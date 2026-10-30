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
