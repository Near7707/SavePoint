// v0.6.64 (step 0): the rules for keeping a room's memory in user files (home.js). Nothing uses them yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { cleanName,
    roomAddr, scopeOf, migrateId, homeId, memName, tagName, clueName, movedName, copyHash, fingerprint, digest, renameNotice, hasTraces,
    classifyRead, readUserFile, checked, validMem, validTag, memBody, tagBody, renamedTag, clueBody, clueWith, movedBody,
    pickPrints, firstDiff, printCheck, decideRoom, branchRestore, branchState, writePlan, canWrite, nextMem, wroteMine, maybeOverwritten,
    MISSING, BROKEN, ERROR, OK, startName, copyName, startBody, copyHintBody, validState, homeOk, checkStart, checkMem, placeMemory,
    relinkMemory, sameLink,
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
const memFile = (id, { addr = A, integrity = 'i-A', state = recorded(P80, 19), from = { kind: 'new', addr, integrity }, rev = 0, copy = from.kind === 'migrate' ? from.copy : null } = {}) =>
    memBody({ id, state, rev, wid: 'w0', from, home: { addr, integrity }, copy });

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
    const names = [memName(homeId(A, 'x')), memName(migrateId(A, 'c')), tagName(A), tagName(B), clueName('x'), movedName(A, 'c'), movedName(B, 'c'), startName(A), startName(B), copyName('c'), copyName('d')];
    for (const n of names) assert.match(n, /^savepoint-(mem|room|int|moved|moving|copy)-[a-z0-9]{28}\.json$/);
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
    // Only the tag lacks integrity: v0.6.69 every recorded fingerprint matching is no proof of the room
    // (a new room under the same name with the same greeting) → hold, with the check for the reason.
    ({ files } = linked({ integrity: null }));
    r = await decideRoom(room({ integrity: 'i-new' }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why, r.prints], ['hold', 3, 'unproven', { total: 5, matched: 5, first: -1 }]);
    // ...but the same old copy is: link, and the integrity can be filled in.
    ({ files } = linked({ integrity: null, copy: 'c1' }));
    r = await decideRoom(room({ integrity: 'i-new', copy: { hash: 'c1', ok: true } }), world(files).read);
    assert.deepEqual([r.verdict, r.proof, r.fill], ['link', 'copy', { integrity: 'i-new' }]);
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
    // The first message differs and no slot fits → hold (starting empty is the user's choice).
    const first = [...P80]; first[0] = 'another greeting';
    r = await decideRoom(branchRoom({ prints: first.slice(0, 21) }), world(parentWorld().files).read);
    assert.deepEqual([r.verdict, r.row, r.reason], ['hold', 7, 'nothingLeft']);
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
    for (const n of w.reads) assert.match(n, /^savepoint-(mem|room|int|moved|moving|copy)-/);
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
});

test('branch: the first message differs → a matching slot, else no (never an empty memory on its own)', () => {
    // The parent's #0 is now "new"; the branch still has the "old" one; an earlier AUTO recorded the old one.
    const parentNow = [...P80]; parentNow[0] = 'new greeting';
    const branch = P80.slice(0, 30);
    let r = branchRestore(recorded(parentNow, 79), branch);
    assert.deepEqual([r.ok, r.why, r.at], [false, 'nothingLeft', 0]);
    const auto = { id: 'auto1', mem: { ...emptyMem(), scenes: [{ id: 'old' }] }, pos: { lastIndex: 9, digest: digest(branch.slice(0, 10)) }, updated: 3 };
    r = branchRestore(recorded(parentNow, 79), branch, [auto]);
    assert.deepEqual([r.ok, r.via, r.slot, r.state.lastIndex], [true, 'slot', 'auto1', 9]);
    // A parent that has recorded nothing yet is carried over as it is.
    const loaded = { v: 1, mem: { ...emptyMem(), scenes: [{ id: 'kept' }] }, lastIndex: -1, hashes: [], history: [], floor: -1 };
    r = branchRestore(loaded, branch);
    assert.deepEqual([r.ok, r.via, r.state.mem.scenes[0].id], [true, 'parent', 'kept']);
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
    const none = { mem: { kind: MISSING }, start: { kind: MISSING }, moved: { kind: MISSING }, hint: { kind: MISSING }, clue: { kind: MISSING }, tag: { kind: MISSING } };
    const ok = data => ({ kind: OK, data });
    const started = ok(startBody({ addr: A, copy: 'c1', mem: id, wid: 'w0' }));
    const moved = ok(movedBody({ addr: A, copy: 'c1', mem: id })), hint = ok(copyHintBody('c1', [A])), clue = ok(clueBody('i-A', [{ addr: A, mem: id }]));
    assert.deepEqual(writePlan({ ...base, ...none }), { steps: ['writeStart', 'checkStart', 'writeMem', 'checkMem', 'writeMoved', 'writeCopy', 'writeClue', 'recheckStart', 'writeTag'] });
    // Stopped after the start mark; after the body (never written again, even with a newer rev); later.
    assert.deepEqual(writePlan({ ...base, ...none, start: started }), { steps: ['writeMem', 'checkMem', 'writeMoved', 'writeCopy', 'writeClue', 'recheckStart', 'writeTag'] });
    assert.deepEqual(writePlan({ ...base, ...none, start: started, mem: ok({ ...body, rev: 9 }) }), { steps: ['writeMoved', 'writeCopy', 'writeClue', 'recheckStart', 'writeTag'] });
    assert.deepEqual(writePlan({ ...base, ...none, start: started, mem: ok(body), moved }), { steps: ['writeCopy', 'writeClue', 'recheckStart', 'writeTag'] });
    assert.deepEqual(writePlan({ ...base, ...none, start: started, mem: ok(body), moved, hint }), { steps: ['writeClue', 'recheckStart', 'writeTag'] });
    assert.deepEqual(writePlan({ ...base, start: started, mem: ok(body), moved, hint, clue, tag: ok(tagBody({ addr: A, integrity: 'i-A', mem: id, copy: 'c1' })) }), { steps: [] });
    // A memory file from somewhere else, or one that cannot be read or checked → stop.
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok(memFile(id, { from: { kind: 'migrate', addr: A, copy: 'c2' } })) }), { stop: 'otherOrigin' });
    for (const k of ['mem', 'start', 'moved', 'hint', 'clue', 'tag']) for (const kind of [BROKEN, ERROR]) assert.equal(writePlan({ ...base, ...none, [k]: { kind } }).stop, 'read', k);
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok({ ...body, id: 'zz' }) }), { stop: 'read', file: 'mem' });
    // The moved mark without the body: hold, never remade from the old copy.
    assert.deepEqual(writePlan({ ...base, ...none, start: started, moved }), { hold: 'movedNoBody' });
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok(body), moved: ok(movedBody({ addr: A, copy: 'c1', mem: 'other' })) }), { stop: 'movedDiff' });
    // The old copy changed since the move started (an older SavePoint wrote it again) → hold.
    assert.deepEqual(writePlan({ ...base, ...none, copy: 'c2', from: { ...from, copy: 'c2' }, id: migrateId(A, 'c2'), start: started }), { hold: 'copyChanged' });
    // A tag to another memory is never overwritten. v0.6.82 (was: stop 'tagDiff'): held, the same rule as
    // right before the tag is written (sameLink).
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok(body), tag: ok(tagBody({ addr: A, mem: 'other' })) }), { hold: 'tagChanged' });
    // The body is for this address but another integrity → stop.
    assert.deepEqual(writePlan({ ...base, ...none, mem: ok(memFile(id, { from, integrity: 'i-B' })) }), { stop: 'homeDiff' });
    // No integrity: no hint by integrity.
    assert.deepEqual(writePlan({ ...base, integrity: null, ...none }), { steps: ['writeStart', 'checkStart', 'writeMem', 'checkMem', 'writeMoved', 'writeCopy', 'recheckStart', 'writeTag'] });
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

// ───────── v0.6.65: review of v0.6.64 (P2 × 4) ─────────

