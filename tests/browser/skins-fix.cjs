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
    // Open a fresh page (a new SillyTavern session) with optional preset settings / server files.
    async function session({ settings, files, serverDown, width = 390 } = {}) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.addInitScript(([s, f, d]) => { if (s) window.__presetSettings = s; if (f) window.__presetFiles = f; if (d) window.__presetServerDown = true; }, [settings || null, files || null, !!serverDown]);
        await page.goto(URL);
        await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
        await page.waitForTimeout(300);
        return page;
    }
    const files = page => page.evaluate(() => Object.fromEntries(M.files));
    // SillyTavern styles every checkbox like this; SavePoint's own must still show the tick.
    const stCheckbox = 'input[type="checkbox"] { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; background: #000; border: 1px solid #555; }';
    for (const width of [1100, 390]) {
        const page = await session({ width });
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await page.addStyleTag({ content: stCheckbox });
        await ev(() => { M.settings.savePoint.check = false; M.settings.savePoint.hudOpen = true; M.add(8); return __savePoint.handle('run'); });
        await page.waitForTimeout(900);
        await ev(() => { const st = __savePoint.state(); const sc = st.mem.scenes.at(-1); sc.title = 'A very long scene title that keeps going past the edge of the picture'; sc.where = 'Somewhere far along a long road, then a car, ending at a parking lot by the sea'; $('#sp_wand').trigger('click'); });

        // 1. quick settings: the checkbox ticks show; the hide mode is there and works
        await ev(() => __savePoint.handle('qs'));
        let r = await ev(() => { const c = document.querySelector('#sp_overlay [data-qs="auto"]'); return { app: getComputedStyle(c).appearance, checked: c.checked, hide: !!document.querySelector('#sp_overlay [data-qs="hideMode"]'), keep: !!document.querySelector('#sp_overlay [data-qs="keepRecent"]') }; });
        ok(r.app !== 'none' && r.checked && r.hide && r.keep, `${width}px 1. 빠른 설정: 체크 표시가 보이는 체크박스, 하이드 방식·최근 N개 (${JSON.stringify(r)})`);
        await ev(() => { const sel = document.querySelector('#sp_overlay [data-qs="hideMode"]'); sel.value = 'manual'; $(sel).trigger('change'); });
        r = await ev(() => ({ mode: M.settings.savePoint.hideMode, at: M.settings.savePoint.hideManualAt > 0, full: document.querySelector('#sp_settings [data-set=hideMode]').value }));
        ok(r.mode === 'manual' && r.at && r.full === 'manual', `${width}px 1. 빠른 설정에서 수동으로 → 전체 설정과 같음 (${JSON.stringify(r)})`);
        await ev(() => { const sel = document.querySelector('#sp_overlay [data-qs="hideMode"]'); sel.value = 'off'; $(sel).trigger('change'); });
        ok(await ev(() => !document.querySelector('#sp_overlay [data-qs="keepRecent"]') && M.chat.every(m => !m.is_system)), `${width}px 1. 끔 → 최근 N개 칸 숨김, 숨긴 원문 다시 표시`);
        // v0.6.57: with "더 보기" open the panel keeps a capped height and scrolls inside; the window under it stays usable.
        await ev(() => { const sel = document.querySelector('#sp_overlay [data-qs="hideMode"]'); sel.value = 'manual'; $(sel).trigger('change'); });
        await page.waitForTimeout(150);
        if (!(await ev(() => document.querySelector('#sp_overlay .sp-qs details').open))) await page.click('#sp_overlay .sp-qs details > summary');
        await page.waitForTimeout(150);
        r = await ev(() => { const q = document.querySelector('#sp_overlay .sp-qs'), w = document.querySelector('#sp_overlay .sp-window'), b = w.querySelector('.sp-body');
            return { qh: q.clientHeight, sh: q.scrollHeight, wh: w.clientHeight, vh: innerHeight, body: b.getBoundingClientRect().height, head: getComputedStyle(q.querySelector('.sp-qs-h')).position }; });
        // v0.6.63: on a phone the panel covers the whole window below the top bar instead (the rest comes back on ✕).
        const over = r.sh > r.qh;
        ok((width > 560 ? r.qh <= r.vh * 0.72 && over : r.qh >= r.wh * 0.85 && r.body === 0) && r.head === 'sticky',
            `${width}px 1. ★ 빠른 설정: PC는 높이 제한·안에서 스크롤, 폰은 창 전체를 덮음 (${JSON.stringify(r)})`);
        const qbox = await page.locator('#sp_overlay .sp-qs').boundingBox();
        await page.mouse.move(qbox.x + 12, qbox.y + qbox.height / 2); await page.mouse.wheel(0, 600); await page.waitForTimeout(300);
        await ev(() => __savePoint.render(true));
        r = await ev(() => { const q = document.querySelector('#sp_overlay .sp-qs'); const h = q.querySelector('.sp-qs-h').getBoundingClientRect(), qb = q.getBoundingClientRect(); return { top: q.scrollTop, headIn: h.top >= qb.top - 1 && h.bottom <= qb.bottom }; });
        ok((r.top > 50 || (width <= 560 && !over)) && r.headIn, `${width}px 1. ★ 빠른 설정이 넘치면 스크롤되고(다시 그려도 그대로) ✕ 줄은 위에 남음 (${JSON.stringify(r)})`);
        if (SHOTS) await page.screenshot({ path: path.join(OUT, `qs-${width}.png`) });
        await ev(() => __savePoint.handle('qs'));
        r = await ev(() => { const w = document.querySelector('#sp_overlay .sp-window'); return { qs: !!w.querySelector('.sp-qs'), body: w.querySelector('.sp-body').getBoundingClientRect().height, hud: !!w.querySelector('.sp-hud')?.getClientRects().length }; });
        ok(!r.qs && r.body > 60 && r.hud, `${width}px 1. 빠른 설정을 닫으면 원래 창이 그대로 돌아옴 (${JSON.stringify(r)})`);

        // 2. 스토리 콘솔: the scene title takes at most two lines over the picture (wide screens)
        r = await ev(() => { const w = document.querySelector('#sp_overlay .sp-window'); w.setAttribute('data-theme', 'consolenight'); const el = w.querySelector('.sp-scene-now'); const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
            return { lines: Math.round((el.clientHeight - parseFloat(getComputedStyle(el).paddingTop) - parseFloat(getComputedStyle(el).paddingBottom)) / lh), bar: w.querySelector('.sp-bar').getBoundingClientRect().top >= el.getBoundingClientRect().bottom }; });
        ok(r.lines <= 2 && r.bar, `${width}px 2. 스토리 콘솔 장면 제목 두 줄 이내, 진행 바와 겹치지 않음 (${JSON.stringify(r)})`);

        // 3. 레몬 인형뽑기: no tall empty band under the buttons; the machine does not cover them
        r = await ev(() => { const w = document.querySelector('#sp_overlay .sp-window'); w.setAttribute('data-theme', 'cranelemon'); const hud = w.querySelector('.sp-hud'), act = [...hud.querySelectorAll('.sp-actions .sp-btn')].at(-1).getBoundingClientRect(), box = hud.getBoundingClientRect();
            return { below: Math.round(box.bottom - act.bottom), room: Math.round(box.right - act.right), pad: getComputedStyle(hud).paddingBottom }; });
        if (SHOTS) for (const t of ['cranelemon', 'consolenight']) { await ev(t => { M.settings.savePoint.theme = t; __savePoint.render(true); }, t); await page.waitForTimeout(100); await page.locator('#sp_overlay .sp-hud').screenshot({ path: path.join(OUT, `hud-${t}-${width}.png`) }); }
        ok(r.below <= 24 && (width < 561 || r.room >= 120), `${width}px 3. 레몬 인형뽑기 상태창 아래 빈칸 없음, 버튼과 기계 안 겹침 (${JSON.stringify(r)})`);
        await page.close();
    }
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
