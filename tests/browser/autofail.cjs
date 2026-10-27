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
    const srv=await serve(),browser=await chromium.launch();
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.on('pageerror',e=>{console.log('PAGE ERROR',e.message);failures++;});
    await page.goto(`http://localhost:${srv.address().port}/`);await page.waitForFunction(()=>!!globalThis.__savePoint);
    const ev=(fn,arg)=>page.evaluate(fn,arg),run=()=>ev(()=>__savePoint.autoCollect());
    const snap=()=>ev(()=>({st:__savePoint.state(),calls:M.calls.length,text:$('.sp-hud').text(),notices:toastr.log.map(x=>x[1])}));
    await ev(()=>{M.settings.savePoint.check=false;$('#sp_wand').trigger('click');M.badJson=true;M.add(21);});await run();let r=await snap();
    ok(r.st.lastIndex===-1&&r.st.autoLast.status==='failed'&&r.st.autoFail.stage==='collect','형식 실패는 저장 없이 실패 기록');
    ok(r.calls===2&&r.st.autoFail.attempts===2&&r.notices.some(x=>x.includes('체크포인트 실패')),'응답 재요청과 실패 알림·횟수 기록');
    const first=r.calls;await ev(()=>{M.badJson=false;M.add(19);});await run();ok((await snap()).calls===first,'실패 후 새 메시지 19개에서는 재시도 안 함');
    await ev(()=>M.add(1));await run();r=await snap();ok(r.st.lastIndex===38&&!r.st.autoFail,'다음 간격에 실패 범위부터 재시도해 성공하면 실패 기록 삭제');
    await ev(()=>{M.add(20);M.failMeta=true;});const old=r.st.lastRecord;await run();r=await snap();
    ok(r.st.lastIndex===38&&r.st.autoFail.stage==='save'&&r.st.autoLast.status==='failed','채팅 파일 저장 실패도 결과 기록');
    ok(r.st.lastRecord.at===old.at&&r.st.lastRecord.to===old.to,'저장 실패로 마지막 실제 기록을 갱신하지 않음');
    await ev(()=>{M.failMeta=false;M.settings.savePoint.inputChars=30000;M.partialSeen=0;M.failSecond=true;
        const get=SillyTavern.getContext;SillyTavern.getContext=()=>{const c=get();return {...c,generateRaw:async args=>{
            const raw=await c.generateRaw(args);if(!args.prompt.startsWith('You are checking')&&M.failSecond&&++M.partialSeen===2)throw new Error('Second batch failed');return raw;
        }};};M.add(40,i=>'Message '+i+' '+'long words '.repeat(120));});await run();r=await snap();
    ok(r.st.lastIndex>38&&r.st.lastIndex<98&&r.st.autoLast.status==='partial','뒷구간 실패 시 앞의 저장된 구간 유지');
    ok(r.st.autoFail.from===r.st.lastIndex+1&&r.text.includes('일부 저장'),'미기록 나머지 범위와 일부 저장 결과 표시');
    const count=r.calls;await ev(()=>{M.failSecond=false;M.add(1);});await run();ok((await snap()).calls===count,'일부 실패 직후에는 남은 범위를 바로 재전송하지 않음');
    await ev(()=>{M.settings.savePoint.inputChars=60000;M.add(19);});await run();r=await snap();
    ok(r.st.lastIndex===118&&!r.st.autoFail,'다음 간격에 남은 범위부터 이어 기록');
    await ev(()=>{M.settings.savePoint.check=true;M.checkBad=true;M.add(20);});await run();
    await page.waitForFunction(()=>__savePoint.state()?.check?.status==='failed');
    r=await snap();ok(r.st.check.auto===true&&!r.st.autoFail&&r.st.autoLast.status==='saved','저장 후 기록 확인 실패는 체크포인트 저장 실패와 구분');
    await browser.close();srv.close();console.log(failures?failures+' FAILED':'ALL PASS');process.exit(failures?1:0);
})();
