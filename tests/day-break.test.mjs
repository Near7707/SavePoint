import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, normalizeResult, validateResult, dayBreaks, splitKeeps } from '../core.js';
import { linkReference, formatStoryStamp } from '../temporal.js';

// v0.7.5-a1: a scene kept across a new story day by the reply's own time stamps is asked to be split. Invented text only.
const line = (date, clock) => `📅 Date: ${date} | 🕒 Time: ${clock}`;
const msg = (date, clock, words = 'The courier waited by the gate.') => `${line(date, clock)}\n${words}`;
const at = (n, date, clock, period) => ({ relation: 'explicit', date, clock, period, msg: n, quote: line(date, clock) });
const chunkOf = (from, texts) => { const indices = texts.map((_, i) => from + i); return { from, to: indices.at(-1), indices, text: texts.join('\n'), texts: Object.fromEntries(texts.map((t, i) => [from + i, t])) }; };
const scene = (kind, n, time, extra = {}) => ({ scene: kind, title: 'A neutral scene', where: 'Station', who: [], outline: 'A courier waited.', notes: '', ended: false,
    points: [{ text: 'A courier waited.', kind: 'moment', key: false, msgs: [n] }], time: { mode: 'present', ...time }, ...extra });
function check(mem, chunk, scenes, opts = {}) {
    const d = { scenes, entities: [], changes: [] };
    normalizeResult(d, { mem, chunk });
    assert.deepEqual(validateResult(d, { mem, chunk }), []);
    const before = JSON.stringify(mem);
    const out = dayBreaks(d, { mem, chunk, ...opts });
    assert.equal(JSON.stringify(mem), before, 'the check writes nothing');
    return { out, d, save: () => applyResult(mem, d, chunk, { room: 'room-A' }).mem };
}
// A first part: the night of the 12th into the small hours of the 13th (an all-night scene).
function night() {
    const c = chunkOf(0, [msg('1024-04-12', '19:35'), msg('1024-04-13', '06:02')]);
    const r = check(emptyMem(), c, [scene('new', 0, { start: at(0, '1024-04-12', '19:35', 'night'), end: at(1, '1024-04-13', '06:02', 'dawn') })]);
    return { ...r, mem: r.save() };
}

test('midnight passing into dawn does not ask for a split', () => {
    assert.deepEqual(night().out, []);
});

// A first part within one day: the 13th, 10:00 to 11:00.
function day() {
    const c = chunkOf(0, [msg('1024-04-13', '10:00'), msg('1024-04-13', '11:00')]);
    const r = check(emptyMem(), c, [scene('new', 0, { start: at(0, '1024-04-13', '10:00', 'morning'), end: at(1, '1024-04-13', '11:00', 'morning') })]);
    return { mem: r.save() };
}

