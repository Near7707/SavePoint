// v0.6.34: the 📦 storage box for items. Storing only changes what the roleplay model is given;
// an item that left the story keeps its final state and is never revived as usable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, normalizeResult, validateResult, buildInjection, promptContext, cleanMem } from '../core.js';

let n = 0;
function step(mem, changes, entities = [], boxMode = 'manual') {
    const w = `m${n}`, chunk = { from: n, to: n, indices: [n], text: w, texts: { [n]: w } };
    const d = { scenes: [{ scene: mem.scenes.length ? 'continue' : 'new', title: 'Tavern', where: 'Inn', who: [], ended: false, outline: 'They sat at the inn.', notes: '',
        points: [{ text: 'They talked.', kind: 'moment', key: false, msgs: [n] }] }], entities, changes: changes.map(c => ({ msgs: [n], ...c })) };
    normalizeResult(d, { mem, chunk });
    assert.deepEqual(validateResult(d, { mem, chunk }), []);
    const out = applyResult(mem, d, chunk, { room: 'room-A', boxMode }).mem; n++;
    return out;
}
const base = () => {
    n = 0;
    let mem = step(emptyMem(), [{ op: 'add', type: 'item', entity: 'new1', holder: null, text: 'A full healing potion on the table.' },
        { op: 'add', type: 'item', entity: 'new2', holder: null, text: 'A borrowed coat hung on the sofa.' }],
    [{ ref: 'new1', type: 'item', name: 'Healing potion', aliases: [] }, { ref: 'new2', type: 'item', name: 'Borrowed coat', aliases: [] }]);
    return mem;
};

test('an item the story removes goes to the box as gone, with its final state; it is not injected', () => {
    let mem = base();
    const potion = mem.records.find(r => r.text.includes('potion'));
    mem = step(mem, [{ op: 'remove', id: potion.id, text: 'Drunk by the traveller.' }]);
    const r = mem.records.find(x => x.id === potion.id);
    assert.deepEqual([r.stored.by, r.gone, r.text], ['story', true, 'Drunk by the traveller.']);
    const inj = buildInjection(mem, { budget: 6000 }).text;
    assert(!inj.includes('Drunk by') && !inj.includes('healing potion'), 'kept out of the roleplay model');
    const ctx = promptContext(mem, 'potion');
    assert.match(ctx.state, /STORED ITEMS[\s\S]*\[item, gone\] Healing potion: Drunk by the traveller\./, 'the collector can still recognise it');
});

test('a gone item taken out of the box stays gone (never usable again)', () => {
    let mem = base();
    const potion = mem.records.find(r => r.text.includes('potion'));
    mem = step(mem, [{ op: 'remove', id: potion.id, text: 'Drunk by the traveller.' }]);
    mem.records.find(x => x.id === potion.id).stored = null;   // what "꺼내기" does
    delete mem.records.find(x => x.id === potion.id).stored;
    assert.match(buildInjection(mem, { budget: 6000 }).text, /\[item, gone\] Healing potion: Drunk by the traveller\./);
});

test('an item the user stored stays in the box when the story updates it; the record is updated, not duplicated', () => {
    let mem = base();
    const coat = mem.records.find(r => r.text.includes('coat'));
    coat.stored = { by: 'user', at: 1 };
    const id = mem.entities.find(e => e.name === 'Borrowed coat').id;
    mem = step(mem, [{ op: 'add', type: 'item', entity: id, holder: null, text: 'The borrowed coat, worn again by the traveller.' }]);
    const coats = mem.records.filter(r => r.entity === id);
    assert.equal(coats.length, 1, 'no second coat record');
    assert.deepEqual([coats[0].stored.by, coats[0].storedUpdated, coats[0].text], ['user', true, 'The borrowed coat, worn again by the traveller.']);
    assert(!buildInjection(mem, { budget: 6000 }).text.includes('worn again'), 'the user choice is respected');
    mem = step(mem, [{ op: 'update', id: coats[0].id, text: 'The coat is folded on a chair.' }]);
    assert.equal(mem.records.find(r => r.id === coats[0].id).stored.by, 'user');
});

test('an item the story removed returns to the inventory only when the story brings it back', () => {
    let mem = base();
    const potion = mem.records.find(r => r.text.includes('potion'));
    mem = step(mem, [{ op: 'remove', id: potion.id, text: 'Lost in the river.' }]);
    mem = step(mem, [{ op: 'update', id: potion.id, text: 'Someone remembers the lost potion.' }]);
    assert(mem.records.find(x => x.id === potion.id).gone, 'a mere mention does not bring it back');
    mem = step(mem, [{ op: 'update', id: potion.id, text: 'Found again on the riverbank, still sealed.', back: true }]);
    const r = mem.records.find(x => x.id === potion.id);
    assert(!r.stored && !r.gone);
    assert.match(buildInjection(mem, { budget: 6000 }).text, /Found again on the riverbank/);
});

test('the box survives save files (cleanMem) and other record types are still deleted by remove', () => {
    let mem = base();
    mem = step(mem, [{ op: 'add', type: 'world', kind: 'rule', knownBy: [], text: 'No fighting inside the inn.' }]);
    const rule = mem.records.find(r => r.type === 'world');
    const coat = mem.records.find(r => r.text.includes('coat'));
    coat.stored = { by: 'user', at: 5 }; coat.storedUpdated = true;
    mem = step(mem, [{ op: 'remove', id: rule.id }]);
    assert(!mem.records.some(r => r.id === rule.id));
    const back = cleanMem(JSON.parse(JSON.stringify(mem)));
    const c = back.records.find(r => r.id === coat.id);
    assert.deepEqual([c.stored.by, c.storedUpdated], ['user', true]);
});

