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

// Re-run this after each saved chunk: memory supplied by makePrompt has changed.
// The source cap keeps ordinary manual batches small even with a generous input
// setting. A single longer message is allowed when its COMPLETE prompt fits.
export function nextMessageChunk(messages, makePrompt, limit, { sourceLimit = 12000, maxMessages = 20, reserve = 2000 } = {}) {
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

