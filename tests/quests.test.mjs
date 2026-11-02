// v0.6.39: found quests (confirm mode), untracked quests, and who keeps a promise or debt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, normalizeResult, validateResult, buildInjection, cleanMem, promptContext, recordLine, sameQuest } from '../core.js';

function story(questMode = 'auto') {
    let mem = emptyMem(), n = 0;
    const step = (changes, entities = [], { mode = questMode, expectErrors = false } = {}) => {
        const w = `m${n}: "I will bring the lantern back tomorrow," Ari said.`;
        const chunk = { from: n, to: n, indices: [n], text: `#${n} ${w}`, texts: { [n]: w } };
        const d = { scenes: [{ scene: 'new', title: `Scene ${n}`, where: 'Harbor', who: [], ended: true, outline: `Outline ${n}.`, notes: '',
            points: [{ text: 'They talked.', kind: 'moment', key: false, msgs: [n] }] }], entities, changes: changes.map(c => ({ msgs: [n], ...c })) };
        normalizeResult(d, { mem, chunk });
        const errors = validateResult(d, { mem, chunk });
        if (expectErrors) return errors;
        assert.deepEqual(errors, []);
        mem = applyResult(mem, d, chunk, { room: 'r', questMode: mode }).mem; n++;
        return mem;
    };
    step([], [{ ref: 'a', type: 'person', name: 'Ari', aliases: [] }, { ref: 'b', type: 'person', name: 'Bo', aliases: [] }]);
    const ari = mem.entities.find(e => e.name === 'Ari').id, bo = mem.entities.find(e => e.name === 'Bo').id;
    return { step, get mem() { return mem; }, set mem(m) { mem = m; }, ari, bo, n: () => n };
}
const lantern = (s, extra = {}) => ({ op: 'add', type: 'quest', kind: 'promise', who: [s.ari], text: 'Ari will bring the borrowed lantern back tomorrow.',
    terms: { msg: s.n(), quote: 'I will bring the lantern back tomorrow' }, ...extra });

test('confirm mode: a new quest waits as found; story status still updates; auto mode lists it at once', () => {
    const s = story('confirm');
    s.step([lantern(s)]);
    const q = s.mem.records.find(r => r.type === 'quest');
    assert.equal(q.track, 'pending');
    s.step([{ op: 'update', id: q.id, status: 'done' }]);
    const q2 = s.mem.records.find(r => r.id === q.id);
    assert.equal(q2.status, 'done'); assert.equal(q2.track, 'pending', 'finished in the story while waiting: still waiting for the user');
    const a = story('auto'); a.step([lantern(a)]);
    assert.equal(a.mem.records.find(r => r.type === 'quest').track, undefined);
});

test('found quests are injected and sent to the collector; untracked ones are not injected and only nearby open ones are sent', () => {
    const s = story('confirm');
    s.step([lantern(s)]);
    let q = s.mem.records.find(r => r.type === 'quest');
    assert.match(buildInjection(s.mem, { budget: 6000 }).text, /lantern/);
    assert.match(promptContext(s.mem, 'Ari').state, new RegExp(q.id));
    q.track = 'declined';
    assert.doesNotMatch(buildInjection(s.mem, { budget: 6000 }).text, /lantern/);
    const near = promptContext(s.mem, 'Ari waved.').state, far = promptContext(s.mem, 'Nobody here.').state;
    assert.match(near, /UNTRACKED THREADS[\s\S]*lantern/);
    assert.doesNotMatch(far, /lantern/, 'not about anyone in play: not sent');
    q.pin = true;
    assert.match(buildInjection(s.mem, { budget: 6000 }).text, /lantern/, 'a pinned one still goes in');
});

test('the same thread in other words stays untracked; new terms make it a candidate again', () => {
    const s = story('auto');
    s.step([lantern(s)]);
    const first = s.mem.records.find(r => r.type === 'quest');
    first.track = 'declined';
    s.step([lantern(s, { text: 'Ari promised to bring back the lantern she borrowed by tomorrow.' })]);
    const twin = s.mem.records.filter(r => r.type === 'quest').at(-1);
    assert.equal(twin.track, 'declined'); assert.equal(twin.autoDeclined, first.id);
    s.step([lantern(s, { text: 'Ari will buy Bo a loaf of bread.', terms: { msg: s.n(), quote: 'I will bring the lantern back tomorrow' } })]);
    assert.equal(s.mem.records.filter(r => r.type === 'quest').at(-1).track, undefined, 'a different promise is a new quest');
    s.step([{ op: 'update', id: first.id, terms: { msg: s.n(), quote: 'I will bring the lantern back tomorrow' } }]);
    assert.equal(s.mem.records.find(r => r.id === first.id).track, 'pending');
    assert.equal(sameQuest({ kind: 'goal', text: 'Find the lantern.' }, { kind: 'promise', text: 'Find the lantern.' }), false, 'kinds differ');
});

test('by/to: kept for promises and debts, dropped elsewhere, shown to the collector, survive a save file', () => {
    const s = story('auto');
    s.step([lantern(s, { by: [s.ari], to: [s.bo] }),
        { op: 'add', type: 'quest', kind: 'goal', who: [s.ari], text: 'Ari wants to see the lighthouse.', by: [s.ari], to: [s.bo] }]);
    const [p, g] = s.mem.records.filter(r => r.type === 'quest');
    assert.deepEqual([p.by, p.to], [[s.ari], [s.bo]]);
    assert.equal(g.by, undefined, 'a goal has no by/to (dropped, not an error)');
    assert.match(recordLine(s.mem, p), /\{Ari -> Bo\}/);
    s.step([{ op: 'update', id: p.id, by: [s.ari, s.bo], to: [] }]);
    const p2 = s.mem.records.find(r => r.id === p.id);
    assert.deepEqual([p2.by, p2.to], [[s.ari, s.bo], undefined]);
    assert.match(recordLine(s.mem, p2), /\{Ari, Bo, to each other\}/);
    const back = cleanMem(JSON.parse(JSON.stringify(s.mem))).records.find(r => r.id === p.id);
    assert.deepEqual(back.by, [s.ari, s.bo]);
    const errors = s.step([lantern(s, { by: ['nobody'] })], [], { expectErrors: true });
    assert(errors.some(e => /\.by\[0\]/.test(e)), errors.join('\n'));
});

test('track survives a save file; unknown values are dropped', () => {
    const s = story('confirm');
    s.step([lantern(s)]);
    const raw = JSON.parse(JSON.stringify(s.mem));
    assert.equal(cleanMem(raw).records.find(r => r.type === 'quest').track, 'pending');
    raw.records.find(r => r.type === 'quest').track = 'weird';
    assert.equal(cleanMem(raw).records.find(r => r.type === 'quest').track, undefined);
});
