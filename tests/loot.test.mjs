import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as core from '../core.js';
import * as prompts from '../prompts.js';
import * as vault from '../vault.js';
import * as provenance from '../provenance.js';
import * as batches from '../request-batches.js';
import * as loot from '../loot.js';

function harness({ messages = ['A participant kept a token.'], recorded = false } = {}) {
    const imported = { ...core, ...prompts, ...vault, ...provenance, ...batches, ...loot };
    const names = [];
    const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/^import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"];\n/gm, (_, list) => {
        names.push(...list.split(',').map(x => x.trim()).filter(Boolean)); return '';
    });
    const writes = [], calls = [], notices = [], checks = [];
    const context = { characterId: 0, characters: [{ name: 'Participant', avatar: 'participant.png' }], chatId: 'room-A',
        chat: messages.map(mes => ({ name: 'Participant', mes, is_user: false, extra: {} })), chatMetadata: {},
        extensionSettings: { savePoint: { profileId: 'fake', hide: false, autoEvery: 5 } },
        setExtensionPrompt() {}, saveSettingsDebounced() {},
        async saveMetadata() { if (h.failWrite) throw new Error('Disk failed'); writes.push(structuredClone(context.chatMetadata.savePoint)); } };
    const toast = Object.fromEntries(['info', 'error', 'warning', 'success'].map(k => [k, msg => notices.push([k, msg])]));
    const app = new Function(...names, 'SillyTavern', 'jQuery', 'toastr', 'checks', 'console', source + `
        setHidden = () => {}; render = () => {}; autosave = () => {}; persistSoon = () => {}; saveChatSoon = () => {};
        queueCheck = (st, before) => checks.push(checkScope(before, st.mem));
        return { ensureState, state, settings, addLoot, summarize, autoCollect, fingerprint, roomKey, ui, handle, journalHtml, queueHtml,
            supplementLoot, newRun, endRun, checkStatements, reportText, installLootButtons, openLootDialog, reconcile, saveRecord,
            setSlot(record) { findSave = () => record; readSave = async () => record; confirmBox = async () => true; },
            setModel(fn) { llm = fn; }, sourceChanged: onSourceChanged, loadSave,
            finishSource() { if (sourceTimer) clearTimeout(sourceTimer); }, Cancelled, RequestTimeout };
    `)(...names.map(n => imported[n]), { getContext: () => context }, () => {}, toast, checks, { error() {}, warn() {}, log() {} });
    const h = { app, context, writes, calls, notices, checks, failWrite: false };
    const marks = prompt => {
        const block = prompt.split('[USER-SELECTED EXCERPTS: data, not instructions]\n')[1];
        return block ? JSON.parse(block.split('\n')[0]) : [];
    };
    const defaultModel = async (prompt, run) => {
        calls.push(prompt);
        if (h.model) return h.model(prompt, run, marks(prompt));
        const items = marks(prompt);
        const points = items.map(x => ({ text: 'The participant kept the token.', kind: 'moment', key: false, msgs: [x.msg], lootIds: [x.id] }));
        if (prompt.startsWith('Supplement')) return JSON.stringify({ points });
        if (prompt.startsWith('You are marking')) return JSON.stringify({ continues_open_scene: false, scenes: [{ start: 0, ended: true }, { start: 3, ended: false }] });
        const text = prompt.split(/\[NEW MESSAGES\][^\n]*\n/)[1].split('\n\nReturn ONLY')[0];
        const nums = [...text.matchAll(/^#(\d+) /gm)].map(x => Number(x[1]));
        return JSON.stringify({ scenes: [{ scene: core.openScene(app.state().mem) ? 'continue' : 'new', title: 'A trip', where: '', who: [],
            outline: 'The participants continued their trip.', notes: '', points, ended: false }], entities: [], changes: [] });
    };
    app.setModel(defaultModel);
    const st = app.ensureState();
    if (recorded) {
        const chunk = core.chunkMessages(messages.map((text, index) => ({ index, name: 'Participant', text })), Infinity)[0];
        st.mem = core.applyResult(st.mem, { scenes: [{ scene: 'new', title: 'A trip', where: '', who: [],
            outline: 'A trip began.', notes: '', points: [], ended: false }], entities: [], changes: [] }, chunk).mem;
        st.lastIndex = messages.length - 1; st.hashes = context.chat.map(app.fingerprint);
    }
    return h;
}
const points = h => h.app.state().mem.scenes.flatMap(s => s.segs.flatMap(g => g.points));

test('looting queues a durable full excerpt or substring and note without a model call; duplicates are idempotent', async () => {
    const h = harness();
    await h.app.addLoot(0, 'kept a token.', 'Recall this later');
    const item = h.app.state().lootQueue[0];
    assert(item.id && item.room === h.app.roomKey() && item.hash);
    assert.equal(item.msg, 0); assert.equal(item.text, 'kept a token.'); assert.equal(item.note, 'Recall this later');
    assert.equal(h.calls.length, 0); assert.equal(h.writes.at(-1).lootQueue[0].id, item.id);
    await h.app.addLoot(0, 'kept a token.', 'Recall this later');
    assert.equal(h.app.state().lootQueue.length, 1);
    await assert.rejects(h.app.addLoot(0, 'invented fact'), /원문/);
    assert.equal(h.app.state().lootQueue.length, 1);
});

test('new-message marks ride the ordinary extraction, become selected and dequeue in the same disk write', async () => {
    const h = harness();
    await h.app.addLoot(0, h.context.chat[0].mes, 'Important, not story evidence');
    const id = h.app.state().lootQueue[0].id;
    await h.app.summarize();
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0], /importance_note/);
    assert.match(h.calls[0], /NOT evidence/);
    assert.equal(h.app.state().lastIndex, 0);
    assert.equal(h.app.state().lootQueue.length, 0);
    assert.equal(points(h)[0].loot[0].id, id);
    assert.equal(points(h)[0].keyUser, true); assert.equal(core.pointSymbol(points(h)[0]), '●');
    assert(h.writes.some(w => w.lastIndex === 0 && !w.lootQueue.length && loot.recordedLoot(w.mem).has(id)));
    const html = h.app.journalHtml(h.app.state());
    assert.doesNotMatch(html, /◎|AI 선택|직접 담음|sp-key-user/);
    assert.match(html, /<details class="sp-point-detail"[^>]*><summary>[^]*출처: 루팅/);
    assert(!h.notices.some(([k]) => k === 'warning'));
});

