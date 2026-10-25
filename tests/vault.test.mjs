import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault, INDEX, PREV_INDEX, roomHash, autoName, slotName } from '../vault.js';

// In-memory stand-in for the SillyTavern files API. `log` records every write/delete in order.
function fakeServer({ failPut = () => false, offline = false } = {}) {
    const files = new Map(), log = [];
    const io = {
        async put(name, obj) { if (offline) throw new Error('offline'); if (failPut(name)) throw new Error('write failed: ' + name); files.set(name, JSON.parse(JSON.stringify(obj))); log.push(['put', name]); },
        async get(name) { if (offline) throw new Error('offline'); return files.has(name) ? JSON.parse(JSON.stringify(files.get(name))) : null; },
        async del(name) { files.delete(name); log.push(['del', name]); },
        async exists(names) { return Object.fromEntries(names.map(n => [n, files.has(n)])); },
    };
    return { io, files, log };
}
const mem = n => ({ scenes: [{ id: 's1', title: 'S' + n, segs: [] }], entities: [], records: [], next: {} });
let clock = 1000;
const rec = (over = {}) => ({ id: 'id' + (clock), name: 'Slot', auto: false, room: 'roomA', char: 'Ari', created: clock, updated: clock++, stats: { scenes: 1 }, msgCount: 3, pos: null, mem: mem(clock), ...over });
const RH = roomHash('roomA');
const auto = (n, rh = RH) => rec({ id: 'auto_' + rh, auto: true, roomHash: rh, name: 'auto ' + n });

test('a manual slot is a file plus an index entry; the cache gets the list without memory', async () => {
    const s = fakeServer();
    let cache = null;
    const v = new Vault(s.io, { onChange: list => { cache = list; } });
    await v.init([]);
    const r = rec({ id: 'abc' });
    await v.put(r);
    assert.deepEqual(s.log.map(x => x[1]), [slotName('abc'), INDEX]);   // file first, then index
    assert.equal(s.files.get(slotName('abc')).saves[0].mem.scenes[0].title, r.mem.scenes[0].title);
    assert.equal(cache.length, 1);
    assert.equal(cache[0].mem, undefined);
    assert.equal(cache[0].file, slotName('abc'));
    assert.equal((await v.read(cache[0])).name, 'Slot');
});

test('autosaves keep 3 per room; new file -> index -> delete oldest, never overwriting a listed file', async () => {
    const s = fakeServer();
    const v = new Vault(s.io);
    await v.init([]);
    for (let i = 1; i <= 3; i++) await v.put(auto(i));
    assert.deepEqual(v.entries.map(e => e.name), ['auto 3', 'auto 2', 'auto 1']);
    const listedBefore = new Set(v.entries.map(e => e.file));
    s.log.length = 0;
    await v.put(auto(4));
    const [first, second, third, fourth] = s.log;
    assert.equal(first[0], 'put');
    assert.ok(!listedBefore.has(first[1]), 'new autosave goes to a name not currently listed');
    assert.deepEqual([second[1], third[1]], [PREV_INDEX, INDEX]);
    assert.deepEqual(fourth, ['del', autoName(RH, 0)]);   // the oldest, after the index
    assert.deepEqual(v.entries.map(e => e.name), ['auto 4', 'auto 3', 'auto 2']);
    assert.equal(new Set(v.entries.map(e => e.file)).size, 3);
    // the previous index still lists the old three
    assert.deepEqual(s.files.get(PREV_INDEX).saves.map(e => e.name), ['auto 3', 'auto 2', 'auto 1']);
});

test('a failed content write changes nothing; a failed index write deletes nothing', async () => {
    let failing = null;
    const s = fakeServer({ failPut: n => n === failing });
    const v = new Vault(s.io);
    await v.init([]);
    for (let i = 1; i <= 3; i++) await v.put(auto(i));
    const before = JSON.stringify(v.entries);
    failing = autoName(RH, 3);
    await assert.rejects(v.put(auto(9)));
    assert.equal(JSON.stringify(v.entries), before);
    failing = INDEX;
    s.log.length = 0;
    await assert.rejects(v.put(auto(10)));
    assert.equal(JSON.stringify(v.entries), before);
    assert.ok(!s.log.some(x => x[0] === 'del'), 'no file deleted when the index was not written');
    assert.ok(v.error);
});

test('only the newest rooms keep autosaves', async () => {
    const s = fakeServer();
    const v = new Vault(s.io);
    await v.init([]);
    for (const r of ['r1', 'r2', 'r3']) await v.put(auto(1, roomHash(r)), { keepRooms: 2 });
    assert.deepEqual([...new Set(v.entries.map(e => e.roomHash))], [roomHash('r3'), roomHash('r2')]);
    assert.ok(!s.files.has(autoName(roomHash('r1'), 0)));
});

