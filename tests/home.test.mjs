// v0.6.64 (step 0): the rules for keeping a room's memory in user files (home.js). Nothing uses them yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
    roomAddr, scopeOf, migrateId, homeId, memName, tagName, clueName, movedName, copyHash, fingerprint, digest, renameNotice, hasTraces,
    classifyRead, readUserFile, checked, validMem, validTag, memBody, tagBody, renamedTag, clueBody, clueWith, movedBody,
    pickPrints, firstDiff, printCheck, decideRoom, branchRestore, branchState, writePlan, canWrite, nextMem, wroteMine, maybeOverwritten,
    MISSING, BROKEN, ERROR, OK,
} from '../home.js';
import { emptyMem, pushHistory } from '../core.js';

const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const section = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));

// ───────── a small world of user files ─────────

const A = roomAddr('ari.png', 'Ari - 2026-01-01');
const B = roomAddr('ari.png', 'Ari - renamed');
const P = roomAddr('ari.png', 'Ari - main');          // a parent room
const G = roomAddr('group:7', 'Party chat');
const msgs = (n, f = i => `Message ${i}`) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, mes: f(i), swipe_id: 0 }));
const printsOf = list => list.map(fingerprint);
const P80 = printsOf(msgs(80));

// A memory that recorded `upto` messages of `prints`, one summary per `size` messages.
function recorded(prints, upto, { size = 5, floorTo = -1 } = {}) {
    const st = { v: 1, line: 'L', roomKey: P, mem: emptyMem(), lastIndex: -1, hashes: [], history: [], floor: -1, rev: 0, lootQueue: [] };
    for (let from = 0; from <= upto; from += size) {
        const to = Math.min(upto, from + size - 1);
        const before = st.mem;
        const after = structuredClone(before);
        after.scenes.push({ id: `s${from}`, title: `Scene ${from}`, status: 'closed', segs: [] });
        st.mem = after; st.lastIndex = to; st.hashes = prints.slice(0, to + 1);
        pushHistory(st, before, after, { kind: 'summary', from, to });
    }
    if (floorTo >= 0) { st.history = st.history.filter(h => h.from > floorTo); st.floor = floorTo; }
    return st;
}
const memFile = (id, { addr = A, integrity = 'i-A', state = recorded(P80, 19), from = { kind: 'new', addr, integrity }, rev = 0 } = {}) =>
    memBody({ id, state, rev, wid: 'w0', from, home: { addr, integrity } });

function world(files = {}, states = {}) {
    const store = new Map(Object.entries(files));
    const reads = [];
    const read = async name => {
        reads.push(name);
        if (states[name] === 'broken') return { kind: BROKEN, why: 'json' };
        if (states[name] === 'error') return { kind: ERROR, status: 500 };
        return store.has(name) ? { kind: OK, data: structuredClone(store.get(name)) } : { kind: MISSING };
    };
    return { store, read, reads };
}
const put = (files, name, body) => { files[name] = body; return files; };
// A room A linked by tag to memory `id`.
function linked({ integrity = 'i-A', copy = null, prints = pickPrints(P80.slice(0, 20)), state } = {}) {
    const id = homeId(A, integrity ?? 'none');
    const files = {};
    put(files, tagName(A), tagBody({ addr: A, integrity, mem: id, copy, prints }));
    put(files, memName(id), memFile(id, { integrity, state }));
    return { files, id };
}
const room = (extra = {}) => ({ addr: A, integrity: 'i-A', mainChat: null, copy: null, traces: false, prints: P80.slice(0, 30), renames: [], ...extra });

// ───────── names, ids and small helpers ─────────

test('room address is the same string as index.js roomKey', () => {
    assert.equal(A, JSON.stringify(['ari.png', 'Ari - 2026-01-01']));
    assert.match(section('function roomKey()', '\nfunction hasChat'), /JSON\.stringify\(\[ci\.key, String\(id\)\]\)/);
    assert.equal(scopeOf(G), 'group:7');
    assert.equal(scopeOf('not json'), null);
});

test('file names are safe user-file names, fixed per input, and differ per input', () => {
    const names = [memName(homeId(A, 'x')), memName(migrateId(A, 'c')), tagName(A), tagName(B), clueName('x'), movedName(A, 'c'), movedName(B, 'c')];
    for (const n of names) assert.match(n, /^savepoint-(mem|room|int|moved)-[a-z0-9]{28}\.json$/);
    assert.equal(new Set(names).size, names.length);
    assert.equal(tagName(A), tagName(roomAddr('ari.png', 'Ari - 2026-01-01')));
    assert.notEqual(homeId(A, 'c'), migrateId(A, 'c'));
    // Not the vault's names.
    for (const n of names) assert.doesNotMatch(n, /^savepoint-(auto|quick|slot|index)/);
});

