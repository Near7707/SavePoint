// SavePoint home: where a room's memory lives once it moves out of the chat file (planned for v0.7.0).
//
// v0.6.64 (step 0): pure rules only. index.js does not use this file yet, so nothing changes for users.
//
// The plan (docs/REVIEW.md, v0.6.64): a room's memory is kept in the user files folder
// (data/<user>/user/files/), never in the chat file. SillyTavern saves the whole chat on its own timing,
// so anything SavePoint keeps in the chat file can be raced; files in user/files are never touched by it.
//
// Files (all JSON, all in user/files):
// - savepoint-mem-<memory id>.json    the memory: state + rev + wid (write receipt) + recent (rev, wid) list
//                                      + where it came from (`from`) + which room it belongs to (`home`).
// - savepoint-room-<hash of address>.json   the room's name tag: address (written out in full and checked
//                                      when read), integrity, memory id, a few message fingerprints,
//                                      the old-copy hash seen when the tag was written, state linked|renamed.
// - savepoint-int-<hash of integrity>.json  a search hint: rooms (address + memory id) with that integrity.
//                                      Never enough to link on its own (an imported copy has the same value).
// - savepoint-moved-<hash of address + old copy>.json   "this room's old in-chat memory was moved":
//                                      the memory id it went to and its rev then.
// - savepoint-moving-<hash of address>.json   (v0.6.65) "a move out of this room's chat started": the old
//                                      copy it started from, the memory id, a receipt. Found by the address
//                                      alone, so a retry finds it even after the old copy changed.
// - savepoint-copy-<hash of old copy>.json    (v0.6.65) rooms this old copy was moved out of. Only ever a
//                                      reason to hold (an older chat without integrity, renamed elsewhere).
// A room's address is the character (avatar) or group ('group:<id>') plus the chat file name, the same
// string index.js uses as roomKey(). Memory ids follow fixed rules, so a retry points at the same file and
// a room's memory file can be found by name even when its tag is gone:
// - moved from the chat file: hash(address + old copy hash)
// - a branch or a new room:   hash(address + integrity)
//
// Reading a file has four outcomes and they are never mixed up: missing (the server says there is no such
// file), broken (it came back but is not the JSON we wrote, or belongs to another name), error (the server
// or the network failed), ok. Broken and error are never taken as "missing": nothing is created or
// overwritten on top of a file that could not be read.

import { canon, hashString } from './guard.js';
import { rollbackFrom } from './core.js';

const clone = v => structuredClone(v);
const plainObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = v => typeof v === 'string' && v !== '';
const optStr = v => v === null || v === undefined || str(v);
const int = v => Number.isInteger(v);

// ───────── names and ids ─────────

// 128 bits as 28 base-36 characters (cyrb128). Not a security hash: every file also holds the full
// address it is for, and a file holding another one is read as broken.
export function nameHash(text) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    const s = String(text);
    for (let i = 0; i < s.length; i++) {
        const k = s.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
    return [h1, h2, h3, h4].map(x => (x >>> 0).toString(36).padStart(7, '0')).join('');
}
const idOf = (...parts) => nameHash(canon(parts));

// Same string as index.js roomKey(): JSON of [character avatar or 'group:<id>', chat file name].
export const roomAddr = (scope, file) => JSON.stringify([String(scope), String(file)]);
export const scopeOf = addr => { try { const a = JSON.parse(addr); return Array.isArray(a) ? a[0] : null; } catch { return null; } };
export const migrateId = (addr, copy) => idOf('migrate', addr, copy);
export const homeId = (addr, integrity) => idOf('home', addr, integrity);
export const memName = id => `savepoint-mem-${id}.json`;
export const tagName = addr => `savepoint-room-${idOf('room', addr)}.json`;
export const clueName = integrity => `savepoint-int-${idOf('int', integrity)}.json`;
export const movedName = (addr, copy) => `savepoint-moved-${idOf('moved', addr, copy)}.json`;
export const startName = addr => `savepoint-moving-${idOf('moving', addr)}.json`;
export const copyName = copy => `savepoint-copy-${idOf('copy', copy)}.json`;

// The old in-chat memory (chat metadata `savePoint`) as one value.
export const copyHash = copy => hashString(canon(copy));
// The same fingerprint index.js keeps per recorded message (visibility is not content).
export function fingerprint(m) {
    if (!m || typeof m !== 'object') return 'x';
    return hashString(JSON.stringify([m.name || '', !!m.is_user, m.mes || '', m.swipe_id ?? null]));
}
// The same digest a save slot keeps for its recorded messages (pos.digest).
export const digest = list => hashString(list.join('|'));

