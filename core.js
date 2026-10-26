import { cleanLootSources, restoreLostLoot } from './loot.js';
import { upgradeEvidence, detachEvidence, cleanPrior, cleanSource } from './provenance.js';
// SavePoint core: pure data logic (no SillyTavern, no DOM).
// Memory = scenes (journal) + entities (who/what) + records (current state).

export const RECORD_TYPES = ['party', 'item', 'quest', 'world'];
export const ENTITY_TYPES = ['person', 'item', 'place'];
export const ASPECTS = ['relation', 'condition'];
export const QUEST_KINDS = ['promise', 'goal', 'debt', 'mystery'];
export const QUEST_STATUS = ['open', 'done', 'failed'];
export const WORLD_KINDS = ['place', 'rule', 'name', 'secret'];
export const HISTORY_BYTES = 3 * 1024 * 1024;

const clone = v => structuredClone(v);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v.trim() : '');
const strList = v => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const uniq = list => [...new Set(list)];

export function emptyMem() {
    return { evidenceVersion: 1, scenes: [], entities: [], records: [], next: { s: 1, g: 1, e: 1, r: 1 } };
}
function takeId(mem, k) {
    const n = mem.next[k] || 1;
    mem.next[k] = n + 1;
    return k + n;
}

// ───────── tokens & language ─────────

export function estTokens(text) {
    const s = String(text || '');
    let ascii = 0, other = 0;
    for (let i = 0; i < s.length; i++) (s.charCodeAt(i) < 128 ? ascii++ : other++);
    return Math.ceil(ascii / 3.6 + other * 0.9);
}
const NON_LATIN = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯]/;
export function mostlyNonEnglish(value) {
    const tokens = String(value || '').split(/\s+/).filter(Boolean);
    let other = 0, latin = 0;
    for (const t of tokens) {
        if (NON_LATIN.test(t)) other++;
        else if (/[A-Za-z]{2,}/.test(t)) latin++;
    }
    if (!other) return false;
    if (!latin) return true;
    return other >= 3 && latin < other * 1.5;
}

// ───────── entities ─────────

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
export function entityTerms(e) {
    const terms = [e.name, ...(e.aliases || [])].map(norm);
    // Objects and places are often referred to by their head noun ("the compass" for "brass compass").
    if (e.type === 'item' || e.type === 'place') {
        const head = norm(String(e.name).replace(/\([^)]*\)/g, ' ')).split(/[^a-z]+/).filter(Boolean).pop();
        if (head && head.length >= 5) terms.push(head);
    }
    return uniq(terms.filter(t => t.length >= (NON_LATIN.test(t) ? 1 : 2)));
}
export function findEntity(mem, nameOrId) {
    const key = norm(nameOrId);
    if (!key) return null;
    return mem.entities.find(e => e.id === nameOrId) ||
        mem.entities.find(e => norm(e.name) === key) ||
        mem.entities.find(e => (e.aliases || []).some(a => norm(a) === key)) || null;
}
function termIn(text, term) {
    if (!term) return false;
    if (NON_LATIN.test(term)) return term.length >= 2 && text.includes(term);
    if (term.length < 3) return false;
    const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(e?s)?([^a-z0-9]|$)`);
    return re.test(text);
}
// Entities named in a piece of text, with the term that matched.
export function mentionedEntities(mem, text) {
    const t = norm(text);
    const found = new Map();
    if (!t) return found;
    for (const e of mem.entities) {
        const hit = entityTerms(e).find(term => termIn(t, term));
        if (hit) found.set(e.id, hit);
    }
    return found;
}
export function entityName(mem, id) {
    return mem.entities.find(e => e.id === id)?.name || id || '';
}

// ───────── message chunks ─────────

// messages: [{ index, name, text }] (already filtered). Each chunk stays under limit chars when possible.
export function chunkMessages(messages, limit) {
    const chunks = [];
    let cur = null;
    for (const m of messages) {
        const line = `#${m.index} ${m.name}: ${m.text}`;
        if (cur && cur.size + line.length + 2 > limit) { chunks.push(cur); cur = null; }
        if (!cur) cur = { from: m.index, to: m.index, lines: [], indices: [], size: 0, texts: {} };
        cur.lines.push(line); cur.indices.push(m.index); cur.to = m.index; cur.size += line.length + 2;
        cur.texts[m.index] = String(m.text ?? '');
    }
    if (cur) chunks.push(cur);
    return chunks.map(c => ({ from: c.from, to: c.to, indices: c.indices, text: c.lines.join('\n\n'), texts: c.texts }));
}

// ───────── points: stored vs injected ─────────
// Every point is stored. Only "key" points are injected with their scene: important results,
// unresolved matters or recall cues that the outline and the current state do not already carry.
// key = the AI's choice, keyUser = the user's own choice (always wins). Old points without
// either are injected as before.
export const pointId = (g, j) => `${g.id}.${j}`;
// A scene's outline is the outlines of its parts in order; nothing written earlier is rewritten.
export const sceneOutlineParts = s => s.segs.map(g => g.outline).filter(Boolean);
export const sceneOutlineText = s => sceneOutlineParts(s).join(' ') || s.title;
export const pointInjected = p => p.pin === true || (p.keyUser ?? p.key ?? true);
export const pointSymbol = p => p.pin === true ? '📌' : pointInjected(p) ? '●' : '○';
// The open scene's points shown to the AI (newest first within limits); the AI re-judges these.
export function openPoints(open, { maxCount = 60, maxChars = 8000 } = {}) {
    if (!open) return { shown: [], hidden: 0 };
    const all = open.segs.flatMap(g => g.points.map((p, j) => ({ id: pointId(g, j), p })));
    const tail = all.slice(-maxCount), shown = [];
    let size = 0;
    for (let i = tail.length - 1; i >= 0; i--) {
        const len = tail[i].id.length + tail[i].p.text.length + 3;
        if (size + len > maxChars) break;
        shown.unshift(tail[i]); size += len;
    }
    return { shown, hidden: all.length - shown.length };
}
export function findPointById(scene, id) {
    const [gid, j] = String(id).split('.');
    const g = scene.segs.find(x => x.id === gid);
    return g && /^\d+$/.test(j || '') ? g.points[Number(j)] || null : null;
}

// ───────── prompt context ─────────

export function openScene(mem) {
    const last = mem.scenes[mem.scenes.length - 1];
    return last && last.status === 'open' ? last : null;
}
function recordLine(mem, r, withId = true) {
    const id = withId ? `${r.id} ` : '';
    const en = x => entityName(mem, x);
    if (r.type === 'party') return `${id}[${r.aspect}] ${en(r.entity)}: ${r.text}`;
    if (r.type === 'item') return `${id}[item] ${en(r.entity)}${r.holder ? ` (held by ${en(r.holder)})` : ''}: ${r.text}`;
    if (r.type === 'quest') return `${id}[${r.kind}${r.status !== 'open' ? ', ' + r.status : ''}] ${r.text}${r.who?.length ? ` (${r.who.map(en).join(', ')})` : ''}`;
    return `${id}[${r.kind}] ${r.text}${r.knownBy?.length ? ` (known by ${r.knownBy.map(en).join(', ')})` : ''}`;
}
export { recordLine };
function recordEntities(r) {
    return [r.entity, r.holder, ...(r.who || []), ...(r.knownBy || [])].filter(Boolean);
}
function capLines(lines, maxChars) {
    const out = [];
    let size = 0;
    for (const l of lines) {
        if (size + l.length + 1 > maxChars) { out.push(`(… ${lines.length - out.length} more not shown)`); break; }
        out.push(l); size += l.length + 1;
    }
    return out;
}
// Context sent with each extraction: only what this chunk can touch, with a size cap.
export function promptContext(mem, chunkText, { stateChars = 12000, entityChars = 6000 } = {}) {
    const open = openScene(mem);
    const relevant = new Set(mentionedEntities(mem, chunkText).keys());
    for (const id of open?.who || []) relevant.add(id);
    const quests = mem.records.filter(r => r.type === 'quest' && r.status === 'open');
    for (const q of quests) for (const id of recordEntities(q)) relevant.add(id);
    const entities = [...mem.entities].sort((a, b) => (relevant.has(b.id) ? 1 : 0) - (relevant.has(a.id) ? 1 : 0));
    const entityLines = entities.map(e => `${e.id} ${e.type}: ${e.name}${e.aliases?.length ? ` (also: ${e.aliases.join(', ')})` : ''}`);
    const touches = r => recordEntities(r).some(id => relevant.has(id));
    const order = [
        ...quests,
        ...mem.records.filter(r => r.type !== 'quest' && touches(r)),
        ...mem.records.filter(r => r.type === 'world' && (r.kind === 'rule' || r.kind === 'secret') && !touches(r)),
        ...mem.records.filter(r => r.type !== 'quest' && !touches(r) && !(r.type === 'world' && (r.kind === 'rule' || r.kind === 'secret'))),
    ];
    const stateLines = uniq(order).map(r => recordLine(mem, r));
    let openText = '(none)';
    if (open) {
        const { shown, hidden } = openPoints(open);
        openText = [`${open.id} "${open.title}"${open.where ? ` @ ${open.where}` : ''}`, `Outline so far: ${sceneOutlineText(open)}`,
            'Points recorded so far (id: text):', ...(hidden ? [`(${hidden} earlier points not shown)`] : []),
            ...shown.map(x => `${x.id}: ${x.p.text}`)].join('\n');
    }
    const recent = mem.scenes.filter(s => s !== open).slice(-4)
        .map(s => `${s.id} "${s.title}"${s.where ? ` @ ${s.where}` : ''}: ${sceneOutlineText(s)}`);
    return {
        entities: entityLines.length ? capLines(entityLines, entityChars).join('\n') : '(none yet)',
        state: stateLines.length ? capLines(stateLines, stateChars).join('\n') : '(empty)',
        open: openText,
        recent: recent.length ? recent.join('\n') : '(none)',
    };
}


