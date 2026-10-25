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
    const settingsOf = page => page.evaluate(() => JSON.parse(JSON.stringify(M.settings)));
    const page = await session();
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(() => { M.add(6); M.settings.savePoint.check = false; $('#sp_wand').trigger('click'); });

    // 1. time limit: the request is dropped, nothing saved, the details say what happened
    await ev(() => { M.settings.savePoint.timeoutSec = 5; M.delayOnce = 7000; });
    const p1 = ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(2300);
    let r = await ev(() => $('.sp-progress').text());
    ok(/첫 요청 · 응답 대기 [12]초/.test(r), `1. 진행 표시: 단계 · 응답 대기 경과 시간 (${r.trim()})`);
    await p1;
    r = await ev(() => ({ last: __savePoint.state()?.lastIndex ?? -1, err: $('.sp-err').text(), toast: toastr.log.map(x => x[1]).pop(), run: !!__savePoint.ui.run }));
    ok(r.last === -1 && !r.run, '1. 제한 시간이 지나면 취소, 아무것도 저장 안 함');
    ok(r.toast.includes('안에 오지 않았어요') && r.err.includes('제한 시간 초과로 취소'), `1. 실패 이유 표시 (${r.toast})`);

    // a new task runs while the old reply is still on its way; the late reply changes nothing
    await ev(() => __savePoint.handle('run'));
    const after = await ev(() => JSON.stringify({ mem: __savePoint.state().mem, last: __savePoint.state().lastIndex }));
    await ev(() => { M.delay = 4000; M.add(2); });
    const p2 = ev(() => __savePoint.handle('run-close'));
    await page.waitForFunction(() => M.lateDone === 1, null, { timeout: 8000 });
    r = await ev(() => ({ prog: $('.sp-progress').text(), err: $('.sp-err').length }));
    ok(/응답 대기|응답 받음/.test(r.prog) && r.err === 0, `1. [${r.prog.trim()}] 늦게 도착한 응답은 새 작업 진행 표시를 바꾸지 않음`);
    await p2;
    await ev(() => { M.delay = 0; });
    const now = await ev(() => JSON.stringify({ mem: __savePoint.state().mem, last: __savePoint.state().lastIndex }));
    ok(JSON.parse(after).last === 5 && JSON.parse(now).last === 7 && (await ev(() => __savePoint.state().mem.scenes.length)) === 1 && (await ev(() => __savePoint.state().mem.scenes[0].segs.length)) === 2, '1. 늦은 응답은 저장되지 않음 (장면 1개 그대로)');

    // 2. failure details list each attempt
    await ev(() => { M.settings.savePoint.timeoutSec = 300; M.add(4); M.failAt = M.chat.length - 2; });
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => $('.sp-err li').map((i, e) => e.textContent).get());
    ok(/^첫 요청: \d+초 · 응답 [\d,]+자 · 검사 실패 \d+건$/.test(r[0]) && /^재요청: .*검사 실패 \d+건$/.test(r[1]), `2. 시도마다 걸린 시간·응답 길이·결과 (${r.slice(0, 2).join(' | ')})`);
    await ev(() => { M.failAt = undefined; });
    await ev(() => __savePoint.handle('run'));

    // 3. terms: shown in the quest tab, never injected
    await ev(() => { M.add(3, i => (i === M.chat.length + 1 ? 'PROMISE: we both wash the dishes after cards.' : '')); });
    await ev(() => { const b = M.chat.length; });
    await ev(() => { M.chat[M.chat.length - 2].mes = 'PROMISE: we both wash the dishes after cards.'; });
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => { const q = __savePoint.state().mem.records.filter(x => x.type === 'quest').pop(); __savePoint.handle('tab', 'quests'); return { q, html: $('.sp-terms').text(), inj: M.prompts[Object.keys(M.prompts)[0]]?.v || '' }; });
    ok(r.q?.terms?.quote?.startsWith('PROMISE: we both wash') && r.html.includes('근거 원문 #'), '3. 약속에 원문 인용이 붙고 퀘스트 탭에서 보임');
    ok(r.inj.includes('Promise made') && !r.inj.includes('wash the dishes'), '3. 인용은 주입에 들어가지 않음');

    // 4. a debt/promise whose evidence cannot be sent whole is "근거 일부 누락 · 판단 보류", not "문제 없음"
    await ev(() => { M.settings.savePoint.check = true; M.add(3); M.chat[M.chat.length - 2].mes = 'PROMISE: we both wash. ' + 'The band plays on. '.repeat(400); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    r = await ev(() => ({ st: __savePoint.state().check, hud: $('.sp-checks').text(), prompt: M.lastCheck }));
    ok(r.st.status === 'issues' && r.st.issues.some(x => x.kind === 'partial') && r.hud.includes('근거 일부 누락 · 판단 보류'), '4. 근거를 온전히 못 보내면 판단 보류로 표시');
    ok(r.prompt.includes('[TERMS]') && r.prompt.includes('context:'), '4. 확인 AI에 조건 원문과 앞뒤 문맥 전달');

    // 5. the whole range from first to last evidence is sent for a promise
    await ev(() => { M.promiseRange = true; M.add(5); M.chat[M.chat.length - 1].mes = 'PROMISE kept for later.'; M.chat[M.chat.length - 3].mes = 'Plan update: we both wash.'; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    r = await ev(() => { const q = __savePoint.state().mem.records.filter(x => x.type === 'quest').pop(); const orig = M.lastCheck.split('[ORIGINAL MESSAGES]')[1]; const lo = Math.min(...q.msgs), hi = Math.max(...q.msgs); const need = []; for (let n = lo; n <= hi; n++) need.push(n); return { need, all: need.every(n => orig.includes(`#${n} `)), status: __savePoint.state().check.status }; });
    ok(r.need.length >= 3 && r.all && r.status === 'ok', `5. 첫 근거부터 마지막 근거까지 사이 메시지 전부 전달 (#${r.need[0]}–#${r.need[r.need.length - 1]})`);
    await ev(() => { M.promiseRange = false; });

    // 6. disagreement without proof: both named, nobody blamed, two edit buttons
    await ev(() => { M.checkUnclear = true; M.add(3); M.chat[M.chat.length - 2].mes = 'PROMISE again.'; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    r = await ev(() => ({ hud: $('.sp-checks').text(), edits: $('.sp-checks [data-act^="check-edit"]').length }));
    ok(r.hud.includes('충돌 · 판단 보류') && r.hud.includes('↔') && r.edits === 2, '6. 판단 보류: 두 항목을 함께 보여 주고 각각 편집 가능');
    await ev(() => { M.checkUnclear = false; });

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