test('fingerprint and digest are the ones index.js keeps', () => {
    const box = {};
    vm.runInNewContext(section('function hashString(', '// Visibility') + section('function fingerprint(', '// The translation') + 'this.fp = fingerprint; this.hs = hashString;', box);
    for (const m of [...msgs(4), { name: 'Me', is_user: true, mes: '한국어 ✨', swipe_id: 2 }, null, { mes: 'x' }]) assert.equal(fingerprint(m), box.fp(m));
    assert.equal(digest(['a', 'b']), box.hs('a|b'));
    // Visibility is not content.
    assert.equal(fingerprint({ ...msgs(1)[0], is_system: true }), fingerprint(msgs(1)[0]));
});

test('rename notice: names without .jsonl, group scope, nothing usable → null', () => {
    assert.deepEqual(renameNotice({ avatarId: 'ari.png', groupId: undefined, oldFileName: 'Ari - 2026-01-01.jsonl', newFileName: 'Ari - renamed.jsonl' }), { from: A, to: B });
    assert.deepEqual(renameNotice({ avatarId: undefined, groupId: '7', oldFileName: 'Party chat.jsonl', newFileName: 'Party 2.jsonl' }), { from: G, to: roomAddr('group:7', 'Party 2') });
    assert.equal(renameNotice({ avatarId: 'ari.png', oldFileName: 'x.jsonl', newFileName: 'x.jsonl' }), null);
    assert.equal(renameNotice({ oldFileName: 'x.jsonl', newFileName: 'y.jsonl' }), null);
    assert.equal(renameNotice(null), null);
});

test('SavePoint traces: the old copy or a SavePoint mark on a message', () => {
    assert.equal(hasTraces({}, msgs(3)), false);
    assert.equal(hasTraces({ savePoint: { v: 1 } }, []), true);
    for (const k of ['savepointHidden', 'savepointVisible', 'savepointHeld', 'savepointKeep']) assert.equal(hasTraces({}, [{ mes: 'x', extra: { [k]: true } }]), true);
    assert.equal(hasTraces({ other: 1 }, [{ mes: 'x', extra: { display_text: 'y' } }]), false);
});

test('fingerprints for a tag: first, last, spread; checks count misses and never pass with none', () => {
    const h = P80.slice(0, 20);
    assert.deepEqual(pickPrints(h).map(p => p.i), [0, 5, 10, 14, 19]);
    assert.deepEqual(pickPrints(h.slice(0, 2)).map(p => p.i), [0, 1]);
    assert.deepEqual(pickPrints([]), []);
    assert.deepEqual(printCheck(pickPrints(h), P80), { total: 5, matched: 5, first: -1 });
    const changed = [...P80]; changed[10] = 'other'; changed[14] = 'other';
    assert.deepEqual(printCheck(pickPrints(h), changed), { total: 5, matched: 3, first: 10 });
    assert.deepEqual(printCheck(pickPrints(h), P80.slice(0, 12)), { total: 5, matched: 3, first: 14 });
    assert.equal(firstDiff(h, P80), -1);
    assert.equal(firstDiff(h, P80.slice(0, 7)), 7);
});

// ───────── reading: four outcomes ─────────

test('a read is missing only on 404; broken and errors are never missing', async () => {
    assert.equal(classifyRead(404, '').kind, MISSING);
    assert.equal(classifyRead(500, '{}').kind, ERROR);
    assert.equal(classifyRead(403, '{}').kind, ERROR);
    assert.equal(classifyRead(200, '{"a":').kind, BROKEN);
    assert.equal(classifyRead(200, '<!DOCTYPE html><html>').kind, BROKEN);
    assert.equal(classifyRead(200, '').kind, BROKEN);
    assert.equal(classifyRead(200, '{"a":1}', d => d.a === 2).kind, BROKEN);
    assert.deepEqual(classifyRead(200, '{"a":1}'), { kind: OK, data: { a: 1 } });
    const res = (status, body) => ({ status, text: async () => body });
    assert.equal((await readUserFile(async () => { throw new Error('offline'); }, 'x.json')).kind, ERROR);
    assert.equal((await readUserFile(async () => ({ status: 200, text: async () => { throw new Error('cut'); } }), 'x.json')).kind, ERROR);
    assert.equal((await readUserFile(async () => res(404, 'nf'), 'x.json')).kind, MISSING);
    assert.equal((await readUserFile(async () => res(200, 'nope'), 'x.json')).kind, BROKEN);
    let asked = '';
    assert.deepEqual(await readUserFile(async url => { asked = url; return res(200, '[1]'); }, 'x.json'), { kind: OK, data: [1] });
    assert.match(asked, /^\/user\/files\/x\.json\?t=\d+$/);
});