test('the user\'s box choice survives the story removing the item and bringing it back', () => {
    let mem = base();
    const coat = mem.records.find(r => r.text.includes('coat'));
    coat.stored = { by: 'user', at: 1 };
    mem = step(mem, [{ op: 'remove', id: coat.id, text: 'Lost on the ferry.' }]);
    let r = mem.records.find(x => x.id === coat.id);
    assert.deepEqual([r.stored.by, r.gone], ['user', true], 'still the user\'s box; the story state is gone');
    mem = step(mem, [{ op: 'update', id: coat.id, text: 'Found the coat and wore it again.', back: true }]);
    r = mem.records.find(x => x.id === coat.id);
    assert.equal(r.stored.by, 'user'); assert(!r.gone && r.storedUpdated);
    assert(!buildInjection(mem, { budget: 6000 }).text.includes('wore it again'), 'stays out until the user takes it out');
});

test('a gone item the user took out is no longer gone once the story brings it back', () => {
    let mem = base();
    const coat = mem.records.find(r => r.text.includes('coat'));
    mem = step(mem, [{ op: 'remove', id: coat.id, text: 'Lost on the ferry.' }]);
    delete mem.records.find(x => x.id === coat.id).stored;   // 꺼내기
    assert.match(buildInjection(mem, { budget: 6000 }).text, /\[item, gone\] Borrowed coat: Lost on the ferry\./);
    mem = step(mem, [{ op: 'update', id: coat.id, text: 'Found the coat and wore it again.', back: true }]);
    const text = buildInjection(mem, { budget: 6000 }).text;
    assert.match(text, /\[item\] Borrowed coat: Found the coat and wore it again\./);
    assert(!text.includes('[item, gone] Borrowed coat'), 'no contradictory gone line');
    const id = mem.entities.find(e => e.name === 'Borrowed coat').id;
    mem = step(mem, [{ op: 'remove', id: coat.id, text: 'Lost again.' }]);
    mem = step(mem, [{ op: 'add', type: 'item', entity: id, holder: null, text: 'The coat turned up at the inn.' }]);
    assert.equal(mem.records.filter(r => r.entity === id).length, 1, 'an add for a gone item updates it');
    assert(!mem.records.find(r => r.entity === id).gone);
});

test('"back" is only for items', () => {
    let mem = base();
    mem = step(mem, [{ op: 'add', type: 'world', kind: 'rule', knownBy: [], text: 'No fighting inside the inn.' }]);
    const rule = mem.records.find(r => r.type === 'world');
    const w = 'm', chunk = { from: n, to: n, indices: [n], text: w, texts: { [n]: w } };
    const d = { scenes: [{ scene: 'continue', title: 'Tavern', where: 'Inn', who: [], ended: false, outline: 'x.', notes: '', points: [{ text: 'y', kind: 'moment', key: false, msgs: [n] }] }], entities: [],
        changes: [{ op: 'update', id: rule.id, back: true, msgs: [n] }] };
    normalizeResult(d, { mem, chunk });
    assert(validateResult(d, { mem, chunk }).some(e => e.includes('back is only for items')));
});

test('box modes decide what happens when the story uses a user-boxed item again; 🔒 always keeps it', () => {
    const run = (mode, lock = false) => {
        let mem = base();
        const coat = mem.records.find(r => r.text.includes('coat'));
        coat.stored = { by: 'user', at: 1, ...(lock ? { lock: true } : {}) };
        mem = step(mem, [{ op: 'update', id: coat.id, text: 'Wearing the borrowed coat again.', back: true }], [], mode);
        return mem.records.find(r => r.id === coat.id);
    };
    const manual = run('manual'), notify = run('notify'), auto = run('auto'), locked = run('auto', true), lockedNotify = run('notify', true);
    assert.deepEqual([manual.stored?.by, !!manual.returnNotice, manual.storedUpdated], ['user', false, true]);
    assert.deepEqual([notify.stored?.by, !!notify.returnNotice], ['user', true]);
    assert(!auto.stored && !auto.returnNotice, 'auto takes it out');
    assert.deepEqual([locked.stored?.by, locked.stored.lock, !!locked.returnNotice], ['user', true, false]);
    assert(!lockedNotify.returnNotice, 'a locked item raises no notice');
});

test('a mere mention never triggers the box mode; a story-boxed item returns in every mode', () => {
    let mem = base();
    const coat = mem.records.find(r => r.text.includes('coat'));
    coat.stored = { by: 'user', at: 1 };
    mem = step(mem, [{ op: 'update', id: coat.id, text: 'Someone talks about the coat.' }], [], 'auto');
    assert.equal(mem.records.find(r => r.id === coat.id).stored?.by, 'user');
    const potion = mem.records.find(r => r.text.includes('potion'));
    mem = step(mem, [{ op: 'remove', id: potion.id, text: 'Lost.' }], [], 'manual');
    mem = step(mem, [{ op: 'update', id: potion.id, text: 'Found it.', back: true }], [], 'manual');
    assert(!mem.records.find(r => r.id === potion.id).stored);
});

test('lock and notice survive save files', () => {
    let mem = base();
    const coat = mem.records.find(r => r.text.includes('coat'));
    coat.stored = { by: 'user', at: 1, lock: true }; coat.returnNotice = { at: 9 };
    const back = cleanMem(JSON.parse(JSON.stringify(mem))).records.find(r => r.id === coat.id);
    assert.deepEqual([back.stored.lock, back.returnNotice.at], [true, 9]);
});
