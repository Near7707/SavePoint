import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, normalizeResult, validateResult, cleanMem } from '../core.js';
import { formatSegmentTime, lastStoryTime, normalizeStoryDate, upgradeStoryTimes, dueStatus } from '../temporal.js';

// An info box like many roleplay presets print on every reply. Invented scene text only.
const box = (date, clock) => `<Scene_Info><small>\n📅 Date: ${date} | 🕒 Time: ${clock}\n📍 Location: Old Station\n</small></Scene_Info>\n\nThe courier waited by the gate.`;
const line = (date, clock) => `📅 Date: ${date} | 🕒 Time: ${clock}`;
function save(mem, words, time, changes = []) {
    const index = mem.scenes.flatMap(s => s.segs).length;
    const chunk = { from: index, to: index, indices: [index], text: words, texts: { [index]: words } };
    const at = t => t && { ...t, msg: index };
    const d = { scenes: [{ scene: mem.scenes.length ? 'continue' : 'new', title: 'A neutral scene', where: 'Station', who: [], outline: 'A courier waited.', notes: '', ended: false,
        points: [{ text: 'A courier waited.', kind: 'moment', key: false, msgs: [index] }], time: { mode: 'present', start: at(time.start), end: at(time.end) } }], entities: [],
        changes: changes.map(c => ({ ...c, msgs: [index], ...(c.terms ? { terms: { msg: index, quote: c.terms } } : {}), ...(c.due ? { due: { ...c.due, msg: index } } : {}) })) };
    normalizeResult(d, { mem, chunk });
    assert.deepEqual(validateResult(d, { mem, chunk }), []);
    return applyResult(mem, d, chunk, { room: 'room-A' }).mem;
}
const last = m => formatSegmentTime(m.scenes.flatMap(s => s.segs).at(-1).time, m.timeAnchors, 'ko');
const first = () => save(emptyMem(), box('2026-10-25 (Sun)', '14:38'), { start: { relation: 'explicit', date: '2026-10-25 (Sun)', clock: '14:38', period: 'afternoon', quote: line('2026-10-25 (Sun)', '14:38') }, end: { relation: 'same' } });

test('a weekday after an ISO date is a label, not a separate calendar', () => {
    for (const d of ['2026-10-25 (Sun)', '2026-10-25 Sun', '2026-10-25 (Sunday)', '2026-10-25, Sun.', '2026-10-25 (일)', '2026-10-25 (일요일)', '2026-10-25（日）'.replace('日', '일')])
        assert.equal(normalizeStoryDate(d), '2026-10-25', d);
    for (const d of ['왕국력 312년 봄 3일 (일)', '2026-02-30 (Mon)', '2026-10-25 (night)', '2026-10-25 and later'])
        assert.equal(normalizeStoryDate(d), d, d);
    const m = first();
    assert.equal(last(m), '2026-10-25 · 오후 · 14:38');
    assert.equal(Object.values(m.timeAnchors)[0].date, '2026-10-25');
});

test('the same day written with and without the weekday stays one confirmed day', () => {
    let m = save(first(), box('2026-10-25 (Sun)', '15:10'), { start: { relation: 'same' }, end: { relation: 'same', date: '2026-10-25', clock: '15:10', period: 'afternoon', quote: line('2026-10-25 (Sun)', '15:10') } });
    assert.equal(last(m), '2026-10-25 · 오후 · 14:38 → 2026-10-25 · 오후 · 15:10');
    m = save(m, box('2026-10-26 (Mon)', '09:00'), { start: { relation: 'explicit', date: '2026-10-26 (Mon)', clock: '09:00', quote: line('2026-10-26 (Mon)', '09:00') }, end: { relation: 'same' } });
    assert.equal(Object.keys(m.timeAnchors).length, 1, 'the next day links on the same reference');
    assert.equal(lastStoryTime(m).stamp.day, 1);
});

test('a quoted info box after an unconfirmed gap confirms again instead of spreading the gap', () => {
    let m = save(first(), 'The courier waited.', { start: { relation: 'same' }, end: { relation: 'unknown' } });
    assert.match(last(m), /시간 미확인$/);
    m = save(m, box('2026-10-25 (Sun)', '16:00'), { start: { relation: 'same', date: '2026-10-25 (Sun)', clock: '16:00', quote: line('2026-10-25 (Sun)', '16:00') }, end: { relation: 'same' } });
    assert.equal(last(m), '2026-10-25 · 16:00');
    m = save(m, 'The courier waited.', { start: { relation: 'same' }, end: { relation: 'same' } });
    assert.equal(last(m), '2026-10-25 · 16:00', 'plain inheritance continues from the recovered time');
});