test('[P2] tag gone, then an older SavePoint changed the old copy: hold, never link again or move it twice', async () => {
    const mid = migrateId(A, 'c1');
    const body = memFile(mid, { from: { kind: 'migrate', addr: A, copy: 'c1' }, rev: 12 });
    const started = startBody({ addr: A, copy: 'c1', mem: mid, wid: 'w0' });
    const now = { copy: { hash: 'c2', ok: true } };
    // Found through the integrity hint: its recorded copy is not the chat's → hold.
    let r = await decideRoom(room(now), world({ [memName(mid)]: body, [clueName('i-A')]: clueBody('i-A', [{ addr: A, mem: mid }]), [startName(A)]: started }).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 6, 'copyChanged']);
    // No hint, no integrity: the move-start mark (found by the address alone) still finds it → hold.
    r = await decideRoom(room({ ...now, integrity: null }), world({ [memName(mid)]: body, [startName(A)]: started }).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 6, 'copyChanged']);
    // The copy changed in the middle of the move (mark written, no body yet) → hold, not a second move.
    r = await decideRoom(room({ ...now, integrity: null }), world({ [startName(A)]: started }).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 6, 'copyChanged']);
    // The same copy after a stop with no body yet → the move is tried again.
    r = await decideRoom(room({ copy: { hash: 'c1', ok: true }, integrity: null }), world({ [startName(A)]: started }).read);
    assert.deepEqual([r.verdict, r.row, r.mem], ['migrate', 10, mid]);
    // A mark, no body and no old copy left in the chat → hold.
    r = await decideRoom(room({ integrity: null }), world({ [startName(A)]: started }).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 6, 'moveStarted']);
    // A new room's memory (no copy recorded) and now an old copy in the chat → hold.
    const own = homeId(A, 'i-A');
    r = await decideRoom(room(now), world({ [memName(own)]: memFile(own) }).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 6, 'copyChanged']);
    // The same copy as recorded → link again.
    r = await decideRoom(room({ copy: { hash: 'c1', ok: true } }), world({ [memName(mid)]: body, [startName(A)]: started }).read);
    assert.deepEqual([r.verdict, r.mem], ['relink', mid]);
});

test('[P2] an imported copy of a linked branch is held with that branch as the candidate (row 8 before 7)', async () => {
    const pw = parentWorld();
    const bid = homeId(B, 'i-B1');
    const files = { ...pw.files,
        [tagName(B)]: tagBody({ addr: B, integrity: 'i-B1', mem: bid }),
        [memName(bid)]: memFile(bid, { addr: B, integrity: 'i-B1', from: { kind: 'branch', addr: B, integrity: 'i-B1', parent: pw.pAddr } }),
        [clueName('i-B1')]: clueBody('i-B1', [{ addr: B, mem: bid }]) };
    const imported = roomAddr('ari.png', 'Ari - renamed imported');
    const w = world(files);
    const r = await decideRoom({ ...branchRoom({ prints: P80.slice(0, 21) }), addr: imported }, w.read, { slotsOf: pw.slotsOf });
    assert.deepEqual([r.verdict, r.row, r.candidates], ['hold', 8, [B]]);
    assert.equal(w.reads.includes(memName(pw.pid)), false, "the parent's memory is not even read");
    // The branch itself (its own tag gone) still links to its own memory first (row 6).
    const f2 = { ...files }; delete f2[tagName(B)];
    const own = await decideRoom({ ...branchRoom(), addr: B }, world(f2).read);
    assert.deepEqual([own.verdict, own.row, own.mem], ['relink', 6, bid]);
});

test('[P2] a memory file must hold a real memory; tag, chat file and memory must agree on the integrity', async () => {
    const st = recorded(P80, 19);
    assert.equal(validState(st), true);
    assert.equal(validState({ v: 1, mem: {}, lastIndex: 80, hashes: [] }), false);
    assert.equal(validState({ ...st, hashes: st.hashes.slice(1) }), false);
    assert.equal(validState({ ...st, lastIndex: -2, hashes: [] }), false);
    assert.equal(validState({ ...st, hashes: [...st.hashes.slice(1), 7] }), false);
    assert.equal(validState({ ...st, mem: { ...st.mem, records: null } }), false);
    assert.equal(validState({ ...st, history: {} }), false);
    assert.equal(branchRestore({ v: 1, mem: {}, lastIndex: 80, hashes: [] }, P80).ok, false);
    const id = homeId(A, 'i-A');
    assert.equal(checked({ kind: OK, data: memBody({ id, state: { v: 1, mem: {}, lastIndex: 80, hashes: [] }, wid: 'w', from: { kind: 'new', addr: A }, home: { addr: A, integrity: null } }) }, validMem(id)).kind, BROKEN);
    // The tag says i-A, the memory's home says i-B (same address) → hold, not link.
    const { files } = linked();
    files[memName(id)] = memFile(id, { integrity: 'i-B' });
    const r = await decideRoom(room(), world(files).read);
    assert.deepEqual([r.verdict, r.why], ['hold', 'homeDiff']);
    assert.equal(homeOk({ addr: A, integrity: 'i-A' }, A, 'i-A', null), true);
    assert.equal(homeOk({ addr: A, integrity: null }, A, null), true);
    assert.equal(homeOk({ addr: A, integrity: 'i-A' }, A, 'i-A', 'i-B'), false);
    assert.equal(homeOk({ addr: A, integrity: 'i-A' }, A, null), false);
    assert.equal(homeOk({ addr: B, integrity: null }, A, 'i-A'), false);
});

test('copy hint: an old copy moved out of another room (no integrity, renamed elsewhere) → hold; only a reason to hold', async () => {
    const files = { [copyName('c1')]: copyHintBody('c1', [B]) };
    let r = await decideRoom(room({ integrity: null, copy: { hash: 'c1', ok: true } }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.from], ['hold', 9, B]);
    // Listing only this room is no reason to hold (and never a reason to link).
    r = await decideRoom(room({ integrity: null, copy: { hash: 'c1', ok: true } }), world({ [copyName('c1')]: copyHintBody('c1', [A]) }).read);
    assert.deepEqual([r.verdict, r.row], ['migrate', 10]);
    r = await decideRoom(room({ integrity: null, copy: { hash: 'c1', ok: true } }), world({ [copyName('c1')]: copyHintBody('c1', [A]) }, { [copyName('c1')]: 'broken' }).read);
    assert.equal(r.verdict, 'readFail');
});

// ───────── v0.6.65: putting the memory in place, one device and two ─────────

// A user-files folder shared by devices; each device's reads and writes take turns as `order` says
// (then they alternate).
function folder(files = {}) {
    const store = new Map(Object.entries(files).map(([k, v]) => [k, JSON.stringify(v)]));
    const log = [];
    let sched = null;
    const io = (dev, { failWrite = null } = {}) => ({
        async read(n) { await sched?.turn(dev); try { return store.has(n) ? { kind: OK, data: JSON.parse(store.get(n)) } : { kind: MISSING }; } finally { sched?.done(); } },
        async write(n, body) {
            await sched?.turn(dev);
            try { if (failWrite && n.startsWith(failWrite)) throw new Error('disk'); store.set(n, JSON.stringify(body)); log.push([dev, n]); } finally { sched?.done(); }
        },
    });
    const run = async (jobs, order = []) => {
        const devs = Object.keys(jobs), active = new Set(devs), wait = new Map();
        let k = 0, busy = false, alt = 0;
        const cur = () => k < order.length ? order[k] : devs[alt % devs.length];
        const pump = () => {
            if (busy) return;
            for (let t = 0; t < 2 * devs.length && !active.has(cur()); t++) k < order.length ? k++ : alt++;
            const w = wait.get(cur());
            if (w) { wait.delete(cur()); busy = true; w(); }
        };
        sched = { turn: d => new Promise(r => { wait.set(d, r); pump(); }), done: () => { busy = false; k < order.length ? k++ : alt++; pump(); } };
        const out = await Promise.all(devs.map(d => jobs[d]().finally(() => { active.delete(d); pump(); })));
        sched = null;
        return Object.fromEntries(devs.map((d, i) => [d, out[i]]));
    };
    return { store, log, io, run, get: n => store.has(n) ? JSON.parse(store.get(n)) : undefined };
}
const moveArgs = (copy, wid, extra = {}) => ({ id: migrateId(A, copy), from: { kind: 'migrate', addr: A, copy }, addr: A, integrity: 'i-A', copy, state: recorded(P80, 19), wid, ...extra });

