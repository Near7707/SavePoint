// v0.6.96: the record batch — outline cap for the collector, input breakdown on the limit error,
// "id" read as "ref" for new entities, and one live record per item.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, normalizeResult, validateResult, promptContext, openScene, sceneOutlineText, outlineTail } from '../core.js';
import { nextMessageChunk, assertPromptFits, InputLimitError } from '../request-batches.js';
import { buildExtractPromptParts, DEFAULT_GUIDE } from '../prompts.js';

function story() {
    let mem = emptyMem(), n = 0;
    const step = (scene, changes = [], entities = [], { expectErrors = false } = {}) => {
        const w = `m${n}: Ari walked on with Bo.`;
        const chunk = { from: n, to: n, indices: [n], text: `#${n} ${w}`, texts: { [n]: w } };
        const d = { scenes: [{ title: 'Long road', where: 'Road', who: [], ended: false, notes: '',
            points: [{ text: `Step ${n}.`, kind: 'moment', key: false, msgs: [n] }], ...scene }], entities, changes: changes.map(c => ({ msgs: [n], ...c })) };
        const fixes = normalizeResult(d, { mem, chunk });
        const errors = validateResult(d, { mem, chunk });
        if (expectErrors) return { errors, fixes };
        assert.deepEqual(errors, []);
        mem = applyResult(mem, d, chunk, { room: 'r' }).mem; n++;
        return { mem, fixes };
    };
    return { step, get mem() { return mem; } };
}

test('a scene left open for a long time sends only its newest outline parts to the collector; the stored outline is whole', () => {
    const s = story();
    s.step({ scene: 'new', outline: 'Part 0 ' + 'x'.repeat(300) + '.' }, [], [{ ref: 'a', type: 'person', name: 'Ari', aliases: [] }]);
    for (let i = 1; i < 60; i++) s.step({ scene: 'continue', outline: `Part ${i} ` + 'x'.repeat(300) + '.' });
    const open = openScene(s.mem);
    assert.ok(sceneOutlineText(open).length > 18000, 'nothing stored is cut');
    const c = promptContext(s.mem, 'Ari');
    const line = c.open.split('\n').find(l => l.startsWith('Outline so far:'));
    assert.ok(line.length < 4300, `capped (${line.length})`);
    assert.match(line, /\(\d+ earlier parts not shown\)/);
    assert.match(line, /Part 59 /, 'the newest part is kept');
    assert.doesNotMatch(line, /Part 0 /);
    // Once it closes it is one of the recent scenes: capped there too.
    s.step({ scene: 'new', title: 'Next', outline: 'Next.' });
    const recent = promptContext(s.mem, 'Ari').recent;
    assert.ok(recent.length < 1800, `recent capped (${recent.length})`);
    assert.match(recent, /Part 59 /);
});

test('recent closed scenes are capped too, and short outlines are sent as before', () => {
    const scene = { id: 's1', title: 'T', status: 'closed', segs: Array.from({ length: 20 }, (_, i) => ({ outline: `Bit ${i} ` + 'y'.repeat(200), points: [] })) };
    const t = outlineTail(scene, 1500);
    assert.ok(t.length < 1600 && /Bit 19 /.test(t) && /earlier parts not shown/.test(t));
    const short = { title: 'T', segs: [{ outline: 'One.', points: [] }, { outline: 'Two.', points: [] }] };
    assert.equal(outlineTail(short, 1500), sceneOutlineText(short));
    const huge = { title: 'T', segs: [{ outline: 'z'.repeat(5000), points: [] }] };
    assert.ok(outlineTail(huge, 1500).length <= 1501, 'one part longer than the cap keeps its end');
});

test('the input limit error carries what filled the input, before any request is sent', () => {
    const make = c => buildExtractPromptParts({ guide: DEFAULT_GUIDE, names: { char: 'Ari', user: 'Bo' }, card: 'card', context: { entities: '(none yet)', state: '(empty)', time: '', open: '(none)', recent: '(none)' }, chunk: c });
    const msgs = [{ index: 3, name: 'Ari', text: 'w'.repeat(30000) }];
    let err;
    try { nextMessageChunk(msgs, make, 20000); } catch (e) { err = e; }
    assert.ok(err instanceof InputLimitError);
    assert.ok(err.parts && err.parts.messages > 30000 && err.parts.guide > 1000, JSON.stringify(err.parts));
    assert.equal(Object.values(err.parts).reduce((a, b) => a + b, 0), err.chars);
    // A plain string prompt still works, with no breakdown.
    assert.throws(() => nextMessageChunk(msgs, c => make(c).text, 20000), e => e instanceof InputLimitError && e.parts === null);
    assert.throws(() => assertPromptFits('a'.repeat(11), 10, { guide: 11 }), e => e.parts?.guide === 11);
});

