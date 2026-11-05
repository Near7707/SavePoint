// v0.6.58: comparing the open chat with the chat file on the server, before and after SavePoint writes it.
//
// SillyTavern writes the whole chat (messages and chat metadata) on every save, so a write from a
// screen that does not hold everything the file holds loses the rest. Before writing, the file must be
// "covered" by the page: every message in the file is on the page with the same content, and every
// metadata key in the file has the same value on the page. The page may have more (messages not saved
// yet). SavePoint's own parts are left out of that comparison: its memory (chat metadata `module`),
// its marks on messages and swipes (`own` keys in `extra`), and `is_system` (the hide state).
// After writing, the file is read again and compared with what was written.
//
// Messages and metadata values are compared as hashes of a canonical JSON (keys sorted, as JSON would
// keep them), so a long chat is not held twice in memory.

export function hashString(text) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        const n = text.charCodeAt(i);
        a = Math.imul(a ^ n, 16777619);
        b = Math.imul(b, 33) ^ n;
    }
    return `${text.length}:${a >>> 0}:${b >>> 0}`;
}
// JSON with object keys in a fixed order; values JSON would drop (undefined, functions) are dropped.
export function canon(v) {
    if (v === null || typeof v !== 'object') { const s = JSON.stringify(v); return s === undefined ? 'null' : s; }
    if (typeof v.toJSON === 'function') return canon(v.toJSON());
    if (Array.isArray(v)) return '[' + v.map(x => x === undefined || typeof x === 'function' ? 'null' : canon(x)).join(',') + ']';
    const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function').sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
const hashOf = v => hashString(canon(v));
// A message without SavePoint's parts.
function plain(m, own) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return m;
    const out = { ...m };
    delete out.is_system;
    const strip = x => {
        if (!x || typeof x !== 'object' || Array.isArray(x)) return x;
        const e = { ...x };
        for (const k of own) delete e[k];
        return Object.keys(e).length ? e : undefined;
    };
    out.extra = strip(out.extra);
    if (out.extra === undefined) delete out.extra;
    if (Array.isArray(out.swipe_info)) out.swipe_info = out.swipe_info.map(s => {
        if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
        const c = { ...s }; c.extra = strip(c.extra);
        if (c.extra === undefined) delete c.extra;
        return c;
    });
    return out;
}
// What the comparisons need from a chat: per message a full hash and a hash without SavePoint's parts,
// and per metadata key a hash (null meta: the file has no metadata header).
export function snapshot(meta, messages, own) {
    const list = Array.isArray(messages) ? messages : [];
    return {
        full: list.map(hashOf),
        plain: list.map(m => hashOf(plain(m, own))),
        meta: meta && typeof meta === 'object' ? Object.fromEntries(Object.keys(meta).filter(k => meta[k] !== undefined).map(k => [k, hashOf(meta[k])])) : null,
    };
}
// The chat file as /api/chats/get returns it: a header line with chat_metadata, then the messages.
// null: nothing usable came back (a missing file and a failed read look the same here).
export function splitFile(data) {
    if (!Array.isArray(data) || !data.length) return null;
    const head = data[0] && typeof data[0] === 'object' && !Array.isArray(data[0]) && 'chat_metadata' in data[0] ? data[0] : null;
    if (head && (!head.chat_metadata || typeof head.chat_metadata !== 'object')) return null;
    return { meta: head ? head.chat_metadata : null, messages: head ? data.slice(1) : data };
}
// Does the page hold everything the file holds (SavePoint's parts aside)?
// { ok } or { ok: false, why: 'more' (the file has more messages) | 'diff' (a message differs) | 'meta', at }.
export function covers(page, file, module) {
    if (file.plain.length > page.plain.length) return { ok: false, why: 'more', at: page.plain.length };
    for (let i = 0; i < file.plain.length; i++) if (file.plain[i] !== page.plain[i]) return { ok: false, why: 'diff', at: i };
    if (file.meta) for (const k of Object.keys(file.meta)) {
        if (k === module) continue;
        if (!page.meta || page.meta[k] !== file.meta[k]) return { ok: false, why: 'meta', at: k };
    }
    return { ok: true };
}
// After a write: 'ok' (the file has what was written: the same memory and the same messages, more may
// have been saved after them), 'failed' (the file is exactly as it was before the write), or 'unsure'.
export function writeResult(written, before, after, module) {
    const sameMod = (a, b) => (a.meta?.[module] ?? null) === (b.meta?.[module] ?? null);
    // A file without a metadata header (older group chats) keeps the memory elsewhere: only the messages are checked.
    if ((after.meta === null || sameMod(after, written)) && after.full.length >= written.full.length && written.full.every((h, i) => after.full[i] === h)) return 'ok';
    if (before && sameMod(after, before) && after.full.length === before.full.length && before.full.every((h, i) => after.full[i] === h)
        && JSON.stringify(after.meta) === JSON.stringify(before.meta)) return 'failed';
    return 'unsure';
}
// Two snapshots of the same page, everything included (for "did the room change while we asked?").
export function samePage(a, b, module) {
    if (a.full.length !== b.full.length || a.full.some((h, i) => b.full[i] !== h)) return false;
    const keys = new Set([...Object.keys(a.meta || {}), ...Object.keys(b.meta || {})]);
    for (const k of keys) if (k !== module && (a.meta || {})[k] !== (b.meta || {})[k]) return false;
    return true;
}
