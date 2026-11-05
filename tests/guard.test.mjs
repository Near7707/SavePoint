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

// v0.6.59
test('a message the file had when last read and lacks now was deleted elsewhere (gone); a new one is fine', () => {
    const list = Array.from({ length: 20 }, (_, i) => msg(i));
    const seen = snap({}, list), page = snap({}, list), file = snap({}, list.slice(0, 19));
    assert.deepEqual(covers(page, file, MOD, seen), { ok: false, why: 'gone', at: 19 });
    assert.equal(covers(page, file, MOD).ok, true, 'without the last read it looks like a new message');
    const local = [...list.slice(0, 19), msg(99)];
    assert.equal(covers(snap({}, local), file, MOD, seen).ok, true, 'a message made here at that place is new');
    assert.equal(covers(snap({}, [...list, msg(20)]), snap({}, list), MOD, seen).ok, true, 'a message after the last read is new');
    const shorter = snap({}, list.slice(0, 18));
    assert.equal(covers(shorter, shorter, MOD, seen).ok, true, 'deleted here and saved: the page has nothing extra');
});

test('older attachment fields and the shape SillyTavern shows are the same attachment', () => {
    const file = [msg(0, { image: 'user/images/a.png', title: 'A' }), msg(1, { file: { url: 'user/files/b.txt', size: 3, name: 'b.txt' } })];
    const page = copy(file);
    page[0].extra = { media: [{ type: 'image', url: 'user/images/a.png' }], title: 'A' };
    page[1].extra = { files: [{ url: 'user/files/b.txt', size: 3, name: 'b.txt' }] };
    assert.equal(covers(snap({}, page), snap({}, file), MOD).ok, true);
    const swipes = [msg(0, { image_swipes: ['x.png', 'y.png'], image: 'y.png' })], shown = copy(swipes);
    shown[0].extra = { media: [{ type: 'image', url: 'x.png' }, { type: 'image', url: 'y.png' }], media_display: 'gallery', media_index: 1 };
    assert.equal(covers(snap({}, shown), snap({}, swipes), MOD).ok, true, 'image swipes become a gallery');
    const other = copy(page); other[0].extra.media[0].url = 'user/images/z.png';
    assert.equal(covers(snap({}, other), snap({}, file), MOD).why, 'diff', 'another picture is still different');
});

test("author's note keys saved as null are filled with defaults on the page", () => {
    const list = [msg(0)];
    const file = snap({ note_prompt: null, note_interval: null, note_depth: null, note_position: null, note_role: null }, list);
    assert.equal(covers(snap({ note_prompt: '', note_interval: 1, note_depth: 4, note_position: 1, note_role: 0 }, list), file, MOD).ok, true);
    assert.equal(covers(snap({ note_prompt: 'kept here' }, list), snap({ note_prompt: 'written elsewhere' }, list), MOD).why, 'meta');
    assert.equal(covers(snap({ other_ext: 1 }, list), snap({ other_ext: null }, list), MOD).why, 'meta', 'only those keys');
});

test('a write is never confirmed from a file without the memory (older group chats)', () => {
    const before = snap(null, [msg(0)]), written = snap({ [MOD]: { rev: 2 } }, [msg(0)]);
    assert.equal(writeResult(written, before, before, MOD), 'failed', 'the file did not change at all');
    assert.equal(writeResult(written, before, snap(null, [msg(0), msg(1)]), MOD), 'unsure');
    assert.equal(writeResult(written, before, written, MOD), 'ok', 'once the header with the memory is there');
});