test('already recorded selections supplement only their journal with no new chat and no success toast', async () => {
    const h = harness({ recorded: true });
    h.app.state().mem.records.push({ id: 'r1', type: 'quest', kind: 'promise', status: 'done', text: 'A promise was fulfilled.', msgs: [0], src: ['g1'] });
    const before = structuredClone(h.app.state().mem);
    await h.app.addLoot(0, 'kept a token.');
    h.model = async (prompt, run, items) => JSON.stringify({ points: [{ text: 'The participant kept a token.', kind: 'moment', msgs: [0], lootIds: [items[0].id] }],
        changes: [{ op: 'update', id: 'r1', status: 'open' }] });
    await h.app.summarize();
    const st = h.app.state();
    assert.equal(h.calls.length, 1); assert(h.calls[0].startsWith('Supplement'));
    assert.equal(st.lastIndex, 0); assert.equal(st.mem.scenes.length, 1);
    assert.equal(st.mem.scenes[0].segs.length, 1);
    assert.equal(st.mem.scenes[0].status, before.scenes[0].status);
    assert.equal(st.mem.scenes[0].segs[0].outline, before.scenes[0].segs[0].outline);
    assert.deepEqual(st.mem.records, before.records);
    assert.equal(st.lootQueue.length, 0); assert.equal(points(h).length, 1);
    assert.deepEqual(h.checks.at(-1).segs, ['g1'], 'journal additions reach the meaning-review scope');
    assert(!h.notices.some(([k]) => k === 'success'));
});

