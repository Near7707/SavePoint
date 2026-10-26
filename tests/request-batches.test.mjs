import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, promptContext, openScene } from '../core.js';
import { DEFAULT_GUIDE, buildExtractPrompt, buildCheckPrompt } from '../prompts.js';
import { nextMessageChunk, planReviewBatches, assertPromptFits, InputLimitError } from '../request-batches.js';

const messages = (n, chars = 1000) => Array.from({ length: n }, (_, index) => ({ index, name: 'Speaker', text: 'a'.repeat(chars) }));
const extractPrompt = (mem, chunk) => buildExtractPrompt({ guide: DEFAULT_GUIDE, names: {}, card: '', context: promptContext(mem, chunk.text), chunk });
const checkPrompt = input => buildCheckPrompt({ names: {}, ...input });
const statement = (id, nums) => ({ id, kind: 'journal', line: `${id}: An event happened.`, messages: nums });

test('manual collection recalculates full prompts as open-scene memory grows; no message lost or repeated', () => {
    const source = messages(100);
    const original = JSON.stringify(source);
    let mem = emptyMem(), cursor = 0;
    const seen = [], sizes = [], counts = [];
    while (cursor < source.length) {
        const chunk = nextMessageChunk(source.slice(cursor), c => extractPrompt(mem, c), 20000);
        const prompt = extractPrompt(mem, chunk);
        assert(prompt.length <= 20000);
        seen.push(...chunk.indices); sizes.push(prompt.length); counts.push(chunk.indices.length);
        // A continuing scene grows while the same manual operation is still running.
        ({ mem } = applyResult(mem, { scenes: [{ scene: openScene(mem) ? 'continue' : 'new', title: 'A walk', who: [],
            points: Array.from({ length: 10 }, () => ({ text: 'A small event happened. '.repeat(5), kind: 'moment', key: false, msgs: [chunk.from] })),
            outline: 'They continued walking and talking. '.repeat(6), notes: 'A walk.', ended: false }], entities: [], changes: [] }, chunk));
        cursor += chunk.indices.length;
        if (cursor < source.length && extractPrompt(mem, { from: source[cursor].index, to: source[cursor].index, indices: [source[cursor].index], text: `#${source[cursor].index} Speaker: ${source[cursor].text}`, texts: {} }).length > 20000) break;
    }
    // The planner must either fit the remaining full message or clearly stop;
    // an unbounded existing outline must never cause an oversized request.
    assert.deepEqual(seen, source.slice(0, cursor).map(m => m.index));
    assert.equal(JSON.stringify(source), original);
    assert(sizes.length > 2);
    assert(counts.some(n => n < counts[0]));
    if (cursor < source.length) assert.throws(() => nextMessageChunk(source.slice(cursor), c => extractPrompt(mem, c), 20000), InputLimitError);
});

test('a generous input setting still uses small complete-message chunks', () => {
    const chunk = nextMessageChunk(messages(100), c => extractPrompt(emptyMem(), c), 60000);
    assert(chunk.text.length <= 12000);
    assert(chunk.indices.length <= 20);
});

test('one long message is intact when it fits; oversized messages are explicitly stopped', () => {
    const source = messages(1, 16000);
    const chunk = nextMessageChunk(source, c => extractPrompt(emptyMem(), c), 60000);
    assert.equal(chunk.texts[0], source[0].text);
    assert.throws(() => nextMessageChunk(messages(1, 30000), c => extractPrompt(emptyMem(), c), 20000), InputLimitError);
});

test('a limit smaller than fixed instructions cannot be bypassed by a minimum source budget', () => {
    assert.throws(() => nextMessageChunk(messages(3), c => extractPrompt(emptyMem(), c), 5000), InputLimitError);
});

test('the request guard rejects an oversized retry before sending it', () => {
    assert.doesNotThrow(() => assertPromptFits('a'.repeat(20000), 20000));
    assert.throws(() => assertPromptFits('a'.repeat(20001), 20000), InputLimitError);
});

