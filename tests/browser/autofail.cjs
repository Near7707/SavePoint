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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('[SavePoint]')) console.log('CONSOLE', m.text()); });
    await page.goto(`http://localhost:${srv.address().port}/`);
    await page.waitForFunction(() => !!globalThis.__savePoint);
    await page.evaluate(() => { M.settings.savePoint.check = false; });   // the record check has its own suite (checks.cjs)
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const sleep = ms => page.waitForTimeout(ms);
    const SP = '__savePoint';
    const gen = async () => { await ev(async () => { await M.eventSource.emit('generation_started', 'normal', {}, false); await M.eventSource.emit('generation_ended'); }); await sleep(1700); };
    const S = () => ev(() => { const st = __savePoint.state(); return st && { last: st.lastIndex, mark: st.autoMark, hold: !!st.autoHold, autoLast: st.autoLast?.result || '',
        scenes: st.mem.scenes.map(s => ({ id: s.id, status: s.status, segs: s.segs.length, from: s.segs[0].from, to: s.segs.at(-1).to })),
        quests: st.mem.records.filter(r => r.type === 'quest').map(r => r.text), gifts: st.mem.records.length,
        hidden: M.chat.map((m, i) => m.is_system ? i : -1).filter(i => i >= 0), calls: M.calls.length, b: M.bCalls || 0 }; });
    const txt = (i, extra = '') => `${extra}Message ${i} ${'words '.repeat(20)}`;

    const toast = () => ev(() => toastr.log.map(x => x[0] + ':' + x[1]));
    const F = () => ev(() => { const st = __savePoint.state(); return { f: st.autoFail ? JSON.parse(JSON.stringify(st.autoFail)) : null, last: st.lastIndex, hud: $('.sp-hud').text() }; });
    await ev(() => $('#sp_wand').trigger('click'));

    // 1. boundary step fails: short alert, detailed record kept in the room
    await ev(() => { M.add(21, i => (i === 10 ? 'SCENEBREAK later that night. ' : '') + `Message ${i} words.`); M.bBad = true; });
    await gen();
    let r = await F(), t = await toast();
    ok(r.f && r.f.stage === 'boundary' && r.f.from === 0 && r.f.to === 20 && r.f.attempts === 2 && r.f.tries.length === 2, `1. 경계 확인 실패 기록: 단계·범위·요청 횟수 (${r.f?.stage} #${r.f?.from}–#${r.f?.to}, ${r.f?.attempts}회)`);
    ok(t.some(x => x === 'warning:체크포인트 실패 (#0–#20) · 해당 구간 원문 유지'), '1. 짧은 알림');
    ok(r.f.reason && r.f.detail.length > 0 && r.f.at > 0, '1. 이유·자세한 오류·시각 저장');

    // 2. extraction step fails
    await ev(() => { M.bBad = false; M.add(20); M.failAt = 3; });
    await gen();
    r = await F();
    ok(r.f && r.f.stage === 'collect' && r.f.from === 0 && r.f.to === 9 && r.f.attempts === 2 && r.f.tries.every(x => /^(첫 요청|재요청): .*검사 실패/.test(x)), `2. 기록 단계 실패: 실패 구간 #${r.f?.from}–#${r.f?.to}, 시도마다 결과`);
    ok(r.hud.includes('⚠ 체크포인트 실패 #0–#9') && r.last === -1, '2. 상태 바에 표시, 원문은 그대로');
    ok((await ev(() => __savePoint.reportText(__savePoint.state()))).includes('[체크포인트 실패 · 수집]'), '2. 결과 복사에 포함');

    // 3. survives leaving the room and coming back (stored in the chat file, not in the page)
    await ev(async () => { window.__keep = { chat: M.chat, meta: M.meta }; await M.switchChat('chatB', [], {}); await M.switchChat('chatA', __keep.chat, __keep.meta); __savePoint.ui.lastError = null; __savePoint.render(true); });
    r = await F();
    ok(r.f && r.f.stage === 'collect' && r.hud.includes('⚠ 체크포인트 실패 #0–#9'), '3. 방을 옮겼다 와도 실패 기록이 남음');

    // 4. a checkpoint that finds no finished scene does not clear it
    await ev(() => { M.failAt = undefined; M.chat[10].mes = 'Message 10 words.'; M.add(20); });
    await gen();
    r = await F();
    ok(r.f && r.f.from === 0 && r.f.to === 9 && (await ev(() => __savePoint.state().autoLast.result)).includes('끝난 장면 없음'), '4. "끝난 장면 없음"이면 실패 기록 유지');

    // 5. a partial quick save keeps only the part still unrecorded
    await ev(() => { for (let i = 0; i < 10; i++) M.chat[i].mes = `Message ${i} ` + 'long words of the day '.repeat(140); M.settings.savePoint.inputChars = 20000; M.failAt = 6; });
    await ev(() => __savePoint.handle('run'));
    r = await F();
    ok(r.f && r.last >= 0 && r.last < 9 && r.f.from === r.last + 1 && r.f.to === 9, `5. 퀵세이브가 일부만 저장하면 남은 구간만 유지 (저장 #${r.last}까지 → 실패 기록 #${r.f?.from}–#${r.f?.to})`);

    // 6. the failed range saved in full: cleared
    await ev(() => { M.failAt = undefined; M.settings.savePoint.inputChars = 60000; });
    await ev(() => __savePoint.handle('run'));
    r = await F();
    ok(!r.f && r.last >= 9 && !r.hud.includes('체크포인트 실패'), '6. 실패 구간이 저장되면 기록 삭제');

    // 7. collection saved but the review after it failed: told apart
    await ev(() => { M.settings.savePoint.check = true; M.checkBad = true; const first = M.chat.length; M.add(M.chat.length % 2 ? 22 : 21, i => (i === first + 6 ? 'SCENEBREAK next morning. ' : '') + `Message ${i} words.`); });
    const t7 = (await toast()).length;
    await gen(); await sleep(900);
    r = await ev(() => ({ c: __savePoint.state().check, hud: $('.sp-hud').text(), fail: __savePoint.state().autoFail, t: toastr.log.map(x => x[0] + ':' + x[1]) }));
    ok(r.c.status === 'failed' && r.c.kind === 'review' && r.c.auto === true && r.c.attempts === 2 && !r.fail, `7. 저장 후 검토 실패는 따로 기록 (kind ${r.c.kind}, 요청 ${r.c.attempts}회)`);
    ok(r.t.slice(t7).some(x => x === 'warning:체크포인트 저장 후 기록 확인 실패 · 기록은 저장됨') && r.hud.includes('저장 후 기록 확인 실패') && r.hud.includes('기록은 저장됨'), '7. 알림과 상태 바 문구로 구분');
    await ev(() => { M.checkBad = false; });

    // 8. wording
    ok((await ev(() => $('#extensions_settings, body').text())).includes('세이브한 메시지 하이드'), '8. 설정 문구: 세이브한 메시지 하이드');

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