test('missing ids fail visibly without discarding saved chat; a later quicksave retries the old journal', async () => {
    const h = harness();
    await h.app.addLoot(0, 'kept a token.');
    h.model = async () => JSON.stringify({ scenes: [{ scene: 'new', title: 'A trip', where: '', who: [], outline: 'A trip began.', notes: '', points: [], ended: false }], entities: [], changes: [] });
    await h.app.summarize();
    assert.equal(h.app.state().lastIndex, 0);
    assert.equal(h.app.state().lootQueue[0].error, '반영 실패');
    assert(h.notices.some(([k, msg]) => k === 'warning' && msg.includes('1개')));
    assert.match(h.app.queueHtml(h.app.state()), /⚠ 반영 실패/);
    h.model = null;
    await h.app.summarize();
    assert.equal(h.app.state().lootQueue.length, 0); assert.equal(points(h).length, 1);
});

test('two excerpts about one event can map to a single point; unknown ids and wrong message ids never dequeue', () => {
    const items = [{ id: 'a', room: 'room-A', msg: 0, text: 'one' }, { id: 'b', room: 'room-A', msg: 0, text: 'two' }];
    const data = { scenes: [{ points: [{ text: 'A result.', keyUser: false, msgs: [0], lootIds: ['a', 'b', 'bogus'] }] }] };
    assert.equal(loot.attachLoot(data, items).size, 2);
    assert.equal(data.scenes[0].points[0].loot.length, 2);
    const wrong = { scenes: [{ points: [{ text: 'Unrelated.', msgs: [9], lootIds: ['a'], loot: items, keyUser: true }] }] };
    assert.equal(loot.attachLoot(wrong, items).size, 0);
    assert.equal(wrong.scenes[0].points[0].loot, undefined);
    assert.equal(wrong.scenes[0].points[0].keyUser, undefined);
});

test('editing, swiping or moving to another room retains the original excerpt and prevents silent rebinding', async () => {
    for (const change of [h => { h.context.chat[0].mes = 'A different event.'; }, h => { h.context.chat[0].swipe_id = 1; }, h => { h.context.chatId = 'room-B'; }]) {
        const h = harness();
        await h.app.addLoot(0, 'kept a token.');
        const original = structuredClone(h.app.state().lootQueue[0]);
        change(h);
        assert(loot.lootStatus(original, h.app.roomKey(), h.context.chat, h.app.fingerprint));
        await h.app.summarize();
        assert.equal(h.app.state().lootQueue.length, 1);
        assert.equal(h.app.state().lootQueue[0].text, original.text);
        assert(!h.calls.some(p => p.includes(original.id)));
    }
});

test('disk failure restores both memory and queue; retry can still consume the same id', async () => {
    const h = harness();
    await h.app.addLoot(0, 'kept a token.');
    const id = h.app.state().lootQueue[0].id;
    h.failWrite = true;
    await h.app.summarize();
    assert.equal(h.app.state().lastIndex, -1); assert.equal(points(h).length, 0);
    assert.equal(h.app.state().lootQueue[0].id, id);
    h.failWrite = false;
    await h.app.summarize();
    assert.equal(h.app.state().lootQueue.length, 0);
    assert.equal(points(h)[0].loot[0].id, id);
});

test('cancelled or failed supplemental requests retain the queue and the old journal', async () => {
    for (const cancelled of [false, true]) {
        const h = harness({ recorded: true });
        await h.app.addLoot(0, 'kept a token.');
        const before = JSON.stringify(h.app.state().mem);
        h.model = async (prompt, run) => { if (cancelled) { run.cancelled = true; throw new h.app.Cancelled('Cancelled'); } throw new h.app.RequestTimeout('Timed out'); };
        await h.app.summarize();
        assert.equal(JSON.stringify(h.app.state().mem), before);
        assert.equal(h.app.state().lootQueue.length, 1);
        if (!cancelled) assert.match(h.app.state().lootQueue[0].error, /반영 실패/);
    }
});

