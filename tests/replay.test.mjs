// v0.6.46–47: replaying a button edit after an earlier write failed (diffPaths / applyPaths in index.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const code = src.slice(src.indexOf('// v0.6.47: what an item without an id is'), src.indexOf('\nfunction persistSoon'));
const { diffPaths, applyPaths } = vm.runInNewContext(code + ';({ diffPaths, applyPaths })', { clone: x => JSON.parse(JSON.stringify(x)) });
const pt = (text, n) => ({ text, kind: 'moment', key: false, msgs: [n] });
const mem = points => ({ scenes: [{ id: 's1', segs: [{ id: 'g1', points }] }] });
const clone = x => JSON.parse(JSON.stringify(x));

test('same length, other points: a pin meant for D is never put on C', () => {
    const shown = mem([pt('B', 2), pt('C', 3), pt('D', 4)]);      // A deleted, D added by a supplement
    const pinned = clone(shown); pinned.scenes[0].segs[0].points[2].pin = true;
    const patch = diffPaths(shown, pinned);
    const restored = mem([pt('A', 1), pt('B', 2), pt('C', 3)]);   // the supplement write failed
    assert.equal(applyPaths(restored, patch), 'stop');
    assert(!restored.scenes[0].segs[0].points.some(p => p.pin));
});

test('the same point at the same place is still replayed; a gone record stops', () => {
    const a = mem([pt('A', 1), pt('B', 2)]), b = clone(a); b.scenes[0].segs[0].points[1].pin = true;
    const target = mem([pt('A', 1), pt('B', 2)]);
    assert.equal(applyPaths(target, diffPaths(a, b)), 'changed');
    assert.equal(target.scenes[0].segs[0].points[1].pin, true);
    assert.equal(applyPaths(target, diffPaths(a, b)), 'same');
    const r1 = { records: [{ id: 'r1', pin: false }] }, r2 = clone(r1); r2.records[0].pin = true;
    assert.equal(applyPaths({ records: [] }, diffPaths(r1, r2)), 'stop');
});