test('one device: a first move writes every file, the tag last; a stop after any write is finished by a retry', async () => {
    const f = folder();
    const r = await placeMemory(f.io('A'), moveArgs('c1', 'wa'));
    const id = migrateId(A, 'c1');
    assert.deepEqual([r.done, r.mem, r.adopted, r.seen], [true, id, false, { rev: 0, wid: 'wa' }]);
    assert.deepEqual(f.log.map(x => x[1]), [startName(A), memName(id), movedName(A, 'c1'), copyName('c1'), clueName('i-A'), tagName(A)]);
    assert.equal(f.get(memName(id)).copy, 'c1');
    assert.deepEqual(f.get(tagName(A)).prints.map(p => p.i), [0, 5, 10, 14, 19]);
    // Every write that can fail, failing once: nothing is half-linked, and a retry finishes without rewriting the body.
    for (const failAt of [startName(A), memName(id), movedName(A, 'c1'), copyName('c1'), clueName('i-A'), tagName(A)]) {
        const g = folder();
        const x = await placeMemory(g.io('A', { failWrite: failAt }), moveArgs('c1', 'wa'));
        assert.deepEqual([x.stop, g.get(tagName(A))], ['write', undefined], failAt);
        const y = await placeMemory(g.io('A'), moveArgs('c1', 'wa2'));
        assert.equal(y.done, true, failAt);
        assert.equal(g.log.filter(e => e[1] === memName(id)).length, 1, `body written once (${failAt})`);
    }
    // A body that is there already, moved later on (rev 9): never rewritten, the rest only.
    const h = folder({ [startName(A)]: startBody({ addr: A, copy: 'c1', mem: id, wid: 'w0' }), [memName(id)]: memFile(id, { from: { kind: 'migrate', addr: A, copy: 'c1' }, rev: 9 }) });
    const z = await placeMemory(h.io('A'), moveArgs('c1', 'wa'));
    assert.deepEqual([z.done, z.seen.rev, h.log.some(e => e[1] === memName(id))], [true, 9, false]);
    assert.equal(h.get(movedName(A, 'c1')).rev, 9);
});

test('two devices, the same old copy: one body file; the device that reads back the other receipt does not write it again', async () => {
    const f = folder();
    const id = migrateId(A, 'c1');
    const r = await f.run({ A: () => placeMemory(f.io('A'), moveArgs('c1', 'wa')), B: () => placeMemory(f.io('B'), moveArgs('c1', 'wb')) });
    assert.deepEqual([r.A.done, r.B.done, r.A.mem, r.B.mem], [true, true, id, id]);
    const bodies = f.log.filter(e => e[1] === memName(id));
    assert.deepEqual(bodies.map(e => e[0]), ['A', 'B'], 'both wrote the body once (same name)');
    assert.equal([...f.store.keys()].filter(n => n.startsWith('savepoint-mem-')).length, 1);
    // A read back B's receipt: it keeps B's body as it is and only finishes the links.
    assert.deepEqual([r.A.adopted, r.A.seen.wid, r.B.adopted, r.B.seen.wid], [true, 'wb', false, 'wb']);
    assert.equal(f.get(memName(id)).wid, 'wb');
    assert.equal(f.get(tagName(A)).mem, id);
    // The three conditions: the other body must read fine, be for this room and come from the same old copy.
    const mine = { id, from: { kind: 'migrate', addr: A, copy: 'c1' }, addr: A, integrity: 'i-A', copy: 'c1', wid: 'wa' };
    const theirs = memFile(id, { from: mine.from });
    assert.equal(checkMem({ kind: OK, data: theirs }, mine), 'theirs');
    assert.equal(checkMem({ kind: OK, data: { ...theirs, wid: 'wa' } }, mine), 'mine');
    assert.equal(checkMem({ kind: OK, data: { ...theirs, copy: 'c2' } }, mine), 'otherOrigin');
    assert.equal(checkMem({ kind: OK, data: { ...theirs, home: { addr: A, integrity: 'i-B' } } }, mine), 'otherOrigin');
    assert.equal(checkMem({ kind: OK, data: { ...theirs, from: { kind: 'new', addr: A, integrity: 'i-A' } } }, mine), 'otherOrigin');
    for (const res of [{ kind: MISSING }, { kind: BROKEN }, { kind: ERROR }, { kind: OK, data: { ...theirs, state: {} } }]) assert.equal(checkMem(res, mine), 'unsure');
    assert.equal(checkStart({ kind: OK, data: startBody({ addr: A, copy: 'c1', mem: id, wid: 'wb' }) }, { addr: A, copy: 'c1', id, wid: 'wa' }), 'same');
    assert.equal(checkStart({ kind: OK, data: startBody({ addr: A, copy: 'c2', mem: 'x', wid: 'wb' }) }, { addr: A, copy: 'c1', id, wid: 'wa' }), 'copyChanged');
    assert.equal(checkStart({ kind: MISSING }, { addr: A, copy: 'c1', id, wid: 'wa' }), 'unsure');
});

test('two devices, the old copy changed in between: a conflict that is found is held', async () => {
    const id1 = migrateId(A, 'c1'), id2 = migrateId(A, 'c2');
    // Both start together: B's mark lands after A's, A reads B's mark back → A holds; B goes on.
    let f = folder();
    let r = await f.run({ A: () => placeMemory(f.io('A'), moveArgs('c1', 'wa')), B: () => placeMemory(f.io('B'), moveArgs('c2', 'wb')) });
    assert.deepEqual([r.A.hold, r.A.step, r.B.done], ['copyChanged', 'checkStart', true]);
    assert.equal(f.store.has(memName(id1)), false);
    assert.equal(f.get(tagName(A)).mem, id2);
    // One after the other: B finds A's mark for another copy → hold, nothing written.
    f = folder();
    await placeMemory(f.io('A'), moveArgs('c1', 'wa'));
    const before = f.log.length;
    const b = await placeMemory(f.io('B'), moveArgs('c2', 'wb'));
    assert.deepEqual([b.hold, f.log.length], ['copyChanged', before]);
    // B read before A's mark, A checked its mark, then B wrote and checked its own: both passed the first
    // check. A's recheck right before the tag finds it → A holds and writes no tag (its body stays unused).
    f = folder();
    r = await f.run({ A: () => placeMemory(f.io('A'), moveArgs('c1', 'wa')), B: () => placeMemory(f.io('B'), moveArgs('c2', 'wb')) },
        ['B', 'B', 'B', 'B', 'B', 'B', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'B', 'B']);
    assert.deepEqual([r.A.hold, r.A.step, r.B.done], ['copyChanged', 'recheckStart', true]);
    assert.equal(f.get(tagName(A)).mem, id2);
    assert.equal(f.log.filter(e => e[0] === 'A' && e[1] === tagName(A)).length, 0);
});

// ───────── v0.6.67: review of v0.6.65 ─────────

// A folder whose writes can run something right after a given device writes a given file.
function hooked(files = {}) {
    const f = folder(files), after = [];
    const io = dev => {
        const inner = f.io(dev);
        return { read: inner.read, async write(n, b) { await inner.write(n, b); for (const h of after.splice(0)) if (h.dev === dev && h.name === n) await h.run(); else after.push(h); } };
    };
    return { ...f, io, after: (dev, name, run) => after.push({ dev, name, run }) };
}

