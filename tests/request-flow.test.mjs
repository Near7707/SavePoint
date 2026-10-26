// Run the shipped orchestration functions with fake model/network boundaries.
// These verify saved positions, partial failures and review status, not just planners.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../core.js';
import * as prompts from '../prompts.js';
import * as batches from '../request-batches.js';
import * as provenance from '../provenance.js';

const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const section = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
const extractCode = section('function extractPrompt(', '\n// ───────── automatic collection');
const checkCode = section('function checkStatements(', '\nfunction queueCheck') + section('async function runCheck(', '\nconst gapText');
const parseCode = section('function replyKind(', '\nfunction newRun');
class Cancelled extends Error {}
class RequestTimeout extends Error {}

function harness({ count = 40, chars = 1000, limit = 20000, failAt = Infinity, cancelAt = Infinity } = {}) {
    const chat = Array.from({ length: count }, (_, n) => ({ name: 'Speaker', mes: 'a'.repeat(chars) + ` END${n}`, extra: {} }));
    const st = { mem: core.emptyMem(), lastIndex: -1, hashes: [], history: [], rev: 0 };
    const s = { guide: prompts.DEFAULT_GUIDE, inputChars: limit, profileId: 'fake', responseLength: 8000 };
    const calls = [], notifications = [];
    const ui = {};
    const sandbox = { ...core, ...prompts, ...batches, ...provenance, Cancelled, RequestTimeout, ui,
        structuredClone, Set, Map, Date, console: { error() {} },
        settings: () => s, num: key => s[key], names: () => ({}), cardText: () => '',
        chat: () => chat, state: () => st, ensureState: () => st, hasChat: () => true, mainBusy: () => false, reconcile: () => true,
        collect: (a, b) => chat.map((m, index) => ({ index, name: m.name, text: m.mes })).filter(m => m.index >= a && m.index <= b),
        speaker: m => m.name, cleanText: s => s, eligible: m => !m.is_system,
        render() {}, persistSoon() {}, autosave() {}, queueCheck() {},
        toastr: Object.fromEntries(['info', 'error', 'warning', 'success'].map(k => [k, m => notifications.push([k, m])])),
        newRun: () => { const run = { hashes: chat.map(m => m.mes), cancelled: false }; ui.run = run; return run; },
        assertValid: run => { if (run.cancelled) throw new Cancelled('Cancelled'); },
        endRun: () => { ui.run = null; }, checkpoint: () => structuredClone(st),
        async transact(fn) { fn(); st.rev++; }, errorText: e => e.message, fmtSec: n => String(n),
        async llm(prompt, run) {
            batches.assertPromptFits(prompt, s.inputChars);
            calls.push(prompt);
            if (calls.length === failAt) throw new RequestTimeout('Fake timeout');
            if (calls.length === cancelAt) { run.cancelled = true; throw new Cancelled('Cancelled'); }
            if (prompt.startsWith('You are checking')) return '{"issues":[]}';
            const text = prompt.split(/\[NEW MESSAGES\][^\n]*\n/)[1].split('\n\nReturn ONLY')[0];
            const nums = [...text.matchAll(/^#(\d+) /gm)].map(m => Number(m[1]));
            return JSON.stringify({ scenes: [{ scene: core.openScene(st.mem) ? 'continue' : 'new', title: 'A walk', where: 'Street', who: [],
                outline: `They walked from ${nums[0]} to ${nums.at(-1)}.`, notes: 'They walked together.', ended: false,
                points: [{ text: 'They shared a quiet walk.', kind: 'moment', key: false, msgs: [nums[0]] }] }], entities: [], changes: [] });
        },
    };
    const api = vm.runInNewContext(parseCode + extractCode + checkCode + ';({summarize,runCheck,checkStatements})', sandbox);
    return { ...api, st, s, chat, calls, notifications, sandbox };
}

test('quick save completes several bounded requests through the last message', async () => {
    const h = harness();
    const original = JSON.stringify(h.chat);
    await h.summarize();
    assert.equal(h.st.lastIndex, 39);
    assert(h.calls.length > 1);
    assert(h.calls.every(p => p.length <= h.s.inputChars));
    assert.equal(JSON.stringify(h.chat), original);
    assert.equal(h.st.hashes.length, 40);
    assert(h.notifications.some(([k]) => k === 'success'));
});

test('a timed out later chunk leaves all remaining messages uncollected and a retry resumes there', async () => {
    const h = harness({ failAt: 2 });
    const original = JSON.stringify(h.chat);
    await h.summarize();
    const saved = h.st.lastIndex;
    assert(saved >= 0 && saved < 39);
    assert.equal(h.st.hashes.length, saved + 1);
    assert.equal(JSON.stringify(h.chat), original);
    const oldCount = h.calls.length;
    await h.summarize();
    assert.equal(h.st.lastIndex, 39);
    assert(h.calls[oldCount].includes(`[NEW MESSAGES] #${saved + 1} to`));
});

test('cancellation during the second request does not advance the saved position', async () => {
    const h = harness({ cancelAt: 2 });
    await h.summarize();
    assert(h.st.lastIndex >= 0 && h.st.lastIndex < 39);
    assert.equal(h.st.hashes.length, h.st.lastIndex + 1);
    assert(h.notifications.some(([k]) => k === 'info'));
});

test('oversized first message makes no model call and changes no memory or original message', async () => {
    const h = harness({ count: 1, chars: 30000 });
    const memory = JSON.stringify(h.st.mem), original = h.chat[0].mes;
    await h.summarize();
    assert.equal(h.calls.length, 0);
    assert.equal(h.st.lastIndex, -1);
    assert.equal(JSON.stringify(h.st.mem), memory);
    assert.equal(h.chat[0].mes, original);
    assert(h.sandbox.ui.lastError.detail[0].includes('入力') || h.sandbox.ui.lastError.detail[0].includes('입력 한도'));
});

test('review orchestration reads message tails, splits calls and never changes saved memory', async () => {
    const h = harness({ count: 8, chars: 3000, limit: 15000 });
    h.st.mem.scenes = [{ id: 's1', segs: h.chat.map((_, n) => ({ id: `g${n + 1}`, from: n, to: n, outline: `Event ${n}.`, points: [{ text: 'An event.', msgs: [n] }] })) }];
    const scope = { records: [], segs: h.st.mem.scenes[0].segs.map(g => g.id) };
    const memory = JSON.stringify(h.st.mem);
    await h.runCheck(h.st, scope);
    assert.equal(h.st.check.status, 'ok');
    assert(h.calls.length > 1);
    assert(h.calls.every(p => p.length <= h.s.inputChars));
    for (let n = 0; n < h.chat.length; n++) assert(h.calls.some(p => p.includes(h.chat[n].mes)));
    assert.equal(h.st.check.coverage.cut.length, 0);
    assert.equal(h.st.check.coverage.missing.length, 0);
    assert.equal(JSON.stringify(h.st.mem), memory);
});

test('a promise includes the intervening amendment, not just its endpoint evidence', () => {
    const h = harness({ count: 3 });
    h.chat[1].mes = 'The terms were changed here.';
    h.st.mem.records = [{ id: 'r1', type: 'quest', kind: 'promise', text: 'An agreement.', msgs: [0, 2], src: [], terms: { msg: 0, quote: 'An agreement.', context: 'Full context.' } }];
    const statements = h.checkStatements(h.st, { records: ['r1'], segs: [] });
    assert.deepEqual(Array.from(statements[0].messages), [0, 1, 2]);
});

test('an oversized review target is deferred rather than falsely marked problem-free', async () => {
    const h = harness({ count: 3, chars: 8000, limit: 15000 });
    h.st.mem.records = [{ id: 'r1', type: 'quest', kind: 'promise', text: 'An agreement.', msgs: [0, 2], src: [], terms: { msg: 0, quote: 'An agreement.', context: 'Full context.' } }];
    await h.runCheck(h.st, { records: ['r1'], segs: [] });
    assert.equal(h.calls.length, 0);
    assert.equal(h.st.check.status, 'issues');
    assert.equal(h.st.check.issues[0].kind, 'partial');
    assert(h.st.check.issues[0].problem.includes('검토를 보류'));
});

test('a later review request failing leaves saved memory intact and the whole check incomplete', async () => {
    const h = harness({ count: 8, chars: 3000, limit: 15000, failAt: 2 });
    h.st.mem.scenes = [{ id: 's1', segs: h.chat.map((_, n) => ({ id: `g${n + 1}`, from: n, to: n, outline: `Event ${n}.`, points: [] })) }];
    const memory = JSON.stringify(h.st.mem);
    await h.runCheck(h.st, { records: [], segs: h.st.mem.scenes[0].segs.map(g => g.id) });
    assert.equal(h.st.check.status, 'failed');
    assert.equal(JSON.stringify(h.st.mem), memory);
});

test('changing memory during a review cannot publish a stale successful result', async () => {
    const h = harness({ count: 1 });
    h.st.mem.scenes = [{ id: 's1', segs: [{ id: 'g1', from: 0, to: 0, outline: 'An event.', points: [] }] }];
    h.sandbox.llm = async () => { h.st.rev++; return '{"issues":[]}'; };
    await h.runCheck(h.st, { records: [], segs: ['g1'] });
    assert.equal(h.st.check.status, 'failed');
});

test('a number not in the review request is held back instead of accepted as evidence', async () => {
    const h = harness({ count: 1 });
    h.st.mem.scenes = [{ id: 's1', segs: [{ id: 'g1', from: 0, to: 0, outline: 'An event.', points: [] }] }];
    h.sandbox.llm = async () => JSON.stringify({ issues: [{ about: 'g1', kind: 'misread', problem: 'Something is wrong.', msgs: [9999] }] });
    await h.runCheck(h.st, { records: [], segs: ['g1'] });
    assert.equal(h.st.check.issues[0].kind, 'partial');
});

test('a stored checkpoint failure keeps only its unrecorded part after a partial quick save, and is cleared once saved', async () => {
    const h = harness({ failAt: 2 });
    h.st.autoFail = { at: 1, kind: 'collect', stage: 'collect', from: 0, to: 30, reason: 'x', attempts: 2, tries: [], detail: [] };
    await h.summarize();
    const saved = h.st.lastIndex;
    assert(saved >= 0 && saved < 30);
    assert.deepEqual([h.st.autoFail.from, h.st.autoFail.to], [saved + 1, 30]);
    await h.summarize();
    assert.equal(h.st.lastIndex, 39);
    assert.equal(h.st.autoFail, undefined);
});

