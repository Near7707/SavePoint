// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    emptyMem, applyResult, validateResult, resultLanguageIssues, pushHistory, rollbackFrom, buildInjection,
    chunkMessages, cleanMem, detachMem, openScene, promptContext, recallScenes, estTokens, closeOpenScene,
} from '../core.js';

const chunkOf = (from, to) => ({ from, to, indices: Array.from({ length: to - from + 1 }, (_, i) => from + i), text: '' });

// A small story: Mara picks up Theo's broken lantern, repairs it and returns it.
function lanternResult() {
    return {
        checklist: { items: 'lantern repaired and returned' },
        scenes: [{
            scene: 'new', title: 'Lantern at the gate', where: 'East gate', who: ['m', 't', 'l'],
            points: [
                { text: 'Mara picked up the broken lantern, refitted its handle and returned it to Theo, working again.', kind: 'change', key: true, msgs: [2, 4] },
                { text: 'They laughed about Theo tripping over the gate chain.', kind: 'moment', key: false, msgs: [3] },
            ],
            notes: 'Theo dropped the lantern; Mara used wire from her bag to refit the handle.',
            outline: 'At the east gate Mara repaired Theo\'s broken lantern and gave it back. They shared a laugh.',
            ended: false, star: false,
        }],
        entities: [
            { ref: 'm', type: 'person', name: 'Mara', aliases: ['마라'] },
            { ref: 't', type: 'person', name: 'Theo', aliases: ['테오'] },
            { ref: 'l', type: 'item', name: 'brass lantern', aliases: ['랜턴', '등불'] },
        ],
        changes: [
            { op: 'add', type: 'item', entity: 'l', holder: 't', text: 'Handle refitted by Mara; works again.', msgs: [4] },
            { op: 'add', type: 'party', entity: 't', aspect: 'relation', text: 'Grateful to Mara after she fixed his lantern.', msgs: [4] },
            { op: 'add', type: 'quest', kind: 'promise', who: ['t'], text: 'Theo promised to buy Mara tea tomorrow.', terms: { msg: 5, quote: 'I will buy you tea tomorrow' }, msgs: [5] },
        ],
    };
}

test('one result updates the journal and the state together, with evidence', () => {
    const mem = emptyMem();
    const data = lanternResult();
    assert.deepEqual(validateResult(data, { mem, chunk: chunkOf(0, 5) }), []);
    const { mem: next } = applyResult(mem, data, chunkOf(0, 5));
    assert.equal(next.scenes.length, 1);
    const s = next.scenes[0];
    assert.equal(s.status, 'open');
    assert.match(s.segs[0].points[0].text, /returned it to Theo/);
    const item = next.records.find(r => r.type === 'item');
    const theo = next.entities.find(e => e.name === 'Theo');
    assert.equal(item.holder, theo.id);
    assert.deepEqual(item.msgs, [4]);
    assert.equal(item.src[0], s.segs[0].id);
    assert.equal(next.records.filter(r => r.type === 'quest' && r.status === 'open').length, 1);
});

test('a shared moment without any state change is kept', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const moments = mem.scenes[0].segs[0].points.filter(p => p.kind === 'moment');
    assert.equal(moments.length, 1);
    assert.match(moments[0].text, /laughed/);
});

test('an open scene continues across batches under the same id and closes on request', () => {
    let { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const id = mem.scenes[0].id;
    const cont = {
        scenes: [{ scene: 'continue', keys: { 'g1.0': true, 'g1.1': false }, title: 'Lantern at the gate', where: 'East gate', who: ['e1'],
            points: [{ text: 'Mara walked Theo home with the repaired lantern lit.', kind: 'moment', key: false, msgs: [7, 'g1'] }],
            notes: 'Short walk.', outline: 'Mara repaired Theo\'s lantern at the east gate and then walked him home.', ended: false }],
        changes: [{ op: 'update', id: 'r3', status: 'done', msgs: [8] }],
    };
    assert.deepEqual(validateResult(cont, { mem, chunk: chunkOf(6, 9) }), []);
    ({ mem } = applyResult(mem, cont, chunkOf(6, 9), { close: true }));
    assert.equal(mem.scenes.length, 1);
    assert.equal(mem.scenes[0].id, id);
    assert.equal(mem.scenes[0].segs.length, 2);
    assert.equal(mem.scenes[0].status, 'closed');
    assert.equal(mem.records.find(r => r.id === 'r3').status, 'done');
    // the first segment's points are untouched by the new outline
    assert.match(mem.scenes[0].segs[0].points[0].text, /refitted its handle/);
});

test('a new scene closes the open one; several scenes split the batch by start', () => {
    let { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const data = {
        scenes: [
            { scene: 'continue', keys: { 'g1.0': true, 'g1.1': false }, title: 'Lantern at the gate', outline: 'Gate scene ends.', points: [], ended: true },
            { scene: 'new', start: 9, title: 'Market', where: 'Market', outline: 'They shop.', points: [{ text: 'Bought tea.', kind: 'change', key: true, msgs: [10] }], ended: false },
        ],
    };
    assert.deepEqual(validateResult(data, { mem, chunk: chunkOf(6, 12) }), []);
    ({ mem } = applyResult(mem, data, chunkOf(6, 12)));
    assert.equal(mem.scenes.length, 2);
    assert.equal(mem.scenes[0].status, 'closed');
    assert.deepEqual([mem.scenes[0].segs[1].from, mem.scenes[0].segs[1].to], [6, 8]);
    assert.deepEqual([mem.scenes[1].segs[0].from, mem.scenes[1].segs[0].to], [9, 12]);
    assert.equal(openScene(mem).title, 'Market');
});

test('evidence outside the batch is rejected, not widened', () => {
    const bad = lanternResult();
    bad.scenes[0].points[0].msgs = [99];
    bad.changes[0].msgs = [];
    const errors = validateResult(bad, { mem: emptyMem(), chunk: chunkOf(0, 5) });
    assert.ok(errors.some(e => e.includes('#99')));
    assert.ok(errors.some(e => e.includes('at least one')));
});

test('segment references are allowed only for the open scene', () => {
    const data = lanternResult();
    data.scenes[0].points[1].msgs = ['g7'];
    assert.ok(validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 5) }).some(e => e.includes('g7')));
});

