import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as core from '../core.js';
import { buildExtractPrompt } from '../prompts.js';

function fixture(text = 'Theo: tired', extra = {}) {
    return { ...core.emptyMem(), entities: [
        { id: 'e1', type: 'person', name: 'Theo', aliases: ['테오', 'T'] },
        { id: 'e2', type: 'person', name: 'Mira', aliases: ['미라'] },
        { id: 'e3', type: 'item', name: 'Compass', aliases: ['나침반'] },
    ], records: [{ id: 'r1', type: 'party', entity: 'e1', aspect: 'condition', text, src: [], msgs: [], pin: false, ...extra }],
    next: { s: 1, g: 1, e: 4, r: 2 } };
}
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));

test('unique owner names and aliases are removed only as leading colon labels', () => {
    for (const text of ['Theo: tired', '  tHeO  : tired', '테오： tired', 'T: tired', 'Theo: 테오: tired']) {
        const mem = fixture(text);
        assert.equal(core.normalizeRecordNames(mem), true, text);
        assert.equal(mem.records[0].text, 'tired');
        assert.equal(core.normalizeRecordNames(mem), false, 'normalization is idempotent');
        assert.equal(core.recordLine(mem, mem.records[0], false), '[condition] Theo: tired');
    }
});

test('other names, ordinary sentences, empty descriptions and other record types survive', () => {
    for (const text of ['Mira: trusts Theo', 'Theo is tired', 'Theo는 지쳤다', 'Theo:', 'Theo:   ', 'He said Theo: wait']) {
        const mem = fixture(text);
        assert.equal(core.normalizeRecordNames(mem), false, text);
        assert.equal(mem.records[0].text, text);
    }
    const mem = fixture('Theo: meet at the gate', { type: 'quest', kind: 'goal' });
    assert.equal(core.normalizeRecordNames(mem), false);
});

test('shared aliases and colliding canonical names are left untouched', () => {
    for (const label of ['Theo', '테오']) {
        const mem = fixture(`${label}: tired`);
        mem.entities[1].aliases.push(label.toLowerCase());
        assert.equal(core.normalizeRecordNames(mem), false);
        assert.equal(mem.records[0].text, `${label}: tired`);
    }
});

test('item descriptions use the item, not its holder; Korean translations use the same rules', () => {
    const mem = fixture('Compass: cracked', { type: 'item', entity: 'e3', holder: 'e1', ko: '나침반: 금이 감' });
    core.normalizeRecordNames(mem);
    assert.equal(mem.records[0].text, 'cracked');
    assert.equal(mem.records[0].ko, '금이 감');
    mem.records[0].text = 'Theo: repaired it';
    assert.equal(core.normalizeRecordNames(mem), false);
});

test('model additions and updates normalize after entity aliases have been resolved', () => {
    const mem = core.emptyMem();
    const chunk = core.chunkMessages([{ index: 0, name: 'Narrator', text: 'Theo is tired.' }], Infinity)[0];
    const data = { entities: [{ ref: 'person', type: 'person', name: 'Theo', aliases: ['테오'] }],
        scenes: [{ scene: 'new', title: 'A rest', who: ['person'], points: [], notes: '', outline: 'They rest.', ended: false }],
        changes: [{ op: 'add', type: 'party', entity: 'person', aspect: 'condition', text: 'Theo: tired', msgs: [0] }] };
    const saved = core.applyResult(mem, data, chunk).mem;
    assert.equal(saved.records[0].text, 'tired');
    const updated = core.applyResult(saved, { ...data, entities: [], scenes: [{ ...data.scenes[0], scene: 'continue', who: ['e1'] }],
        changes: [{ op: 'update', id: 'r1', text: '테오: rested', msgs: [0] }] }, chunk).mem;
    assert.equal(updated.records[0].text, 'rested');
    assert.equal(saved.records[0].text, 'tired', 'previous memory is untouched');
});

test('legacy import/export and history restoration normalize without changing evidence', () => {
    const raw = fixture('Theo: tired', { ko: '테오: 피곤함' });
    const cleaned = core.cleanMem(raw);
    assert.equal(raw.records[0].text, 'Theo: tired', 'import does not mutate the source');
    assert.equal(cleaned.records[0].text, 'tired');
    assert.equal(cleaned.records[0].ko, '피곤함');
    assert.deepEqual(core.cleanMem(JSON.parse(JSON.stringify(cleaned))), cleaned);
    const after = structuredClone(cleaned); after.records[0].text = 'rested';
    const diff = core.memDiff(raw, after);
    const restored = core.applyDiff(after, diff, true);
    assert.equal(restored.records[0].text, 'tired');
    assert.deepEqual(restored.records[0].msgs, cleaned.records[0].msgs);
    assert.equal(core.applyDiff(restored, diff).records[0].text, 'rested');
});

test('opening old chat metadata persists cleanup once, including a restored undo snapshot', () => {
    const meta = { savePoint: { v: 1, mem: fixture() } }; let saves = 0;
    const state = vm.runInNewContext(section('function state() {', '\nfunction freshState') + ';state', {
        ...core, MODULE: 'savePoint', ctx: () => ({ chatMetadata: meta }), persistSoon: () => saves++,
    });
    state(); state();
    assert.equal(saves, 1);
    assert.equal(meta.savePoint.mem.records[0].text, 'tired');
    meta.savePoint.mem = fixture('테오: rested'); state();
    assert.equal(meta.savePoint.mem.records[0].text, 'rested');
    assert.equal(saves, 2);
});

test('real translation and manual-edit entry points normalize their stored results', async () => {
    const mem = fixture('tired');
    const translate = vm.runInNewContext(section('function applyTranslation(', '\nasync function translate') + ';applyTranslation', { ...core });
    translate(mem, 'r1|rec', '테오: 피곤함');
    assert.equal(mem.records[0].ko, '피곤함');
    const st = { mem };
    const commitEdit = vm.runInNewContext(section('async function commitEdit(', '\nasync function undo') + ';commitEdit', {
        ...core, hasChat: () => true, ensureState: () => st, clone: structuredClone,
        transact: async change => { change(); return true; }, pushHistory() {},
    });
    await commitEdit(next => { next.records[0].text = 'Theo: rested'; });
    assert.equal(st.mem.records[0].text, 'rested');
});

test('fixed output instructions cover customized collection guides too', () => {
    const prompt = buildExtractPrompt({ guide: 'My custom guide', names: {}, card: '',
        context: { entities: '', state: '', open: '(none)', recent: '' }, chunk: { from: 0, to: 0, text: '' } });
    assert.match(prompt, /without a leading person\/item name label/);
});