test('v0.6.67: a move finished (and edited) by another device after the plan was made is never written over', async () => {
    const id = migrateId(A, 'c1');
    const f = hooked();
    f.after('A', startName(A), async () => {
        await placeMemory(f.io('B'), moveArgs('c1', 'wb'));
        const cur = f.get(memName(id));
        await f.io('B').write(memName(id), nextMem(cur, cur.state, 'wb2'));
    });
    const r = await placeMemory(f.io('A'), moveArgs('c1', 'wa'));
    assert.deepEqual([r.done, r.adopted, r.seen], [true, true, { rev: 1, wid: 'wb2' }]);
    assert.deepEqual([f.get(memName(id)).rev, f.get(memName(id)).wid], [1, 'wb2']);
    assert.equal(f.log.filter(e => e[0] === 'A' && e[1] === memName(id)).length, 0);
    assert.equal(f.get(tagName(A)).mem, id);
    // A body from somewhere else appears in between → hold, nothing written over it.
    const g = hooked();
    const other = memBody({ id, state: recorded(P80, 9), wid: 'wx', from: { kind: 'migrate', addr: A, copy: 'c9' }, home: { addr: A, integrity: 'i-A' }, copy: 'c9' });
    g.after('A', startName(A), async () => { await g.io('B').write(memName(id), other); });
    const s = await placeMemory(g.io('A'), moveArgs('c1', 'wa'));
    assert.deepEqual([s.hold, s.step], ['otherOrigin', 'writeMem']);
    assert.equal(g.get(memName(id)).wid, 'wx');
    assert.equal(g.store.has(tagName(A)), false);
    // It cannot be read right before writing → stop, nothing written.
    const h = hooked();
    const io = h.io('A');
    let n = 0;
    const flaky = { read: async name => (name === memName(id) && ++n === 2 ? { kind: ERROR } : io.read(name)), write: io.write };
    const t = await placeMemory(flaky, moveArgs('c1', 'wa'));
    assert.deepEqual([t.stop, t.step, h.store.has(memName(id))], ['read', 'writeMem', false]);
});

test('v0.6.67 row 6: a memory without integrity needs the same old copy, not the address alone (v0.6.69: nor fingerprints)', async () => {
    const id = migrateId(A, 'c-old');
    const files = {
        [memName(id)]: memBody({ id, state: recorded(P80, 19), wid: 'w0', from: { kind: 'migrate', addr: A, copy: 'c-old' }, home: { addr: A, integrity: null }, copy: 'c-old' }),
        [startName(A)]: startBody({ addr: A, copy: 'c-old', mem: id, wid: 'w0' }),
        [movedName(A, 'c-old')]: movedBody({ addr: A, copy: 'c-old', mem: id }),
    };
    const other = printsOf(msgs(10, i => `Different ${i}`));
    // A new room under the same name: other integrity, no old copy, other messages → hold, nothing linked.
    let r = await decideRoom(room({ integrity: 'i-new', prints: other }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why, r.mem], ['hold', 6, 'unproven', id]);
    r = await decideRoom(room({ integrity: null, prints: other }), world(files).read);
    assert.deepEqual([r.verdict, r.why], ['hold', 'unproven']);
    // No messages to compare (a fresh room) is no proof either.
    r = await decideRoom(room({ integrity: 'i-new', prints: [] }), world(files).read);
    assert.deepEqual([r.verdict, r.why], ['hold', 'unproven']);
    // The old room itself, its integrity added later by SillyTavern: the old copy is still in the chat → relink.
    r = await decideRoom(room({ integrity: 'i-late', copy: { hash: 'c-old', ok: true } }), world(files).read);
    assert.deepEqual([r.verdict, r.mem], ['relink', id]);
    // Its old copy gone: v0.6.69 every recorded fingerprint matching is still no proof → hold, the memory kept.
    r = await decideRoom(room({ integrity: 'i-late', prints: P80.slice(0, 30) }), world(files).read);
    assert.deepEqual([r.verdict, r.why, r.mem, r.prints.matched === r.prints.total], ['hold', 'unproven', id, true]);
    const edited = P80.slice(0, 30); edited[19] = 'x';
    r = await decideRoom(room({ integrity: 'i-late', prints: edited }), world(files).read);
    assert.deepEqual([r.verdict, r.why], ['hold', 'unproven']);
    // A memory with integrity is still matched by it (unchanged).
    const { files: lf, id: lid } = linked();
    delete lf[tagName(A)];
    r = await decideRoom(room({ prints: other }), world(lf).read);
    assert.deepEqual([r.verdict, r.mem], ['relink', lid]);
});

test('v0.6.67: an old copy moved out of another room after this room was decided is held, at the start and at the copy hint', async () => {
    const copy = 'c-shared';
    const args = (addr, wid) => ({ id: migrateId(addr, copy), from: { kind: 'migrate', addr, copy }, addr, integrity: null, copy, state: recorded(P80, 19), wid });
    // B finished first (one after the other): A's plan finds B in the copy hint → hold before writing anything.
    let f = folder();
    assert.equal((await placeMemory(f.io('B'), args(B, 'wb'))).done, true);
    const before = f.log.length;
    let r = await placeMemory(f.io('A'), args(A, 'wa'));
    assert.deepEqual([r.hold, f.log.length], ['copyMoved', before]);
    assert.equal(writePlan({ id: migrateId(A, copy), from: { kind: 'migrate', addr: A, copy }, addr: A, copy, mem: { kind: MISSING }, tag: { kind: MISSING },
        start: { kind: MISSING }, moved: { kind: MISSING }, hint: { kind: OK, data: copyHintBody(copy, [B]) } }).hold, 'copyMoved');
    // B lists itself after A's plan: the read in writeCopy finds it → hold, no tag for A.
    const g = hooked();
    g.after('A', movedName(A, copy), async () => { await g.io('B').write(copyName(copy), copyHintBody(copy, [B])); });
    r = await placeMemory(g.io('A'), args(A, 'wa'));
    assert.deepEqual([r.hold, r.step], ['copyMoved', 'writeCopy']);
    assert.equal(g.store.has(tagName(A)), false);
    // Only this room in the hint (a retry) → goes on.
    f = folder({ [copyName(copy)]: copyHintBody(copy, [A]) });
    assert.equal((await placeMemory(f.io('A'), args(A, 'wa'))).done, true);
});

test('v0.6.67 row 8: a listed room counts only with its tag still at this integrity, or with no tag and its memory file there', async () => {
    const X = roomAddr('ari.png', 'Ari - reused');
    // X's address is another room now (its tag has another integrity) → not a candidate.
    let files = { [clueName('i-S')]: clueBody('i-S', [{ addr: X, mem: homeId(X, 'i-S') }]), [tagName(X)]: tagBody({ addr: X, integrity: 'i-OTHER', mem: homeId(X, 'i-OTHER') }) };
    let r = await decideRoom(room({ integrity: 'i-S' }), world(files).read);
    assert.deepEqual([r.verdict, r.row], ['new', 12]);
    // Same tag at this integrity → candidate (unchanged).
    files[tagName(X)] = tagBody({ addr: X, integrity: 'i-S', mem: homeId(X, 'i-S') });
    r = await decideRoom(room({ integrity: 'i-S' }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.candidates], ['hold', 8, [X]]);
    // A linked branch whose tag alone is gone, opened as an imported copy: hold with the branch as candidate,
    // not a fresh copy of the parent's memory.
    const pw = parentWorld();
    const B1 = roomAddr('ari.png', 'Ari - branch'), bid = homeId(B1, 'i-B1');
    files = { ...pw.files, [memName(bid)]: memFile(bid, { addr: B1, integrity: 'i-B1', state: recorded(P80, 39), from: { kind: 'branch', addr: pw.pAddr } }), [clueName('i-B1')]: clueBody('i-B1', [{ addr: B1, mem: bid }]) };
    const imp = branchRoom({ addr: roomAddr('ari.png', 'Ari - branch imported'), prints: P80.slice(0, 45) });
    r = await decideRoom(imp, world(files).read, { slotsOf: pw.slotsOf });
    assert.deepEqual([r.verdict, r.row, r.candidates], ['hold', 8, [B1]]);
    // That memory file cannot be read → readFail, never a guess.
    r = await decideRoom(imp, world(files, { [memName(bid)]: 'error' }).read, { slotsOf: pw.slotsOf });
    assert.deepEqual([r.verdict, r.row], ['readFail', 8]);
    // At another home (a stale hint) or missing → not a candidate: the branch rows go on.
    files[memName(bid)] = memFile(bid, { addr: B1, integrity: 'i-B2', state: recorded(P80, 39) });
    r = await decideRoom(imp, world(files).read, { slotsOf: pw.slotsOf });
    assert.equal(r.verdict, 'branch');
    delete files[memName(bid)];
    r = await decideRoom(imp, world(files).read, { slotsOf: pw.slotsOf });
    assert.equal(r.verdict, 'branch');
});

