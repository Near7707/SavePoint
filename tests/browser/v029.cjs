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
        // These checks read the status details, which a phone-width window folds by default.
        await page.evaluate(() => { M.settings.savePoint.hudOpen = true; });
        await page.waitForTimeout(300);
        return page;
    }
    const files = page => page.evaluate(() => Object.fromEntries(M.files));
    const settingsOf = page => page.evaluate(() => JSON.parse(JSON.stringify(M.settings)));
    const page = await session();
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(() => { M.add(6); M.settings.savePoint.check = false; $('#sp_wand').trigger('click'); });

    // 1. the real error inside "API request failed" is shown, with the status code
    await ev(() => { const inner = Object.assign(new Error('Request too large for model context'), { status: 413 }); M.throwNext = new Error('API request failed', { cause: inner }); });
    await ev(() => __savePoint.handle('run'));
    let r = await ev(() => ({ err: $('.sp-err li').map((i, e) => e.textContent).get(), toast: toastr.log.map(x => x[1]).pop() }));
    ok(r.err[0].includes('API request failed ← Request too large for model context (상태 413)'), `1. 원래 오류와 상태 코드 표시 (${r.err[0]})`);
    ok(r.toast.includes('Request too large'), '1. 알림에도 원래 오류 표시');

    // 2. the failure kind is what actually happened (here: unreadable JSON, not "검사 실패")
    await ev(() => { M.badJson = true; });
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => $('.sp-err li').map((i, e) => e.textContent).get());
    ok(/^첫 요청: .*JSON 해석 실패$/.test(r[0]) && /^재요청: .*JSON 해석 실패$/.test(r[1]), `2. 실패 종류를 그대로 표시 (${r.slice(0, 2).join(' | ')})`);
    await ev(() => { M.badJson = false; });

    // 3. findings are held back when the model cites evidence it was not given; each case is matched by its own problem text
    await ev(() => {
        M.settings.savePoint.check = true;
        const base = M.chat.length;
        M.add(4, i => (i === base ? 'SCENEBREAK The last tile slid into place and the board lit up 5-2 for the home side. ' + 'The tiles clatter across the hall again and again. '.repeat(40) + 'The rule: first to five, the loser sweeps the hall.' : ''));
        M.checkReply = prompt => {
            const ids = [...prompt.split('[JOURNAL]')[1].matchAll(/^(g\d+\.\d+): (.*)$/gm)];
            const first = ids.find(m => m[2].includes(`at ${base}.`))?.[1];
            return { issues: [
                { about: first, kind: 'misread', basis: 'unsupported', problem: 'CASE-A cites a message not in this request.', conflict: ['x', 'no stakes before play'], msgs: [base + 400] },
                { about: first, kind: 'misread', basis: 'contradicted', problem: 'CASE-B fake quote.', conflict: ['x', 'Loser buys everyone dinner forever'], msgs: [base] },
                { about: first, kind: 'misread', basis: 'contradicted', problem: 'CASE-C real quote with the speaker name.', conflict: ['x', 'Ari: "the board lit up 5-2 for the home side"'], msgs: [base] },
            ] };
        };
    });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    r = await ev(() => ({ issues: __savePoint.state().check?.issues || [], hud: $('.sp-checks').text(), cov: __savePoint.state().check?.coverage }));
    const byCase = k => r.issues.find(x => String(x.problem || '').startsWith(k));
    const a = byCase('CASE-A'), b = byCase('CASE-B'), c = byCase('CASE-C');
    ok(a && a.kind === 'partial' && a.was === undefined && a.gaps?.some(g => g.how === '이 검토 요청에 없는 근거 번호'), '3. 이 요청에 보내지 않은 근거 번호를 들면 판단 보류');
    ok(b && b.kind === 'partial' && b.was === 'misread' && b.gaps?.some(g => g.label === '인용 확인 실패'), '3. 반대 문장이라며 든 인용이 보낸 원문에 없으면 판단 보류');
    ok(c && c.kind === 'misread' && !c.gaps, '3. 보낸 원문에 실제로 있는 반대 문장이면 (말한 사람 이름이 붙어도) 경고 유지');
    ok(r.hud.includes('판단 보류 이유:') && r.hud.includes('인용 확인 실패') && r.hud.includes('AI 원래 판단: 원문과 다름'), '3. 판단 보류 이유를 화면에 표시');
    ok(r.cov && r.cov.sent >= 1, `3. 보낸 원문 범위 기록 (보냄 ${r.cov?.sent})`);
    await ev(() => { M.checkReply = null; });

    // 4. one button copies everything as text
    r = await ev(() => __savePoint.reportText(__savePoint.state()));
    ok(/SavePoint v\d+\.\d+\.\d+/.test(r) && r.includes('[기록 확인]') && r.includes('보낸 원문') && r.includes('대상: ') && r.includes('판단 보류 이유: ') && r.includes('인용: "') && r.includes('근거 번호: #'), '4. 복사 내용: 버전·확인 결과·대상 문장·보류 이유·인용·근거 번호');
    await ev(() => { __savePoint.ui.lastError = { at: Date.now(), range: '#0–#5', detail: ['첫 요청: 21초 · 요청 오류: API request failed ← boom (상태 502)'] }; __savePoint.render(true); });
    ok((await ev(() => __savePoint.reportText(__savePoint.state()))).includes('[마지막 실패] #0–#5') , '4. 마지막 실패도 함께 복사');
    await page.click('[data-act="copy-report"]');
    await page.waitForTimeout(300);
    r = await ev(() => ({ toast: toastr.log.map(x => x[1]).pop(), box: $('.sp-copybox textarea').val() || '' }));
    ok(r.toast.includes('복사했어요') || (r.toast.includes('아래 칸') && r.box.includes('[기록 확인]')), `4. 복사 버튼 동작 (${r.toast.slice(0, 20)})`);
    if (SHOTS) { await page.evaluate(() => { __savePoint.ui.savesOpen.set('hud-checks', true); __savePoint.render(true); }); await page.screenshot({ path: path.join(OUT, 'v029.png') }); }

    // 5. a later scene marked "continue" is merged into the one before it, and the fix is shown
    await ev(() => { __savePoint.ui.lastError = null; M.settings.savePoint.check = false; M.laterContinue = true; const b5 = M.chat.length; M.add(4, i => (i === b5 + 2 ? 'SCENEBREAK next part' : '')); });
    const before5 = await ev(() => __savePoint.state().mem.scenes.length);
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => ({ n: __savePoint.state().mem.scenes.length, last: __savePoint.state().lastIndex, len: M.chat.length, hud: $('.sp-hud').text(), rep: __savePoint.reportText(__savePoint.state()) }));
    ok(r.last === r.len - 1 && r.n === before5, `5. 뒤 장면의 continue는 앞 장면에 합쳐서 저장 (장면 수 ${before5} → ${r.n})`);
    ok(r.hud.includes('자동 보정') && r.hud.includes('앞 장면에 합쳤어요') && r.rep.includes('[자동 보정]'), '5. 합친 사실을 상태 바와 결과 복사에 표시');
    await ev(() => { M.laterContinue = false; });

    // 6. pressing ●/○ keeps the scene's point list (and notes) open
    await ev(() => { __savePoint.handle('tab', 'journal'); });
    await page.click('.sp-scene .sp-more > summary');
    await page.click('.sp-scene .sp-notes > summary');
    const keyBtn = '.sp-scene .sp-more [data-act="key-toggle"]';
    const before6 = await ev(sel => document.querySelector(sel).textContent, keyBtn);
    await page.click(keyBtn);
    await page.waitForTimeout(200);
    r = await ev(sel => ({ more: document.querySelector('.sp-scene .sp-more').open, notes: document.querySelector('.sp-scene .sp-notes').open, key: document.querySelector(sel).textContent }), keyBtn);
    ok(r.more && r.notes && r.key !== before6, `6. ●/○를 눌러도 펼친 목록·노트가 접히지 않음 (${before6} → ${r.key})`);
    await page.click('.sp-scene .sp-more > summary');
    await page.waitForTimeout(100);   // the browser reports the toggle a moment later
    await ev(() => __savePoint.render(true));
    ok(!(await ev(() => document.querySelector('.sp-scene .sp-more').open)), '6. 직접 접은 건 접힌 채로 유지');

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
