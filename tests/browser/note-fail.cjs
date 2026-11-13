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

// v0.7.0-a1 (review of v0.7.0-a, P2-1 and P2-3).
// P2-1: an old-format memory is read through a tidied copy until its tidy-up is written. With that write refused
// once, a quick save worked on the copy: "saved" was shown while the page and the file kept the old memory.
// P2-3: a record check whose result could not be written showed the earlier result; a checkpoint whose result note
// alone failed skipped its record check (the note's rollback put back a copy of the same memory).
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: 'off', askResume: false, autoReserve: 0, hudOpen: true } }; });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
    await page.waitForTimeout(300);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const toasts = () => ev(() => toastr.log.map(x => x[1]).join(' | '));
    // Makes the next chat file write whose memory passes `test` (a function body over `st`) fail once (500).
    const failNext = test => ev(src => {
        const f = new Function('st', src);
        M.beforeChatSave = async (name, data) => { if (f(data[0]?.chat_metadata?.savePoint)) { M.beforeChatSave = null; M.failOnce = true; } };
    }, test);
    let r;

    // A room with a memory of its first 8 messages.
    await ev(() => { M.add(8); $('#sp_wand').trigger('click'); });
    await ev(() => __savePoint.handle('run'));
    await wait(1200);
    const memory = await ev(() => JSON.parse(JSON.stringify(M.meta.savePoint)));
    ok(memory?.lastIndex === 7, `준비: #7까지 기록 (${memory?.lastIndex})`);
    const chatA = await ev(() => JSON.parse(JSON.stringify(M.serverFiles.chatA)));
    const oldRoom = async () => {
        const f = JSON.parse(JSON.stringify(chatA));
        f[0].chat_metadata.savePoint.mem.evidenceVersion = 0;
        await ev(file => { M.serverFiles.chatA = file; }, f);
        await ev(() => M.openFile('chatA'));
    };

    // 1. [P2-1] The old-format memory's tidy-up is refused once; then 6 new messages and a quick save.
    await ev(() => { M.failMeta = true; });
    await oldRoom();
    await wait(1500);
    await ev(() => { M.failMeta = false; M.add(6); toastr.log.length = 0; });
    r = await ev(() => ({ page: M.meta.savePoint.mem.evidenceVersion, read: __savePoint.state().mem.evidenceVersion }));
    ok(r.page !== 1 && r.read === 1, `1. 준비: 정리 저장이 거절되어 화면 기억은 예전 형식, 읽기는 정리된 사본 (${r.page}, ${r.read})`);
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    r = await ev(() => ({ page: M.meta.savePoint.lastIndex, file: M.serverFiles.chatA[0].chat_metadata.savePoint.lastIndex, ev: M.meta.savePoint.mem.evidenceVersion, read: __savePoint.state().lastIndex }));
    const t1 = await toasts();
    ok(r.page === 13 && r.file === 13 && r.read === 13 && r.ev === 1, `1. 퀵세이브가 실제 기억에 저장됨 (화면 #${r.page}, 파일 #${r.file}, 읽기 #${r.read}, 형식 ${r.ev})`);
    ok(!t1.includes('퀵세이브 완료') || r.page === 13, `1. 저장하지 않고 완료라고 알리지 않음 (${t1.slice(0, 120)})`);

    // 1b. The tidy-up keeps failing: the save asks nothing and says why.
    await ev(() => { M.failMeta = true; });
    await oldRoom();
    await wait(1500);
    await ev(() => { M.add(6); toastr.log.length = 0; M.c0 = M.calls.length; });
    await ev(() => __savePoint.handle('run'));
    await wait(1200);
    r = await ev(() => ({ calls: M.calls.length - M.c0, page: M.meta.savePoint.lastIndex }));
    const t1b = await toasts();
    ok(r.calls === 0 && r.page === 7 && t1b.includes('기억 정리를 저장하지 못해서') && !t1b.includes('완료'), `1b. 정리 저장이 계속 안 되면 요청 없이 멈추고 알림 (요청 ${r.calls}개, #${r.page}, ${t1b.slice(0, 100)})`);
    await ev(() => { M.failMeta = false; });
    await ev(f => { M.serverFiles.chatA = f; }, chatA);
    await ev(() => M.openFile('chatA'));
    await wait(1000);

    // 2. [P2-3] A record check whose result cannot be written says so (not the earlier result).
    await ev(() => { M.settings.savePoint.check = true; M.add(6); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForFunction(() => __savePoint.state()?.check?.status === 'ok', null, { timeout: 8000 });
    const at0 = await ev(() => __savePoint.state().check.at);
    await failNext(`return !!st?.check && st.check.at > ${at0}`);
    await ev(() => { M.checkIssues = true; toastr.log.length = 0; M.k0 = M.checkCalls; });
    await ev(() => __savePoint.handle('check-rerun'));
    await wait(1500);
    r = await ev(() => ({ calls: M.checkCalls - M.k0, at: __savePoint.state().check.at, hud: $('.sp-hud').text() }));
    const t2 = await toasts();
    ok(r.calls === 1 && r.at === at0, `2. 준비: 다시 확인은 했고 결과 저장은 실패 (확인 ${r.calls}회)`);
    ok(r.hud.includes('기록 확인 결과를 저장하지 못했어요') && t2.includes('결과를 저장하지 못했어요'), `2. 결과를 저장하지 못했다고 화면과 알림에 표시 (${r.hud.match(/기록 확인[^·]*/)?.[0] || '-'})`);
    ok(!r.hud.includes('기록 확인: 문제 없음'), '2. 예전 결과(문제 없음)를 이번 결과처럼 보이지 않음');
    await ev(() => __savePoint.handle('check-rerun'));
    await wait(1500);
    r = await ev(() => ({ status: __savePoint.state().check.status, hud: $('.sp-hud').text() }));
    ok(r.status === 'issues' && !r.hud.includes('결과를 저장하지 못했어요') && r.hud.includes('확인 필요'), `2. 다시 확인이 저장되면 그 결과로 바뀜 (${r.status})`);
    await ev(() => { M.checkIssues = false; });

    // 3. [P2-3] A checkpoint whose record is saved but whose result note fails still checks the record.
    await ev(() => { M.add(6); M.k0 = M.checkCalls; });
    await failNext("return st?.autoLast?.status === 'saved'");
    await ev(() => __savePoint.summarize({ auto: true }));
    await wait(2000);
    r = await ev(() => ({ calls: M.checkCalls - M.k0, last: M.meta.savePoint.lastIndex, file: M.serverFiles.chatA[0].chat_metadata.savePoint.lastIndex, note: M.meta.savePoint.autoLast?.status }));
    ok(r.last === 19 && r.file === 19 && r.note !== 'saved', `3. 준비: 기록은 저장, 결과 메모만 실패 (#${r.last}, 파일 #${r.file}, 메모 ${r.note})`);
    ok(r.calls === 1, `3. 자동 기록 확인은 그대로 함 (확인 ${r.calls}회)`);

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
