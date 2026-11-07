const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const EXT = process.env.EXT || path.resolve(__dirname, '../..');
const HERE = __dirname;

function serve() {
    return new Promise(res => {
        const srv = http.createServer((req, resp) => {
            const u = decodeURIComponent(req.url.split('?')[0]);
            let file;
            if (u.startsWith('/ext/')) file = path.join(EXT, u.slice(5));
            else if (u === '/jquery.js') file = '/usr/share/javascript/jquery/jquery.min.js';
            else file = path.join(HERE, u === '/' ? 'page.html' : u);
            fs.readFile(file, (err, data) => {
                if (err) { resp.writeHead(404); resp.end(); return; }
                const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
                resp.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); resp.end(data);
            });
        });
        srv.listen(0, () => res(srv));
    });
}
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// v0.6.77 (review of v0.6.74, P2): a reset, rewind or load whose write fails puts back the exact hide flags,
// in every hide mode and with SavePoint turned off. Since v0.6.74 the settings never hide again what was
// shown, so before this the messages stayed shown and the next save wrote that into the file. Checked right
// after the failure (page) and after a scheduled save has run (file). The same changes when they succeed
// still show what left the memory (v0.6.74, unchanged).
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    async function session() {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: 'auto', keepRecent: 4 } }; });
        await page.goto(URL);
        await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
        await page.waitForTimeout(300);
        const ev = (fn, arg) => page.evaluate(fn, arg);
        // Two saves (a rewind point and a slot from the first), messages hidden by the auto mode.
        await ev(() => M.add(16));
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        await ev(() => { M.popupInput = 'first'; });
        await ev(() => __savePoint.handle('save-new'));
        await page.waitForTimeout(300);
        await ev(() => M.add(10));
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1800);
        return { page, ev };
    }
    const hidden = ev => ev(() => M.chat.map((m, i) => m.is_system ? i : -1).filter(i => i >= 0).join(','));
    const fileHidden = ev => ev(() => M.serverFiles.chatA.slice(1).map((m, i) => m.is_system ? i : -1).filter(i => i >= 0).join(','));
    const marks = ev => ev(() => M.chat.map(m => m.extra?.savepointHidden ? 1 : 0).join(''));
    const rev = ev => ev(() => __savePoint.state()?.rev);
    const actions = {
        reset: ev => ev(() => __savePoint.handle('clear-room')),
        rewind: ev => ev(() => __savePoint.handle('undo')),
        load: ev => ev(() => __savePoint.handle('load', __savePoint.listSaves().find(x => x.name === 'first').id)),
    };
    const modes = {
        off: ev => ev(() => { M.settings.savePoint.hideMode = 'off'; }),
        auto: async () => {},
        manual: ev => ev(() => { M.settings.savePoint.hideMode = 'manual'; }),
        disabled: ev => ev(() => { M.settings.savePoint.enabled = false; }),
    };

    for (const [mode, setMode] of Object.entries(modes)) {
        for (const [name, run] of Object.entries(actions)) {
            const { page, ev } = await session();
            const before = await hidden(ev), beforeMarks = await marks(ev), beforeRev = await rev(ev);
            if (name === 'reset' && mode === 'off') ok(before.split(',').length >= 10, `준비: 자동 하이드로 숨긴 원문 (${before.split(',').length}개)`);
            await setMode(ev);
            await ev(() => { M.confirm = true; M.failOnce = true; M.toastLog = toastr.log.length; });
            await run(ev).catch(() => {});
            await page.waitForTimeout(800);
            const mid = await hidden(ev);
            ok(await ev(() => M.failOnce === false), `${mode} · ${name}: 저장을 실제로 시도했고 실패함`);
            ok(mid === before && await marks(ev) === beforeMarks && await rev(ev) === beforeRev, `${mode} · ${name} 실패 직후: 기억과 하이드가 그대로 (${mid.split(',').length}개)`);
            // A scheduled save (a small save, like the ones notes and 🔶 make) writes the page as it is now.
            await ev(() => __savePoint.persistSoon());
            await page.waitForTimeout(1200);
            ok(await fileHidden(ev) === before, `${mode} · ${name} 예약된 저장 뒤 파일에도 하이드가 그대로`);
            await page.close();
        }
    }

    // The same changes that succeed (hide off): what left the memory is shown again (v0.6.74, unchanged).
    for (const [name, run] of Object.entries(actions)) {
        const { page, ev } = await session();
        const before = await hidden(ev);
        await ev(() => { M.settings.savePoint.hideMode = 'off'; M.confirm = true; });
        await run(ev);
        await page.waitForTimeout(800);
        const after = await hidden(ev);
        ok(after.split(',').filter(Boolean).length < before.split(',').length && await fileHidden(ev) === after, `성공한 ${name}: 기억에서 빠진 구간만 다시 보임 (${before.split(',').length} → ${after.split(',').filter(Boolean).length})`);
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