test('a file that holds another name (or another shape) reads as broken', () => {
    const id = homeId(A, 'i-A');
    assert.equal(checked({ kind: OK, data: memFile(id) }, validMem(id)).kind, OK);
    assert.equal(checked({ kind: OK, data: memFile(id) }, validMem('other')).kind, BROKEN);
    assert.equal(checked({ kind: OK, data: tagBody({ addr: B, mem: id }) }, validTag(A)).kind, BROKEN);
    assert.equal(checked({ kind: OK, data: { ...memFile(id), state: { v: 1 } } }, validMem(id)).kind, BROKEN);
    assert.equal(checked({ kind: MISSING }, validMem(id)).kind, MISSING);
    assert.equal(checked(undefined, validMem(id)).kind, ERROR);
});

// ───────── opening a room: rows with a tag ─────────

test('row 0: a tag that cannot be read stops everything, whatever else would fit', async () => {
    for (const s of ['broken', 'error']) {
        const { files } = linked();
        const w = world(files, { [tagName(A)]: s });
        const r = await decideRoom(room({ integrity: 'other' }), w.read);
        assert.equal(r.verdict, 'readFail'); assert.equal(r.row, 0); assert.deepEqual(r.names, [tagName(A)]);
    }
    // No tag: a broken hint stops it even with an old copy that would move.
    const w = world({}, { [clueName('i-A')]: 'error' });
    const r = await decideRoom(room({ copy: { hash: 'c1', ok: true } }), w.read);
    assert.equal(r.verdict, 'readFail'); assert.equal(r.row, 0);
    // The parent's moved mark is needed for row 9: broken → stop.
    const w2 = world({}, { [movedName(P, 'c1')]: 'broken' });
    assert.equal((await decideRoom(room({ copy: { hash: 'c1', ok: true }, mainChat: 'Ari - main' }), w2.read)).verdict, 'readFail');
});

test('row 1: integrity on both sides and different → hold, also when fingerprints or the copy differ too', async () => {
    const { files } = linked();
    const changed = [...P80]; changed[10] = 'edited';
    for (const extra of [{}, { prints: changed }, { copy: { hash: 'c9', ok: true } }]) {
        const r = await decideRoom(room({ integrity: 'i-other', ...extra }), world(files).read);
        assert.deepEqual([r.verdict, r.row, r.why], ['hold', 1, 'integrity']);
    }
    // The memory file is not read before row 1: broken there does not change a row-1 hold.
    const { files: f2, id } = linked();
    const r = await decideRoom(room({ integrity: 'i-other' }), world(f2, { [memName(id)]: 'broken' }).read);
    assert.deepEqual([r.verdict, r.row], ['hold', 1]);
});

test('row 2: the old copy in the chat is not the recorded one (an older SavePoint wrote it again) → hold', async () => {
    const { files } = linked({ copy: 'c1' });
    let r = await decideRoom(room({ copy: { hash: 'c2', ok: true } }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 2, 'copyChanged']);
    // A room linked without a copy that has one now.
    const { files: f2 } = linked({ copy: null });
    r = await decideRoom(room({ copy: { hash: 'c2', ok: true } }), world(f2).read);
    assert.deepEqual([r.verdict, r.row], ['hold', 2]);
    // The copy gone (cleaned up) is not this row.
    r = await decideRoom(room({ copy: null }), world(files).read);
    assert.equal(r.verdict, 'link');
});

test('row 3: proof of the same room', async () => {
    // Integrity on both and equal.
    let { files, id } = linked();
    let r = await decideRoom(room(), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.proof, r.mem, r.changedAt, r.fill], ['link', 3, 'integrity', id, -1, null]);
    // The tag has integrity, the chat file has none → hold even when every fingerprint matches.
    r = await decideRoom(room({ integrity: null }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 3, 'integrityGone']);
    // No integrity on either: the copy hash is the recorded one.
    ({ files } = linked({ integrity: null, copy: 'c1', prints: [] }));
    r = await decideRoom(room({ integrity: null, copy: { hash: 'c1', ok: true } }), world(files).read);
    assert.deepEqual([r.verdict, r.proof], ['link', 'copy']);
    // Only the tag lacks integrity: every recorded fingerprint matches → link, and the integrity can be filled in.
    ({ files } = linked({ integrity: null }));
    r = await decideRoom(room({ integrity: 'i-new' }), world(files).read);
    assert.deepEqual([r.verdict, r.proof, r.fill], ['link', 'prints', { integrity: 'i-new' }]);
    // No fingerprints recorded is no proof.
    ({ files } = linked({ integrity: null, prints: [] }));
    r = await decideRoom(room({ integrity: null }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 3, 'unproven']);
    // One fingerprint differs: not proven (row 4 only comes after a proof).
    ({ files } = linked({ integrity: null }));
    const changed = [...P80]; changed[5] = 'edited';
    r = await decideRoom(room({ integrity: null, prints: changed }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 3, 'unproven']);
});