test('unknown record ids and undeclared entities are rejected', () => {
    const data = lanternResult();
    data.changes.push({ op: 'update', id: 'r40', text: 'x', msgs: [1] });
    data.changes.push({ op: 'add', type: 'item', entity: 'ghost', text: 'x', msgs: [1] });
    const errors = validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 5) });
    assert.ok(errors.some(e => e.includes('r40')));
    assert.ok(errors.some(e => e.includes('ghost')));
});

test('only the first scene may continue, and only if a scene is open', () => {
    const data = lanternResult();
    data.scenes[0].scene = 'continue';
    assert.ok(validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 5) }).some(e => e.includes('continue')));
});

test('language check flags Korean text but not names or aliases', () => {
    const data = lanternResult();
    assert.deepEqual(resultLanguageIssues(data), []);
    data.scenes[0].outline = '마라가 테오의 랜턴을 고쳐서 돌려줬다.';
    data.changes[0].text = 'Handle fixed, the nickname "꼬맹이" stuck.';
    const issues = resultLanguageIssues(data);
    assert.deepEqual(issues, ['scenes[0].outline']);
});

// ───── review 2026-10-25 #1: shared aliases must not merge different things ─────
test('two compasses sharing an alias stay separate, with separate holders', () => {
    const data = {
        scenes: [{ scene: 'new', title: 'Two compasses', who: ['blue', 'red', 'm', 't'], outline: 'Mara got the brass compass, Theo the silver one.',
            points: [{ text: 'Mara took the brass compass; Theo took the silver one.', kind: 'change', key: true, msgs: [1, 2] }], ended: true }],
        entities: [
            { ref: 'blue', type: 'item', name: 'brass compass', aliases: ['나침반'] },
            { ref: 'red', type: 'item', name: 'silver compass', aliases: ['나침반'] },
            { ref: 'm', type: 'person', name: 'Mara' }, { ref: 't', type: 'person', name: 'Theo' },
        ],
        changes: [
            { op: 'add', type: 'item', entity: 'blue', holder: 'm', text: 'Worn by Mara.', msgs: [1] },
            { op: 'add', type: 'item', entity: 'red', holder: 't', text: 'Worn by Theo.', msgs: [2] },
        ],
    };
    assert.deepEqual(validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 3) }), []);
    const { mem } = applyResult(emptyMem(), data, chunkOf(0, 3));
    const items = mem.entities.filter(e => e.type === 'item');
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(e => e.aliases), [['나침반'], ['나침반']]);
    const holder = name => mem.entities.find(e => e.id === mem.records.find(r => r.entity === items.find(i => i.name === name).id).holder).name;
    assert.equal(holder('brass compass'), 'Mara');
    assert.equal(holder('silver compass'), 'Theo');
    assert.equal(mem.scenes[0].who.length, 4);
});

test('an alias shared by a person and an item does not merge them', () => {
    const data = { scenes: [{ scene: 'new', title: 'Star', outline: 'x.', points: [{ text: 'p', kind: 'moment', key: false, msgs: [0] }], ended: true }],
        entities: [{ ref: 'p', type: 'person', name: 'Star', aliases: ['별'] }, { ref: 'i', type: 'item', name: 'star charm', aliases: ['별'] }] };
    assert.deepEqual(validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 1) }), []);
    assert.equal(applyResult(emptyMem(), data, chunkOf(0, 1)).mem.entities.length, 2);
});

test('re-declaring a known entity by the same name is rejected; adding aliases by id works', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const theo = mem.entities.find(e => e.name === 'Theo').id;
    const base = { scenes: [{ scene: 'new', title: 'Night', who: [theo], outline: 'Night falls.', points: [{ text: 'Theo slept.', kind: 'moment', key: false, msgs: [6] }], ended: true }] };
    const dup = { ...base, entities: [{ ref: 'x', type: 'person', name: 'theo' }] };
    assert.ok(validateResult(dup, { mem, chunk: chunkOf(6, 7) }).some(e => e.includes(`already exists as ${theo}`)));
    const twice = { ...base, entities: [{ ref: 'a', type: 'item', name: 'key' }, { ref: 'b', type: 'item', name: 'Key' }] };
    assert.ok(validateResult(twice, { mem, chunk: chunkOf(6, 7) }).some(e => e.includes('declared twice')));
    const alias = { ...base, entities: [{ id: theo, aliases: ['꼬맹이'] }] };
    assert.deepEqual(validateResult(alias, { mem, chunk: chunkOf(6, 7) }), []);
    const next = applyResult(mem, alias, chunkOf(6, 7)).mem;
    assert.deepEqual(next.entities.find(e => e.id === theo).aliases, ['테오', '꼬맹이']);
    assert.equal(next.entities.length, mem.entities.length);
});

