// Exercise the shipped checkpoint/quicksave orchestration with model and disk boundaries mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as core from '../core.js';
import * as temporal from '../temporal.js';
import * as prompts from '../prompts.js';
import * as vault from '../vault.js';
import * as provenance from '../provenance.js';
import * as batches from '../request-batches.js';
import * as loot from '../loot.js';

function harness({ count = 20, chars = 30, reserve = 2, keep = 0, limit = 60000 } = {}) {
    const imported = { ...core, ...temporal, ...prompts, ...vault, ...provenance, ...batches, ...loot }, names = [];
    const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/^import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"];\n/gm, (_, list) => {
        names.push(...list.split(',').map(x => x.trim()).filter(Boolean)); return '';
    });
    const writes = [], calls = [], notices = [], backups = [], checks = [];
    const context = { characterId: 0, characters: [{ name: 'Participant', avatar: 'participant.png' }], chatId: 'room-A',
        chat: [], chatMetadata: {}, extensionSettings: { savePoint: { profileId: 'fake', autoEvery: 20, autoReserve: reserve, keepRecent: keep, inputChars: limit, check: false } },
        setExtensionPrompt() {}, saveSettingsDebounced() {},
        async saveMetadata() {
            h.writeCount++;
            if (h.writeCount === h.failWriteAt) throw new Error('Disk failed');
            writes.push(structuredClone(context.chatMetadata.savePoint));
        } };
    const toast = Object.fromEntries(['info', 'error', 'warning', 'success'].map(k => [k, msg => notices.push([k, msg])]));
    const app = new Function(...names, 'SillyTavern', 'jQuery', 'toastr', 'backups', 'checks', 'console', source + `
        setHidden = (m, i, hidden) => { m.is_system = !!hidden; };
        render = () => {}; persistSoon = () => {}; saveChatSoon = () => {};
        autosave = st => { if (st) backups.push({ lastIndex: st.lastIndex, mem: clone(st.mem) }); };
        queueCheck = (st, before, opts) => checks.push(opts);
        const realEnd = endRun; let lastNotice;
        endRun = run => { lastNotice = clone(run.notice); realEnd(run); };
        return { ensureState, state, settings, summarize, autoCollect, autoCount, autoBlocked, reconcile, undo, loadSave,
            addLoot, saveRecord, hudHtml, syncHide, ui, RequestTimeout, Cancelled,
            notice: () => lastNotice, setModel(fn) { llm = fn; },
            setSlot(rec) { findSave = () => rec; readSave = async () => rec; confirmBox = async () => true; } };
    `)(...names.map(n => imported[n]), { getContext: () => context }, () => {}, toast, backups, checks, { error() {}, warn() {} });
    const h = { app, context, writes, calls, notices, backups, checks, writeCount: 0, failWriteAt: Infinity, failAt: Infinity };
    h.add = (n, text = i => 'A participant continued walking. ' + 'x'.repeat(chars) + ' END' + i) => {
        for (let k = 0; k < n; k++) { const i = context.chat.length; context.chat.push({ name: 'Participant', mes: text(i), is_user: false, extra: {} }); }
    };
    h.add(count); app.ensureState();
    app.setModel(async (prompt, run) => {
        calls.push(prompt);
        if (h.model) return h.model(prompt, run);
        if (calls.length === h.failAt) throw new app.RequestTimeout('Timed out');
        const block = prompt.split(/\[NEW MESSAGES\][^\n]*\n/)[1]?.split('\n\nReturn ONLY')[0] || '';
        const nums = [...block.matchAll(/^#(\d+) /gm)].map(m => Number(m[1]));
        return JSON.stringify({ scenes: [{ scene: core.openScene(app.state().mem) ? 'continue' : 'new', title: 'A walk', where: 'Street',
            who: [], outline: 'The participants continued walking.', notes: '', points: [{ text: 'They walked together.', kind: 'moment', key: true, msgs: [nums[0]] }], ended: false }], entities: [], changes: [] });
    });
    return h;
}

test('checkpoint records an ongoing scene once, retains two messages and never asks for boundaries', async () => {
    const h = harness(); await h.app.autoCollect(); const st = h.app.state();
    assert.equal(h.calls.length, 1); assert(!h.calls.some(x => x.startsWith('You are marking')));
    assert.equal(st.lastIndex, 17); assert.equal(st.mem.scenes[0].status, 'open');
    assert.equal(st.autoMark, 19); assert.equal(h.app.autoCount(st), 0);
    assert(h.context.chat.slice(0, 18).every(m => m.is_system));
    assert(h.context.chat.slice(18).every(m => !m.is_system));
    assert.equal(h.backups.at(-1).lastIndex, 17); assert.equal(st.lastRecord.to, 17);
    assert.equal(h.app.notice().tone, 'success'); assert.match(h.app.notice().text, /최근 2개 여유분/);
});

test('next interval consumes the old tail and continues the same open scene', async () => {
    const h = harness(); await h.app.autoCollect(); const sid = h.app.state().mem.scenes[0].id;
    h.add(1); await h.app.autoCollect(); assert.equal(h.calls.length, 1);
    h.add(19); await h.app.autoCollect();
    const st = h.app.state(); assert.equal(st.lastIndex, 37); assert.equal(st.mem.scenes.length, 1);
    assert.equal(st.mem.scenes[0].id, sid); assert.equal(st.mem.scenes[0].segs[1].from, 18);
    assert.equal(st.mem.scenes[0].status, 'open');
});

test('manual quicksave includes the tail and clears the interval counter', async () => {
    const h = harness(); await h.app.autoCollect(); await h.app.summarize();
    assert.equal(h.app.state().lastIndex, 19); assert.equal(h.app.autoCount(h.app.state()), 0);
    assert.equal(h.app.state().lastRecord.kind, 'quicksave');
});

test('checkpoint balances the eligible prefix; retained messages and their loot never enter any request', async () => {
    const h = harness({ count: 32 });
    h.app.settings().autoEvery = 30;
    const result = await h.app.addLoot(31, h.context.chat[31].mes, 'Remember this later');
    assert(result);
    await h.app.autoCollect();
    const st = h.app.state(), segs = st.mem.scenes[0].segs;
    assert.deepEqual(segs.map(g => g.to - g.from + 1), [15, 15]);
    assert.equal(st.lastIndex, 29); assert.equal(h.calls.length, 2);
    assert(!h.calls.some(p => p.includes('END30') || p.includes('END31')));
    assert.equal(st.lootQueue.length, 1);
    assert(h.context.chat.slice(30).every(m => !m.is_system));
    await h.app.summarize();
    assert.equal(h.app.state().lastIndex, 31, 'manual save still includes the retained tail');
});

test('reserve zero records all; a reserve covering the pending range is a visible no-op without model calls', async () => {
    const a = harness({ reserve: 0 }); await a.app.autoCollect(); assert.equal(a.app.state().lastIndex, 19);
    const b = harness({ reserve: 20 }); await b.app.autoCollect();
    assert.equal(b.calls.length, 0); assert.equal(b.app.state().lastIndex, -1);
    assert.equal(b.app.state().autoLast.status, 'empty'); assert.equal(b.app.state().lastRecord, undefined);
    assert.equal(b.app.autoCount(b.app.state()), 0); assert(!b.context.chat.some(m => m.is_system));
});

test('a failed attempt waits for a full new interval and leaves its original range intact', async () => {
    const h = harness(); h.failAt = 1; await h.app.autoCollect();
    assert.equal(h.app.state().lastIndex, -1); assert.equal(h.app.state().autoLast.status, 'failed');
    assert.equal(h.app.notice().tone, 'warning'); assert(!h.context.chat.some(m => m.is_system));
    assert.equal(h.backups.length, 0); h.add(1); await h.app.autoCollect(); assert.equal(h.calls.length, 1);
    h.add(19); await h.app.autoCollect(); assert.equal(h.app.state().lastIndex, 37);
    assert.equal(h.app.state().autoFail, undefined);
});

test('a later batch failure preserves and backs up only the committed prefix, then resumes next interval', async () => {
    const h = harness({ count: 40, chars: 1500, limit: 30000 }); h.failAt = 2; await h.app.autoCollect();
    const saved = h.app.state().lastIndex; assert(saved >= 0 && saved < 37);
    assert.equal(h.app.state().lastRecord.to, saved); assert.equal(h.backups.at(-1).lastIndex, saved);
    assert.equal(h.app.state().autoLast.status, 'partial'); assert.equal(h.app.state().autoFail.from, saved + 1);
    assert(h.context.chat.slice(saved + 1).every(m => !m.is_system));
    const calls = h.calls.length; h.add(1); await h.app.autoCollect(); assert.equal(h.calls.length, calls);
    h.add(19); await h.app.autoCollect(); assert.equal(h.app.state().lastIndex, 57, JSON.stringify({ last: h.app.state().autoLast, errors: h.app.ui.lastError, notices: h.notices }));
    assert(h.calls[calls].includes('[NEW MESSAGES] #' + (saved + 1)));
});

test('a disk failure cannot publish a completed record or advance the actual-record timestamp', async () => {
    const h = harness(); h.failWriteAt = 1; await h.app.autoCollect(); const st = h.app.state();
    assert.equal(st.lastIndex, -1); assert.equal(st.lastRecord, undefined);
    assert.equal(st.autoFail.stage, 'save'); assert.equal(st.autoLast.status, 'failed');
    assert.equal(h.app.notice().tone, 'warning'); assert(!h.app.notice().text.includes('완료'));
    assert(h.context.chat.every(m => !m.is_system)); assert.equal(h.backups.length, 0);
});

test('input overflow does not permanently hold checkpoints; the next interval can retry', async () => {
    const h = harness({ chars: 30000, limit: 5000 }); await h.app.autoCollect();
    assert.equal(h.calls.length, 0); assert.equal(h.app.state().lastIndex, -1);
    assert.equal(h.app.state().autoHold, null);
    h.app.settings().inputChars = 100000; h.add(20, () => 'A short continuation.');
    await h.app.autoCollect(); assert(h.app.state().lastIndex >= 0);
});

test('a checkpoint rejected before sending does not label an earlier request as its failure', async () => {
    const h = harness({ limit: 5000 });
    h.app.ui.lastRequest = { task: 'Previous successful quicksave', chars: 100, maxTokens: 8000,
        textChars: 2, reasoningChars: 0, status: 'received' };
    const previous = h.app.ui.lastRequest;
    await h.app.autoCollect();
    const f = h.app.state().autoFail;
    assert.equal(h.calls.length, 0);
    assert.equal(f.attempts, 0);
    assert.equal(f.requestNotSent, true);
    assert.deepEqual(f.requestLines, []);
    assert.deepEqual(h.app.ui.lastError.request, []);
    assert.match(h.app.ui.lastError.requestNote, /AI 호출 없음/);
    assert.equal(h.app.ui.lastRequest, previous);
    assert.equal(f.failureId, h.app.ui.lastError.failureId);
});

test('a later chunk that cannot be planned does not reuse the preceding saved chunk diagnostics', async () => {
    const h = harness({ count: 40 });
    h.model = async (prompt, run) => {
        run.requestRecord = { task: 'Saved first chunk', chars: prompt.length, maxTokens: 8000,
            textChars: 2, reasoningChars: 0, status: 'received' };
        h.app.settings().inputChars = 5000;
        return JSON.stringify({ scenes: [{ scene: 'new', title: 'A walk', where: 'Street', who: [],
            outline: 'The participants continued walking.', notes: '', points: [], ended: false }], entities: [], changes: [] });
    };
    await h.app.autoCollect();
    assert.equal(h.calls.length, 1);
    const st = h.app.state();
    assert(st.lastIndex >= 0 && st.lastIndex < 37);
    assert.equal(st.autoLast.status, 'partial');
    assert.equal(st.autoFail.requestNotSent, true);
    assert.deepEqual(st.autoFail.requestLines, []);
    assert.deepEqual(h.app.ui.lastError.request, []);
});

test('hiding uses the whole-chat recent count, and retained messages stay visible regardless', async () => {
    const h = harness({ keep: 4 }); await h.app.autoCollect();
    assert.equal(h.app.state().lastIndex, 17);
    assert(h.context.chat.slice(0, 16).every(m => m.is_system));
    assert(h.context.chat.slice(16).every(m => !m.is_system));
    const last = h.app.state().lastIndex; h.context.chat.at(-1).mes = 'A swiped latest answer.';
    assert(h.app.reconcile()); assert.equal(h.app.state().lastIndex, last);
});

test('an empty retained tail is shown separately from the last actual saved range', async () => {
    const h = harness(); await h.app.autoCollect();
    const last = structuredClone(h.app.state().lastRecord);
    h.app.settings().autoEvery = 5; h.app.settings().autoReserve = 20;
    h.add(5); await h.app.autoCollect();
    assert.deepEqual(h.app.state().lastRecord, last);
    const html = h.app.hudHtml(h.app.state());
    assert.match(html, /마지막 자동 저장 시도/); assert.match(html, /마지막 실제 기록/);
    assert.match(html, /기록할 메시지 없음/);
});

test('room transfer preserves the open scene and starts recording with local message numbers', async () => {
    const h = harness(); await h.app.summarize(); const sid = h.app.state().mem.scenes[0].id;
    const rec = h.app.saveRecord(h.app.state(), 'A slot', 'slot', false); h.app.setSlot(rec);
    h.context.chatId = 'room-B'; h.context.chat = []; h.context.chatMetadata = {};
    await h.app.loadSave('slot'); h.add(20); await h.app.autoCollect();
    const st = h.app.state(); assert.equal(st.lastIndex, 17); assert.equal(st.mem.scenes.length, 1);
    assert.equal(st.mem.scenes[0].id, sid); assert.equal(st.mem.scenes[0].status, 'open');
    assert.equal(st.mem.scenes[0].segs.at(-1).from, 0); assert(st.mem.scenes[0].segs[0].source);
});

test('rewind restores the previous memory and actual-record range without hiding the retained tail', async () => {
    const h = harness(); await h.app.autoCollect(); const before = structuredClone(h.app.state().mem);
    const last = structuredClone(h.app.state().lastRecord); h.add(20); await h.app.autoCollect();
    await h.app.undo(); assert.deepEqual(h.app.state().mem, before); assert.deepEqual(h.app.state().lastRecord, last);
    assert(h.context.chat.slice(18).every(m => !m.is_system));
});

test('cancelled checkpoints retain the interval mark and can be saved manually', async () => {
    const h = harness(); h.model = async (prompt, run) => { run.cancelled = true; throw new h.app.Cancelled('Cancelled'); };
    await h.app.autoCollect(); assert.equal(h.app.state().lastIndex, -1);
    assert.equal(h.app.state().autoLast.status, 'cancelled'); assert.equal(h.app.state().autoMark, 19);
    h.add(1); await h.app.autoCollect(); assert.equal(h.calls.length, 1);
    h.model = null; await h.app.summarize(); assert.equal(h.app.state().lastIndex, 20);
});
