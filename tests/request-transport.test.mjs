import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { assertPromptFits } from '../request-batches.js';

const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const code = src.slice(src.indexOf('class Cancelled extends'), src.indexOf('// What a reply looked like'));

function harness(sendRequest, extra = {}) {
    const config = { profileId: 'p', requestStream: true, reasoningEffort: '', responseLength: 8000, timeoutSec: 300, inputChars: 60000, ...extra };
    const calls = [], timers = [], writes = [], messages = [];
    const ui = {};
    const profiles = [{ id: 'p', name: 'Test profile', mode: 'cc' }];
    const state = { mem: { scenes: [], records: [] }, lastIndex: -1 };
    const context = { ConnectionManagerRequestService: { async sendRequest(...args) { calls.push(args); return sendRequest(...args); } },
        generateRaw: async () => '{"ok":true}' };
    const sandbox = { ui, assertPromptFits, settings: () => config, ctx: () => context, num: k => config[k], profiles: () => profiles,
        profileLabel: () => 'Test profile', Date, AbortController, console,
        render() {}, setInterval: () => 0, clearInterval() {},
        setTimeout(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout(t) { if (t) t.cleared = true; },
        $: () => ({ text(value) { writes.push(value); } }),
        mainBusy: () => false, state: () => state,
        newRun() { const run = { st: state, ctrl: new AbortController(), cancelled: false }; ui.run = run; return run; },
        endRun(run) { if (ui.run === run) { ui.run = null; ui.req = null; } },
        toastr: Object.fromEntries(['info', 'success', 'warning'].map(k => [k, text => messages.push([k, text])])),
    };
    const api = vm.runInNewContext(code + ';({llm,readModelReply,reqText,cancelRun,testConnection})', sandbox);
    const run = { ctrl: new AbortController(), cancelled: false }; ui.run = run;
    return { ...api, config, ui, context, calls, timers, writes, messages, state, profiles, run };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('profile streaming consumes cumulative answer text once and keeps reasoning out of the answer', async () => {
    const h = harness(() => async function* () {
        yield { text: '', state: { reasoning: 'thinking' } };
        yield { text: '{"ok":', state: { reasoning: 'thinking done' } };
        yield { text: '{"ok":true}', state: { reasoning: 'thinking done' } };
    });
    const result = await h.llm('A short prompt', h.run);
    assert.equal(result, '{"ok":true}');
    assert.equal(h.calls[0][3].stream, true);
    assert.equal(h.ui.lastRequest.textChars, result.length);
    assert.equal(h.ui.lastRequest.reasoningChars, 13);
    assert.equal(h.ui.lastRequest.status, 'received');
    assert.equal(h.ui.lastRequest.stream, true);
    assert(!JSON.stringify(h.ui.lastRequest).includes('thinking done'), 'diagnostics only keep lengths');
});

test('nonstream fallback and explicit nonstream requests preserve extracted content and reasoning lengths', async () => {
    const h = harness(() => ({ content: '{"ok":true}', reasoning: 'private thought' }), { requestStream: false });
    assert.equal(await h.llm('prompt', h.run), '{"ok":true}');
    assert.equal(h.calls[0][3].stream, false);
    assert.equal(h.ui.lastRequest.reasoningChars, 15);
    assert.equal(h.ui.lastRequest.stream, false);
});

test('reasoning override is per chat-profile request, and default mode leaves the profile untouched', async () => {
    const h = harness(() => ({ content: '{}' }), { reasoningEffort: 'low' });
    await h.llm('prompt', h.run);
    assert.equal(h.calls[0][4].reasoning_effort, 'low');
    h.config.reasoningEffort = '';
    await h.llm('prompt', h.run);
    assert.equal(Object.keys(h.calls[1][4]).length, 0);
    h.config.reasoningEffort = 'max'; h.profiles[0].mode = 'tc';
    await h.llm('prompt', h.run);
    assert.equal(Object.keys(h.calls[2][4]).length, 0, 'do not send a chat reasoning field to text completion');
});

test('main API keeps its existing path and does not receive profile overrides', async () => {
    const h = harness(() => { throw new Error('must not use a profile'); }, { profileId: '', reasoningEffort: 'low' });
    let payload;
    h.context.generateRaw = async value => { payload = value; return '{}'; };
    assert.equal(await h.llm('prompt', h.run), '{}');
    assert.equal(h.calls.length, 0);
    assert.deepEqual(Object.keys(payload).sort(), ['prompt', 'responseLength']);
});

test('a timeout reports reasoning-only progress, and a late chunk cannot affect the next request', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = harness(() => async function* () {
        yield { text: '', state: { reasoning: 'still reasoning' } };
        await gate;
        yield { text: 'LATE', state: { reasoning: 'late thoughts' } };
    });
    const promise = h.llm('prompt', h.run);
    const rejected = assert.rejects(promise, /안에 오지 않았어요/);
    await settle();
    assert.match(h.reqText(), /수신 중.*사고 15자 \/ 본문 0자/);
    h.timers[0].fn();
    await rejected;
    assert.equal(h.ui.lastRequest.status, 'timeout');
    assert.equal(h.calls[0][3].signal.aborted, true);
    const old = h.ui.lastRequest;
    h.ui.req = { id: 999, phase: 'wait', textChars: 0 };
    release(); await settle();
    assert.equal(h.ui.lastRequest, old);
    assert.equal(h.ui.req.textChars, 0);
});

test('cancel drops an unfinished stream and aborts its profile request', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = harness(() => async function* () { await gate; yield { text: 'late' }; });
    const promise = h.llm('prompt', h.run);
    const rejected = assert.rejects(promise, /중지했어요/);
    await settle(); h.cancelRun(); await rejected;
    assert.equal(h.calls[0][3].signal.aborted, true);
    assert.equal(h.ui.lastRequest.status, 'cancelled');
    release(); await settle();
});

test('short connection test sends no roleplay, changes no memory and caps its output and wait', async () => {
    const h = harness(() => ({ content: '{"ok":true}', reasoning: '' }));
    h.ui.run = null;
    const before = JSON.stringify(h.state);
    await h.testConnection();
    assert.equal(JSON.stringify(h.state), before);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][2], 1024);
    assert.equal(h.timers[0].ms, 60000);
    assert.equal(h.calls[0][1][0].content, 'Reply with only this JSON object: {"ok":true}');
    assert(h.messages.some(([k]) => k === 'success'));
    assert.equal(h.ui.run, null);
});

test('a reasoning-only probe is not reported as a successful answer', async () => {
    const h = harness(() => ({ content: '', reasoning: 'thinking only' }));
    h.ui.run = null;
    await h.testConnection();
    assert(!h.messages.some(([k]) => k === 'success'));
    assert.match(h.ui.lastError.detail[0], /본문이 비어.*사고 13자/);
});
