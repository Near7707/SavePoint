import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, normalizeResult, validateResult, cleanMem, memDiff, applyDiff, buildInjection } from '../core.js';
import { formatSegmentTime, linkReference, linkConflicts, timelineRows, dueStatus, editStoryTime, recomputeStoryTimes, storyTimeContext } from '../temporal.js';

// Invented text only.
function build(parts) {
    let mem = emptyMem(), n = 0;
    for (const p of parts) {
        const w = `${p.words || 'x'}\n${(p.q || []).join('\n')}`;
        const chunk = { from: n, to: n, indices: [n], text: w, texts: { [n]: w } };
        const at = t => t && { ...t, msg: n };
        const d = { scenes: [{ scene: p.newScene ? 'new' : 'continue', title: 'Errand', where: 'Harbor', who: [], ended: false, outline: p.outline || 'They waited.', notes: '',
            points: [{ text: 'A point.', kind: 'moment', key: false, msgs: [n] }], time: { mode: 'present', start: at(p.s), end: at(p.e) } }], entities: [],
            changes: (p.changes || []).map(c => ({ ...c, msgs: [n], terms: { msg: n, quote: c.terms }, due: { ...c.due, msg: n } })) };
        normalizeResult(d, { mem, chunk });
        assert.deepEqual(validateResult(d, { mem, chunk }), []);
        mem = applyResult(mem, d, chunk, { room: 'room-A' }).mem; n++;
    }
    return mem;
}
const same = { relation: 'same' };
const nextDay = { relation: 'advance', days: 1, quote: '다음 날' };
// Recording days 1 and 2, a promise for "tomorrow" on day 2, then a vague jump.
const story = () => build([
    { newScene: true, s: same, e: same, outline: 'Day one.' },
    { s: nextDay, e: same, words: '다음 날 아침. 내일 다시 오겠다고 약속했다.', outline: 'Day two.',
        changes: [{ op: 'add', type: 'quest', kind: 'promise', status: 'open', who: [], text: 'Promised to come back.', terms: '내일 다시 오겠다고 약속했다', due: { expr: '내일', days: 1 } }] },
    { s: { relation: 'jump', elapsed: '몇 주 뒤', quote: '몇 주 뒤' }, e: same, words: '몇 주 뒤', outline: 'Weeks later.' },
]);
const record = m => timelineRows(m)[0].ref.anchor;
const show = m => m.scenes[0].segs.map(g => formatSegmentTime(g.time, m.timeAnchors, 'ko'));

test('a date linked to the recording reference shows on its days and in deadlines, keeping days and messages', () => {
    const m = story();
    const before = JSON.stringify(m.scenes);
    assert.deepEqual(show(m), ['기록 기준 1일째', '기록 기준 2일째', '몇 주 뒤']);
    linkReference(m, record(m), '2026-10-25', 0);
    assert.deepEqual(show(m), ['2026-10-25', '2026-10-26', '몇 주 뒤'], 'the vague jump is not linked automatically');
    assert.equal(JSON.stringify(m.scenes), before, 'saved days and message numbers stay');
    const q = m.records[0];
    assert.match(dueStatus(m, q) ? JSON.stringify(dueStatus(m, q)) : '', /check/, 'after the jump the deadline still cannot be compared');
    assert.equal(dueStatus({ ...m, scenes: [{ ...m.scenes[0], segs: m.scenes[0].segs.slice(0, 2) }] }, q).left, 1);
    assert.match(buildInjection(m, { budget: 6000 }).text, /2026-10-26/);
});

test('a link survives re-reading, export and undo, and can be removed', () => {
    const m = story(), key = record(m), before = structuredClone(m);
    linkReference(m, key, '2026-10-25 (Sun)', 0);
    recomputeStoryTimes(m);
    assert.equal(show(m)[1], '2026-10-26');
    const back = cleanMem(JSON.parse(JSON.stringify(m)));
    assert.equal(show(back)[1], '2026-10-26');
    const undone = applyDiff(m, memDiff(before, m), true);
    assert.equal(show(undone)[1], '기록 기준 2일째');
    linkReference(m, key, '', 0);
    assert.equal(show(m)[1], '기록 기준 2일째');
});

test('a link never overrules a date in the text, and disagreements are reported', () => {
    let m = build([
        { newScene: true, s: same, e: same },
        { s: nextDay, e: same, words: '다음 날' },
        { s: { relation: 'explicit', date: '2026-10-28', quote: '2026-10-28' }, e: same, words: '2026-10-28' },
    ]);
    linkReference(m, record(m), '2026-10-27', 0);   // day 2 would be 10-28 — fine
    assert.deepEqual(linkConflicts(m), []);
    linkReference(m, record(m), '2026-10-28', 0);   // day 2 = 10-29, then the text says 10-28
    const c = linkConflicts(m);
    assert.equal(c.length, 1); assert.equal(c[0].date, '2026-10-28'); assert.equal(c[0].before, '2026-10-29');
    assert.equal(show(m)[2], '2026-10-28', 'the stated date stays confirmed');
    recomputeStoryTimes(m);
    assert.equal(show(m)[2], '2026-10-28', 're-reading does not use the link either');
});

test('only an undated reference can be linked, with a real date', () => {
    const m = build([{ newScene: true, s: { relation: 'explicit', date: '2026-10-25', quote: '2026-10-25' }, e: same, words: '2026-10-25' }]);
    const key = timelineRows(m)[0].ref?.anchor || Object.keys(m.timeAnchors)[0];
    assert.throws(() => linkReference(m, key, '2026-10-20', 0), /원문 날짜는 바꿀 수 없어요/);
    const r = story();
    assert.throws(() => linkReference(r, record(r), '2026-02-30', 0), /실제 날짜/);
    assert.throws(() => linkReference(r, 't:nope', '2026-10-25', 0), /찾지 못했어요/);
});

test('a manual time edit inside a linked reference keeps showing linked dates', () => {
    const m = story();
    linkReference(m, record(m), '2026-10-25', 0);
    editStoryTime(m, m.scenes[0].segs[1].id, { edge: 'end', day: '', date: '', period: 'night', clock: '' }, 'room-A');
    assert.equal(show(m)[1], '2026-10-26 → 2026-10-26 · 밤');
    assert.match(storyTimeContext(m, 'ko'), /몇 주 뒤/);
});
