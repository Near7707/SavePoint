import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, cleanMem, detachMem, setQuestStatus, memDiff, applyDiff, buildInjection, promptContext, validateResult } from '../core.js';
import { questEventTimes, linkReference, editStoryTime } from '../temporal.js';

const quest = m => m.records.find(r => r.type === 'quest');
const add = (kind = 'promise') => ({ op: 'add', type: 'quest', kind, text: 'Meet at the station.', status: 'open', who: [] });
function save(mem = emptyMem(), { changes = [add()], date = '2026-10-25', endDate = date, period = 'afternoon', endPeriod = period,
    room = 'room-A', from, time, words = 'I promise to meet at the station tomorrow.' } = {}) {
    from ??= Math.max(-1, ...mem.scenes.flatMap(s => s.segs).filter(g => !g.external).map(g => g.to)) + 1;
    const to = from + 2, texts = { [from]: `${date} ${period}`, [from + 1]: words, [to]: `${endDate} ${endPeriod}` };
    const chunk = { from, to, indices: [from, from + 1, to], texts, text: Object.entries(texts).map(([n, v]) => `#${n} Speaker: ${v}`).join('\n') };
    const data = { scenes: [{ scene: mem.scenes.length ? 'continue' : 'new', title: 'A neutral trip', where: 'Station', who: [],
        outline: 'A participant visited the station.', notes: '', ended: false, points: [],
        time: time || { mode: 'present', start: { relation: 'explicit', date, period, msg: from, quote: texts[from] },
            end: { relation: 'explicit', date: endDate, period: endPeriod, msg: to, quote: texts[to] } } }], entities: [],
        changes: changes.map(c => ({ ...c, msgs: c.msgs || [from + 1],
            ...(c.op === 'add' && ['promise', 'debt'].includes(c.kind) ? { terms: { msg: from + 1, quote: words } } : {}),
            ...(c.due ? { due: { ...c.due, msg: from + 1 } } : {}) })) };
    assert.deepEqual(validateResult(data, { mem, chunk }), []);
    return applyResult(mem, data, chunk, { room }).mem;
}
const labels = m => questEventTimes(m, quest(m));

test('quest creation evidence survives rolling evidence truncation and unrelated text updates', () => {
    let m = save();
    const created = structuredClone(quest(m).questEvents.created);
    for (let n = 0; n < 15; n++) m = save(m, { date: '2026-10-26', changes: [{ op: 'update', id: 'r1', text: `Meet at the station, note ${n}.` }] });
    assert(!quest(m).msgs.includes(1));
    assert.deepEqual(quest(m).questEvents.created, created);
    assert.deepEqual(labels(m), [{ label: '약속한 때', text: '2026-10-25 · 오후' }]);
});

test('a changed deadline does not become the creation date', () => {
    let m = save(emptyMem(), { changes: [{ ...add(), due: { expr: 'tomorrow', days: 1 } }] });
    m = save(m, { date: '2026-10-26', changes: [{ op: 'update', id: 'r1', due: { expr: 'tomorrow', days: 1 } }] });
    assert.equal(quest(m).due.seg, 'g2');
    assert.equal(quest(m).questEvents.created.segs[0], 'g1');
    assert.equal(labels(m)[0].text, '2026-10-25 · 오후');
});

test('AI completion and failure use the status transition, not later record updates', () => {
    let m = save();
    m = save(m, { date: '2026-10-26', changes: [{ op: 'update', id: 'r1', status: 'done' }] });
    m = save(m, { date: '2026-10-27', changes: [{ op: 'update', id: 'r1', text: 'The meeting is over.', status: 'done' }] });
    assert.deepEqual(labels(m)[1], { label: '완료한 때', text: '2026-10-26 · 오후' });
    m = save(m, { date: '2026-10-28', changes: [{ op: 'update', id: 'r1', status: 'open' }] });
    assert.equal(labels(m).length, 1);
    m = save(m, { date: '2026-10-29', changes: [{ op: 'update', id: 'r1', status: 'failed' }] });
    assert.deepEqual(labels(m)[1], { label: '실패한 때', text: '2026-10-29 · 오후' });
});

test('manual status changes have no story date and undo restores the prior AI evidence', () => {
    let m = save();
    m = save(m, { date: '2026-10-26', changes: [{ op: 'update', id: 'r1', status: 'done' }] });
    const before = structuredClone(m);
    setQuestStatus(quest(m), 'open'); setQuestStatus(quest(m), 'failed');
    assert.deepEqual(quest(m).questEvents.resolved, { status: 'failed', manual: true });
    assert.equal(labels(m).length, 1);
    const diff = memDiff(before, m), back = applyDiff(m, diff, true);
    assert.deepEqual(labels(back)[1], { label: '완료한 때', text: '2026-10-26 · 오후' });
    assert.equal(labels(applyDiff(back, diff)).length, 1);
    const restored = cleanMem(JSON.parse(JSON.stringify(m)));
    assert.equal(labels(restored).length, 1);
});

