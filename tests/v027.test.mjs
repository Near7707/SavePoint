import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, normalizeResult, validateResult, applyResult, groupErrors } from '../core.js';

const chunkOf = (from, to) => ({ from, to, indices: Array.from({ length: to - from + 1 }, (_, i) => from + i), text: '' });
const pt = (text, msgs) => ({ text, kind: 'change', key: true, msgs });

test('bare names are linked to the one entity they name (declared in this reply)', () => {
    const data = {
        entities: [{ ref: 'new1', type: 'person', name: 'Theo' }, { ref: 'new2', type: 'person', name: 'Mara', aliases: ['MRA'] }, { ref: 'new3', type: 'item', name: 'Pip the paper kite', aliases: ['Pip'] }],
        scenes: [{ scene: 'new', title: 'Fair', outline: 'They played.', who: ['Theo', 'MRA'], points: [pt('Theo won the kite.', [1])] }],
        changes: [{ op: 'add', type: 'item', entity: 'Pip', holder: 'Theo', text: 'Won at the ring toss.', msgs: [1] }],
    };
    const notes = normalizeResult(data, { mem: emptyMem(), chunk: chunkOf(0, 3) });
    assert.deepEqual(data.scenes[0].who, ['new1', 'new2']);
    assert.equal(data.changes[0].entity, 'new3');
    assert.equal(data.changes[0].holder, 'new1');
    assert.ok(notes.some(n => n.includes('"Theo" -> new1')));
    assert.deepEqual(validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 3) }), []);
});

test('a name shared by two entities is not guessed', () => {
    const mem = emptyMem();
    mem.entities.push({ id: 'e1', type: 'item', name: 'Pip the paper kite', aliases: ['Pip'] }, { id: 'e2', type: 'place', name: 'Pip Crossing', aliases: ['Pip'] },
        { id: 'e3', type: 'person', name: 'Theo', aliases: [] });
    const data = { scenes: [{ scene: 'new', title: 'T', outline: 'O', who: ['theo'], points: [pt('x', [0])] }],
        changes: [{ op: 'add', type: 'item', entity: 'Pip', holder: 'Theo', text: 't', msgs: [0] }] };
    normalizeResult(data, { mem, chunk: chunkOf(0, 1) });
    assert.deepEqual(data.scenes[0].who, ['e3']);
    assert.equal(data.changes[0].entity, 'Pip');
    assert.equal(data.changes[0].holder, 'e3');
    assert.ok(validateResult(data, { mem, chunk: chunkOf(0, 1) }).some(e => e.includes('"Pip"')));
});

test('a point keeps only message numbers inside its own scene; one with none inside is rejected', () => {
    const mem = emptyMem();
    const data = { scenes: [
        { scene: 'new', title: 'A', outline: 'O', points: [pt('round', [52, 53, 55]), pt('tea', [55])] },
        { scene: 'new', start: 55, title: 'B', outline: 'O', points: [pt('tea', [55])] },
    ] };
    normalizeResult(data, { mem, chunk: chunkOf(50, 56) });
    assert.deepEqual(data.scenes[0].points[0].msgs, [52, 53]);
    assert.deepEqual(data.scenes[0].points[1].msgs, [55]);
    const errors = validateResult(data, { mem, chunk: chunkOf(50, 56) });
    assert.ok(errors.some(e => e.startsWith('scenes[0].points[1] cites only messages outside this scene (#50-#54)')));
    data.scenes[0].points.pop();
    assert.deepEqual(validateResult(data, { mem, chunk: chunkOf(50, 56) }), []);
    const { mem: next } = applyResult(mem, data, chunkOf(50, 56));
    assert.equal(next.scenes[0].segs[0].points.length, 1);
});

test('repeated name errors are shown as one line', () => {
    const lines = groupErrors([
        'scenes[0].who[0] "Theo" is not a known entity id or a ref declared in "entities".',
        'changes[0] ("x").entity "Theo" is not a known entity id or a ref declared in "entities".',
        'changes[1] ("y").holder "Mara" is not a known entity id or a ref declared in "entities".',
        'scenes[0].title is empty.',
    ]);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('"Theo" ×2') && lines[0].includes('"Mara" ×1'));
    assert.equal(lines[1], 'scenes[0].title is empty.');
});

test('a later scene marked "continue" is merged into the scene before it', () => {
    const mem = emptyMem();
    const data = { scenes: [
        { scene: 'new', title: 'Fair', outline: 'They played.', who: ['e1'], notes: 'First half.', points: [pt('a', [0])], ended: false },
        { scene: 'continue', title: 'Fair 2', outline: 'They kept playing.', who: ['e2'], notes: 'Second half.', points: [pt('b', [2])], ended: true, star: true },
        { scene: 'new', start: 4, title: 'Drive', outline: 'They left.', points: [pt('c', [4])] },
    ] };
    mem.entities.push({ id: 'e1', type: 'person', name: 'Theo', aliases: [] }, { id: 'e2', type: 'person', name: 'Mara', aliases: [] });
    const notes = normalizeResult(data, { mem, chunk: chunkOf(0, 5) });
    assert.ok(notes.includes('merged:2>1'));
    assert.equal(data.scenes.length, 2);
    const s0 = data.scenes[0];
    assert.deepEqual(s0.points.map(p => p.text), ['a', 'b']);
    assert.equal(s0.outline, 'They played. They kept playing.');
    assert.equal(s0.notes, 'First half. Second half.');
    assert.deepEqual(s0.who, ['e1', 'e2']);
    assert.equal(s0.ended, true);
    assert.equal(s0.star, true);
    assert.equal(s0.title, 'Fair');
    assert.deepEqual(validateResult(data, { mem, chunk: chunkOf(0, 5) }), []);
    const { mem: next } = applyResult(mem, data, chunkOf(0, 5));
    assert.deepEqual(next.scenes.map(s => [s.title, s.segs[0].from, s.segs[0].to]), [['Fair', 0, 3], ['Drive', 4, 5]]);
});