test('a new entity declared with "id" ("new1", or an id that does not exist) is read as its ref', () => {
    const s = story();
    s.step({ scene: 'new', outline: 'Start.' }, [], [{ ref: 'a', type: 'person', name: 'Ari', aliases: [] }]);
    const r = s.step({ scene: 'continue', outline: 'Shirt.' },
        [{ op: 'add', type: 'item', entity: 'new1', holder: 'e1', text: 'A black shirt.' }, { op: 'add', type: 'item', entity: 'e20', holder: 'e1', text: 'A red scarf.' }],
        [{ id: 'new1', type: 'item', name: 'black shirt', aliases: [] }, { id: 'e20', type: 'item', name: 'red scarf', aliases: [] }]);
    assert.ok(r.fixes.some(f => f.startsWith('ref:')));
    const names = s.mem.entities.map(e => e.name);
    assert.ok(names.includes('black shirt') && names.includes('red scarf'));
    const scarf = s.mem.entities.find(e => e.name === 'red scarf');
    assert.ok(s.mem.records.some(x => x.type === 'item' && x.entity === scarf.id));
    // An id that does not exist without a type or name is still an error; so is a name that already exists.
    let out = s.step({ scene: 'continue', outline: 'x' }, [], [{ id: 'e40', name: 'thing' }], { expectErrors: true });
    assert.ok(out.errors.some(e => /unknown entity id "e40"/.test(e)));
    out = s.step({ scene: 'continue', outline: 'x' }, [], [{ id: 'e41', type: 'person', name: 'Ari', aliases: [] }], { expectErrors: true });
    assert.ok(out.errors.some(e => /already exists as e1/.test(e)));
    // An "e"-shaped ref written as a ref is still refused.
    out = s.step({ scene: 'continue', outline: 'x' }, [], [{ ref: 'e42', type: 'item', name: 'cup', aliases: [] }], { expectErrors: true });
    assert.ok(out.errors.some(e => /looks like an id/.test(e)));
});

// v0.6.99 (review P2): an existing id with spaces around it must not become a new entity's ref.
test('an existing id with spaces (" e1 ") is not read as a new ref, and a new ref may never be an existing id', () => {
    const s = story();
    s.step({ scene: 'new', outline: 'Start.' }, [], [{ ref: 'a', type: 'person', name: 'Ari', aliases: [] }]);
    const ari = s.mem.entities.find(e => e.name === 'Ari').id;
    assert.equal(ari, 'e1');
    const out = s.step({ scene: 'continue', outline: 'More.', who: [ari] },
        [{ op: 'add', type: 'item', entity: 'sh', holder: ari, text: 'A black shirt.' }],
        [{ id: ` ${ari} `, type: 'person', name: 'Bo', aliases: [] }, { ref: 'sh', type: 'item', name: 'black shirt', aliases: [] }], { expectErrors: true });
    assert.ok(!out.fixes.some(f => f.startsWith('ref:')), 'not read as a ref');
    assert.ok(out.errors.some(e => /unknown entity id " e1 "/.test(e)), 'asked again, as before v0.6.96');
    assert.deepEqual(s.mem.entities.map(e => e.name), ['Ari']);
    // Validation alone also refuses a ref (read from "id") that is an existing id.
    const d = { scenes: [{ scene: 'continue', title: 'T', outline: 'x', where: 'Road', who: ['e1'], ended: false, notes: '',
        points: [{ text: 'x.', kind: 'moment', key: false, msgs: [9] }] }], entities: [{ ref: 'e1', type: 'person', name: 'Bo', aliases: [] }], changes: [] };
    Object.defineProperty(d.entities[0], 'refFromId', { value: true });
    const errors = validateResult(d, { mem: s.mem, chunk: { from: 9, to: 9, indices: [9], text: '#9 x', texts: { 9: 'x' } } });
    assert.ok(errors.some(e => /"e1" is already the id of an existing entity/.test(e)), errors.join('\n'));
});

test('adding an item that already has a live record updates that record instead of adding a second one', () => {
    const s = story();
    s.step({ scene: 'new', outline: 'Start.' }, [{ op: 'add', type: 'item', entity: 'sh', holder: 'a', text: 'A black shirt, clean.' }],
        [{ ref: 'a', type: 'person', name: 'Ari', aliases: [] }, { ref: 'b', type: 'person', name: 'Bo', aliases: [] }, { ref: 'sh', type: 'item', name: 'black shirt', aliases: [] }]);
    const shirt = s.mem.entities.find(e => e.name === 'black shirt').id, bo = s.mem.entities.find(e => e.name === 'Bo').id;
    s.step({ scene: 'continue', outline: 'Torn.' }, [{ op: 'add', type: 'item', entity: shirt, holder: bo, text: 'A black shirt, torn at the sleeve.' }]);
    const recs = s.mem.records.filter(x => x.type === 'item' && x.entity === shirt);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].text, 'A black shirt, torn at the sleeve.');
    assert.equal(recs[0].holder, bo);
    assert.deepEqual(recs[0].msgs, [0, 1]);
});
