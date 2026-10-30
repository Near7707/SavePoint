import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chunkMessages, openScene } from '../core.js';

const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const section = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));
const hiding = section('function setHidden(', '// ───────── change detection');
const transaction = section('async function transact(', '\nfunction persistSoon');
const summarizeCode = section('async function summarize(', '// ───────── automatic collection');
const automaticCode = section('async function autoCollect(', '// ───────── record check');
const HIDE_KEY = 'savepointHidden', VISIBLE_KEY = 'savepointVisible';

function harness({ count = 10, lastIndex = 9, keepRecent = 2 } = {}) {
    const chat = Array.from({ length: count }, (_, n) => ({ mes: `Message ${n}`, name: 'Speaker', is_system: false, extra: {} }));
    const settings = { enabled: true, hide: true, keepRecent, profileId: 'mock', inputChars: 60000, autoReserve: 2 };
    const meta = { savePoint: { mem: { scenes: [{ id: 's1', status: 'closed', segs: [] }], records: [], entities: [] }, lastIndex, rev: 0, hashes: [] } };
    const dom = new Map(chat.map((m, n) => [n, String(m.is_system)]));
    const writes = [], notifications = [];
    let calls = 0;
    const ui = {};
    const box = { clearInterrupted() {},
        MODULE: 'savePoint', HIDE_KEY, VISIBLE_KEY, ui, roomEpoch: 0,
        clone: structuredClone, roomKey: () => 'room', state: () => meta.savePoint, ctx: () => ({ chatMetadata: meta, swipe: { refresh() {} } }),
        chat: () => chat, settings: () => settings, num: k => settings[k], hasMemory: mem => !!(mem.scenes.length || mem.records.length),
        $(selector) { const index = Number(selector.match(/mesid="(\d+)"/)[1]); return { attr(k, value) { dom.set(index, value); } }; },
        saveChatSoon() {}, refreshInjection() {}, render() {}, autosave() {},
        async persist() { writes.push(structuredClone({ meta, chat })); },
        hasChat: () => true, mainBusy: () => false, ensureState: () => meta.savePoint, reconcile: () => true,
        collect: (a, b) => chat.map((m, index) => ({ index, name: m.name, text: m.mes })).filter(m => m.index >= a && m.index <= b),
        openScene, closeOpenScene: mem => ({ ...mem, scenes: mem.scenes.map(s => ({ ...s, status: 'closed' })) }),
        nextMessageChunk: msgs => chunkMessages(msgs, Infinity)[0], extractPrompt: () => 'prompt',
        newRun: () => { const run = { hashes: chat.map(m => m.mes), cancelled: false }; ui.run = run; return run; },
        assertValid() {}, checkpoint: () => structuredClone(meta.savePoint), pushHistory() {}, settleAutoFail() {}, persistSoon() {},
        lootForChunk: () => [], settleLoot: () => 0, supplementLoot: async () => ({ saved: 0, failed: 0 }), markStaleLoot: async () => {}, failPendingLoot: async () => 0,
        async extractChunk() { calls++; return { scenes: [{}] }; }, applyResult: () => ({ mem: meta.savePoint.mem }),
        endRun() { ui.run = null; }, queueCheck() {}, Cancelled: class extends Error {}, errorText: e => e.message,
        newId: () => 'hide-test-failure', requestLines: () => [],
        reportError: e => notifications.push(['error', e.message]), console: { error() {} },
        toastr: Object.fromEntries(['success', 'info', 'warning', 'error'].map(k => [k, m => notifications.push([k, m])])),
        autoBlocked: () => false, names: () => ({}), buildBoundaryPrompt: () => 'boundary',
        validateBoundary: () => ({ errors: [], plan: { boundary: count - 3, closeOpen: false, continuesOpen: false } }),
        llm: async () => '{}', parseJson: JSON.parse, batchNote: () => '', chunkMessages, fmtSec: () => '0초',
        recordAutoFail() {}, noteAuto() {}, flashSaveBanner() {}, replyKind() { return null; }, isTry: () => false,
    };
    const api = vm.runInNewContext(transaction + hiding + summarizeCode + automaticCode + ';({syncHide,transact,summarize,autoCollect})', box);
    return { ...api, box, chat, settings, meta, dom, writes, notifications, calls: () => calls };
}

test('a save-time rescan repairs every older visibility hole from #0 and preserves the latest N', () => {
    const h = harness();
    for (const n of [0, 2, 5]) h.chat[n].extra[VISIBLE_KEY] = true;
    h.chat[3].extra[HIDE_KEY] = 1; // manually opened, not yet noticed by a redraw
    h.chat[4].is_system = true; h.chat[4].extra[HIDE_KEY] = 1;
    h.dom.set(4, 'false'); // stale rendered attribute
    h.syncHide({ rehide: true });
    h.chat.forEach((m, n) => {
        assert.equal(m.is_system, n < 8);
        assert.equal(h.dom.get(n), String(n < 8));
        if (n < 8) assert.equal(m.extra[VISIBLE_KEY], undefined);
    });
});

test('ordinary redraws leave manually opened messages visible until the next save', () => {
    const h = harness();
    h.chat[0].extra[HIDE_KEY] = 1;
    h.syncHide();
    assert.equal(h.chat[0].is_system, false);
    assert.equal(h.chat[0].extra[VISIBLE_KEY], true);
    h.syncHide();
    assert.equal(h.chat[0].is_system, false);
    h.syncHide({ rehide: true });
    assert.equal(h.chat[0].is_system, true);
});

