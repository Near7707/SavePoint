// SavePoint memory file writes (v0.7.0-a). Made ready here; index.js does not use it yet (v0.7.0-b switches the
// memory over to these files). Plan: docs/PLAN-v0.7.md, "두 기기" and pass marks 10–11.
//
// One write of a room's memory file (user/files/savepoint-mem-<id>.json):
// 1. Nothing is sent while a write of this room got no answer (`line.pending`): that request may still land at any
//    time, and a newer write sent now could be overwritten by it (pass mark 11 ①). The room's memory writes stay
//    stopped until the room is opened again (a new line). Pass mark 10: no answer = not finished.
// 2. The file is read first. It must be exactly the one last seen on this line: the same rev and the same receipt
//    (wid), or "no file" when none was seen. Anything else (another device wrote, the file is gone) → nothing is
//    written and the line stops ('conflict'). A file that cannot be read (error, broken) → nothing is written.
// 3. The next body is made from the file just read (rev + 1, a new receipt) and sent.
//    - Refused before anything was written (a 4xx other than 408) → 'refused': the caller may take its change back.
//    - No answer (the connection dropped, a timeout, a gateway's 408/5xx, a 200 that is not SillyTavern's answer)
//      → 'pending': may still land; the line stops.
// 4. Read back: our receipt → 'ok' (this becomes what the line last saw). Another receipt → 'overwritten' (another
//    device wrote right after us; the line stops). Unreadable → 'unread': the server said it was written, so it is
//    taken as seen, and the next write's first read checks it again.
// What this does not cover (README, known limits): another device writing between our read and our write (the
// server has no compare-and-write); a late request found only after the room was opened again (pass mark 11 ②).

import { MISSING, OK, checked, readUserFile, canWrite, wroteMine } from './home.js';

export const MEM_OK = 'ok', REFUSED = 'refused', PENDING = 'pending', CONFLICT = 'conflict', OVERWRITTEN = 'overwritten', UNREAD = 'unread', READ_ERROR = 'error';

// A room's line of memory writes on this page. `seen`: { rev, wid } of the file last seen, { missing: true } when
// the server said there is none, null before the first read. `pending`: the request that got no answer.
// `stop`: why this line writes nothing more (conflict, overwritten, pending).
export function memLine(seen = null) { return { seen, pending: null, stop: null, busy: false }; }
// What a read tells the line it saw (open the room: the file as it is then).
export function seenOf(res) {
    if (res?.kind === MISSING) return { missing: true };
    if (res?.kind === OK && res.data) return { rev: res.data.rev, wid: res.data.wid };
    return null;
}
const sameSeen = (res, seen) => !!seen && (seen.missing ? res.kind === MISSING : res.kind === OK && canWrite(res.data, seen));

// The upload's answer: 'ok' only for SillyTavern's own success ({ path }); a refusal only when the server answered
// that it did not take the request (4xx but 408); everything else may still be on its way into the file.
export function classifyUpload(status, body) {
    if (status >= 200 && status <= 299) return body && typeof body === 'object' && typeof body.path === 'string' ? MEM_OK : PENDING;
    if (status >= 400 && status <= 499 && status !== 408) return REFUSED;
    return PENDING;
}
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
// io for the real server. `timeout`: a request with no answer by then is given up on (it may still land).
export function serverMemIO(fetchFn, headers = () => ({}), { timeout = 30000 } = {}) {
    return {
        read: (name, valid) => readUserFile(fetchFn, name, { headers: headers(), valid }),
        async upload(name, text) {
            const ac = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = ac ? setTimeout(() => ac.abort(), timeout) : null;
            try {
                const r = await fetchFn('/api/files/upload', { method: 'POST', headers: headers(), body: JSON.stringify({ name, data: toBase64(text) }), signal: ac?.signal });
                let body = null;
                try { body = await r.json(); } catch { /* not json */ }
                return { kind: classifyUpload(r.status, body), status: r.status };
            } catch { return { kind: PENDING, status: 0 }; }
            finally { if (timer) clearTimeout(timer); }
        },
    };
}

// Writes `make(file)` (the body to write, given the file read now: its data, or null when there is none) over the
// room's memory file. `valid`: the shape check for this file (home.js validMem(id)).
// Returns { status, body? }. Only 'ok' and 'unread' wrote; 'pending' and 'overwritten' may have; the rest did not.
export async function writeMem(io, line, { name, valid, make }) {
    if (line.pending) return { status: PENDING };
    if (line.stop) return { status: line.stop };
    if (line.busy) throw new Error('memory writes of one room run one at a time (the room queue)');
    line.busy = true;
    try {
        let pre;
        try { pre = checked(await io.read(name, valid), valid); } catch { pre = { kind: READ_ERROR }; }
        if (pre.kind !== OK && pre.kind !== MISSING) return { status: READ_ERROR };
        if (!sameSeen(pre, line.seen)) { line.stop = CONFLICT; return { status: CONFLICT }; }
        const body = make(pre.kind === OK ? pre.data : null);
        if (!body || !valid(body)) throw new Error('memory body does not pass its own check');
        let up;
        try { up = await io.upload(name, JSON.stringify(body)); } catch { up = { kind: PENDING }; }
        if (up?.kind === REFUSED) return { status: REFUSED };
        if (up?.kind !== MEM_OK) {
            line.pending = { rev: body.rev, wid: body.wid, at: Date.now() };
            line.stop = PENDING;
            return { status: PENDING, body };
        }
        let post;
        try { post = checked(await io.read(name, valid), valid); } catch { post = { kind: READ_ERROR }; }
        if (post.kind === OK && wroteMine(post.data, body.wid)) { line.seen = { rev: body.rev, wid: body.wid }; return { status: MEM_OK, body }; }
        if (post.kind === OK || post.kind === MISSING) { line.stop = OVERWRITTEN; return { status: OVERWRITTEN, body }; }
        line.seen = { rev: body.rev, wid: body.wid };
        return { status: UNREAD, body };
    } finally { line.busy = false; }
}
