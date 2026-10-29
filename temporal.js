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
// A confirmed time band may have a local reference but no known day number.
// Relative advances then establish offsets within that reference, never a global story day.
const known = t => !!t && t.certainty !== 'unconfirmed' && typeof t.anchor === 'string' && (integer(t.day) || t.day === null);
const idFor = (time, seg, edge) => 't:' + JSON.stringify([time.origin || null, seg.id, edge]);
const stampUnknown = (claim = {}) => ({ ...claim, anchor: null, day: null, certainty: 'unconfirmed' });

export function cleanTimeAnchors(raw) {
    const out = {};
    if (!object(raw)) return out;
    for (const [id, a] of Object.entries(raw)) {
        if (!id.startsWith('t:') || id.length > 1600 || !object(a)) continue;
        out[id] = { date: normalizeStoryDate(text(a.date)), label: text(a.label), baseDay: integer(a.baseDay) ? a.baseDay : 0,
            // v0.6.0 could create more than one unnamed "record" anchor. Only an
            // initial one retains that wording; later references stay local.
            numbered: a.numbered === true || (a.numbered === undefined && a.kind === 'record' && !Object.keys(out).length),
            counted: a.counted === true,
            kind: ['record', 'explicit', 'jump', 'manual'].includes(a.kind) ? a.kind : 'record',
            ...(cleanLink(a.link) ? { link: cleanLink(a.link) } : {}) };
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
    if (s.manual) { s.manualDay = integer(raw.manualDay) ? raw.manualDay : null;
        if (object(raw.basis)) s.basis = { date: text(raw.basis.date), label: text(raw.basis.label), baseDay: integer(raw.basis.baseDay) ? raw.basis.baseDay : 0, numbered: raw.basis.numbered === true,
            ...(cleanLink(raw.basis.link) ? { link: cleanLink(raw.basis.link) } : {}) };
    }
    if (!s.manual && s.op !== 'same' && !s.verified) return stampUnknown(s);
    return s;
}
export function cleanStoryTime(raw) {
    if (!object(raw)) return undefined;
    return { mode: raw.mode === 'flashback' ? 'flashback' : 'present', origin: text(raw.origin, 1200) || null,
        ...(integer(raw.rules) && raw.rules > 0 ? { rules: raw.rules } : {}),
        start: cleanStamp(raw.start), end: cleanStamp(raw.end),
        ...(Array.isArray(raw.via) && raw.via.length <= 200 ? { via: raw.via.map(cleanStamp) } : {}) };
}
// "2026-10-25 (Sun)", "2026-10-25 Sun.", "2026-10-25 (일요일)" -> "2026-10-25". Info boxes often add a
// weekday; it is a label, not a different calendar. Only a valid ISO date is shortened.
const WEEKDAY = '(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?\\.?|[일월화수목금토](?:요일)?';
const WEEKDAY_DATE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\s*(?:[(\\[（]\\s*(?:${WEEKDAY})\\s*[)\\]）]|,?\\s*(?:${WEEKDAY}))$`, 'i');
export function normalizeStoryDate(date) {
    const s = String(date ?? '').trim(), m = s.match(WEEKDAY_DATE);
    return m && isoDay(m[1]) !== null ? m[1] : s;
}
// "2026-02-30" or "2026-02-30 (Mon)": shaped like a real date but not one. Never stored as a custom calendar.
function impossibleDate(date) {
    const s = String(date ?? '').trim(), m = s.match(WEEKDAY_DATE);
    return (/^\d{4}-\d{2}-\d{2}$/.test(s) && isoDay(s) === null) || (!!m && isoDay(m[1]) === null);
}
const stampIso = (stamp, anchors) => known(stamp) ? isoDay(dateAt(stamp, anchors)) : null;
function isoDay(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return null;
    const ms = Date.parse(s + 'T00:00:00Z');
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s ? ms / 86400000 : null;
}
// A date the user linked to an undated reference: `date` is the calendar day of reference day `day`.
function cleanLink(raw) {
    return object(raw) && isoDay(text(raw.date)) !== null && integer(raw.day) ? { date: text(raw.date), day: raw.day } : null;
}
// `linked` = also use a date the user linked to an undated reference. Only display and deadlines do;
// reading the story's own time claims never does, so a link cannot overrule a date in the text.
export function dateAt(stamp, anchors = {}, linked = false) {
    if (!known(stamp)) return '';
    const a = anchors[stamp.anchor]; if (!a) return '';
    if (linked && !a.date && a.link) {
        const d = new Date((isoDay(a.link.date) + (stamp.day ?? a.baseDay) - a.link.day) * 86400000);
        const result = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
        return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : '';
    }
    const day = isoDay(a.date), delta = (stamp.day ?? a.baseDay) - a.baseDay;
    if (day !== null) {
        const d = new Date((day + delta) * 86400000);
        const result = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
        return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : '';
    }
    // Custom calendars are never fed to JavaScript Date or advanced by invented month lengths.
    return delta === 0 ? a.date : '';
}
// Short time expressions are common. Literal quotes need at least two letters/numbers;
// keep the shared minimum for fuzzy/format-normalized matching and promise checks.
function timeQuoteMatches(source, quote, quoteMatches) {
    return typeof source === 'string' && (quote.match(/[\p{L}\p{N}]/gu) || []).length >= 2 &&
        (source.includes(quote) || (typeof quoteMatches === 'function' && !!quoteMatches(source, quote)));
}
// This checks an exact day COUNT, not whether the narration has actually reached it.
// Future appointments, recollections and negations still require model interpretation.
// Reads the elapsed-day counts stated in a quote, or null when the wording is approximate,
// a range or otherwise not an exact count. Shared by advances and promise deadlines.
function readElapsed(quote) {
    const q = String(quote || '').toLowerCase().replace(/[*_`]/g, '');
    if (/(?:대략|약\s*(?:\d|한|일주일|보름)|며칠|몇\s*(?:일|날|주)|\b(?:about|roughly|approximately|several|few|half|quarter)\b|(?:일|주)\s*반)|\d+\s*[-–~]\s*\d+\s*(?:일|주|days?|weeks?|fortnights?)/i.test(q)) return null;
    // Approximate wording ("일주일쯤", "이틀 정도", "거의 사흘", "nearly two days") is not an exact count.
    const unit = '(?:날|일|틀|흘|새|레|름|주|드레|흐레)';
    if (new RegExp(`쯤|정도|가량|남짓|얼추|거의|안팎|${unit}\\s*(?:넘게|넘어|이상|이내|여(?=[\\s,.만후뒤]|$))|\\b(?:nearly|almost|around|more\\s+than|less\\s+than|or\\s+so|give\\s+or\\s+take|(?:just\\s+)?(?:over|under)\\s+(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\\d+))\\b`, 'i').test(q)) return null;
    const number = '(?:a|one|two|three|four|five|six|seven|eight|nine|ten|\\d+)';
    if (new RegExp('\\b' + number + '\\s*(?:to|[-–~])\\s*' + number + '\\s*(?:days?|weeks?|fortnights?)\\b').test(q)) return null;
    // These extended expressions do not mean one day; leave them for an explicit date.
    if (/\bday\s+after\s+(?:tomorrow|next)\b/.test(q)) return null;
    const counts = [], ko = { '다음날': 1, '그다음날': 1, '바로다음날': 1, '이튿날': 1, '익일': 1, '하루': 1, '이틀': 2, '사흘': 3, '나흘': 4, '닷새': 5, '엿새': 6, '이레': 7, '여드레': 8, '아흐레': 9, '열흘': 10, '일주일': 7, '한주': 7, '보름': 15 };
    const en = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const re = /(?:그|바로)?다음\s*날|이튿날|익일|하루|이틀|사흘|나흘|닷새|엿새|이레|여드레|아흐레|열흘|일주일|한\s*주|보름|(?<!\d)(\d+)\s*(일|주)|\b(?:next|following)\s+(?:day|morning|evening|night)\b|\bday\s+after\b|\b(a|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:(?:full|whole)\s+)?(days?|weeks?|fortnights?)\b/g;
    for (const m of q.matchAll(re)) {
        const before = q.slice(0, m.index), after = q.slice(m.index + m[0].length);
        // Do not read the tail of a compound number or a past-time expression.
        const numeric = m[1] !== undefined || /^\d+$/.test(m[3] || '');
        if (/[\p{L}\p{N}-]$/u.test(before) || (numeric && /[.,]$/.test(before)) || /\b(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\s+$/.test(before)) continue;
        if (/^\s*(?:전|이전|ago\b|earlier\b|before\b)/.test(after)) continue;
        const token = m[0].replace(/\s/g, '');
        const count = ko[token] ?? (m[1] ? Number(m[1]) * (m[2] === '주' ? 7 : 1)
            : m[3] ? (en[m[3]] ?? Number(m[3])) * (m[4].startsWith('week') ? 7 : m[4].startsWith('fortnight') ? 14 : 1) : 1);
        counts.push(count);
    }
    return counts;
}
function advanceQuoteMatches(quote, days) {
    if (!integer(days) || days < 0) return false;
    const counts = readElapsed(quote);
    // Exactly one elapsed-time expression: "다음 날 밤과 그다음 날" is two steps, not one.
    return !!counts && counts.length === 1 && counts[0] === days;
}
// A deadline counted from the moment a promise was made: "내일", "모레", "사흘 뒤", "by tomorrow".
// Only one exact count is accepted; "내일모레", "며칠 안에", "이번 주말" keep their words only.
const DUE_WORDS = [[/내일\s*모레/, null], [/글피/, 3], [/모레/, 2], [/내일/, 1], [/오늘\s*(?:밤|저녁|안|중)?/, 0],
    [/\bthe\s+day\s+after\s+tomorrow\b/, 2], [/\btomorrow\b/, 1], [/\b(?:today|tonight|this\s+(?:evening|night))\b/, 0]];
