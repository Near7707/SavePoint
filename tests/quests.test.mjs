// v0.6.39: found quests (confirm mode), untracked quests, and who keeps a promise or debt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMem, applyResult, normalizeResult, validateResult, buildInjection, cleanMem, promptContext, recordLine, sameQuest } from '../core.js';

function story(questMode = 'auto') {
    let mem = emptyMem(), n = 0;
    const step = (changes, entities = [], { mode = questMode, expectErrors = false, say = '' } = {}) => {
        const w = `m${n}: "I will bring the lantern back tomorrow," Ari said.${say ? ' ' + say : ''}`;
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
    // v0.6.40: the same terms quoted again change nothing; really new terms make it a candidate again
    s.step([{ op: 'update', id: first.id, terms: { msg: s.n(), quote: 'I will bring the lantern back tomorrow' } }]);
    assert.equal(s.mem.records.find(r => r.id === first.id).track, 'declined', 're-quote: still untracked');
    // v0.6.41: a shorter cut of the same words is no change either
    s.step([{ op: 'update', id: first.id, terms: { msg: s.n(), quote: 'lantern back tomorrow' } }]);
    assert.equal(s.mem.records.find(r => r.id === first.id).track, 'declined', 'shorter quote: still untracked');
    s.step([{ op: 'update', id: first.id, terms: { msg: s.n(), quote: 'Ari said' } }]);
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
    // v0.6.40: two people keeping a vow is not "to each other" unless the messages say so (mutual)
    s.step([{ op: 'update', id: p.id, by: [s.ari, s.bo], to: [] }]);
    let p2 = s.mem.records.find(r => r.id === p.id);
    assert.deepEqual([p2.by, p2.to, p2.mutual], [[s.ari, s.bo], undefined, undefined]);
    assert.match(recordLine(s.mem, p2), /\{Ari, Bo\}/);
    s.step([{ op: 'update', id: p.id, mutual: true }]);
    p2 = s.mem.records.find(r => r.id === p.id);
    assert.match(recordLine(s.mem, p2), /\{Ari, Bo, to each other\}/);
    assert.equal(cleanMem(JSON.parse(JSON.stringify(s.mem))).records.find(r => r.id === p.id).mutual, true);
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

test('v0.6.40: a look-alike is hidden only when nothing tells them apart (people, roles, terms, deadline)', () => {
    const s = story('confirm');
    s.step([{ op: 'add', type: 'quest', kind: 'goal', who: [s.ari], text: 'Repair the old bridge before winter.' }]);
    const first = s.mem.records.find(r => r.type === 'quest'); first.track = 'declined';
    s.step([{ op: 'add', type: 'quest', kind: 'goal', who: [s.bo], text: 'Repair the old bridge before winter.' }]);
    assert.equal(s.mem.records.filter(r => r.type === 'quest').at(-1).track, 'pending', 'another person: shown as found');
    s.step([{ op: 'add', type: 'quest', kind: 'goal', who: [s.ari], text: 'Repair the old bridge before the winter.' }]);
    assert.equal(s.mem.records.filter(r => r.type === 'quest').at(-1).track, 'declined', 'same person, same words: stays untracked');
    s.step([lantern(s)]);
    const l = s.mem.records.filter(r => r.type === 'quest').at(-1); l.track = 'declined';
    s.step([lantern(s, { due: { expr: 'tomorrow', days: 1, msg: s.n() } })]);
    assert.equal(s.mem.records.filter(r => r.type === 'quest').at(-1).track, 'pending', 'a deadline the old one did not have: shown');
});

test('v0.6.40: retire puts a scene prop away as 정리됨; mentions and adds do not bring it back, back: true does', () => {
    const s = story('auto');
    s.step([{ op: 'add', type: 'item', entity: 'tea', holder: null, text: 'A tea set with a half-full teapot.' }], [{ ref: 'tea', type: 'item', name: 'Tea set', aliases: [] }]);
    const tea = s.mem.records.find(r => r.type === 'item');
    s.step([{ op: 'update', id: tea.id, text: 'Tea time is over; half a teapot is left on the table.', retire: true }]);
    let t = s.mem.records.find(r => r.id === tea.id);
    assert.deepEqual([t.stored?.by, t.stored?.reason, t.gone], ['story', 'retired', undefined]);
    assert.doesNotMatch(buildInjection(s.mem, { budget: 6000 }).text, /teapot/);
    assert.match(promptContext(s.mem, 'x').state, /STORED ITEMS[\s\S]*retired prop/);
    s.step([{ op: 'update', id: tea.id, text: 'Ari sips from the leftover teapot.' }]);
    s.step([{ op: 'add', type: 'item', entity: t.entity, holder: null, text: 'The teapot is still on the table.' }]);
    t = s.mem.records.find(r => r.id === tea.id);
    assert.equal(t.stored?.reason, 'retired', 'mentioned or used a little: stays put away');
    assert.equal(s.mem.records.filter(r => r.type === 'item').length, 1, 'no second record');
    s.step([{ op: 'update', id: tea.id, text: 'Ari pours the rest into a flask to take on the trip.', back: true }]);
    assert.equal(s.mem.records.find(r => r.id === tea.id).stored, undefined, 'a new reason to follow it: back');
    // pinned or hand-added items are never retired by the story; retire on a non-item is dropped
    const r = s.mem.records.find(x => x.id === tea.id); r.pin = true;
    s.step([{ op: 'update', id: tea.id, text: 'The flask is packed.', retire: true }]);
    assert.equal(s.mem.records.find(x => x.id === tea.id).stored, undefined);
    s.step([{ op: 'add', type: 'quest', kind: 'goal', who: [s.ari], text: 'Reach the coast.' }]);
    const q = s.mem.records.find(x => x.type === 'quest');
    s.step([{ op: 'update', id: q.id, text: 'Reach the coast soon.', retire: true }]);
    assert.equal(s.mem.records.find(x => x.id === q.id).stored, undefined);
    assert.equal(cleanMem(JSON.parse(JSON.stringify(s.mem))).records.find(x => x.id === tea.id).pin, true);
});

test('v0.6.41: the same calendar date said again later is no change; a new date is', () => {
    const s = story('auto');
    const say = (extra) => s.step([lantern(s, extra)]);
    const at = n => ({ msg: n });
    s.step([{ op: 'add', type: 'quest', kind: 'promise', who: [s.ari], text: 'Ari will return the lantern.',
        terms: { msg: s.n(), quote: 'I will bring the lantern back tomorrow' }, due: { expr: 'tomorrow', date: '', days: 1, msg: s.n() } }]);
    const q = s.mem.records.find(r => r.type === 'quest'); q.track = 'declined';
    // no story time: "tomorrow" said again cannot be placed, so it reads as the same words
    s.step([{ op: 'update', id: q.id, due: { expr: 'tomorrow', days: 1, msg: s.n() } }]);
    assert.equal(s.mem.records.find(r => r.id === q.id).track, 'declined');
    s.step([{ op: 'update', id: q.id, mutual: true, by: [s.ari, s.bo], to: [] }]);
    assert.equal(s.mem.records.find(r => r.id === q.id).mutual, true);
    s.step([{ op: 'update', id: q.id, mutual: false }]);
    assert.equal(s.mem.records.find(r => r.id === q.id).mutual, undefined, 'mutual: false clears it (alone is a change)');
});

test('v0.6.41: a fixed date repeated in a later part stays untracked; a different date makes it a candidate', () => {
    const s = story('auto');
    const say = 'Return it by 2026-11-08.';
    s.step([lantern(s, { due: { expr: 'by 2026-11-08', date: '2026-11-08', days: null, msg: s.n() } })], [], { say });
    const q = s.mem.records.find(r => r.type === 'quest'); q.track = 'declined';
    s.step([{ op: 'update', id: q.id, due: { expr: 'by 2026-11-08', date: '2026-11-08', days: null, msg: s.n() } }], [], { say });
    assert.equal(s.mem.records.find(r => r.id === q.id).track, 'declined', 'same date, later part');
    assert.equal(s.mem.records.find(r => r.id === q.id).due?.date, '2026-11-08', 'the date was applied');
    s.step([{ op: 'update', id: q.id, due: { expr: 'by 2026-11-09', date: '2026-11-09', days: null, msg: s.n() } }], [], { say: 'Return it by 2026-11-09.' });
    assert.equal(s.mem.records.find(r => r.id === q.id).track, 'pending', 'moved deadline');
});