test('row 3: the tag\'s memory file missing, at another home, or unreadable', async () => {
    let { files, id } = linked();
    delete files[memName(id)];
    let r = await decideRoom(room(), world(files).read);
    assert.deepEqual([r.verdict, r.why, r.mem], ['hold', 'memGone', id]);
    ({ files, id } = linked());
    files[memName(id)] = memFile(id, { addr: B });
    r = await decideRoom(room(), world(files).read);
    assert.deepEqual([r.verdict, r.why], ['hold', 'homeDiff']);
    ({ files, id } = linked());
    r = await decideRoom(room(), world(files, { [memName(id)]: 'error' }).read);
    assert.deepEqual([r.verdict, r.row, r.names], ['readFail', 3, [memName(id)]]);
});

test('row 4: once it is the same room, some fingerprints differ → link and handle the change', async () => {
    const { files } = linked();
    const changed = [...P80]; changed[14] = 'edited';
    let r = await decideRoom(room({ prints: changed }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.changedAt], ['link', 4, 14]);
    // The memory's own recorded fingerprints are checked too (a message the tag did not pick).
    changed[3] = 'edited';
    r = await decideRoom(room({ prints: changed }), world(files).read);
    assert.equal(r.changedAt, 3);
    // Messages gone.
    r = await decideRoom(room({ prints: P80.slice(0, 8) }), world(files).read);
    assert.deepEqual([r.row, r.changedAt], [4, 8]);
});

test('a tag that says this name was renamed away → hold, unless a rename back to it was seen here', async () => {
    const { files, id } = linked();
    files[tagName(A)] = renamedTag(files[tagName(A)], B);
    files[tagName(B)] = tagBody({ addr: B, integrity: 'i-A', mem: id });
    let r = await decideRoom(room(), world(files).read);
    assert.deepEqual([r.verdict, r.why, r.to], ['hold', 'renamedAway', B]);
    r = await decideRoom(room({ renames: [{ from: A, to: B }, { from: B, to: A }] }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.from, r.mem], ['rename', 5, B, id]);
});

// ───────── rows without a tag ─────────

test('row 5: a rename seen on this device with the same integrity moves the tag', async () => {
    const id = homeId(A, 'i-A');
    const files = { [tagName(A)]: tagBody({ addr: A, integrity: 'i-A', mem: id }), [memName(id)]: memFile(id) };
    const at = { ...room(), addr: B, renames: [{ from: A, to: B }] };
    let r = await decideRoom(at, world(files).read);
    assert.deepEqual([r.verdict, r.row, r.from, r.mem], ['rename', 5, A, id]);
    // A retry after the old tag was already marked: still this rename.
    const f2 = { ...files, [tagName(A)]: renamedTag(files[tagName(A)], B) };
    r = await decideRoom(at, world(f2).read);
    assert.deepEqual([r.verdict, r.row], ['rename', 5]);
    // Integrity differs: not this rename (the hint then holds it, row 8).
    const f3 = { ...files, [clueName('i-A')]: clueBody('i-A', [{ addr: A, mem: id }]) };
    r = await decideRoom({ ...at, integrity: 'i-B' }, world(f3).read);
    assert.notEqual(r.verdict, 'rename');
    // No rename seen here: the original name gone from the list is not enough (the hint holds it).
    r = await decideRoom({ ...at, renames: [] }, world(f3).read);
    assert.deepEqual([r.verdict, r.row, r.candidates], ['hold', 8, [A]]);
    // The renamed room's memory file is gone.
    r = await decideRoom(at, world({ [tagName(A)]: files[tagName(A)] }).read);
    assert.deepEqual([r.verdict, r.why], ['hold', 'memGone']);
});

test('row 5 without integrity: an old copy already moved from the old name holds (row 9), not a second move', async () => {
    const id = migrateId(A, 'c1');
    const files = {
        [tagName(A)]: tagBody({ addr: A, integrity: null, mem: id, copy: 'c1' }),
        [memName(id)]: memFile(id, { integrity: null, from: { kind: 'migrate', addr: A, copy: 'c1' } }),
        [movedName(A, 'c1')]: movedBody({ addr: A, copy: 'c1', mem: id }),
    };
    const r = await decideRoom({ ...room(), addr: B, integrity: null, copy: { hash: 'c1', ok: true }, renames: [{ from: A, to: B }] }, world(files).read);
    assert.deepEqual([r.verdict, r.row, r.from], ['hold', 9, A]);
});

