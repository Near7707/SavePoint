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

    await ev(() => $('#sp_wand').trigger('click'));
    // A. under 20 new messages: nothing happens
    await ev(t => { M.add(19, i => (i === 19 ? '' : '') + `Message ${i} words words words.`); }, null);
    await gen();
    ok((await ev(() => M.calls.length)) === 0, 'A. 새 메시지 19개 → 자동 시도 안 함');
    // the last message must be a character reply
    await ev(() => { M.add(1); });            // #19 is a user message (odd index)
    await gen();
    ok((await ev(() => M.calls.length)) === 0, 'A. 마지막이 유저 메시지면 대기');
    // B. 21 messages, one scene still going: boundary call only, nothing saved, counter moves
    await ev(() => { M.add(1); });            // #20 character
    await gen();
    let r = await S();
    ok(r && r.b === 1 && r.calls === 1 && r.last === -1 && r.autoLast === '끝난 장면 없음', `B. 끝난 장면 없음 → 경계 확인만, 저장 없음 (${r?.autoLast})`);
    ok(r.mark === 20 && r.hidden.length === 0, 'B. 카운터 이동, 하이드 없음');
    await ev(() => { M.add(4); }); await gen();
    ok((await ev(() => M.calls.length)) === 1, 'B. 다음 20개 전에는 같은 원문을 다시 요청하지 않음');

    // C. scene A ends at #29, scene B (with a promise) runs on: only A is collected
    await ev(() => { M.add(16, i => (i === 30 ? 'SCENEBREAK next morning. ' : '') + (i === 12 ? 'GIFT ' : '') + (i === 33 ? 'PROMISE to meet. ' : '') + `Message ${i} words.`); });
    const callsBefore = await ev(() => M.calls.length);
    await gen();
    r = await S();
    const extractPrompt = await ev(() => M.calls.at(-1));
    ok(r.b === 2 && r.calls - callsBefore === 2, 'C. ① 경계 확인 → ② 끝난 구간 추출 (호출 2번)');
    ok(r.last === 29 && r.scenes.length === 1 && r.scenes[0].status === 'closed' && r.scenes[0].to === 29, `C. 끝난 장면 A(#0–#29)만 기록·닫힘 (#${r.last})`);
    ok(!extractPrompt.includes('#30 ') && !extractPrompt.includes('PROMISE'), 'C. ②에는 진행 중인 장면 B의 원문이 들어가지 않음');
    ok(r.quests.length === 0, 'C. B의 약속은 상태 목록에 들어가지 않음');
    ok(extractPrompt.includes('confirmed finished') && extractPrompt.includes('#29'), 'C. ②에 "마지막 장면까지 종료 확인" 조건 전달');
    ok(r.hidden.length === 30 && r.hidden.at(-1) === 29, `C. 하이드는 기록된 범위까지만 (숨김 #0–#${r.hidden.at(-1)}, 진행 중인 B는 보임)`);
    ok(r.autoLast.startsWith('장면 1개 기록'), `C. 상태 바에 결과 표시 (${r.autoLast})`);

    // D. manual mid-record of the open scene B, then auto finds its end → same scene id, closed
    await ev(() => __savePoint.handle('run'));
    r = await S();
    const bId = r.scenes.at(-1).id;
    const endD = await ev(() => M.chat.length - 1);
    ok(r.scenes.at(-1).status === 'open' && r.last === endD && r.mark === endD, `D. 수동 지금 정리 → B 중간 기록, 자동 카운터 재설정 (#${r.last})`);
    await ev(() => { M.add(20, i => (i === 52 ? 'SCENEBREAK at the harbor. ' : '') + `Message ${i} words.`); });
    await gen();
    r = await S();
    const bScene = r.scenes.find(s => s.id === bId);
    ok(bScene && bScene.status === 'closed' && bScene.segs === 2 && bScene.to === 51, `D. 자동이 B의 끝을 찾으면 같은 장면 ID에 이어 붙여 닫음 (${JSON.stringify(bScene)})`);
    ok(r.scenes.length === 2 && r.last === 51, 'D. 새 장면을 중복 생성하지 않음, C 장면은 미정리');

    // E. close-only: manual record of C, then new messages are all a new scene D
    await ev(() => __savePoint.handle('run'));
    const lastBefore = (await S()).last;
    await ev(() => { const first = M.chat.length; M.add(20, i => (i === first ? 'SCENEBREAK a week later. ' : '') + `Message ${i} words.`); });
    const c0 = await ev(() => M.calls.length);
    await gen();
    r = await S();
    ok(r.calls - c0 === 1 && r.last === lastBefore && r.scenes.at(-1).status === 'closed', `E. 새 메시지가 전부 새 장면이면 추출 없이 열린 장면만 닫음 (${r.autoLast})`);
    ok(r.autoLast.includes('닫음'), 'E. 결과 표시');

    // F. invalid boundary numbers: retried once; still invalid → nothing changes
    await ev(() => { M.add(20); M.bBad = true; });
    const before = await S();
    await gen();
    r = await S();
    ok(r.b - before.b === 2 && r.last === before.last && r.autoLast.startsWith('실패'), `F. 보내지 않은 경계 번호 → 재요청 후 실패, 변경 없음 (${r.autoLast})`);
    await ev(() => { M.bBad = false; M.add(20); M.bBadOnce = true; });
    await gen();
    r = await S();
    ok(!r.autoLast.startsWith('실패'), `F. 한 번 틀린 경계는 재요청으로 통과 (${r.autoLast})`);
    await ev(() => { M.bBadOnce = false; });

    // G. counting: user-hidden messages and swipes do not count
    const g0 = await S();
    await ev(() => { M.add(10); for (let i = M.chat.length - 10; i < M.chat.length; i++) M.chat[i].is_system = true; M.add(9); M.add(1); });   // 10 user-hidden + 10 visible
    await gen();
    ok((await S()).b === g0.b, 'G. 사용자가 숨긴 메시지는 세지 않음');
    await ev(async () => { const m = M.chat.at(-1); m.mes = 'swiped'; m.swipe_id = 1; await M.eventSource.emit('message_swiped', M.chat.length - 1); });
    await gen();
    ok((await S()).b === g0.b, 'G. 스와이프는 개수를 늘리지 않음');

    // H. input limit: hold with the agreed text, manual run lifts it
    await ev(() => { M.settings.savePoint.inputChars = 5000; M.add(40, i => `Message ${i} ${'long text '.repeat(30)}`); });
    await gen();
    r = await S();
    const hud = await ev(() => $('.sp-auto-line').text());
    ok(r.hold && hud.includes('미기록 내용이 입력 한도를 넘어 체크포인트를 멈췄어요. `퀵세이브`를 눌러 주세요.'), 'H. 입력 한도 초과 → 자동 보류 + 안내 문구');
    const hc = await ev(() => M.calls.length);
    await ev(() => { M.add(30); }); await gen();
    ok((await ev(() => M.calls.length)) === hc, 'H. 보류 중에는 자동 시도 안 함');
    await ev(() => { M.settings.savePoint.inputChars = 60000; });
    await ev(() => __savePoint.handle('run'));
    ok(!(await S()).hold, 'H. 수동 정리 후 보류 해제');

    // I. a new generation cancels a running automatic collection (main API), counter kept
    await ev(() => { M.add(20, i => (i % 7 === 0 ? 'SCENEBREAK ' : '') + `Message ${i}.`); M.delay = 300; });
    const i0 = await S();
    await ev(async () => { await M.eventSource.emit('generation_ended'); });
    await sleep(1400);
    await ev(async () => { await M.eventSource.emit('generation_started', 'normal', {}, false); });
    await sleep(500);
    r = await S();
    ok(r.last === i0.last && r.mark === i0.mark && r.autoLast.startsWith('취소'), `I. 생성 시작 → 자동 정리 취소, 카운터 유지 (${r.autoLast})`);
    await ev(() => { M.delay = 0; });
    await ev(async () => { await M.eventSource.emit('generation_ended'); });
    await sleep(1700);
    ok((await S()).last > i0.last, 'I. 생성이 끝나면 다시 시도');

    // J. off switch
    await ev(() => { M.settings.savePoint.auto = false; M.add(30); });
    const j0 = await ev(() => M.calls.length);
    await gen();
    ok((await ev(() => M.calls.length)) === j0 && (await ev(() => $('.sp-auto-line').text())).includes('체크포인트 꺼짐'), 'J. 끄면 자동 시도 안 함');

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
