import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../core.js';
import * as provenance from '../provenance.js';
import * as batches from '../request-batches.js';
import { buildCheckPrompt } from '../prompts.js';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const quote = 'I will return the token tomorrow.';
const chunk = (from, to, texts = {}) => ({ from, to, indices: Array.from({ length: to - from + 1 }, (_, n) => from + n), texts, text: '' });

function original() {
    return core.applyResult(core.emptyMem(), {
        scenes: [{ scene: 'new', title: 'An unfinished trip', where: 'Gate', who: ['person', 'token'],
            outline: 'A participant borrows a token and promises to return it.', notes: 'The trip continues.', ended: false,
            points: [{ text: 'A participant borrowed a token.', kind: 'change', key: true, msgs: [48, 49] }] }],
        entities: [{ ref: 'person', type: 'person', name: 'Participant', aliases: [] }, { ref: 'token', type: 'item', name: 'Token', aliases: [] }],
        changes: [{ op: 'add', type: 'quest', kind: 'promise', status: 'open', who: ['person'], text: 'Participant promised to return the token.', terms: { msg: 48, quote }, msgs: [48] }],
    }, chunk(48, 49, { 48: quote, 49: 'The token is borrowed.' })).mem;
}
function updateInNextRoom(mem) {
    const data = { scenes: [{ scene: 'continue', title: 'Ignored new title', where: 'Gate', who: ['e1', 'e2'],
        outline: 'The token is returned during the same trip.', notes: 'The trip continues.', ended: false,
        points: [{ text: 'Participant returned the token.', kind: 'change', key: true, msgs: [0] }] }], entities: [],
        changes: [{ op: 'update', id: 'r1', status: 'done', text: 'Participant returned the borrowed token.', msgs: [0] }] };
    const batch = chunk(0, 1, { 0: 'Participant returned the borrowed token.', 1: 'The trip continues.' });
    assert.deepEqual(core.validateResult(data, { mem, chunk: batch }), []);
    return core.applyResult(mem, data, batch).mem;
}
function legacyMixed() {
    const a = original();
    delete a.evidenceVersion;
    for (const r of a.records) delete r.evidenceVersion;
    a.scenes[0].external = true;
    a.scenes[0].status = 'closed';
    a.scenes.push({ id: 's2', title: 'Later scene', where: '', who: [], status: 'open', star: false, pin: false,
        segs: [{ id: 'g2', from: 0, to: 1, outline: 'Later events.', notes: '', points: [{ text: 'A later event.', kind: 'moment', msgs: [0] }] }] });
    a.records[0].src.push('g2'); a.records[0].msgs.push(0);
    return a;
}

test('moving to a fresh chat keeps the scene open and quarantines every old message index', () => {
    const a = original(), before = JSON.stringify(a);
    const b = core.detachMem(a, 'room-A');
    assert.equal(core.openScene(b).id, a.scenes[0].id);
    assert.equal(b.scenes[0].segs[0].from, null);
    assert.equal(b.scenes[0].segs[0].to, null);
    assert.deepEqual(b.scenes[0].segs[0].source, { room: 'room-A', from: 48, to: 49 });
    assert.deepEqual(b.scenes[0].segs[0].points[0].msgs, []);
    assert.deepEqual(b.scenes[0].segs[0].points[0].oldEvidence, [{ room: 'room-A', msgs: [48, 49] }]);
    assert.deepEqual(b.records[0].msgs, []);
    assert.equal(b.records[0].terms.msg, null);
    assert.deepEqual(b.records[0].terms.source, { room: 'room-A', msg: 48 });
    assert.equal(b.records[0].terms.quote, a.records[0].terms.quote);
    assert.equal(JSON.stringify(a), before);
});