test('row 6: a room whose tag is gone links again to its own memory file, before the branch check', async () => {
    // A branch that went on by itself: its memory is hash(address + integrity).
    const parent = linked({ integrity: 'i-P' });
    const files = { ...parent.files };
    files[tagName(P)] = files[tagName(A)]; files[tagName(P)] = tagBody({ addr: P, integrity: 'i-P', mem: parent.id });
    delete files[tagName(A)];
    const own = homeId(A, 'i-A');
    files[memName(own)] = memFile(own, { from: { kind: 'branch', addr: A, integrity: 'i-A', parent: P }, rev: 7 });
    let r = await decideRoom(room({ mainChat: 'Ari - main' }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.mem], ['relink', 6, own]);
    // Moved from the chat: hash(address + copy).
    const mid = migrateId(A, 'c1');
    r = await decideRoom(room({ integrity: null, copy: { hash: 'c1', ok: true } }),
        world({ [memName(mid)]: memFile(mid, { integrity: null, from: { kind: 'migrate', addr: A, copy: 'c1' } }) }).read);
    assert.deepEqual([r.verdict, r.mem], ['relink', mid]);
    // Through the integrity hint (a memory first made under another id).
    const other = homeId(B, 'i-A');
    r = await decideRoom(room(), world({ [clueName('i-A')]: clueBody('i-A', [{ addr: A, mem: other }]), [memName(other)]: memFile(other) }).read);
    assert.deepEqual([r.verdict, r.mem], ['relink', other]);
    // Its home is another room → hold.
    r = await decideRoom(room(), world({ [memName(own)]: memFile(own, { addr: B }) }).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 6, 'homeDiff']);
    // Unreadable → stop.
    r = await decideRoom(room(), world({ [memName(own)]: memFile(own) }, { [memName(own)]: 'broken' }).read);
    assert.deepEqual([r.verdict, r.row], ['readFail', 6]);
    // A moved mark without its memory file → hold (offer a slot), never a second move.
    r = await decideRoom(room({ copy: { hash: 'c1', ok: true } }), world({ [movedName(A, 'c1')]: movedBody({ addr: A, copy: 'c1', mem: mid }) }).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 6, 'movedNoBody']);
});

function parentWorld({ scope = 'ari.png', integrity = 'i-P', upto = 79, floorTo = -1, slots = [] } = {}) {
    const pAddr = roomAddr(scope, 'Ari - main');
    const pid = homeId(pAddr, integrity);
    const files = {
        [tagName(pAddr)]: tagBody({ addr: pAddr, integrity, mem: pid, prints: pickPrints(P80.slice(0, upto + 1)) }),
        [memName(pid)]: memFile(pid, { addr: pAddr, integrity, state: recorded(P80, upto, { floorTo }) }),
    };
    return { pAddr, pid, files, slotsOf: async a => (a === pAddr ? slots : []) };
}
const branchRoom = (extra = {}) => room({ integrity: 'i-B1', mainChat: 'Ari - main', ...extra });

test('row 7: a branch of a linked room inherits a copy of the parent\'s memory, rewound to where they part', async () => {
    const pw = parentWorld();
    const w = world(pw.files);
    const r = await decideRoom(branchRoom({ prints: P80.slice(0, 21) }), w.read, { slotsOf: pw.slotsOf });
    assert.deepEqual([r.verdict, r.row, r.parent, r.parentMem, r.mem, r.via, r.at], ['branch', 7, pw.pAddr, pw.pid, homeId(A, 'i-B1'), 'rewind', 21]);
    assert.equal(r.state.lastIndex, 19);
    assert.equal(r.state.roomKey, A);
    // The parent's file was only read.
    assert.deepEqual(w.store.get(memName(pw.pid)), pw.files[memName(pw.pid)]);
    // A group branch: the parent is looked up in the same group.
    const gw = parentWorld({ scope: 'group:7' });
    const g = await decideRoom({ ...branchRoom({ prints: P80.slice(0, 21) }), addr: G }, world(gw.files).read, { slotsOf: gw.slotsOf });
    assert.deepEqual([g.verdict, g.parent], ['branch', gw.pAddr]);
    // The parent's memory unreadable → stop; gone → hold.
    let x = await decideRoom(branchRoom(), world(pw.files, { [memName(pw.pid)]: 'error' }).read);
    assert.deepEqual([x.verdict, x.row], ['readFail', 7]);
    const f2 = { ...pw.files }; delete f2[memName(pw.pid)];
    x = await decideRoom(branchRoom(), world(f2).read);
    assert.deepEqual([x.verdict, x.why], ['hold', 'parentGone']);
    // The parent was renamed after the branch was made: its tag is followed.
    const f3 = { ...pw.files, [tagName(B)]: tagBody({ addr: B, integrity: 'i-P', mem: pw.pid }) };
    f3[tagName(pw.pAddr)] = renamedTag(pw.files[tagName(pw.pAddr)], B);
    x = await decideRoom(branchRoom({ prints: P80.slice(0, 21) }), world(f3).read);
    assert.deepEqual([x.verdict, x.parent], ['branch', B]);
});