// ───────── terms of debts and promises ─────────
// A debt or promise carries the original words that set its terms. Code checks that the words
// are really in the cited message and keeps the sentences around them, so a quote of half a
// rule ("The one who loses washes the dishes.") always travels with the other half ("The one who wins dries them.").
// Terms are evidence for checking only; they are never injected.
export const TERMS_KINDS = ['debt', 'promise'];
const QUOTE_DROP = /[*_~`"'“”‘’«»「」『』]/;
// Normalized text plus a map from each normalized character back to the original position.
function normMap(text) {
    let out = '', map = [], space = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (QUOTE_DROP.test(ch)) continue;
        if (/\s/.test(ch)) { if (out && !space) { out += ' '; map.push(i); } space = true; continue; }
        space = false; out += ch.toLowerCase(); map.push(i);
    }
    if (out.endsWith(' ')) { out = out.slice(0, -1); map.pop(); }
    return { out, map };
}
export const normQuote = q => normMap(String(q || '')).out.trim();
// Where the quote is in the message, as original positions, or null.
export function findQuote(text, quote) {
    const q = normQuote(quote).replace(/[.!?…]+$/, '');
    if (q.length < 6) return null;
    const { out, map } = normMap(String(text || ''));
    const at = out.indexOf(q);
    if (at < 0) return null;
    return { start: map[at], end: map[at + q.length - 1] + 1 };
}
// The quoted passage with `around` sentences before and after it, from the original text.
export function termsContext(text, start, end, around = 2, max = 900) {
    text = String(text || '');
    const cuts = [0];
    const re = /[.!?…]+["'”’*)\]]*\s+|\n+/g;
    let m;
    while ((m = re.exec(text))) cuts.push(m.index + m[0].length);
    if (cuts[cuts.length - 1] !== text.length) cuts.push(text.length);
    const sentOf = pos => { let k = 0; while (k + 1 < cuts.length - 1 && cuts[k + 1] <= pos) k++; return k; };
    const a = Math.max(0, sentOf(start) - around), b = Math.min(cuts.length - 2, sentOf(Math.max(start, end - 1)) + around);
    let from = cuts[a], to = cuts[b + 1];
    if (to - from > max) { from = Math.max(from, start - Math.floor((max - (end - start)) / 2)); to = Math.min(to, from + max); }
    return text.slice(from, to).replace(/\s+/g, ' ').trim();
}
function termsOf(c, chunk) {
    const t = plain(c.terms) ? c.terms : null;
    if (!t) return null;
    const msg = typeof t.msg === 'string' ? Number(t.msg.replace('#', '')) : t.msg;
    const text = chunk.texts?.[msg];
    const at = text !== undefined ? findQuote(text, t.quote) : null;
    if (!at) return null;
    return { msg, quote: text.slice(at.start, at.end).replace(/\s+/g, ' ').trim(), context: termsContext(text, at.start, at.end) };
}

// ───────── result validation ─────────

const isSegRef = v => typeof v === 'string' && /^g\d+$/.test(v.trim());
// Mistakes fixed in code before validation. Each returns a note; nothing is guessed.
// 1. "continue" on the first scene when there is no open scene at all can only mean "new".
//    Later scenes are not touched.
// 2. A bare name used where an id belongs ("Theo" instead of "e1") is replaced when the name or an
//    alias matches exactly ONE entity, known or declared in this reply. Two or more matches stay
//    an error (one word can name a kite and a lane).
// 3. A point citing messages outside its own scene keeps only the ones inside it; a point with
//    none inside is left for validation to reject.
export function normalizeResult(data, { mem, chunk } = {}) {
    const notes = [];
    if (!plain(data)) return notes;
    const scenes = Array.isArray(data.scenes) ? data.scenes : [];
    if (!openScene(mem) && plain(scenes[0]) && scenes[0].scene === 'continue') {
        scenes[0].scene = 'new';
        notes.push('scenes[0]: "continue" with no open scene was read as "new".');
    }
    // A later scene marked "continue" can only mean "the scene just before goes on": merge it into
    // that scene (points and notes appended, outlines joined). No boundary is invented and nothing is lost.
    for (let i = 1; i < scenes.length; i++) {
        const cur = scenes[i], prev = scenes[i - 1];
        if (!plain(cur) || cur.scene !== 'continue' || !plain(prev)) continue;
        const join = (a, b) => [str(a), str(b)].filter(Boolean).join(' ');
        if (Array.isArray(prev.points) && Array.isArray(cur.points)) prev.points = [...prev.points, ...cur.points];
        else if (Array.isArray(cur.points)) prev.points = cur.points;
        prev.outline = join(prev.outline, cur.outline);
        if (typeof prev.notes === 'string' || typeof cur.notes === 'string') prev.notes = join(prev.notes, cur.notes);
        if (Array.isArray(cur.who)) prev.who = [...new Set([...(Array.isArray(prev.who) ? prev.who : []), ...cur.who])];
        if (!str(prev.where) && str(cur.where)) prev.where = cur.where;
        if (typeof cur.ended === 'boolean') prev.ended = cur.ended;
        if (cur.star === true) prev.star = true;
        scenes.splice(i, 1);
        notes.push(`merged:${i + 1}>${i}`);
        i--;
    }
    // Names -> ids
    const declared = (Array.isArray(data.entities) ? data.entities : []).filter(e => plain(e) && str(e.ref) && !str(e.id));
    const isRef = v => typeof v === 'string' && (declared.some(e => str(e.ref) === v.trim()) || mem.entities.some(x => x.id === v.trim()));
    const byName = new Map();
    const addName = (n, target) => { const k = norm(n); if (!k) return; if (!byName.has(k)) byName.set(k, new Set()); byName.get(k).add(target); };
    for (const x of mem.entities) { addName(x.name, x.id); (x.aliases || []).forEach(a => addName(a, x.id)); }
    for (const e of declared) { addName(e.name, str(e.ref)); strList(e.aliases).forEach(a => addName(a, str(e.ref))); }
    // Aliases added to known entities in this reply count for that entity.
    for (const e of (Array.isArray(data.entities) ? data.entities : [])) if (plain(e) && str(e.id) && mem.entities.some(x => x.id === e.id)) strList(e.aliases).forEach(a => addName(a, e.id));
    const fixed = new Map();
    const fix = v => {
        if (typeof v !== 'string' || !v.trim() || isRef(v)) return v;
        const hit = byName.get(norm(v));
        if (!hit || hit.size !== 1) return v;
        const id = [...hit][0];
        fixed.set(v.trim(), id);
        return id;
    };
    const fixList = l => (Array.isArray(l) ? l.map(fix) : l);
    for (const sc of scenes) if (plain(sc)) sc.who = fixList(sc.who);
    for (const c of (Array.isArray(data.changes) ? data.changes : [])) {
        if (!plain(c)) continue;
        if (c.entity !== undefined) c.entity = fix(c.entity);
        if (c.holder !== undefined) c.holder = fix(c.holder);
        if (c.who !== undefined) c.who = fixList(c.who);
        if (c.knownBy !== undefined) c.knownBy = fixList(c.knownBy);
    }
    if (fixed.size) notes.push(`Names used as ids were linked: ${[...fixed].map(([n, id]) => `"${n}" -> ${id}`).join(', ')}.`);
    // Point evidence inside its own scene
    if (chunk && Array.isArray(chunk.indices)) {
        const n = v => (typeof v === 'string' && /^#?\d+$/.test(v.trim()) ? Number(v.replace('#', '')) : v);
        const starts = scenes.map((sc, i) => (i === 0 ? chunk.from : n(plain(sc) ? sc.start : undefined)));
        scenes.forEach((sc, i) => {
            if (!plain(sc) || !Array.isArray(sc.points)) return;
            const lo = starts[i], next = starts[i + 1];
            if (!Number.isInteger(lo)) return;
            const hi = Number.isInteger(next) ? next - 1 : chunk.to;
            sc.points.forEach((p, j) => {
                if (!plain(p) || !Array.isArray(p.msgs)) return;
                const inside = p.msgs.filter(m => { const v = n(m); return !Number.isInteger(v) || (v >= lo && v <= hi); });
                const hasNum = inside.some(m => Number.isInteger(n(m)));
                if (inside.length < p.msgs.length && hasNum) {
                    notes.push(`scenes[${i}].points[${j}]: message numbers outside this scene were dropped.`);
                    p.msgs = inside;
                }
            });
        });
    }
    return notes;
}
export function validateResult(data, { mem, chunk, expectContinue }) {
    const errors = [];
    const open = openScene(mem);
    const inChunk = new Set(chunk.indices);
    const openSegs = new Set((open?.segs || []).map(g => g.id));
    const declared = new Map();
    const evidence = (msgs, where) => {
        if (!Array.isArray(msgs) || !msgs.length) { errors.push(`${where}: "msgs" must list at least one message number.`); return; }
        for (const m of msgs) {
            if (Number.isInteger(m)) { if (!inChunk.has(m)) errors.push(`${where}: #${m} is not one of the new messages (#${chunk.from}–#${chunk.to}).`); }
            else if (isSegRef(m)) { if (!openSegs.has(m.trim())) errors.push(`${where}: "${m}" is not a segment of the open scene.`); }
            else if (typeof m === 'string' && /^#?\d+$/.test(m.trim())) {
                const n = Number(m.replace('#', ''));
                if (!inChunk.has(n)) errors.push(`${where}: #${n} is not one of the new messages (#${chunk.from}–#${chunk.to}).`);
            } else errors.push(`${where}: invalid evidence ${JSON.stringify(m)}.`);
        }
    };
    // Terms: required when a debt or promise is added; on an update only when the terms change
    // (marking it kept, paid or failed needs only "status" and the message that shows it).
    const checkTerms = (c, w, required) => {
        const t = c.terms;
        if (t === undefined || t === null) { if (required) errors.push(`${w}: a ${c.kind} needs "terms": {"msg": <number>, "quote": "<the exact words that set the terms>"}. Quote the whole condition, every side of it, from one message.`); return; }
        if (!plain(t)) { errors.push(`${w}.terms must be {"msg": <number>, "quote": "..."}.`); return; }
        const msg = typeof t.msg === 'string' && /^#?\d+$/.test(t.msg.trim()) ? Number(t.msg.replace('#', '')) : t.msg;
        if (!Number.isInteger(msg) || !inChunk.has(msg)) { errors.push(`${w}.terms.msg must be one of the new messages (#${chunk.from}–#${chunk.to}).`); return; }
        if (!str(t.quote) || normQuote(t.quote).length < 6) { errors.push(`${w}.terms.quote must copy the words that set the terms.`); return; }
        if (chunk.texts && !findQuote(chunk.texts[msg], t.quote)) errors.push(`${w}.terms.quote is not in message #${msg}. Copy the words exactly as they appear there, in the story's language; do not translate, shorten or join separate parts.`);
    };
    if (!plain(data)) return ['The reply must be one JSON object.'];
    // Entities first, so scenes and changes can be checked against the declared refs.
    if (data.entities !== undefined && !Array.isArray(data.entities)) errors.push('"entities" must be an array.');
    const newNames = new Map();
    for (const [i, e] of (Array.isArray(data.entities) ? data.entities : []).entries()) {
        const w = `entities[${i}]`;
        if (!plain(e)) { errors.push(`${w} must be an object.`); continue; }
        if (e.aliases !== undefined && (!Array.isArray(e.aliases) || e.aliases.some(a => typeof a !== 'string'))) errors.push(`${w}.aliases must be an array of strings.`);
        if (str(e.id)) { if (!mem.entities.some(x => x.id === e.id)) errors.push(`${w}: unknown entity id "${e.id}".`); continue; }
        const ref = str(e.ref);
        if (!ref) { errors.push(`${w}.ref is missing.`); continue; }
        if (/^[sgerSGER]\d+$/.test(ref)) errors.push(`${w}.ref "${ref}" looks like an id; invent a ref such as "new1".`);
        if (declared.has(ref)) errors.push(`${w}.ref "${ref}" is declared twice.`);
        if (!ENTITY_TYPES.includes(e.type)) errors.push(`${w}.type must be person, item or place.`);
        if (!str(e.name)) errors.push(`${w}.name is missing.`);
        const key = `${e.type}|${norm(e.name)}`;
        const same = mem.entities.find(x => x.type === e.type && norm(x.name) === norm(e.name));
        if (same) errors.push(`${w}: "${e.name}" already exists as ${same.id}. Use ${same.id} instead of declaring it again; if it is a different ${e.type}, give it a distinguishing name.`);
        else if (newNames.has(key)) errors.push(`${w}: "${e.name}" is declared twice. Give different ${e.type}s distinguishing names.`);
        newNames.set(key, ref);
        declared.set(ref, e);
    }
    // A reference is an existing entity id or a ref declared in this reply; never a bare name.
    const typeOf = r => {
        if (typeof r !== 'string' || !r.trim()) return null;
        const k = r.trim();
        if (declared.has(k)) return declared.get(k).type || null;
        return mem.entities.find(x => x.id === k)?.type || null;
    };
    // Wrong-type references get a hint on how to fix them, aimed at the actual field.
    const HINT = {
        'item.entity': 'In an "item" record, "entity" is the item itself and the person who has it goes in "holder". If this change is about a person, make it a "party" record; if it describes a place, make it a "world" record with kind "place".',
        'party.entity': 'In a "party" record, "entity" is the person the record is about. If this change is about an object, make it an "item" record whose "entity" is that object.',
        'holder': '"holder" is the person or place that has the item now.',
        'people': 'Only people can be listed here.',
    };
    const ref = (r, where, types = ENTITY_TYPES, hint = '') => {
        const t = typeOf(r);
        if (!t) errors.push(`${where} "${r}" is not a known entity id or a ref declared in "entities".`);
        else if (!types.includes(t)) {
            const name = declared.get(String(r).trim())?.name || mem.entities.find(x => x.id === r)?.name || r;
            errors.push(`${where} "${r}" (${name}) is a ${t}, but must be ${types.map(x => (x === 'item' ? 'an item' : 'a ' + x)).join(' or ')}.${hint ? ' ' + hint : ''}`);
        }
    };
    const refList = (list, where, types, hint = '') => {
        if (list === undefined) return;
        if (!Array.isArray(list)) { errors.push(`${where} must be an array.`); return; }
        list.forEach((r, k) => ref(r, `${where}[${k}]`, types, hint));
    };
    if (!Array.isArray(data.scenes) || !data.scenes.length) errors.push('"scenes" must contain at least one scene.');
    let prevStart = chunk.from;
    (Array.isArray(data.scenes) ? data.scenes : []).forEach((s, i) => {
        const w = `scenes[${i}]`;
        if (!plain(s)) { errors.push(`${w} must be an object.`); return; }
        if (!['new', 'continue'].includes(s.scene)) errors.push(`${w}.scene must be "new" or "continue".`);
        if (s.scene === 'continue' && (i > 0 || !open)) errors.push(`${w}: only the first scene may "continue", and only when there is an OPEN SCENE.`);
        if (i === 0 && expectContinue === true && s.scene !== 'continue') errors.push(`${w}: these messages continue the OPEN SCENE, so the first scene must be "continue".`);
        if (i === 0 && expectContinue === false && s.scene === 'continue') errors.push(`${w}: these messages start a new scene, so the first scene must be "new".`);
        if (!str(s.title)) errors.push(`${w}.title is empty.`);
        if (!str(s.outline)) errors.push(`${w}.outline is empty.`);
        if (s.notes !== undefined && typeof s.notes !== 'string') errors.push(`${w}.notes must be a string.`);
        refList(s.who, `${w}.who`);
        if (i > 0) {
            const st = typeof s.start === 'string' ? Number(s.start.replace('#', '')) : s.start;
            if (!Number.isInteger(st) || !inChunk.has(st) || st <= prevStart) errors.push(`${w}.start must be the first message number of this scene, after the previous scene's start.`);
            else prevStart = st;
        }
        if (!Array.isArray(s.points)) errors.push(`${w}.points must be an array.`);
        else s.points.forEach((p, j) => {
            if (!plain(p) || !str(p.text)) { errors.push(`${w}.points[${j}] needs "text".`); return; }
            if (!['change', 'moment'].includes(p.kind)) errors.push(`${w}.points[${j}].kind must be "change" or "moment".`);
            if (typeof p.key !== 'boolean') errors.push(`${w}.points[${j}].key must be true or false.`);
            evidence(p.msgs, `${w}.points[${j}]`);
        });
    });
    // A point belongs to the scene its messages are in.
    if (Array.isArray(data.scenes)) {
        const n = v => (typeof v === 'string' && /^#?\d+$/.test(v.trim()) ? Number(v.replace('#', '')) : v);
        const starts = data.scenes.map((s, i) => (i === 0 ? chunk.from : n(plain(s) ? s.start : undefined)));
        data.scenes.forEach((s, i) => {
            if (!plain(s) || !Array.isArray(s.points) || !Number.isInteger(starts[i])) return;
            const hi = Number.isInteger(starts[i + 1]) ? starts[i + 1] - 1 : chunk.to;
            s.points.forEach((p, j) => {
                const nums = plain(p) && Array.isArray(p.msgs) ? p.msgs.map(n).filter(Number.isInteger) : [];
                if (nums.length && nums.every(m => m < starts[i] || m > hi))
                    errors.push(`scenes[${i}].points[${j}] cites only messages outside this scene (#${starts[i]}-#${hi}). Put the point in the scene where those messages are, and do not write the same point twice.`);
            });
        });
    }
    const hasValue = v => v !== undefined && v !== null && v !== '';
    if (data.changes !== undefined && !Array.isArray(data.changes)) errors.push('"changes" must be an array.');
    for (const [i, c] of (Array.isArray(data.changes) ? data.changes : []).entries()) {
        const w = `changes[${i}]${plain(c) && str(c.text) ? ` ("${str(c.text).slice(0, 60)}")` : ''}`;
        if (!plain(c)) { errors.push(`${w} must be an object.`); continue; }
        if (c.op === 'add') {
            if (!RECORD_TYPES.includes(c.type)) { errors.push(`${w}.type must be party, item, quest or world.`); continue; }
            if (!str(c.text)) errors.push(`${w}.text is empty.`);
            if (c.type === 'party') {
                if (!ASPECTS.includes(c.aspect)) errors.push(`${w}.aspect must be "relation" or "condition".`);
                ref(c.entity, `${w}.entity`, ['person'], HINT['party.entity']);
            }
            if (c.type === 'item') {
                ref(c.entity, `${w}.entity`, ['item'], HINT['item.entity']);
                if (hasValue(c.holder)) ref(c.holder, `${w}.holder`, ['person', 'place'], HINT.holder);
            }
            if (c.type === 'quest') {
                if (!QUEST_KINDS.includes(c.kind)) errors.push(`${w}.kind must be one of ${QUEST_KINDS.join(', ')}.`);
                if (c.status !== undefined && !QUEST_STATUS.includes(c.status)) errors.push(`${w}.status must be open, done or failed.`);
                refList(c.who, `${w}.who`, ['person'], HINT.people);
                if (TERMS_KINDS.includes(c.kind)) checkTerms(c, w, true);
            }
            if (c.type !== 'quest' && c.status !== undefined) errors.push(`${w}.status is only for quests.`);
            if (c.type === 'world') {
                if (!WORLD_KINDS.includes(c.kind)) errors.push(`${w}.kind must be one of ${WORLD_KINDS.join(', ')}.`);
                refList(c.knownBy, `${w}.knownBy`, ['person'], HINT.people);
                if (hasValue(c.entity)) ref(c.entity, `${w}.entity`);
            }
            evidence(c.msgs, w);
        } else if (c.op === 'update' || c.op === 'remove') {
            const rec = mem.records.find(r => r.id === c.id);
            if (!rec) { errors.push(`${w}: unknown record id "${c.id}". Only records listed in CURRENT STATE can be updated; describe a new one with "add".`); continue; }
            if (c.op === 'update') {
                if (c.text !== undefined && !str(c.text)) errors.push(`${w}.text is empty.`);
                if (c.status !== undefined && (rec.type !== 'quest' || !QUEST_STATUS.includes(c.status))) errors.push(`${w}.status is only for quests: open, done or failed.`);
                if (c.holder !== undefined && rec.type !== 'item') errors.push(`${w}.holder is only for items.`);
                else if (hasValue(c.holder)) ref(c.holder, `${w}.holder`, ['person', 'place'], HINT.holder);
                if (c.knownBy !== undefined && rec.type !== 'world') errors.push(`${w}.knownBy is only for world records.`);
                else refList(c.knownBy, `${w}.knownBy`, ['person'], HINT.people);
                if (c.text === undefined && c.status === undefined && c.holder === undefined && c.knownBy === undefined && c.terms === undefined) errors.push(`${w} changes nothing.`);
                if (c.terms !== undefined && c.terms !== null) {
                    if (rec.type !== 'quest' || !TERMS_KINDS.includes(rec.kind)) errors.push(`${w}.terms is only for debts and promises.`);
                    else checkTerms(c, w, false);
                }
            }
            evidence(c.msgs, w);
        } else errors.push(`${w}.op must be add, update or remove.`);
    }
    return errors;
}

