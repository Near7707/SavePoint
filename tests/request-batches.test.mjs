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

const collectChunks = (source, makePrompt = c => c.text, limit = 60000, options = {}) => {
    const chunks = [];
    for (let offset = 0; offset < source.length;) {
        const chunk = nextMessageChunk(source.slice(offset), makePrompt, limit, options);
        chunks.push(chunk); offset += chunk.indices.length;
    }
    return chunks;
};

test('short 30/25 message saves are balanced instead of leaving a small tail', () => {
    for (const [n, expected] of [[30, [15, 15]], [25, [13, 12]], [40, [20, 20]], [60, [20, 20, 20]]]) {
        const source = messages(n, 100), snapshot = JSON.stringify(source);
        const chunks = collectChunks(source);
        assert.deepEqual(chunks.map(c => c.indices.length), expected);
        assert.deepEqual(chunks.flatMap(c => c.indices), source.map(m => m.index));
        assert.equal(JSON.stringify(source), snapshot);
    }
});

test('source volume, rather than equal message counts, balances uneven RP replies', () => {
    const source = [4000, 4000, ...Array(8).fill(1000)].map((chars, index) => ({ index, name: 'Speaker', text: 'x'.repeat(chars) }));
    const greedy = collectChunks(source, c => c.text, 60000, { balance: false });
    const balanced = collectChunks(source);
    assert.deepEqual(balanced.map(c => c.indices.length), [2, 8]);
    assert.equal(balanced.length, greedy.length);
    const spread = chunks => Math.max(...chunks.map(c => c.text.length)) - Math.min(...chunks.map(c => c.text.length));
    assert(spread(balanced) < spread(greedy));
    assert(balanced.every(c => c.text.length <= 12000));
});

test('a more even split cannot add a forecast request: retain the fill-first prefix', () => {
    const source = [2000, 2000, 2000, 1, 1, 1, 1, 1].map((chars, index) => ({ index, name: 'S', text: 'x'.repeat(chars) }));
    const options = { maxMessages: 4 };
    const first = nextMessageChunk(source, c => c.text, 60000, options);
    assert.equal(first.indices.length, 4, 'three or fewer would leave over four messages and require a third call');
    assert.equal(collectChunks(source, c => c.text, 60000, options).length, 2);
});

test('a long single message stays whole; a later oversized message cannot block the good prefix', () => {
    const source = [16000, 100, 100].map((chars, index) => ({ index, name: 'S', text: 'x'.repeat(chars) }));
    const first = nextMessageChunk(source, c => c.text, 60000);
    assert.deepEqual(first.indices, [0]); assert.equal(first.texts[0], source[0].text);
    const laterBad = [100, 100, 30000].map((chars, index) => ({ index, name: 'S', text: 'x'.repeat(chars) }));
    assert.deepEqual(nextMessageChunk(laterBad, c => c.text, 20000).indices, [0, 1]);
    assert.throws(() => nextMessageChunk(laterBad.slice(2), c => c.text, 20000), InputLimitError);
});

test('planning is recalculated against increased fixed context before the next request', () => {
    const source = messages(40, 200);
    let overhead = 500;
    const prompt = c => 'X'.repeat(overhead) + c.text;
    const first = nextMessageChunk(source, prompt, 8000);
    const tail = source.slice(first.indices.length);
    const before = nextMessageChunk(tail, prompt, 8000);
    overhead = 4500;
    const after = nextMessageChunk(tail, prompt, 8000);
    assert(after.indices.length < before.indices.length);
    assert(prompt(after).length <= 6000, 'preserve the existing 2000-character retry margin');
    assert.deepEqual(after.indices, tail.slice(0, after.indices.length).map(m => m.index));
});

test('seeded mixed-length inputs preserve limits, coverage and the static forecast request count', () => {
    let seed = 7707;
    const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let trial = 0; trial < 180; trial++) {
        const source = Array.from({ length: 1 + rand(80) }, (_, i) => ({ index: i * 3, name: 'S', text: 'x'.repeat(1 + rand(4000)) }));
        const limit = 7000 + rand(15000), reserve = rand(1500), overhead = rand(1200);
        const prompt = c => 'X'.repeat(overhead) + c.text;
        const greedy = collectChunks(source, prompt, limit, { reserve, balance: false });
        const balanced = collectChunks(source, prompt, limit, { reserve });
        assert(balanced.length <= greedy.length, `trial ${trial}`);
        assert.deepEqual(balanced.flatMap(c => c.indices), source.map(m => m.index));
        for (const c of balanced) {
            assert(c.indices.length <= 20 && c.text.length <= 12000);
            assert(prompt(c).length <= limit);
            if (c.indices.length > 1) assert(prompt(c).length <= limit - reserve);
            for (const n of c.indices) assert.equal(c.texts[n], source.find(m => m.index === n).text);
        }
    }
});

test('lookahead does not repeatedly build the same suffix or send model calls', () => {
    const source = messages(2000, 30); let builds = 0;
    const chunk = nextMessageChunk(source, c => { builds++; return c.text; }, 60000);
    assert.equal(chunk.indices.length, 20);
    assert(builds <= source.length * 20, `${builds} prompt builds`);
});
