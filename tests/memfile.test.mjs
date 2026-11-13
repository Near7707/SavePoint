// v0.7.0-a: memory file writes (memfile.js). Made ready; index.js does not use them yet.
// Pass marks: 7 (rev, wid before and after), 10 (no answer = not finished), 11 ① (a late request never overwrites a
// newer memory written from the same page).
import test from 'node:test';
import assert from 'node:assert/strict';
import { memLine, seenOf, writeMem, classifyUpload, serverMemIO, MEM_OK, REFUSED, PENDING, CONFLICT, OVERWRITTEN, UNREAD, READ_ERROR } from '../memfile.js';
import { memBody, nextMem, validMem, memName, roomAddr, MISSING, OK, ERROR, BROKEN } from '../home.js';
import { emptyMem } from '../core.js';

const A = roomAddr('ari.png', 'Ari - 2026-01-01');
const ID = 'm1', NAME = memName(ID), valid = validMem(ID);
const state = n => ({ v: 1, mem: { ...emptyMem(), note: n }, lastIndex: -1, hashes: [], history: [], floor: -1 });
const first = () => memBody({ id: ID, state: state('first'), rev: 0, wid: 'w0', from: { kind: 'new', addr: A }, home: { addr: A, integrity: 'i1' } });
let n = 0;
const next = note => file => file ? nextMem(file, state(note), `w${++n}`) : memBody({ id: ID, state: state(note), rev: 0, wid: `w${++n}`, from: { kind: 'new', addr: A }, home: { addr: A, integrity: 'i1' } });

// A user files folder whose uploads can be held back and let through later (a request on its way), dropped
// (no answer, but it lands), refused, or answered without landing.
function world(files = {}) {
    const store = new Map(Object.entries(files).map(([k, v]) => [k, JSON.stringify(v)]));
    const w = { store, held: [], mode: 'ok', readMode: 'ok', reads: 0, uploads: 0, between: null };
    w.data = name => store.has(name) ? JSON.parse(store.get(name)) : null;
    w.io = {
        async read(name) {
            w.reads++;
            if (w.readMode === 'error') return { kind: ERROR };
            if (w.readMode === 'broken') return { kind: BROKEN };
            if (!store.has(name)) return { kind: MISSING };
            return { kind: OK, data: JSON.parse(store.get(name)) };
        },
        async upload(name, text) {
            w.uploads++;
            const land = () => store.set(name, text);
            if (w.mode === 'refuse') return { kind: REFUSED, status: 400 };
            if (w.mode === 'hold') { w.held.push(land); return { kind: PENDING, status: 0 }; }   // no answer; lands when let through
            if (w.mode === 'drop') { land(); return { kind: PENDING, status: 502 }; }           // landed, answer lost
            land();
            if (w.between) { const f = w.between; w.between = null; f(); }                       // another device right after
            return { kind: MEM_OK, status: 200 };
        },
    };
    return w;
}

test('a write over the file last seen: ok, and the line moves on (rev + 1, new receipt)', async () => {
    const w = world({ [NAME]: first() });
    const line = memLine(seenOf({ kind: OK, data: first() }));
    const r = await writeMem(w.io, line, { name: NAME, valid, make: next('a') });
    assert.equal(r.status, MEM_OK);
    assert.equal(w.data(NAME).rev, 1);
    assert.deepEqual(line.seen, { rev: 1, wid: r.body.wid });
    const r2 = await writeMem(w.io, line, { name: NAME, valid, make: next('b') });
    assert.equal(r2.status, MEM_OK);
    assert.equal(w.data(NAME).rev, 2);
    assert.equal(w.data(NAME).state.mem.note, 'b');
    assert.deepEqual(w.data(NAME).recent.map(x => x.rev), [0, 1, 2]);
});

