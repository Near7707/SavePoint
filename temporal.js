// Story time is separate from message addresses and wall-clock timestamps.
// Anchors are local reference days, not a claim about the story's first day.
export const PERIODS = ['dawn', 'morning', 'day', 'afternoon', 'evening', 'night'];
const KO = { dawn: '새벽', morning: '아침', day: '낮', afternoon: '오후', evening: '저녁', night: '밤' };
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 180) => typeof v === 'string' && v.trim().length <= max ? v.trim() : '';
const integer = v => Number.isInteger(v) && Math.abs(v) <= 1000000;
const clock = v => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '';
const OPS = ['same', 'explicit', 'advance', 'jump', 'unknown', 'manual'];
const CERTAINTY = ['explicit', 'linked', 'manual', 'unconfirmed'];
const known = t => !!t && t.certainty !== 'unconfirmed' && typeof t.anchor === 'string' && integer(t.day);
const idFor = (time, seg, edge) => 't:' + JSON.stringify([time.origin || null, seg.id, edge]);
const stampUnknown = (claim = {}) => ({ ...claim, anchor: null, day: null, certainty: 'unconfirmed' });

export function cleanTimeAnchors(raw) {
    const out = {};
    if (!object(raw)) return out;
    for (const [id, a] of Object.entries(raw)) {
        if (!id.startsWith('t:') || id.length > 1600 || !object(a)) continue;
        out[id] = { date: text(a.date), label: text(a.label), baseDay: integer(a.baseDay) ? a.baseDay : 0,
            kind: ['record', 'explicit', 'jump', 'manual'].includes(a.kind) ? a.kind : 'record' };
    }
    return out;
}
function cleanStamp(raw) {
    if (!object(raw)) return stampUnknown({ op: 'unknown' });
    const ev = object(raw.evidence) && Number.isInteger(raw.evidence.msg) && raw.evidence.msg >= 0 && text(raw.evidence.quote, 2000)
        ? { room: text(raw.evidence.room, 1200) || null, msg: raw.evidence.msg, quote: text(raw.evidence.quote, 2000) } : null;
    const s = { op: OPS.includes(raw.op) ? raw.op : 'unknown', date: text(raw.date), period: PERIODS.includes(raw.period) ? raw.period : '', clock: clock(raw.clock),
        days: integer(raw.days) && raw.days >= 0 ? raw.days : null, elapsed: text(raw.elapsed), evidence: ev,
        verified: !!raw.verified && !!ev, manual: raw.manual === true && raw.op === 'manual',
        anchor: typeof raw.anchor === 'string' && raw.anchor.startsWith('t:') && raw.anchor.length <= 1600 ? raw.anchor : null,
        day: integer(raw.day) ? raw.day : null, certainty: CERTAINTY.includes(raw.certainty) ? raw.certainty : 'unconfirmed' };
    if (s.manual) { s.manualDay = integer(raw.manualDay) ? raw.manualDay : 0;
        if (object(raw.basis)) s.basis = { date: text(raw.basis.date), label: text(raw.basis.label), baseDay: integer(raw.basis.baseDay) ? raw.basis.baseDay : 0 };
    }
    if (!s.manual && s.op !== 'same' && !s.verified) return stampUnknown(s);
    return s;
}
export function cleanStoryTime(raw) {
    if (!object(raw)) return undefined;
    return { mode: raw.mode === 'flashback' ? 'flashback' : 'present', origin: text(raw.origin, 1200) || null,
        start: cleanStamp(raw.start), end: cleanStamp(raw.end),
        ...(Array.isArray(raw.via) && raw.via.length <= 200 ? { via: raw.via.map(cleanStamp) } : {}) };
}
function isoDay(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
    const ms = Date.parse(s + 'T00:00:00Z');
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s ? ms / 86400000 : null;
}
export function dateAt(stamp, anchors = {}) {
    if (!known(stamp)) return '';
    const a = anchors[stamp.anchor]; if (!a) return '';
    const day = isoDay(a.date), delta = stamp.day - a.baseDay;
    if (day !== null) {
        const d = new Date((day + delta) * 86400000);
        const result = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
        return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : '';
    }
    // Custom calendars are never fed to JavaScript Date or advanced by invented month lengths.
    return delta === 0 ? a.date : '';
}
function claimFromModel(raw, { chunk, seg, room, quoteMatches }) {
    if (raw === undefined || raw === null) return { op: 'same', date: '', period: '', clock: '', days: null, elapsed: '', evidence: null, verified: false, manual: false };
    if (!object(raw)) return { op: 'unknown' };
    const op = ['same', 'explicit', 'advance', 'jump', 'unknown'].includes(raw.relation) ? raw.relation : 'unknown';
    const n = typeof raw.msg === 'string' && /^#?\d+$/.test(raw.msg) ? Number(raw.msg.replace('#', '')) : raw.msg;
    const quote = text(raw.quote, 2000), source = chunk.texts?.[n];
    const verified = Number.isInteger(n) && n >= seg.from && n <= seg.to && chunk.indices.includes(n) &&
        typeof source === 'string' && !!quote && typeof quoteMatches === 'function' && !!quoteMatches(source, quote);
    const date = text(raw.date), period = PERIODS.includes(raw.period) ? raw.period : '', at = clock(raw.clock);
    const s = { op, date, period, clock: at, days: integer(raw.days) && raw.days >= 0 ? raw.days : null, elapsed: text(raw.elapsed),
        evidence: verified ? { room: room || null, msg: n, quote } : null, verified, manual: false };
    // An absent mention inherits; an unsupported claim cannot masquerade as inheritance.
    if (op === 'same' && (date || period || at) && !verified) s.op = 'unknown';
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && isoDay(date) === null) s.op = 'unknown';
    if (date && (!verified || !(quote.includes(date) || quoteMatches(quote, date)))) s.op = 'unknown';
    if (op !== 'same' && op !== 'unknown' && !verified) s.op = 'unknown';
    return s;
}
function resolveStamp(claim, previous, anchors, key) {
    const s = { ...claim, anchor: null, day: null, certainty: 'unconfirmed' };
    const anchor = (kind, date = '', label = '', day = 0) => {
        anchors[key] = { kind, date, label, baseDay: day }; s.anchor = key; s.day = day;
    };
    if (claim.manual && claim.op === 'manual') {
        const day = integer(claim.manualDay) ? claim.manualDay : 0;
        anchor('manual', claim.date, claim.elapsed, day);
        if (!claim.date && claim.basis) anchors[key] = { ...claim.basis, kind: 'manual' };
        s.certainty = 'manual'; return s;
    }
    if (claim.op === 'unknown') return s;
    if (claim.op === 'same') {
        if (claim.date && known(previous) && dateAt(previous, anchors) && claim.date !== dateAt(previous, anchors)) return s;
        if (!previous) { anchor('record'); s.certainty = 'linked'; }
        else if (known(previous) && anchors[previous.anchor]) { s.anchor = previous.anchor; s.day = previous.day; s.certainty = 'linked'; }
        else return s;
        if (!claim.verified) { s.period = previous?.period || ''; s.clock = previous?.clock || ''; }
        else { s.period ||= previous?.period || ''; s.clock ||= previous?.clock || ''; }
        return s;
    }
    if (!claim.verified || !claim.evidence) return s;
    if (claim.op === 'jump') {
        if (!claim.elapsed) return s;
        anchor('jump', '', claim.elapsed); s.certainty = 'explicit'; return s;
    }
    if (claim.op === 'advance') {
        if (!known(previous) || !anchors[previous.anchor] || !integer(claim.days) || claim.days < 0) return s;
        s.anchor = previous.anchor; s.day = previous.day + claim.days; s.certainty = 'linked';
        if (!integer(s.day)) return stampUnknown(claim);
        // A new day does not inherit yesterday's exact clock or time band.
        return s;
    }
    if (claim.op === 'explicit') {
        if (!claim.date && !claim.period && !claim.clock) return s;
        if (claim.date) {
            const oldDate = dateAt(previous, anchors), oldDay = isoDay(oldDate), newDay = isoDay(claim.date);
            if (known(previous) && oldDate && claim.date === oldDate) { s.anchor = previous.anchor; s.day = previous.day; }
            else if (known(previous) && oldDay !== null && newDay !== null) { s.anchor = previous.anchor; s.day = previous.day + newDay - oldDay; }
            else anchor('explicit', claim.date);
        } else if (known(previous) && anchors[previous.anchor]) { s.anchor = previous.anchor; s.day = previous.day; }
        else anchor('record');
        s.certainty = 'explicit'; return s;
    }
    return s;
}
const parts = mem => (mem.scenes || []).flatMap(s => s.segs || []);
export function lastStoryTime(mem) {
    let last = null;
    for (const g of parts(mem)) if (g.time?.mode === 'present' && g.time.end) last = { stamp: g.time.end, segment: g.id };
    return last;
}
export function resolveResultTime(mem, raw, { chunk, seg, room = null, quoteMatches }) {
    const all = parts(mem), last = all[all.length - 1];
    const mode = raw?.mode === 'flashback' ? 'flashback' : 'present';
    const prev = mode === 'present' ? lastStoryTime(mem)?.stamp : last?.time?.mode === 'flashback' ? last.time.end : null;
    // Old saves and models that omit this optional field remain fully usable, without backfilling dates.
    if (raw === undefined && !prev) return undefined;
    const time = { mode, origin: room, start: null, end: null };
    const invalid = raw !== undefined && (!object(raw) || (raw.mode !== undefined && !['present', 'flashback'].includes(raw.mode)));
    mem.timeAnchors ||= {};
    const options = { chunk, seg, room, quoteMatches };
    const steps = object(raw) && Array.isArray(raw.parts) && raw.parts.length <= 100 ? raw.parts.flatMap(p =>
        p === undefined ? [undefined, undefined] : object(p) ? [p.start, p.end] : [{ relation: 'unknown' }, { relation: 'unknown' }]) : [raw?.start, raw?.end];
    let prior = prev;
    const resolved = steps.map((step, i) => {
        const stamp = resolveStamp(invalid ? { op: 'unknown' } : claimFromModel(step, options), prior, mem.timeAnchors, idFor(time, seg, i === 0 ? 'start' : i === steps.length - 1 ? 'end' : 'via' + i));
        prior = stamp; return stamp;
    });
    time.start = resolved[0] || stampUnknown({ op: 'unknown' }); time.end = resolved[resolved.length - 1] || time.start;
    if (resolved.length > 2) time.via = resolved.slice(1, -1);

    return time;
}
// Re-resolve only recorded claims. No historical quote is looked up in this room's chat.
export function recomputeStoryTimes(mem) {
    mem.timeAnchors = cleanTimeAnchors(mem.timeAnchors);
    let present = null, flashback = null, wasFlashback = false;
    for (const g of parts(mem)) {
        if (!g.time) continue;
        const t = cleanStoryTime(g.time); g.time = t;
        const previous = t.mode === 'flashback' ? wasFlashback ? flashback : null : present;
        t.start = resolveStamp(t.start, previous, mem.timeAnchors, idFor(t, g, 'start'));
        let mid = t.start;
        if (t.via) t.via = t.via.map((claim, i) => { mid = resolveStamp(claim, mid, mem.timeAnchors, idFor(t, g, 'via' + (i + 1))); return mid; });
        t.end = resolveStamp(t.end, mid, mem.timeAnchors, idFor(t, g, 'end'));
        if (t.mode === 'present') present = t.end; else flashback = t.end;
        wasFlashback = t.mode === 'flashback';
    }
}
export function editStoryTime(mem, segmentId, values, room = null) {
    const g = parts(mem).find(x => x.id === segmentId); if (!g) return false;
    const existing = cleanStoryTime(g.time), origin = existing?.origin || g.source?.room || room;
    const edge = values.edge === 'start' ? 'start' : 'end';
    const day = values.day === '' || values.day === undefined ? existing?.[edge]?.day ?? 0 : Number(values.day) - 1;
    if (!integer(day) || day < 0) throw new Error('기준 일 수는 1 이상의 정수로 입력해 주세요.');
    const date = text(values.date), period = PERIODS.includes(values.period) ? values.period : '', at = clock(values.clock);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && isoDay(date) === null) throw new Error('ISO 날짜가 유효하지 않아요. 작품 고유 달력은 이름을 포함해 적어 주세요.');
    if (values.clock && !at) throw new Error('시각은 00:00–23:59 형식으로 입력해 주세요.');
    if (typeof values.date === 'string' && values.date.trim().length > 180) throw new Error('날짜 표현은 180자 이내로 입력해 주세요.');
    const manual = { op: 'manual', manual: true, verified: false, manualDay: day, date, period, clock: at, days: null, elapsed: '', evidence: null };
    const basis = mem.timeAnchors?.[existing?.[edge]?.anchor];
    if (!date && basis) manual.basis = { ...basis };
    g.time = { mode: values.mode === 'flashback' ? 'flashback' : 'present', origin,
        start: existing?.start || { op: 'same' }, ...(existing?.via ? { via: existing.via } : {}), end: existing?.end || { op: 'same' } };
    g.time[edge] = manual;
    recomputeStoryTimes(mem); return true;
}
export function formatStoryStamp(stamp, anchors = {}, lang = 'en') {
    const ko = lang === 'ko';
    if (!stamp || !known(stamp) || !anchors[stamp.anchor]) return ko ? '시간 미확인' : 'unknown story time (unconfirmed)';
    const a = anchors[stamp.anchor], date = dateAt(stamp, anchors), n = stamp.day + 1;
    let label = date;
    if (!label && a.date) label = `${a.date} ${stamp.day - a.baseDay >= 0 ? '+' : ''}${stamp.day - a.baseDay}${ko ? '일' : ' days'}`;
    if (!label && a.label) label = `${a.label} · ${stamp.day === 1 && ko ? '이튿날' : ko ? `해당 기준 ${n}일째` : `day ${n} of this reference`}`;
    if (!label) label = ko ? `기록 기준 ${n}일째` : `recording day ${n}`;
    return [label, stamp.period ? ko ? KO[stamp.period] : stamp.period : '', stamp.clock].filter(Boolean).join(' · ');
}
export function formatSegmentTime(time, anchors = {}, lang = 'en') {
    if (!time) return '';
    const a = formatStoryStamp(time.start, anchors, lang), b = formatStoryStamp(time.end, anchors, lang);
    return `${time.mode === 'flashback' ? lang === 'ko' ? '회상 · ' : 'flashback · ' : ''}${a === b ? a : a + ' → ' + b}`;
}
export function sceneTimeRange(scene, anchors = {}, lang = 'en') {
    const times = (scene.segs || []).map(g => g.time).filter(Boolean); if (!times.length) return '';
    const current = times.filter(t => t.mode !== 'flashback'), use = current.length ? current : times;
    const a = formatStoryStamp(use[0].start, anchors, lang), b = formatStoryStamp(use[use.length - 1].end, anchors, lang);
    const flash = times.some(t => t.mode === 'flashback') ? lang === 'ko' ? '회상 포함 · ' : 'includes flashback · ' : '';
    return flash + (a === b ? a : a + ' → ' + b);
}
export function storyTimeContext(mem, lang = 'en') {
    const last = lastStoryTime(mem); return last ? formatStoryStamp(last.stamp, mem.timeAnchors, lang) : '';
}