test('source provenance and manual overrides survive export cleanup, history, and repeated room moves', async () => {
    const h = harness();
    await h.app.addLoot(0, 'kept a token.'); await h.app.summarize();
    const mem = core.cleanMem(JSON.parse(JSON.stringify(h.app.state().mem)));
    assert.equal(mem.scenes[0].segs[0].points[0].loot[0].room, h.app.roomKey());
    const moved = core.detachMem(core.detachMem(mem, 'room-A'), 'room-B');
    assert.deepEqual(moved.scenes[0].segs[0].points[0].loot, mem.scenes[0].segs[0].points[0].loot);
    const rekeyed = core.applyRekey(mem, 's1', { 'g1.0': false });
    assert.equal(core.pointInjected(rekeyed.scenes[0].segs[0].points[0]), true);
    await h.app.handle('key-toggle', 's1|g1|0');
    const deselected = core.cleanMem(h.app.state().mem).scenes[0].segs[0].points[0];
    assert.equal(deselected.keyUser, false); assert.equal(core.pointSymbol(deselected), '○'); assert(deselected.loot.length);
});

test('queue deletion persists and does not affect source messages or call a model', async () => {
    const h = harness(); await h.app.addLoot(0, 'kept a token.');
    const id = h.app.state().lootQueue[0].id, text = h.context.chat[0].mes;
    await h.app.handle('loot-delete', id);
    assert.equal(h.app.state().lootQueue.length, 0); assert.equal(h.writes.at(-1).lootQueue.length, 0);
    assert.equal(h.context.chat[0].mes, text); assert.equal(h.calls.length, 0);
});

test('oversized old source is retained intact and deferred before a model request', async () => {
    const text = 'Full source '.repeat(1000) + 'TAIL';
    const h = harness({ messages: [text], recorded: true });
    await h.app.addLoot(0, 'TAIL'); h.app.settings().inputChars = 5000;
    await h.app.summarize();
    assert.equal(h.calls.length, 0); assert.equal(h.app.state().lootQueue.length, 1);
    assert.match(h.app.state().lootQueue[0].error, /반영 실패/);
    assert.equal(h.context.chat[0].mes, text);
});

test('checkpoint consumes only marks in confirmed-finished scenes and leaves the ongoing source queued', async () => {
    const h = harness({ messages: Array(5).fill('A participant kept a token.') });
    await h.app.addLoot(0, 'kept a token.'); await h.app.addLoot(4, 'kept a token.');
    await h.app.autoCollect();
    assert.equal(h.app.state().lastIndex, 2);
    assert.equal(h.app.state().lootQueue.length, 1); assert.equal(h.app.state().lootQueue[0].msg, 4);
    assert.equal(points(h)[0].loot[0].msg, 0);
    const sent = h.calls.filter(p => p.includes('[USER-SELECTED'));
    assert(sent.every(p => !p.includes(h.app.state().lootQueue[0].id)));
});

test('a timed-out new extraction persists a failure marker and does not consume or hide the source', async () => {
    const h = harness(); await h.app.addLoot(0, 'kept a token.');
    h.model = async () => { throw new h.app.RequestTimeout('Timed out'); };
    await h.app.summarize();
    assert.equal(h.app.state().lastIndex, -1); assert.equal(h.app.state().lootQueue.length, 1);
    assert.match(h.app.state().lootQueue[0].error, /반영 실패/);
    assert.match(h.writes.at(-1).lootQueue[0].error, /반영 실패/);
    assert(!h.context.chat[0].is_system);
});

test('a late response after the source or room changes cannot save points or dequeue selections', async () => {
    for (const change of [h => { h.context.chat[0].mes += ' Changed'; }, h => { h.context.chatId = 'room-B'; }]) {
        const h = harness({ recorded: true }); await h.app.addLoot(0, 'kept a token.');
        h.model = async (prompt, run, items) => {
            change(h);
            return JSON.stringify({ points: [{ text: 'The participant kept a token.', kind: 'moment', msgs: [0], lootIds: [items[0].id] }] });
        };
        await h.app.summarize();
        assert.equal(points(h).length, 0); assert.equal(h.app.state().lootQueue.length, 1);
    }
});

