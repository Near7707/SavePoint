// Pure rules for the hide experiment. No SillyTavern access here, so Node tests can run them.
//
// A mark names a message without its position: send date, speaker, user flag and a text fingerprint.
// Positions move when messages are deleted; the date and speaker do not.
//
// SillyTavern hands interceptors its own request list ("core"): hidden (`is_system`) messages are
// already gone, a swipe drops the last item, and every item is a shallow copy with rewritten text
// and its own `index` (position in the list, not in the chat). Other interceptors may add items.
// So a chat position never equals a list position; we pair them in order instead.

export function fp(text) {
    let h = 0x811c9dc5;
    const s = String(text ?? '').trim();
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

export function keyOf(m) { return [m?.send_date ?? '', m?.name ?? '', m?.is_user ? 1 : 0].join('\u0001'); }

export function markOf(m) { return { date: m?.send_date ?? null, name: m?.name ?? '', user: !!m?.is_user, fp: fp(m?.mes) }; }

const sameKey = (m, mark) => (m?.send_date ?? null) === mark.date && (m?.name ?? '') === mark.name && !!m?.is_user === mark.user;

// Where the marked message is now: { i } or { miss: 'gone' | 'ambiguous' }.
export function findMarked(chat, mark) {
    const hits = [];
    chat.forEach((m, i) => { if (m && sameKey(m, mark)) hits.push(i); });
    if (hits.length === 1) return { i: hits[0] };
    if (!hits.length) return { miss: 'gone' };
    const exact = hits.filter(i => fp(chat[i].mes) === mark.fp);
    return exact.length === 1 ? { i: exact[0] } : { miss: 'ambiguous' };
}

// chat position -> list position, walking both in order. A shared `extra` object is proof
// (SillyTavern spreads messages, so the reference survives); otherwise the key must be unique
// in the chat. Items another extension added match nothing and are stepped over.
export function pairCore(chat, core) {
    const counts = new Map();
    chat.forEach(m => { if (m) counts.set(keyOf(m), (counts.get(keyOf(m)) ?? 0) + 1); });
    const pair = new Map(), unsure = new Set();
    let k = 0;
    chat.forEach((m, i) => {
        if (!m) return;
        let p = -1;
        if (m.extra && typeof m.extra === 'object') {
            for (let j = k; j < core.length; j++) if (core[j]?.extra === m.extra) { p = j; break; }
        }
        if (p < 0) {
            if (counts.get(keyOf(m)) > 1) { unsure.add(i); return; }
            for (let j = k; j < core.length; j++) if (keyOf(core[j]) === keyOf(m)) { p = j; break; }
        }
        if (p >= 0) { pair.set(i, p); k = p + 1; }
    });
    return { pair, unsure };
}

// Which list items to drop for the marks, and why the others stay.
export function planRemoval(chat, core, marks, type) {
    const { pair, unsure } = pairCore(chat, core);
    const remove = [], removed = [], skipped = [];
    const seen = new Set();
    for (const mark of marks) {
        const at = findMarked(chat, mark);
        if (at.miss) { skipped.push({ mark, why: at.miss }); continue; }
        const i = at.i;
        if (seen.has(i)) continue;
        seen.add(i);
        if (chat[i].is_system) { skipped.push({ mark, i, why: 'already-hidden' }); continue; }
        if (unsure.has(i)) { skipped.push({ mark, i, why: 'ambiguous' }); continue; }
        if (!pair.has(i)) { skipped.push({ mark, i, why: 'not-in-request' }); continue; }
        const p = pair.get(i);
        if (type === 'continue' && p === core.length - 1) { skipped.push({ mark, i, why: 'continue-target' }); continue; }
        remove.push(p);
        removed.push({ mark, i });
    }
    return { remove: remove.sort((a, b) => b - a), removed: removed.sort((a, b) => a.i - b.i), skipped };
}

// Drop in place: SillyTavern keeps using the same array after the interceptor returns.
export function applyRemoval(core, remove) {
    for (const p of [...remove].sort((a, b) => b - a)) core.splice(p, 1);
    return core;
}

// "2-5, 8" -> [2, 3, 4, 5, 8]
export function parseIds(text, max) {
    const out = new Set();
    for (const part of String(text ?? '').split(/[,\s]+/).filter(Boolean)) {
        const r = part.match(/^#?(\d+)(?:-#?(\d+))?$/);
        if (!r) return null;
        let a = Number(r[1]), b = r[2] === undefined ? a : Number(r[2]);
        if (a > b) [a, b] = [b, a];
        if (b - a > 2000) return null;
        for (let n = a; n <= b; n++) if (n < max) out.add(n);
    }
    return [...out].sort((a, b) => a - b);
}