test('the same open scene accepts a new local segment and completes an imported promise', () => {
    const b = updateInNextRoom(core.detachMem(original(), 'room-A'));
    assert.equal(b.scenes.length, 1);
    assert.equal(core.openScene(b).id, 's1');
    assert.equal(b.scenes[0].title, 'An unfinished trip');
    assert.equal(b.scenes[0].external, undefined);
    assert.equal(b.scenes[0].segs[0].external, true);
    assert.equal(b.scenes[0].segs[1].external, undefined);
    assert.equal(b.scenes[0].segs[1].from, 0);
    assert.equal(b.records[0].status, 'done');
    assert.deepEqual(b.records[0].msgs, [0]);
    assert.deepEqual(b.records[0].oldEvidence, [{ room: 'room-A', msgs: [48] }]);
    assert.equal(b.records[0].terms.source.room, 'room-A');
});

test('A to B to C preserves each original source and distinguishes equal old message numbers', () => {
    const b = updateInNextRoom(core.detachMem(original(), 'room-A'));
    const c = core.detachMem(b, 'room-B');
    assert.equal(c.scenes[0].segs[0].source.room, 'room-A');
    assert.equal(c.scenes[0].segs[1].source.room, 'room-B');
    assert.deepEqual(c.records[0].oldEvidence, [{ room: 'room-A', msgs: [48] }, { room: 'room-B', msgs: [0] }]);
    assert.equal(c.records[0].terms.source.room, 'room-A');
    const d = updateInNextRoom(c);
    assert.deepEqual(d.records[0].msgs, [0]);
    assert.deepEqual(d.records[0].oldEvidence, c.records[0].oldEvidence);
    assert.equal(d.scenes[0].segs.length, 3);
});

test('save/import round trips preserve source metadata, open state and active evidence', () => {
    const b = updateInNextRoom(core.detachMem(original(), 'room-A'));
    const restored = core.cleanMem(JSON.parse(JSON.stringify(b)));
    assert.deepEqual(restored, b);
    const c = core.detachMem(restored, 'room-B');
    assert.deepEqual(core.cleanMem(JSON.parse(JSON.stringify(c))), c);
});

test('legacy imported records with mixed old/new indexes become unknown-source evidence', () => {
    const restored = core.cleanMem(legacyMixed());
    assert.equal(restored.evidenceVersion, 1);
    assert.equal(restored.scenes[0].segs[0].source.room, null);
    assert.deepEqual(restored.records[0].msgs, []);
    assert.deepEqual(restored.records[0].oldEvidence, [{ room: null, msgs: [48, 0] }]);
    assert.equal(restored.records[0].terms.source.room, null);
    assert.equal(restored.records[0].terms.source.msg, 48);
    assert.equal(restored.scenes[0].status, 'closed'); // never guess whether an old scene should reopen
    assert.equal(restored.scenes[1].status, 'open');
    assert.equal(provenance.upgradeEvidence(restored), restored);
});

test('a later local update is not archived again during cleaning or a second migration', () => {
    const restored = core.cleanMem(legacyMixed());
    restored.records[0].msgs = [1];
    const before = JSON.stringify(restored.records[0].oldEvidence);
    restored.evidenceVersion = 0; // e.g. restoring an old history entry
    const migrated = provenance.upgradeEvidence(restored);
    assert.deepEqual(migrated.records[0].msgs, [1]);
    assert.equal(JSON.stringify(migrated.records[0].oldEvidence), before);
    assert.deepEqual(core.cleanMem(migrated).records[0].msgs, [1]);
});

test('legacy records whose source segment was deleted are quarantined instead of guessing a room', () => {
    const old = original();
    delete old.evidenceVersion; delete old.records[0].evidenceVersion;
    old.records[0].src = ['g999'];
    const restored = core.cleanMem(old);
    assert.deepEqual(restored.records[0].msgs, []);
    assert.equal(restored.records[0].oldEvidence[0].room, null);
    assert.equal(restored.records[0].terms.source.room, null);
});

test('explicitly closed scenes stay closed when transferred to another room', () => {
    const closed = core.closeOpenScene(original());
    assert.equal(core.openScene(core.detachMem(closed, 'room-A')), null);
});

