import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, cleanMem, detachMem, buildInjection, applyRekey, pointInjected, pointSymbol } from '../core.js';

function archive() {
    const mem = emptyMem();
    mem.scenes = Array.from({ length: 6 }, (_, i) => ({
        id: `s${i + 1}`, title: `Chapter ${i + 1}`, where: '', who: [], status: 'closed', star: false, pin: false,
        segs: [{ id: `g${i + 1}`, from: i * 10, to: i * 10 + 9,
            outline: `The travellers finished stage ${i + 1}.`, notes: '',
            points: [{ text: `Mara kept the unique keepsake from stage ${i + 1}.`, kind: 'moment', key: false, msgs: [i * 10] }] }],
    }));
    return mem;
}

test('a pinned point survives old-scene compression with its full text, even when key is false', () => {
    const mem = archive(), p = mem.scenes[0].segs[0].points[0];
    p.pin = true;
    const result = buildInjection(mem, { recentScenes: 1, recall: false });
    assert.equal(pointInjected(p), true);
    assert.ok(result.text.includes('## Pinned points'));
    assert.equal(result.text.split(p.text).length - 1, 1);
    assert.equal(result.pinMissing, 0);
});

test('pins and manual choices survive a save/import round trip and AI re-selection', () => {
    const mem = archive(), p = mem.scenes[0].segs[0].points[0];
    p.pin = true; p.keyUser = false; p.ko = '저장된 번역';
    const restored = cleanMem(JSON.parse(JSON.stringify(mem)));
    const changed = applyRekey(restored, 's1', { 'g1.0': false });
    const next = changed.scenes[0].segs[0].points[0];
    assert.equal(next.pin, true);
    assert.equal(next.keyUser, false);
    assert.equal(next.ko, p.ko);
    assert.equal(pointInjected(next), true);
    assert.equal(detachMem(changed).scenes[0].segs[0].points[0].pin, true);
    next.pin = false;
    assert.equal(pointInjected(next), false, 'unpinning restores the previous selection');
});

test('the same pinned point is not repeated in a recent journal or keyword recall', () => {
    const mem = archive(), s = mem.scenes.at(-1), p = s.segs[0].points[0];
    p.key = true; p.pin = true;
    const result = buildInjection(mem, { query: 'Mara unique keepsake stage', ignoreNames: ['Mara'] });
    assert.equal(result.text.split(p.text).length - 1, 1);
    s.segs[0].outline = p.text;
    const overlap = buildInjection(mem, { recall: false });
    assert.equal(overlap.text.split(p.text).length - 1, 1, 'an identical outline already carries the pin');
});

test('point pins obey the overall budget and missing pins are reported', () => {
    const mem = archive();
    for (const s of mem.scenes) {
        const p = s.segs[0].points[0]; p.pin = true;
        p.text += ' A long account of the repaired mechanism and its final location.'.repeat(10);
    }
    for (const budget of [300, 600, 1000, 2000, 6000]) {
        const result = buildInjection(mem, { budget, query: 'repaired mechanism final location', titleCap: 0 });
        assert.ok(result.tokens <= budget, `${result.tokens} exceeds ${budget}`);
        assert.ok(result.used.recall <= budget * 0.15);
        const included = mem.scenes.filter(s => result.text.includes(s.segs[0].points[0].text)).length;
        assert.equal(result.pinMissing, mem.scenes.length - included);
        assert.equal(result.pinOverflow, result.pinMissing > 0);
    }
});

test('fixed points can use the total budget rather than lose to the reserved recall share', () => {
    const mem = archive(); mem.scenes = mem.scenes.slice(0, 1);
    const p = mem.scenes[0].segs[0].points[0]; p.pin = true;
    p.text = 'Mara retained the keepsake. ' + 'Its original inscription remains intact. '.repeat(22);
    const result = buildInjection(mem, { budget: 400, titleCap: 0 });
    assert.ok(result.text.includes(p.text));
    assert.equal(result.pinOverflow, false);
    assert.ok(result.tokens <= 400);
});

test('selected points share one symbol while stored-only and pinned points stay distinct', () => {
    assert.equal(pointSymbol({ key: true }), '●');
    assert.equal(pointSymbol({ key: true, keyUser: true }), '●');
    assert.equal(pointSymbol({ key: false, keyUser: true }), '●');
    assert.equal(pointSymbol({ key: true, keyUser: false }), '○');
    assert.equal(pointSymbol({ key: false, pin: true }), '📌');
});