export function dueDaysMatch(expr, days) {
    if (!integer(days) || days < 0) return false;
    let q = String(expr || '').toLowerCase().replace(/[*_`]/g, '');
    const counts = [];
    for (const [re, n] of DUE_WORDS) {
        const g = new RegExp(re.source, 'g');
        if (!g.test(q)) continue;
        if (n === null) return false;
        q = q.replace(new RegExp(re.source, 'g'), m => { counts.push(n); return ' '.repeat(m.length); });
    }
    const rest = readElapsed(q);
    if (!rest) return false;
    counts.push(...rest);
    return counts.length === 1 && counts[0] === days;
}
function claimFromModel(raw, { chunk, seg, room, quoteMatches }) {
    if (raw === undefined || raw === null) return { op: 'same', date: '', period: '', clock: '', days: null, elapsed: '', evidence: null, verified: false, manual: false };
    if (!object(raw)) return { op: 'unknown' };
    const op = ['same', 'explicit', 'advance', 'jump', 'unknown'].includes(raw.relation) ? raw.relation : 'unknown';
    const n = typeof raw.msg === 'string' && /^#?\d+$/.test(raw.msg) ? Number(raw.msg.replace('#', '')) : raw.msg;
    const quote = text(raw.quote, 2000), source = chunk.texts?.[n];
    const verified = Number.isInteger(n) && n >= seg.from && n <= seg.to && chunk.indices.includes(n) &&
        timeQuoteMatches(source, quote, quoteMatches);
    const date = normalizeStoryDate(text(raw.date)), period = PERIODS.includes(raw.period) ? raw.period : '', at = clock(raw.clock);
    const s = { op, date, period, clock: at, days: integer(raw.days) && raw.days >= 0 ? raw.days : null, elapsed: text(raw.elapsed),
        evidence: verified ? { room: room || null, msg: n, quote } : null, verified, manual: false };
    // An absent mention inherits; an unsupported claim cannot masquerade as inheritance.
    if (op === 'same' && (date || period || at) && !verified) s.op = 'unknown';
    if (date && impossibleDate(date)) s.op = 'unknown';
    if (date && (!verified || !timeQuoteMatches(quote, date, quoteMatches))) s.op = 'unknown';
    if (op !== 'same' && op !== 'unknown' && !verified) s.op = 'unknown';
    if (op === 'advance' && !advanceQuoteMatches(quote, s.days)) s.op = 'unknown';
    return s;
}
// `floor` is the ISO day of the last confirmed present time, which an unconfirmed gap in between
// does not erase: the present still cannot move to an earlier calendar date.
function resolveStamp(claim, previous, anchors, key, mode, floor = null) {
    if (claim.date) claim = { ...claim, date: normalizeStoryDate(claim.date) };
    const s = { ...claim, anchor: null, day: null, certainty: 'unconfirmed' };
    if (!claim.manual && claim.date && impossibleDate(claim.date)) return s;
    const anchor = (kind, date = '', label = '', day = 0) => {
        // A date the user linked to this reference survives re-reading.
        const link = anchors[key]?.link;
        anchors[key] = { kind, date, label, baseDay: day ?? 0, numbered: kind === 'record', counted: kind === 'manual' && integer(day), ...(link && !date ? { link } : {}) }; s.anchor = key; s.day = day;
    };
    if (claim.manual && claim.op === 'manual') {
        const day = integer(claim.manualDay) ? claim.manualDay : null;
        const current = anchors[key];
        anchor('manual', claim.date, claim.elapsed, day);
        if (!claim.date && claim.basis) {
            // The basis is a copy taken when the time was edited. A date linked (or unlinked) to this
            // reference afterwards is newer, so the reference's current state wins over the copy.
            const { link: copied, ...basis } = claim.basis;
            const link = current ? current.link : copied;
            anchors[key] = { ...basis, kind: 'manual', counted: integer(day), ...(link ? { link } : {}) };
        }
        s.certainty = 'manual'; return s;
    }
    if (claim.op === 'unknown') return s;
    if (claim.op === 'same') {
        // "Same" that quotes its own date or time (an info box on every reply) does not need the
        // previous part: an unconfirmed gap before it must not spread, and a different quoted
        // date is read as that date. The explicit rules (no backward date) still apply.
        // Only what the quote itself shows is revived: a date quoted verbatim, a clock whose digits
        // appear in the quote. A time band alone or a clock without a date never creates a date.
        const quote = claim.evidence?.quote || '';
        const clockShown = !!claim.clock && quote.replace(/\s/g, '').includes(claim.clock.replace(/\s/g, ''));
        const stated = claim.verified && claim.evidence && (claim.date || clockShown);
        const before = known(previous) && anchors[previous.anchor] ? dateAt(previous, anchors) : null;
        if (stated && (before === null || (claim.date && claim.date !== before)))
            return resolveStamp({ ...claim, op: 'explicit', clock: clockShown ? claim.clock : '', period: claim.date || clockShown ? claim.period : '' }, previous, anchors, key, mode, floor);
        if (!previous && mode === 'present') { anchor('record'); s.certainty = 'linked'; }
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
        s.anchor = previous.anchor; s.day = (previous.day ?? anchors[previous.anchor].baseDay) + claim.days; s.certainty = 'linked';
        if (!integer(s.day)) return stampUnknown(claim);
        // A new day does not inherit yesterday's exact clock or time band.
        return s;
    }
    if (claim.op === 'explicit') {
        if (!claim.date && !claim.period && !claim.clock) return s;
        if (claim.date) {
            const oldDate = dateAt(previous, anchors), oldDay = isoDay(oldDate), newDay = isoDay(claim.date);
            // A quoted letter or recalled date cannot silently turn the present backward.
            // Keep the claim for review; only acted flashbacks and manual edits may do that.
            // An undated reference (a clock-only time, a vague jump) does not lift the floor either.
            const limit = oldDay ?? floor;
            if (mode !== 'flashback' && limit !== null && newDay !== null && newDay < limit) return s;
            if (known(previous) && oldDate && claim.date === oldDate) { s.anchor = previous.anchor; s.day = previous.day; }
            else if (known(previous) && oldDay !== null && newDay !== null) { s.anchor = previous.anchor; s.day = (previous.day ?? anchors[previous.anchor].baseDay) + newDay - oldDay; }
            else anchor('explicit', claim.date);
        } else if (known(previous) && anchors[previous.anchor]) { s.anchor = previous.anchor; s.day = previous.day; }
        else anchor(!previous && mode === 'present' ? 'record' : 'explicit');
        s.certainty = 'explicit'; return s;
    }
    return s;
}
const parts = mem => (mem.scenes || []).flatMap(s => s.segs || []);
const edges = t => [t.start, ...(t.via || []), t.end].filter(Boolean);
function presentFloor(mem) {
    let floor = null;
    for (const g of parts(mem)) if (g.time?.mode === 'present') for (const x of edges(g.time)) floor = stampIso(x, mem.timeAnchors || {}) ?? floor;
    return floor;
}
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
    const time = { mode, origin: room, rules: TIME_RULES, start: null, end: null };
    const invalid = raw !== undefined && (!object(raw) || (raw.mode !== undefined && !['present', 'flashback'].includes(raw.mode)));
    mem.timeAnchors ||= {};
    const options = { chunk, seg, room, quoteMatches };
    const steps = object(raw) && Array.isArray(raw.parts) && raw.parts.length <= 100 ? raw.parts.flatMap(p =>
        p === undefined ? [undefined, undefined] : object(p) ? [p.start, p.end] : [{ relation: 'unknown' }, { relation: 'unknown' }]) : [raw?.start, raw?.end];
    let prior = prev, floor = mode === 'present' ? presentFloor(mem) : null;
    const resolved = steps.map((step, i) => {
        const stamp = resolveStamp(invalid ? { op: 'unknown' } : claimFromModel(step, options), prior, mem.timeAnchors, idFor(time, seg, i === 0 ? 'start' : i === steps.length - 1 ? 'end' : 'via' + i), mode, floor);
        if (mode === 'present') floor = stampIso(stamp, mem.timeAnchors) ?? floor;
        prior = stamp; return stamp;
    });
    time.start = resolved[0] || stampUnknown({ op: 'unknown' }); time.end = resolved[resolved.length - 1] || time.start;
    if (resolved.length > 2) time.via = resolved.slice(1, -1);

    return time;
}
// Re-resolve only recorded claims. No historical quote is looked up in this room's chat.
export function recomputeStoryTimes(mem, { fromSegment = null, edge = 'start', revive = false } = {}) {
    mem.timeAnchors = cleanTimeAnchors(mem.timeAnchors);
    let present = null, flashback = null, wasFlashback = false, floor = null;
    let active = fromSegment === null;
    const remember = t => {
        if (t.mode === 'present') { present = t.end; for (const x of edges(t)) floor = stampIso(x, mem.timeAnchors) ?? floor; }
        else flashback = t.end;
        wasFlashback = t.mode === 'flashback';
    };
    // revive (one-time upgrade only): an unconfirmed boundary whose own claim quotes a date or a
    // clock may be read again; plain inherited gaps stay as they were.
    // Only parts saved under older rules (no `rules` mark) are revived: a part already read with the
    // current rules keeps its verdict, e.g. a backward date blocked when the earlier scene still existed.
    let reviveThis = false;
    const standsAlone = c => reviveThis && !c.manual && c.verified && c.evidence && (c.op === 'explicit' || (c.op === 'same' && (c.date || c.clock)));
    for (const g of parts(mem)) {
        if (!g.time) continue;
        if (g.id === fromSegment) active = true;
        // A manual edit cannot reinterpret an earlier saved boundary or revive an
        // earlier unconfirmed claim just because its preceding scene was deleted.
        if (!active) { remember(g.time); continue; }
        reviveThis = revive && !(g.time.rules >= TIME_RULES);
        const t = cleanStoryTime(g.time); g.time = t;
        if (revive) t.rules = TIME_RULES;
        const previous = t.mode === 'flashback' ? wasFlashback ? flashback : null : present;
        const keepStart = g.id === fromSegment && edge === 'end';
        // A deleted prefix is not a new story beginning. Its anchor remains a valid
        // boundary snapshot for the first retained part, including an already-applied
        // advance. A newly edited start has no resolved anchor and is recalculated.
        // Upgrade only: a first boundary that quotes a calendar date but was kept as "recording day 1"
        // (older versions ignored the date of a first "same") is read as that date instead.
        const datedRecord = standsAlone(t.start) && !!t.start.date && known(t.start) && mem.timeAnchors[t.start.anchor]?.kind === 'record';
        const keepBoundary = !previous && !datedRecord && ((known(t.start) && mem.timeAnchors[t.start.anchor]) ||
            (!t.start.manual && t.start.certainty === 'unconfirmed' && !standsAlone(t.start)));
        const at = t.mode === 'present' ? floor : null;
        if (!keepStart && !keepBoundary)
            t.start = resolveStamp(t.start, previous, mem.timeAnchors, idFor(t, g, 'start'), t.mode, at);
        let mid = t.start, low = t.mode === 'present' ? stampIso(t.start, mem.timeAnchors) ?? at : null;
        if (t.via) t.via = t.via.map((claim, i) => { mid = keepStart ? claim : resolveStamp(claim, mid, mem.timeAnchors, idFor(t, g, 'via' + (i + 1)), t.mode, low); if (t.mode === 'present') low = stampIso(mid, mem.timeAnchors) ?? low; return mid; });
        t.end = resolveStamp(t.end, mid, mem.timeAnchors, idFor(t, g, 'end'), t.mode, low);
        remember(t);
    }
}
// Upgrade of parts saved before these rules (weekday dates, quoted "same", dated first parts). Each
// part carries the rules it was read with, so a part brought back by undoing an old edit is upgraded
// again, while a part already read with these rules keeps its verdict. Re-reading recalculates from
// the saved claims, so elapsed days are never added twice. It only adds confirmation: if it would
// lose a confirmed time or change a manual one, the times stay as they were (only marked).
export const TIME_RULES = 2;
export function upgradeStoryTimes(mem) {
    const old = parts(mem).filter(g => g.time && !(g.time.rules >= TIME_RULES));
    if (!old.length) return false;
    const trial = structuredClone({ scenes: mem.scenes, timeAnchors: mem.timeAnchors || {} });
    recomputeStoryTimes(trial, { revive: true });
    const before = parts(mem).flatMap(g => g.time ? edges(g.time) : []), after = parts(trial).flatMap(g => g.time ? edges(g.time) : []);
    const safe = before.length === after.length && before.every((x, i) =>
        (!known(x) || known(after[i])) && (!x.manual || JSON.stringify(x) === JSON.stringify(after[i])));
    if (safe) { mem.scenes = trial.scenes; mem.timeAnchors = trial.timeAnchors; }
    else for (const g of old) g.time.rules = TIME_RULES;
    return true;
}
export function editStoryTime(mem, segmentId, values, room = null) {
    const g = parts(mem).find(x => x.id === segmentId); if (!g) return false;
    const existing = cleanStoryTime(g.time), origin = existing?.origin || g.source?.room || room;
    const edge = values.edge === 'start' ? 'start' : 'end';
    const day = values.day === '' || values.day === undefined ? existing?.[edge]?.day ?? null : Number(values.day) - 1;
    if (day !== null && (!integer(day) || day < 0)) throw new Error('기준 일 수는 1 이상의 정수로 입력해 주세요.');
    const date = normalizeStoryDate(text(values.date)), period = PERIODS.includes(values.period) ? values.period : '', at = clock(values.clock);
    if (impossibleDate(date)) throw new Error('ISO 날짜가 유효하지 않아요. 작품 고유 달력은 이름을 포함해 적어 주세요.');
    if (values.clock && !at) throw new Error('시각은 00:00–23:59 형식으로 입력해 주세요.');
    if (typeof values.date === 'string' && values.date.trim().length > 180) throw new Error('날짜 표현은 180자 이내로 입력해 주세요.');
    const manual = { op: 'manual', manual: true, verified: false, manualDay: day, date, period, clock: at, days: null, elapsed: '', evidence: null };
    const basis = mem.timeAnchors?.[existing?.[edge]?.anchor];
    if (basis) manual.basis = { ...basis };
    g.time = { mode: values.mode === 'flashback' ? 'flashback' : 'present', origin, ...(existing?.rules ? { rules: existing.rules } : {}),
        start: existing?.start || { op: 'same' }, ...(existing?.via ? { via: existing.via } : {}), end: existing?.end || { op: 'same' } };
    g.time[edge] = manual;
    recomputeStoryTimes(mem, { fromSegment: segmentId, edge }); return true;
}
export function formatStoryStamp(stamp, anchors = {}, lang = 'en') {
    const ko = lang === 'ko';
    if (!stamp || !known(stamp) || !anchors[stamp.anchor]) return ko ? '시간 미확인' : 'unknown story time (unconfirmed)';
    return [stampLabel(stamp, anchors, lang), stamp.period ? ko ? KO[stamp.period] : stamp.period : '', stamp.clock].filter(Boolean).join(' · ');
}
// The date part of a confirmed stamp: a calendar date, a day of a reference, or the reference's own words.
function stampLabel(stamp, anchors, lang) {
    const ko = lang === 'ko';
    const a = anchors[stamp.anchor], date = dateAt(stamp, anchors, true), offset = integer(stamp.day) ? stamp.day - a.baseDay : null, n = stamp.day + 1;
    let label = date;
    if (!label && a.date && offset !== null) label = `${a.date} ${offset >= 0 ? '+' : ''}${offset}${ko ? '일' : ' days'}`;
    if (!label && a.numbered && integer(stamp.day)) label = ko ? `기록 기준 ${n}일째` : `recording day ${n}`;
    if (!label && a.counted && integer(stamp.day)) label = ko ? `직접 지정 기준 ${n}일째` : `day ${n} of the manually set reference`;
    if (!label) {
        label = a.label || (ko ? '날짜 미상' : 'unknown date');
        if (offset !== null && offset > 0) label += ` · ${offset === 1 ? ko ? '이튿날' : 'next day' : ko ? `해당 기준 ${offset + 1}일째` : `day ${offset + 1} of this reference`}`;
    }
    return label;
}
// The date part and the time-of-day part of one stamp, plus what identifies "the same day of the
// same reference". Used to write a scene's times without repeating its date in every part.
function stampParts(stamp, anchors, lang = 'en') {
    const ko = lang === 'ko';
    if (!stamp || !known(stamp) || !anchors[stamp.anchor]) return { known: false, date: ko ? '시간 미확인' : 'time unconfirmed', time: '', key: null };
    return { known: true, date: stampLabel(stamp, anchors, lang), time: [stamp.period ? ko ? KO[stamp.period] : stamp.period : '', stamp.clock].filter(Boolean).join(' '), key: `${stamp.anchor}|${stamp.day}` };
}
// For the injection: a scene's time once in its head, and each part only with what changed.
// The date is written again whenever it changes, after an unconfirmed time, at a flashback, and
// when the reference changes (a different anchor), since the earlier date must not be assumed there.
export function compactSceneTimes(scene, anchors = {}) {
    const timed = (scene.segs || []).filter(g => g.time), labels = new Map();
    if (!timed.length) return { head: '', labels };
    let ctx = null;
    // One stamp: its time of day only when it continues the same day of the same reference.
    const one = (stamp, mode) => {
        const p = stampParts(stamp, anchors), same = !!(p.known && ctx && ctx.key === p.key && ctx.mode === mode);
        ctx = p.known ? { key: p.key, mode } : null;
        return { ...p, same, text: same ? p.time : [p.date, p.time].filter(Boolean).join(' ') };
    };
    const range = g => {
        const flash = g.time.mode === 'flashback';
        if (flash) ctx = null;
        const a = one(g.time.start, g.time.mode), b = one(g.time.end, g.time.mode);
        if (flash) ctx = null;
        let text;
        if (!b.text || (b.same && b.time === a.time)) text = a.text;            // ends where it started
        else if (b.same) text = a.text ? `${a.text}–${b.text}` : b.text;          // same day: 10:00–11:30
        else text = a.text ? `${a.text} → ${b.text}` : `→ ${b.text}`;              // another day or reference
        return text ? (flash ? 'flashback ' : '') + text : '';
    };
    if (timed.length === 1) return { head: range(timed[0]), labels };
    // Head: the date span of the PRESENT parts only, so a flashback never looks like time running
    // backwards; a scene that has flashbacks says so. The first part continues from the head's date.
    const present = timed.filter(g => g.time.mode !== 'flashback'), span = present.length ? present : timed;
    const first = stampParts(span[0].time.start, anchors), last = stampParts(span[span.length - 1].time.end, anchors);
    const dates = first.date === last.date && first.key === last.key ? first.date : `${first.date} → ${last.date}`;
    const head = !present.length ? `flashback ${dates}` : present.length < timed.length ? `${dates} · includes flashback` : dates;
    ctx = first.known && timed[0].time.mode !== 'flashback' ? { key: first.key, mode: 'present' } : null;
    for (const g of timed) { const t = range(g); if (t) labels.set(g.id, t); }
    return { head, labels };
}
// ───────── timeline (screen only; nothing here is injected) ─────────
// Which time reference a confirmed stamp belongs to. Real calendar dates form one line; a recording
// day count, a vague jump, a manual count and a custom calendar each stay separate, never merged.
function referenceOf(stamp, anchors) {
    const a = anchors[stamp.anchor];
    if (isoDay(dateAt(stamp, anchors)) !== null) return { key: 'dated', label: '실제 날짜' };
    const own = { key: 'ref:' + stamp.anchor, anchor: stamp.anchor, linkable: !a.date, link: a.link || null };
    if (a.kind === 'record' && a.numbered) return { ...own, label: '기록 기준' };
    if (a.kind === 'jump') return { ...own, label: `“${a.label}” 이후` };
    if (a.counted) return { ...own, label: '직접 지정한 기준' };
    return { ...own, label: a.date ? `${a.date} 기준` : '날짜 미상 기준' };
}
// Link a calendar date to an undated reference: reference day `day` (0-based) is `date`. Saved
// days and message numbers stay; only display and deadlines read it. '' removes the link.
export function linkReference(mem, anchor, date, day) {
    const a = mem.timeAnchors?.[anchor];
    if (!a) throw new Error('그 시간 기준을 찾지 못했어요.');
    if (a.date) throw new Error('이미 날짜가 있는 기준이에요. 원문 날짜는 바꿀 수 없어요.');
    const d = String(date ?? '').trim();
    if (!d) { delete a.link; return true; }
    if (isoDay(normalizeStoryDate(d)) === null) throw new Error('날짜는 YYYY-MM-DD 형식의 실제 날짜로 입력해 주세요.');
    if (!integer(day)) throw new Error('연결할 날을 찾지 못했어요.');
    a.link = { date: normalizeStoryDate(d), day };
    return true;
}
// Where linked dates and dates from the text disagree: the present going back to an earlier day
// across a linked reference. Reported, never changed.
export function linkConflicts(mem) {
    const anchors = mem.timeAnchors || {}, out = [];
    let last = null;
    for (const g of parts(mem)) {
        if (g.time?.mode !== 'present') continue;
        for (const x of edges(g.time)) {
            const iso = known(x) ? isoDay(dateAt(x, anchors, true)) : null;
            if (iso === null) continue;
            const linked = !!anchors[x.anchor]?.link;
            if (last && iso < last.iso && (linked || last.linked)) out.push({ segId: g.id, date: dateAt(x, anchors, true), before: last.date, beforeSeg: last.segId });
            last = { iso, linked, date: dateAt(x, anchors, true), segId: g.id };
        }
    }
    return out;
}
// Every part in record order. Unknown times stay in place (no reference of their own); a flashback
// is marked and does not change the present reference.
export function timelineRows(mem) {
    const anchors = mem.timeAnchors || {}, rows = [];
    for (const scene of mem.scenes || []) for (const g of scene.segs || []) {
        const row = { sceneId: scene.id, segId: g.id, from: g.from ?? null, to: g.to ?? null, flashback: g.time?.mode === 'flashback', timed: !!g.time,
            unknown: !g.time || g.time.start?.certainty === 'unconfirmed' || g.time.end?.certainty === 'unconfirmed', day: null, ref: null, time: '' };
        if (!g.time) { row.time = '시간 정보 없음'; rows.push(row); continue; }
        const a = stampParts(g.time.start, anchors, 'ko'), b = stampParts(g.time.end, anchors, 'ko');
        const lead = a.known ? g.time.start : b.known ? g.time.end : null;
        if (lead) { row.day = { key: (a.known ? a : b).key, label: (a.known ? a : b).date, index: lead.day }; row.ref = referenceOf(lead, anchors); }
        row.time = row.flashback || !(a.known && b.known && a.key === b.key)
            ? formatSegmentTime(g.time, anchors, 'ko')
            : a.time && b.time && a.time !== b.time ? `${a.time}–${b.time}` : a.time || b.time || '';
        rows.push(row);
    }
    return rows;
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

// ───────── promise and debt deadlines ─────────
// A deadline keeps the original words ("내일", "by Friday"). It is placed on the story timeline only
// when the moment the promise was made is certain: the part that holds it sits on one known day of
// one reference, and the words give one exact count of days from then. A deadline that has passed is
// "past due as of the last record"; it never means the promise was broken.
export function cleanDue(raw) {
    if (!object(raw)) return undefined;
    const expr = text(raw.expr, 200), date = text(raw.date);
    const manual = object(raw.manual) ? { anchor: typeof raw.manual.anchor === 'string' && raw.manual.anchor.startsWith('t:') ? raw.manual.anchor : null,
        day: integer(raw.manual.day) ? raw.manual.day : null } : null;
    if (!expr && !date && !(manual && manual.anchor && manual.day !== null)) return undefined;
    return { expr, date, days: integer(raw.days) && raw.days >= 0 ? raw.days : null,
        seg: typeof raw.seg === 'string' && /^g\d+$/.test(raw.seg) ? raw.seg : null,
        room: text(raw.room, 1200) || null, msg: Number.isInteger(raw.msg) && raw.msg >= 0 ? raw.msg : null,
        ...(manual && manual.anchor && manual.day !== null ? { manual } : {}) };
}
// From a model's {"expr","days","date","msg"}: the words must be in that message, and a day count
// is kept only when the words state exactly that count. Anything else keeps the words alone.
export function resolveDueClaim(raw, { chunk, room = null, segOf }) {
    if (!object(raw)) return undefined;
    const n = typeof raw.msg === 'string' && /^#?\d+$/.test(raw.msg) ? Number(raw.msg.replace('#', '')) : raw.msg;
    const expr = text(raw.expr, 200), source = chunk.texts?.[n];
    if (!expr || !Number.isInteger(n) || !chunk.indices.includes(n) || !timeQuoteMatches(source, expr)) return undefined;
    const days = integer(raw.days) && raw.days >= 0 && dueDaysMatch(expr, raw.days) ? raw.days : null;
    const date = text(raw.date) && timeQuoteMatches(expr, text(raw.date)) ? text(raw.date) : '';
    return cleanDue({ expr, days, date, seg: segOf(n), room, msg: n });
}
// The moment a promise was made: only a part that stays on one known day of one reference.
function madeAt(mem, segId) {
    const g = parts(mem).find(x => x.id === segId);
    const t = g?.time;
    if (!t || t.mode === 'flashback') return null;
    const stamps = [t.start, ...(t.via || []), t.end];
    if (!stamps.every(x => known(x) && mem.timeAnchors?.[x.anchor])) return null;
    // One day: the same day of one reference, or the same real calendar date (ISO) on any references.
    const iso = isoOf(mem, stamps[0]);
    const sameDay = x => (x.anchor === stamps[0].anchor && dayOn(mem, x) === dayOn(mem, stamps[0])) || (iso !== null && isoOf(mem, x) === iso);
    if (!stamps.every(sameDay)) return null;
    return { ...stamps[0], day: dayOn(mem, stamps[0]) };
}
const isoOf = (mem, x) => isoDay(dateAt(x, mem.timeAnchors || {}, true));
// A confirmed stamp without its own day count sits on its reference's base day (a dated manual edit).
const dayOn = (mem, x) => integer(x.day) ? x.day : mem.timeAnchors?.[x.anchor]?.baseDay ?? null;
export function dueStamp(mem, r) {
    const due = r?.due; if (!due) return null;
    if (due.manual) {
        if (!mem.timeAnchors?.[due.manual.anchor]) return null;
        const at = { anchor: due.manual.anchor, day: due.manual.day, certainty: 'manual' }, iso = isoOf(mem, at);
        return iso !== null ? { ...at, iso } : at;
    }
    const base = due.seg ? madeAt(mem, due.seg) : null;
    if (!base) return null;
    const from = isoOf(mem, base), to = isoDay(due.date);
    if (due.days !== null) return { anchor: base.anchor, day: base.day + due.days, certainty: 'linked', ...(from !== null ? { iso: from + due.days } : {}) };
    if (from !== null && to !== null) return { anchor: base.anchor, day: base.day + (to - from), certainty: 'linked', iso: to };
    return null;
}
// 'left' | 'today' | 'past' (as of the last record) | 'check' (cannot be compared) | 'words' (no
// day could be placed) | null (no deadline, or the promise is no longer open).
export function dueStatus(mem, r) {
    if (!r?.due || r.status !== 'open') return null;
    const due = dueStamp(mem, r);
    if (!due) return { kind: 'words' };
    const now = lastStoryTime(mem)?.stamp;
    let left = null;
    if (known(now) && now.anchor === due.anchor && integer(dayOn(mem, now))) left = due.day - dayOn(mem, now);
    // Real calendar dates can be compared across references; local day counts cannot.
    else if (known(now) && due.iso !== undefined && isoOf(mem, now) !== null) left = due.iso - isoOf(mem, now);
    if (left === null) return { kind: 'check', due };
    return { kind: left > 0 ? 'left' : left === 0 ? 'today' : 'past', left, due };
}
export function formatDue(mem, r, lang = 'en') {
    const ko = lang === 'ko', due = r?.due; if (!due) return '';
    const words = due.expr ? `“${due.expr}”` : due.date;
    const stamp = dueStamp(mem, r), at = stamp ? formatStoryStamp({ ...stamp, period: '', clock: '' }, mem.timeAnchors, lang) : '';
    const st = dueStatus(mem, r);
    const head = ko ? `기한 ${[words, at && `(${at})`].filter(Boolean).join(' ')}` : `due ${[words, at && `(${at})`].filter(Boolean).join(' ')}`;
    if (!st) return head;
    if (st.kind === 'words') return head + (ko ? ' · 날짜로 계산할 수 없어요' : ', not placed on the story timeline');
    if (st.kind === 'check') return head + (ko ? ' · 확인 필요 (지금 시간과 비교할 수 없어요)' : ', cannot be compared with the current story time');
    if (st.kind === 'left') return head + (ko ? ` · ${st.left}일 남음 (마지막 기록 기준)` : `, ${st.left} day${st.left === 1 ? '' : 's'} left as of the last record`);
    if (st.kind === 'today') return head + (ko ? ' · 오늘이 기한 (마지막 기록 기준)' : ', due today as of the last record');
    return head + (ko ? ` · 기한 지남 (마지막 기록 기준, 약속을 어겼다는 뜻은 아니에요)` : `, past due by ${-st.left} day${st.left === -1 ? '' : 's'} as of the last record (not necessarily broken)`);
}
// Manual deadline: a day on the reference of the last recorded story time, or cleared (null).
export function setManualDue(mem, r, { day, expr } = {}) {
    const now = lastStoryTime(mem)?.stamp;
    // expr undefined = the words were not edited; '' = the user erased them.
    const words = expr === undefined ? undefined : text(expr, 200);
    const reword = due => {
        // New or erased words replace the AI's reading of the old ones.
        if (words === undefined || words === (due.expr || '')) return due;
        return { ...due, expr: words, days: null, date: '' };
    };
    if (day === null || day === undefined || day === '') {
        if (!r.due && !words) return true;
        const due = reword({ ...(r.due || { date: '', days: null, seg: null, room: null, msg: null, expr: '' }) });
        delete due.manual;
        if (!due.expr && !due.date) delete r.due; else r.due = due;
        return true;
    }
    if (!known(now) || !mem.timeAnchors?.[now.anchor]) throw new Error('지금 이야기 시간이 확인되지 않아서 기한 일 수를 지정할 수 없어요. 먼저 구간 시간을 직접 지정해 주세요.');
    let n;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(day).trim())) {
        // A real calendar date, placed on the current reference when that reference is dated.
        // It may fall before the reference's first day: that is still a real (already passed) date.
        const to = isoDay(String(day).trim()), from = isoOf(mem, now);
        if (to === null) throw new Error('날짜가 유효하지 않아요.');
        if (from === null) throw new Error('지금 이야기 시간에 실제 날짜가 없어서 날짜로는 지정할 수 없어요. N일째로 입력해 주세요.');
        n = dayOn(mem, now) + (to - from);
    } else {
        n = Number(day) - 1;
        if (!integer(n) || n < 0) throw new Error('기한은 1 이상의 일 수나 YYYY-MM-DD 날짜로 입력해 주세요.');
    }
    r.due = { ...reword({ ...(r.due || { date: '', days: null, seg: null, room: null, msg: null, expr: '' }) }), manual: { anchor: now.anchor, day: n } };
    return true;
}