test('new current-room agreement terms replace the old cached source without mutating earlier memory', () => {
    const b = core.detachMem(original(), 'room-A');
    const data = { scenes: [{ scene: 'continue', title: 'Trip', who: [], outline: 'The agreement is renewed.', points: [], ended: false }],
        entities: [], changes: [{ op: 'update', id: 'r1', terms: { msg: 0, quote: 'I will return the token next week.' }, msgs: [0] }] };
    const c = chunk(0, 0, { 0: 'I will return the token next week.' });
    assert.deepEqual(core.validateResult(data, { mem: b, chunk: c }), []);
    const after = core.applyResult(b, data, c).mem;
    assert.equal(after.records[0].terms.msg, 0);
    assert.equal(after.records[0].terms.source, undefined);
    assert.equal(b.records[0].terms.source.room, 'room-A');
    assert.deepEqual(core.cleanMem(after).records[0].terms, after.records[0].terms);
});

test('history undo/redo keeps imported sources separated while restoring local evidence', () => {
    const before = core.detachMem(original(), 'room-A'), after = updateInNextRoom(before);
    const diff = core.memDiff(before, after);
    assert.deepEqual(core.applyDiff(after, diff, true), before);
    assert.deepEqual(core.applyDiff(before, diff), after);
});

test('old segment references keep their true source through another move', () => {
    const b = updateInNextRoom(core.detachMem(original(), 'room-A'));
    b.records[0].msgs.push('g1');
    const c = core.detachMem(b, 'room-B');
    assert(c.records[0].oldEvidence.find(x => x.room === 'room-A').msgs.includes('g1'));
    assert(!c.records[0].oldEvidence.find(x => x.room === 'room-B').msgs.includes('g1'));
});

test('segment references to imported scenes never resolve to current numeric evidence', () => {
    const b = updateInNextRoom(core.detachMem(original(), 'room-A'));
    const resolved = provenance.evidenceNumbers(b, ['g1', 'g2']);
    assert.deepEqual(resolved.messages, [0]);
    assert.equal(resolved.external[0].room, 'room-A');
});

test('closing a scene remains an explicit story action after a move', () => {
    const b = core.detachMem(original(), 'room-A');
    assert(core.openScene(b));
    assert.equal(core.openScene(core.closeOpenScene(b)), null);
});

function reviewHarness(mem) {
    const st = { mem, rev: 0 }, calls = [], reads = [];
    const chat = new Proxy(Array.from({ length: 60 }, (_, n) => ({ name: 'Current', mes: n === 0 ? 'Participant returned the borrowed token.' : n === 48 ? 'UNRELATED CURRENT ROOM MESSAGE 48' : `Current event ${n}.` })), {
        get(target, key) { if (/^\d+$/.test(String(key))) reads.push(Number(key)); return target[key]; },
    });
    const box = { ...core, ...provenance, ...batches, buildCheckPrompt, names: () => ({}), state: () => st, chat: () => chat,
        eligible: () => true, speaker: m => m.name, cleanText: s => s, ui: {}, num: () => 60000,
        newRun: () => ({ cancelled: false }), assertValid() {}, endRun() {}, render() {}, persistSoon() {},
        errorText: e => e.message, fmtSec: () => '0초', replyKind: () => null, parseJson: JSON.parse,
        Cancelled: class extends Error {}, RequestTimeout: class extends Error {}, retryNote: () => '',
        async llm(prompt) { calls.push(prompt); return '{"issues":[]}'; },
    };
    const code = section('function checkStatements(', '\nfunction queueCheck') + section('async function runCheck(', '\nconst gapText');
    const api = vm.runInNewContext(code + ';({checkStatements,runCheck})', box);
    return { ...api, box, st, calls, reads, chat };
}

test('review of an updated imported promise uses current evidence and cached terms, never the old numeric index', async () => {
    const h = reviewHarness(updateInNextRoom(core.detachMem(original(), 'room-A')));
    const before = JSON.stringify(h.st.mem);
    await h.runCheck(h.st, { records: ['r1'], segs: ['g2'] });
    assert(h.calls.length > 0);
    assert(h.calls.some(p => p.includes(quote) && p.includes('Participant returned the borrowed token.')));
    assert(h.calls.every(p => !p.includes('UNRELATED CURRENT ROOM MESSAGE 48')));
    assert(!h.reads.includes(48));
    assert.equal(h.st.check.status, 'issues');
    assert(h.st.check.issues.some(i => i.kind === 'partial' && i.problem.includes('근거가 이전 방')));
    assert.equal(JSON.stringify(h.st.mem), before);
    assert.equal(h.st.mem.records[0].status, 'done');
});

