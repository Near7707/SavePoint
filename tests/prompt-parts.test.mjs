import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractPrompt, buildExtractPromptParts, DEFAULT_GUIDE } from '../prompts.js';

const args = note => ({ guide: DEFAULT_GUIDE, names: { char: 'A', user: 'B' }, card: 'Character: A\ndescription: a courier.',
    context: { entities: 'e1 person: A', state: 'r1 [condition] A: tired', time: '2026-10-25', open: 's1 "Errand"\nOutline so far: x', recent: 's0 "Before": y' },
    chunk: { from: 3, to: 5, indices: [3, 4, 5], text: '#3 A: hi\n\n#4 B: hello\n\n#5 A: bye', texts: {} }, note });

test('request sections add up exactly to the request, with and without a batch note', () => {
    for (const note of ['', '[USER-SELECTED EXCERPTS]\n[]']) {
        const { text, parts } = buildExtractPromptParts(args(note));
        assert.equal(text, buildExtractPrompt(args(note)), 'the text itself is unchanged');
        assert.equal(Object.values(parts).reduce((a, b) => a + b, 0), text.length);
        assert(parts.guide > parts.messages && parts.messages > 0 && parts.card > 0 && parts.state > 0 && parts.open > 0 && parts.recent > 0);
        assert.equal(!!parts.note, !!note);
    }
});

// v0.6.57: the record check judges meaning, not wording, but still catches changes that steer the story.
import { buildCheckPrompt as checkRule } from '../prompts.js';
test('record check: same core meaning passes; settledness, intent, relation, ownership and result changes are reported', () => {
    const p = checkRule({ names: {}, records: 'r1: Bo suspects Ari already thought about opening the box.', journal: '', messages: '#1 Bo: "You wrote that down, which means you already thought about it."' });
    assert.match(p, /Judge meaning, not wording/);
    assert.match(p, /Never report a statement only because its exact words do not appear/);
    for (const k of ['suspects vs knows', 'offered vs accepted', 'intent', 'a relationship', 'holding something for now vs owning it', 'a result']) assert.ok(p.includes(k), k);
});

test('v0.6.97: a new story day ends the scene even in the same place; the previous default guide is still recognised', async () => {
    const p = await import('../prompts.js');
    assert.match(p.DEFAULT_GUIDE, /A new story day always ends the scene, even in the same place/);
    assert.match(p.SCENE_END_RULE, /A new story day always ends the scene, even in the same place/);
    assert.ok(p.OLD_GUIDE_HASHES.includes('7lvgk81d3nkee4fh'), 'the v0.6.96 default guide is replaced, not kept as an edited copy');
    assert.ok(!p.OLD_GUIDE_HASHES.includes(p.guideHash(p.DEFAULT_GUIDE)));
});

test('v0.6.100: morning after the night is a new story day for scenes even without the words "next day"', async () => {
    const p = await import('../prompts.js');
    for (const text of [p.DEFAULT_GUIDE, p.SCENE_END_RULE]) assert.match(text, /The words "next day" need not appear: when the night passes and morning comes/);
    assert.match(p.OUTPUT_FORMAT, /only about day counts in time stamps; scenes still end when the night passes into morning/);
    assert.ok(p.OLD_GUIDE_HASHES.includes('9xq4qk1r2f34q4m8'), 'the v0.6.97 default guide is replaced, not kept as an edited copy');
    assert.ok(!p.OLD_GUIDE_HASHES.includes(p.guideHash(p.DEFAULT_GUIDE)));
});