test('a new file only where the server said there is none', async () => {
    const w = world();
    const line = memLine(seenOf({ kind: MISSING }));
    const r = await writeMem(w.io, line, { name: NAME, valid, make: next('new') });
    assert.equal(r.status, MEM_OK);
    assert.equal(w.data(NAME).rev, 0);
    // A line that never read the file (seen null) writes nothing, even over no file.
    const w2 = world();
    const r2 = await writeMem(w2.io, memLine(null), { name: NAME, valid, make: next('x') });
    assert.equal(r2.status, CONFLICT);
    assert.equal(w2.uploads, 0);
});

test('two devices: a file not as last seen (rev or receipt) is never written over; the line stops', async () => {
    for (const other of [{ rev: 1, wid: 'theirs' }, { rev: 0, wid: 'theirs' }]) {   // a newer one, and the same rev by another receipt
        const theirs = { ...first(), ...other, recent: [{ rev: other.rev, wid: other.wid }] };
        const w = world({ [NAME]: theirs });
        const line = memLine({ rev: 0, wid: 'w0' });
        const r = await writeMem(w.io, line, { name: NAME, valid, make: next('mine') });
        assert.equal(r.status, CONFLICT);
        assert.equal(w.uploads, 0);
        assert.equal(w.data(NAME).wid, 'theirs');
        assert.equal((await writeMem(w.io, line, { name: NAME, valid, make: next('again') })).status, CONFLICT);
        assert.equal(w.uploads, 0);
    }
    // The file deleted elsewhere since it was seen: not made again.
    const w = world();
    const r = await writeMem(w.io, memLine({ rev: 0, wid: 'w0' }), { name: NAME, valid, make: next('x') });
    assert.equal(r.status, CONFLICT);
    assert.equal(w.uploads, 0);
});

test('a file that cannot be read (error, broken) is never taken as missing and nothing is written', async () => {
    for (const mode of ['error', 'broken']) {
        const w = world();
        w.readMode = mode;
        const line = memLine({ missing: true });
        const r = await writeMem(w.io, line, { name: NAME, valid, make: next('x') });
        assert.equal(r.status, READ_ERROR);
        assert.equal(w.uploads, 0);
        assert.equal(line.stop, null, 'a failed read does not stop the line: the next write reads again');
    }
    // A file of another shape (another memory id) is broken, not missing.
    const w = world({ [NAME]: { ...first(), id: 'other' } });
    assert.equal((await writeMem(w.io, memLine({ missing: true }), { name: NAME, valid, make: next('x') })).status, READ_ERROR);
    assert.equal(w.uploads, 0);
});

test('refused before writing: nothing landed, the line goes on', async () => {
    const w = world({ [NAME]: first() });
    w.mode = 'refuse';
    const line = memLine({ rev: 0, wid: 'w0' });
    assert.equal((await writeMem(w.io, line, { name: NAME, valid, make: next('x') })).status, REFUSED);
    assert.equal(w.data(NAME).wid, 'w0');
    w.mode = 'ok';
    assert.equal((await writeMem(w.io, line, { name: NAME, valid, make: next('y') })).status, MEM_OK);
});

test('pass mark 10: no answer = not finished — the room writes no memory until it is opened again', async () => {
    for (const mode of ['hold', 'drop']) {
        const w = world({ [NAME]: first() });
        w.mode = mode;
        const line = memLine({ rev: 0, wid: 'w0' });
        const r = await writeMem(w.io, line, { name: NAME, valid, make: next('lost') });
        assert.equal(r.status, PENDING);
        assert.equal(line.pending.rev, 1);
        w.mode = 'ok';
        const uploads = w.uploads, reads = w.reads;
        assert.equal((await writeMem(w.io, line, { name: NAME, valid, make: next('later') })).status, PENDING);
        assert.equal(w.uploads, uploads, 'nothing sent');
        assert.equal(w.reads, reads, 'not even read');
    }
});