// ───── review #2: a quest made and finished in one batch ─────
test('a quest created and fulfilled in the same batch is stored as done', () => {
    const mk = status => ({ scenes: [{ scene: 'new', title: 'Tea', who: ['m'], outline: 'Mara promised tea and bought it.', points: [{ text: 'Mara promised tea and bought it.', kind: 'change', key: true, msgs: [1, 4] }], ended: true }],
        entities: [{ ref: 'm', type: 'person', name: 'Mara' }],
        changes: [{ op: 'add', type: 'quest', kind: 'promise', who: ['m'], text: 'Mara promised to buy tea.', terms: { msg: 1, quote: 'I will buy the tea' }, ...(status ? { status } : {}), msgs: [1, 4] }] });
    for (const [status, expect] of [['done', 'done'], ['failed', 'failed'], [undefined, 'open']]) {
        const data = mk(status);
        assert.deepEqual(validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 5) }), []);
        assert.equal(applyResult(emptyMem(), data, chunkOf(0, 5)).mem.records[0].status, expect);
    }
    const bad = mk('finished');
    assert.ok(validateResult(bad, { mem: emptyMem(), chunk: chunkOf(0, 5) }).some(e => e.includes('status')));
});

// ───── review #5: unknown references are rejected, not silently dropped ─────
test('unknown who / knownBy references are rejected', () => {
    const data = lanternResult();
    data.scenes[0].who.push('ghost');
    data.changes.push({ op: 'add', type: 'world', kind: 'secret', text: 'The gate is unlocked.', knownBy: ['ghost'], msgs: [1] });
    data.changes[2].who = ['nobody'];
    const errors = validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 5) });
    assert.ok(errors.some(e => e.includes('scenes[0].who[3]')));
    assert.ok(errors.some(e => e.includes('knownBy[0]')));
    assert.ok(errors.some(e => e.startsWith('changes[2] (') && e.includes('.who[0] "nobody"')));
});

test('bare names and wrong entity types are rejected; valid refs resolve', () => {
    const data = lanternResult();
    data.changes[1].entity = 'Theo';          // a name, not a ref
    data.changes[0].holder = 'l';             // an item cannot hold an item
    data.changes.push({ op: 'add', type: 'world', kind: 'secret', text: 'Theo hides a key.', knownBy: ['m'], msgs: [3] });
    const errors = validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 5) });
    assert.ok(errors.some(e => e.startsWith('changes[1] (') && e.includes('.entity "Theo" is not a known entity')));
    assert.ok(errors.some(e => e.includes('.holder "l" (brass lantern) is a item, but must be a person or a place.') && e.includes('has the item now')));
    data.changes[1].entity = 't'; data.changes[0].holder = 't';
    assert.deepEqual(validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 5) }), []);
    const { mem } = applyResult(emptyMem(), data, chunkOf(0, 5));
    const mara = mem.entities.find(e => e.name === 'Mara').id;
    assert.deepEqual(mem.records.find(r => r.type === 'world').knownBy, [mara]);
    // knownBy survives a later update that does not touch it
    const upd = { scenes: [{ scene: 'continue', keys: { 'g1.0': true, 'g1.1': false }, title: 'x', outline: 'y.', points: [], ended: false }], changes: [{ op: 'update', id: 'r4', text: 'Theo hides a brass key.', msgs: [6] }] };
    assert.deepEqual(validateResult(upd, { mem, chunk: chunkOf(6, 7) }), []);
    assert.deepEqual(applyResult(mem, upd, chunkOf(6, 7)).mem.records.find(r => r.id === 'r4').knownBy, [mara]);
});

test('declared refs must be unique and must not look like ids', () => {
    const data = lanternResult();
    data.entities.push({ ref: 'm', type: 'person', name: 'Mira' }, { ref: 'e9', type: 'person', name: 'Ivo' });
    const errors = validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 5) });
    assert.ok(errors.some(e => e.includes('"m" is declared twice')));
    assert.ok(errors.some(e => e.includes('"e9" looks like an id')));
});

test('rollback from an edited message undoes that batch and every later one', () => {
    const st = { mem: emptyMem(), lastIndex: -1, history: [], floor: -1 };
    const step = (data, from, to) => {
        const before = st.mem;
        st.mem = applyResult(st.mem, data, chunkOf(from, to)).mem;
        pushHistory(st, before, st.mem, { kind: 'summary', from: st.lastIndex + 1, to });
        st.lastIndex = to;
    };
    step({ scenes: [{ scene: 'new', title: 'Gift', outline: 'Mara received a ring.', points: [{ text: 'Mara received a silver ring from Theo.', kind: 'change', key: true, msgs: [1] }], ended: true }],
        entities: [{ ref: 'm', type: 'person', name: 'Mara' }, { ref: 'ring', type: 'item', name: 'silver ring' }],
        changes: [{ op: 'add', type: 'item', entity: 'ring', holder: 'm', text: 'A gift from Theo.', msgs: [1] }] }, 0, 3);
    step({ scenes: [{ scene: 'new', title: 'Pass on', outline: 'Mara gave the ring to Ivy.', points: [{ text: 'Mara gave the ring to Ivy.', kind: 'change', key: true, msgs: [5] }], ended: true }],
        entities: [{ ref: 'i', type: 'person', name: 'Ivy' }],
        changes: [{ op: 'update', id: 'r1', holder: 'i', msgs: [5] }] }, 4, 7);
    // edit in the middle of the first batch
    assert.equal(rollbackFrom(st, 2), true);
    assert.equal(st.lastIndex, -1);
    assert.equal(st.mem.scenes.length, 0);
    assert.equal(st.mem.records.length, 0);
    assert.equal(st.history.length, 0);
});

test('rollback from the second batch keeps the first', () => {
    const st = { mem: emptyMem(), lastIndex: -1, history: [], floor: -1 };
    for (const [from, to] of [[0, 3], [4, 7]]) {
        const before = st.mem;
        st.mem = applyResult(st.mem, { scenes: [{ scene: 'new', title: 'S' + from, outline: 'x.', points: [{ text: 'p', kind: 'moment', key: false, msgs: [from] }], ended: true }] }, chunkOf(from, to)).mem;
        pushHistory(st, before, st.mem, { kind: 'summary', from, to });
        st.lastIndex = to;
    }
    assert.equal(rollbackFrom(st, 6), true);
    assert.equal(st.lastIndex, 3);
    assert.deepEqual(st.mem.scenes.map(s => s.title), ['S0']);
    assert.equal(st.mem.next.s, 2);
});