// SillyTavern's CHAT_RENAMED notice ({ avatarId, groupId, oldFileName, newFileName }; the names come with
// ".jsonl") as two addresses. null when it does not say enough.
// Note: SillyTavern may clean the new name on the server (sanitizedFileName) and still send the name as
// typed, so `to` can differ from the reopened room; the caller compares it with the room it reopened.
export function renameNotice(data) {
    if (!plainObj(data)) return null;
    const scope = data.groupId !== undefined && data.groupId !== null && data.groupId !== '' ? 'group:' + data.groupId : data.avatarId;
    const bare = n => String(n ?? '').replace(/\.jsonl$/i, '');
    const from = bare(data.oldFileName), to = bare(data.newFileName);
    if (!str(scope) || !from || !to || from === to) return null;
    return { from: roomAddr(scope, from), to: roomAddr(scope, to) };
}

// SavePoint's marks on messages (hide, shown, held, 🔖) and the old in-chat memory.
export const OWN_KEYS = ['savepointHidden', 'savepointVisible', 'savepointHeld', 'savepointKeep'];
export function hasTraces(meta, messages, module = 'savePoint') {
    if (plainObj(meta) && meta[module] !== undefined && meta[module] !== null) return true;
    return (Array.isArray(messages) ? messages : []).some(m => plainObj(m?.extra) && OWN_KEYS.some(k => m.extra[k] !== undefined));
}

// ───────── reading ─────────

export const MISSING = 'missing', BROKEN = 'broken', ERROR = 'error', OK = 'ok';
// One read of user/files/<name>: HTTP status and body text. Only 404 is "missing".
export function classifyRead(status, text, valid = () => true) {
    if (status === 404) return { kind: MISSING };
    if (!int(status) || status < 200 || status > 299) return { kind: ERROR, status };
    let data;
    try { data = JSON.parse(String(text)); } catch { return { kind: BROKEN, why: 'json' }; }
    if (!valid(data)) return { kind: BROKEN, why: 'shape' };
    return { kind: OK, data };
}
// The fetch around it. A thrown fetch or an unreadable body is an error, never "missing".
export async function readUserFile(fetchFn, name, { headers, valid } = {}) {
    let r, text;
    try { r = await fetchFn(`/user/files/${name}?t=${Date.now()}`, { cache: 'no-store', headers }); }
    catch { return { kind: ERROR, why: 'network' }; }
    try { text = await r.text(); } catch { return { kind: ERROR, why: 'body' }; }
    return classifyRead(r.status, text, valid);
}
// A read that came back but fails its own check counts as broken.
export function checked(res, valid) {
    if (!res || ![MISSING, BROKEN, ERROR, OK].includes(res.kind)) return { kind: ERROR, why: 'read' };
    return res.kind === OK && !valid(res.data) ? { kind: BROKEN, why: 'shape' } : res;
}
const bad = r => r.kind === BROKEN || r.kind === ERROR;

// ───────── file bodies ─────────

const RECENT = 8;
// v0.6.65: a memory's shape, its recorded range and its fingerprints agree (one per recorded message).
export const validState = s => plainObj(s) && s.v === 1 && plainObj(s.mem)
    && ['scenes', 'entities', 'records'].every(k => Array.isArray(s.mem[k]))
    && int(s.lastIndex) && s.lastIndex >= -1 && Array.isArray(s.hashes) && s.hashes.length === s.lastIndex + 1 && s.hashes.every(str)
    && (s.history === undefined || Array.isArray(s.history)) && (s.floor === undefined || int(s.floor) && s.floor >= -1);
const validFrom = f => plainObj(f) && ['migrate', 'branch', 'new'].includes(f.kind) && str(f.addr);
export const validMem = id => d => plainObj(d) && d.format === 'savepoint-mem' && d.v === 1 && d.id === id && int(d.rev) && d.rev >= 0 && str(d.wid)
    && Array.isArray(d.recent) && d.recent.every(x => plainObj(x) && int(x.rev) && str(x.wid))
    && validFrom(d.from) && plainObj(d.home) && str(d.home.addr) && optStr(d.home.integrity) && optStr(d.copy) && validState(d.state);
export const validTag = addr => d => plainObj(d) && d.format === 'savepoint-room' && d.v === 1 && d.addr === addr && str(d.mem)
    && optStr(d.integrity) && optStr(d.copy) && Array.isArray(d.prints) && d.prints.every(p => plainObj(p) && int(p.i) && p.i >= 0 && str(p.h))
    && (d.state === 'linked' || d.state === 'renamed' && str(d.to));
export const validClue = integrity => d => plainObj(d) && d.format === 'savepoint-int' && d.v === 1 && d.integrity === integrity
    && Array.isArray(d.rooms) && d.rooms.every(x => plainObj(x) && str(x.addr) && str(x.mem));