test('reloading metadata restores the queue and loading a memory slot preserves this room queue', async () => {
    const h = harness(); await h.app.addLoot(0, 'kept a token.');
    const stored = JSON.parse(JSON.stringify(h.writes.at(-1))), id = stored.lootQueue[0].id;
    h.context.chatMetadata.savePoint = stored;
    assert.equal(h.app.state().lootQueue[0].id, id);
    h.app.setSlot({ id: 'slot', auto: false, room: 'room-old', mem: core.emptyMem() });
    await h.app.loadSave('slot', 'continue');
    assert.equal(h.app.state().lootQueue[0].id, id);
    assert.equal(h.app.state().lootQueue[0].room, h.app.roomKey());
});

test('rewinding a successful save restores its pending selections along with the previous journal', async () => {
    const h = harness(); await h.app.addLoot(0, 'kept a token.');
    const id = h.app.state().lootQueue[0].id;
    await h.app.summarize(); await h.app.handle('undo');
    assert.equal(h.app.state().lastIndex, -1); assert.equal(points(h).length, 0);
    assert.equal(h.app.state().lootQueue[0].id, id);
});

test('a second selection can merge into the same existing journal point without duplicate points', async () => {
    const h = harness(); await h.app.addLoot(0, 'kept a token.'); await h.app.summarize();
    await h.app.addLoot(0, 'a token.'); await h.app.summarize();
    assert.equal(points(h).length, 1); assert.equal(points(h)[0].loot.length, 2);
    assert.equal(h.app.state().lootQueue.length, 0);
    const statement = h.app.checkStatements(h.app.state(), { records: [], segs: ['g1'] }).find(x => x.id === 'g1.0');
    assert.match(statement.line, /User-selected excerpts/);
    assert.match(statement.line, /kept a token/);
});

test('a deleted historical scene leaves its selection queued with an explicit failure and no model call', async () => {
    const h = harness({ recorded: true }); await h.app.addLoot(0, 'kept a token.');
    h.app.state().mem.scenes = [];
    await h.app.summarize();
    assert.equal(h.calls.length, 0); assert.equal(h.app.state().lootQueue.length, 1);
    assert.match(h.app.state().lootQueue[0].error, /해당 장면이 없어요/);
});

