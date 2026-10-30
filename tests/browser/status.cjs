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
    const srv = await serve(), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.goto(`http://localhost:${srv.address().port}/`); await page.waitForFunction(() => !!globalThis.__savePoint);
    const ev = (fn, arg) => page.evaluate(fn, arg), run = () => ev(() => __savePoint.autoCollect());
    const banner = () => ev(() => { const b = document.getElementById('sp_save_banner'); return b ? { shown: !b.hidden, text: b.textContent, tone: b.dataset.tone, top: b.style.top } : { shown: false }; });
    await ev(() => { M.settings.savePoint.check = false; M.add(21); });

    // 1. the status panel folds on phones; the status line stands for the details
    await ev(() => document.querySelector('#sp_open').click());
    let r = await ev(() => ({ folded: !!document.querySelector('.sp-hud.sp-hud-folded'), chip: $('.sp-hud-chip').text(), more: getComputedStyle(document.querySelector('.sp-hud-more')).display, h: document.querySelector('.sp-hud').offsetHeight }));
    ok(r.folded && r.more === 'none' && r.chip.includes('미기록'), `1. 휴대폰 폭에서 상태 상세가 접히고 요약 줄 표시 (${r.chip.trim()})`);
    await page.click('.sp-hud-chip');
    r = await ev(() => ({ open: !!document.querySelector('.sp-hud.sp-hud-open'), saved: M.settings.savePoint.hudOpen, more: getComputedStyle(document.querySelector('.sp-hud-more')).display }));
    ok(r.open && r.saved === true && r.more !== 'none', '1. 요약 줄을 누르면 펼쳐지고 선택을 기억');
    await page.click('.sp-hud-chip');
    await ev(() => document.querySelector('[data-act=close]').click());

    // 2. a failed checkpoint: original range kept, remaining range shown, request breakdown recorded
    await ev(() => { M.throwNext = new Error('Load failed'); });
    await run();
    r = await ev(() => ({ f: __savePoint.state().autoFail, report: __savePoint.reportText(__savePoint.state()) }));
    const sizes = (r.report.match(/입력 내역: ([^\n]+)/) || [])[1] || '';
    const total = Number(((r.report.match(/입력 ([\d,]+)자 \(확장이 만든 요청 기준\)/) || [])[1] || '0').replace(/,/g, ''));
    const sum = [...sizes.matchAll(/([\d,]+)(?= ·|$)/g)].reduce((a, m) => a + Number(m[1].replace(/,/g, '')), 0);
    ok(sizes.includes('지침·출력 형식') && sizes.includes('새 원문') && total > 0 && sum === total, `2. 결과 복사에 요청 분량 내역, 합계 = 전체 입력 (${sum}/${total})`);
    ok(r.report.includes('첫 본문 수신 없음') && r.report.includes('첫 사고 수신'), '2. 첫 사고·첫 본문 수신을 따로 기록, 본문이 없으면 없음');
    ok(r.report.includes('실패한 요청: #0–') && r.report.includes('현재 재시도가 필요한 범위: #0–'), '2. 실패한 요청과 현재 남은 범위를 따로 표시');
    // 3. the failure banner stays until tapped, then opens the details
    r = await banner();
    ok(r.shown && r.tone === 'warning' && r.text.includes('눌러서 자세히 보기'), '3. 실패 배너 표시와 누르기 안내');
    await page.waitForTimeout(9000);
    ok((await banner()).shown, '3. 실패 배너는 시간이 지나도 남아 있음');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'status-banner-fail.png') });
    await page.click('#sp_save_banner');
    r = await ev(() => ({ open: __savePoint.ui.open, hud: !!document.querySelector('.sp-hud.sp-hud-open'), details: document.querySelector('[data-group=hud-autofail]')?.open, chip: document.querySelector('.sp-hud-chip')?.className, b: !document.getElementById('sp_save_banner').hidden }));
    ok(r.open && r.hud && r.details && !r.b && r.chip.includes('sp-alerting'), '3. 누르면 창이 열리고 실패 상세가 펼쳐지며 배너는 닫힘, 요약 줄은 경고색');
    ok(await ev(() => $('.sp-hud-chip').text().includes('실패 1')), '3. 같은 실패를 두 번 세지 않음');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'status-open-fail.png') });
    await ev(() => document.querySelector('[data-act=close]').click());

    // 4. a part saved later: the old record keeps its numbers, the remaining range moves
    await ev(() => { M.add(20); });
    await ev(() => { M.throwNext = null; });
    // force a partial: save only the first batch, then fail
    await ev(() => { M.settings.savePoint.inputChars = 20000; M.failSecond = true; M.partialSeen = 0;
        const get = SillyTavern.getContext; SillyTavern.getContext = () => { const c = get(); return { ...c, generateRaw: async args => {
            const raw = await c.generateRaw(args); if (M.failSecond && ++M.partialSeen === 2) throw new Error('Second batch failed'); return raw; } }; };
        M.add(30, i => 'Message ' + i + ' ' + 'long words '.repeat(120)); });
    await ev(() => __savePoint.summarize());
    r = await ev(() => ({ f: __savePoint.state().autoFail, last: __savePoint.state().lastIndex, report: __savePoint.reportText(__savePoint.state()) }));
    ok(r.f && r.f.from === 0 && r.report.includes(`현재 재시도가 필요한 범위: #${r.last + 1}–`), `4. 예전 실패 번호는 그대로, 남은 범위만 갱신 (#${r.f?.from} / 남은 #${r.last + 1})`);
    await ev(() => { M.failSecond = false; M.settings.savePoint.inputChars = 60000; });

    // 5. a result while the page is hidden waits until it is visible again
    await ev(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); M.add(2); });
    await ev(() => __savePoint.summarize());
    r = await banner();
    ok(!r.shown || r.tone === 'running', '5. 화면이 꺼져 있는 동안 끝난 결과는 바로 띄우지 않음');
    await ev(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    r = await banner();
    ok(r.shown && /저장 완료/.test(r.text), `5. 화면이 다시 보이면 결과 배너 표시 (${r.text?.trim().slice(0, 20)})`);

    // 6. the on-screen keyboard: the banner follows the visible part of the page
    await ev(() => { Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, get: () => 320 }); window.visualViewport.dispatchEvent(new Event('scroll')); });
    r = await banner();
    ok(r.top === '328px', `6. 키보드로 화면이 밀리면 보이는 영역 맨 위로 (${r.top})`);
    await ev(() => { Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, get: () => 0 }); window.visualViewport.dispatchEvent(new Event('scroll')); });
    ok((await banner()).top === '', '6. 키보드가 내려가면 원래 위치');

    // 7. wide screens start unfolded
    const wide = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await wide.goto(`http://localhost:${srv.address().port}/`); await wide.waitForFunction(() => !!globalThis.__savePoint);
    await wide.evaluate(() => { M.add(3); document.querySelector('#sp_open').click(); });
    ok(await wide.evaluate(() => !!document.querySelector('.sp-hud.sp-hud-open')), '7. 넓은 화면은 처음부터 펼침');
    await browser.close(); srv.close();
    console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