test('the recovery keeps the old safeguards', () => {
    // Unquoted "same" with a date is still not evidence.
    let m = save(first(), 'The courier waited.', { start: { relation: 'same' }, end: { relation: 'unknown' } });
    m = save(m, 'The courier waited.', { start: { relation: 'same', date: '2026-10-25', quote: 'no such words' }, end: { relation: 'same' } });
    assert.equal(last(m), '시간 미확인');
    // A quoted earlier date cannot turn the present backward through "same" either.
    m = save(first(), box('2026-10-20 (Tue)', '10:00'), { start: { relation: 'same', date: '2026-10-20 (Tue)', clock: '10:00', quote: line('2026-10-20 (Tue)', '10:00') }, end: { relation: 'same' } });
    assert.equal(last(m), '시간 미확인');
    assert.equal(lastStoryTime(m).stamp.certainty, 'unconfirmed');
});

test('records saved by the previous version are re-read once on opening', () => {
    // Shape the old version stored: a weekday anchor date, an unconfirmed quoted "same" end,
    // and a following part that inherited the gap.
    const ev = (msg, clock) => ({ room: 'room-A', msg, quote: line('2026-10-25 (Sun)', clock) });
    const seg = (id, n, start, end) => ({ id, from: n, to: n, outline: 'A courier waited.', points: [{ text: 'A courier waited.', kind: 'moment', key: false, msgs: [n] }], time: { mode: 'present', origin: 'room-A', start, end } });
    const anchor = 't:' + JSON.stringify([ 'room-A', 'g1', 'start' ]);
    const old = { ...emptyMem(), timeAnchors: { [anchor]: { kind: 'explicit', date: '2026-10-25 (Sun)', label: '', baseDay: 0, numbered: false, counted: false } },
        scenes: [{ id: 's1', title: 'A neutral scene', where: 'Station', who: [], status: 'open', segs: [
            seg('g1', 0, { op: 'explicit', date: '2026-10-25 (Sun)', clock: '14:38', period: 'afternoon', evidence: ev(0, '14:38'), verified: true, anchor, day: 0, certainty: 'explicit' }, { op: 'same', anchor, day: 0, certainty: 'linked', clock: '14:38', period: 'afternoon' }),
            seg('g2', 1, { op: 'same', anchor, day: 0, certainty: 'linked', clock: '14:38', period: 'afternoon' }, { op: 'same', date: '2026-10-25', clock: '15:10', period: 'afternoon', evidence: ev(1, '15:10'), verified: true, anchor: null, day: null, certainty: 'unconfirmed' }),
            seg('g3', 2, { op: 'same', anchor: null, day: null, certainty: 'unconfirmed' }, { op: 'same', anchor: null, day: null, certainty: 'unconfirmed' })] }] };
    const m = cleanMem(JSON.parse(JSON.stringify(old)));
    assert.equal(upgradeStoryTimes(m), true);
    assert.deepEqual(m.scenes[0].segs.map(g => formatSegmentTime(g.time, m.timeAnchors, 'ko')),
        ['2026-10-25 · 오후 · 14:38', '2026-10-25 · 오후 · 14:38 → 2026-10-25 · 오후 · 15:10', '2026-10-25 · 오후 · 15:10']);
    assert.equal(upgradeStoryTimes(m), false, 'a second pass changes nothing');
});

test('deadlines placed on a weekday date now count days', () => {
    let m = first();
    m = save(m, box('2026-10-25 (Sun)', '15:00') + '\n내일 성문에서 만나자고 약속했다.', { start: { relation: 'same', date: '2026-10-25 (Sun)', clock: '15:00', quote: line('2026-10-25 (Sun)', '15:00') }, end: { relation: 'same' } },
        [{ op: 'add', type: 'quest', kind: 'promise', status: 'open', who: [], text: 'Promised to meet at the gate.', terms: '내일 성문에서 만나자고 약속했다', due: { expr: '내일', days: 1 } }]);
    m = save(m, box('2026-10-26 (Mon)', '09:00'), { start: { relation: 'explicit', date: '2026-10-26 (Mon)', clock: '09:00', quote: line('2026-10-26 (Mon)', '09:00') }, end: { relation: 'same' } });
    assert.equal(dueStatus(m, m.records.find(r => r.type === 'quest')).kind, 'today');
});