export const validMoved = (addr, copy) => d => plainObj(d) && d.format === 'savepoint-moved' && d.v === 1 && d.addr === addr && d.copy === copy && str(d.mem) && int(d.rev);
export const validStart = addr => d => plainObj(d) && d.format === 'savepoint-moving' && d.v === 1 && d.addr === addr && str(d.copy) && str(d.mem) && str(d.wid);
export const validCopyHint = copy => d => plainObj(d) && d.format === 'savepoint-copy' && d.v === 1 && d.copy === copy && Array.isArray(d.rooms) && d.rooms.every(str);

// `copy`: the old in-chat copy the chat file had when this memory was linked to the room (null: none).
export const memBody = ({ id, state, rev = 0, wid, recent = [], from, home, copy = null }) =>
    ({ format: 'savepoint-mem', v: 1, id, rev, wid, recent: [...recent, { rev, wid }].slice(-RECENT), from, home, copy, state });
export const tagBody = ({ addr, integrity = null, mem, copy = null, prints = [], at = Date.now() }) =>
    ({ format: 'savepoint-room', v: 1, addr, integrity, mem, copy, prints, state: 'linked', at });
export const renamedTag = (tag, to, at = Date.now()) => ({ ...tag, state: 'renamed', to, at });
export const clueBody = (integrity, rooms) => ({ format: 'savepoint-int', v: 1, integrity, rooms });
export const clueWith = (clue, integrity, addr, mem) => {
    const rooms = (clue?.rooms || []).filter(x => !(x.addr === addr && x.mem === mem));
    return clueBody(integrity, [...rooms, { addr, mem }]);
};
export const movedBody = ({ addr, copy, mem, rev = 0 }) => ({ format: 'savepoint-moved', v: 1, addr, copy, mem, rev });
export const startBody = ({ addr, copy, mem, wid, at = Date.now() }) => ({ format: 'savepoint-moving', v: 1, addr, copy, mem, wid, at });
export const copyHintBody = (copy, rooms) => ({ format: 'savepoint-copy', v: 1, copy, rooms });
export const copyHintWith = (hint, copy, addr) => copyHintBody(copy, [...new Set([...(hint?.rooms || []), addr])]);

// ───────── fingerprints ─────────

// A few recorded fingerprints for a name tag: the first, the last, and evenly spread ones between.
export function pickPrints(hashes, n = 5) {
    const list = Array.isArray(hashes) ? hashes : [];
    if (!list.length) return [];
    const at = new Set([0, list.length - 1]);
    for (let k = 1; at.size < Math.min(n, list.length) && k < n - 1; k++) at.add(Math.round(k * (list.length - 1) / (n - 1)));
    return [...at].sort((a, b) => a - b).map(i => ({ i, h: list[i] }));
}
// The first recorded place that differs from the chat (a message gone counts), or -1.
export function firstDiff(hashes, prints) {
    for (let i = 0; i < (hashes || []).length; i++) if (prints[i] !== hashes[i]) return i;
    return -1;
}
// Recorded fingerprints ({ i, h }) against the chat: how many there are, how many match, the first miss.
export function printCheck(recorded, prints) {
    const list = Array.isArray(recorded) ? recorded : [];
    const miss = list.filter(p => prints[p.i] !== p.h).map(p => p.i);
    return { total: list.length, matched: list.length - miss.length, first: miss.length ? Math.min(...miss) : -1 };
}

// ───────── opening a room ─────────

// What to read before deciding, apart from memory files: the room's tag; without one, the tags of
// renamed-from rooms, the integrity hint and the tags of the rooms it lists, this room's moved mark,
// the parent's tag (main_chat, following renames), and moved marks of the old copy in those rooms.
// read(name) → { kind, data } (data parsed, not checked yet).
// in: { addr, integrity, mainChat, copy: { hash, ok } | null, traces, prints, renames: [{ from, to }] }
async function gather(input, read) {
    const files = new Map(), failed = [];
    const get = async (name, valid) => {
        if (files.has(name)) return files.get(name);
        let res;
        try { res = checked(await read(name), valid); } catch { res = { kind: ERROR, why: 'read' }; }
        files.set(name, res);
        if (bad(res)) failed.push(name);
        return res;
    };
    const { addr, integrity, mainChat, copy } = input;
    const tag = await get(tagName(addr), validTag(addr));
    if (tag.kind === OK && tag.data.state === 'linked' || bad(tag)) return { files, failed };
    // No tag, or this name's tag says it was renamed away: what the rows without a tag need.
    const others = new Set();
    for (const r of input.renames || []) if (r?.to === addr && str(r.from) && r.from !== addr) { others.add(r.from); await get(tagName(r.from), validTag(r.from)); }
    if (str(integrity)) {
        const clue = await get(clueName(integrity), validClue(integrity));
        if (clue.kind === OK) for (const x of clue.data.rooms) if (x.addr !== addr) { others.add(x.addr); await get(tagName(x.addr), validTag(x.addr)); }
    }
    if (copy) await get(movedName(addr, copy.hash), validMoved(addr, copy.hash));
    await get(startName(addr), validStart(addr));
    if (copy) await get(copyName(copy.hash), validCopyHint(copy.hash));
    if (str(mainChat)) {
        let p = roomAddr(scopeOf(addr), mainChat);
        const seen = new Set([addr]);
        for (let hop = 0; hop < 5 && !seen.has(p); hop++) {
            seen.add(p); others.add(p);
            const t = await get(tagName(p), validTag(p));
            if (t.kind !== OK || t.data.state !== 'renamed') break;
            p = t.data.to;
        }
    }
    if (copy) for (const a of others) await get(movedName(a, copy.hash), validMoved(a, copy.hash));
    return { files, failed };
}

