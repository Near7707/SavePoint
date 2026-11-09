import test from 'node:test';
import assert from 'node:assert/strict';
import { markOf, findMarked, planRemoval, applyRemoval, parseIds } from '../experiments/hide-probe/probe-core.js';

// The request list as SillyTavern 1.19 builds it before interceptors (public/script.js, Generate):
// drop `is_system`, drop the last item on a swipe, shallow-copy each item with rewritten text and
// its own list `index`, then copy again for reasoning.
function stCore(chat, type, tools = false) {
    let core = chat.filter(x => !x.is_system || (tools && Array.isArray(x.extra?.tool_invocations)));
    if (type === 'swipe') core.pop();
    core = core.map((m, index) => ({ ...m, mes: `${m.mes} [regex]`, index }));
    return core.map(m => ({ ...m }));
}

function room(n = 10) {
    return Array.from({ length: n }, (_, i) => ({
        name: i % 2 ? 'Ari' : 'Bo', is_user: i % 2 === 0, mes: `line ${i}`,
        send_date: `2026-01-01 10:${String(i).padStart(2, '0')}`, extra: {},
    }));
}

const texts = core => core.map(c => c.mes.replace(' [regex]', ''));
function run(chat, ids, type, mutate, tools) {
    const marks = ids.map(i => markOf(chat[i], chat));
    const core = stCore(chat, type, tools);
    if (mutate) mutate(core);
    const plan = planRemoval(chat, core, marks, type);
    applyRemoval(core, plan.remove);
    return { core, plan };
}

test('hide probe: mixed with /hide, only the marked messages leave the request', () => {
    const chat = room();
    chat[2].is_system = true;                 // ordinary /hide
    chat[4].is_system = true; chat[4].extra.savepointHidden = true;   // SavePoint hide
    const { core, plan } = run(chat, [3, 6, 7]);
    assert.deepEqual(texts(core), ['line 0', 'line 1', 'line 5', 'line 8', 'line 9']);
    assert.deepEqual(plan.removed.map(r => r.i), [3, 6, 7]);
    assert.deepEqual(plan.skipped, []);
});

test('hide probe: a message that is already hidden is reported, not removed twice', () => {
    const chat = room();
    chat[3].is_system = true;
    const { core, plan } = run(chat, [3, 5]);
    assert.deepEqual(texts(core), ['line 0', 'line 1', 'line 2', 'line 4', 'line 6', 'line 7', 'line 8', 'line 9']);
    assert.deepEqual(plan.skipped.map(x => [x.i, x.why]), [[3, 'already-hidden']]);
});

