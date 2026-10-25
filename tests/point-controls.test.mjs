// Exercise the real point handlers and HTML without a browser or external API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../core.js';
import * as prompts from '../prompts.js';
import * as vault from '../vault.js';

function controls() {
    const mem = core.emptyMem();
    mem.scenes.push({ id: 's1', title: 'Lantern', where: '', who: [], status: 'open', star: false, pin: false,
        segs: [{ id: 'g1', from: 0, to: 0, outline: 'A lantern was repaired.', notes: '',
            points: [{ text: 'Mara kept the blue ribbon.', kind: 'moment', key: true, msgs: [0] }] }] });
    const st = { v: 1, mem, lastIndex: -1, hashes: [], history: [], floor: -1, rev: 0 };
    let writes = 0;
    const context = { characterId: 0, characters: [{ name: 'Theo', avatar: 'theo.png' }], chatId: 'room', chat: [],
        chatMetadata: { savePoint: st }, extensionSettings: {}, setExtensionPrompt() {},
        async saveMetadata() { writes++; }, saveSettingsDebounced() {} };
    const imported = { ...core, ...prompts, ...vault };
    const original = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const names = [];
    const source = original.replace(/^import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"];\n/gm, (_, list) => {
        names.push(...list.split(',').map(x => x.trim()).filter(Boolean)); return '';
    });
    const run = new Function(...names, 'SillyTavern', 'jQuery',
        source + '\nrender = () => {}; autosave = () => {}; return { handle, journalHtml, ui };');
    const app = run(...names.map(n => imported[n]), { getContext: () => context }, () => {});
    return { app, context, writes: () => writes,
        point: () => context.chatMetadata.savePoint.mem.scenes[0].segs[0].points[0],
        html: () => app.journalHtml(context.chatMetadata.savePoint) };
}

test('point controls distinguish AI and manual choices, persist them, and restore the choice after unpinning', async () => {
    const c = controls();
    assert.match(c.html(), /data-act="key-toggle"[^>]*>●<\/button>/);
    await c.app.handle('key-toggle', 's1|g1|0');
    assert.equal(c.point().keyUser, false);
    await c.app.handle('key-toggle', 's1|g1|0');
    assert.equal(c.point().keyUser, true, 'matching the AI does not erase the explicit user choice');
    assert.match(c.html(), /data-act="key-toggle"[^>]*>◎<\/button>/);
    await c.app.handle('pin-point', 's1|g1|0');
    assert.equal(c.point().pin, true);
    assert.match(c.html(), /data-act="key-toggle"[^>]*>📌<\/button>/);
    assert.doesNotMatch(c.html(), /data-act="pin-point"/, 'the leading pin is the unpin control');
    await c.app.handle('key-toggle', 's1|g1|0');
    assert.equal(c.point().pin, false);
    assert.equal(c.point().keyUser, true);
    assert.match(c.html(), /data-act="key-toggle"[^>]*>◎<\/button>/);
    assert.equal(c.writes(), 4);
});

test('pinning a stored-only point restores stored-only on release and does not change translations', async () => {
    const c = controls();
    c.point().key = false; c.point().ko = '푸른 리본을 보관했다.';
    await c.app.handle('pin-point', 's1|g1|0');
    assert.equal(core.pointInjected(c.point()), true);
    await c.app.handle('key-toggle', 's1|g1|0');
    assert.equal(core.pointInjected(c.point()), false);
    assert.equal(c.point().ko, '푸른 리본을 보관했다.');
    assert.match(c.html(), /data-act="key-toggle"[^>]*>○<\/button>/);
});