// A memory's home is this room: the same address, and its integrity (if it has one) is every one given.
// v0.6.65: also used when a tag links (row 3) and in writePlan/checkMem, not only for row 6. By row 3 the
// tag and the chat file have the same integrity (or the tag has none), so the chat file's is the one to check.
export const homeOk = (home, addr, ...ints) => home.addr === addr && (home.integrity == null || ints.filter(str).every(i => i === home.integrity) && ints.some(str));

// Decide what an opening room is. The rows are tried from the top; the first that fits is the answer.
//  0  a needed file is broken or could not be read → readFail (stop, check again later)
//  with a name tag:
//  1  integrity on both sides and different → hold
//  2  the old in-chat copy differs from the one recorded (an older SavePoint wrote it again) → hold
//  3  same room? integrity on both and equal / (no integrity, or only the tag lacks it) the copy hash is
//     the recorded one, or every recorded fingerprint matches (none recorded is no proof) / the tag has
//     integrity and the file does not → hold / not proven → hold
//  4  only once it is the same room: some fingerprints differ → link + source change
//  without a tag:
//  5  a rename seen on this device and the integrity matches → move the tag
//  6  this room's own memory file (by its id rules, the integrity hint, the moved mark or the move-start
//     mark), readable, at home here and with the same old copy → link again to it (before everything below)
//  8  the same integrity is linked to another room → hold (v0.6.65: before 7, so an imported copy of a
//     linked branch is held with that branch as the candidate instead of copying the parent's memory)
//  7  a branch (integrity differs from the parent, main_chat is a linked room in the same scope) → inherit
//  9  the old copy was already moved from another room (moved marks, or the copy hint) → hold
//  10 an old copy → move it out (migrate)
//  11 other SavePoint traces → hold
//  12 a new room (memory only once the integrity is in the chat file)
// Also: a tag that says this name was renamed away → hold (row 1), unless a rename back to it was seen
// here (row 5). The tag's memory file is read only once the room is proven (row 3): missing → hold,
// at another home (address, or an integrity the tag or the chat file disagrees with) → hold.
// v0.6.65, row 6: a found memory whose recorded old copy is not the chat's (an older SavePoint wrote it
// again), or a move-start mark for another old copy → hold; a move-start mark with nothing behind it and
// no old copy in the chat any more → hold; with the same old copy → the move is tried again (row 10). Row 0 covers the small files (tags, the hint, moved marks), all read first;
// a memory file that cannot be read stops at the row that needs it (still readFail).
// readMem(id) → { kind, data } of savepoint-mem-<id>.json; slotsOf(addr) → that room's AUTO/QUICK records.
// Nothing here writes. While holding nothing is written or deleted.
export async function decideRoom(input, read, { readMem = id => read(memName(id)), slotsOf = async () => [] } = {}) {
    const { addr, integrity = null, mainChat = null, copy = null, traces = false } = input;
    const prints = Array.isArray(input.prints) ? input.prints : [];
    const out = (verdict, row, extra = {}) => ({ verdict, row, ...extra });
    const hold = (row, why, extra = {}) => out('hold', row, { why, ...extra });
    const fail = (row, names) => out('readFail', row, { names });
    const mem = async id => { let r; try { r = checked(await readMem(id), validMem(id)); } catch { r = { kind: ERROR }; } return r; };

    const { files, failed } = await gather(input, read);
    if (failed.length) return fail(0, failed);
    const tagRes = files.get(tagName(addr));

    const renamedAway = tagRes.kind === OK && tagRes.data.state === 'renamed' ? tagRes.data : null;
    if (tagRes.kind === OK && !renamedAway) {
        const tag = tagRes.data;
        if (str(tag.integrity) && str(integrity) && tag.integrity !== integrity) return hold(1, 'integrity');
        if (copy && copy.hash !== tag.copy) return hold(2, 'copyChanged');
        let proof;
        if (str(tag.integrity) && str(integrity)) proof = 'integrity';
        else if (str(tag.integrity)) return hold(3, 'integrityGone');
        else if (copy && str(tag.copy) && copy.hash === tag.copy) proof = 'copy';
        else {
            const pc = printCheck(tag.prints, prints);
            if (pc.total >= 1 && pc.matched === pc.total) proof = 'prints';
            else return hold(3, 'unproven', { prints: pc });
        }
        const m = await mem(tag.mem);
        if (bad(m)) return fail(3, [memName(tag.mem)]);
        if (m.kind === MISSING) return hold(3, 'memGone', { mem: tag.mem });
        if (!homeOk(m.data.home, addr, integrity)) return hold(3, 'homeDiff', { mem: tag.mem });
        const at = [printCheck(tag.prints, prints).first, firstDiff(m.data.state.hashes, prints)].filter(i => i >= 0);
        const changedAt = at.length ? Math.min(...at) : -1;
        return out('link', changedAt < 0 ? 3 : 4, { proof, mem: tag.mem, changedAt, fill: !str(tag.integrity) && str(integrity) ? { integrity } : null });
    }

    // 5: renamed on this device, same integrity.
    for (const r of input.renames || []) {
        if (r?.to !== addr || !str(r.from) || r.from === addr) continue;
        const t = files.get(tagName(r.from));
        if (t?.kind !== OK) continue;
        const toHere = t.data.state === 'renamed' ? t.data.to === addr : true;
        if (!toHere || !str(t.data.integrity) || t.data.integrity !== integrity) continue;
        const m = await mem(t.data.mem);
        if (bad(m)) return fail(5, [memName(t.data.mem)]);
        if (m.kind === MISSING) return hold(5, 'memGone', { mem: t.data.mem, from: r.from });
        return out('rename', 5, { from: r.from, mem: t.data.mem });
    }
    // This name's tag says it was renamed away and no rename back to it was seen here: a room under the
    // old name again is not that room.
    if (renamedAway) return hold(1, 'renamedAway', { to: renamedAway.to });

    // 6: this room's own memory, found by name.
    const ids = [];
    if (str(integrity)) ids.push(homeId(addr, integrity));
    if (copy) ids.push(migrateId(addr, copy.hash));
    const clue = str(integrity) ? files.get(clueName(integrity)) : null;
    if (clue?.kind === OK) for (const x of clue.data.rooms) if (x.addr === addr) ids.push(x.mem);
    const movedHere = copy ? files.get(movedName(addr, copy.hash)) : null;
    if (movedHere?.kind === OK) ids.push(movedHere.data.mem);
    const start = files.get(startName(addr));
    if (start?.kind === OK) {
        if (copy && start.data.copy !== copy.hash) return hold(6, 'copyChanged', { mem: start.data.mem });
        ids.push(start.data.mem);
    }
    for (const id of [...new Set(ids)]) {
        const m = await mem(id);
        if (bad(m)) return fail(6, [memName(id)]);
        if (m.kind === MISSING) continue;
        if (!homeOk(m.data.home, addr, integrity)) return hold(6, 'homeDiff', { mem: id });
        if (copy && m.data.copy !== copy.hash) return hold(6, 'copyChanged', { mem: id });
        return out('relink', 6, { mem: id, from: m.data.from });
    }
    if (movedHere?.kind === OK) return hold(6, 'movedNoBody', { mem: movedHere.data.mem });
    if (start?.kind === OK && !copy) return hold(6, 'moveStarted', { mem: start.data.mem });

    // 8: the same integrity linked somewhere else (an imported copy, an old-style branch).
    const clueRooms = clue?.kind === OK ? clue.data.rooms : [];
    const linked = [...new Set(clueRooms.filter(x => x.addr !== addr && files.get(tagName(x.addr))?.kind === OK && files.get(tagName(x.addr)).data.state === 'linked').map(x => x.addr))];
    if (linked.length) return hold(8, 'sameIntegrity', { candidates: linked });

    // 7: a branch of a linked room.
    let parent = null;
    if (str(integrity) && str(mainChat)) {
        let p = roomAddr(scopeOf(addr), mainChat);
        for (let hop = 0; hop < 5 && p !== addr; hop++) {
            const t = files.get(tagName(p));
            if (t?.kind !== OK) break;
            if (t.data.state === 'renamed') { p = t.data.to; continue; }
            parent = { addr: p, tag: t.data };
            break;
        }
    }
    if (parent && parent.tag.integrity !== integrity) {
        const m = await mem(parent.tag.mem);
        if (bad(m)) return fail(7, [memName(parent.tag.mem)]);
        if (m.kind === MISSING) return hold(7, 'parentGone', { parent: parent.addr });
        let slots = [];
        try { slots = await slotsOf(parent.addr) || []; } catch { slots = []; }
        const r = branchRestore(m.data.state, prints, slots);
        if (!r.ok) return hold(7, 'branchUnproven', { parent: parent.addr, at: r.at, reason: r.why });
        return out('branch', 7, { parent: parent.addr, parentMem: parent.tag.mem, mem: homeId(addr, integrity), state: branchState(r.state, addr), via: r.via, at: r.at });
    }

    // 9: this old copy was already moved out of another room (the parent, a room with this integrity, a
    // rename), or the copy hint lists another room (an older chat without integrity renamed elsewhere).
    if (copy) for (const [name, res] of files) {
        if (!name.startsWith('savepoint-moved-') || res.kind !== OK || res.data.addr === addr || res.data.copy !== copy.hash) continue;
        return hold(9, 'copyMoved', { from: res.data.addr, mem: res.data.mem });
    }
    const hint = copy ? files.get(copyName(copy.hash)) : null;
    const elsewhere = hint?.kind === OK ? hint.data.rooms.filter(a => a !== addr) : [];
    if (elsewhere.length) return hold(9, 'copyMoved', { from: elsewhere[0], rooms: elsewhere });
    if (copy?.ok) return out('migrate', 10, { mem: migrateId(addr, copy.hash) });
    if (copy || traces) return hold(11, 'traces');
    if (str(integrity)) return out('new', 12, { mem: homeId(addr, integrity) });
    return out('new', 12, { mem: null, wait: true });
}