test('hide probe: swipe drops the last item first; the rest still lines up', () => {
    const chat = room();
    chat[1].is_system = true;
    const { core, plan } = run(chat, [2, 9], 'swipe');
    assert.deepEqual(texts(core), ['line 0', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8']);
    assert.deepEqual(plan.skipped.map(x => [x.i, x.why]), [[9, 'not-in-request']]);
});

test('hide probe: items added by another interceptor are stepped over', () => {
    const chat = room();
    const { core } = run(chat, [1, 4], 'normal', c => {
        c.unshift({ mes: 'injected top', is_user: false, name: 'Keeper' });
        c.splice(4, 0, { mes: 'injected mid', is_user: true, name: 'Bo', send_date: 'x' });
    });
    assert.deepEqual(core.map(c => c.mes.replace(' [regex]', '')),
        ['injected top', 'line 0', 'line 2', 'injected mid', 'line 3', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
});

test('hide probe: a copied `extra` still pairs by send date and speaker', () => {
    const chat = room();
    const { core } = run(chat, [5], 'normal', c => c.forEach((m, j) => { c[j] = structuredClone(m); }));
    assert.deepEqual(texts(core).includes('line 5'), false);
    assert.equal(core.length, 9);
});

test('hide probe: marks follow the message when an earlier one is deleted', () => {
    const chat = room();
    const marks = [markOf(chat[6])];
    chat.splice(2, 1);
    assert.deepEqual(findMarked(chat, marks[0]), { i: 5 });
    const core = stCore(chat);
    applyRemoval(core, planRemoval(chat, core, marks).remove);
    assert.equal(texts(core).includes('line 6'), false);
    assert.equal(core.length, 8);
});

test('hide probe: same date and speaker twice — `extra` decides, otherwise nothing is removed', () => {
    const chat = room(6);
    chat[3].send_date = chat[1].send_date;       // two Ari lines with one timestamp
    let r = run(chat, [3]);
    assert.deepEqual(texts(r.core), ['line 0', 'line 1', 'line 2', 'line 4', 'line 5']);
    // without `extra` the two cannot be told apart in the request list: keep both
    delete chat[1].extra; delete chat[3].extra;
    r = run(chat, [3]);
    assert.equal(r.core.length, 6);
    assert.deepEqual(r.plan.skipped.map(x => [x.i, x.why]), [[3, 'ambiguous']]);
});

test('hide probe: continue keeps the message being continued', () => {
    const chat = room();
    const { core, plan } = run(chat, [9], 'continue');
    assert.equal(core.length, 10);
    assert.deepEqual(plan.skipped.map(x => x.why), ['continue-target']);
});

test('hide probe: a deleted marked message is reported as gone', () => {
    const chat = room();
    const mark = markOf(chat[4]);
    chat.splice(4, 1);
    const core = stCore(chat);
    const plan = planRemoval(chat, core, [mark]);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.skipped.map(x => x.why), ['gone']);
});

test('hide probe: id list parsing', () => {
    assert.deepEqual(parseIds('2-5, 8', 10), [2, 3, 4, 5, 8]);
    assert.deepEqual(parseIds('#7-#6 #1', 10), [1, 6, 7]);
    assert.deepEqual(parseIds('12', 10), []);
    assert.equal(parseIds('two', 10), null);
});

// 0.1.1 (GPT review of the experiment)
test('hide probe 0.1.1: chosen A deleted, B with the same date/speaker/role is not removed in its place', () => {
    const chat = room(6);
    chat[3].send_date = chat[1].send_date;
    const mark = markOf(chat[1], chat);
    chat.splice(1, 1);
    const core = stCore(chat);
    const plan = planRemoval(chat, core, [mark]);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.skipped.map(x => x.why), ['ambiguous']);
    // the same mark still finds A while A is there, by its text
    assert.equal(findMarked(room(6).map((m, i, a) => (i === 3 ? { ...m, send_date: a[1].send_date } : m)), mark).i, 1);
});

test('hide probe 0.1.1: an item put in just before the chosen one, carrying its `extra`, removes nothing', () => {
    const chat = room(6);
    const { core, plan } = run(chat, [3], 'normal', c => c.splice(3, 0, { ...c[3], mes: 'injected' }));
    assert.deepEqual(texts(core), ['line 0', 'line 1', 'line 2', 'injected', 'line 3', 'line 4', 'line 5']);
    assert.deepEqual(plan.skipped.map(x => x.why), ['ambiguous']);
});

test('hide probe 0.1.1: same date and speaker put in by another interceptor (no `extra`) removes nothing', () => {
    const chat = room(6);
    chat.forEach(m => delete m.extra);
    let { core, plan } = run(chat, [3], 'normal', c => c.splice(3, 0, { ...c[3], mes: 'injected' }));
    assert.equal(core.length, 7);
    assert.deepEqual(plan.skipped.map(x => x.why), ['ambiguous']);
    // put in further up (before earlier messages): the in-order walk has passed it, the chosen one is still found
    ({ core, plan } = run(chat, [3], 'normal', c => c.splice(1, 0, { ...c[3], mes: 'injected' })));
    assert.deepEqual(texts(core), ['line 0', 'injected', 'line 1', 'line 2', 'line 4', 'line 5']);
});

test('hide probe 0.1.1: a tool call message SillyTavern keeps in the request is reported as kept, not as hidden', () => {
    const chat = room(6);
    chat[2].is_system = true; chat[2].extra.tool_invocations = [{}];
    const { core, plan } = run(chat, [2], 'normal', null, true);
    assert.equal(core.length, 6);
    assert.deepEqual(plan.skipped.map(x => x.why), ['tool-kept']);
});

test('hide probe 0.1.1: continue keeps the chat\'s last message even when another interceptor appended after it', () => {
    const chat = room(6);
    const { core, plan } = run(chat, [5, 2], 'continue', c => c.push({ mes: 'tail', name: 'Keeper' }));
    assert.deepEqual(texts(core), ['line 0', 'line 1', 'line 3', 'line 4', 'line 5', 'tail']);
    assert.deepEqual(plan.skipped.map(x => [x.i, x.why]), [[5, 'continue-target']]);
});

test('hide probe 0.1.1: huge numbers do not hang the parser', () => {
    assert.deepEqual(parseIds('9007199254740992', 20), null);
    assert.deepEqual(parseIds('9007199254740990', 20), []);
    assert.deepEqual(parseIds('3-900000000', 6), [3, 4, 5]);
});
