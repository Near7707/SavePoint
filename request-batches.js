// Request planning only. Original messages are atomic: never slice their text or
// mark a partly-read message as collected. Limits count the complete extension prompt.
import { chunkMessages } from './core.js';

export class InputLimitError extends Error {
    constructor(message, chars, limit) {
        super(message);
        this.name = 'InputLimitError'; this.chars = chars; this.limit = limit;
    }
}

export function assertPromptFits(prompt, limit) {
    if (prompt.length > limit) throw new InputLimitError(
        `요청 입력이 ${prompt.length.toLocaleString()}자로 설정 한도 ${limit.toLocaleString()}자를 넘어요. 원문을 자르지 않고 요청을 멈췄어요.`, prompt.length, limit);
}

// The original fill-first planner remains the safety baseline. A single longer
// message is allowed when its COMPLETE prompt fits; its text is never cropped.
function greedyMessageChunk(messages, makePrompt, limit, { sourceLimit = 12000, maxMessages = 20, reserve = 2000 } = {}) {
    if (!messages.length) return null;
    const target = Math.max(0, limit - reserve);
    let best = null;
    for (let n = 1; n <= Math.min(messages.length, maxMessages); n++) {
        const chunk = chunkMessages(messages.slice(0, n), Infinity)[0];
        if (n > 1 && chunk.text.length > sourceLimit) break;
        const chars = makePrompt(chunk).length;
        if (chars > limit) {
            if (!best) throw new InputLimitError(
                `메시지 #${chunk.from} 전체와 수집 지침·기존 기억을 보내려면 ${chars.toLocaleString()}자가 필요해요 (입력 한도 ${limit.toLocaleString()}자). 이 메시지는 자르거나 저장하지 않았어요. 입력 한도를 늘린 뒤 다시 눌러 주세요.`, chars, limit);
            break;
        }
        if (n > 1 && chars > target) break;
        best = chunk;
        if (chars > target || chunk.text.length >= sourceLimit) break;
    }
    return best;
}

// Re-run immediately before EACH request, after saving the previous result.
// Counts below are estimates using the current memory, not a promise about future
// calls: memory, relevant entities and loot in makePrompt can change after a save.
export function nextMessageChunk(messages, makePrompt, limit, options = {}) {
    const first = greedyMessageChunk(messages, makePrompt, limit, options);
    if (!first || first.indices.length === messages.length || options.balance === false) return first;

    // Memoize counts/steps rather than full source strings. Different candidate
    // prefixes often lead to the same suffix; plan each suffix at most once.
    const steps = new Map([[0, first.indices.length]]);
    const counts = new Map([[messages.length, 0]]);
    const countFrom = start => {
        const path = [];
        let offset = start;
        while (!counts.has(offset)) {
            path.push(offset);
            if (!steps.has(offset)) {
                try { steps.set(offset, greedyMessageChunk(messages.slice(offset), makePrompt, limit, options).indices.length); }
                catch (e) {
                    if (!(e instanceof InputLimitError)) throw e;
                    // A later oversized message must not prevent saving the valid
                    // prefix now. Let its own turn report the original error.
                    counts.set(offset, Infinity); break;
                }
            }
            offset += steps.get(offset);
        }
        let count = counts.get(offset);
        for (let i = path.length - 1; i >= 0; i--) counts.set(path[i], ++count);
        return counts.get(start);
    };
    const baseline = countFrom(0);
    if (!Number.isFinite(baseline)) return first;

    // Include message headers and separators, just as chunkMessages does. Balance
    // original source volume, not only message count (RP replies vary in length).
    const weights = messages.map(m => `#${m.index} ${m.name}: ${m.text}`.length + 2);
    const goal = weights.reduce((a, b) => a + b, 0) / baseline;
    let chosen = first.indices.length, best = Math.abs(first.text.length + 2 - goal), size = 0;
    for (let n = 1; n <= first.indices.length; n++) {
        size += weights[n - 1];
        const distance = Math.abs(size - goal);
        // Every candidate is a prefix already admitted by the baseline's checks.
        // Keep the fuller prefix on a tie, and never add a forecast request just
        // to make this request look more even. Otherwise retain the old chunk.
        if (distance > best || (distance === best && n <= chosen)) continue;
        if (1 + countFrom(n) > baseline) continue;
        chosen = n; best = distance;
    }
    return chosen === first.indices.length ? first : chunkMessages(messages.slice(0, chosen), Infinity)[0];
}

// Each statement carries ALL of its evidence, including intervening messages
// for promises/debts. Prefer to keep statements sharing evidence together;
// if a group is too large, each statement still travels with its full evidence.
export function planReviewBatches(statements, readMessage, makePrompt, limit, { reserve = 2000 } = {}) {
    const cache = new Map();
    const read = n => {
        if (!cache.has(n)) cache.set(n, readMessage(n));
        return cache.get(n);
    };
    const build = items => {
        const nums = [...new Set(items.flatMap(s => s.messages))].sort((a, b) => a - b);
        const sent = {}, cover = {}, missing = [];
        for (const n of nums) {
            const m = read(n);
            if (m == null) { missing.push(n); cover[n] = 'missing'; }
            else { sent[n] = m.text; cover[n] = 'whole'; }
        }
        return {
            ids: new Set(items.map(s => s.id)),
            records: items.filter(s => s.kind === 'record').map(s => s.line).join('\n'),
            journal: items.filter(s => s.kind === 'journal').map(s => s.line).join('\n'),
            terms: items.map(s => s.terms).filter(Boolean).join('\n'),
            messages: nums.filter(n => cover[n] === 'whole').map(n => `#${n} ${read(n).name}: ${sent[n]}`).join('\n\n'),
            notShown: missing, sent, cover,
        };
    };
    const pending = new Set(statements);
    const batches = [], deferred = [];
    let current = [];
    const flush = () => { if (current.length) batches.push(build(current)); current = []; };
    const fits = items => makePrompt(build(items)).length <= limit;
    while (pending.size) {
        const first = pending.values().next().value;
        const input = build([first]);
        const chars = makePrompt(input).length;
        if (input.notShown.length || chars > limit || !first.messages.length) {
            pending.delete(first);
            deferred.push({ ...first, missing: input.notShown, chars,
                reason: !first.messages.length && first.external?.length ? 'foreign' : input.notShown.length ? 'missing' : !first.messages.length ? 'no-evidence' : 'size' });
            continue;
        }
        const evidence = new Set(first.messages);
        const related = [...pending].filter(s => s === first || s.messages.some(n => evidence.has(n)));
        const group = related.length > 1 && related.every(s => s.messages.length && !build([s]).notShown.length) && fits(related) ? related : [first];
        const combined = [...current, ...group];
        if (current.length && makePrompt(build(combined)).length > Math.max(0, limit - reserve)) flush();
        current.push(...group);
        group.forEach(s => pending.delete(s));
    }
    flush();
    return { batches, deferred };
}

