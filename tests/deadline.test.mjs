import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, cleanMem, detachMem, buildInjection, validateResult, normalizeResult, memDiff, applyDiff, recordLine } from '../core.js';
import { dueStatus, formatDue, setManualDue, editStoryTime, lastStoryTime } from '../temporal.js';

// One saved part per call. `time` is the part's story time; `changes` are state changes in it.
function save(mem, { time, changes = [], words = 'A participant waited.', room = 'room-A' } = {}) {
    const index = mem.scenes.flatMap(s => s.segs).length;
    const chunk = { from: index, to: index, indices: [index], text: words, texts: { [index]: words } };
    const at = t => t && { ...t, msg: index, quote: t.quote ?? words };
    const d = { scenes: [{ scene: mem.scenes.length ? 'continue' : 'new', title: 'A neutral scene', where: 'Station', who: [], outline: 'A participant waited.', notes: '', ended: false,
        points: [{ text: 'A participant waited.', kind: 'moment', key: true, msgs: [index] }], ...(time ? { time: { mode: time.mode || 'present', start: at(time.start), end: at(time.end) } } : {}) }],
        entities: [], changes: changes.map(c => ({ ...c, msgs: [index], ...(c.terms ? { terms: { msg: index, quote: c.terms } } : {}), ...(c.due ? { due: { ...c.due, msg: index } } : {}) })) };
    normalizeResult(d, { mem, chunk });
    assert.deepEqual(validateResult(d, { mem, chunk }), []);
    return applyResult(mem, d, chunk, { room }).mem;
}
const same = { start: { relation: 'same' }, end: { relation: 'same' } };
const promise = (words, due) => ({ op: 'add', type: 'quest', kind: 'promise', status: 'open', who: [], text: 'Participant promised to meet at the gate.', terms: words, due });
const begin = () => save(emptyMem(), { time: { start: { relation: 'explicit', date: '2026-10-24', quote: '2026-10-24' }, end: { relation: 'same' } }, words: 'It was 2026-10-24.' });
const next = (mem, days = 1, quote = days === 1 ? '다음 날' : `${days}일 뒤`) => save(mem, { time: { start: { relation: 'advance', days, quote }, end: { relation: 'same' } }, words: `${quote} 아침.` });
const q = m => m.records.find(r => r.type === 'quest');

test('"내일" made on a known day becomes a deadline one day later, and its status follows the story time', () => {
    let m = begin();
    m = save(m, { time: same, words: '내일 성문에서 만나자고 약속했다.', changes: [promise('내일 성문에서 만나자고 약속했다', { expr: '내일', days: 1 })] });
    assert.equal(q(m).due.days, 1);
    assert.equal(dueStatus(m, q(m)).kind, 'left'); assert.equal(dueStatus(m, q(m)).left, 1);
    assert.match(formatDue(m, q(m), 'ko'), /“내일” \(2026-10-25\) · 1일 남음 \(마지막 기록 기준\)/);
    m = next(m); assert.equal(dueStatus(m, q(m)).kind, 'today');
    m = next(m); assert.equal(dueStatus(m, q(m)).kind, 'past');
    assert.match(formatDue(m, q(m), 'ko'), /기한 지남 \(마지막 기록 기준, 약속을 어겼다는 뜻은 아니에요\)/);
    assert.equal(q(m).status, 'open', 'passing a deadline never closes or fails the promise');
    assert.match(recordLine(m, q(m)), /past due by 1 day as of the last record \(not necessarily broken\)/);
    assert.match(buildInjection(m, { budget: 6000 }).text, /past due by 1 day as of the last record/);
});

test('vague or mismatched deadline words keep the words only', () => {
    for (const [expr, days, words] of [['며칠 안에', 3, '며칠 안에 갚겠다고 했다.'], ['내일모레', 2, '내일모레 갚겠다고 했다.'], ['이번 주말', 2, '이번 주말까지 갚겠다고 했다.'], ['내일', 3, '내일 갚겠다고 했다.'], ['사흘쯤 뒤', 3, '사흘쯤 뒤에 갚겠다고 했다.']]) {
        let m = begin();
        m = save(m, { time: same, words, changes: [promise(words.replace(/\.$/, ''), { expr, days })] });
        assert.equal(q(m).due.days, null, expr); assert.equal(dueStatus(m, q(m)).kind, 'words', expr);
        assert.match(formatDue(m, q(m), 'ko'), /날짜로 계산할 수 없어요/, expr);
    }
    // words that are not in the message are not kept at all
    let m = begin();
    m = save(m, { time: same, words: '꼭 갚겠다고 했다.', changes: [promise('꼭 갚겠다고 했다', { expr: '내일', days: 1 })] });
    assert.equal(q(m).due, undefined);
});

test('a deadline is placed only when the moment it was said is certain', () => {
    // the part where it was said spans two days: which day is unknown
    let m = begin();
    m = save(m, { time: { start: { relation: 'same' }, end: { relation: 'advance', days: 1, quote: '다음 날' } }, words: '내일 보자고 했고, 다음 날이 되었다.', changes: [promise('내일 보자고 했고', { expr: '내일', days: 1 })] });
    assert.equal(dueStatus(m, q(m)).kind, 'words');
    // no story time at all
    m = save(emptyMem(), { words: '내일 보자고 했다.', changes: [promise('내일 보자고 했다', { expr: '내일', days: 1 })] });
    assert.equal(dueStatus(m, q(m)).kind, 'words');
    // said in an acted flashback
    m = begin();
    m = save(m, { time: { mode: 'flashback', start: { relation: 'explicit', date: '2026-10-01', quote: '2026-10-01' }, end: { relation: 'same' } }, words: '2026-10-01, 내일 보자고 했다.', changes: [promise('내일 보자고 했다', { expr: '내일', days: 1 })] });
    assert.equal(dueStatus(m, q(m)).kind, 'words');
});

