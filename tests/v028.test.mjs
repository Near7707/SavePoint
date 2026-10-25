import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, validateResult, applyResult, findQuote, termsContext, validateCheck, chunkMessages } from '../core.js';

const RULE = '"House rules." Theo tapped the table. "Two rounds of cards. **The one who loses washes the dishes.** The one who wins dries them, and pretends it is harder." He shuffled the deck. The kettle clicked off.';
const msgs = [
    { index: 48, name: 'Theo', text: RULE },
    { index: 49, name: 'Mara', text: 'Deal.' },
    { index: 50, name: 'Theo', text: 'Mara won the first round.' },
    { index: 51, name: 'Mara', text: 'Again.' },
    { index: 52, name: 'Theo', text: 'New plan: we wash together tonight.' },
];
const chunk = chunkMessages(msgs, Infinity)[0];
const scene = (extra = {}) => ({ scene: 'new', title: 'Cards', outline: 'They played cards.', points: [{ text: 'Played.', kind: 'change', key: false, msgs: [50] }], ...extra });

test('a quote is found despite markdown, quote marks and spacing; context keeps the other half of the rule', () => {
    const at = findQuote(RULE, 'The one who loses washes the dishes.');
    assert.ok(at);
    assert.equal(RULE.slice(at.start, at.end), 'The one who loses washes the dishes');
    const ctx = termsContext(RULE, at.start, at.end);
    assert.ok(ctx.includes('The one who wins dries them'), ctx);
    assert.ok(ctx.includes('Two rounds of cards'));
    assert.equal(findQuote(RULE, 'The winner owes the loser a cake'), null);
    assert.ok(findQuote('He said: “The one who   loses\n washes.”', '"the one who loses washes"'));
});

test('a debt needs terms that really are in the cited message', () => {
    const base = { scenes: [scene()], entities: [{ ref: 'a', type: 'person', name: 'Theo' }, { ref: 'n', type: 'person', name: 'Mara' }] };
    const without = { ...base, changes: [{ op: 'add', type: 'quest', kind: 'debt', who: ['a', 'n'], text: 'Theo owes Mara the dishes.', msgs: [48] }] };
    assert.ok(validateResult(without, { mem: emptyMem(), chunk }).some(e => e.includes('needs "terms"')));
    const wrong = { ...base, changes: [{ ...without.changes[0], terms: { msg: 48, quote: 'Theo owes Mara the dishes' } }] };
    assert.ok(validateResult(wrong, { mem: emptyMem(), chunk }).some(e => e.includes('is not in message #48')));
    const goal = { ...base, changes: [{ op: 'add', type: 'quest', kind: 'goal', who: ['a'], text: 'Win a round.', msgs: [50] }] };
    assert.deepEqual(validateResult(goal, { mem: emptyMem(), chunk }), [], 'goals need no terms');
    const ok = { ...base, changes: [{ ...without.changes[0], terms: { msg: '#48', quote: 'The one who loses washes the dishes.' } }] };
    assert.deepEqual(validateResult(ok, { mem: emptyMem(), chunk }), []);
    const { mem } = applyResult(emptyMem(), ok, chunk);
    const r = mem.records[0];
    assert.equal(r.terms.msg, 48);
    assert.equal(r.terms.quote, 'The one who loses washes the dishes');
    assert.ok(r.terms.context.includes('The one who wins dries them'));
});

test('marking a debt paid keeps its terms; new terms replace them only when given', () => {
    const base = { scenes: [scene()], entities: [{ ref: 'a', type: 'person', name: 'Theo' }] };
    let { mem } = applyResult(emptyMem(), { ...base, changes: [{ op: 'add', type: 'quest', kind: 'promise', who: ['a'], text: 'Theo will wash the dishes.', terms: { msg: 48, quote: 'The one who loses washes the dishes' }, msgs: [48] }] }, chunk);
    const id = mem.records[0].id;
    const later = chunkMessages([{ index: 60, name: 'Theo', text: 'He washed every plate.' }, { index: 61, name: 'Theo', text: 'New rule: the loser also sweeps the floor.' }], Infinity)[0];
    const paid = { scenes: [{ ...scene(), points: [{ text: 'Paid.', kind: 'change', key: false, msgs: [60] }] }], changes: [{ op: 'update', id, status: 'done', msgs: [60] }] };
    assert.deepEqual(validateResult(paid, { mem, chunk: later }), []);
    mem = applyResult(mem, paid, later).mem;
    assert.equal(mem.records[0].status, 'done');
    assert.equal(mem.records[0].terms.quote, 'The one who loses washes the dishes');
    assert.deepEqual(mem.records[0].msgs, [48, 60]);
    const changed = { scenes: paid.scenes, changes: [{ op: 'update', id, text: 'The loser also sweeps the floor.', terms: { msg: 61, quote: 'the loser also sweeps the floor' }, msgs: [61] }] };
    assert.deepEqual(validateResult(changed, { mem, chunk: later }), []);
    mem = applyResult(mem, changed, later).mem;
    assert.equal(mem.records[0].terms.msg, 61);
    const onItem = { scenes: paid.scenes, changes: [{ op: 'update', id, terms: { msg: 61, quote: 'nobody said this' }, msgs: [61] }] };
    assert.ok(validateResult(onItem, { mem, chunk: later }).some(e => e.includes('is not in message #61')));
});

test('a continued scene keeps the title it started with', () => {
    let { mem } = applyResult(emptyMem(), { scenes: [scene({ title: 'Card night' })] }, chunk);
    const more = chunkMessages([{ index: 53, name: 'Theo', text: 'More cards.' }], Infinity)[0];
    mem = applyResult(mem, { scenes: [{ scene: 'continue', title: 'Card night and the walk home', outline: 'More cards.', points: [{ text: 'x', kind: 'moment', key: false, msgs: [53] }] }] }, more).mem;
    assert.equal(mem.scenes.length, 1);
    assert.equal(mem.scenes[0].title, 'Card night');
    assert.equal(mem.scenes[0].segs.length, 2);
});

test('check issues: misread names the wrong one; disagreement without proof is "unclear" with both ids', () => {
    const ids = new Set(['r3', 'g2.0']);
    const { issues } = validateCheck({ issues: [
        { about: 'g2.0', kind: 'misread', problem: 'Says loser Theo.', msgs: [68] },
        { about: 'r3', also: 'g2.0', kind: 'unclear', problem: 'They disagree.', msgs: [] },
        { about: 'r3', also: 'g2.0', kind: 'contradiction', problem: 'Old kind.', msgs: [] },
        { about: 'r3', also: 'zz', kind: 'unclear', problem: 'Unknown other id.', msgs: [] },
    ] }, ids);
    assert.deepEqual(issues.map(x => [x.about, x.kind, x.also ?? null]), [['g2.0', 'misread', null], ['r3', 'unclear', 'g2.0'], ['r3', 'unclear', 'g2.0'], ['r3', 'unclear', null]]);
});