// ───────── branch ─────────

// A branch's memory, worked out on a copy of the parent's (the parent's file is never touched).
// prints: the branch's messages (fingerprints, from its chat file). slots: the parent's AUTO/QUICK records
// ({ mem, pos: { lastIndex, digest }, updated }).
// 1. the first recorded place where the branch differs; 2. undo every summary from the one covering it
// (fails below the trimmed history, `floor`); 3. every recorded fingerprint left must match the branch;
// 4. otherwise the slot whose recorded messages all match, the furthest one (then the newest); 5. none → no.
// v0.6.65: a rewind that leaves nothing recorded (the first message differs) proves nothing, the same as
// no fingerprints: a matching slot is used, otherwise no (hold; starting empty is the user's choice).
// A parent that has recorded nothing yet (a memory loaded without messages) is still carried over as it is.
export function branchRestore(parent, prints, slots = []) {
    if (!validState(parent)) return { ok: false, why: 'parent', at: -1 };
    const st = clone(parent);
    const k = firstDiff(st.hashes, prints);
    if (k < 0) return { ok: true, via: 'parent', at: -1, state: st };
    const allMatch = s => s.hashes.length === s.lastIndex + 1 && s.hashes.every((h, i) => prints[i] === h);
    let why = 'floor';
    if (rollbackFrom(st, k)) {
        st.hashes = st.hashes.slice(0, st.lastIndex + 1);
        if (st.lastIndex < 0) why = 'nothingLeft';
        else if (allMatch(st)) return { ok: true, via: 'rewind', at: k, state: st };
        else why = 'mismatch';
    }
    const fits = (Array.isArray(slots) ? slots : []).filter(s => plainObj(s?.mem) && int(s?.pos?.lastIndex) && s.pos.lastIndex >= 0
        && s.pos.lastIndex < prints.length && digest(prints.slice(0, s.pos.lastIndex + 1)) === s.pos.digest)
        .sort((a, b) => b.pos.lastIndex - a.pos.lastIndex || (b.updated || 0) - (a.updated || 0));
    if (fits.length) {
        const s = fits[0], last = s.pos.lastIndex;
        return { ok: true, via: 'slot', at: k, slot: s.id ?? null,
            state: { v: 1, mem: clone(s.mem), lastIndex: last, hashes: prints.slice(0, last + 1), history: [], floor: last, lootQueue: [] } };
    }
    return { ok: false, why, at: k };
}
// What a branch does not carry over: the rewind point, check results, the linked slot, failure records,
// the last-save note and the auto-save marks (they count the parent's messages).
export function branchState(st, addr) {
    const out = clone(st);
    for (const k of ['undo', 'undoInfo', 'check', 'review', 'autoFail', 'lastRecord', 'autoHold', 'autoAttemptAt', 'autoLast', 'wid']) delete out[k];
    out.linkedSave = null;
    out.roomKey = addr;
    out.autoMark = out.lastIndex;
    if (plainObj(out.hideManual) && int(out.hideManual.to)) out.hideManual = { ...out.hideManual, to: Math.min(out.hideManual.to, out.lastIndex) };
    return out;
}