test('v0.6.67: a memory without a history list cannot be rewound for a branch: a matching slot, or hold (no exception)', async () => {
    const st = recorded(P80, 19); delete st.history;
    assert.equal(validState(st), true);
    const other = P80.slice(0, 10).concat(printsOf(msgs(10, i => `Changed ${i}`)));
    assert.deepEqual(branchRestore(st, other, []), { ok: false, why: 'noHistory', at: 10 });
    const slot = { id: 'q', mem: emptyMem(), pos: { lastIndex: 4, digest: digest(other.slice(0, 5)) }, updated: 1 };
    const r = branchRestore(st, other, [slot]);
    assert.deepEqual([r.ok, r.via, r.state.lastIndex], [true, 'slot', 4]);
    // Nothing differs → carried over as it is (no rewind needed).
    assert.equal(branchRestore(st, P80.slice(0, 30)).ok, true);
    // Through decideRoom: hold with the reason.
    const pw = parentWorld();
    const pm = pw.files[memName(pw.pid)]; delete pm.state.history;
    const d = await decideRoom(branchRoom({ prints: P80.slice(0, 10).concat(other.slice(10)) }), world(pw.files).read, { slotsOf: pw.slotsOf });
    assert.deepEqual([d.verdict, d.row, d.reason], ['hold', 7, 'noHistory']);
});

// ───────── v0.6.69: review of v0.6.67 ─────────

test('v0.6.69: a move held because another room moved the same old copy stays held when the room is opened again and on a retry', async () => {
    const copy = 'c-shared';
    const args = (addr, wid) => ({ id: migrateId(addr, copy), from: { kind: 'migrate', addr, copy }, addr, integrity: null, copy, state: recorded(P80, 19), wid });
    const roomA = room({ integrity: null, copy: { hash: copy, ok: true }, traces: true, prints: P80.slice(0, 20) });
    const f = hooked();
    f.after('A', movedName(A, copy), () => placeMemory(f.io('B'), args(B, 'wb')));
    const first = await placeMemory(f.io('A'), args(A, 'wa'));
    assert.deepEqual([first.hold, first.step, f.store.has(memName(migrateId(A, copy)))], ['copyMoved', 'writeCopy', true]);
    const read = async n => (f.store.has(n) ? { kind: OK, data: f.get(n) } : { kind: MISSING });
    const d = await decideRoom(roomA, read);
    assert.deepEqual([d.verdict, d.row, d.why, d.from], ['hold', 6, 'copyMoved', B]);
    assert.equal((await placeMemory(f.io('A'), args(A, 'wa'))).hold, 'copyMoved');
    assert.equal((await decideRoom(roomA, read)).why, 'copyMoved');                  // the same answer every time
    assert.equal(f.store.has(tagName(A)), false);
    // The copy hint cannot be read → readFail, not a link.
    const files = Object.fromEntries([...f.store].map(([k, v]) => [k, JSON.parse(v)]));
    const r = await decideRoom(roomA, world(files, { [copyName(copy)]: 'error' }).read);
    assert.equal(r.verdict, 'readFail');
});

test('v0.6.69 row 6: another room\'s moved mark, or the hint for the memory\'s own copy, holds; a branch carrying the old copy still relinks', async () => {
    const copy = 'c-shared', id = migrateId(A, copy);
    const body = (integrity = 'i-A') => memBody({ id, state: recorded(P80, 19), wid: 'w0', from: { kind: 'migrate', addr: A, copy }, home: { addr: A, integrity }, copy });
    // Another room's moved mark (found through the integrity hint) and no copy hint yet → hold.
    let files = { [memName(id)]: body(), [clueName('i-A')]: clueBody('i-A', [{ addr: B, mem: 'other' }]), [movedName(B, copy)]: movedBody({ addr: B, copy, mem: 'other' }) };
    let r = await decideRoom(room({ copy: { hash: copy, ok: true } }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why, r.from], ['hold', 6, 'copyMoved', B]);
    // The old copy is no longer in the chat (integrity proves the room): the hint for the memory's own copy is read.
    files = { [memName(id)]: body(), [clueName('i-A')]: clueBody('i-A', [{ addr: A, mem: id }]), [copyName(copy)]: copyHintBody(copy, [B]) };
    const w = world(files);
    r = await decideRoom(room(), w.read);
    assert.deepEqual([r.verdict, r.why, w.reads.includes(copyName(copy))], ['hold', 'copyMoved', true]);
    r = await decideRoom(room(), world(files, { [copyName(copy)]: 'error' }).read);
    assert.deepEqual([r.verdict, r.row, r.names], ['readFail', 6, [copyName(copy)]]);
    files[copyName(copy)] = copyHintBody(copy, [A]);
    r = await decideRoom(room(), world(files).read);
    assert.deepEqual([r.verdict, r.mem], ['relink', id]);
    // A branch carries its parent's old copy, which the parent moved out: still its own memory → relink.
    const pw = parentWorld();
    const bid = homeId(A, 'i-B1');
    files = { ...pw.files, [memName(bid)]: memBody({ id: bid, state: recorded(P80, 19), wid: 'w0', from: { kind: 'branch', addr: pw.pAddr }, home: { addr: A, integrity: 'i-B1' }, copy }),
        [copyName(copy)]: copyHintBody(copy, [pw.pAddr]), [movedName(pw.pAddr, copy)]: movedBody({ addr: pw.pAddr, copy, mem: pw.pid }) };
    r = await decideRoom(branchRoom({ copy: { hash: copy, ok: true } }), world(files).read, { slotsOf: pw.slotsOf });
    assert.deepEqual([r.verdict, r.mem], ['relink', bid]);
});

test('v0.6.69: the same room needs the same integrity or the same old copy; integrity that differs holds even with the same copy; fingerprints alone hold', async () => {
    const greet = printsOf([{ name: 'Ari', is_user: false, mes: 'Hello there', swipe_id: 0 }]);
    const id = migrateId(A, 'c-old');
    const mem = integrity => memBody({ id, state: recorded(greet, 0, { size: 1 }), wid: 'w0', from: { kind: 'migrate', addr: A, copy: 'c-old' }, home: { addr: A, integrity }, copy: 'c-old' });
    // Integrity different on both sides, the same old copy: hold with and without a tag.
    let files = { [memName(id)]: mem('i-old'), [tagName(A)]: tagBody({ addr: A, integrity: 'i-old', mem: id, copy: 'c-old' }) };
    let r = await decideRoom(room({ integrity: 'i-new', copy: { hash: 'c-old', ok: true } }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 1, 'integrity']);
    delete files[tagName(A)];
    r = await decideRoom(room({ integrity: 'i-new', copy: { hash: 'c-old', ok: true } }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 6, 'homeDiff']);
    // An old memory without integrity that recorded only the greeting; a new room with the same name and greeting.
    files = { [memName(id)]: mem(null), [startName(A)]: startBody({ addr: A, copy: 'c-old', mem: id, wid: 'w0' }) };
    const kept = structuredClone(files[memName(id)]);
    const w = world(files);
    r = await decideRoom(room({ integrity: 'i-new', prints: greet }), w.read);
    assert.deepEqual([r.verdict, r.row, r.why, r.mem, r.prints], ['hold', 6, 'unproven', id, { total: 1, matched: 1, first: -1 }]);
    files[tagName(A)] = tagBody({ addr: A, integrity: null, mem: id, copy: 'c-old', prints: pickPrints(greet) });
    r = await decideRoom(room({ integrity: 'i-new', prints: greet }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 3, 'unproven']);
    r = await decideRoom(room({ integrity: null, prints: greet }), world(files).read);
    assert.deepEqual([r.verdict, r.row, r.why], ['hold', 3, 'unproven']);
    assert.deepEqual(w.store.get(memName(id)), kept);                                   // the old memory is kept as it was
    // The same old copy in the chat → link (the old room itself).
    r = await decideRoom(room({ integrity: 'i-new', copy: { hash: 'c-old', ok: true }, prints: greet }), world(files).read);
    assert.deepEqual([r.verdict, r.proof], ['link', 'copy']);
});

