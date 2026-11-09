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

// `dup`: another message in the chat had the same date, speaker and role when it was chosen. Then the text
// fingerprint must match too, even when only one candidate is left (the chosen one may be the one deleted).
export function markOf(m, chat = []) {
    const dup = chat.some(x => x && x !== m && keyOf(x) === keyOf(m));
    return { date: m?.send_date ?? null, name: m?.name ?? '', user: !!m?.is_user, fp: fp(m?.mes), ...(dup ? { dup: true } : {}) };
}

const sameKey = (m, mark) => (m?.send_date ?? null) === mark.date && (m?.name ?? '') === mark.name && !!m?.is_user === mark.user;

// Where the marked message is now: { i } or { miss: 'gone' | 'ambiguous' }.
export function findMarked(chat, mark) {
    const hits = [];
    chat.forEach((m, i) => { if (m && sameKey(m, mark)) hits.push(i); });
    if (hits.length === 1) return !mark.dup || fp(chat[hits[0]].mes) === mark.fp ? { i: hits[0] } : { miss: 'ambiguous' };
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
        // 0.1.1: on the list side too, two candidates (another interceptor put in an item carrying the same `extra`
        // or the same date and speaker) mean no pair: nothing is removed rather than the wrong item.
        const after = test => { const js = []; for (let j = k; j < core.length; j++) if (test(core[j])) js.push(j); return js; };
        let p = -1;
        if (m.extra && typeof m.extra === 'object') {
            const js = after(c => c?.extra === m.extra);
            if (js.length > 1) { unsure.add(i); return; }
            if (js.length === 1) p = js[0];
        }
        if (p < 0) {
            if (counts.get(keyOf(m)) > 1) { unsure.add(i); return; }
            const js = after(c => keyOf(c) === keyOf(m));
            if (js.length > 1) { unsure.add(i); return; }
            if (js.length === 1) p = js[0];
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
        // 0.1.1: a hidden message SillyTavern still sends (a tool call's message, when tools are on) stays and says so.
        if (chat[i].is_system) { skipped.push({ mark, i, why: pair.has(i) ? 'tool-kept' : 'already-hidden' }); continue; }
        if (unsure.has(i)) { skipped.push({ mark, i, why: 'ambiguous' }); continue; }
        if (!pair.has(i)) { skipped.push({ mark, i, why: 'not-in-request' }); continue; }
        const p = pair.get(i);
        // 0.1.1: the message being continued is the chat's last one, wherever other interceptors left it in the list.
        if (type === 'continue' && i === chat.length - 1) { skipped.push({ mark, i, why: 'continue-target' }); continue; }
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
        if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
        if (a > b) [a, b] = [b, a];
        // 0.1.1: only numbers the chat has (a huge number no longer loops forever).
        for (let n = a, end = Math.min(b, max - 1); n <= end; n++) out.add(n);
    }
    return [...out].sort((a, b) => a - b);
}