// ───────── writing a memory file for a room ─────────

// What is left to do to put a memory file in place for a room (moved from the chat, a branch or a new room),
// for a first try and for a retry after a stop at any step. Never rewrites a memory file that exists:
//  - it exists and came from the same place → the rest only (its rev may be newer; it is left alone)
//  - it came from somewhere else, or any read failed → stop
//  - a moved mark without its memory file → hold (do not remake it from the old copy; offer a slot)
//  - (moves) a move-start mark for another old copy, or a memory that recorded another one → hold
// Steps, always in this order: writeStart → checkStart (moves only) → writeMem → checkMem (read back) →
// writeMoved → writeCopy (moves only) → writeClue → recheckStart (moves) → writeTag (last).
// in: { id, from, addr, integrity, copy (the old copy the chat has: moves, and a branch that carries one),
//       mem, moved, start, hint, clue, tag: reads ({ kind, data }) }
export function writePlan({ id, from, addr, integrity = null, copy = null, mem, moved = null, start = null, hint = null, clue = null, tag }) {
    const move = from?.kind === 'migrate';
    const reads = [['mem', mem, validMem(id)], ['tag', tag, validTag(addr)]];
    if (move) reads.push(['start', start, validStart(addr)], ['moved', moved, validMoved(addr, copy)], ['hint', hint, validCopyHint(copy)]);
    if (str(integrity)) reads.push(['clue', clue, validClue(integrity)]);
    const r = {};
    for (const [k, res, valid] of reads) {
        r[k] = checked(res, valid);
        if (bad(r[k])) return { stop: 'read', file: k };
    }
    const steps = [];
    if (move) {
        if (r.start.kind === MISSING) steps.push('writeStart', 'checkStart');
        else if (r.start.data.copy !== copy) return { hold: 'copyChanged' };
        else if (r.start.data.mem !== id) return { stop: 'startDiff' };
    }
    if (r.mem.kind === OK) {
        if (canon(r.mem.data.from) !== canon(from)) return { stop: 'otherOrigin' };
        if (!homeOk(r.mem.data.home, addr, integrity)) return { stop: 'homeDiff' };
        if ((r.mem.data.copy ?? null) !== (copy ?? null)) return { hold: 'copyChanged' };
    } else {
        if (r.moved?.kind === OK) return { hold: 'movedNoBody' };
        steps.push('writeMem', 'checkMem');
    }
    if (r.moved) {
        if (r.moved.kind === MISSING) steps.push('writeMoved');
        else if (r.moved.data.mem !== id) return { stop: 'movedDiff' };
    }
    if (r.hint && !(r.hint.kind === OK && r.hint.data.rooms.includes(addr))) steps.push('writeCopy');
    if (r.clue && !(r.clue.kind === OK && r.clue.data.rooms.some(x => x.addr === addr && x.mem === id))) steps.push('writeClue');
    if (r.tag.kind === MISSING) steps.push(...move ? ['recheckStart'] : [], 'writeTag');
    else if (r.tag.data.state !== 'linked' || r.tag.data.mem !== id) return { stop: 'tagDiff' };
    return { steps };
}