test('an edit before the history floor cannot roll back', () => {
    const st = { mem: emptyMem(), lastIndex: 10, history: [], floor: 10 };
    assert.equal(rollbackFrom(st, 4), false);
});

test('injection respects the hard cap and recalls by a Korean alias', () => {
    let mem = emptyMem();
    ({ mem } = applyResult(mem, {
        scenes: [{ scene: 'new', title: 'Compass', where: 'Fair', who: ['b'], outline: 'Theo found a brass compass at the fair and gave it to Mara.',
            points: [{ text: 'Theo gave Mara the brass compass he found.', kind: 'change', key: true, msgs: [1] }],
            notes: 'The compass has a cracked glass and a tin star charm. Theo joked it was worth a fortune.', ended: true }],
        entities: [{ ref: 'b', type: 'item', name: 'brass compass', aliases: ['나침반'] }],
    }, chunkOf(0, 2)));
    for (let i = 0; i < 30; i++) {
        ({ mem } = applyResult(mem, { scenes: [{ scene: 'new', title: 'Filler ' + i, outline: 'A long ordinary day passed with chores and small talk about the weather and the harvest. '.repeat(3), points: [{ text: 'Chores.', kind: 'moment', key: false, msgs: [3 + i * 2] }], ended: true }] }, chunkOf(3 + i * 2, 4 + i * 2)));
    }
    const inj = buildInjection(mem, { budget: 800, titleCap: 40, query: '마라는 나침반을 만지작거렸다.' });
    assert.ok(inj.tokens <= 800 + 5, `tokens ${inj.tokens}`);
    assert.equal(inj.recalled[0]?.title, 'Compass');
    assert.match(inj.text, /cracked glass/);
    assert.ok(inj.used.titles <= 40);
    assert.ok(inj.omittedScenes > 0);
});

test('unused recall budget flows to the journal', () => {
    let mem = emptyMem();
    for (let i = 0; i < 12; i++) {
        ({ mem } = applyResult(mem, { scenes: [{ scene: 'new', title: 'Day ' + i, outline: 'Something happened that day in detail. '.repeat(12), points: [{ text: 'p', kind: 'moment', key: false, msgs: [i * 2] }], ended: true }] }, chunkOf(i * 2, i * 2 + 1)));
    }
    const inj = buildInjection(mem, { budget: 1200, titleCap: 100, query: '' });
    assert.equal(inj.used.recall, 0);
    assert.ok(inj.used.journal > 1200 * 0.5, `journal ${inj.used.journal}`);
    assert.ok(inj.tokens <= 1205);
});

test('pinned scenes keep at least one line; pin overflow is reported', () => {
    let mem = emptyMem();
    for (let i = 0; i < 20; i++) {
        ({ mem } = applyResult(mem, { scenes: [{ scene: 'new', title: 'Old ' + i, outline: 'First sentence for scene ' + i + '. ' + 'More words that are long. '.repeat(10), points: [{ text: 'p', kind: 'moment', key: false, msgs: [i * 2] }], ended: true }] }, chunkOf(i * 2, i * 2 + 1)));
    }
    mem.scenes[0].pin = true;
    let inj = buildInjection(mem, { budget: 400, titleCap: 50, recentScenes: 2 });
    assert.match(inj.text, /Old 0 \(|- Old 0/);
    assert.equal(inj.pinOverflow, false);
    for (const s of mem.scenes) { s.pin = true; s.outline = 'The first sentence of this pinned scene is deliberately long and detailed. ' + s.outline; }
    inj = buildInjection(mem, { budget: 300, titleCap: 50 });
    assert.equal(inj.pinOverflow, true);
    assert.ok(inj.tokens <= 305);
});

test('a pinned scene keeps its minimum even when many small scenes compete', () => {
    let mem = emptyMem();
    ({ mem } = applyResult(mem, { scenes: [{ scene: 'new', title: 'Vow', outline: 'Important '.repeat(135) + '.', points: [{ text: 'vow', kind: 'change', key: true, msgs: [0] }], ended: true }] }, chunkOf(0, 1)));
    for (let i = 1; i <= 30; i++) ({ mem } = applyResult(mem, { scenes: [{ scene: 'new', title: 'Day ' + i, outline: 'An ordinary day passed with chores and a walk.', points: [{ text: 'walk', kind: 'moment', key: false, msgs: [i * 2] }], ended: true }] }, chunkOf(i * 2, i * 2 + 1)));
    mem.scenes[0].pin = true;
    const inj = buildInjection(mem, { budget: 600, titleCap: 0 });
    assert.match(inj.text, /- Vow: Important/);
    assert.equal(inj.pinOverflow, false);
    assert.ok(inj.tokens <= 605, `tokens ${inj.tokens}`);
    // when the pinned minimum alone cannot fit, the warning matches the real omission
    const tight = buildInjection(mem, { budget: 300, titleCap: 0 });
    assert.doesNotMatch(tight.text, /- Vow:/);
    assert.equal(tight.pinOverflow, true);
    assert.equal(tight.pinMissing, 1);
});

test('open quests and current-scene state come first', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const inj = buildInjection(mem, { budget: 2000, query: '테오가 웃었다' });
    assert.match(inj.text, /Open threads:\n- \[promise\] Theo promised/);
    assert.match(inj.text, /Items:\n- \[item\] brass lantern \(held by Theo\)/);
    assert.ok(inj.text.indexOf('## Current state') < inj.text.indexOf('## Journal'));
});

