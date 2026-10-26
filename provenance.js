// Numeric evidence always belongs to the active chat. Imported numbers live
// separately with their source, and can never be used to index the active chat.
const clone = v => structuredClone(v);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const ref = n => Number.isInteger(n) && n >= 0 || typeof n === 'string' && /^g\d+$/.test(n);
const room = value => typeof value === 'string' && value.trim() ? value : null;
const num = value => Number.isInteger(value) && value >= 0 ? value : null;
export function cleanPrior(value) {
    return (Array.isArray(value) ? value : []).filter(plain).map(x => ({ room: room(x.room), msgs: [...new Set((Array.isArray(x.msgs) ? x.msgs : []).filter(ref))] })).filter(x => x.msgs.length);
}
export function cleanSource(value) {
    if (!plain(value)) return null;
    if (Object.hasOwn(value, 'msg')) return { room: room(value.room), msg: num(value.msg) };
    return { room: room(value.room), from: num(value.from), to: num(value.to) };
}
function archive(item, sourceRoom, segments = new Map()) {
    const msgs = (item.msgs || []).filter(ref);
    if (msgs.length) {
        item.oldEvidence ||= [];
        for (const value of msgs) {
            const g = segments.get(value);
            const owner = g?.source ? g.source.room : sourceRoom;
            const existing = item.oldEvidence.find(x => x.room === owner);
            if (existing) existing.msgs = [...new Set([...existing.msgs, value])];
            else item.oldEvidence.push({ room: owner, msgs: [value] });
        }
    }
    item.msgs = [];
}
function archiveSegment(g, sourceRoom, segments) {
    g.source ||= { room: sourceRoom, from: num(g.from), to: num(g.to) };
    g.external = true;
    for (const p of g.points) archive(p, sourceRoom, segments);
    g.from = null; g.to = null;
}
function archiveTerms(r, sourceRoom) {
    if (r.terms && !r.terms.source) {
        r.terms.source = { room: sourceRoom, msg: num(r.terms.msg) };
        r.terms.msg = null;
    }
}

// Old releases had only a scene-wide external flag. If a legacy record mixed
// old/new numbers, their provenance cannot be recovered: quarantine them as
// unknown rather than guessing. Record markers protect later local updates.
export function upgradeEvidence(mem) {
    if (mem.evidenceVersion === 1) return mem;
    const out = clone(mem), external = new Set();
    const segments = new Map(out.scenes.flatMap(s => s.segs.map(g => [g.id, g])));
    for (const s of out.scenes) {
        for (const g of s.segs) {
            if (g.external || g.source || s.external) {
                if (!g.external || !g.source) archiveSegment(g, null, segments);
                external.add(g.id);
            }
        }
        if (s.segs.every(g => g.external)) s.external = true;
        else delete s.external;
    }
    for (const r of out.records) {
        if (r.evidenceVersion !== 1 && ((r.src || []).some(id => external.has(id) || !segments.has(id)) || (!(r.src || []).length && external.size))) {
            archive(r, null, segments); archiveTerms(r, null);
        }
        r.evidenceVersion = 1;
    }
    out.evidenceVersion = 1;
    return out;
}

export function detachEvidence(mem, sourceRoom = null) {
    const out = clone(upgradeEvidence(mem)), source = room(sourceRoom);
    const segments = new Map(out.scenes.flatMap(s => s.segs.map(g => [g.id, g])));
    for (const s of out.scenes) {
        for (const g of s.segs) if (!g.external) archiveSegment(g, source, segments);
        s.external = true;
        // Moving a chat is not a story event. Keep the open scene open.
    }
    for (const r of out.records) {
        archive(r, source, segments); archiveTerms(r, source); r.evidenceVersion = 1;
    }
    return out;
}

export function segmentPrior(g) {
    if (!g.external && !g.source) return [];
    const s = g.source || { room: null, from: g.from, to: g.to };
    return [{ room: s.room, msgs: [s.from, s.to].filter(n => Number.isInteger(n) && n >= 0) }];
}

// Resolve segment references without ever reinterpreting an imported number.
export function evidenceNumbers(mem, refs) {
    const segments = new Map(mem.scenes.flatMap(s => s.segs.map(g => [g.id, g])));
    const messages = new Set(), external = [];
    for (const value of refs || []) {
        if (Number.isInteger(value) && value >= 0) { messages.add(value); continue; }
        const g = segments.get(value);
        if (!g) continue;
        if (g.external || g.source) { external.push(...segmentPrior(g)); continue; }
        // Stored segment ranges are expanded by the caller against the chat.
        for (const p of g.points) for (const n of p.msgs || []) if (Number.isInteger(n) && n >= 0) messages.add(n);
    }
    return { messages: [...messages].sort((a, b) => a - b), external };
}