// ───────── two devices ─────────

// Write only over the file last seen: same rev and same receipt.
export const canWrite = (file, seen) => !!file && !!seen && file.rev === seen.rev && file.wid === seen.wid;
// The next body of a memory file (rev + 1, a new receipt, the recent list kept short).
export const nextMem = (file, state, wid) => memBody({ id: file.id, state, rev: file.rev + 1, wid, recent: file.recent, from: file.from, home: file.home, copy: file.copy ?? null });
// After writing, read it back: ours only when it holds our receipt.
export const wroteMine = (after, wid) => !!after && after.wid === wid;
// When a room opens: AUTO saves of this room that the memory file's recent list does not know about.
// ({ rev, wid } on each AUTO.) A hint ("may have been overwritten"), not proof either way.
export function maybeOverwritten(autos, file) {
    if (!file) return [];
    const recent = file.recent || [], low = recent.length ? Math.min(...recent.map(x => x.rev)) : file.rev;
    return (autos || []).filter(a => int(a?.rev) && str(a?.wid)).filter(a => {
        if (a.rev > file.rev) return true;
        if (a.rev < low) return false;
        return !recent.some(x => x.rev === a.rev && x.wid === a.wid);
    });
}

// ───────── putting a memory file in place, with read-backs (v0.6.65) ─────────

