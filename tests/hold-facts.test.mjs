// v0.7.1-a5 (step 4): the held room's detail shows only what the decision kept (holdFacts). Nothing is compared again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { holdFacts } from '../home.js';

const A = JSON.stringify(['Ava', 'Ava - 2026-10-01@10h00m00s000ms']);
const B = JSON.stringify(['Ava', 'Ava - 2026-10-02@11h30m00s000ms']);

test('a hold made later (another reason, or not a hold decision) keeps only its reason', () => {
    for (const [d, why] of [[null, 'unproven'], [{ verdict: 'hold', why: 'unproven', prints: { total: 5, matched: 5 } }, 'tagChanged'],
        [{ verdict: 'migrate', mem: 'm1' }, 'closesUnknown'], [{ verdict: 'relink', mem: 'm1' }, 'otherOrigin']]) {
        const f = holdFacts(d, why);
        assert.equal(f.own, false);
        assert.deepEqual([f.rooms, f.mems, f.cmp], [[], [], { kind: 'none' }]);
    }
});

test('a sample comparison is kept as counted, never as a whole match or a first difference', () => {
    const f = holdFacts({ verdict: 'hold', why: 'unproven', prints: { total: 5, matched: 3, first: 2 } }, 'unproven');
    assert.deepEqual(f.cmp, { kind: 'sample', total: 5, matched: 3 });
    assert.equal(holdFacts({ verdict: 'hold', why: 'unproven', prints: { total: 0, matched: 0, first: -1 } }, 'unproven').cmp.total, 0);
    // row 6 keeps the memory too
    const g = holdFacts({ verdict: 'hold', why: 'unproven', mem: 'memA', prints: { total: 4, matched: 4, first: -1 } }, 'unproven');
    assert.deepEqual(g.mems, [{ id: 'memA', state: '' }]);
    assert.deepEqual(g.cmp, { kind: 'sample', total: 4, matched: 4 });
});

test('every recorded original matched only with a rescue offer; candidates without one compare nothing', () => {
    const f = holdFacts({ verdict: 'hold', why: 'sameIntegrity', candidates: [A], rescue: { from: A, mem: 'memA', last: 11 } }, 'sameIntegrity');
    assert.deepEqual(f.rooms, [{ addr: A, role: 'same' }]);
    assert.deepEqual(f.mems, [{ id: 'memA', state: '' }]);
    assert.deepEqual(f.cmp, { kind: 'all', n: 12 });
    const g = holdFacts({ verdict: 'hold', why: 'sameIntegrity', candidates: [A, B] }, 'sameIntegrity');
    assert.deepEqual(g.rooms.map(r => r.addr), [A, B]);
    assert.deepEqual(g.cmp, { kind: 'none' });
});

test('a branch keeps the first difference over the parent\'s whole record; a parent without its file says so', () => {
    const f = holdFacts({ verdict: 'hold', why: 'branchUnproven', parent: A, at: 7, reason: 'floor' }, 'branchUnproven');
    assert.deepEqual(f.rooms, [{ addr: A, role: 'parent' }]);
    assert.deepEqual(f.cmp, { kind: 'diff', at: 7 });
    assert.deepEqual(holdFacts({ verdict: 'hold', why: 'branchUnproven', parent: A, at: -1, reason: 'parent' }, 'branchUnproven').cmp, { kind: 'none' });
    const g = holdFacts({ verdict: 'hold', why: 'parentGone', parent: A }, 'parentGone');
    assert.equal(g.parentMissing, true);
    assert.deepEqual(g.cmp, { kind: 'none' });
});

test('other reasons keep their rooms and memory files as given, with the file state the reason means', () => {
    assert.deepEqual(holdFacts({ verdict: 'hold', why: 'copyMoved', from: A, rooms: [A, B] }, 'copyMoved').rooms, [{ addr: A, role: 'moved' }, { addr: B, role: 'moved' }]);
    assert.deepEqual(holdFacts({ verdict: 'hold', why: 'memGone', mem: 'm1' }, 'memGone').mems, [{ id: 'm1', state: 'missing' }]);
    assert.deepEqual(holdFacts({ verdict: 'hold', why: 'homeDiff', mem: 'm1' }, 'homeDiff').mems, [{ id: 'm1', state: 'other' }]);
    const r = holdFacts({ verdict: 'hold', why: 'renameUnproven', mem: 'm1', from: A }, 'renameUnproven');
    assert.deepEqual([r.rooms, r.mems], [[{ addr: A, role: 'from' }], [{ id: 'm1', state: '' }]]);
    assert.deepEqual(holdFacts({ verdict: 'hold', why: 'renamedAway', to: B }, 'renamedAway').rooms, [{ addr: B, role: 'to' }]);
    const t = holdFacts({ verdict: 'hold', why: 'traces' }, 'traces');
    assert.equal(t.own, true);
    assert.deepEqual([t.rooms, t.mems, t.cmp], [[], [], { kind: 'none' }]);
});