test('review of old-only evidence is deferred without an API call or current-room index access', async () => {
    const h = reviewHarness(core.detachMem(original(), 'room-A'));
    await h.runCheck(h.st, { records: ['r1'], segs: ['g1'] });
    assert.equal(h.calls.length, 0);
    assert(!h.reads.includes(48));
    assert(h.st.check.issues.every(i => i.kind === 'partial'));
});

test('missing old context cannot generate an unsupported-claim warning about a fulfilled promise', async () => {
    const h = reviewHarness(updateInNextRoom(core.detachMem(original(), 'room-A')));
    h.box.llm = async () => JSON.stringify({ issues: [{ about: 'r1', kind: 'misread', basis: 'unsupported', problem: 'The earlier promise is not in the messages.', msgs: [0] }] });
    await h.runCheck(h.st, { records: ['r1'], segs: ['g2'] });
    assert(!h.st.check.issues.some(i => i.kind === 'misread'));
    assert(h.st.check.issues.some(i => i.kind === 'partial'));
    assert.equal(h.st.mem.records[0].status, 'done');
});

test('a contradiction quoting a real current-room original can still be reported', async () => {
    const h = reviewHarness(updateInNextRoom(core.detachMem(original(), 'room-A')));
    h.box.llm = async () => JSON.stringify({ issues: [{ about: 'r1', kind: 'misread', basis: 'contradicted', problem: 'A current event contradicts the record.', conflict: ['A statement.', 'Participant returned the borrowed token.'], msgs: [0] }] });
    await h.runCheck(h.st, { records: ['r1'], segs: ['g2'] });
    assert(h.st.check.issues.some(i => i.kind === 'misread'));
    assert(h.st.check.issues.some(i => i.kind === 'partial'));
});

test('a model citing an old number cannot fetch an unrelated current-room excerpt', async () => {
    const h = reviewHarness(updateInNextRoom(core.detachMem(original(), 'room-A')));
    h.box.llm = async () => JSON.stringify({ issues: [{ about: 'r1', kind: 'misread', basis: 'contradicted', problem: 'A claimed contradiction.', conflict: ['A statement.', 'Participant returned the borrowed token.'], msgs: [48] }] });
    await h.runCheck(h.st, { records: ['r1'], segs: ['g2'] });
    assert(!h.reads.includes(48));
    assert(h.st.check.issues.every(i => !i.excerpt.some(t => t.includes('UNRELATED'))));
    assert(h.st.check.issues.every(i => i.kind === 'partial'));
});

test('legacy imported data is made safe even before the review begins', () => {
    const h = reviewHarness(legacyMixed());
    h.checkStatements(h.st, { records: ['r1'], segs: ['g2'] });
    assert(!h.reads.includes(48));
});

test('raw recall skips old segments but can recall the new part of a mixed-source scene', () => {
    const h = reviewHarness(updateInNextRoom(core.detachMem(original(), 'room-A')));
    const recall = vm.runInNewContext(section('function rawExcerpt(', '\nfunction refreshInjection') + ';rawExcerpt', h.box);
    assert.equal(recall(h.st.mem.scenes[0]), 'Participant returned the borrowed token.');
    assert(!h.reads.includes(48));
    assert.equal(recall(core.detachMem(original(), 'room-A').scenes[0]), '');
});