test('pass mark 11 ①: a request with no answer that lands late never overwrites a newer memory from this page', async () => {
    const w = world({ [NAME]: first() });
    const line = memLine({ rev: 0, wid: 'w0' });
    w.mode = 'hold';
    const lost = await writeMem(w.io, line, { name: NAME, valid, make: next('old') });
    assert.equal(lost.status, PENDING);
    w.mode = 'ok';
    // The next save on the same page: not sent (it would be the one overwritten).
    const newer = await writeMem(w.io, line, { name: NAME, valid, make: next('new') });
    assert.equal(newer.status, PENDING);
    w.held.shift()();                                      // the old request lands now
    assert.equal(w.data(NAME).state.mem.note, 'old');
    assert.equal(w.data(NAME).rev, 1);
    // Opened again: the line starts from the file as it is (the late write), and goes on over it.
    const reopened = memLine(seenOf(await w.io.read(NAME)));
    assert.deepEqual(reopened.seen, { rev: 1, wid: lost.body.wid });
    const r = await writeMem(w.io, reopened, { name: NAME, valid, make: next('after') });
    assert.equal(r.status, MEM_OK);
    assert.equal(w.data(NAME).rev, 2);
    // Opened again before the late request landed: the line starts from rev 0, writes rev 1; the late one (also rev 1,
    // another receipt) then lands over it. Not prevented here (pass mark 11 ②): the next write finds the file is not
    // as last seen and stops.
    const w2 = world({ [NAME]: first() });
    const l1 = memLine({ rev: 0, wid: 'w0' });
    w2.mode = 'hold';
    await writeMem(w2.io, l1, { name: NAME, valid, make: next('old') });
    w2.mode = 'ok';
    const l2 = memLine(seenOf(await w2.io.read(NAME)));
    assert.equal((await writeMem(w2.io, l2, { name: NAME, valid, make: next('new') })).status, MEM_OK);
    w2.held.shift()();
    assert.equal((await writeMem(w2.io, l2, { name: NAME, valid, make: next('next') })).status, CONFLICT);
    assert.equal(w2.data(NAME).state.mem.note, 'old', 'the conflict wrote nothing');
});

test('read back: another receipt right after ours → overwritten (stops); unreadable → taken as written', async () => {
    const w = world({ [NAME]: first() });
    w.between = () => w.store.set(NAME, JSON.stringify({ ...first(), rev: 1, wid: 'theirs', recent: [{ rev: 1, wid: 'theirs' }] }));
    const line = memLine({ rev: 0, wid: 'w0' });
    assert.equal((await writeMem(w.io, line, { name: NAME, valid, make: next('mine') })).status, OVERWRITTEN);
    assert.equal(line.stop, OVERWRITTEN);
    assert.equal((await writeMem(w.io, line, { name: NAME, valid, make: next('x') })).status, OVERWRITTEN);

    const w2 = world({ [NAME]: first() });
    const l2 = memLine({ rev: 0, wid: 'w0' });
    const realRead = w2.io.read;
    let k = 0;
    w2.io.read = async name => (k++ === 1 ? { kind: ERROR } : realRead(name));
    const r = await writeMem(w2.io, l2, { name: NAME, valid, make: next('mine') });
    assert.equal(r.status, UNREAD);
    assert.deepEqual(l2.seen, { rev: 1, wid: r.body.wid });
    assert.equal((await writeMem(w2.io, l2, { name: NAME, valid, make: next('next') })).status, MEM_OK);
});

test('one write at a time per line; a body that fails its own check is never sent', async () => {
    const w = world({ [NAME]: first() });
    const line = memLine({ rev: 0, wid: 'w0' });
    const a = writeMem(w.io, line, { name: NAME, valid, make: next('a') });
    await assert.rejects(writeMem(w.io, line, { name: NAME, valid, make: next('b') }), /one at a time/);
    assert.equal((await a).status, MEM_OK);
    await assert.rejects(writeMem(w.io, line, { name: NAME, valid, make: () => ({ broken: true }) }), /own check/);
    assert.equal(w.uploads, 1);
});