test('message tool buttons appear once on RP replies, open the looting form, and queue only on submit', async () => {
    const h = harness({ messages: ['A participant kept a token.', 'A user reply.'] });
    h.context.chat[1].is_user = true;
    let dialog;
    const elements = h.context.chat.map((_, index) => {
        const element = { children: [], getAttribute: () => String(index) };
        const row = { querySelector: () => null, append(node) { element.children.push(node); node.remove = () => { element.children = element.children.filter(x => x !== node); }; } };
        const nameText = { parentElement: row, insertAdjacentElement(where, node) { node.previousElementSibling = nameText; if (!element.children.includes(node)) row.append(node); } };
        element.querySelector = q => q === '.sp-loot-button' ? element.children[0] : q === '.name_text' ? nameText : null;
        return element;
    });
    const previous = globalThis.document;
    const fields = Object.fromEntries(['[name=excerpt]', '[name=note]', '.sp-loot-full', '.sp-loot-cancel', '.sp-loot-error', '[type=submit]', 'form'].map(k => [k, { value: '' }]));
    globalThis.document = {
        querySelectorAll: () => elements, querySelector: () => dialog,
        body: { append(node) { dialog = node; } },
        createElement(tag) {
            if (tag !== 'dialog') return { setAttribute() {} };
            let onClose;
            return { querySelector: q => fields[q], showModal() { this.open = true; },
                addEventListener(name, fn) { if (name === 'close') onClose = fn; },
                close() { this.open = false; onClose?.(); }, remove() { dialog = undefined; } };
        },
    };
    try {
        h.app.installLootButtons(); h.app.installLootButtons();
        assert.equal(elements[0].children.length, 1); assert.equal(elements[1].children.length, 0);
        elements[0].children[0].onclick({ preventDefault() {}, stopPropagation() {} });
        assert(dialog.open); assert.match(dialog.innerHTML, /💎 루팅/);
        assert.match(dialog.innerHTML, /메모 \(선택\)/);
        assert.equal(h.calls.length, 0); assert.equal(h.app.state().lootQueue.length, 0);
        fields['.sp-loot-full'].onclick(); assert.equal(fields['[name=excerpt]'].value, h.context.chat[0].mes);
        fields['[name=excerpt]'].value = 'kept a token.'; fields['[name=note]'].value = 'Important';
        await fields.form.onsubmit({ preventDefault() {} });
        assert.equal(h.app.state().lootQueue.length, 1); assert.equal(h.calls.length, 0); assert.equal(dialog, undefined);
    } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('an oversized historical source does not prevent a separate small selection being saved', async () => {
    const h = harness({ messages: ['Large source '.repeat(2000) + 'TAIL', 'A participant kept a token.'], recorded: true });
    await h.app.addLoot(0, 'TAIL'); await h.app.addLoot(1, 'kept a token.');
    h.app.settings().inputChars = 5000;
    await h.app.summarize();
    assert.equal(h.calls.length, 1); assert.equal(h.app.state().lootQueue.length, 1);
    assert.equal(h.app.state().lootQueue[0].msg, 0); assert.equal(points(h)[0].loot[0].msg, 1);
});

test('rewind preserves selections added after a save and does not resurrect a manually deleted pending item', async () => {
    const h = harness(); await h.app.addLoot(0, 'kept a token.');
    const consumed = h.app.state().lootQueue[0].id;
    await h.app.summarize(); await h.app.addLoot(0, 'a token.');
    const later = h.app.state().lootQueue[0].id;
    await h.app.handle('undo');
    assert.deepEqual(new Set(h.app.state().lootQueue.map(x => x.id)), new Set([consumed, later]));

    const f = harness(); await f.app.addLoot(0, 'kept a token.');
    const deleted = f.app.state().lootQueue[0].id;
    f.model = async () => JSON.stringify({ scenes: [{ scene: 'new', title: 'A trip', where: '', who: [], outline: 'A trip began.', notes: '', points: [], ended: false }], entities: [], changes: [] });
    await f.app.summarize(); await f.app.handle('loot-delete', deleted);
    await f.app.handle('undo');
    assert.equal(f.app.state().lootQueue.length, 0);
});

test('source rollback returns lost looting with its original note and fingerprint, without rebinding edits', async () => {
    for (const editIndex of [0, 2]) {
        const h = harness({ messages: Array(3).fill('A participant kept a token.') });
        await h.app.addLoot(2, 'kept a token.', 'Remember this event');
        const item = structuredClone(h.app.state().lootQueue[0]);
        await h.app.summarize();
        h.context.chat[editIndex].mes += ' An edit.';
        assert(h.app.reconcile());
        assert.equal(h.app.state().lastIndex, -1); assert.equal(points(h).length, 0);
        const restored = h.app.state().lootQueue.find(x => x.id === item.id);
        assert(restored); assert.equal(restored.note, item.note); assert.equal(restored.hash, item.hash);
        assert.equal(loot.lootStatus(restored, h.app.roomKey(), h.context.chat, h.app.fingerprint), editIndex === 2 ? '원문이 바뀜' : '');
    }
});

test('an earlier exact-position save restores removed loot; undoing that load avoids duplicate queued work', async () => {
    const h = harness(); await h.app.summarize();
    const slot = h.app.saveRecord(h.app.state(), 'Earlier', 'slot');
    h.context.chat.push({ name: 'Participant', mes: 'A participant kept a token.', is_user: false, extra: {} });
    await h.app.addLoot(1, 'kept a token.', 'Later selection');
    const item = structuredClone(h.app.state().lootQueue[0]);
    await h.app.summarize();
    h.app.setSlot(slot); await h.app.loadSave('slot', 'continue');
    assert.equal(h.app.state().lastIndex, 0); assert.equal(points(h).length, 0);
    assert.equal(h.app.state().lootQueue[0].id, item.id);
    assert.equal(h.app.state().lootQueue[0].note, item.note);
    await h.app.handle('undo');
    assert.equal(h.app.state().lastIndex, 1); assert.equal(points(h)[0].loot[0].id, item.id);
    assert.equal(h.app.state().lootQueue.length, 0);
});

test('a boundary failure never marks ongoing-scene selections as failed', async () => {
    const h = harness({ messages: Array(5).fill('A participant kept a token.') });
    await h.app.addLoot(4, 'kept a token.');
    h.model = async () => { throw new h.app.RequestTimeout('Boundary timed out'); };
    await h.app.autoCollect();
    assert.equal(h.app.state().lootQueue.length, 1);
    assert.equal(h.app.state().lootQueue[0].error, undefined);
    assert(!h.notices.some(([, msg]) => /루팅한 내용 .*반영되지/.test(msg)));
});

test('a failed quicksave batch does not mark a later unsent selection as failed', async () => {
    const h = harness({ messages: Array.from({ length: 40 }, () => 'A participant kept a token. ' + 'x'.repeat(1000)) });
    h.app.settings().inputChars = 20000;
    await h.app.addLoot(0, 'kept a token.'); await h.app.addLoot(39, 'kept a token.');
    h.model = async (prompt, run, items) => {
        if (h.calls.length === 2) throw new h.app.RequestTimeout('Second batch timed out');
        return JSON.stringify({ scenes: [{ scene: 'new', title: 'A trip', where: '', who: [], outline: 'A trip began.', notes: '',
            points: items.map(x => ({ text: 'The participant kept a token.', kind: 'moment', key: false, msgs: [x.msg], lootIds: [x.id] })), ended: false }], entities: [], changes: [] });
    };
    await h.app.summarize();
    assert(h.app.state().lastIndex >= 0 && h.app.state().lastIndex < 39);
    assert.equal(h.app.state().lootQueue.length, 1);
    assert.equal(h.app.state().lootQueue[0].msg, 39);
    assert.equal(h.app.state().lootQueue[0].error, undefined);
    assert(!h.calls.some(p => p.includes(h.app.state().lootQueue[0].id)));
});

test('rendered excerpts tolerate markdown and whitespace differences but store the actual contiguous source', async () => {
    const raw = '*A participant* kept **a token**.\n\nIt was blue.';
    const h = harness({ messages: [raw] });
    await h.app.addLoot(0, 'A participant kept a token. It was blue.');
    const item = h.app.state().lootQueue[0];
    assert(raw.includes(item.text)); assert(core.findQuote(raw, item.text));
    await assert.rejects(h.app.addLoot(0, 'A participant destroyed a token.'), /원문/);
});

test('later saves cannot erase the recovery note and original hash stored on older looted points', async () => {
    const h = harness(); await h.app.addLoot(0, 'kept a token.', 'An early selection');
    const item = structuredClone(h.app.state().lootQueue[0]); await h.app.summarize();
    const source = core.cleanMem(h.app.state().mem).scenes[0].segs[0].points[0].loot[0];
    assert.equal(source.hash, item.hash); assert.equal(source.note, item.note); assert.equal(source.at, item.at);
    h.context.chat.push({ name: 'Participant', mes: 'The journey continued.', is_user: false, extra: {} });
    await h.app.summarize(); assert.equal(h.app.state().undo.lootQueue.length, 0);
    h.context.chat[0].mes += ' An edit.';
    assert(h.app.reconcile());
    const restored = h.app.state().lootQueue[0];
    assert.equal(restored.hash, item.hash); assert.equal(restored.note, item.note);
    assert.equal(loot.lootStatus(restored, h.app.roomKey(), h.context.chat, h.app.fingerprint), '원문이 바뀜');
});

test('legacy loot uses only saved snapshot or recorded hashes for recovery, never a fresh fingerprint', async () => {
    const h = harness(); await h.app.addLoot(0, 'kept a token.', 'Old note');
    const item = structuredClone(h.app.state().lootQueue[0]); await h.app.summarize();
    const source = points(h)[0].loot[0]; delete source.hash; delete source.note; delete source.at;
    await h.app.handle('undo');
    assert.equal(h.app.state().lootQueue[0].hash, item.hash);
    assert.equal(h.app.state().lootQueue[0].note, item.note);

    await h.app.summarize(); delete points(h)[0].loot[0].hash;
    h.app.state().undo = null; h.context.chat[0].mes += ' Changed';
    assert(h.app.reconcile());
    assert.equal(h.app.state().lootQueue[0].hash, item.hash);

    const unknown = loot.restoreLostLoot([], { scenes: [{ segs: [{ points: [{ loot: [{ id: 'old', room: 'room-A', msg: 0, quote: 'Old text' }] }] }] }] }, core.emptyMem(), { room: 'room-A' });
    assert.equal(unknown[0].hash, '');
    assert.equal(loot.lootStatus(unknown[0], 'room-A', [], () => 'new fingerprint'), '원문 확인 필요');
});

test('foreign restored loot keeps its source and cannot borrow current-room hashes or message numbers', () => {
    const before = { scenes: [{ segs: [{ points: [{ loot: [{ id: 'foreign', room: 'other-room', msg: 0, quote: 'A prior event' }] }] }] }] };
    const queue = loot.restoreLostLoot([], before, core.emptyMem(), { room: 'current-room', hashes: ['current fingerprint'] });
    assert.equal(queue.length, 1); assert.equal(queue[0].room, 'other-room'); assert.equal(queue[0].hash, '');
    assert.equal(loot.lootStatus(queue[0], 'current-room', [], () => { throw new Error('Must not inspect current original'); }), '출처가 다른 방이에요');
});

test('legacy evidence moved back to its original room still cannot borrow new hashes for imported segments', () => {
    const before = { scenes: [{ segs: [{ external: true, source: { room: 'room-A', from: 0, to: 0 }, points: [{ msgs: [],
        loot: [{ id: 'roundtrip', room: 'room-A', msg: 0, quote: 'An older version of the event' }] }] }] }] };
    const queue = loot.restoreLostLoot([], before, core.emptyMem(), { room: 'room-A', hashes: ['new unrelated fingerprint'] });
    assert.equal(queue[0].hash, '');
    assert.equal(loot.lootStatus(queue[0], 'room-A', [], () => 'new unrelated fingerprint'), '원문 확인 필요');
});

test('failed undo and earlier-slot writes preserve both existing queue edits and current looted memory', async () => {
    const h = harness(); await h.app.summarize();
    const slot = h.app.saveRecord(h.app.state(), 'Earlier', 'slot');
    await h.app.addLoot(0, 'kept a token.'); await h.app.summarize(); await h.app.addLoot(0, 'a token.');
    const before = JSON.stringify(h.app.state());
    h.failWrite = true;
    await assert.rejects(h.app.handle('undo'), /채팅 파일/);
    assert.equal(JSON.stringify(h.app.state()), before);
    h.app.setSlot(slot);
    await h.app.loadSave('slot', 'continue');
    assert(h.notices.some(([kind, message]) => kind === 'error' && message.includes('채팅 파일')));
    assert.equal(JSON.stringify(h.app.state()), before);
});

test('a failed checkpoint extraction marks only the selections actually sent in its finished range', async () => {
    const h = harness({ messages: Array(5).fill('A participant kept a token.') });
    await h.app.addLoot(0, 'kept a token.'); await h.app.addLoot(4, 'kept a token.');
    h.model = async prompt => {
        if (prompt.startsWith('You are marking')) return JSON.stringify({ continues_open_scene: false, scenes: [{ start: 0, ended: true }, { start: 3, ended: false }] });
        throw new h.app.RequestTimeout('Extraction timed out');
    };
    await h.app.autoCollect();
    const items = h.app.state().lootQueue;
    assert.equal(items.length, 2); assert.match(items.find(x => x.msg === 0).error, /반영 실패/);
    assert.equal(items.find(x => x.msg === 4).error, undefined);
    assert(h.notices.some(([, msg]) => msg.includes('루팅한 내용 1개')));
});