test('a continued scene that runs on for days is asked to split where the new day is shown', () => {
    const { mem } = night();
    const c = chunkOf(2, [msg('1024-04-13', '06:30'), msg('1024-04-14', '09:00'), msg('1024-04-16', '07:48')]);
    const { out } = check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-13', '06:30', 'dawn'), end: at(4, '1024-04-16', '07:48', 'morning') })]);
    assert.equal(out.length, 1);
    assert.match(out[0], /^scenes\[0\] \(#2-#4\) runs into a new story day/);
    assert.match(out[0], /1024-04-12.*→ 1024-04-16.*shown at #4/);
    assert.match(out[0], /"scene": "new", "start"/);
});

test('one day later in the morning (by the clock or by the time band) is a new day; the same day is not', () => {
    const { mem } = day();
    const c = chunkOf(2, [msg('1024-04-13', '12:30'), msg('1024-04-13', '21:10'), msg('1024-04-14', '07:48')]);
    assert.equal(check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-13', '12:30', 'day'), end: at(4, '1024-04-14', '07:48', 'morning') })]).out.length, 1);
    assert.deepEqual(check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-13', '12:30', 'day'), end: at(3, '1024-04-13', '21:10', 'night') })]).out, []);
    // 06:59 on the next day is still the small hours.
    const early = chunkOf(2, [msg('1024-04-13', '21:10'), msg('1024-04-14', '06:59')]);
    assert.deepEqual(check(mem, early, [scene('continue', 2, { start: at(2, '1024-04-13', '21:10', 'night'), end: at(3, '1024-04-14', '06:59', 'morning') })]).out, []);
});

// v0.7.5-a2 (GPT review of a1, P3): the small hours in between do not hide the morning after them.
test('an evening, the small hours and then the morning: the morning is compared with the evening before', () => {
    const { mem } = day();
    const c = chunkOf(2, [msg('1024-04-13', '23:00'), msg('1024-04-14', '06:00'), msg('1024-04-14', '07:00')]);
    // Two scenes the reply marks as one ("continue" later on) are joined, their times kept as steps.
    const joined = [scene('continue', 2, { start: at(2, '1024-04-13', '23:00', 'night'), end: at(3, '1024-04-14', '06:00', 'dawn') }),
        scene('continue', 4, { start: at(4, '1024-04-14', '07:00', 'morning'), end: { relation: 'same' } }, { start: 4 })];
    const { out } = check(mem, c, joined);
    assert.equal(out.length, 1);
    assert.match(out[0], /1024-04-13 · night · 23:00 → 1024-04-14 · morning · 07:00, shown at #4/);
    // The same across two rounds: the open scene ended in the small hours, the next messages begin after 07:00.
    const n = night();
    const c2 = chunkOf(2, [msg('1024-04-13', '08:00'), msg('1024-04-13', '09:00')]);
    const next = check(n.mem, c2, [scene('continue', 2, { start: at(2, '1024-04-13', '08:00', 'morning'), end: at(3, '1024-04-13', '09:00', 'morning') })]).out;
    assert.equal(next.length, 1);
    assert.match(next[0], /^scenes\[0\] continues the OPEN SCENE.*1024-04-12 · night · 19:35 → 1024-04-13 · morning · 08:00/);
    // Still the small hours: nothing.
    const c3 = chunkOf(2, [msg('1024-04-13', '06:30'), msg('1024-04-13', '06:50')]);
    assert.deepEqual(check(n.mem, c3, [scene('continue', 2, { start: at(2, '1024-04-13', '06:30', 'dawn'), end: at(3, '1024-04-13', '06:50', 'dawn') })]).out, []);
});

test('a continued scene that already begins on a new day is asked to be a new scene', () => {
    const { mem } = day();
    const c = chunkOf(2, [msg('1024-04-14', '10:00'), msg('1024-04-14', '11:00')]);
    const { out } = check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-14', '10:00', 'morning'), end: at(3, '1024-04-14', '11:00', 'morning') })]);
    assert.equal(out.length, 1);
    assert.match(out[0], /^scenes\[0\] continues the OPEN SCENE.*make it "scene": "new"/);
    // The boundary step said it continues: not contradicted.
    assert.deepEqual(check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-14', '10:00', 'morning'), end: at(3, '1024-04-14', '11:00', 'morning') })], { expectContinue: true }).out, []);
    // Already split there: nothing to ask.
    assert.deepEqual(check(mem, c, [scene('new', 2, { start: at(2, '1024-04-14', '10:00', 'morning'), end: at(3, '1024-04-14', '11:00', 'morning') })]).out, []);
});

// v0.7.5-a2 (GPT review of a1, P2-2): both boundaries go into the one second request.
test('a continued scene that begins on a new day and runs into another: both are asked for at once', () => {
    const { mem } = day();
    const c = chunkOf(2, [msg('1024-04-14', '10:00'), msg('1024-04-14', '11:00'), msg('1024-04-15', '09:00'), msg('1024-04-17', '09:00')]);
    const { out } = check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-14', '10:00', 'morning'), end: at(4, '1024-04-15', '09:00', 'morning') }),
        scene('continue', 5, { start: at(5, '1024-04-17', '09:00', 'morning'), end: { relation: 'same' } }, { start: 5 })]);
    assert.equal(out.length, 2);
    assert.match(out[0], /^scenes\[0\] continues the OPEN SCENE.*1024-04-13.*→ 1024-04-14/);
    assert.match(out[1], /^scenes\[0\] \(#2-#5\) runs into a new story day.*1024-04-14.*→ 1024-04-15.*shown at #4; 1024-04-15.*→ 1024-04-17.*shown at #5/);
});

test('a new day shown at the first message: a continued scene becomes new, a new scene is left alone', () => {
    const { mem } = day();
    const c = chunkOf(2, [msg('1024-04-15', '12:00'), msg('1024-04-15', '13:00')]);
    const time = { start: { relation: 'same' }, end: at(2, '1024-04-15', '12:00', 'day') };
    const a = check(mem, c, [scene('continue', 2, time)]).out;
    assert.equal(a.length, 1);
    assert.match(a[0], /^scenes\[0\] continues the OPEN SCENE.*begin at #2/);
    assert.deepEqual(check(mem, c, [scene('new', 2, time)]).out, []);
});

test('a quoted "the next day" counts without a time band; a bare night one day later and a flashback do not', () => {
    const { mem } = day();
    const c = chunkOf(2, ['They kept walking.', 'The next day they reached the ferry.']);
    const adv = { relation: 'advance', days: 1, msg: 3, quote: 'The next day' };
    assert.equal(check(mem, c, [scene('continue', 2, { start: { relation: 'same' }, end: adv })]).out.length, 1);
    assert.deepEqual(check(mem, c, [scene('continue', 2, { mode: 'flashback', start: { relation: 'same' }, end: adv })]).out, []);
    // "The next day" quoted with the small hours as its time band is left to the model.
    assert.deepEqual(check(mem, c, [scene('continue', 2, { start: { relation: 'same' }, end: { ...adv, period: 'dawn' } })]).out, []);
    // An acted past scene with its own dates is not the present moving on.
    const past = chunkOf(2, [msg('1023-01-01', '10:00'), msg('1023-01-05', '10:00')]);
    assert.deepEqual(check(mem, past, [scene('new', 2, { mode: 'flashback', start: at(2, '1023-01-01', '10:00', 'morning'), end: at(3, '1023-01-05', '10:00', 'morning') })]).out, []);
    const c2 = chunkOf(2, [msg('1024-04-13', '16:30'), `📅 Date: 1024-04-14\nNight again.`]);
    const bare = { relation: 'explicit', date: '1024-04-14', period: 'night', msg: 3, quote: '📅 Date: 1024-04-14' };
    assert.deepEqual(check(mem, c2, [scene('continue', 2, { start: at(2, '1024-04-13', '16:30', 'afternoon'), end: bare })]).out, []);
});

test('each scene of a reply is checked with the scenes before it; a split reply passes', () => {
    const { mem } = night();
    const c = chunkOf(2, [msg('1024-04-13', '06:30'), msg('1024-04-14', '09:00'), msg('1024-04-16', '07:48')]);
    const split = [scene('continue', 2, { start: at(2, '1024-04-13', '06:30', 'dawn'), end: { relation: 'same' } }, { ended: true }),
        scene('new', 3, { start: at(3, '1024-04-14', '09:00', 'morning'), end: { relation: 'same' } }, { start: 3, ended: true }),
        scene('new', 4, { start: at(4, '1024-04-16', '07:48', 'morning'), end: { relation: 'same' } }, { start: 4 })];
    assert.deepEqual(check(mem, c, split).out, []);
    const half = [scene('continue', 2, { start: at(2, '1024-04-13', '06:30', 'dawn'), end: { relation: 'same' } }, { ended: true }),
        scene('new', 3, { start: at(3, '1024-04-14', '09:00', 'morning'), end: at(4, '1024-04-16', '07:48', 'morning') }, { start: 3 })];
    const out = check(mem, c, half).out;
    assert.equal(out.length, 1);
    assert.match(out[0], /^scenes\[1\] \(#3-#4\)/);
});

test('a reply the check cannot read gives no notes instead of an error', () => {
    assert.deepEqual(dayBreaks(null, { mem: emptyMem(), chunk: chunkOf(0, ['x']) }), []);
    assert.deepEqual(dayBreaks({ scenes: [{}] }, {}), []);
});

// v0.7.5-a3 (GPT review of a2, P2-2): a scene that is already new does not inherit the night of the scene before it.
test('a new scene from the small hours into the morning of one date is not asked to split again', () => {
    const { mem } = day();
    const c = chunkOf(2, [msg('1024-04-13', '23:00'), msg('1024-04-14', '06:00'), msg('1024-04-14', '08:00')]);
    const two = [scene('continue', 2, { start: at(2, '1024-04-13', '23:00', 'night'), end: { relation: 'same' } }, { ended: true }),
        scene('new', 3, { start: at(3, '1024-04-14', '06:00', 'dawn'), end: at(4, '1024-04-14', '08:00', 'morning') }, { start: 3 })];
    assert.deepEqual(check(mem, c, two).out, []);
    // One scene running through the same hours still is.
    const one = [scene('continue', 2, { start: at(2, '1024-04-13', '23:00', 'night'), via: [at(3, '1024-04-14', '06:00', 'dawn')], end: at(4, '1024-04-14', '08:00', 'morning') })];
    const out = check(mem, c, one).out;
    assert.equal(out.length, 1);
    assert.match(out[0], /1024-04-13 · night · 23:00 → 1024-04-14 · morning · 08:00, shown at #4/);
});

// v0.7.5-a3 (GPT review of a2, P2-1): what the split reply must still carry.
test('splitKeeps: time stamps on messages and state changes of the first reply', () => {
    const t = (n, date, clock) => ({ relation: 'explicit', date, clock, period: 'morning', msg: n, quote: 'q' });
    const promise = { op: 'add', type: 'quest', kind: 'promise', status: 'open', who: ['ari'], text: 'Promise made at 3.', msgs: [3] };
    const first = { scenes: [{ time: { start: t(2, '1024-04-13', '10:00'), end: t(4, '1024-04-15', '09:00') } }], changes: [promise] };
    const split = { scenes: [{ time: { start: t(2, '1024-04-13', '10:00'), end: { relation: 'same' } } }, { time: { start: t(4, '1024-04-15', '09:00'), end: { relation: 'same' } } }], changes: [promise] };
    assert.equal(splitKeeps(first, split), '');
    // Merged parts count too.
    assert.equal(splitKeeps(first, { scenes: [{ _timeParts: [{ start: t(2, '1024-04-13', '10:00') }, { end: t(4, '1024-04-15', '09:00') }] }], changes: [promise] }), '');
    assert.equal(splitKeeps(first, { ...split, scenes: split.scenes.map(() => ({})) }), 'time stamps 2');
    assert.equal(splitKeeps(first, { ...split, scenes: [split.scenes[0], { time: { start: t(4, '1024-04-16', '09:00') } }] }), 'time stamps 1');
    // A change swapped for another (same count), or dropped.
    assert.equal(splitKeeps(first, { ...split, changes: [{ ...promise, text: 'Something else.', msgs: [2] }] }), 'changes 1');
    assert.equal(splitKeeps(first, { ...split, changes: [{ ...promise, status: 'done' }] }), 'changes 1');
    assert.equal(splitKeeps(first, { ...split, changes: [] }), 'changes 1');
    // Reworded over the same messages, or the same text on other messages: the same change. One second change answers one first change.
    assert.equal(splitKeeps(first, { ...split, changes: [{ ...promise, text: 'A promise was given.' }] }), '');
    assert.equal(splitKeeps(first, { ...split, changes: [{ ...promise, msgs: [3, 4] }] }), '');
    assert.equal(splitKeeps({ ...first, changes: [promise, promise] }, split), 'changes 1');
    // Extra stamps and changes in the second reply are fine; "same" stamps are not counted.
    assert.equal(splitKeeps({ scenes: [{ time: { start: { relation: 'same' } } }], changes: [] }, split), '');
    assert.equal(splitKeeps(first, null), 'unreadable');
});

// v0.7.5-a4 (GPT review of a3): a split reply that keeps the values but not what makes them hold when saved.
function nextDays(variant = {}) {
    const { mem } = day();
    const words = '내일 성문에서 만나자고 약속했다.';
    const c = chunkOf(2, [msg('1024-04-13', '11:30'), msg('1024-04-15', '09:00', words)]);
    const promise = { op: 'add', type: 'quest', kind: 'promise', status: 'open', who: [], text: 'Promised to meet at the gate.', msgs: [3],
        terms: { msg: 3, quote: '내일 성문에서 만나자고 약속했다' }, due: { expr: '내일', days: 1, msg: 3 } };
    const late = variant.late || at(3, '1024-04-15', '09:00', 'morning');
    const make = (scenes, changes) => {
        const d = { scenes, entities: [], changes };
        normalizeResult(d, { mem, chunk: c });
        assert.deepEqual(validateResult(d, { mem, chunk: c }), []);
        return d;
    };
    const first = make([scene('continue', 2, { start: at(2, '1024-04-13', '11:30', 'morning'), end: at(3, '1024-04-15', '09:00', 'morning') })], [promise]);
    const second = make([scene('continue', 2, { start: at(2, '1024-04-13', '11:30', 'morning'), end: { relation: 'same' } }, { ended: true }),
        scene('new', 3, { start: late, end: { relation: 'same' } }, { start: 3 })], [variant.promise || promise]);
    return { mem, c, first, second, save: d => applyResult(JSON.parse(JSON.stringify(mem)), d, c, { room: 'room-A' }).mem };
}

test('splitKeeps: a stamp confirmed in the first reply must still be confirmed in the second (P2-1)', () => {
    const ok = nextDays();
    assert.equal(splitKeeps(ok.first, ok.second, { mem: ok.mem, chunk: ok.c }), '');
    // Same date, clock and message, but no quote: by the values alone it looks kept, yet saved it is unconfirmed.
    const { quote, ...bare } = at(3, '1024-04-15', '09:00', 'morning');
    const r = nextDays({ late: bare });
    assert.equal(splitKeeps(r.first, r.second), '', 'the values alone match');
    assert.equal(splitKeeps(r.first, r.second, { mem: r.mem, chunk: r.c }), 'time stamps 1');
    const last = m => m.scenes.at(-1).segs.at(-1).time.start.certainty;
    assert.equal(last(r.save(r.first)), 'explicit');
    assert.equal(last(r.save(r.second)), 'unconfirmed', 'what the check prevents');
    // A quote that is not in that message is the same loss.
    const w = nextDays({ late: { ...bare, quote: 'Not in the message at all' } });
    assert.equal(splitKeeps(w.first, w.second, { mem: w.mem, chunk: w.c }), 'time stamps 1');
});

test('splitKeeps: a promise keeps its deadline and quoted terms (P2-2)', () => {
    const ok = nextDays();
    const p = ok.first.changes[0];
    const { due, ...noDue } = p;
    const lost = variant => { const r = nextDays({ promise: variant }); return splitKeeps(r.first, r.second, { mem: r.mem, chunk: r.c }); };
    assert.equal(lost(noDue), 'changes 1');
    assert.equal(lost({ ...p, due: { ...p.due, days: 2, expr: '내일' } }), 'changes 1');
    assert.equal(lost({ ...p, due: { ...p.due, msg: 2 } }), 'changes 1');
    // (No terms at all is already refused by validation: a promise needs them.)
    assert.equal(lost({ ...p, terms: { msg: 3, quote: '성문에서 만나자고' } }), 'changes 1');
    // The same deadline and terms written again (another wording of the text) still match.
    assert.equal(lost({ ...p, text: 'They agreed to meet at the gate.', due: { ...p.due }, terms: { ...p.terms } }), '');
    // A deadline the first reply did not give may be added.
    const r = nextDays();
    assert.equal(splitKeeps({ ...r.first, changes: [noDue] }, r.second, { mem: r.mem, chunk: r.c }), '');
    // Saved without the deadline, it is gone: what the check prevents.
    const saved = nextDays({ promise: noDue });
    assert.ok(saved.save(saved.first).records.some(x => x.due));
    assert.ok(!saved.save(saved.second).records.some(x => x.due));
});

// v0.7.5-a5 (GPT review of a4): a quoted "two days later" rests on its message too, and a flashback is not the present.
test('splitKeeps: a quoted advance must stay confirmed, and the present must stay the present', () => {
    const { mem } = day();
    const save = (d, c) => applyResult(JSON.parse(JSON.stringify(mem)), d, c, { room: 'room-A' }).mem;
    const make = (c, scenes) => { const d = { scenes, entities: [], changes: [] }; normalizeResult(d, { mem, chunk: c }); assert.deepEqual(validateResult(d, { mem, chunk: c }), []); return d; };
    const split = (c, late, mode = 'present') => make(c, [scene('continue', 2, { start: { relation: 'same' }, end: { relation: 'same' } }, { ended: true }),
        scene('new', 3, { mode, start: late, end: { relation: 'same' } }, { start: 3 })]);
    // "Two days later" with its quote, then without it: the days alone are the same values, saved it is unconfirmed.
    const c = chunkOf(2, ['The courier waited by the gate.', 'Two days later, the courier came back.']);
    const adv = quote => ({ relation: 'advance', days: 2, period: 'morning', msg: 3, ...(quote ? { quote: 'Two days later' } : {}) });
    const first = make(c, [scene('continue', 2, { start: { relation: 'same' }, end: adv(true) })]);
    assert.equal(dayBreaks(first, { mem, chunk: c }).length, 1, 'asked to split');
    assert.equal(splitKeeps(first, split(c, adv(true)), { mem, chunk: c }), '');
    const bare = split(c, adv(false));
    assert.equal(splitKeeps(first, bare), '', 'the values alone match');
    assert.equal(splitKeeps(first, bare, { mem, chunk: c }), 'time stamps 1');
    const start = m => m.scenes.at(-1).segs.at(-1).time.start.certainty;
    assert.equal(start(save(split(c, adv(true)), c)), 'linked');
    assert.equal(start(save(bare, c)), 'unconfirmed', 'what the check prevents');
    // The same dated stamp, told as a flashback: saved, the present stays on the day before.
    const c2 = chunkOf(2, ['The courier waited by the gate.', msg('1024-04-15', '09:00')]);
    const f2 = make(c2, [scene('continue', 2, { start: { relation: 'same' }, end: at(3, '1024-04-15', '09:00', 'morning') })]);
    const late = at(3, '1024-04-15', '09:00', 'morning');
    assert.equal(splitKeeps(f2, split(c2, late), { mem, chunk: c2 }), '');
    const back = split(c2, late, 'flashback');
    assert.equal(splitKeeps(f2, back), '', 'the values alone match');
    assert.equal(splitKeeps(f2, back, { mem, chunk: c2 }), 'time stamps 1');
    assert.equal(save(back, c2).scenes.at(-1).segs.at(-1).time.mode, 'flashback', 'what the check prevents');
});

// v0.7.5-a6 (GPT review of a5): a "same" that quotes a new clock on the same day is saved with that clock, so it counts too.
test('splitKeeps: a quoted same-day clock must stay, a bare inheriting "same" is not counted', () => {
    const { mem } = day();
    const c = chunkOf(2, [msg('1024-04-15', '09:00'), msg('1024-04-15', '17:00')]);
    const make = scenes => { const d = { scenes, entities: [], changes: [] }; normalizeResult(d, { mem, chunk: c }); assert.deepEqual(validateResult(d, { mem, chunk: c }), []); return d; };
    const late = { relation: 'same', date: '1024-04-15', clock: '17:00', period: 'evening', msg: 3, quote: line('1024-04-15', '17:00') };
    const first = make([scene('continue', 2, { start: at(2, '1024-04-15', '09:00', 'morning'), end: late })]);
    assert.equal(dayBreaks(first, { mem, chunk: c }).length, 1, 'asked to make it a new scene');
    const second = end => make([scene('new', 2, { start: at(2, '1024-04-15', '09:00', 'morning'), end })]);
    const endClock = d => applyResult(JSON.parse(JSON.stringify(mem)), d, c, { room: 'room-A' }).mem.scenes.at(-1).segs.at(-1).time.end.clock;
    assert.equal(splitKeeps(first, second(late), { mem, chunk: c }), '');
    assert.equal(endClock(second(late)), '17:00');
    const bare = second({ relation: 'same' });
    assert.equal(splitKeeps(first, bare), '', 'the values alone do not count a "same"');
    assert.equal(splitKeeps(first, bare, { mem, chunk: c }), 'time stamps 1');
    assert.equal(endClock(bare), '09:00', 'what the check prevents');
    // A bare "same" in the first reply (no quote, only inherits) is not something the second one must carry.
    const plainFirst = make([scene('continue', 2, { start: at(2, '1024-04-15', '09:00', 'morning'), end: { relation: 'same' } })]);
    assert.equal(splitKeeps(plainFirst, second({ relation: 'same' }), { mem, chunk: c }), '');
});

// v0.7.5-a7 (real use): the same time written another way, and a new entity under another invented ref, are not lost.
test('splitKeeps: the same saved time written another way and a renumbered new entity are kept', () => {
    const { mem } = day();
    const c = chunkOf(2, [msg('1024-04-13', '20:00'), msg('1024-04-13', '23:10'), `The next day. ${line('1024-04-14', '07:39')}\nThe courier woke.`]);
    const make = (scenes, entities = [], changes = []) => { const d = { scenes, entities, changes }; normalizeResult(d, { mem, chunk: c }); assert.deepEqual(validateResult(d, { mem, chunk: c }), []); return d; };
    const ent = (ref, name = 'Brass key') => [{ ref, type: 'item', name, aliases: ['key'] }];
    const add = ref => [{ op: 'add', type: 'item', entity: ref, text: 'A brass key was found.', msgs: [3] }];
    const first = make([scene('continue', 2, { start: at(2, '1024-04-13', '20:00', 'night'), end: at(4, '1024-04-14', '07:39', 'morning') })], ent('new1'), add('new1'));
    assert.equal(dayBreaks(first, { mem, chunk: c }).length, 1, 'asked to split');
    const morning = { relation: 'advance', days: 1, clock: '07:39', period: 'morning', msg: 4, quote: 'The next day.' };
    const second = (late, entities, changes) => make([scene('continue', 2, { start: at(2, '1024-04-13', '20:00', 'night'), end: at(3, '1024-04-13', '23:10', 'night') }, { ended: true }),
        scene('new', 4, { start: late, end: { relation: 'same' } }, { start: 4 })], entities, changes);
    // "The next day, 07:39" for "1024-04-14 07:39": the raw values differ, saved it is the same confirmed time.
    const other = second(morning, ent('new1'), add('new1'));
    assert.equal(splitKeeps(first, other), 'time stamps 1', 'the raw values differ');
    assert.equal(splitKeeps(first, other, { mem, chunk: c }), '');
    // The same new key under "new2": kept. A different new item: still lost.
    assert.equal(splitKeeps(first, second(at(4, '1024-04-14', '07:39', 'morning'), ent('new2'), add('new2')), { mem, chunk: c }), '');
    assert.equal(splitKeeps(first, second(at(4, '1024-04-14', '07:39', 'morning'), ent('new2', 'Iron key'), add('new2')), { mem, chunk: c }), 'changes 1');
    // Dropping the quote of the next day still loses the confirmed time.
    const bare = { ...morning }; delete bare.quote;
    assert.equal(splitKeeps(first, second(bare, ent('new1'), add('new1')), { mem, chunk: c }), 'time stamps 1');
});

// v0.7.5-a8 (GPT review of a7): a date the message gives is not a day counted on a date the user linked, and two new things
// of the same name from different messages are not one.
test('splitKeeps: a quoted date stays a quoted date over a linked reference; same-named new things need a shared message', () => {
    // An undated reference (clocks only) linked by the user to 1024-04-14.
    let mem = emptyMem();
    const c0 = chunkOf(0, ['At 10:00 the courier waited.', 'At 11:00 the courier left.']);
    const d0 = { scenes: [scene('new', 0, { start: { relation: 'explicit', clock: '10:00', period: 'morning', msg: 0, quote: 'At 10:00' },
        end: { relation: 'same', clock: '11:00', period: 'morning', msg: 1, quote: 'At 11:00' } })], entities: [], changes: [] };
    normalizeResult(d0, { mem, chunk: c0 }); assert.deepEqual(validateResult(d0, { mem, chunk: c0 }), []);
    mem = applyResult(mem, d0, c0, { room: 'room-A' }).mem;
    const ref = Object.keys(mem.timeAnchors)[0];
    linkReference(mem, ref, '1024-04-14', mem.timeAnchors[ref].baseDay);
    const c = chunkOf(2, ['The courier waited by the gate at 20:00.', `The next day. ${line('1024-04-15', '10:00')}\nThe courier woke.`]);
    const make = (m, ch, scenes, entities = [], changes = []) => { const d = { scenes, entities, changes }; normalizeResult(d, { mem: m, chunk: ch }); assert.deepEqual(validateResult(d, { mem: m, chunk: ch }), []); return d; };
    const first = make(mem, c, [scene('continue', 2, { start: { relation: 'same' }, end: at(3, '1024-04-15', '10:00', 'morning') })]);
    const second = late => make(mem, c, [scene('continue', 2, { start: { relation: 'same' }, end: { relation: 'same' } }, { ended: true }),
        scene('new', 3, { start: late, end: { relation: 'same' } }, { start: 3 })]);
    const counted = second({ relation: 'advance', days: 1, clock: '10:00', period: 'morning', msg: 3, quote: 'The next day.' });
    assert.equal(splitKeeps(first, second(at(3, '1024-04-15', '10:00', 'morning')), { mem, chunk: c }), '');
    assert.equal(splitKeeps(first, counted, { mem, chunk: c }), 'time stamps 1');
    // What the check prevents: moving the link moves the counted day, not the quoted one.
    const saved = (d, edge) => { const m = applyResult(JSON.parse(JSON.stringify(mem)), d, c, { room: 'room-A' }).mem;
        linkReference(m, ref, '1024-04-15', m.timeAnchors[ref].baseDay); return formatStoryStamp(m.scenes.at(-1).segs.at(-1).time[edge], m.timeAnchors); };
    assert.match(saved(first, 'end'), /^1024-04-15/);
    assert.match(saved(counted, 'start'), /^1024-04-16/);
    // A brass key in each wing: the second reply keeps only the west one.
    const m2 = emptyMem();
    const k = chunkOf(0, [`${line('1024-04-13', '20:00')}\nIn the east wing a brass key was found.`, `${line('1024-04-13', '21:00')}\nIn the west wing a brass key was found.`, msg('1024-04-14', '09:00')]);
    const ent = r => [{ ref: r, type: 'item', name: 'Brass key', aliases: ['key'] }];
    const add = (r, n) => [{ op: 'add', type: 'item', entity: r, text: 'A brass key was found.', msgs: [n] }];
    const f2 = make(m2, k, [scene('new', 0, { start: at(0, '1024-04-13', '20:00', 'night'), end: at(2, '1024-04-14', '09:00', 'morning') })], ent('new1'), add('new1', 0));
    const s2 = (r, n) => make(m2, k, [scene('new', 0, { start: at(0, '1024-04-13', '20:00', 'night'), end: { relation: 'same' } }, { ended: true }),
        scene('new', 2, { start: at(2, '1024-04-14', '09:00', 'morning'), end: { relation: 'same' } }, { start: 2 })], ent(r), add(r, n));
    assert.equal(splitKeeps(f2, s2('new2', 0), { mem: m2, chunk: k }), '', 'only the ref changed');
    assert.equal(splitKeeps(f2, s2('new2', 1), { mem: m2, chunk: k }), 'changes 1');
    assert.equal(splitKeeps(f2, s2('new1', 1), { mem: m2, chunk: k }), 'changes 1', 'the same ref from another message');
});

// v0.7.5-a9 (GPT review of a8): a segment id is evidence of its own ("g1" and "g2" differ), a message number is the same with or without "#".
test('splitKeeps: segment ids as evidence are compared as they are, message numbers with or without "#"', () => {
    let mem = emptyMem();
    for (const [i, clock] of [[0, '10:00'], [1, '11:00'], [2, '12:00']]) {
        const c = chunkOf(i, [msg('1024-04-13', clock)]);
        const d = { scenes: [scene(i ? 'continue' : 'new', i, { start: at(i, '1024-04-13', clock, 'morning'), end: { relation: 'same' } })], entities: [], changes: [] };
        normalizeResult(d, { mem, chunk: c }); assert.deepEqual(validateResult(d, { mem, chunk: c }), []);
        mem = applyResult(mem, d, c, { room: 'room-A' }).mem;
    }
    const [g1, g2] = mem.scenes.at(-1).segs.map(g => g.id);
    const k = chunkOf(3, [msg('1024-04-13', '20:00'), msg('1024-04-14', '09:00')]);
    const make = (scenes, entities, changes) => { const d = { scenes, entities, changes }; normalizeResult(d, { mem, chunk: k }); assert.deepEqual(validateResult(d, { mem, chunk: k }), []); return d; };
    const ent = r => [{ ref: r, type: 'item', name: 'Brass key', aliases: ['key'] }];
    const add = (r, e) => [{ op: 'add', type: 'item', entity: r, text: 'A brass key was found.', msgs: e }];
    const first = make([scene('continue', 3, { start: at(3, '1024-04-13', '20:00', 'night'), end: at(4, '1024-04-14', '09:00', 'morning') })], ent('new1'), add('new1', [g1]));
    const second = (entities, changes) => make([scene('continue', 3, { start: at(3, '1024-04-13', '20:00', 'night'), end: { relation: 'same' } }, { ended: true }),
        scene('new', 4, { start: at(4, '1024-04-14', '09:00', 'morning'), end: { relation: 'same' } }, { start: 4 })], entities, changes);
    assert.equal(splitKeeps(first, second(ent('new2'), add('new2', [g1])), { mem, chunk: k }), '');
    assert.equal(splitKeeps(first, second(ent('new2'), add('new2', [g2])), { mem, chunk: k }), 'changes 1', 'another segment');
    assert.equal(splitKeeps(first, second(ent('new2'), add('new2', [g2, g1])), { mem, chunk: k }), '', 'a shared segment');
    // Message numbers: 3 and "#3" are one.
    const f2 = make([scene('continue', 3, { start: at(3, '1024-04-13', '20:00', 'night'), end: at(4, '1024-04-14', '09:00', 'morning') })], ent('new1'), add('new1', [3]));
    assert.equal(splitKeeps(f2, second(ent('new2'), add('new2', ['#3'])), { mem, chunk: k }), '');
});