// After writing the move-start mark, read it back. Ours ('mine'); another device's for the same old copy
// and memory id ('same': both started the same move, go on); anything else → hold ('copyChanged' when it
// is another old copy, 'unsure' when it is gone or unreadable).
export function checkStart(res, { addr, copy, id, wid }) {
    const r = checked(res, validStart(addr));
    if (r.kind !== OK) return 'unsure';
    if (r.data.wid === wid) return 'mine';
    if (r.data.copy !== copy) return 'copyChanged';
    return r.data.mem === id ? 'same' : 'unsure';
}
// After writing the memory file, read it back. Ours ('mine'). Another device's receipt: kept as it is and
// used ('theirs') only when it reads fine, is for this room (address and integrity) and was moved from the
// same old copy (the same `from` and the same recorded copy); otherwise hold ('otherOrigin' / 'unsure').
export function checkMem(res, { id, from, addr, integrity = null, copy = null, wid }) {
    const r = checked(res, validMem(id));
    if (r.kind !== OK) return 'unsure';
    if (r.data.wid === wid) return 'mine';
    if (canon(r.data.from) !== canon(from) || !homeOk(r.data.home, addr, integrity) || (r.data.copy ?? null) !== (copy ?? null)) return 'otherOrigin';
    return 'theirs';
}

// Carry out writePlan with reads and writes given (io.read(name) → { kind, data }, io.write(name, body)).
// in: { id, from, addr, integrity, copy, state, wid }. Returns { done, mem, adopted, seen: { rev, wid } }
// (the memory file this room now uses; adopted: another device's, left as it was), { hold }, or { stop }.
// Each step that changes something is followed by the read that confirms it; nothing is retried here.
// Two devices: one that finds the other's start mark for another old copy holds. Both can still pass when
// the second writes its mark after the first checked its own (the server has no compare-and-write); the
// recheck right before the tag narrows that, and the tag is written last either way.
export async function placeMemory(io, { id, from, addr, integrity = null, copy = null, state, wid }) {
    const move = from?.kind === 'migrate';
    const rd = async name => { try { return await io.read(name); } catch { return { kind: ERROR }; } };
    const wr = async (name, body) => { try { await io.write(name, body); return true; } catch { return false; } };
    const reads = { mem: await rd(memName(id)), tag: await rd(tagName(addr)) };
    if (move) Object.assign(reads, { start: await rd(startName(addr)), moved: await rd(movedName(addr, copy)), hint: await rd(copyName(copy)) });
    if (str(integrity)) reads.clue = await rd(clueName(integrity));
    const plan = writePlan({ id, from, addr, integrity, copy, ...reads });
    if (!plan.steps) return plan;
    let body = reads.mem?.kind === OK ? reads.mem.data : null, adopted = false;
    for (const step of plan.steps) {
        if (step === 'writeStart') { if (!await wr(startName(addr), startBody({ addr, copy, mem: id, wid }))) return { stop: 'write', step }; }
        else if (step === 'checkStart' || step === 'recheckStart') {
            const v = checkStart(await rd(startName(addr)), { addr, copy, id, wid });
            if (v !== 'mine' && v !== 'same') return { hold: v, step };
        } else if (step === 'writeMem') { if (!await wr(memName(id), memBody({ id, state, wid, from, home: { addr, integrity }, copy }))) return { stop: 'write', step }; }
        else if (step === 'checkMem') {
            const back = await rd(memName(id));
            const v = checkMem(back, { id, from, addr, integrity, copy, wid });
            if (v !== 'mine' && v !== 'theirs') return { hold: v, step };
            body = back.data; adopted = v === 'theirs';
        } else if (step === 'writeMoved') { if (!await wr(movedName(addr, copy), movedBody({ addr, copy, mem: id, rev: body.rev }))) return { stop: 'write', step }; }
        else if (step === 'writeCopy') {
            const h = checked(await rd(copyName(copy)), validCopyHint(copy));
            if (bad(h)) return { stop: 'read', step };
            if (!await wr(copyName(copy), copyHintWith(h.kind === OK ? h.data : null, copy, addr))) return { stop: 'write', step };
        } else if (step === 'writeClue') {
            const c = checked(await rd(clueName(integrity)), validClue(integrity));
            if (bad(c)) return { stop: 'read', step };
            if (!await wr(clueName(integrity), clueWith(c.kind === OK ? c.data : null, integrity, addr, id))) return { stop: 'write', step };
        } else if (step === 'writeTag') {
            if (!await wr(tagName(addr), tagBody({ addr, integrity, mem: id, copy, prints: pickPrints(body.state.hashes) }))) return { stop: 'write', step };
        }
    }
    return { done: true, mem: id, adopted, seen: { rev: body.rev, wid: body.wid } };
}
