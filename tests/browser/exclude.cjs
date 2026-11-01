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
    const page = await session();
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(() => { M.settings.savePoint.check = false; M.settings.savePoint.hudOpen = true; $('#sp_wand').trigger('click'); });

    // 1. marked parts never reach the summarizer; the chat keeps them
    await ev(() => {
        const ta = document.querySelector('#sp_settings [data-set=excludeMarks]'); ta.value = 'Inner_Info\n[속마음] ~ [/속마음]'; $(ta).trigger('input');
        M.add(6, i => i === 1 ? 'Ari waves from the bridge. <Inner_Info><small>💭 Ari: ZETA-THOUGHT</small></Inner_Info> She walks on.'
            : i === 3 ? 'Me: let us go. [속마음] OMEGA-THOUGHT [/속마음] Fine.'
            : i === 4 ? '<inner_info class="x">💭 Ari: ONLY-THOUGHT</inner_info>'
            : i === 5 ? 'Half [속마음] KEPT-UNCLOSED' : '');
    });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    let r = await ev(() => { const p = M.calls.filter(c => !c.startsWith('You are checking')).pop(); return { p, chat: M.chat.map(m => m.mes).join('\n'), last: __savePoint.state().lastIndex }; });
    ok(r.last === 5 && !/ZETA|OMEGA|ONLY-THOUGHT/.test(r.p) && r.p.includes('Ari waves from the bridge.') && r.p.includes('She walks on.') && r.p.includes('Fine.'), '1. 태그 블록·시작~끝 구간은 요약 요청에서 빠지고 앞뒤 본문은 남음');
    ok(r.p.includes('#4 Ari: (only excluded content)') && r.p.includes('KEPT-UNCLOSED'), '1. 뺄 부분만 있는 메시지는 표시만 남기고, 끝 표시가 없으면 자르지 않음');
    ok(/ZETA-THOUGHT/.test(r.chat) && /OMEGA-THOUGHT/.test(r.chat), '1. 채팅 원문은 그대로');
    r = await ev(() => ({ summary: document.querySelector('[data-settings-summary=recording]')?.textContent || '', skin: [...document.querySelectorAll('#sp_settings label')].some(l => l.textContent.trim().startsWith('스킨')), st: [...document.querySelectorAll('[data-set=theme] option')].find(o => o.value === 'st')?.textContent }));
    ok(r.summary.includes('뺄 부분 2개') && r.skin && r.st === '실리태번 테마 따라가기', `1. 설정 요약에 뺄 부분 수, "스킨" 이름 (${r.summary})`);

    // 2. the recording-process rule rides in the fixed format, so an edited guide still gets it
    ok(r && (await ev(() => M.calls.at(-1))).includes('never describe the recording process'), '2. 구간이 도중에 끝날 때의 말투 규칙이 요청에 포함');

    // 3. how much original text one request carries is a setting
    await ev(() => { M.settings.savePoint.sourceChars = 2000; M.add(12, i => `Long message ${i} ` + 'with plenty of words '.repeat(25)); });
    const c0 = await ev(() => M.calls.length);
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    const small = await ev(c0 => M.calls.slice(c0).filter(c => !c.startsWith('You are checking')).length, c0);
    await ev(() => { M.settings.savePoint.sourceChars = 12000; M.add(12, i => `Long message ${i} ` + 'with plenty of words '.repeat(25)); });
    const c1 = await ev(() => M.calls.length);
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    const big = await ev(c1 => M.calls.slice(c1).filter(c => !c.startsWith('You are checking')).length, c1);
    ok(small > big && big === 1, `3. 원문 분량 설정이 요청 수를 바꿈 (2,000자: ${small}번 / 12,000자: ${big}번)`);

    // 4. a request that came back but whose save failed is not called a failed request
    await ev(() => { M.add(3); M.failMeta = true; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(800);
    r = await ev(() => __savePoint.reportText(__savePoint.state()));
    ok(r.includes('이 구간의 요청 기록 (요청은 성공 · 이후 단계에서 실패)') && !r.includes('실패한 요청의 기록'), '4. 저장 단계 실패에는 "요청은 성공" 제목');
    await ev(() => { M.failMeta = false; });

    // 5. 중지 is readable in the two themes that paint every action button
    await ev(() => { M.add(4); M.delay = 5000; });
    const p5 = ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(500);
    r = await ev(() => ['consolenight', 'cranelemon'].map(t => { const w = document.querySelector('#sp_overlay .sp-window'); w.setAttribute('data-theme', t);
        const s = getComputedStyle(w.querySelector('[data-act=stop]')); return [t, s.color, s.backgroundColor, s.backgroundImage.slice(0, 30)]; }));
    ok(r[0][1] === 'rgb(122, 31, 51)' && r[0][3].startsWith('linear-gradient') && r[1][1] === 'rgb(255, 255, 255)' && r[1][2] === 'rgb(239, 91, 91)', `5. 스토리 콘솔·레몬 인형뽑기 중지 버튼 색 (${r.map(x => x.slice(1, 3).join('/')).join(' · ')})`);
    await p5; await ev(() => { M.delay = 0; });

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
