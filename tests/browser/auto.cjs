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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.goto(`http://localhost:${srv.address().port}/`);
    await page.waitForFunction(() => !!globalThis.__savePoint);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const run = () => ev(() => __savePoint.autoCollect());
    const snap = () => ev(() => ({ st: __savePoint.state(), calls: M.calls.length, b: M.bCalls || 0, text: $('.sp-hud').text(), hidden: M.chat.map((m,i)=>m.is_system?i:-1).filter(n=>n>=0) }));
    await ev(() => { M.settings.savePoint.check = false; M.settings.savePoint.keepRecent = 0; $('#sp_wand').trigger('click'); M.add(19); });
    await run(); ok((await ev(()=>M.calls.length))===0,'간격 미달이면 요청 없음');
    await ev(()=>M.add(1)); await run(); ok((await ev(()=>M.calls.length))===0,'마지막이 유저 메시지면 대기');
    await ev(()=>M.add(1)); await run(); let r=await snap();
    ok(r.calls===1&&r.b===0&&r.st.lastIndex===18,'진행 중 장면도 경계 호출 없이 최근 2개를 빼고 기록');
    ok(r.st.mem.scenes[0].status==='open'&&r.st.autoLast.status==='saved','진행 장면은 열린 상태로 유지');
    ok(r.hidden.length===19&&r.hidden.at(-1)===18,'여유분 2개는 하이드하지 않음');
    ok(r.text.includes('마지막 자동 저장 시도')&&r.text.includes('마지막 실제 기록')&&r.text.includes('최근 2개 여유분'),'확인 시각과 실제 기록·여유분을 구분');
    const sid=r.st.mem.scenes[0].id;
    await ev(()=>M.add(4)); await run(); ok((await ev(()=>M.calls.length))===1,'기존 미기록이 있어도 다음 간격 전에는 다시 요청 안 함');
    await ev(()=>M.add(16)); await run(); r=await snap();
    ok(r.st.lastIndex===38&&r.st.mem.scenes.length===1&&r.st.mem.scenes[0].id===sid,'다음 간격에 지난 여유분부터 같은 장면에 이어 기록');
    await ev(async()=>{M.chat.at(-1).mes='A different latest answer.'; await M.eventSource.emit('message_swiped',M.chat.length-1);});
    await ev(()=>__savePoint.reconcile());ok((await snap()).st.lastIndex===38,'여유분 스와이프는 기록 범위를 되감지 않음');
    await ev(()=>__savePoint.handle('run'));r=await snap();
    ok(r.st.lastIndex===40&&r.st.autoMark===40,'수동 퀵세이브는 마지막 메시지까지 기록하고 간격 초기화');
    await ev(()=>{M.settings.savePoint.autoReserve=0;M.add(20);});await run();r=await snap();
    ok(r.st.lastIndex===60,'여유분 0개면 마지막 메시지까지 자동 기록');
    await ev(()=>{M.settings.savePoint.autoEvery=5;M.settings.savePoint.autoReserve=20;M.add(6);});const noCalls=r.calls;await run();r=await snap();
    ok(r.calls===noCalls&&r.st.autoLast.status==='empty'&&r.st.lastRecord.to===60,'여유분만 있으면 호출 없이 미기록 결과, 마지막 실제 기록 유지');
    await ev(()=>{M.settings.savePoint.autoEvery=20;M.settings.savePoint.autoReserve=2;M.settings.savePoint.inputChars=60000;M.add(40,i=>'Message '+i+' '+'words '.repeat(160));});
    const before=r.calls;await run();r=await snap();
    ok(r.calls>before+1&&r.st.lastIndex===104&&!r.st.autoHold,'긴 미기록은 작은 요청으로 분할 저장');
    await page.waitForTimeout(1500);
    ok(await ev(()=>M.settings.savePoint.slotCache.some(s=>s.auto&&s.msgCount===105)),'오토세이브에 실제 기록 위치 반영');
    await ev(()=>{M.settings.savePoint.auto=false;M.add(20);});const off=r.calls;await run();
    ok((await ev(()=>M.calls.length))===off,'체크포인트를 끄면 자동 요청 안 함');
    await browser.close();srv.close();console.log(failures?failures+' FAILED':'ALL PASS');process.exit(failures?1:0);
})();