test('unrecorded messages are never hidden even when they are outside the recent-N window', () => {
    const h = harness({ lastIndex: 3 });
    h.syncHide({ rehide: true });
    assert(h.chat.slice(0, 4).every(m => m.is_system));
    assert(h.chat.slice(4).every(m => !m.is_system));
});

test('N=0 hides all recorded messages and a large N leaves them visible', () => {
    const all = harness({ keepRecent: 0 });
    all.syncHide({ rehide: true });
    assert(all.chat.every(m => m.is_system));
    const none = harness({ keepRecent: 20 });
    none.syncHide({ rehide: true });
    assert(none.chat.every(m => !m.is_system));
});

test('recent messages previously hidden by SavePoint are reopened', () => {
    const h = harness();
    for (const n of [8, 9]) { h.chat[n].is_system = true; h.chat[n].extra[HIDE_KEY] = 1; }
    h.syncHide({ rehide: true });
    assert(h.chat.slice(8).every(m => !m.is_system && !m.extra[HIDE_KEY]));
});

test('manual hides remain owned by the user and are not reopened when SavePoint is disabled', () => {
    const h = harness();
    h.chat[1].is_system = true;
    h.syncHide({ rehide: true });
    assert.equal(h.chat[1].extra[HIDE_KEY], undefined);
    h.settings.enabled = false;
    h.syncHide();
    assert.equal(h.chat[1].is_system, true);
    assert(h.chat.filter((_, n) => n !== 1).every(m => !m.is_system));
});

test('hide-off, source-review and empty-memory states never force a new hide', () => {
    for (const mode of ['off', 'review', 'empty']) {
        const h = harness();
        if (mode === 'off') h.settings.hide = false;
        if (mode === 'review') h.meta.savePoint.review = {};
        if (mode === 'empty') h.meta.savePoint.mem.scenes = [];
        h.syncHide({ rehide: true });
        assert(h.chat.every(m => !m.is_system));
    }
});

test('a successful save writes the rescanned visibility and memory position together', async () => {
    const h = harness({ lastIndex: 3 });
    h.chat[0].extra[VISIBLE_KEY] = true;
    await h.transact(() => { h.meta.savePoint.lastIndex = 6; }, { rehide: true });
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].meta.savePoint.lastIndex, 6);
    assert(h.writes[0].chat.slice(0, 7).every(m => m.is_system));
    assert(h.writes[0].chat.slice(7).every(m => !m.is_system));
});

test('a failed disk write restores manual visibility exceptions, ownership and the saved position', async () => {
    const h = harness({ lastIndex: 3 });
    h.chat[0].extra[VISIBLE_KEY] = true;
    h.chat[1].extra[HIDE_KEY] = 1;
    h.chat[2].is_system = true;
    delete h.chat[3].extra;
    const original = JSON.stringify(h.chat), before = JSON.stringify(h.meta.savePoint);
    h.box.persist = async () => { throw new Error('disk full'); };
    await assert.rejects(h.transact(() => { h.meta.savePoint.lastIndex = 8; }, { rehide: true }), /저장하지 못해서/);
    assert.equal(JSON.stringify(h.chat), original);
    assert.equal(JSON.stringify(h.meta.savePoint), before);
    h.chat.forEach((m, n) => assert.equal(h.dom.get(n), String(m.is_system)));
});

test('quick save with no new messages repairs hide holes without a model call', async () => {
    const h = harness();
    h.chat[0].extra[VISIBLE_KEY] = true;
    await h.summarize();
    assert.equal(h.calls(), 0);
    assert(h.chat.slice(0, 8).every(m => m.is_system));
    assert(h.chat.slice(8).every(m => !m.is_system));
    assert.equal(h.meta.savePoint.lastIndex, 9);
});

test('quick save with new messages rescans the whole saved prefix, including prior manual exceptions', async () => {
    const h = harness({ lastIndex: 3 });
    h.chat[0].extra[VISIBLE_KEY] = true;
    await h.summarize();
    assert.equal(h.calls(), 1);
    assert.equal(h.meta.savePoint.lastIndex, 9);
    assert(h.chat.slice(0, 8).every(m => m.is_system));
    assert(h.chat.slice(8).every(m => !m.is_system));
});

test('checkpoint saves rescan from the start without hiding the retained two messages', async () => {
    const h = harness({ lastIndex: 3 });
    h.chat[0].extra[VISIBLE_KEY] = true;
    await h.autoCollect();
    assert.equal(h.calls(), 1);
    assert.equal(h.meta.savePoint.lastIndex, 7);
    assert(h.chat.slice(0, 8).every(m => m.is_system));
    assert(h.chat.slice(8).every(m => !m.is_system));
});

test('a failed later quick-save batch hides only the successfully saved prefix', async () => {
    const h = harness({ lastIndex: 3, keepRecent: 0 });
    h.chat[0].extra[VISIBLE_KEY] = true;
    h.box.nextMessageChunk = msgs => chunkMessages(msgs.slice(0, 2), Infinity)[0];
    let calls = 0;
    h.box.extractChunk = async () => { if (++calls === 2) throw new Error('model unavailable'); return {}; };
    await h.summarize();
    assert.equal(h.meta.savePoint.lastIndex, 5);
    assert(h.chat.slice(0, 6).every(m => m.is_system));
    assert(h.chat.slice(6).every(m => !m.is_system));
});

