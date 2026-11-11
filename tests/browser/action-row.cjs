// v0.6.98: the action row (퀵세이브 · 리와인드 · 👻 하이드 · 번역) keeps every button's size and place
// when a save starts (중지 takes 퀵세이브's place and size), in every skin, on PC and phone widths,
// with and without the 👻 button, and no label is cut.
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

(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    for (const width of [1100, 390, 360]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.goto(URL);
        await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
        await page.waitForTimeout(300);
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await ev(() => { M.settings.savePoint.check = false; M.settings.savePoint.hudOpen = false; M.settings.savePoint.hideMode = 'manual'; M.add(30); return __savePoint.handle('run'); });
        await page.waitForTimeout(900);
        await ev(() => { M.add(6); $('#sp_wand').trigger('click'); });
        await page.waitForTimeout(300);
        const themes = await ev(() => [...document.querySelectorAll('#sp_settings [data-set=theme] option')].map(o => o.value));
        // Each button's box (the 번역 wrapper stands for its button), whether its label is cut, and
        // whether the row stays on one line.
        const measure = () => ev(() => {
            const items = [...document.querySelectorAll('#sp_overlay .sp-actions > *')];
            return items.map(e => {
                const b = e.getBoundingClientRect(), bt = e.matches('.sp-btn') ? e : e.querySelector('.sp-btn');
                return { act: e.dataset.act || 'lang', x: Math.round(b.left), w: Math.round(b.width), top: Math.round(b.top), cut: bt.scrollWidth > bt.clientWidth + 1 };
            });
        });
        const set = (theme, busy, hideMode) => ev(([t, b, h]) => {
            M.settings.savePoint.theme = t; M.settings.savePoint.hideMode = h;
            const ui = __savePoint.ui; ui.run = b ? { cancelled: false } : null; ui.progress = b ? '구간 2/3 기록 중…' : '';
            __savePoint.render(true);
            // the widest count the 👻 button ever shows
            const n = document.querySelector('#sp_overlay .sp-actions .sp-hide-n'); if (n) n.textContent = '999+';
        }, [theme, busy, hideMode]);
        const bad = { size: [], cut: [], line: [], stop: [] };
        for (const theme of themes) for (const hideMode of ['manual', 'auto']) {
            await set(theme, false, hideMode); const idle = await measure();
            await set(theme, true, hideMode); const busy = await measure();
            const tag = `${theme}/${hideMode}`;
            if (idle.length !== busy.length || idle.length !== (hideMode === 'manual' ? 4 : 3)) { bad.size.push(`${tag}:count`); continue; }
            if (idle.some((a, i) => Math.abs(a.x - busy[i].x) > 1 || Math.abs(a.w - busy[i].w) > 1)) bad.size.push(tag);
            if (idle[0].act !== 'run' || busy[0].act !== 'stop') bad.stop.push(tag);
            if ([...idle, ...busy].some(x => x.cut)) bad.cut.push(tag);
            if ([...idle, ...busy].some(x => Math.abs(x.top - idle[0].top) > 1)) bad.line.push(tag);
        }
        await ev(() => { __savePoint.ui.run = null; __savePoint.ui.progress = ''; });
        ok(!bad.stop.length, `${width}px 중지가 퀵세이브 자리에 (${bad.stop.join(',') || `${themes.length}개 스킨`})`);
        ok(!bad.size.length, `${width}px ★ 저장을 시작해도 버튼 크기·자리가 그대로 — 👻 있을 때·없을 때 (${bad.size.join(',') || 'ok'})`);
        ok(!bad.cut.length, `${width}px 잘린 글자 없음, 👻 999+ 포함 (${bad.cut.join(',') || 'ok'})`);
        ok(!bad.line.length, `${width}px 한 줄 (${bad.line.join(',') || 'ok'})`);
        await page.close();
    }
    await browser.close(); srv.close();
    console.log(failures ? `${failures} FAILED` : 'ALL PASS');
    process.exit(failures ? 1 : 0);
})();