test('settings loss: a fresh session reads the server index (no recovery step needed)', async () => {
    const s = fakeServer();
    const v1 = new Vault(s.io);
    await v1.init([]);
    await v1.put(rec({ id: 'keep', name: 'Route A' }));
    let cache = null;
    const v2 = new Vault(s.io, { onChange: l => { cache = l; } });
    await v2.init([]);                       // empty settings
    assert.deepEqual(cache.map(e => e.name), ['Route A']);
    assert.equal((await v2.read(cache[0])).name, 'Route A');
});

test('index lost but settings cache intact: index is rebuilt from the cache for files that exist', async () => {
    const s = fakeServer();
    const v1 = new Vault(s.io);
    await v1.init([]);
    await v1.put(rec({ id: 'a', name: 'A' }));
    await v1.put(rec({ id: 'b', name: 'B' }));
    const cache = JSON.parse(JSON.stringify(v1.entries));
    s.files.delete(INDEX); s.files.delete(PREV_INDEX); s.files.delete(slotName('b'));
    const v2 = new Vault(s.io);
    await v2.init(cache);
    assert.deepEqual(v2.entries.map(e => e.name), ['A']);
    assert.ok(s.files.has(INDEX));
});

test('index lost, previous index present: the previous one is not overwritten and find() reports it', async () => {
    const s = fakeServer();
    const v1 = new Vault(s.io);
    await v1.init([]);
    await v1.put(rec({ id: 'a', name: 'A' }));
    await v1.put(rec({ id: 'b', name: 'B' }));
    s.files.delete(INDEX);
    const prevBefore = JSON.stringify(s.files.get(PREV_INDEX));
    const v2 = new Vault(s.io);
    await v2.init([]);
    assert.equal(v2.notice, 'index-missing');
    await v2.put(rec({ id: 'c', name: 'C' }));
    assert.equal(JSON.stringify(s.files.get(PREV_INDEX)), prevBefore, 'prev kept when this session had no index');
    const found = await v2.find(null);
    assert.deepEqual(found.filter(f => f.source === 'prev').map(f => f.name).sort(), ['A']);
    assert.ok(found.find(f => f.name === 'C').listed);
    const a = found.find(f => f.name === 'A');
    assert.equal(a.exists, true);
    assert.equal(a.listed, false);
    await v2.restore(a);
    assert.deepEqual(v2.entries.map(e => e.name).sort(), ['A', 'C']);
});

test('both index files lost: this room\'s autosaves are found by name; manual slots are not', async () => {
    const s = fakeServer();
    const v1 = new Vault(s.io);
    await v1.init([]);
    await v1.put(rec({ id: 'm', name: 'Manual' }));
    for (let i = 1; i <= 3; i++) await v1.put(auto(i));
    s.files.delete(INDEX); s.files.delete(PREV_INDEX);
    const v2 = new Vault(s.io);
    await v2.init([]);
    assert.equal(v2.entries.length, 0);
    const found = await v2.find(RH);
    assert.deepEqual(found.map(f => [f.name, f.source]), [['auto 3', 'room'], ['auto 2', 'room'], ['auto 1', 'room']]);
    assert.ok(!found.some(f => f.name === 'Manual'));
    assert.equal(v2.entries.length, 0, 'finding changes nothing');
    await v2.restore(found[0]);
    assert.deepEqual(v2.entries.map(e => e.name), ['auto 3']);
    assert.equal(v2.entries[0].auto, true);
});

test('server unreachable: init reports offline and put rejects', async () => {
    const s = fakeServer({ offline: true });
    const v = new Vault(s.io);
    await v.init([]);
    assert.equal(v.online, false);
    await assert.rejects(v.put(rec()));
});

test('delete: index first, then the file', async () => {
    const s = fakeServer();
    const v = new Vault(s.io);
    await v.init([]);
    await v.put(rec({ id: 'x' }));
    s.log.length = 0;
    await v.remove('x');
    assert.deepEqual(s.log.map(x => x[1]), [PREV_INDEX, INDEX, slotName('x')]);
    assert.equal(v.entries.length, 0);
});

test('renaming an autosave keeps a manual copy and leaves the rotation alone', async () => {
    const s = fakeServer();
    const v = new Vault(s.io);
    await v.init([]);
    await v.put(auto(1));
    const a = v.entries[0];
    await v.rename(a.id, 'Before the storm', 'kept1');
    assert.deepEqual(v.entries.map(e => [e.name, !!e.auto]).sort(), [['Before the storm', false], ['auto 1', true]]);
});