test('after a vague jump the deadline cannot be compared and asks for a check', () => {
    let m = begin();
    m = save(m, { time: same, words: '내일 성문에서 만나자고 약속했다.', changes: [promise('내일 성문에서 만나자고 약속했다', { expr: '내일', days: 1 })] });
    m = save(m, { time: { start: { relation: 'jump', elapsed: '몇 주 뒤', quote: '몇 주 뒤' }, end: { relation: 'same' } }, words: '몇 주 뒤.' });
    assert.equal(dueStatus(m, q(m)).kind, 'check');
    assert.match(formatDue(m, q(m), 'ko'), /확인 필요/);
    assert.doesNotMatch(formatDue(m, q(m), 'ko'), /기한 지남/);
});

test('a stated calendar date is placed on an ISO timeline; a kept promise shows no countdown', () => {
    let m = begin();
    m = save(m, { time: same, words: '2026-10-27까지 갚겠다고 했다.', changes: [{ ...promise('2026-10-27까지 갚겠다고 했다', { expr: '2026-10-27까지', date: '2026-10-27' }), kind: 'debt' }] });
    assert.equal(dueStatus(m, q(m)).left, 3);
    m = save(m, { time: same, words: 'The debt was repaid.', changes: [{ op: 'update', id: q(m).id, status: 'done' }] });
    assert.equal(dueStatus(m, q(m)), null);
    assert.doesNotMatch(formatDue(m, q(m), 'ko'), /남음|지남/);
});

test('a manual deadline is protected from later AI deadlines and survives export, room moves and undo', () => {
    let m = begin();
    m = save(m, { time: same, words: '며칠 안에 갚겠다고 했다.', changes: [promise('며칠 안에 갚겠다고 했다', { expr: '며칠 안에', days: null })] });
    const before = structuredClone(m);
    setManualDue(m, q(m), { day: '4' });
    assert.equal(dueStatus(m, q(m)).left, 3);
    m = save(m, { time: same, words: '내일 갚겠다고 다시 말했다.', changes: [{ op: 'update', id: q(m).id, due: { expr: '내일', days: 1 } }] });
    assert.equal(q(m).due.manual.day, 3, 'the AI deadline does not replace the user\'s');
    const back = cleanMem(JSON.parse(JSON.stringify(m)));
    assert.equal(dueStatus(back, q(back)).left, 3);
    const moved = detachMem(back, 'room-A');
    assert.equal(dueStatus(moved, q(moved)).left, 3, 'a room move keeps story time and deadline');
    const diff = memDiff(before, m), undone = applyDiff(m, diff, true);
    assert.equal(q(undone).due.manual, undefined);
    // clearing the manual day keeps the words
    setManualDue(m, q(m), { day: '' });
    assert.equal(q(m).due.manual, undefined); assert.equal(q(m).due.expr, '며칠 안에');
});

test('editing the story time of the part where a promise was made moves its deadline', () => {
    let m = begin();
    m = save(m, { time: same, words: '내일 만나자고 약속했다.', changes: [promise('내일 만나자고 약속했다', { expr: '내일', days: 1 })] });
    const part = m.scenes[0].segs[1];
    assert.match(formatDue(m, q(m), 'en'), /2026-10-25/);
    editStoryTime(m, part.id, { edge: 'start', date: '2026-10-28', day: '', period: '', clock: '', mode: 'present' }, 'room-A');
    editStoryTime(m, part.id, { edge: 'end', date: '2026-10-28', day: '', period: '', clock: '', mode: 'present' }, 'room-A');
    assert.match(formatDue(m, q(m), 'en'), /2026-10-29/);
    assert.equal(dueStatus(m, q(m)).kind, 'left', 'real calendar dates compare across references'); assert.equal(dueStatus(m, q(m)).left, 1);
});

test('a manual deadline needs a confirmed current story time', () => {
    let m = save(emptyMem(), { time: { start: { relation: 'unknown' }, end: { relation: 'unknown' } }, words: '며칠 안에 갚겠다고 했다.', changes: [promise('며칠 안에 갚겠다고 했다', { expr: '며칠 안에', days: null })] });
    assert.throws(() => setManualDue(m, q(m), { day: '3' }), /지금 이야기 시간이 확인되지 않아서/);
});

test('a manual deadline may be a real calendar date on a dated timeline, or a day count on any timeline', () => {
    let m = begin();
    m = save(m, { time: same, words: '며칠 안에 갚겠다고 했다.', changes: [promise('며칠 안에 갚겠다고 했다', { expr: '며칠 안에', days: null })] });
    setManualDue(m, q(m), { day: '2026-10-30' });
    assert.equal(dueStatus(m, q(m)).left, 6);
    assert.throws(() => setManualDue(m, q(m), { day: '2026-02-30' }), /날짜가 유효하지 않아요/);
    let c = save(emptyMem(), { time: { start: { relation: 'explicit', date: '왕국력 312년 봄 3일', quote: '왕국력 312년 봄 3일' }, end: { relation: 'same' } }, words: '왕국력 312년 봄 3일.' });
    c = save(c, { time: same, words: '며칠 안에 갚겠다고 했다.', changes: [promise('며칠 안에 갚겠다고 했다', { expr: '며칠 안에', days: null })] });
    assert.throws(() => setManualDue(c, q(c), { day: '2026-10-30' }), /실제 날짜가 없어서/);
    setManualDue(c, q(c), { day: '4' });
    assert.equal(dueStatus(c, q(c)).left, 3);
});
