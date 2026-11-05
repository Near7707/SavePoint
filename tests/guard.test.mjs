// v0.6.58: the comparisons behind the room gate (guard.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { canon, snapshot, splitFile, covers, writeResult, samePage } from '../guard.js';

const OWN = ['savepointHidden', 'savepointVisible', 'savepointHeld', 'savepointKeep'];
const MOD = 'savePoint';
const msg = (i, extra = {}) => ({ name: 'Ari', is_user: false, mes: `Line ${i}`, swipe_id: 0, swipes: [`Line ${i}`], swipe_info: [{ extra: {} }], extra });
const snap = (meta, list) => snapshot(meta, list, OWN);
const copy = v => JSON.parse(JSON.stringify(v));

test('canonical JSON ignores key order and values JSON drops', () => {
    assert.equal(canon({ b: 1, a: [1, undefined, { d: 2, c: undefined }] }), canon({ a: [1, null, { d: 2 }], b: 1 }));
});

test('a file the page holds, or holds more of, is covered; SavePoint parts and hide state do not count', () => {
    const file = [msg(0), msg(1)], page = copy(file);
    page[0].is_system = true; page[0].extra.savepointHidden = 1; page[1].swipe_info[0].extra.savepointKeep = 1; page[1].extra.savepointKeep = 1;
    page.push(msg(2));
    assert.deepEqual(covers(snap({ [MOD]: { rev: 2 }, other: 1 }, page), snap({ [MOD]: { rev: 1 }, other: 1 }, file), MOD), { ok: true });
});

test('the file holding more, or other content, is never covered', () => {
    const base = [msg(0), msg(1), msg(2)];
    const page = snap({}, base.slice(0, 2));
    assert.equal(covers(page, snap({}, base), MOD).why, 'more');
    const cases = {
        text: f => { f[1].mes += ' (edited)'; },
        swipe: f => { f[1].swipes.push('Another reply'); },
        swipeData: f => { f[1].swipe_info[0].extra.reasoning = 'x'; },
        attachment: f => { f[0].extra.image = 'a.png'; },
    };
    for (const [name, change] of Object.entries(cases)) {
        const f = copy(base.slice(0, 2)); change(f);
        assert.equal(covers(page, snap({}, f), MOD).why, 'diff', name);
    }
    assert.equal(covers(snap({ ext: { v: 1 } }, base), snap({ ext: { v: 2 } }, base), MOD).why, 'meta');
    assert.equal(covers(snap({}, base), snap({ ext: { v: 2 } }, base), MOD).why, 'meta', 'a key only the file has');
    assert.equal(covers(snap({ ext: 1, mine: 2 }, base), snap({ ext: 1 }, base), MOD).ok, true, 'a key only the page has is fine');
});

test('an empty or broken answer is not a file', () => {
    assert.equal(splitFile([]), null); assert.equal(splitFile({}), null); assert.equal(splitFile(null), null);
    assert.deepEqual(splitFile([{ chat_metadata: {} }]), { meta: {}, messages: [] }, 'a header alone is a real, empty room');
    assert.equal(splitFile([msg(0)]).meta, null, 'a file without a header keeps its messages');
});

test('after a write: landed, unchanged (failed) or unsure', () => {
    const before = snap({ [MOD]: { rev: 1 } }, [msg(0)]);
    const pageList = [msg(0, { savepointHidden: 1 }), msg(1)];
    const written = snap({ [MOD]: { rev: 2 } }, pageList);
    assert.equal(writeResult(written, before, written, MOD), 'ok');
    assert.equal(writeResult(written, before, snap({ [MOD]: { rev: 2 } }, [...pageList, msg(2)]), MOD), 'ok', 'saved again with a newer message');
    assert.equal(writeResult(written, before, before, MOD), 'failed');
    assert.equal(writeResult(written, before, snap({ [MOD]: { rev: 1 } }, [msg(0), msg(1)]), MOD), 'unsure', 'something else changed');
    assert.equal(writeResult(written, before, snap({ [MOD]: { rev: 2 } }, [msg(0)]), MOD), 'unsure');
});

test('the same page, everything included except the memory', () => {
    const a = snap({ [MOD]: { rev: 1 }, x: 1 }, [msg(0)]);
    assert.equal(samePage(a, snap({ [MOD]: { rev: 5 }, x: 1 }, [msg(0)]), MOD), true);
    assert.equal(samePage(a, snap({ [MOD]: { rev: 1 }, x: 1 }, [msg(0, { savepointHidden: 1 })]), MOD), false);
    assert.equal(samePage(a, snap({ [MOD]: { rev: 1 }, x: 2 }, [msg(0)]), MOD), false);
});