test('row 7: not enough to inherit → hold; the same integrity as the parent (an older branch) → row 8', async () => {
    const pw = parentWorld({ floorTo: 49 });
    let r = await decideRoom(branchRoom({ prints: P80.slice(0, 21) }), world(pw.files).read, { slotsOf: pw.slotsOf });
    assert.deepEqual([r.verdict, r.row, r.why, r.reason], ['hold', 7, 'branchUnproven', 'floor']);
    // A branch made by an older SillyTavern keeps the parent's integrity; the hint lists the parent.
    const pw2 = parentWorld({ integrity: 'i-A' });
    const files = { ...pw2.files, [clueName('i-A')]: clueBody('i-A', [{ addr: pw2.pAddr, mem: pw2.pid }]) };
    r = await decideRoom(room({ mainChat: 'Ari - main' }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.candidates], ['hold', 8, [pw2.pAddr]]);
});

test('rows 8–12 without a tag', async () => {
    // 8: the same integrity linked to another room (an imported copy) → hold with the candidate.
    const id = homeId(B, 'i-A');
    let files = { [tagName(B)]: tagBody({ addr: B, integrity: 'i-A', mem: id }), [clueName('i-A')]: clueBody('i-A', [{ addr: B, mem: id }]), [memName(id)]: memFile(id, { addr: B }) };
    let r = await decideRoom(room({ copy: { hash: 'c1', ok: true } }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.candidates], ['hold', 8, [B]]);
    // A hint whose room has no tag any more is not a link.
    r = await decideRoom(room(), world({ [clueName('i-A')]: clueBody('i-A', [{ addr: B, mem: id }]) }).read);
    assert.deepEqual([r.verdict, r.row], ['new', 12]);
    // 9: the old copy was already moved out of the parent (main_chat) → hold.
    files = { [movedName(P, 'c1')]: movedBody({ addr: P, copy: 'c1', mem: migrateId(P, 'c1') }) };
    r = await decideRoom(room({ copy: { hash: 'c1', ok: true }, mainChat: 'Ari - main' }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.from], ['hold', 9, P]);
    // 10: an old copy → move it out.
    r = await decideRoom(room({ copy: { hash: 'c1', ok: true }, mainChat: 'Ari - main' }), world({}).read);
    assert.deepEqual([r.verdict, r.row, r.mem], ['migrate', 10, migrateId(A, 'c1')]);
    // 11: a copy that is not a usable memory, or only SavePoint's marks on messages → hold.
    r = await decideRoom(room({ copy: { hash: 'c1', ok: false } }), world({}).read);
    assert.deepEqual([r.verdict, r.row], ['hold', 11]);
    r = await decideRoom(room({ traces: true }), world({}).read);
    assert.deepEqual([r.verdict, r.row], ['hold', 11]);
    // 12: a new room; without integrity in the chat file no memory is made yet.
    r = await decideRoom(room(), world({}).read);
    assert.deepEqual([r.verdict, r.row, r.mem], ['new', 12, homeId(A, 'i-A')]);
    r = await decideRoom(room({ integrity: null }), world({}).read);
    assert.deepEqual([r.verdict, r.row, r.mem, r.wait], ['new', 12, null, true]);
});

test('deciding only reads (no write path), and a read that throws is an error', async () => {
    const r = await decideRoom(room(), async () => { throw new Error('offline'); });
    assert.equal(r.verdict, 'readFail');
    // decideRoom gets nothing it could write with; the reads it made are user-file names only.
    const w = world({});
    await decideRoom(room({ copy: { hash: 'c1', ok: true }, mainChat: 'Ari - main', renames: [{ from: B, to: A }] }), w.read);
    for (const n of w.reads) assert.match(n, /^savepoint-(mem|room|int|moved)-/);
});

// ───────── branch restore ─────────

test('branch: parent at #80, branch at #20 → rewound to #19; the branch point\'s last swipe differs → the same', () => {
    const parent = recorded(P80, 79);
    let r = branchRestore(parent, P80.slice(0, 21));
    assert.deepEqual([r.ok, r.via, r.at, r.state.lastIndex], [true, 'rewind', 21, 19]);
    assert.equal(r.state.mem.scenes.length, 4);
    assert.deepEqual(r.state.hashes, P80.slice(0, 20));
    assert.equal(parent.lastIndex, 79, 'the parent is untouched');
    const swiped = P80.slice(0, 21); swiped[20] = fingerprint({ name: 'Ari', is_user: false, mes: 'another swipe', swipe_id: 1 });
    r = branchRestore(parent, swiped);
    assert.deepEqual([r.ok, r.at, r.state.lastIndex], [true, 20, 19]);
    // A branch past everything recorded keeps it all.
    r = branchRestore(recorded(P80, 39), P80.slice(0, 60));
    assert.deepEqual([r.ok, r.via, r.state.lastIndex], [true, 'parent', 39]);
});