// ───────── scene boundaries (automatic collection, step 1) ─────────

// Checks the boundary reply against the messages actually sent and works out what may be saved:
// only scenes whose end is confirmed by the start of a following scene.
export function validateBoundary(data, { indices, hasOpen }) {
    const errors = [];
    const sent = new Set(indices);
    const num = v => (typeof v === 'string' && /^#?\d+$/.test(v.trim()) ? Number(v.replace('#', '')) : v);
    if (!plain(data)) return { errors: ['The reply must be one JSON object.'], plan: null };
    if (typeof data.continues_open_scene !== 'boolean') errors.push('"continues_open_scene" must be true or false.');
    else if (data.continues_open_scene && !hasOpen) errors.push('"continues_open_scene" must be false: there is no open scene.');
    if (!Array.isArray(data.scenes) || !data.scenes.length) errors.push('"scenes" must list at least one scene.');
    let prev = -Infinity;
    const scenes = (Array.isArray(data.scenes) ? data.scenes : []).map((s, i) => {
        const w = `scenes[${i}]`;
        if (!plain(s)) { errors.push(`${w} must be an object.`); return null; }
        const start = num(s.start);
        if (!Number.isInteger(start) || !sent.has(start)) errors.push(`${w}.start must be a message number from NEW MESSAGES (#${indices[0]}-#${indices[indices.length - 1]}).`);
        else if (start <= prev) errors.push(`${w}.start must come after the previous scene's start.`);
        else prev = start;
        if (i === 0 && start !== indices[0]) errors.push(`${w}.start must be #${indices[0]}, the first new message.`);
        if (typeof s.ended !== 'boolean') errors.push(`${w}.ended must be true or false.`);
        return { start, ended: s.ended === true };
    });
    if (errors.length) return { errors, plan: null };
    // A scene counts as finished only when it says so AND a later scene has started.
    let k = 0;
    while (k < scenes.length - 1 && scenes[k].ended) k++;
    const boundary = k > 0 ? indices.filter(n => n < scenes[k].start).pop() : null;
    return {
        errors: [],
        plan: { continuesOpen: data.continues_open_scene, closeOpen: hasOpen && !data.continues_open_scene,
            finished: k, boundary: boundary ?? null, scenes },
    };
}

// Text fields that are injected must be English. Names and aliases are exempt.
export function resultLanguageIssues(data) {
    const out = [];
    const check = (v, where) => { if (typeof v === 'string' && mostlyNonEnglish(v)) out.push(where); };
    (data?.scenes || []).forEach((s, i) => {
        if (!plain(s)) return;
        check(s.title, `scenes[${i}].title`); check(s.where, `scenes[${i}].where`);
        check(s.outline, `scenes[${i}].outline`); check(s.notes, `scenes[${i}].notes`);
        (Array.isArray(s.points) ? s.points : []).forEach((p, j) => check(p?.text, `scenes[${i}].points[${j}]`));
    });
    (Array.isArray(data?.changes) ? data.changes : []).forEach((c, i) => check(c?.text, `changes[${i}].text`));
    return out;
}

// ───────── applying a result ─────────

function numEvidence(msgs) {
    return (msgs || []).map(m => (typeof m === 'string' && /^#?\d+$/.test(m.trim()) ? Number(m.replace('#', '')) : m));
}
export function applyResult(mem, data, chunk, { close = false } = {}) {
    const next = clone(upgradeEvidence(mem));
    const refs = new Map();
    for (const e of data.entities || []) {
        if (str(e.id)) {
            const ex = next.entities.find(x => x.id === e.id);
            if (ex) ex.aliases = uniq([...(ex.aliases || []), ...strList(e.aliases)]).filter(a => norm(a) !== norm(ex.name));
            continue;
        }
        // A declared ref is always a new entity. Shared aliases are fine (two different
        // compasses can both be "나침반"); sameness is only ever stated by using an existing id.
        const name = str(e.name);
        const ent = { id: takeId(next, 'e'), type: e.type, name, aliases: uniq(strList(e.aliases).filter(a => norm(a) !== norm(name))) };
        next.entities.push(ent);
        refs.set(str(e.ref), ent.id);
    }
    const resolve = r => {
        if (typeof r !== 'string' || !r.trim()) return null;
        const k = r.trim();
        if (refs.has(k)) return refs.get(k);
        return next.entities.some(x => x.id === k) ? k : null;
    };
    // Scenes: first one starts at the chunk start; later ones at their "start".
    const scenes = data.scenes;
    const starts = scenes.map((s, i) => (i === 0 ? chunk.from : Number(String(s.start).replace('#', ''))));
    const segIds = [];
    const segRanges = [];
    let current = openScene(next);
    scenes.forEach((s, i) => {
        const from = starts[i];
        const to = i + 1 < scenes.length ? chunk.indices.filter(n => n < starts[i + 1]).pop() ?? from : chunk.to;
        const seg = {
            id: takeId(next, 'g'), from, to,
            outline: str(s.outline),
            points: s.points.map(p => ({ text: str(p.text), kind: p.kind, key: p.key === true, msgs: numEvidence(p.msgs), ...(cleanLootSources(p.loot).length ? { loot: cleanLootSources(p.loot), keyUser: true } : {}) })),
            notes: str(s.notes),
        };
        segIds.push(seg.id); segRanges.push(seg);
        const who = uniq(strList(s.who).map(resolve).filter(Boolean));
        if (s.scene === 'continue' && current && i === 0) {
            current.segs.push(seg);
            delete current.external;
            // The scene keeps the title it started with; a later part does not rename it.
            if (str(s.where)) current.where = str(s.where);
            current.who = uniq([...current.who, ...who]);
            if (s.star === true) current.star = true;
        } else {
            if (current) current.status = 'closed';
            current = { id: takeId(next, 's'), title: str(s.title), where: str(s.where), who, status: 'open',
                star: s.star === true, pin: false, segs: [seg] };
            next.scenes.push(current);
        }
        const last = i === scenes.length - 1;
        current.status = !last || close || s.ended === true ? 'closed' : 'open';
    });
    const segFor = msgs => {
        for (const m of msgs) {
            if (Number.isInteger(m)) { const g = segRanges.find(x => m >= x.from && m <= x.to); if (g) return g.id; }
            if (isSegRef(m)) return m.trim();
        }
        return segIds[segIds.length - 1];
    };
    for (const c of data.changes || []) {
        const msgs = numEvidence(c.msgs);
        const src = segFor(msgs);
        if (c.op === 'add') {
            const r = { id: takeId(next, 'r'), type: c.type, text: str(c.text), src: [src], msgs, pin: false, evidenceVersion: 1 };
            if (c.type === 'party') { r.entity = resolve(c.entity); r.aspect = c.aspect; }
            if (c.type === 'item') { r.entity = resolve(c.entity); r.holder = resolve(c.holder); }
            if (c.type === 'quest') {
                r.kind = c.kind; r.status = QUEST_STATUS.includes(c.status) ? c.status : 'open'; r.who = uniq(strList(c.who).map(resolve).filter(Boolean));
                const t = TERMS_KINDS.includes(c.kind) ? termsOf(c, chunk) : null;
                if (t) r.terms = t;
            }
            if (c.type === 'world') { r.kind = c.kind; r.knownBy = uniq(strList(c.knownBy).map(resolve).filter(Boolean)); if (c.entity) r.entity = resolve(c.entity); }
            next.records.push(r);
        } else if (c.op === 'update') {
            const r = next.records.find(x => x.id === c.id);
            if (str(c.text) && str(c.text) !== r.text) { r.text = str(c.text); delete r.ko; }
            if (c.status !== undefined) r.status = c.status;
            if (c.holder !== undefined) r.holder = resolve(c.holder);
            if (Array.isArray(c.knownBy)) r.knownBy = uniq(c.knownBy.map(resolve).filter(Boolean));
            // New terms only when given; a status change keeps the original terms.
            if (r.type === 'quest' && TERMS_KINDS.includes(r.kind) && c.terms) { const t = termsOf(c, chunk); if (t) r.terms = t; }
            r.src = uniq([...(r.src || []), src]);
            r.msgs = uniq([...(r.msgs || []), ...msgs]).slice(-12);
        } else if (c.op === 'remove') {
            next.records = next.records.filter(x => x.id !== c.id);
        }
    }
    return { mem: next, segIds };
}

// Closing the open scene without new messages.
export function closeOpenScene(mem) {
    const next = clone(mem);
    const open = openScene(next);
    if (open) open.status = 'closed';
    return next;
}

// ───────── history (diffs) and rollback ─────────

const COLLECTIONS = ['scenes', 'entities', 'records'];
export function memDiff(before, after) {
    const changes = [], orderBefore = {}, orderAfter = {};
    for (const kind of COLLECTIONS) {
        const a = new Map(before[kind].map(e => [e.id, e])), b = new Map(after[kind].map(e => [e.id, e]));
        orderBefore[kind] = [...a.keys()]; orderAfter[kind] = [...b.keys()];
        for (const id of new Set([...a.keys(), ...b.keys()])) {
            if (JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id))) changes.push({ kind, id, before: a.has(id) ? clone(a.get(id)) : null, after: b.has(id) ? clone(b.get(id)) : null });
        }
    }
    return { changes, orderBefore, orderAfter, nextBefore: clone(before.next), nextAfter: clone(after.next) };
}
export function applyDiff(mem, diff, backwards = false) {
    const out = clone(mem);
    for (const kind of COLLECTIONS) {
        const map = new Map(out[kind].map(e => [e.id, e]));
        for (const c of diff.changes) {
            if (c.kind !== kind) continue;
            const v = backwards ? c.before : c.after;
            if (v) map.set(c.id, clone(v)); else map.delete(c.id);
        }
        const order = (backwards ? diff.orderBefore : diff.orderAfter)[kind];
        out[kind] = [...order.filter(id => map.has(id)).map(id => map.get(id)), ...[...map.values()].filter(e => !order.includes(e.id))];
    }
    out.next = clone(backwards ? diff.nextBefore : diff.nextAfter);
    out.evidenceVersion = 0;
    return upgradeEvidence(out);
}
// st: { mem, lastIndex, history, floor }
export function pushHistory(st, before, after, meta = {}) {
    st.history ||= [];
    st.history.push({ kind: meta.kind || 'edit', from: meta.from ?? null, to: meta.to ?? null, at: meta.at || Date.now(), diff: memDiff(before, after) });
    while (st.history.length > 1 && JSON.stringify(st.history).length > HISTORY_BYTES) {
        const old = st.history.shift();
        if (old.kind === 'summary') st.floor = Math.max(st.floor ?? -1, old.to);
    }
}
// Undo every summary from the one covering messageIndex onward (and edits made after it).
export function rollbackFrom(st, messageIndex) {
    if (messageIndex <= (st.floor ?? -1)) return false;
    const i = st.history.findIndex(h => h.kind === 'summary' && h.to >= messageIndex);
    if (i < 0) return false;
    const before = st.mem;
    for (let k = st.history.length - 1; k >= i; k--) st.mem = applyDiff(st.mem, st.history[k].diff, true);
    const from = st.history[i].from;
    st.history.splice(i);
    st.lastIndex = from - 1;
    const queue = restoreLostLoot(st.lootQueue, before, st.mem, { room: st.roomKey, hashes: st.hashes, fallback: st.undo?.lootQueue });
    if (st.lootQueue || queue.length) st.lootQueue = queue;
    return true;
}

// ───────── recall ─────────

const STOP = new Set('that this with from have were they them their there what when where which while would could should about into your just like then than been only also some will over back down here very more much even still after before because'.split(' '));
// Content words (4+ letters) and numbers such as scores or times ("1.5", "3-2").
function words(text) {
    const t = norm(text);
    const nums = (t.match(/\d+(?:[.:\-–]\d+)+|\d{2,}/g) || []);
    return uniq([...t.split(/[^a-z0-9']+/).filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)), ...nums]);
}
function sceneText(s) {
    return norm([s.title, s.where, sceneOutlineText(s), ...s.segs.flatMap(g => [g.notes, ...g.points.map(p => p.text)])].join(' '));
}
// ───────── duplicates ─────────

const plainText = t => norm(t).replace(/[^a-z0-9ㄱ-힝\s]/g, ' ').replace(/\s+/g, ' ').trim();
// 'exact': the point is already contained, as written, in its scene's outline.
// 'near': most of its content words are in the outline (shown as a candidate only).
export function dupState(scene, p) {
    const outline = plainText(sceneOutlineText(scene)), text = plainText(p.text);
    if (!text) return null;
    if (outline.includes(text)) return 'exact';
    const pw = words(p.text);
    if (pw.length < 3) return null;
    const ow = new Set(words(sceneOutlineText(scene)));
    return pw.filter(w => ow.has(w)).length / pw.length >= 0.75 ? 'near' : null;
}
// Points that go into the injection with their scene: key points, minus exact duplicates of the
// outline (never a point the user marked ● themselves). Stored choices are not changed.
export const injectedPoints = s => s.segs.flatMap(g => g.points)
    .filter(p => !p.pin && pointInjected(p) && !(p.keyUser !== true && dupState(s, p) === 'exact'));

// ───────── recall units ─────────

// Everything of a scene that the injection did not carry, in small units: points and note sentences
// (and the outline, if only a line or the title went in).
export function recallUnits(s, form) {
    const units = [];
    if (form !== 'full' && form !== 'outline') units.push({ kind: 'outline', text: sceneOutlineText(s) });
    const shown = new Set(form === 'full' ? injectedPoints(s) : []);
    for (const g of s.segs) {
        for (const p of g.points) if (!shown.has(p)) units.push({ kind: 'point', text: p.text, seg: g.id });
        for (const sentence of String(g.notes || '').split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(x => x.length > 12)) units.push({ kind: 'note', text: sentence, seg: g.id });
    }
    return units;
}
// Scenes whose left-out material matches the latest messages, with each unit scored. Recent scenes
// are included: anything not actually injected can be recalled.
export function recallScenes(mem, query, formOf = () => 'none', max = 2, ignoreNames = []) {
    const mentioned = mentionedEntities(mem, query);
    // The character and the persona are in nearly every message; their names point at nothing in particular.
    const ignore = new Set(ignoreNames.map(norm).filter(Boolean));
    for (const id of [...mentioned.keys()]) {
        const ent = mem.entities.find(e => e.id === id);
        if (ent && entityTerms(ent).some(t => ignore.has(t))) mentioned.delete(id);
    }
    // Names present in most scenes (the main pair) say nothing about which scene is relevant.
    const n = mem.scenes.length;
    if (n >= 4) {
        for (const id of [...mentioned.keys()]) {
            const ent = mem.entities.find(e => e.id === id);
            const df = mem.scenes.filter(s => s.who.includes(id) || entityTerms(ent).some(t => termIn(sceneText(s), t))).length;
            if (df / n > 0.5) mentioned.delete(id);
        }
    }
    const ignoreWords = new Set([...ignore].flatMap(t => t.split(/\s+/)));
    const qWords = words(query).filter(w => !ignoreWords.has(w));
    const terms = [...mentioned.entries()].map(([id, term]) => ({ term, ent: mem.entities.find(e => e.id === id) }));
    const scoreText = t => {
        const x = norm(t), hits = [];
        let sc = 0;
        for (const { term, ent } of terms) if (entityTerms(ent).some(tt => termIn(x, tt))) { sc += 2; hits.push(`${term}→${ent.name}`); }
        const overlap = qWords.filter(w => x.includes(w));
        sc += overlap.length * 0.7;
        return { sc, hits, overlap };
    };
    const scored = [];
    for (const s of mem.scenes) {
        const form = formOf(s);
        const units = recallUnits(s, form);
        if (!units.length) continue;
        const all = scoreText([...(form === 'none' ? [s.title, s.where] : []), ...units.map(u => u.text)].join(' '));
        // Three shared content words (or a name plus one) are needed for the scene to qualify.
        if (all.sc < 2 || (!all.hits.length && all.overlap.length < 3)) continue;
        const reasons = [...new Set(all.hits)];
        if (all.overlap.length) reasons.push(`words: ${all.overlap.slice(0, 4).join(', ')}`);
        for (const u of units) u.score = scoreText(u.text).sc;
        scored.push({ scene: s, score: all.sc, reasons, form, units });
    }
    scored.sort((a, b) => b.score - a.score || b.scene.segs[0].from - a.scene.segs[0].from);
    return scored.slice(0, max);
}

// ───────── injection ─────────

const firstSentence = t => (String(t).match(/^.*?[.!?](\s|$)/)?.[0] || String(t)).trim();
function sceneHead(s) { return `${s.title}${s.where ? ` (${s.where})` : ''}${s.star ? ' ★' : ''}`; }
const progress = s => (s.status === 'open' ? ' [in progress]' : '');
export function sceneFull(s) {
    const pts = injectedPoints(s).map(p => `  • ${p.text}`);
    return [`- ${sceneHead(s)}${progress(s)}: ${sceneOutlineText(s)}`, ...pts].join('\n');
}
export function sceneOutline(s) { return `- ${sceneHead(s)}${progress(s)}: ${sceneOutlineText(s)}`; }
export function sceneOneLiner(s) { return `- ${sceneHead(s)}: ${firstSentence(sceneOutlineText(s))}`; }

export const INJECT_HEADER = '[SavePoint memory: past records of this story. Do not repeat completed actions; carry forward their results and any ongoing states. The latest messages always take priority.]';

export function buildInjection(mem, opts = {}) {
    const budget = Math.max(300, opts.budget ?? 6000);
    const titleCap = Math.max(0, opts.titleCap ?? 600);
    const share = opts.share || { state: 0.35, journal: 0.5, recall: 0.15 };
    const recentN = opts.recentScenes ?? 3;
    const query = opts.query || '';
    const empty = { text: '', tokens: 0, recalled: [], omittedScenes: 0, pinOverflow: false, pinMissing: 0, used: { state: 0, journal: 0, recall: 0, titles: 0 } };
    if (!mem.scenes.length && !mem.records.length) return empty;

    const mentioned = mentionedEntities(mem, query);
    const open = openScene(mem);
    const hot = new Set(mentioned.keys());
    for (const id of open?.who || []) hot.add(id);
    const recentScenes = mem.scenes.slice(-recentN);
    for (const sc of recentScenes) for (const id of sc.who) hot.add(id);

    const items = [];
    const recPriority = r => {
        if (r.pin) return 2;
        if (r.type === 'quest' && r.status === 'open') return 1;
        if (recordEntities(r).some(id => hot.has(id))) return 1;
        if (r.type === 'quest') return 8;
        return 6;
    };
    for (const r of mem.records) items.push({ tier: 'state', pr: recPriority(r), rec: r, pin: !!r.pin, alts: [recordLine(mem, r, false)] });
    const recentIds = new Set(recentScenes.map(sc => sc.id));
    mem.scenes.forEach((sc, idx) => {
        let pr, alts;
        if (recentIds.has(sc.id)) { pr = 4; alts = [sceneFull(sc), sceneOutline(sc), sceneOneLiner(sc)]; }
        else if (sc.pin) { pr = 2; alts = [sceneOutline(sc), sceneOneLiner(sc)]; }
        else if (sc.star) { pr = 5; alts = [sceneOutline(sc), sceneOneLiner(sc)]; }
        else { pr = 7; alts = [sceneOutline(sc)]; }
        if (sc.pin && pr !== 2) pr = Math.min(pr, 2);
        items.push({ tier: 'journal', pr, scene: sc, idx, pin: !!sc.pin, alts });
        for (const g of sc.segs) for (const p of g.points) {
            if (p.pin === true) items.push({ tier: 'journal', pr: 2, scene: sc, point: p, pin: true,
                alts: [`- From "${sc.title}": ${p.text}`] });
        }
    });
    const sorted = [...items].sort((a, b) => a.pr - b.pr);
    const used = { state: 0, journal: 0, recall: 0, titles: 0 };
    const caps = { state: budget * share.state, journal: budget * share.journal, recall: budget * share.recall };
    const headerCost = estTokens(INJECT_HEADER) + 30 + (items.some(it => it.point) ? estTokens('## Pinned points') + 1 : 0);
    let total = headerCost;
    const chosen = new Map();
    const costOf = alt => estTokens(alt) + 1;
    const tryAdd = (it, respectTier, limit) => {
        if (chosen.has(it)) return;
        for (const alt of it.alts) {
            const cost = costOf(alt);
            if (total + cost > limit) continue;
            if (respectTier && used[it.tier] + cost > caps[it.tier]) continue;
            chosen.set(it, alt); used[it.tier] += cost; total += cost;
            return;
        }
    };
    const upgradePinned = (pinnedItems, limit) => {
        for (const it of pinnedItems) {
            if (!chosen.has(it)) continue;
            const cur = chosen.get(it), curCost = costOf(cur);
            for (const alt of it.alts) {
                if (alt === cur) break;
                const extra = costOf(alt) - curCost;
                if (total + extra <= limit) { chosen.set(it, alt); used[it.tier] += extra; total += extra; break; }
            }
        }
    };
    // Phase 1: state and journal, keeping the recall share free for now.
    const reserve = opts.recall === false ? 0 : Math.floor(caps.recall);
    const limit1 = budget - reserve;
    const pinned = sorted.filter(it => it.pin);
    for (const it of [...pinned].sort((a, b) => costOf(a.alts.at(-1)) - costOf(b.alts.at(-1)))) {
        const alt = it.alts.at(-1), cost = costOf(alt);
        if (total + cost > budget) continue;
        chosen.set(it, alt); used[it.tier] += cost; total += cost;
    }
    for (const it of sorted) tryAdd(it, true, limit1);
    for (const it of sorted) tryAdd(it, false, limit1);
    upgradePinned(pinned, limit1);

    // Phase 2: recall what the journal did not actually carry (including recent scenes), unit by unit,
    // best match first, never repeating text already in the injection, within the recall share.
    const formOf = sc => {
        const it = items.find(x => x.scene === sc);
        const alt = it && chosen.get(it);
        if (!alt) return 'none';
        if (alt === sceneFull(sc)) return 'full';
        if (alt === sceneOutline(sc)) return 'outline';
        return 'oneliner';
    };
    const recalled = opts.recall === false ? [] : recallScenes(mem, query, formOf, opts.recallMax ?? 2, opts.ignoreNames || []);
    const injectedSoFar = plainText([...chosen.values()].join(' '));
    const cap = Math.min(Math.floor(caps.recall), budget - total);
    const picked = new Map();
    let recallCost = 0;
    const pool = recalled.flatMap((r, ri) => r.units.map((u, ui) => ({ r, u, ri, ui })))
        .filter(x => x.u.score >= 1.4 && !injectedSoFar.includes(plainText(x.u.text)))
        .sort((a, b) => b.u.score - a.u.score || a.ri - b.ri || a.ui - b.ui);
    const maxUnits = opts.recallUnits ?? 6, perScene = 4;
    let taken = 0;
    for (const x of pool) {
        if (taken >= maxUnits || (picked.get(x.r)?.length || 0) >= perScene) continue;
        const head = picked.has(x.r) ? 0 : estTokens(`- From "${x.r.scene.title}":`) + 1;
        const cost = estTokens(x.u.text) + 4 + head;
        if (recallCost + cost > cap) continue;
        if (!picked.has(x.r)) picked.set(x.r, []);
        picked.get(x.r).push(x);
        recallCost += cost; taken++;
    }
    const recallItems = [];
    for (const [r, list] of picked) {
        list.sort((a, b) => a.ui - b.ui);
        const raw = opts.rawRecall ? opts.rawRecall(r.scene) : '';
        const lines = [`- From "${r.scene.title}":`, ...list.map(x => `  • ${x.u.text}`)];
        if (raw && recallCost + estTokens(raw) + 4 <= cap) { lines.push(`  Original excerpt: ${raw}`); recallCost += estTokens(raw) + 4; }
        const it = { tier: 'recall', pr: 3, recall: { ...r, units: list.map(x => x.u) }, alts: [lines.join('\n')] };
        items.push(it);
        chosen.set(it, it.alts[0]);
        recallItems.push(it);
    }
    used.recall = recallCost; total += recallCost;
    // Phase 3: whatever the recall share did not use goes back to state and journal
    // (a scene that was just recalled is not added again).
    const recalledScenes = new Set(recallItems.map(it => it.recall.scene));
    for (const it of sorted) if (!recalledScenes.has(it.scene)) tryAdd(it, false, budget);
    upgradePinned(pinned, budget);
    // A pinned point is its own item even when its scene is old or reduced to a title.
    // If the selected outline of the same scene already contains it verbatim, show it once.
    const pinnedPointItems = [];
    const pointTexts = new Set();
    for (const it of pinned.filter(it => it.point && chosen.has(it))) {
        const text = plainText(it.point.text), key = `${it.scene.id}|${text}`;
        const sceneItem = items.find(x => x.scene === it.scene && !x.point && x.tier === 'journal');
        if ((sceneItem && chosen.has(sceneItem) && plainText(chosen.get(sceneItem)).includes(text)) || pointTexts.has(key)) {
            const cost = costOf(chosen.get(it)); used.journal -= cost; total -= cost;
        } else { pinnedPointItems.push(it); pointTexts.add(key); }
    }
    const pinMissing = pinned.filter(it => !chosen.has(it)).length;
    const pinOverflow = pinMissing > 0;

    // Titles of scenes that did not fit (and were not recalled), newest first under their own cap.
    const recalledIds = new Set(recallItems.map(it => it.recall.scene.id));
    const left = items.filter(it => it.tier === 'journal' && !it.point && !chosen.has(it) && !recalledIds.has(it.scene.id)).map(it => it.scene);
    const titleList = [];
    let titleCost = 0;
    for (const sc of [...left].reverse()) {
        const t = sc.title + (sc.star ? ' ★' : '');
        const c = estTokens(t) + 1;
        if (titleCost + c > titleCap || total + c > budget) break;
        titleList.unshift(t); titleCost += c; total += c;
    }
    used.titles = titleCost;

    const stateItems = items.filter(it => it.tier === 'state' && chosen.has(it));
    const group = (label, pred) => {
        const lines = stateItems.filter(it => pred(it.rec)).map(it => '- ' + chosen.get(it));
        return lines.length ? [`${label}:`, ...lines] : [];
    };
    const stateBlock = [
        ...group('People', r => r.type === 'party'),
        ...group('Items', r => r.type === 'item'),
        ...group('Open threads', r => r.type === 'quest' && r.status === 'open'),
        ...group('Resolved threads', r => r.type === 'quest' && r.status !== 'open'),
        ...group('World', r => r.type === 'world'),
    ];
    const journalItems = items.filter(it => it.tier === 'journal' && !it.point && chosen.has(it)).sort((a, b) => a.idx - b.idx);
    const journalBlock = [
        ...(titleList.length ? [`Earlier scenes (titles only): ${titleList.join('; ')}.`] : []),
        ...journalItems.map(it => chosen.get(it)),
    ];
    const parts = [INJECT_HEADER];
    if (stateBlock.length) parts.push('## Current state', ...stateBlock);
    if (pinnedPointItems.length) parts.push('## Pinned points', ...pinnedPointItems.map(it => chosen.get(it)));
    if (journalBlock.length) parts.push('## Journal (oldest to newest)', ...journalBlock);
    if (recallItems.length) parts.push('## Recalled details (relevant to the latest messages)', ...recallItems.map(it => chosen.get(it)));
    const text = parts.join('\n');
    return {
        text, tokens: estTokens(text), used, pinOverflow, pinMissing,
        omittedScenes: left.length - titleList.length,
        recalled: recallItems.map(it => ({ id: it.recall.scene.id, title: it.recall.scene.title, reasons: it.recall.reasons, form: it.recall.form })),
    };
}

// ───────── validation of stored memory (imports, save files) ─────────

export function cleanMem(raw) {
    if (!plain(raw) || !Array.isArray(raw.scenes) || !Array.isArray(raw.entities) || !Array.isArray(raw.records)) throw new Error('SavePoint 기억 형식이 아니에요.');
    const out = emptyMem();
    out.evidenceVersion = raw.evidenceVersion === 1 ? 1 : 0;
    const ids = new Set();
    const id = (v, prefix) => {
        const s = str(v);
        if (!new RegExp(`^${prefix}\\d+$`).test(s) || ids.has(s)) throw new Error('기억 항목 ID가 잘못됐거나 중복됐어요.');
        ids.add(s);
        return s;
    };
    for (const e of raw.entities) {
        if (!plain(e) || !str(e.name)) throw new Error('인물·물건 항목이 잘못됐어요.');
        out.entities.push({ id: id(e.id, 'e'), type: ENTITY_TYPES.includes(e.type) ? e.type : 'person', name: str(e.name), aliases: uniq(strList(e.aliases)) });
    }
    const ent = new Set(out.entities.map(e => e.id));
    const eref = v => (typeof v === 'string' && ent.has(v) ? v : null);
    for (const s of raw.scenes) {
        if (!plain(s) || !str(s.title) || !Array.isArray(s.segs) || !s.segs.length) throw new Error('장면 항목이 잘못됐어요.');
        const scene = { id: id(s.id, 's'), title: str(s.title), where: str(s.where), who: uniq((s.who || []).map(eref).filter(Boolean)),
            status: s.status === 'open' ? 'open' : 'closed', star: !!s.star, pin: !!s.pin,
            segs: s.segs.map(g => {
                if (!plain(g)) throw new Error('장면 기록이 잘못됐어요.');
                return { ...(g.external ? { external: true } : {}), ...(cleanSource(g.source) ? { source: cleanSource(g.source) } : {}), id: id(g.id, 'g'), from: Number.isInteger(g.from) ? g.from : null, to: Number.isInteger(g.to) ? g.to : null,
                    ...(str(g.outline) ? { outline: str(g.outline) } : {}),
                    points: (Array.isArray(g.points) ? g.points : []).filter(p => plain(p) && str(p.text)).map(p => ({
                        text: str(p.text), kind: p.kind === 'change' ? 'change' : 'moment',
                        ...(typeof p.key === 'boolean' ? { key: p.key } : {}),
                        ...(cleanPrior(p.oldEvidence).length ? { oldEvidence: cleanPrior(p.oldEvidence) } : {}),
                        msgs: (Array.isArray(p.msgs) ? p.msgs : []).filter(m => Number.isInteger(m) || isSegRef(m)),
                        ...(typeof p.keyUser === 'boolean' ? { keyUser: p.keyUser } : {}),
                        ...(cleanLootSources(p.loot).length ? { loot: cleanLootSources(p.loot) } : {}),
                        ...(p.pin === true ? { pin: true } : {}),
                        ...(str(p.ko) ? { ko: p.ko } : {}) })),
                    notes: str(g.notes), ...(str(g.koNotes) ? { koNotes: g.koNotes } : {}), ...(str(g.koOutline) ? { koOutline: g.koOutline } : {}) };
            }) };
        if (str(s.koTitle)) scene.koTitle = s.koTitle;
        if (s.external) scene.external = true;
        out.scenes.push(scene);
    }
    for (const r of raw.records) {
        if (!plain(r) || !RECORD_TYPES.includes(r.type) || !str(r.text)) throw new Error('상태 항목이 잘못됐어요.');
        const rec = { evidenceVersion: r.evidenceVersion === 1 ? 1 : 0, ...(cleanPrior(r.oldEvidence).length ? { oldEvidence: cleanPrior(r.oldEvidence) } : {}), id: id(r.id, 'r'), type: r.type, text: str(r.text), src: strList(r.src), msgs: (Array.isArray(r.msgs) ? r.msgs : []).filter(m => Number.isInteger(m) || isSegRef(m)), pin: !!r.pin };
        if (r.type === 'party') { rec.entity = eref(r.entity); rec.aspect = ASPECTS.includes(r.aspect) ? r.aspect : 'relation'; }
        if (r.type === 'item') { rec.entity = eref(r.entity); rec.holder = eref(r.holder); }
        if (r.type === 'quest') {
            rec.kind = QUEST_KINDS.includes(r.kind) ? r.kind : 'goal'; rec.status = QUEST_STATUS.includes(r.status) ? r.status : 'open'; rec.who = uniq((r.who || []).map(eref).filter(Boolean));
            if (plain(r.terms) && (Number.isInteger(r.terms.msg) || cleanSource(r.terms.source)) && str(r.terms.quote)) rec.terms = { msg: Number.isInteger(r.terms.msg) ? r.terms.msg : null, quote: str(r.terms.quote), context: str(r.terms.context) || str(r.terms.quote), ...(cleanSource(r.terms.source) ? { source: cleanSource(r.terms.source) } : {}) };
        }
        if (r.type === 'world') { rec.kind = WORLD_KINDS.includes(r.kind) ? r.kind : 'rule'; rec.knownBy = uniq((r.knownBy || []).map(eref).filter(Boolean)); if (eref(r.entity)) rec.entity = r.entity; }
        if (str(r.ko)) rec.ko = r.ko;
        out.records.push(rec);
    }
    const max = k => Math.max(0, ...[...ids].filter(x => x[0] === k).map(x => Number(x.slice(1))));
    out.next = { s: max('s') + 1, g: max('g') + 1, e: max('e') + 1, r: max('r') + 1 };
    if (plain(raw.next)) for (const k of ['s', 'g', 'e', 'r']) if (Number.isInteger(raw.next[k]) && raw.next[k] > out.next[k]) out.next[k] = raw.next[k];
    for (let i = 0; i < out.scenes.length - 1; i++) out.scenes[i].status = 'closed';
    return upgradeEvidence(out);
}
// Preserve the narrative scene; detach only references to the original chat.
export function detachMem(mem, sourceRoom = null) {
    return detachEvidence(mem, sourceRoom);
}

// ───────── summary numbers for save files and status ─────────

export function memStats(mem) {
    const last = mem.scenes[mem.scenes.length - 1];
    return {
        scenes: mem.scenes.length,
        records: mem.records.length,
        openQuests: mem.records.filter(r => r.type === 'quest' && r.status === 'open').length,
        place: last?.where || '',
        lastTitle: last?.title || '',
    };
}

// ───────── re-choosing key points of stored scenes (no re-collection) ─────────

export function rekeyItems(scene) {
    return scene.segs.flatMap(g => g.points.map((p, j) => ({ id: pointId(g, j), text: p.text, kind: p.kind })));
}
export function validateRekey(data, ids) {
    if (!plain(data) || !plain(data.keys)) return ['Return {"keys": {"<point id>": true | false, ...}}.'];
    const errors = [];
    const missing = ids.filter(id => typeof data.keys[id] !== 'boolean');
    if (missing.length) errors.push(`"keys" is missing true/false for: ${missing.slice(0, 12).join(', ')}.`);
    const unknown = Object.keys(data.keys).filter(id => !ids.includes(id));
    if (unknown.length) errors.push(`"keys" has unknown ids: ${unknown.slice(0, 8).join(', ')}.`);
    return errors;
}
export function applyRekey(mem, sceneId, keys) {
    const next = clone(mem);
    const scene = next.scenes.find(s => s.id === sceneId);
    if (!scene) return next;
    for (const [id, v] of Object.entries(keys)) { const p = findPointById(scene, id); if (p && typeof v === 'boolean') p.key = v; }
    return next;
}

// ───────── record check (warnings only) ─────────

export function validateCheck(data, knownIds) {
    if (!plain(data) || !Array.isArray(data.issues)) return { errors: ['Return {"issues": [...]} (an empty list if nothing is wrong).'], issues: [] };
    const issues = [];
    let dropped = 0;
    for (const it of data.issues) {
        const about = plain(it) ? str(it.about) : '';
        if (!about || !knownIds.has(about) || !str(it.problem)) { dropped++; continue; }
        const also = str(it.also);
        // "misread" names the wrong statement; anything else means the two disagree and nobody is blamed.
        const kind = it.kind === 'misread' ? 'misread' : 'unclear';
        issues.push({ about, kind, basis: it.basis === 'contradicted' ? 'contradicted' : 'unsupported', ...(kind === 'unclear' && also && also !== about && knownIds.has(also) ? { also } : {}), problem: str(it.problem),
            conflict: (Array.isArray(it.conflict) ? it.conflict : []).map(str).filter(Boolean).slice(0, 2),
            msgs: (Array.isArray(it.msgs) ? it.msgs : []).map(m => (typeof m === 'string' ? Number(m.replace('#', '')) : m)).filter(Number.isInteger).slice(0, 8) });
    }
    return { errors: dropped && !issues.length ? [`Every issue must name one id listed above in "about" (${dropped} did not).`] : [], issues };
}
// What a saved batch changed: records added or edited, and the new parts.
export function checkScope(before, after) {
    const old = new Map(before.records.map(r => [r.id, JSON.stringify(r)]));
    const records = after.records.filter(r => old.get(r.id) !== JSON.stringify(r)).map(r => r.id);
    const oldSegs = new Map(before.scenes.flatMap(sc => sc.segs.map(g => [g.id, JSON.stringify(g)])));
    const segs = after.scenes.flatMap(sc => sc.segs.filter(g => oldSegs.get(g.id) !== JSON.stringify(g)).map(g => g.id));
    return { records, segs };
}

// Display only: many identical reference errors become one line per name.
export function groupErrors(errors) {
    const names = new Map(), rest = [];
    for (const e of errors || []) {
        const m = /"([^"]+)" is not a known entity id or a ref declared in "entities"\.$/.exec(e);
        if (m) names.set(m[1], (names.get(m[1]) || 0) + 1); else rest.push(e);
    }
    const head = names.size ? [`Names used instead of entity ids (declare them in "entities" or use their ids): ${[...names].map(([n, k]) => `"${n}" ×${k}`).join(', ')}`] : [];
    return [...head, ...rest];
}


