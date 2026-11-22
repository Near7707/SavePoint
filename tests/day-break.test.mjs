import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, normalizeResult, validateResult, dayBreaks } from '../core.js';

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

test('a continued scene that runs on for days is asked to split where the new day is shown', () => {
    const { mem } = night();
    const c = chunkOf(2, [msg('1024-04-13', '06:30'), msg('1024-04-14', '09:00'), msg('1024-04-16', '07:48')]);
    const { out } = check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-13', '06:30', 'dawn'), end: at(4, '1024-04-16', '07:48', 'morning') })]);
    assert.equal(out.length, 1);
    assert.match(out[0], /^scenes\[0\] \(#2-#4\) runs into a new story day/);
    assert.match(out[0], /1024-04-13.*→ 1024-04-16.*shown at #4/);
    assert.match(out[0], /"scene": "new", "start"/);
});

test('one day later in the morning (by the clock or by the time band) is a new day; the same day is not', () => {
    const { mem } = night();
    const c = chunkOf(2, [msg('1024-04-13', '06:30'), msg('1024-04-13', '21:10'), msg('1024-04-14', '07:48')]);
    assert.equal(check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-13', '06:30', 'dawn'), end: at(4, '1024-04-14', '07:48', 'morning') })]).out.length, 1);
    assert.deepEqual(check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-13', '06:30', 'dawn'), end: at(3, '1024-04-13', '21:10', 'night') })]).out, []);
    // 06:59 on the next day is still the small hours.
    const early = chunkOf(2, [msg('1024-04-13', '21:10'), msg('1024-04-14', '06:59')]);
    assert.deepEqual(check(mem, early, [scene('continue', 2, { start: at(2, '1024-04-13', '21:10', 'night'), end: at(3, '1024-04-14', '06:59', 'morning') })]).out, []);
});

test('a continued scene that already begins on a new day is asked to be a new scene', () => {
    const { mem } = night();
    const c = chunkOf(2, [msg('1024-04-14', '10:00'), msg('1024-04-14', '11:00')]);
    const { out } = check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-14', '10:00', 'morning'), end: at(3, '1024-04-14', '11:00', 'morning') })]);
    assert.equal(out.length, 1);
    assert.match(out[0], /^scenes\[0\] continues the OPEN SCENE.*make it "scene": "new"/);
    // The boundary step said it continues: not contradicted.
    assert.deepEqual(check(mem, c, [scene('continue', 2, { start: at(2, '1024-04-14', '10:00', 'morning'), end: at(3, '1024-04-14', '11:00', 'morning') })], { expectContinue: true }).out, []);
    // Already split there: nothing to ask.
    assert.deepEqual(check(mem, c, [scene('new', 2, { start: at(2, '1024-04-14', '10:00', 'morning'), end: at(3, '1024-04-14', '11:00', 'morning') })]).out, []);
});

test('a new day shown at the first message: a continued scene becomes new, a new scene is left alone', () => {
    const { mem } = night();
    const c = chunkOf(2, [msg('1024-04-15', '12:00'), msg('1024-04-15', '13:00')]);
    const time = { start: { relation: 'same' }, end: at(2, '1024-04-15', '12:00', 'day') };
    const a = check(mem, c, [scene('continue', 2, time)]).out;
    assert.equal(a.length, 1);
    assert.match(a[0], /new story day begins at its first message #2/);
    assert.deepEqual(check(mem, c, [scene('new', 2, time)]).out, []);
});

test('a quoted "the next day" counts without a time band; a bare night one day later and a flashback do not', () => {
    const { mem } = night();
    const c = chunkOf(2, ['They kept walking.', 'The next day they reached the ferry.']);
    const adv = { relation: 'advance', days: 1, msg: 3, quote: 'The next day' };
    assert.equal(check(mem, c, [scene('continue', 2, { start: { relation: 'same' }, end: adv })]).out.length, 1);
    assert.deepEqual(check(mem, c, [scene('continue', 2, { mode: 'flashback', start: { relation: 'same' }, end: adv })]).out, []);
    // "The next day" quoted with the small hours as its time band is left to the model.
    assert.deepEqual(check(mem, c, [scene('continue', 2, { start: { relation: 'same' }, end: { ...adv, period: 'dawn' } })]).out, []);
    // An acted past scene with its own dates is not the present moving on.
    const past = chunkOf(2, [msg('1023-01-01', '10:00'), msg('1023-01-05', '10:00')]);
    assert.deepEqual(check(mem, past, [scene('new', 2, { mode: 'flashback', start: at(2, '1023-01-01', '10:00', 'morning'), end: at(3, '1023-01-05', '10:00', 'morning') })]).out, []);
    const c2 = chunkOf(2, [msg('1024-04-13', '06:30'), `📅 Date: 1024-04-14\nNight again.`]);
    const bare = { relation: 'explicit', date: '1024-04-14', period: 'night', msg: 3, quote: '📅 Date: 1024-04-14' };
    assert.deepEqual(check(mem, c2, [scene('continue', 2, { start: at(2, '1024-04-13', '06:30', 'dawn'), end: bare })]).out, []);
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