test('v0.6.69: a damaged history or a rewind that fails goes to a matching slot, or holds (no exception)', async () => {
    const other = P80.slice(0, 10).concat(printsOf(msgs(10, i => `Changed ${i}`)));
    const slot = { id: 'q', mem: emptyMem(), pos: { lastIndex: 4, digest: digest(other.slice(0, 5)) }, updated: 1 };
    const damaged = {
        'null entry': st => { st.history = [null]; },
        'entry without diff': st => { delete st.history[1].diff; },
        'summary without range': st => { st.history[2].to = 'x'; },
        'diff that cannot be undone': st => { st.history[3].diff.changes = [null]; },
    };
    for (const [name, hurt] of Object.entries(damaged)) {
        const st = recorded(P80, 19); hurt(st);
        assert.equal(validState(st), true, name);
        let r;
        assert.doesNotThrow(() => { r = branchRestore(st, other, []); }, name);
        assert.equal(r.ok, false, name);
        assert.ok(['noHistory', 'rewindFail'].includes(r.why), name);
        r = branchRestore(st, other, [slot]);
        assert.deepEqual([r.ok, r.via, r.state.lastIndex], [true, 'slot', 4], name);
    }
    // Through decideRoom: hold with the reason, or the slot. (v0.6.71: a null change is caught by the history
    // check now — noHistory; a change that passes it and still fails on the rewind is rewindFail.)
    const throws = st => { const d = st.history[3].diff, c = d.changes[0]; c.before = { ...c.after, segs: 'x' }; d.orderBefore[c.kind].push(c.id); };
    for (const [hurt, why] of [[st => { st.history[3].diff.changes = [null]; }, 'noHistory'], [throws, 'rewindFail']]) for (const slots of [[], [slot]]) {
        const pw = parentWorld({ slots });
        hurt(pw.files[memName(pw.pid)].state);
        const d = await decideRoom(branchRoom({ prints: other }), world(pw.files).read, { slotsOf: pw.slotsOf });
        assert.deepEqual(slots.length ? [d.verdict, d.via] : [d.verdict, d.reason], slots.length ? ['branch', 'slot'] : ['hold', why], why);
    }
});

// ───────── v0.6.71: review of v0.6.69 ─────────

const A2 = roomAddr('ari.png', 'Ari - 2026-01-01 imported');
const asFiles = f => Object.fromEntries([...f.store].map(([k, v]) => [k, JSON.parse(v)]));
const readOf = f => async n => (f.store.has(n) ? { kind: OK, data: f.get(n) } : { kind: MISSING });
const moveOf = (addr, copy, wid, integrity = null) => ({ id: migrateId(addr, copy), from: { kind: 'migrate', addr, copy }, addr, integrity, copy, state: recorded(P80, 19), wid });
const oldRoom = (addr, extra = {}) => room({ addr, integrity: null, copy: { hash: 'c-old', ok: true }, traces: true, prints: P80.slice(0, 20), ...extra });

test('v0.6.71 ①: a move that stopped before its copy hint is finished by the relink (hint, then tag); another room with the same old copy then holds', async () => {
    const f = folder();
    const id = migrateId(A, 'c-old');
    assert.deepEqual((await placeMemory(f.io('A', { failWrite: copyName('c-old') }), moveOf(A, 'c-old', 'wa'))).stop, 'write');
    const d = await decideRoom(oldRoom(A), readOf(f));
    assert.deepEqual([d.verdict, d.row, d.mem, d.copy, d.seen], ['relink', 6, id, 'c-old', { rev: 0, wid: 'wa' }]);
    const before = f.log.length;
    const r = await relinkMemory(f.io('A'), d, { addr: A, integrity: null, wid: 'wa2' });
    assert.deepEqual([r.done, r.mem, r.seen], [true, id, { rev: 0, wid: 'wa' }]);
    assert.deepEqual(f.log.slice(before).map(e => e[1]), [copyName('c-old'), tagName(A)]);   // the missing hint first, the tag last
    assert.equal(f.log.filter(e => e[1] === memName(id)).length, 1, 'the body is never written again');
    assert.deepEqual(f.get(copyName('c-old')).rooms, [A]);
    const b = await decideRoom(oldRoom(B), readOf(f));
    assert.deepEqual([b.verdict, b.row, b.why, b.from], ['hold', 9, 'copyMoved', A]);
    assert.equal((await decideRoom(oldRoom(A), readOf(f))).verdict, 'link');
});

test('v0.6.71 ②: another room finishing the same move while this one opens → hold (row 6 reads the hint again; the relink checks it too)', async () => {
    const f = folder();
    await placeMemory(f.io('A', { failWrite: copyName('c-old') }), moveOf(A, 'c-old', 'wa'));
    // B finishes after A gathered its files and before A read the memory file.
    let once = false;
    const readMem = async id => { if (!once) { once = true; assert.equal((await placeMemory(f.io('B'), moveOf(B, 'c-old', 'wb'))).done, true); } return readOf(f)(memName(id)); };
    const d = await decideRoom(oldRoom(A), readOf(f), { readMem });
    assert.deepEqual([d.verdict, d.row, d.why, d.from], ['hold', 6, 'copyMoved', B]);
    // B finishes after A decided: the relink holds at the hint and writes no tag.
    const g = folder();
    await placeMemory(g.io('A', { failWrite: copyName('c-old') }), moveOf(A, 'c-old', 'wa'));
    const e = await decideRoom(oldRoom(A), readOf(g));
    assert.equal(e.verdict, 'relink');
    assert.equal((await placeMemory(g.io('B'), moveOf(B, 'c-old', 'wb'))).done, true);
    const r = await relinkMemory(g.io('A'), e, { addr: A, integrity: null, wid: 'wa2' });
    assert.equal(r.hold, 'copyMoved');
    assert.equal(g.store.has(tagName(A)), false);
});

test('v0.6.71 ③: a room that stopped before its integrity hint gets it on the relink; an imported copy then holds (row 8) instead of starting anew', async () => {
    const f = folder();
    const id = homeId(A, 'i-A');
    const args = { id, from: { kind: 'new', addr: A, integrity: 'i-A' }, addr: A, integrity: 'i-A', state: recorded(P80, 19), wid: 'wa' };
    assert.equal((await placeMemory(f.io('A', { failWrite: clueName('i-A') }), args)).stop, 'write');
    const d = await decideRoom(room(), readOf(f));
    assert.deepEqual([d.verdict, d.row, d.mem], ['relink', 6, id]);
    const before = f.log.length;
    assert.equal((await relinkMemory(f.io('A'), d, { addr: A, integrity: 'i-A', wid: 'wa2' })).done, true);
    assert.deepEqual(f.log.slice(before).map(e => e[1]), [clueName('i-A'), tagName(A)]);
    const imp = await decideRoom(room({ addr: A2 }), readOf(f));
    assert.deepEqual([imp.verdict, imp.row, imp.why, imp.candidates], ['hold', 8, 'sameIntegrity', [A]]);
});

test('v0.6.71 ④: integrity proves the room and only the chat lost its old copy → the memory\'s own copy is used; a chat copy that differs holds', async () => {
    const f = folder();
    const id = migrateId(A, 'c-old');
    await placeMemory(f.io('A', { failWrite: copyName('c-old') }), moveOf(A, 'c-old', 'wa', 'i-A'));
    const gone = room({ copy: null, traces: true, prints: P80.slice(0, 20) });
    const d = await decideRoom(gone, readOf(f));
    assert.deepEqual([d.verdict, d.row, d.mem, d.copy], ['relink', 6, id, 'c-old']);
    // What the chat has (nothing) would be held as another copy: the reason the memory's own is used.
    assert.equal((await placeMemory(f.io('A'), { ...moveOf(A, 'c-old', 'wx', 'i-A'), copy: null })).hold, 'copyChanged');
    const r = await relinkMemory(f.io('A'), d, { addr: A, integrity: 'i-A', wid: 'wa2' });
    assert.deepEqual([r.done, r.mem], [true, id]);
    assert.deepEqual([f.get(tagName(A)).copy, f.get(copyName('c-old')).rooms], ['c-old', [A]]);
    // The chat still has an old copy, another one: hold as before, nothing written.
    const g = folder();
    await placeMemory(g.io('A', { failWrite: copyName('c-old') }), moveOf(A, 'c-old', 'wa', 'i-A'));
    const before = g.log.length;
    const e = await decideRoom(room({ copy: { hash: 'c-new', ok: true }, traces: true }), readOf(g));
    assert.deepEqual([e.verdict, e.row, e.why], ['hold', 6, 'copyChanged']);
    assert.equal(g.log.length, before);
});

