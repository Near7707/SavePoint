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
    await page.goto(`http://localhost:${srv.address().port}/`);
    await page.waitForFunction(() => !!globalThis.__savePoint);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const sleep = ms => page.waitForTimeout(ms);


    await ev(() => {
        M.settings.savePoint.check = false; M.settings.savePoint.auto = false;
        M.timeCase = 'initial';
        const getContext = SillyTavern.getContext;
        SillyTavern.getContext = () => {
            const c = getContext();
            return {...c, generateRaw: async args => {
                const raw = await c.generateRaw(args);
                const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
                if (data.scenes) for (const sc of data.scenes) {
                    const n = sc.points[0].msgs.find(Number.isInteger), quote = M.chat[n].mes;
                    if (M.timeCase === 'initial') {
                        sc.title = ''; sc.outline = '';
                        sc.points[0].key = true;
                        sc.time = {mode:'present',start:{relation:'explicit',date:'2026-10-24',period:'night',msg:n,quote},end:{relation:'same'}};
                    } else if (M.timeCase === 'advance') {
                        sc.title = 'A real scene title'; sc.time = {mode:'present',start:{relation:'same'},end:{relation:'advance',days:1,period:'morning',msg:n,quote:'다음 날'}};
                    } else if (M.timeCase === 'bad') sc.time = {mode:'present',end:{relation:'explicit',date:'2035-04-10',msg:n,quote:'a fabricated quote'}};
                    else if (M.timeCase === 'night') sc.time = {mode:'present',end:{relation:'explicit',period:'night',msg:n,quote:'밤'}};
                    else if (M.timeCase === 'backward') sc.time = {mode:'present',end:{relation:'explicit',date:'2026-10-20',msg:n,quote:'2026-10-20'}};
                }
                return JSON.stringify(data);
            }};
        };
        M.add(2, () => '2026-10-24 night: a participant returned the repaired token.');
        $('#sp_wand').trigger('click');
    });
    await ev(() => __savePoint.handle('run'));
    let r = await ev(() => ({mem:__savePoint.state().mem,calls:M.calls.length,text:$('.sp-window').text(),injection:M.prompts.savepoint.v}));
    ok(r.calls === 1 && r.mem.scenes[0].titlePending && r.mem.scenes[0].segs[0].outlinePending, '1. 날짜 추출은 기존 요청 1회, 임시 제목·개요로 정상 세이브');
    ok(r.text.includes('2026-10-24') && r.text.includes('임시 제목') && r.injection.includes('Last recorded story time: 2026-10-24'), '1. 화면과 주입에 마지막 기록의 날짜');
    const firstPoint=r.mem.scenes[0].segs[0].points[0].text;
    await ev(()=>__savePoint.handle('key-toggle','s1|g1|0'));
    ok(await ev(text=>!M.prompts.savepoint.v.includes(text),firstPoint),'1. ○로 바꾼 포인트는 임시 개요에서도 주입되지 않음');
    await ev(()=>__savePoint.handle('key-toggle','s1|g1|0'));
    ok(await ev(text=>M.prompts.savepoint.v.includes(text),firstPoint),'1. ●로 다시 고르면 임시 개요도 즉시 반영');
    await ev(()=>__savePoint.handle('edit-scene','s1'));
    await page.fill('[data-edit=where]','Gate');await page.click('[data-act=edit-save]');
    ok(await ev(()=>__savePoint.state().mem.scenes[0].titlePending === true), '1. 장소만 고쳐도 임시 제목 교체 가능 상태는 유지');
    await ev(() => { M.timeCase='advance';M.add(2,()=> '다음 날 아침, 다시 만났다.'); });
    await ev(() => __savePoint.handle('run'));
    r=await ev(()=>({s:__savePoint.state().mem.scenes[0],injection:M.prompts.savepoint.v,calls:M.calls.length}));
    ok(r.s.title === 'A real scene title' && !r.s.titlePending && r.s.segs.length === 2, '2. 이어 기록에서 임시 제목만 정상 제목으로 교체');
    ok(r.injection.includes('Last recorded story time: 2026-10-25'), '2. 다음 날이 같은 기준의 2일째로 연결');
    const beforeEditCalls=r.calls;
    await ev(()=>__savePoint.handle('edit-segtime','s1|g1'));
    await page.fill('[data-edit=date]','2026-10-26');
    await page.click('[data-act=edit-save]');
    r=await ev(()=>({mem:__savePoint.state().mem,calls:M.calls.length,text:$('.sp-window').text(),injection:M.prompts.savepoint.v}));
    ok(r.calls === beforeEditCalls && r.mem.scenes[0].segs[0].time.end.certainty === 'manual' && r.injection.includes('Last recorded story time: 2026-10-27'), '3. 직접 지정은 호출 없이 보호되고 이후 연결 시간만 재계산');
    await ev(()=>__savePoint.handle('edit-scene','s1'));
    await page.fill('[data-edit=title]','User chosen title');await page.click('[data-act=edit-save]');
    await ev(()=>{M.add(2,()=> '다음 날 아침, 길을 나섰다.');});await ev(()=>__savePoint.handle('run'));
    r=await ev(()=>({mem:__savePoint.state().mem,injection:M.prompts.savepoint.v}));
    ok(r.mem.scenes[0].title === 'User chosen title' && r.mem.scenes[0].segs[0].time.end.certainty === 'manual' && r.injection.includes('2026-10-28'), '4. 다음 세이브가 직접 지정 제목·날짜를 덮지 않음');
    await ev(()=>__savePoint.handle('save-new'));
    const slot=await ev(()=>__savePoint.state().linkedSave);
    await ev(async()=>{await M.switchChat('room-B',[],{});M.add(2,()=> '다음 날 아침, 새 방에서 이어 간다.');});
    await ev(id=>__savePoint.handle('load',id),slot);
    const beforeBranch=await ev(()=>JSON.stringify(__savePoint.state().mem));
    await ev(()=>__savePoint.handle('run'));
    r=await ev(()=>({mem:__savePoint.state().mem,injection:M.prompts.savepoint.v}));
    const gs=r.mem.scenes[0].segs;
    ok(r.injection.includes('Last recorded story time: 2026-10-29') && gs.at(-1).time.end.day === 3, '5. 다른 방에서 #0부터 이어도 기준 일 수는 계속됨');
    ok(gs[0].time.start.evidence.msg === 0 && gs[0].time.start.evidence.room !== gs.at(-1).time.end.evidence.room && gs.at(-1).time.end.evidence.msg === 0, '5. 같은 #0이라도 시간 근거의 출처 방은 구분');
    await ev(()=>__savePoint.undo());
    r=await ev(()=>({mem:JSON.stringify(__savePoint.state().mem),injection:M.prompts.savepoint.v}));
    ok(r.mem === beforeBranch && r.injection.includes('2026-10-28'), '6. 리와인드는 시간·기준점도 저장 전 상태로 복원');
    await ev(()=>{M.timeCase='bad';});await ev(()=>__savePoint.handle('run'));
    r=await ev(()=>({st:__savePoint.state(),injection:M.prompts.savepoint.v}));
    ok(r.st.lastIndex === 1 && r.st.mem.scenes[0].segs.at(-1).time.end.certainty === 'unconfirmed' && r.injection.includes('(unconfirmed)'), '7. 날짜 근거가 틀려도 내용은 저장, 시간만 미확인');
    const stable=await ev(()=>JSON.stringify(__savePoint.state().mem));
    await ev(()=>{M.failMeta=true;__savePoint.handle('edit-segtime','s1|g1');});
    await page.fill('[data-edit=date]','2026-11-01');
    await ev(()=>__savePoint.handle('edit-save').catch(()=>{}));
    r=await ev(()=>JSON.stringify(__savePoint.state().mem));
    ok(r === stable, '8. 채팅 파일 쓰기 실패 시 날짜 편집도 원복');
    await ev(()=>{M.failMeta=false;});
    await page.setViewportSize({width:320,height:667});await ev(()=>__savePoint.render(true));
    r=await ev(()=>({w:document.querySelector('#sp_overlay .sp-window').getBoundingClientRect().width,b:document.querySelector('.sp-body').clientHeight}));
    ok(r.w<=320 && r.b>50, '9. 작은 모바일 폭에서도 본문과 날짜 편집 영역 접근 가능');
    const lastGid=await ev(()=>__savePoint.state().mem.scenes[0].segs.at(-1).id);
    await ev(gid=>__savePoint.handle('edit-segtime','s1|'+gid),lastGid);
    ok(await page.inputValue('[data-edit=day]')==='','10. 미확인 구간의 일 수 편집은 빈칸');
    await page.selectOption('[data-edit=period]','night');await page.click('[data-act=edit-save]');
    r=await ev(()=>({t:__savePoint.state().mem.scenes[0].segs.at(-1).time.end,injection:M.prompts.savepoint.v}));
    ok(r.t.day===null&&r.t.certainty==='manual'&&r.injection.includes('Last recorded story time: unknown date · night'),'10. 밤만 직접 지정해도 1일째를 만들지 않음');
    await ev(()=>{M.timeCase='bad';M.add(2,()=> 'No usable date.');});await ev(()=>__savePoint.handle('run'));
    await ev(()=>{M.timeCase='night';M.add(2,()=> '밤이 깊었다.');});await ev(()=>__savePoint.handle('run'));
    r=await ev(()=>({t:__savePoint.state().mem.scenes[0].segs.at(-1).time.end,injection:M.prompts.savepoint.v}));
    ok(r.t.certainty==='explicit'&&r.injection.includes('Last recorded story time: unknown date · night'),'11. 미확인 뒤 시간대만 확인되면 별도 기준의 날짜 미상');
    await ev(()=>__savePoint.handle('edit-segtime','s1|'+__savePoint.state().mem.scenes[0].segs.at(-1).id));
    await page.fill('[data-edit=date]','2026-10-24');await page.click('[data-act=edit-save]');
    await ev(()=>{M.timeCase='backward';M.add(2,()=> 'The letter was dated 2026-10-20.');});await ev(()=>__savePoint.handle('run'));
    r=await ev(()=>({t:__savePoint.state().mem.scenes[0].segs.at(-1).time.end,injection:M.prompts.savepoint.v}));
    ok(r.t.certainty==='unconfirmed'&&!r.injection.includes('Last recorded story time: 2026-10-20'),'12. 편지의 과거 날짜가 현재 시간으로 역행하지 않음');
    if(SHOTS)await page.screenshot({path:path.join(OUT,'story-time.png')});
    await browser.close();srv.close();console.log(failures ? `${failures} FAILED` : 'ALL PASS');process.exit(failures?1:0);
})();
