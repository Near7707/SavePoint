// v0.6.36: party standby. Recording is unchanged; only what the roleplay model is given changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, normalizeResult, validateResult, buildInjection, cleanMem, promptContext } from '../core.js';

function build() {
    let mem = emptyMem(), n = 0;
    const step = (who, changes, entities = []) => {
        const w = `m${n}`, chunk = { from: n, to: n, indices: [n], text: w, texts: { [n]: w } };
        const d = { scenes: [{ scene: 'new', title: `Scene ${n}`, where: 'Town', who, ended: true, outline: `Outline ${n}.`, notes: '',
            points: [{ text: 'They talked.', kind: 'moment', key: false, msgs: [n] }] }], entities, changes: changes.map(c => ({ msgs: [n], ...c })) };
        normalizeResult(d, { mem, chunk });
        assert.deepEqual(validateResult(d, { mem, chunk }), []);
        mem = applyResult(mem, d, chunk, { room: 'r' }).mem; n++;
    };
    step(['p1', 'p2'], [{ op: 'add', type: 'party', entity: 'p2', aspect: 'relation', text: 'Wren owes the courier a favour.' },
        { op: 'add', type: 'party', entity: 'p2', aspect: 'condition', text: 'Wren has a bandaged arm.' }],
    [{ ref: 'p1', type: 'person', name: 'Courier', aliases: [] }, { ref: 'p2', type: 'person', name: 'Wren', aliases: [] }]);
    const c = mem.entities.find(e => e.name === 'Courier').id;
    for (let k = 0; k < 4; k++) step([c], []);   // Wren is out of the recent scenes
    return mem;
}
const wren = mem => mem.entities.find(e => e.name === 'Wren');

test('active: a person out of the recent scenes is still a normal candidate', () => {
    const t = buildInjection(build(), { budget: 6000 }).text;
    assert.match(t, /favour/); assert.match(t, /bandaged/);
});

test('standby: nothing by default, only the newest record when named, everything when back in a scene', () => {
    const mem = build(); wren(mem).standby = 'standby';
    let t = buildInjection(mem, { budget: 6000, query: 'The courier walked home.' }).text;
    assert(!/favour|bandaged/.test(t));
    t = buildInjection(mem, { budget: 6000, query: 'I wonder how Wren is doing.' }).text;
    assert(/bandaged/.test(t) && !/favour/.test(t), 'named only: the newest record');
    mem.scenes.at(-1).who.push(wren(mem).id);
    t = buildInjection(mem, { budget: 6000 }).text;
    assert(/favour/.test(t) && /bandaged/.test(t), 'back in a scene: all of them');
});

test('exclude: never, even when named or present; a 📌 record still goes in; the collector still sees them', () => {
    const mem = build(); wren(mem).standby = 'exclude';
    mem.scenes.at(-1).who.push(wren(mem).id);
    let t = buildInjection(mem, { budget: 6000, query: 'Wren waved.' }).text;
    assert(!/favour|bandaged/.test(t));
    mem.records.find(r => r.text.includes('favour')).pin = true;
    t = buildInjection(mem, { budget: 6000 }).text;
    assert(/favour/.test(t) && !/bandaged/.test(t));
    assert.match(promptContext(mem, 'Wren').state, /bandaged/, 'recording keeps seeing every record');
    assert.equal(cleanMem(JSON.parse(JSON.stringify(mem))).entities.find(e => e.name === 'Wren').standby, 'exclude');
});

test('v0.6.38: the newest relation/condition is the one changed last, not the one last in the list', async () => {
    const { newestParty } = await import('../core.js');
    let mem = emptyMem(), n = 0;
    const step = (changes, entities = []) => {
        const w = `m${n}`, chunk = { from: n, to: n, indices: [n], text: w, texts: { [n]: w } };
        const d = { scenes: [{ scene: 'new', title: `Scene ${n}`, where: 'Town', who: [], ended: true, outline: `Outline ${n}.`, notes: '',
            points: [{ text: 'They talked.', kind: 'moment', key: false, msgs: [n] }] }], entities, changes: changes.map(c => ({ msgs: [n], ...c })) };
        normalizeResult(d, { mem, chunk });
        assert.deepEqual(validateResult(d, { mem, chunk }), []);
        mem = applyResult(mem, d, chunk, { room: 'r' }).mem; n++;
    };
    step([{ op: 'add', type: 'party', entity: 'p', aspect: 'condition', text: 'Wren sprained an ankle.' }], [{ ref: 'p', type: 'person', name: 'Wren', aliases: [] }]);
    const id = wren(mem).id;
    step([{ op: 'add', type: 'party', entity: id, aspect: 'condition', text: 'Wren is hungry.' }]);
    const ankle = mem.records.find(r => /ankle/.test(r.text)).id;
    step([{ op: 'update', id: ankle, text: 'Wren’s ankle has fully healed.' }]);
    assert.match(newestParty(mem, id, 'condition').text, /healed/);
    // standby + named: the one line given is the healed one
    wren(mem).standby = 'standby';
    const t = buildInjection(mem, { budget: 6000, query: 'Is Wren around?' }).text;
    assert(/healed/.test(t) && !/hungry/.test(t), t);
    // seq survives a save file round trip
    assert.match(newestParty(cleanMem(JSON.parse(JSON.stringify(mem))), id, 'condition').text, /healed/);
});