test('empty input and nonconsecutive original message numbers are preserved', () => {
    assert.equal(nextMessageChunk([], () => '', 20000), null);
    const source = [0, 5, 9].map(index => ({ index, name: 'Me', text: 'Hello' }));
    const chunk = nextMessageChunk(source, () => '', 20000);
    assert.deepEqual(chunk.indices, [0, 5, 9]);
});

test('review sends full 8000, 3000 and 1500 character messages, never the old 6000/2000/700 prefixes', () => {
    const source = [8000, 3000, 1500].map(n => ({ name: 'Me', text: 'a'.repeat(n) + ' END-OF-MESSAGE' }));
    const plan = planReviewBatches([statement('g1', [0]), statement('g2', [1]), statement('g3', [2])], n => source[n], checkPrompt, 20000);
    assert.equal(plan.deferred.length, 0);
    const sent = Object.assign({}, ...plan.batches.map(b => b.sent));
    source.forEach((m, n) => assert.equal(sent[n], m.text));
    for (const batch of plan.batches) { assert(checkPrompt(batch).length <= 20000); assert(!batch.messages.includes('[...cut]')); }
});

test('review splits independent targets into bounded calls while retaining evidence per target', () => {
    const source = messages(10, 4000).map(m => ({ name: m.name, text: m.text }));
    const targets = source.map((_, n) => statement(`g${n + 1}`, [n]));
    const plan = planReviewBatches(targets, n => source[n], checkPrompt, 15000);
    assert(plan.batches.length > 1);
    assert.equal(plan.deferred.length, 0);
    const covered = new Set();
    for (const batch of plan.batches) {
        assert(checkPrompt(batch).length <= 15000);
        for (const target of targets.filter(t => batch.ids.has(t.id))) {
            covered.add(target.id);
            for (const n of target.messages) assert.equal(batch.sent[n], source[n].text);
        }
    }
    assert.equal(covered.size, targets.length);
});

test('related targets share their complete evidence in one request when possible', () => {
    const targets = [statement('r1', [0, 1, 2]), statement('g1.0', [1, 2])];
    const source = messages(3, 1000);
    const plan = planReviewBatches(targets, n => source[n], checkPrompt, 12000);
    assert.equal(plan.batches.length, 1);
    assert.equal(plan.batches[0].ids.size, 2);
    assert.equal(Object.keys(plan.batches[0].sent).length, 3);
});

test('an oversized evidence group is deferred without cropping; other targets are still reviewed', () => {
    const source = messages(3, 8000);
    const plan = planReviewBatches([statement('r1', [0, 1, 2]), statement('g2', [1])], n => source[n], checkPrompt, 15000);
    assert.deepEqual(plan.deferred.map(s => [s.id, s.reason]), [['r1', 'size']]);
    assert.equal(plan.batches.length, 1);
    assert.equal(plan.batches[0].sent[1], source[1].text);
    assert(!plan.batches[0].ids.has('r1'));
});

test('missing evidence and targets with no evidence cannot be reported as reviewed', () => {
    const plan = planReviewBatches([statement('r1', [0, 1]), statement('r2', [])], n => n === 0 ? { name: 'Me', text: 'Hello' } : null, checkPrompt, 20000);
    assert.equal(plan.batches.length, 0);
    assert.deepEqual(plan.deferred.map(s => s.reason), ['missing', 'no-evidence']);
});

test('splitting a group never copies truncated supporting messages into a batch', () => {
    const source = messages(3, 5000);
    const targets = [statement('g1', [0, 1]), statement('g2', [1, 2])];
    const plan = planReviewBatches(targets, n => source[n], checkPrompt, 15000);
    assert.equal(plan.batches.length, 2);
    assert.equal(plan.deferred.length, 0);
    for (const batch of plan.batches) for (const [n, text] of Object.entries(batch.sent)) assert.equal(text, source[n].text);
});