test('evidence chips and terms distinguish old/current sources without attaching current-message actions', () => {
    const mem = core.detachMem(updateInNextRoom(core.detachMem(original(), 'room-A')), 'room-B');
    const helpers = section('function evidenceText(', '\nfunction whoChips');
    const api = vm.runInNewContext(helpers + ';({evidenceChips,priorTermsLabel})', { state: () => ({ mem }), esc: v => String(v) });
    const html = api.evidenceChips([0], mem.records[0].oldEvidence);
    assert(html.includes('이전 방 1 #48'));
    assert(html.includes('이전 방 2 #0'));
    assert(html.includes('>#0<'));
    assert(!html.includes('data-act'));
    assert.equal(api.priorTermsLabel(mem.records[0].terms), '이전 방 1 #48');
});

test('unknown legacy sources are explicitly labelled instead of displaying active-chat numbers', () => {
    const mem = core.cleanMem(legacyMixed());
    const api = vm.runInNewContext(section('function evidenceText(', '\nfunction whoChips') + ';({evidenceChips,priorTermsLabel})', { state: () => ({ mem }), esc: v => String(v) });
    assert(api.evidenceChips([], mem.records[0].oldEvidence).includes('이전 방·출처 미상'));
    assert(api.priorTermsLabel(mem.records[0].terms).includes('이전 방·출처 미상'));
});

test('opening existing chat metadata migrates old evidence once and schedules persistence', () => {
    const meta = { savePoint: { v: 1, mem: legacyMixed() } };
    let saves = 0;
    const state = vm.runInNewContext(section('function state() {', '\nfunction freshState') + ';state', {
        MODULE: 'savePoint', ctx: () => ({ chatMetadata: meta }), upgradeEvidence: provenance.upgradeEvidence, persistSoon: () => saves++,
    });
    assert.equal(state().mem.records[0].msgs.length, 0);
    assert.equal(state().mem.records[0].terms.source.room, null);
    state();
    assert.equal(saves, 1);
});

async function loadFixture(exact, mode = 'continue') {
    const originalChat = Array.from({ length: 50 }, (_, n) => ({ mes: `Original ${n}` }));
    const currentChat = exact ? [...originalChat, { mes: 'A new reply' }] : Array.from({ length: 5 }, (_, n) => ({ mes: `Different ${n}` }));
    const digest = xs => JSON.stringify(xs);
    const save = { id: 'slot', auto: false, room: 'room-A', pos: { lastIndex: 49, digest: digest(originalChat.map(m => m.mes)) } };
    const meta = {};
    const box = { clone: structuredClone, ...core, save, ui: {}, findSave: () => save, hasChat: () => true, readSave: async () => ({ mem: original() }),
        state: () => meta.savePoint || null, hasMemory: () => true, confirmBox: async () => true,
        freshState: extra => ({ v: 1, mem: core.emptyMem(), lastIndex: -1, hashes: [], floor: -1, ...extra }),
        chat: () => currentChat, hashesTo: n => currentChat.slice(0, n + 1).map(m => m.mes), digest,
        transact: async fn => fn(), ctx: () => ({ chatMetadata: meta }), MODULE: 'savePoint',
        pendingCount: () => currentChat.length, toastr: { success() {} }, reportError: e => { throw e; },
    };
    const load = vm.runInNewContext(section('async function loadSave(', '\nasync function renameSave') + ';loadSave', box);
    await load('slot', mode);
    return meta.savePoint;
}

test('loading a verified identical-prefix branch retains active indexes and an open scene', async () => {
    const st = await loadFixture(true);
    assert.equal(st.lastIndex, 49);
    assert.equal(core.openScene(st.mem).id, 's1');
    assert.deepEqual(st.mem.records[0].msgs, [48]);
    assert.equal(st.mem.scenes[0].external, undefined);
});

test('continue and route-copy into a different chat start at #0 while keeping the old scene open', async () => {
    for (const mode of ['continue', 'copy']) {
        const st = await loadFixture(false, mode);
        assert.equal(st.lastIndex, -1);
        assert.equal(core.openScene(st.mem).id, 's1');
        assert.equal(st.mem.scenes[0].segs[0].source.room, 'room-A');
        assert.deepEqual(st.mem.records[0].msgs, []);
        assert.equal(st.linkedSave, mode === 'continue' ? 'slot' : null);
    }
});