test('prompt context lists only relevant state when it is large', () => {
    let { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    for (let i = 0; i < 300; i++) mem.records.push({ id: 'r' + (100 + i), type: 'world', kind: 'place', text: 'Some far place number ' + i + ' with a long description.', src: [], msgs: [], pin: false });
    const c = promptContext(mem, '#9 Theo: 테오가 랜턴을 들었다', { stateChars: 3000 });
    assert.ok(c.state.length < 3300);
    assert.match(c.state.split('\n')[0], /promise/);
    assert.match(c.state, /brass lantern/);
    assert.match(c.state, /more not shown/);
});

test('chunks stay under the limit and keep message numbers', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ index: i * 2, name: 'A', text: 'x'.repeat(100) }));
    const chunks = chunkMessages(msgs, 1200);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.text.length <= 1200);
    assert.equal(chunks[0].from, 0);
    assert.equal(chunks.at(-1).to, 98);
    assert.deepEqual(chunks.flatMap(c => c.indices), msgs.map(m => m.index));
});

test('stored memory survives cleaning; detached memory preserves an open scene and separates evidence', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const back = cleanMem(JSON.parse(JSON.stringify(mem)));
    assert.equal(JSON.stringify(back.scenes), JSON.stringify(mem.scenes));
    assert.deepEqual(back.next, mem.next);
    const d = detachMem(back);
    assert.equal(d.scenes[0].external, true);
    assert.equal(openScene(d).id, back.scenes[0].id);
    assert.deepEqual(d.scenes[0].segs[0].points[0].msgs, []);
    assert.equal(d.scenes[0].segs[0].source.room, null);
    assert.throws(() => cleanMem({ scenes: [{ id: 'x' }], entities: [], records: [] }));
});

test('closing the open scene without new messages', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    assert.equal(openScene(closeOpenScene(mem)), null);
});

test('recall ignores names that appear in most scenes', () => {
    let mem = emptyMem();
    ({ mem } = applyResult(mem, { scenes: [{ scene: 'new', title: 'Compass', who: ['a', 'b'], outline: 'Ari got a compass.', points: [{ text: 'Ari got the compass.', kind: 'change', key: true, msgs: [0] }], ended: true }],
        entities: [{ ref: 'a', type: 'person', name: 'Ari', aliases: ['아리'] }, { ref: 'b', type: 'item', name: 'compass', aliases: ['나침반'] }] }, chunkOf(0, 1)));
    for (let i = 1; i < 6; i++) ({ mem } = applyResult(mem, { scenes: [{ scene: 'new', title: 'Day ' + i, who: ['e1'], outline: 'Ari walked around.', points: [{ text: 'Ari walked.', kind: 'moment', key: false, msgs: [i * 2] }], ended: true }] }, chunkOf(i * 2, i * 2 + 1)));
    assert.equal(recallScenes(mem, '아리가 웃었다').length, 0);
    assert.equal(recallScenes(mem, '아리가 나침반을 봤다')[0].scene.title, 'Compass');
});

test('recall ignores scenes with only one weak match', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    assert.equal(recallScenes(mem, 'the weather today').length, 0);
    assert.ok(estTokens('hello world') > 0);
});

// ───── automatic collection: scene boundaries ─────
import { validateBoundary } from '../core.js';
const sent = [10, 11, 12, 14, 15, 16, 17];   // #13 was hidden by the user, so it was not sent

test('boundary: only scenes followed by a started scene are finished', () => {
    const { errors, plan } = validateBoundary({ continues_open_scene: false, scenes: [
        { start: 10, ended: true }, { start: 14, ended: true }, { start: 16, ended: false }] }, { indices: sent, hasOpen: false });
    assert.deepEqual(errors, []);
    assert.equal(plan.finished, 2);
    assert.equal(plan.boundary, 15);
});

test('boundary: an "ended" last scene is not saved without a following scene', () => {
    const { plan } = validateBoundary({ continues_open_scene: false, scenes: [{ start: 10, ended: true }] }, { indices: sent, hasOpen: false });
    assert.equal(plan.boundary, null);
    assert.equal(plan.closeOpen, false);
});

test('boundary: a scene marked not ended stops the saved prefix', () => {
    const { plan } = validateBoundary({ continues_open_scene: false, scenes: [
        { start: 10, ended: false }, { start: 14, ended: true }, { start: 16, ended: false }] }, { indices: sent, hasOpen: false });
    assert.equal(plan.boundary, null);
});

test('boundary: the last message before the next start is used even across a gap', () => {
    const { plan } = validateBoundary({ continues_open_scene: false, scenes: [{ start: 10, ended: true }, { start: 14, ended: false }] }, { indices: sent, hasOpen: false });
    assert.equal(plan.boundary, 12);
});

test('boundary: numbers must be sent, in range, ascending, and start at the first message', () => {
    const bad = (scenes, extra = {}) => validateBoundary({ continues_open_scene: false, scenes, ...extra }, { indices: sent, hasOpen: false }).errors;
    assert.ok(bad([{ start: 10, ended: true }, { start: 13, ended: false }]).some(e => e.includes('scenes[1].start')));   // hidden, not sent
    assert.ok(bad([{ start: 10, ended: true }, { start: 40, ended: false }]).some(e => e.includes('scenes[1].start')));   // out of range
    assert.ok(bad([{ start: 10, ended: true }, { start: 15, ended: true }, { start: 14, ended: false }]).some(e => e.includes('after the previous')));
    assert.ok(bad([{ start: 11, ended: false }]).some(e => e.includes('must be #10')));
    assert.ok(bad([{ start: 10, ended: 'yes' }]).some(e => e.includes('ended')));
    assert.ok(bad([{ start: 10, ended: false }], { continues_open_scene: true }).some(e => e.includes('no open scene')));
    assert.deepEqual(bad([{ start: '#10', ended: true }, { start: '14', ended: false }]), []);
});

