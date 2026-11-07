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

// v0.6.73: the 🧿 주입 tab opened only after the "needed limit" figures were worked out (the injection built
// again 15–20 times, twice) and nothing on screen answered meanwhile. Now the tab shows at once, the figures
// follow in small pieces, and they are kept while memory and settings stay the same.
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, askResume: false, budget: 300, hideMode: 'off' } }; });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
    await page.waitForTimeout(300);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    await ev(() => { M.add(40, i => i % 3 === 0 ? `SCENEBREAK ${i} ${'a long line of words '.repeat(12)}` : ''); return __savePoint.handle('run'); });
    await wait(1500);
    await ev(() => $('#sp_wand').trigger('click'));
    await wait(200);
    const body = () => document.querySelector('#sp_overlay .sp-body')?.innerHTML || '';
    // 1. the tab is drawn at once with a "working it out" line, then the figures come
    let r = await ev(src => { __savePoint.handle('tab', 'inject'); const h = (new Function(`return (${src})()`))(); return { wait: h.includes('계산하고 있어요'), need: h.includes('필요해요'), tab: __savePoint.ui.tab }; }, body.toString());
    ok(r.tab === 'inject' && r.wait && !r.need, `1. 주입 탭이 바로 열리고 '계산하고 있어요'가 보임 (${JSON.stringify(r)})`);
    await page.waitForFunction(src => { const h = (new Function(`return (${src})()`))(); return !h.includes('계산하고 있어요') && /필요해요|늘려도/.test(h); }, body.toString(), { timeout: 8000 }).catch(() => {});
    r = await ev(src => { const h = (new Function(`return (${src})()`))(); return { wait: h.includes('계산하고 있어요'), need: /필요해요|늘려도/.test(h), n: __savePoint.ui.injNeed }; }, body.toString());
    ok(!r.wait && r.need, `1. 계산이 끝나면 필요한 상한이 보임 (${JSON.stringify(r)})`);
    // 2. leaving and coming back: the figures are kept (nothing to work out again)
    r = await ev(src => { __savePoint.handle('tab', 'journal'); __savePoint.handle('tab', 'inject'); const h = (new Function(`return (${src})()`))(); return { wait: h.includes('계산하고 있어요'), need: /필요해요|늘려도/.test(h) }; }, body.toString());
    ok(!r.wait && r.need, `2. 기억·설정이 그대로면 다시 열 때 계산하지 않음 (${JSON.stringify(r)})`);
    // 3. memory changed: worked out again; leaving the tab meanwhile stops it, other tabs answer at once
    r = await ev(src => { __savePoint.state().rev = (__savePoint.state().rev || 0) + 1; __savePoint.handle('tab', 'inject'); const a = (new Function(`return (${src})()`))().includes('계산하고 있어요');
        const t0 = performance.now(); __savePoint.handle('tab', 'journal'); return { a, ms: performance.now() - t0, tab: __savePoint.ui.tab }; }, body.toString());
    await wait(600);
    const after = await ev(() => ({ n: __savePoint.ui.injNeed, p: __savePoint.ui.injNeedPoints }));
    ok(r.a && r.tab === 'journal' && after.n === undefined && after.p === undefined, `3. 기억이 바뀌면 다시 계산, 탭을 떠나면 계산을 멈춤 (${JSON.stringify({ ...r, ...after })})`);
    await ev(() => __savePoint.handle('tab', 'inject'));
    await page.waitForFunction(src => /필요해요|늘려도/.test((new Function(`return (${src})()`))()), body.toString(), { timeout: 8000 }).catch(() => {});
    ok(await ev(src => /필요해요|늘려도/.test((new Function(`return (${src})()`))()), body.toString()), '3. 다시 열면 이어서 계산해서 보여 줌');
    // 4. the figures match the one-shot calculation
    r = await ev(async () => { const core = await import('/ext/core.js'); const st = __savePoint.state(); const o = __savePoint.ui.injOpts;
        return { ui: [__savePoint.ui.injNeed, __savePoint.ui.injNeedPoints], direct: [core.neededBudget(st.mem, o), __savePoint.ui.injNeedPoints === undefined ? undefined : core.neededBudget(st.mem, o, 100000, { points: true })] }; });
    ok(JSON.stringify(r.ui) === JSON.stringify(r.direct), `4. 나눠서 계산한 값이 한 번에 계산한 값과 같음 (${JSON.stringify(r)})`);
    // 5. v0.6.79 (review P3): working it out, then a room with no memory opens on the same tab: the old room's
    //    calculation stops (its figures never land in the new room).
    await ev(() => { __savePoint.handle('tab', 'journal'); __savePoint.state().rev = (__savePoint.state().rev || 0) + 1; __savePoint.handle('tab', 'inject'); });
    r = await ev(src => (new Function(`return (${src})()`))().includes('계산하고 있어요'), body.toString());
    await ev(() => M.switchChat('chatEmpty', [{ name: 'Ari', is_user: false, is_system: false, mes: 'Hello there', swipe_id: 0, extra: {} }], {}));
    await ev(() => __savePoint.handle('tab', 'inject'));
    await wait(1500);
    const empty = await ev(() => ({ key: __savePoint.ui.injNeedKey ?? null, n: __savePoint.ui.injNeed, p: __savePoint.ui.injNeedPoints, tab: __savePoint.ui.tab, mem: !!__savePoint.state()?.mem?.scenes?.length }));
    ok(r && empty.tab === 'inject' && !empty.mem && empty.key === null && empty.n === undefined && empty.p === undefined, `5. 기억 없는 방으로 옮기면 이전 방 계산이 멈춤 (${JSON.stringify({ r, ...empty, key: empty.key && 'old' })})`);
    await browser.close(); srv.close();
    console.log(failures ? failures + ' FAILED' : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
