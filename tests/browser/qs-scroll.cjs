const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const EXT = process.env.EXT || path.resolve(__dirname, '../..');
const HERE = __dirname;
const OUT = path.join(HERE, 'shots'); fs.mkdirSync(OUT, { recursive: true });
const SHOTS = process.argv.includes('--shots');

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

(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    async function session({ settings, width = 390 } = {}) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.addInitScript(s => { if (s) window.__presetSettings = s; }, settings || null);
        await page.goto(URL);
        await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
        await page.waitForTimeout(300);
        return page;
    }
    // v0.6.66: on a phone the quick settings hide the window's body and tab bar (v0.6.63). The places they
    // were scrolled to are kept: read before they are hidden, never while hidden.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, askResume: false, hudOpen: true } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    await ev(() => { M.add(40, i => i % 3 === 0 ? `SCENEBREAK ${i} ${'a long line of words '.repeat(12)}` : ''); return __savePoint.handle('run'); });
    await wait(1500);
    await ev(() => $('#sp_wand').trigger('click'));
    await wait(200);
    const where = () => ev(() => { const w = document.querySelector('#sp_overlay .sp-window'); const b = w.querySelector('.sp-body'), t = w.querySelector('.sp-tabs');
        return { body: Math.round(b.scrollTop), bodyMax: b.scrollHeight - b.clientHeight, tabs: Math.round(t.scrollLeft), tabsMax: t.scrollWidth - t.clientWidth, qs: !!w.querySelector('.sp-qs') }; });
    let r = await where();
    ok(r.bodyMax > 300 && r.tabsMax > 40 && !r.qs, `준비: 저널 본문과 탭 줄이 넘침 (${JSON.stringify(r)})`);

    // 1. scroll the body down, open the quick settings right away, close them: the same place.
    await ev(() => { document.querySelector('#sp_overlay .sp-body').scrollTop = 180; });
    await ev(() => __savePoint.handle('qs'));
    await wait(100);
    r = await ev(() => { const b = document.querySelector('#sp_overlay .sp-body'); return { hidden: !b.getClientRects().length, qs: !!document.querySelector('#sp_overlay .sp-qs') }; });
    ok(r.hidden && r.qs, `1. 휴대폰: 빠른 설정이 본문을 가림 (${JSON.stringify(r)})`);
    await ev(() => __savePoint.render(true));                  // a redraw while it is open (a value changed, a banner)
    await ev(() => __savePoint.handle('qs'));
    await wait(100);
    r = await where();
    ok(!r.qs && r.body === 180, `1. ★ 본문을 내린 직후 열고 닫아도 그 자리 (${r.body}, 기대 180)`);

    // 2. the tab bar scrolled sideways: the same after opening, a redraw and closing.
    await ev(() => { document.querySelector('#sp_overlay .sp-tabs').scrollLeft = 40; });
    const tabs0 = (await where()).tabs;
    await ev(() => __savePoint.render(true));
    const tabs1 = (await where()).tabs;
    await ev(() => __savePoint.handle('qs'));
    await ev(() => __savePoint.render(true));
    await ev(() => __savePoint.handle('qs'));
    await wait(100);
    r = await where();
    ok(tabs0 === 40 && tabs1 === 40 && r.tabs === 40, `2. 탭 줄 가로 위치도 그대로 (${tabs0} → 다시 그림 ${tabs1} → 열고 닫음 ${r.tabs})`);
    ok(r.body === 180, `2. 본문 위치도 그대로 (${r.body})`);

    // 4. v0.6.68: the chosen tab scrolled out of view stays there on redraws and resizes; it is brought into
    // view only when the tab changes (also when that happened while the bar was hidden).
    const inView = () => ev(() => { const a = document.querySelector('#sp_overlay .sp-tabs .sp-active').getBoundingClientRect(), b = document.querySelector('#sp_overlay .sp-tabs').getBoundingClientRect(); return a.left >= b.left - 1 && a.right <= b.right + 1; });
    const far = await ev(() => { const t = document.querySelector('#sp_overlay .sp-tabs'); t.scrollLeft = t.scrollWidth; return Math.round(t.scrollLeft); });
    ok(far > 40 && !(await inView()), `4. 준비: 고른 탭(저널)이 화면 밖 (${far})`);
    await ev(() => __savePoint.render(true));
    await wait(700);                                             // past the redraw ~0.5 s after opening, and resize callbacks
    r = await where();
    ok(r.tabs === far, `4. ★ 다시 그려도 보던 위치 그대로 (${r.tabs}, 기대 ${far})`);
    await page.setViewportSize({ width: 380, height: 844 }); await wait(200);
    await page.setViewportSize({ width: 390, height: 844 }); await wait(200);
    const afterResize = (await where()).tabs;
    ok(Math.abs(afterResize - far) <= 12 && !(await inView()), `4. ★ 창 크기가 바뀌어도 고른 탭 쪽으로 끌려가지 않음 (${afterResize})`);
    await ev(() => { __savePoint.ui.tab = 'main'; __savePoint.ui.edit = null; __savePoint.render(true); });
    await wait(150);
    ok(await inView(), `4. 탭을 바꾸면 고른 탭이 보이게 이동 (${(await where()).tabs})`);
    await ev(() => { const t = document.querySelector('#sp_overlay .sp-tabs'); t.scrollLeft = t.scrollWidth; });
    await ev(() => __savePoint.handle('qs'));
    await ev(() => { __savePoint.ui.tab = 'journal'; __savePoint.render(true); });  // changed while the bar is hidden
    await ev(() => __savePoint.handle('qs'));
    await wait(200);
    ok(await inView(), `4. 빠른 설정이 열린 동안 바꾼 탭도 닫으면 보임 (${(await where()).tabs})`);

    // 3. PC: the panel sits on top; nothing is hidden and nothing moves.
    const pc = await session({ width: 1100, settings: { savePoint: { firstTab: 'journal', check: false, askResume: false, hudOpen: true } } });
    await pc.evaluate(() => { M.add(40, i => i % 3 === 0 ? `SCENEBREAK ${i} ${'a long line of words '.repeat(12)}` : ''); return __savePoint.handle('run'); });
    await pc.waitForTimeout(1500);
    await pc.evaluate(() => $('#sp_wand').trigger('click'));
    await pc.waitForTimeout(200);
    await pc.evaluate(() => { document.querySelector('#sp_overlay .sp-body').scrollTop = 150; });
    await pc.evaluate(() => __savePoint.handle('qs'));
    const open = await pc.evaluate(() => ({ body: Math.round(document.querySelector('#sp_overlay .sp-body').scrollTop), shown: !!document.querySelector('#sp_overlay .sp-body').getClientRects().length }));
    await pc.evaluate(() => __savePoint.handle('qs'));
    const closed = await pc.evaluate(() => Math.round(document.querySelector('#sp_overlay .sp-body').scrollTop));
    ok(open.shown && open.body === 150 && closed === 150, `3. PC는 본문이 보이는 채로, 위치 그대로 (${JSON.stringify(open)}, ${closed})`);

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