test('boundary: new messages that all belong to a new scene close the open scene only', () => {
    const { plan } = validateBoundary({ continues_open_scene: false, scenes: [{ start: 10, ended: false }] }, { indices: sent, hasOpen: true });
    assert.equal(plan.closeOpen, true);
    assert.equal(plan.boundary, null);
    const cont = validateBoundary({ continues_open_scene: true, scenes: [{ start: 10, ended: true }, { start: 15, ended: false }] }, { indices: sent, hasOpen: true }).plan;
    assert.equal(cont.closeOpen, false);
    assert.equal(cont.boundary, 14);
});

test('extraction must follow the boundary decision about the open scene', () => {
    let { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const asNew = { scenes: [{ scene: 'new', title: 'x', outline: 'y.', points: [], ended: true }] };
    assert.ok(validateResult(asNew, { mem, chunk: chunkOf(6, 8), expectContinue: true }).some(e => e.includes('must be "continue"')));
    const asCont = { scenes: [{ scene: 'continue', keys: { 'g1.0': true, 'g1.1': false }, title: 'x', outline: 'y.', points: [], ended: true }] };
    assert.deepEqual(validateResult(asCont, { mem, chunk: chunkOf(6, 8), expectContinue: true }), []);
});

test('a person in the item slot gets an actionable message naming the change (v0.2.1)', () => {
    const data = lanternResult();
    data.changes.push({ op: 'add', type: 'item', entity: 't', holder: 'l', text: 'Theo carries the lantern home.', msgs: [5] });
    const errors = validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 5) });
    const e = errors.find(x => x.startsWith('changes[3] ("Theo carries the lantern home.")'));
    assert.ok(e, errors.join('\n'));
    assert.match(e, /\.entity "t" \(Theo\) is a person, but must be an item\./);
    assert.match(e, /"entity" is the item itself and the person who has it goes in "holder"/);
    assert.match(e, /make it a "party" record/);
    // no automatic swap: the change is still rejected as written
    assert.ok(errors.some(x => x.includes('.holder "l" (brass lantern) is a item')));
});

test('retry note asks to reread the cited message instead of swapping fields', async () => {
    const { retryNote } = await import('../prompts.js');
    assert.match(retryNote(['x'], []), /reread the message it cites/);
});

// ───── v0.2.4: stored vs injected points ─────
import { foldLegacyOutline, sceneFull, pointInjected, openPoints, validateRekey, applyRekey, rekeyItems } from '../core.js';

test('only key points are injected, also for the open scene; all false means outline only', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const s = mem.scenes[0];
    assert.equal(s.status, 'open');
    let txt = sceneFull(s);
    assert.match(txt, /refitted its handle/);          // key: true
    assert.doesNotMatch(txt, /laughed/);                // key: false, still stored
    assert.equal(s.segs[0].points.length, 2);
    s.segs[0].points[0].key = false;
    txt = sceneFull(s);
    assert.equal(txt.split('\n').length, 1, 'outline only');
});

test('points stored before v0.2.4 (no key) are still injected', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    for (const p of mem.scenes[0].segs[0].points) delete p.key;
    assert.equal(sceneFull(mem.scenes[0]).split('\n').length, 3);
});