test('v0.6.71 ⑤: right before the tag the copy hint is read again, also on a retry with no writeCopy left → another room there holds, no tag', async () => {
    const id = migrateId(A, 'c-old');
    // A stopped after its copy hint (at the integrity hint): the retry has no writeCopy step.
    const f = hooked();
    await placeMemory(f.io('A'), { ...moveOf(A, 'c-old', 'wa', 'i-A') }).catch(() => {});
    f.store.delete(tagName(A)); f.store.delete(clueName('i-A'));
    assert.deepEqual(f.get(copyName('c-old')).rooms, [A]);
    const d = await decideRoom(room({ copy: { hash: 'c-old', ok: true }, traces: true, prints: P80.slice(0, 20) }), readOf(f));
    assert.equal(d.verdict, 'relink');
    // Another room lands in the hint after the plan was made (the gap the server cannot close).
    f.after('A', clueName('i-A'), async () => { await f.io('B').write(copyName('c-old'), copyHintBody('c-old', [A, B])); });
    const r = await relinkMemory(f.io('A'), d, { addr: A, integrity: 'i-A', wid: 'wa2' });
    assert.deepEqual([r.hold, r.step], ['copyMoved', 'recheckStart']);
    assert.equal(f.store.has(tagName(A)), false);
    // A first move gets the same check.
    const g = hooked();
    g.after('A', clueName('i-A'), async () => { await g.io('B').write(copyName('c-old'), copyHintBody('c-old', [A, B])); });
    const s = await placeMemory(g.io('A'), moveOf(A, 'c-old', 'wa', 'i-A'));
    assert.deepEqual([s.hold, s.step, g.store.has(tagName(A))], ['copyMoved', 'recheckStart', false]);
    // The hint cannot be read there → stop, no tag.
    const h = folder();
    const io = h.io('A');
    let n = 0;
    const flaky = { read: async name => (name === copyName('c-old') && ++n === 3 ? { kind: ERROR } : io.read(name)), write: io.write };
    const t = await placeMemory(flaky, moveOf(A, 'c-old', 'wa', 'i-A'));
    assert.deepEqual([t.stop, t.step, h.store.has(tagName(A))], ['read', 'recheckStart', false]);
    assert.equal(id, migrateId(A, 'c-old'));
});

test('v0.6.71: the relink goes on only over the memory file decideRoom saw: gone, another one or unreadable → stop, never made again', async () => {
    const id = migrateId(A, 'c-old');
    // Stopped at the copy hint (hooked() has no failing writes: finish, then take off what was not written).
    const setup = async () => { const f = hooked(); await placeMemory(f.io('A'), moveOf(A, 'c-old', 'wa')); f.store.delete(copyName('c-old')); f.store.delete(tagName(A)); return f; };
    // Gone before the relink.
    let f = await setup();
    let d = await decideRoom(oldRoom(A), readOf(f));
    assert.equal(d.verdict, 'relink');
    assert.equal((await relinkMemory(f.io('A'), { ...d, verdict: 'link' }, { addr: A, wid: 'wa2' })).stop, 'notRelink');
    f.store.delete(memName(id));
    let before = f.log.length;
    let r = await relinkMemory(f.io('A'), d, { addr: A, integrity: null, wid: 'wa2' });
    assert.deepEqual([r.stop, f.store.has(memName(id)), f.log.length], ['memGone', false, before]);
    // Another memory under that name now (another receipt).
    f = await setup();
    d = await decideRoom(oldRoom(A), readOf(f));
    const cur = f.get(memName(id));
    await f.io('B').write(memName(id), nextMem(cur, recorded(P80, 9), 'wb'));
    before = f.log.length;
    r = await relinkMemory(f.io('A'), d, { addr: A, integrity: null, wid: 'wa2' });
    assert.deepEqual([r.stop, f.get(memName(id)).wid, f.log.length], ['memChanged', 'wb', before]);
    // Unreadable.
    f = await setup();
    d = await decideRoom(oldRoom(A), readOf(f));
    const io = f.io('A');
    r = await relinkMemory({ read: async n => (n === memName(id) ? { kind: BROKEN } : io.read(n)), write: io.write }, d, { addr: A, integrity: null, wid: 'wa2' });
    assert.equal(r.stop, 'read');
    // Changed while the hints were written: read again right before the tag → stop, no tag.
    f = await setup();
    d = await decideRoom(oldRoom(A), readOf(f));
    f.after('A', copyName('c-old'), async () => { f.store.delete(memName(id)); });
    r = await relinkMemory(f.io('A'), d, { addr: A, integrity: null, wid: 'wa2' });
    assert.deepEqual([r.stop, r.step, f.store.has(tagName(A)), f.store.has(memName(id))], ['memGone', 'recheckMem', false, false]);
});

test('v0.6.71 ⑥: a damaged change in the history (a side missing, a side the order lists contradict, unusable id counters) → a matching slot, or hold; a normal before: null rewinds', async () => {
    const p = P80.slice(0, 4);
    const st = { v: 1, line: 'L', roomKey: P, mem: emptyMem(), lastIndex: -1, hashes: [], history: [], floor: -1, rev: 0, lootQueue: [] };
    let b = st.mem, a = structuredClone(b);
    a.scenes.push({ id: 's0', title: 'One', status: 'open', segs: [] });
    st.mem = a; st.lastIndex = 0; st.hashes = p.slice(0, 1); pushHistory(st, b, a, { kind: 'summary', from: 0, to: 0 });
    b = st.mem; a = structuredClone(b); a.scenes[0].title = 'One, edited';
    a.scenes.push({ id: 's1', title: 'Two', status: 'open', segs: [] });
    st.mem = a; st.lastIndex = 1; st.hashes = p.slice(0, 2); pushHistory(st, b, a, { kind: 'summary', from: 1, to: 1 });
    const branch = [p[0], 'other'];
    const slotMem = emptyMem(); slotMem.scenes.push({ id: 's0', title: 'One', status: 'open', segs: [] });
    const slot = { id: 'q', mem: slotMem, pos: { lastIndex: 0, digest: digest([p[0]]) }, updated: 1 };
    // Intact: the edit is undone and the new scene (before: null) goes, the first scene stays.
    let r = branchRestore(st, branch, []);
    assert.deepEqual([r.ok, r.via, r.state.mem.scenes.map(x => x.title)], [true, 'rewind', ['One']]);
    const edit = d => d.changes.find(c => c.id === 's0'), added = d => d.changes.find(c => c.id === 's1');
    const damaged = {
        'before missing': d => { delete edit(d).before; },
        'after missing': d => { delete added(d).after; },
        'before null for an item that was there': d => { edit(d).before = null; },
        'before for an item that was not there': d => { added(d).before = { id: 's1', title: 'x', status: 'open', segs: [] }; },
        'after null for an item still there': d => { edit(d).after = null; },
        'unknown kind': d => { edit(d).kind = 'other'; },
        'nextBefore missing': d => { delete d.nextBefore; },
        'nextBefore not usable': d => { d.nextBefore = { s: 0, g: 1, e: 1, r: 1 }; },
        'nextBefore without a counter': d => { delete d.nextBefore.g; },
        'nextAfter missing': d => { delete d.nextAfter; },
        'orderAfter missing a list': d => { delete d.orderAfter.records; },
    };
    for (const [name, hurt] of Object.entries(damaged)) {
        const s = structuredClone(st); hurt(s.history[1].diff);
        assert.equal(validState(s), true, name);
        let x;
        assert.doesNotThrow(() => { x = branchRestore(s, branch, []); }, name);
        assert.deepEqual([x.ok, x.why], [false, 'noHistory'], name);
        x = branchRestore(s, branch, [slot]);
        assert.deepEqual([x.ok, x.via, x.state.mem.scenes.map(y => y.title)], [true, 'slot', ['One']], name);
    }
    // Through decideRoom: hold without a slot.
    const pw = parentWorld();
    const pm = pw.files[memName(pw.pid)].state;
    delete pm.history[3].diff.nextBefore;
    const other = P80.slice(0, 10).concat(printsOf(msgs(10, i => `Changed ${i}`)));
    const d = await decideRoom(branchRoom({ prints: other }), world(pw.files).read, { slotsOf: pw.slotsOf });
    assert.deepEqual([d.verdict, d.row, d.reason], ['hold', 7, 'noHistory']);
});