test('branch: the parent changed an earlier message; the first message differs', () => {
    const edited = [...P80]; edited[7] = 'edited later';
    let r = branchRestore(recorded(edited, 79), P80.slice(0, 30));
    assert.deepEqual([r.ok, r.at, r.state.lastIndex], [true, 7, 4]);
    const first = [...P80]; first[0] = 'another greeting';
    r = branchRestore(recorded(P80, 79), first.slice(0, 30));
    assert.deepEqual([r.ok, r.via, r.state.lastIndex, r.state.mem.scenes.length], [true, 'rewind', -1, 0]);
});

test('branch: history too short → a slot whose recorded messages all match (the furthest), or no', () => {
    const parent = recorded(P80, 79, { floorTo: 49 });
    let r = branchRestore(parent, P80.slice(0, 21));
    assert.deepEqual([r.ok, r.why, r.at], [false, 'floor', 21]);
    const slot = (last, prints = P80, updated = 1) => ({ id: `s${last}`, mem: { ...emptyMem(), scenes: [{ id: `x${last}` }] }, pos: { lastIndex: last, digest: digest(prints.slice(0, last + 1)) }, updated });
    const wrong = [...P80]; wrong[3] = 'x';
    r = branchRestore(parent, P80.slice(0, 21), [slot(9), slot(14), slot(18, wrong), slot(40), slot(14, P80, 5)]);
    assert.deepEqual([r.ok, r.via, r.slot, r.state.lastIndex, r.state.floor, r.state.history.length], [true, 'slot', 's14', 14, 14, 0]);
    assert.deepEqual(r.state.hashes, P80.slice(0, 15));
    // A slot with nothing recorded does not count.
    r = branchRestore(parent, P80.slice(0, 21), [{ mem: emptyMem(), pos: { lastIndex: -1, digest: digest([]) } }]);
    assert.equal(r.ok, false);
    assert.equal(branchRestore({ v: 1 }, P80).ok, false);
});

test('branch of a branch; what a branch does not carry over', () => {
    const b1 = branchRestore(recorded(P80, 79), P80.slice(0, 41));
    assert.equal(b1.state.lastIndex, 39);
    const p2 = [...P80.slice(0, 31), ...printsOf(msgs(10, i => `Other ${i}`))];
    const b2 = branchRestore(b1.state, p2);
    assert.deepEqual([b2.ok, b2.at, b2.state.lastIndex], [true, 31, 29]);
    const st = branchState({ ...b1.state, undo: {}, undoInfo: {}, check: { at: 1 }, review: { at: 3 }, linkedSave: 'slot1', autoFail: { to: 9 }, lastRecord: { run: 'r' },
        autoMark: 79, autoHold: 1, autoAttemptAt: 2, autoLast: {}, wid: 'w', hideManual: { to: 70, at: 5 } }, A);
    for (const k of ['undo', 'undoInfo', 'check', 'review', 'autoFail', 'lastRecord', 'autoHold', 'autoAttemptAt', 'autoLast', 'wid']) assert.equal(k in st, false, k);
    assert.deepEqual([st.linkedSave, st.roomKey, st.autoMark, st.hideManual.to], [null, A, 39, 39]);
});

// ───────── writing: first try and retries ─────────