// ───── v0.2.5: part outlines are never rewritten ─────
test('continuing keeps earlier part outlines and point choices; the new part gets its own outline', () => {
    let { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    mem.scenes[0].segs[0].points[1].keyUser = true;
    const cont = { scenes: [{ scene: 'continue', title: 'Lantern at the gate', outline: 'Theo promised to repay her with tea.',
        keys: { 'g1.0': false, 'g1.1': false },          // ignored since v0.2.5
        points: [{ text: 'Theo promised to repay her with tea.', kind: 'change', key: false, msgs: [6] }], ended: false }] };
    assert.deepEqual(validateResult(cont, { mem, chunk: chunkOf(6, 7) }), []);
    ({ mem } = applyResult(mem, cont, chunkOf(6, 7)));
    const [g1, g2] = mem.scenes[0].segs;
    assert.match(g1.outline, /repaired Theo's broken lantern/);
    assert.equal(g2.outline, 'Theo promised to repay her with tea.');
    assert.equal(g1.points[0].key, true, 'earlier AI choice not re-judged');
    assert.equal(pointInjected(g1.points[1]), true);
    const txt = sceneFull(mem.scenes[0]);
    assert.match(txt, /repaired Theo's broken lantern.*repay her with tea/s, 'both part outlines, in order');
    assert.match(txt, /refitted its handle/);
});

test('a continue reply no longer needs keys for earlier points', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const e = validateResult({ scenes: [{ scene: 'continue', title: 'x', outline: 'y.', points: [], ended: false }] }, { mem, chunk: chunkOf(6, 7) });
    assert.deepEqual(e, []);
    const noKey = lanternResult(); delete noKey.scenes[0].points[0].key;
    assert.ok(validateResult(noKey, { mem: emptyMem(), chunk: chunkOf(0, 5) }).some(x => x.includes('.key must be true or false')));
});

// ───── v0.2.5: recall by what was actually injected ─────
test('a recent scene can recall its left-out points and notes', () => {
    let { mem } = applyResult(emptyMem(), {
        scenes: [{ scene: 'new', title: 'Fair', where: 'Fair', who: ['a', 'b'], outline: 'Theo and Mara spent the evening at the fair.',
            points: [{ text: 'At the sketch stall Theo said "hold still" before each drawing.', kind: 'moment', key: false, msgs: [1] },
                     { text: 'Mara won the chess match by a single move.', kind: 'change', key: false, msgs: [2] }],
            notes: 'The sketch has two panels: the dog, then both of them.', ended: false }],
        entities: [{ ref: 'a', type: 'person', name: 'Theo' }, { ref: 'b', type: 'person', name: 'Mara' }],
    }, chunkOf(0, 3));
    let inj = buildInjection(mem, { budget: 3000, query: 'Do you still have the sketch stall drawing?' });
    assert.equal(inj.recalled[0]?.title, 'Fair', 'recent scene is a recall candidate');
    assert.match(inj.text, /## Recalled details[\s\S]*hold still/);
    assert.doesNotMatch(inj.text.split('## Recalled')[0], /hold still/);
    // a point that is already injected is not repeated by recall
    mem.scenes[0].segs[0].points[0].keyUser = true;
    inj = buildInjection(mem, { budget: 3000, query: 'Do you still have the sketch stall drawing?' });
    assert.equal((inj.text.match(/hold still/g) || []).length, 1);
});

test('a key point dropped by the budget can still be recalled', () => {
    let mem = emptyMem();
    ({ mem } = applyResult(mem, { scenes: [{ scene: 'new', title: 'Chess', who: [], outline: 'They played chess.', points: [{ text: 'Mara won the chess match by a single move at the fair.', kind: 'change', key: true, msgs: [0] }], ended: true }] }, chunkOf(0, 1)));
    for (let i = 0; i < 3; i++) ({ mem } = applyResult(mem, { scenes: [{ scene: 'new', title: 'Day ' + i, outline: 'Ordinary day number ' + i + ' with long chores and errands across the district. '.repeat(6), points: [{ text: 'chores', kind: 'moment', key: true, msgs: [2 + i * 2] }], ended: true }] }, chunkOf(2 + i * 2, 3 + i * 2)));
    const inj = buildInjection(mem, { budget: 500, titleCap: 50, recentScenes: 4, query: 'who won the chess at the fair?' });
    assert.ok(inj.tokens <= 505);
    assert.match(inj.text, /single move/, 'recalled even though the scene was cut to its outline or less');
});

test('the open-scene list shown to the AI is capped, and only shown points must be judged', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const g = mem.scenes[0].segs[0];
    for (let i = 0; i < 80; i++) g.points.push({ text: 'filler point number ' + i, kind: 'moment', key: false, msgs: [1] });
    const { shown, hidden } = openPoints(mem.scenes[0]);
    assert.equal(shown.length, 60);
    assert.equal(hidden, 22);
    assert.equal(shown.at(-1).id, 'g1.81');
});

test('re-choosing key points of a stored scene without re-collecting', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const s = mem.scenes[0];
    s.segs[0].points[0].keyUser = true;
    const ids = rekeyItems(s).map(x => x.id);
    assert.deepEqual(ids, ['g1.0', 'g1.1']);
    assert.ok(validateRekey({ keys: { 'g1.0': false } }, ids).some(x => x.includes('g1.1')));
    assert.ok(validateRekey({ keys: { 'g1.0': false, 'g1.1': true, 'zz': true } }, ids).some(x => x.includes('zz')));
    assert.deepEqual(validateRekey({ keys: { 'g1.0': false, 'g1.1': true } }, ids), []);
    const next = applyRekey(mem, s.id, { 'g1.0': false, 'g1.1': true });
    const [p0, p1] = next.scenes[0].segs[0].points;
    assert.equal(p0.key, false); assert.equal(pointInjected(p0), true, 'user choice kept');
    assert.equal(p1.key, true);
    assert.equal(mem.scenes[0].segs[0].points[1].key, false, 'original untouched');
});

test('the character and persona names alone do not trigger recall', () => {
    const { mem } = applyResult(emptyMem(), {
        scenes: [{ scene: 'new', title: 'Gift', who: ['a'], outline: 'A quiet evening.', points: [{ text: 'Ari received a gift at 6.', kind: 'change', key: false, msgs: [1] }], ended: false }],
        entities: [{ ref: 'a', type: 'person', name: 'Ari', aliases: ['아리'] }],
    }, chunkOf(0, 2));
    assert.equal(buildInjection(mem, { query: 'Ari smiled. 아리가 웃었다.' }).recalled.length, 1, 'without the ignore list');
    const inj = buildInjection(mem, { query: 'Ari smiled. 아리가 웃었다.', ignoreNames: ['Ari', 'Me'] });
    assert.equal(inj.recalled.length, 0);
    assert.doesNotMatch(inj.text, /gift at 6/);
});

// ───── v0.2.6 ─────
import { normalizeResult, dupState, injectedPoints } from '../core.js';

test('continue with no open scene becomes new, only for the first scene', () => {
    const data = lanternResult();
    data.scenes[0].scene = 'continue';
    assert.equal(normalizeResult(data, { mem: emptyMem() }).length, 1);
    assert.equal(data.scenes[0].scene, 'new');
    assert.deepEqual(validateResult(data, { mem: emptyMem(), chunk: chunkOf(0, 5) }), []);
    const two = { scenes: [{ scene: 'new', title: 'a', outline: 'b.', points: [], ended: true }, { scene: 'continue', start: 3, title: 'c', outline: 'd.', points: [], ended: false }] };
    normalizeResult(two, { mem: emptyMem() });
    assert.equal(two.scenes.length, 1, 'a later "continue" is merged into the scene before it (v0.3.1)');
    assert.equal(two.scenes[0].outline, 'b. d.');
    assert.equal(two.scenes[0].ended, false);
    // with an open scene nothing is changed
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const cont = { scenes: [{ scene: 'continue', title: 'x', outline: 'y.', points: [], ended: false }] };
    assert.deepEqual(normalizeResult(cont, { mem }), []);
});

test('a key point that the outline already contains as written is not injected again; user ● is', () => {
    const { mem } = applyResult(emptyMem(), {
        scenes: [{ scene: 'new', title: 'Chess', outline: 'Theo won 3-2. Mara kept the kite.', ended: true, points: [
            { text: 'Theo won 3-2.', kind: 'change', key: true, msgs: [0] },
            { text: 'As agreed beforehand, Mara kept the kite.', kind: 'change', key: true, msgs: [1] },
            { text: 'Mara then kept the kite.', kind: 'change', key: false, msgs: [1] }] }],
    }, chunkOf(0, 2));
    const s = mem.scenes[0];
    const [a, b, c] = s.segs[0].points;
    assert.equal(dupState(s, a), 'exact');
    assert.equal(dupState(s, b), null, 'adds the reason, so it stays');
    assert.equal(dupState(s, c), 'near');
    assert.deepEqual(injectedPoints(s).map(p => p.text), [b.text]);
    assert.equal(a.key, true, 'stored choice untouched');
    a.keyUser = true;
    assert.equal(injectedPoints(s).length, 2, 'a point the user marked stays');
});

test('recall takes matching units within a hard share and never repeats injected text', () => {
    let { mem } = applyResult(emptyMem(), {
        scenes: [{ scene: 'new', title: 'Fair', who: [], outline: 'They won a kite and drew sketches.', ended: false,
            points: [{ text: 'At the sketch stall Theo said "hold still" before the first drawing.', kind: 'moment', key: false, msgs: [1] },
                     { text: 'They drew sketches at the stall.', kind: 'moment', key: true, msgs: [1] }],
            notes: ('The ring toss paid out on the fourth throw after a long wait. ').repeat(1) + 'The sketch stall drawing shows the dog and both of them grinning. ' + 'Filler sentence about the tea stand and the weather outside the fair. '.repeat(40) }],
    }, chunkOf(0, 2));
    const inj = buildInjection(mem, { budget: 2000, query: 'Do you still have the sketch stall drawing from the stall?' });
    assert.ok(inj.used.recall <= 2000 * 0.15 + 1, `recall ${inj.used.recall}`);
    const rec = inj.text.split('## Recalled')[1] || '';
    assert.match(rec, /hold still/);
    assert.match(rec, /drawing shows the dog/);
    assert.doesNotMatch(rec, /tea stand/, 'unrelated note sentences are not pulled in');
    assert.doesNotMatch(rec, /drew sketches at the stall/, 'already injected');
});


test('an early scene-wide outline is folded into the first part so it stays in the injection', () => {
    const { mem } = applyResult(emptyMem(), lanternResult(), chunkOf(0, 5));
    const old = JSON.parse(JSON.stringify(mem));
    old.scenes[0].legacyOutline = 'Old scene-wide outline about the card game.';
    old.scenes[0].koOutline = '옛 번역';
    const cleaned = cleanMem(old);
    assert.match(cleaned.scenes[0].segs[0].outline, /^Old scene-wide outline about the card game\. /);
    assert.equal(cleaned.scenes[0].legacyOutline, undefined);
    assert.match(sceneFull(cleaned.scenes[0]), /Old scene-wide outline/);
    const bare = JSON.parse(JSON.stringify(mem));
    bare.scenes[0].outline = 'Bare outline from the first release.';
    for (const g of bare.scenes[0].segs) delete g.outline;
    const live = JSON.parse(JSON.stringify(bare));
    assert.equal(foldLegacyOutline(live), true);
    assert.equal(live.scenes[0].segs[0].outline, 'Bare outline from the first release.');
    assert.equal(foldLegacyOutline(live), false, 'folds once');
});

test('an unusable later scene start is repaired from the batch instead of failing the save', () => {
    const scene = (start, msgs, title) => ({ scene: 'new', title, where: '', who: [], outline: `${title} happened.`, notes: '', ended: false, ...(start === undefined ? {} : { start }),
        points: [{ text: `${title} point.`, kind: 'moment', key: false, msgs }] });
    // a batch with a gap (#64 was hidden by the user, so it is not part of the batch)
    const chunk = { from: 60, to: 69, indices: [60, 61, 62, 63, 65, 66, 67, 68, 69], text: '' };
    // missing start: taken from the first message the scene's own points cite
    let data = { scenes: [scene(undefined, [60], 'A'), scene(undefined, [66, 67], 'B')], entities: [], changes: [] };
    let notes = normalizeResult(data, { mem: emptyMem(), chunk });
    assert.equal(data.scenes[1].start, 66); assert(notes.some(n => n.startsWith('start:2:')));
    assert.deepEqual(validateResult(data, { mem: emptyMem(), chunk }), []);
    // a start on the hidden gap moves forward to the next real message
    data = { scenes: [scene(undefined, [60], 'A'), scene('#64', [65], 'B')], entities: [], changes: [] };
    normalizeResult(data, { mem: emptyMem(), chunk });
    assert.equal(data.scenes[1].start, 65);
    assert.deepEqual(validateResult(data, { mem: emptyMem(), chunk }), []);
    // a start that is not after the previous scene, and nothing later cited: it is part of that scene
    data = { scenes: [scene(undefined, [60, 61], 'A'), scene(60, [60], 'B')], entities: [], changes: [] };
    notes = normalizeResult(data, { mem: emptyMem(), chunk });
    assert.equal(data.scenes.length, 1); assert.equal(data.scenes[0].points.length, 2); assert(notes.some(n => n.startsWith('merged:')));
    assert.deepEqual(validateResult(data, { mem: emptyMem(), chunk }), []);
    // a good start is left alone
    data = { scenes: [scene(undefined, [60], 'A'), scene(63, [63], 'B')], entities: [], changes: [] };
    notes = normalizeResult(data, { mem: emptyMem(), chunk });
    assert.equal(data.scenes[1].start, 63); assert(!notes.some(n => n.startsWith('start:') || n.startsWith('merged:')));
});