test('v0.6.78: the tag is read again right before it is written: none → written, the same link → kept, anything else → hold', async () => {
    const id = homeId(A, 'i-A');
    const args = { id, from: { kind: 'new', addr: A, integrity: 'i-A' }, addr: A, integrity: 'i-A', state: recorded(P80, 19), wid: 'wa' };
    const failClue = io => ({ read: io.read, async write(n, b) { if (n === clueName('i-A')) throw new Error('x'); return io.write(n, b); } });
    // ① relink (row 6) while another device marks this name renamed away → hold, the mark stays.
    {
        const f = hooked();
        await placeMemory(failClue(f.io('A')), args);
        const d = await decideRoom(room(), readOf(f));
        assert.deepEqual([d.verdict, d.row], ['relink', 6]);
        f.after('A', clueName('i-A'), async () => { await f.io('B').write(tagName(A), renamedTag(tagBody({ addr: A, integrity: 'i-A', mem: id }), A2)); });
        const r = await relinkMemory(f.io('A'), d, { addr: A, integrity: 'i-A', wid: 'wa2' });
        assert.deepEqual([r.hold, r.step], ['tagChanged', 'writeTag']);
        assert.deepEqual([f.get(tagName(A)).state, f.get(tagName(A)).to], ['renamed', A2]);
    }
    // ② another device linked this name to another memory meanwhile → hold, its tag stays.
    {
        const f = hooked();
        await placeMemory(failClue(f.io('A')), args);
        const d = await decideRoom(room(), readOf(f));
        f.after('A', clueName('i-A'), async () => { await f.io('B').write(tagName(A), tagBody({ addr: A, integrity: 'i-A', mem: 'm-other' })); });
        const r = await relinkMemory(f.io('A'), d, { addr: A, integrity: 'i-A', wid: 'wa2' });
        assert.equal(r.hold, 'tagChanged');
        assert.equal(f.get(tagName(A)).mem, 'm-other');
    }
    // ③ the other device finished the same link first → kept as it is (written once, by B), done.
    {
        const f = hooked();
        await placeMemory(failClue(f.io('A')), args);
        const d = await decideRoom(room(), readOf(f));
        const theirs = tagBody({ addr: A, integrity: 'i-A', mem: id, at: 1 });
        f.after('A', clueName('i-A'), async () => { await f.io('B').write(tagName(A), theirs); });
        const r = await relinkMemory(f.io('A'), d, { addr: A, integrity: 'i-A', wid: 'wa2' });
        assert.equal(r.done, true);
        assert.deepEqual(f.get(tagName(A)), theirs);
        assert.equal(f.log.filter(e => e[0] === 'A' && e[1] === tagName(A)).length, 0);
    }
    // ④ the tag cannot be read right before → stop, nothing written; ⑤ none (as before) → written last.
    {
        const f = folder();
        await placeMemory(failClue(f.io('A')), args);
        const d = await decideRoom(room(), readOf(f));
        let reads = 0;
        const io = f.io('A');
        const flaky = { read: async n => (n === tagName(A) && ++reads === 2 ? { kind: ERROR } : io.read(n)), write: io.write };
        const r = await relinkMemory(flaky, d, { addr: A, integrity: 'i-A', wid: 'wa2' });
        assert.deepEqual([r.stop, r.step], ['read', 'writeTag']);
        assert.equal(f.store.has(tagName(A)), false);
        const ok = await relinkMemory(f.io('A'), d, { addr: A, integrity: 'i-A', wid: 'wa2' });
        assert.equal(ok.done, true);
        assert.equal(f.get(tagName(A)).mem, id);
    }
    // ⑥ the first move does the same: another device marks the name renamed right before the tag → hold.
    {
        const f = hooked();
        const cid = migrateId(A, 'c1');
        f.after('A', clueName('i-A'), async () => { await f.io('B').write(tagName(A), renamedTag(tagBody({ addr: A, integrity: 'i-A', mem: cid }), A2)); });
        const r = await placeMemory(f.io('A'), moveOf(A, 'c1', 'wa', 'i-A'));
        assert.deepEqual([r.hold, r.step], ['tagChanged', 'writeTag']);
        assert.equal(f.get(tagName(A)).state, 'renamed');
    }
});

test('v0.6.82: one rule for a tag that is there already (sameLink), when the plan is made and right before the tag', async () => {
    // ① A tag to this memory id with another integrity is there before the plan → held, the tag stays.
    {
        const f = folder();
        const id = homeId(A, 'i-A');
        const theirs = tagBody({ addr: A, integrity: 'i-OTHER', mem: id, at: 1 });
        await f.io('B').write(tagName(A), theirs);
        const r = await placeMemory(f.io('A'), { id, from: { kind: 'new', addr: A, integrity: 'i-A' }, addr: A, integrity: 'i-A', state: recorded(P80, 19), wid: 'wa' });
        assert.equal(r.hold, 'tagChanged');
        assert.deepEqual(f.get(tagName(A)), theirs);
    }
    // ② Right before the tag another device writes this memory id and integrity with another old copy →
    //    held (it used to be taken as done, and the room then held 'copyChanged' when it opened next).
    {
        const f = hooked();
        const cid = migrateId(A, 'c1');
        const theirs = tagBody({ addr: A, integrity: 'i-A', mem: cid, copy: 'c-other', at: 1 });
        f.after('A', clueName('i-A'), async () => { await f.io('B').write(tagName(A), theirs); });
        const r = await placeMemory(f.io('A'), moveOf(A, 'c1', 'wa', 'i-A'));
        assert.deepEqual([r.hold, r.step], ['tagChanged', 'writeTag']);
        assert.deepEqual(f.get(tagName(A)), theirs);
    }
    // ③ The very link with the same old copy, there before the plan or written right before the tag → done,
    //    this device never writes the tag; the room then opens linked.
    for (const when of ['plan', 'tag']) {
        const f = hooked();
        const cid = migrateId(A, 'c1');
        const theirs = tagBody({ addr: A, integrity: 'i-A', mem: cid, copy: 'c1', at: 1 });
        if (when === 'plan') await f.io('B').write(tagName(A), theirs);
        else f.after('A', clueName('i-A'), async () => { await f.io('B').write(tagName(A), theirs); });
        const r = await placeMemory(f.io('A'), moveOf(A, 'c1', 'wa', 'i-A'));
        assert.equal(r.done, true, when);
        assert.equal(f.log.filter(e => e[0] === 'A' && e[1] === tagName(A)).length, 0, when);
    }
    // The rule itself: every part counts.
    const t = tagBody({ addr: A, integrity: 'i-A', mem: 'm', copy: 'c1' });
    assert.equal(sameLink(t, { id: 'm', integrity: 'i-A', copy: 'c1' }), true);
    for (const x of [{ id: 'n', integrity: 'i-A', copy: 'c1' }, { id: 'm', integrity: 'i-B', copy: 'c1' }, { id: 'm', integrity: null, copy: 'c1' }, { id: 'm', integrity: 'i-A', copy: 'c2' }, { id: 'm', integrity: 'i-A', copy: null }])
        assert.equal(sameLink(t, x), false, JSON.stringify(x));
    assert.equal(sameLink(renamedTag(t, A2), { id: 'm', integrity: 'i-A', copy: 'c1' }), false);
});

// v0.7.0-b1a (review P1-4): a rename guess takes the room reopened only when its name is the typed one as the server keeps it.
test('cleanName keeps a chat file name as the server cleans it', () => {
    assert.equal(cleanName('Plain name'), 'Plain name');
    assert.equal(cleanName('a/b:c?d*e|f"g<h>i\\j'), 'abcdefghij');
    assert.equal(cleanName('tab\there'), 'tabhere');
    assert.equal(cleanName('con'), '');
    assert.equal(cleanName('..'), '..', 'with .jsonl it is not a name of dots only');
    assert.equal(cleanName('x'.repeat(300)).length, 255, 'cut at 255 bytes (the cut takes .jsonl too)');
});