test('a single day with mixed periods shows only the date, not an invented afternoon', () => {
    const m = save(emptyMem(), { period: 'morning', endPeriod: 'afternoon' });
    assert.deepEqual(labels(m), [{ label: '약속한 때', text: '2026-10-25' }]);
});

test('multiple days show a range and any unconfirmed boundary hides the date', () => {
    const m = save(emptyMem(), { endDate: '2026-10-26' });
    assert.deepEqual(labels(m), [{ label: '약속 기록 구간', text: '2026-10-25 · 오후 → 2026-10-26 · 오후' }]);
    m.scenes[0].segs[0].time.start.certainty = 'unconfirmed';
    assert.deepEqual(labels(m), []);
    m.scenes[0].segs[0].time.start.certainty = 'explicit';
    m.scenes[0].segs[0].time.via = [{ certainty: 'unconfirmed' }];
    assert.deepEqual(labels(m), []);
});

test('room moves preserve creation and completion sources despite equal message numbers', () => {
    let m = detachMem(save(), 'room-A');
    m = save(m, { room: 'room-B', from: 0, date: '2026-10-28', changes: [{ op: 'update', id: 'r1', status: 'done' }] });
    assert.deepEqual(labels(m), [{ label: '약속한 때', text: '2026-10-25 · 오후' }, { label: '완료한 때', text: '2026-10-28 · 오후' }]);
    m = cleanMem(JSON.parse(JSON.stringify(detachMem(m, 'room-B'))));
    assert.equal(quest(m).questEvents.created.room, 'room-A');
    assert.equal(quest(m).questEvents.resolved.room, 'room-B');
    assert.equal(labels(m)[0].text, '2026-10-25 · 오후');
    assert.equal(labels(m)[1].text, '2026-10-28 · 오후');
});

test('legacy evidence is labelled as a related range, never a known creation or completion', () => {
    let m = save(); delete quest(m).questEvents;
    m = save(m, { date: '2026-10-28', changes: [{ op: 'update', id: 'r1', text: 'A revised meeting.' }] });
    quest(m).status = 'done';
    assert.deepEqual(labels(m), [{ label: '관련 기록 구간', text: '2026-10-25 · 오후' }]);
    m = detachMem(m, 'room-A');
    m = save(m, { room: 'room-B', from: 0, date: '2026-10-29', changes: [] });
    assert.equal(labels(m)[0].text, '2026-10-25 · 오후');
    m.scenes[0].segs = m.scenes[0].segs.filter(g => g.id !== 'g1');
    assert.deepEqual(labels(m), [], 'missing foreign evidence cannot match a local message with the same number');
});

test('missing or mismatched lifecycle sources do not fall back to unrelated rolling evidence', () => {
    const m = save();
    quest(m).questEvents.created.room = 'other-room';
    assert.deepEqual(labels(m), []);
    quest(m).questEvents.created.room = 'room-A';
    quest(m).questEvents.created.segs = ['g999'];
    assert.deepEqual(labels(m), []);
    const cleaned = cleanMem(m);
    assert.deepEqual(labels(cleaned), []);
});

test('linked dates and later segment time edits are reflected without rewriting lifecycle evidence', () => {
    const m = save(emptyMem(), { time: { mode: 'present', start: { relation: 'same' }, end: { relation: 'same' } } });
    const event = structuredClone(quest(m).questEvents.created), g = m.scenes[0].segs[0];
    assert.match(labels(m)[0].text, /기록 기준 1일째/);
    linkReference(m, g.time.start.anchor, '2026-10-25', 0);
    assert.equal(labels(m)[0].text, '2026-10-25');
    for (const edge of ['start', 'end']) editStoryTime(m, 'g1', { edge, date: '2026-10-27', day: '', period: 'night', clock: '', mode: 'present' }, 'room-A');
    assert.equal(labels(m)[0].text, '2026-10-27 · 밤');
    assert.deepEqual(quest(m).questEvents.created, event);
});

test('lifecycle metadata changes neither injection nor extraction context', () => {
    const m = save(), before = structuredClone(m);
    delete quest(before).questEvents;
    assert.equal(buildInjection(m).text, buildInjection(before).text);
    assert.deepEqual(promptContext(m, 'station'), promptContext(before, 'station'));
});

test('flashback evidence stays marked and manual records acquire no creation date', () => {
    const m = save(emptyMem(), { date: '2026-10-25' });
    m.scenes[0].segs[0].time.mode = 'flashback';
    assert.match(labels(m)[0].text, /^회상 · /);
    quest(m).questEvents = { created: null };
    assert.deepEqual(labels(m), []);
});