test('moving the old copy out: first try, a stop after each step, and what is never done again', () => {
    const id = migrateId(A, 'c1'), from = { kind: 'migrate', addr: A, copy: 'c1' };
    const body = memFile(id, { from });
    const base = { id, from, addr: A, integrity: 'i-A', copy: 'c1' };
    const none = { mem: { kind: MISSING }, moved: { kind: MISSING }, clue: { kind: MISSING }, tag: { kind: MISSING } };
    const ok = data => ({ kind: OK, data });
    assert.deepEqual(writePlan({ ...base, ...none }), { steps: ['writeMem', 'checkMem', 'writeMoved', 'writeClue', 'writeTag'] });
    // Stopped after the body: the body is never written again (even with a newer rev).
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok({ ...body, rev: 9 }) }), { steps: ['writeMoved', 'writeClue', 'writeTag'] });
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok(body), moved: ok(movedBody({ addr: A, copy: 'c1', mem: id })) }), { steps: ['writeClue', 'writeTag'] });
    const clue = ok(clueBody('i-A', [{ addr: A, mem: id }]));
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok(body), moved: ok(movedBody({ addr: A, copy: 'c1', mem: id })), clue }), { steps: ['writeTag'] });
    assert.deepEqual(writePlan({ ...base, mem: ok(body), moved: ok(movedBody({ addr: A, copy: 'c1', mem: id })), clue, tag: ok(tagBody({ addr: A, integrity: 'i-A', mem: id, copy: 'c1' })) }), { steps: [] });
    // A memory file from somewhere else, or one that cannot be read or checked → stop.
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok(memFile(id, { from: { kind: 'migrate', addr: A, copy: 'c2' } })) }), { stop: 'otherOrigin' });
    for (const k of ['mem', 'moved', 'clue', 'tag']) for (const kind of [BROKEN, ERROR]) assert.equal(writePlan({ ...base, ...none, [k]: { kind } }).stop, 'read');
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok({ ...body, id: 'zz' }) }), { stop: 'read', file: 'mem' });
    // The moved mark without the body: hold, never remade from the old copy.
    assert.deepEqual(writePlan({ ...base, ...none, moved: ok(movedBody({ addr: A, copy: 'c1', mem: id })) }), { hold: 'movedNoBody' });
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok(body), moved: ok(movedBody({ addr: A, copy: 'c1', mem: 'other' })) }), { stop: 'movedDiff' });
    // A tag to another memory is never overwritten.
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok(body), tag: ok(tagBody({ addr: A, mem: 'other' })) }), { stop: 'tagDiff' });
    // No integrity: no hint.
    assert.deepEqual(writePlan({ ...base, integrity: null, ...none }), { steps: ['writeMem', 'checkMem', 'writeMoved', 'writeTag'] });
    // An existing hint for other rooms gets this room added.
    assert.deepEqual(clueWith(clueBody('i-A', [{ addr: B, mem: 'm2' }]), 'i-A', A, id).rooms, [{ addr: B, mem: 'm2' }, { addr: A, mem: id }]);
    assert.deepEqual(clueWith(null, 'i-A', A, id).rooms, [{ addr: A, mem: id }]);
});

test('a branch or a new room: the same plan without the moved mark', () => {
    const id = homeId(A, 'i-B1'), from = { kind: 'branch', addr: A, integrity: 'i-B1', parent: P };
    const none = { mem: { kind: MISSING }, clue: { kind: MISSING }, tag: { kind: MISSING } };
    assert.deepEqual(writePlan({ id, from, addr: A, integrity: 'i-B1', ...none }), { steps: ['writeMem', 'checkMem', 'writeClue', 'writeTag'] });
    const mine = memFile(id, { integrity: 'i-B1', from });
    assert.deepEqual(writePlan({ id, from, addr: A, integrity: 'i-B1', ...none, mem: { kind: OK, data: mine } }), { steps: ['writeClue', 'writeTag'] });
    assert.deepEqual(writePlan({ id, from: { kind: 'new', addr: A, integrity: 'i-B1' }, addr: A, integrity: 'i-B1', ...none, mem: { kind: OK, data: mine } }), { stop: 'otherOrigin' });
});

// ───────── two devices ─────────

test('two devices: write only over what was seen (rev and receipt), ours only with our receipt', () => {
    const f = memFile('m1', { rev: 3 });
    f.wid = 'w3';
    assert.equal(canWrite(f, { rev: 3, wid: 'w3' }), true);
    assert.equal(canWrite(f, { rev: 3, wid: 'other' }), false, 'same rev written by another device');
    assert.equal(canWrite(f, { rev: 2, wid: 'w3' }), false);
    assert.equal(canWrite(null, { rev: 3, wid: 'w3' }), false);
    let n = f;
    for (let i = 0; i < 12; i++) n = nextMem(n, n.state, `x${i}`);
    assert.deepEqual([n.rev, n.wid, n.recent.length, n.recent.at(-1)], [15, 'x11', 8, { rev: 15, wid: 'x11' }]);
    assert.deepEqual([n.id, n.from, n.home], [f.id, f.from, f.home]);
    assert.equal(wroteMine(n, 'x11'), true);
    assert.equal(wroteMine({ ...n, wid: 'y' }, 'x11'), false);
    // AUTO saves the file does not know about: a hint only.
    const known = n.recent.at(-2);
    assert.deepEqual(maybeOverwritten([known, { rev: n.recent.at(-2).rev, wid: 'other' }, { rev: 99, wid: 'z' }, { rev: 1, wid: 'old' }, { rev: 5 }], n).map(a => a.wid), ['other', 'z']);
    assert.deepEqual(maybeOverwritten([{ rev: 1, wid: 'a' }], null), []);
});