test('the upload answer: only SillyTavern\'s own success is ok; only a refusal before writing is refused', () => {
    assert.equal(classifyUpload(200, { path: 'user/files/x.json' }), MEM_OK);
    assert.equal(classifyUpload(200, null), PENDING);              // a proxy's page
    assert.equal(classifyUpload(200, { ok: true }), PENDING);
    for (const s of [400, 401, 403, 404, 413]) assert.equal(classifyUpload(s, null), REFUSED);
    for (const s of [408, 500, 502, 503, 504, 0]) assert.equal(classifyUpload(s, null), PENDING);
});

// v0.7.0-a1 (review P3): a success names the file asked for; only answers that say nothing was written are refusals.
test('the upload answer (a1): a success must name the file; a proxy\'s 499/409/429 is no answer, not a refusal', () => {
    assert.equal(classifyUpload(200, { path: 'user/files/' + NAME }, NAME), MEM_OK);
    assert.equal(classifyUpload(200, { path: 'user\\files\\' + NAME }, NAME), MEM_OK);
    assert.equal(classifyUpload(200, { path: 'user/files/other.json' }, NAME), PENDING);
    assert.equal(classifyUpload(200, { path: 'user/files/x' + NAME }, NAME), PENDING);
    assert.equal(classifyUpload(204, { path: 'user/files/' + NAME }, NAME), MEM_OK);
    for (const s of [400, 401, 403, 404, 405, 413, 415]) assert.equal(classifyUpload(s, null, NAME), REFUSED);
    for (const s of [402, 409, 410, 422, 425, 429, 451, 499]) assert.equal(classifyUpload(s, null, NAME), PENDING, String(s));
});

// The review's order: a proxy answers 499 while the first request goes on behind it; the next write of the line must
// not be sent (it would land first and be overwritten by the first one).
test('a1: a 499 answer whose request lands later never overwrites the next write of the line', async () => {
    const store = new Map([[NAME, JSON.stringify(first())]]), late = [];
    let calls = 0;
    const fetchFn = async (url, opt) => {
        if (url === '/api/files/upload') {
            calls++;
            const { name, data } = JSON.parse(opt.body);
            const text = Buffer.from(data, 'base64').toString('utf8');
            if (calls === 1) { late.push(() => store.set(name, text)); return { status: 499, json: async () => null }; }
            store.set(name, text);
            return { status: 200, json: async () => ({ path: 'user/files/' + name }) };
        }
        const name = decodeURIComponent(String(url).split('?')[0].split('/').pop());
        return store.has(name) ? { status: 200, text: async () => store.get(name) } : { status: 404, text: async () => 'Not found' };
    };
    const io = serverMemIO(fetchFn);
    const line = memLine({ rev: 0, wid: 'w0' });
    const r1 = await writeMem(io, line, { name: NAME, valid, make: next('first try') });
    assert.equal(r1.status, PENDING);
    const r2 = await writeMem(io, line, { name: NAME, valid, make: next('second') });
    assert.equal(r2.status, PENDING);
    assert.equal(calls, 1, 'the second write was not sent');
    late.shift()();
    assert.equal(JSON.parse(store.get(NAME)).state.mem.note, 'first try');
});

test('serverMemIO: a thrown or timed-out request is no answer; reads keep the four kinds', async () => {
    const io = serverMemIO(async () => { throw new TypeError('network'); });
    assert.equal((await io.upload(NAME, '{}')).kind, PENDING);
    const slow = serverMemIO((url, opt) => new Promise((_, rej) => opt.signal.addEventListener('abort', () => rej(new Error('aborted')))), () => ({}), { timeout: 20 });
    assert.equal((await slow.upload(NAME, '{}')).kind, PENDING);
    const ok = serverMemIO(async () => ({ status: 200, json: async () => ({ path: 'user/files/' + NAME }) }));
    assert.equal((await ok.upload(NAME, '{}')).kind, MEM_OK);
    const missing = serverMemIO(async () => ({ status: 404, text: async () => 'Not found' }));
    assert.equal((await missing.read(NAME, valid)).kind, MISSING);
    const gone = serverMemIO(async () => ({ status: 503, text: async () => '' }));
    assert.equal((await gone.read(NAME, valid)).kind, ERROR);
});
