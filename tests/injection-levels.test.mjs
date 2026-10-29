import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, normalizeResult, validateResult, buildInjection, neededBudget, shortOutline, cleanMem } from '../core.js';
import { compactSceneTimes } from '../temporal.js';

const line = (d, t) => `📅 Date: ${d} | 🕒 Time: ${t}`;
const ex = (d, t) => ({ relation: 'explicit', date: d, clock: t, quote: line(d, t) });
function build(parts) {
    let mem = emptyMem(), n = 0;
    for (const p of parts) {
        const w = `x\n${(p.q || []).join('\n')}`;
        const chunk = { from: n, to: n, indices: [n], text: w, texts: { [n]: w } };
        const at = t => t && { ...t, msg: n };
        const d = { scenes: [{ scene: p.newScene ? 'new' : 'continue', title: p.title || 'Night watch', where: 'Pier', who: [], ended: !!p.ended, outline: p.outline, notes: '',
            points: [{ text: 'A point.', kind: 'moment', key: false, msgs: [n] }], ...(p.s ? { time: { mode: p.mode || 'present', start: at(p.s), end: at(p.e) } } : {}) }], entities: [], changes: [] };
        normalizeResult(d, { mem, chunk });
        assert.deepEqual(validateResult(d, { mem, chunk }), []);
        mem = applyResult(mem, d, chunk, { room: 'room-A' }).mem; n++;
    }
    return mem;
}

test('a scene states its date once; parts carry only what changed', () => {
    const mem = build([
        { newScene: true, s: ex('2026-10-25', '21:00'), e: ex('2026-10-25', '23:30'), q: [line('2026-10-25', '21:00'), line('2026-10-25', '23:30')], outline: 'They started the night watch.' },
        { s: { relation: 'same' }, e: ex('2026-10-25', '23:50'), q: [line('2026-10-25', '23:50')], outline: 'A boat appeared.' },
        { s: { relation: 'same' }, e: ex('2026-10-26', '02:00'), q: [line('2026-10-26', '02:00')], outline: 'Past midnight it was still there.' },
    ]);
    const { head, labels } = compactSceneTimes(mem.scenes[0], mem.timeAnchors);
    assert.equal(head, '2026-10-25 → 2026-10-26');
    assert.deepEqual([...labels.values()], ['21:00–23:30', '23:30–23:50', '23:50 → 2026-10-26 02:00'], 'the date is written again when it changes');
    const text = buildInjection(mem, { budget: 6000 }).text;
    assert.equal((text.match(/2026-10-25/g) || []).length, 1, 'the same date is not repeated in the journal');
    assert.match(text, /\[23:50 → 2026-10-26 02:00\] Past midnight/);
});

test('an unconfirmed time, a flashback and a different reference all restate the date', () => {
    const mem = build([
        { newScene: true, s: ex('2026-10-25', '21:00'), e: { relation: 'unknown' }, q: [line('2026-10-25', '21:00')], outline: 'Fog rolled in.' },
        { s: ex('2026-10-25', '23:00'), e: { relation: 'same' }, q: [line('2026-10-25', '23:00')], outline: 'The fog lifted.' },
        { s: ex('2026-09-01', '10:00'), e: { relation: 'same' }, q: [line('2026-09-01', '10:00')], mode: 'flashback', outline: 'A memory of the first visit.' },
        { s: { relation: 'same' }, e: { relation: 'same' }, outline: 'Back on the pier.' },
    ]);
    const labels = [...compactSceneTimes(mem.scenes[0], mem.timeAnchors).labels.values()];
    assert.deepEqual(labels, ['21:00 → time unconfirmed', '2026-10-25 23:00', 'flashback 2026-09-01 10:00', '2026-10-25 23:00']);
});

test('the short outline is the first sentence of the first and last parts, never cut mid-sentence', () => {
    const one = build([{ newScene: true, outline: 'They met at the gate. They talked for an hour.' }]);
    assert.equal(shortOutline(one.scenes[0]), 'They met at the gate.');
    const many = build([{ newScene: true, outline: 'They met at the gate. They talked.' }, { outline: 'It rained.' }, { outline: 'They parted at dusk. Both were tired.' }]);
    assert.equal(shortOutline(many.scenes[0]), 'They met at the gate. … They parted at dusk.');
    const same = build([{ newScene: true, outline: 'They waited.' }, { outline: 'They waited.' }]);
    assert.equal(shortOutline(same.scenes[0]), 'They waited.', 'the same sentence is used once');
});

function longStory(n = 40) {
    const parts = [];
    for (let i = 0; i < n; i++) parts.push({ newScene: true, title: `Errand ${i + 1}`,
        outline: `Errand ${i + 1} began at the harbor with a long conversation about routes, tides and lanterns. They agreed on a plan and walked to the north pier together. The keeper checked every lamp twice before leaving.` },
        { ended: true, outline: `Later in errand ${i + 1} they returned to the office and wrote the day's report in full detail.` });
    return build(parts);
}

test('older ordinary scenes are reduced first and every scene keeps its saved record', () => {
    const mem = longStory();
    const before = JSON.stringify(mem);
    const inj = buildInjection(mem, { budget: 3000, titleCap: 600 });
    const order = mem.scenes.map(s => inj.levels[s.id]);
    const rank = { full: 5, outline: 4, short: 3, title: 2, recalled: 1, omitted: 0 };
    const ordinary = order.slice(0, -3).map(l => rank[l]);
    assert(ordinary.every((r, i) => i === 0 || r >= ordinary[i - 1]), `newer scenes are never reduced more than older ones: ${order.join(',')}`);
    assert(order.slice(-3).every(l => l === 'full' || l === 'outline'), 'recent scenes keep their priority');
    assert(order.includes('short'), 'the short outline step is used');
    assert.equal(JSON.stringify(mem), before, 'building the injection changes nothing saved');
});

test('the warning says whether the title list cap or the whole limit left scenes out', () => {
    const mem = longStory(60);
    const tight = buildInjection(mem, { budget: 100000, titleCap: 20 });
    assert.equal(tight.omittedScenes, 0, 'with a large limit every scene fits above the title list');
    // A little limit is left but no title list is allowed: the title cap is the reason.
    const capped = buildInjection(mem, { budget: 3000, titleCap: 0 });
    assert(capped.omittedScenes > 0); assert.equal(capped.omittedBy, 'titleCap');
    const full = buildInjection(mem, { budget: 1200, titleCap: 20000 });
    assert(full.omittedScenes > 0); assert.equal(full.omittedBy, 'budget');
});

test('the needed limit comes from running the real injection again', () => {
    const mem = longStory(30);
    const need = neededBudget(mem, { budget: 2000, titleCap: 600 });
    assert(need > 2000);
    const at = buildInjection(mem, { budget: need, titleCap: 600 });
    assert(Object.values(at.levels).every(l => l === 'full' || l === 'outline'));
    assert(!Object.values(buildInjection(mem, { budget: need - 600, titleCap: 600 }).levels).every(l => l === 'full' || l === 'outline'), 'not far above what is needed');
    assert.equal(neededBudget(mem, { budget: 100000 }), 100000, 'already enough');
    assert.equal(neededBudget(longStory(3), { budget: 300 }, 300), null, 'null when the largest limit is not enough');
});
