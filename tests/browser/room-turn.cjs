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
// v0.7.0-b2c: a check that no longer applies (its reason given), or one kept for b3.
const skip = (msg, why) => console.log(`SKIP  ${msg} — ${why}`);

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
    // v0.6.60: each change checked again at its turn (review of v0.6.59): what was approved or read is still
    // what the page shows, a confirmed save only becomes the base when the page still covers it, and the
    // first read of a room compares its memory too.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, hideMode: 'off', askResume: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, is_system: false, mes: `${tag} message ${i} ${'and more '.repeat(6)}.`, swipe_id: 0, swipes: [`${tag} message ${i} ${'and more '.repeat(6)}.`], extra: {} }));
    // v0.7.0-b2c: a room file has its integrity (SillyTavern's own; a memory file is made only for a room that has one).
    const file = (list, meta = {}) => JSON.parse(JSON.stringify([{ chat_metadata: { integrity: 'int-' + Math.random().toString(36).slice(2), ...meta } }, ...list]));
    const toasts = () => ev(() => toastr.log.map(x => x[1]).join(' | '));
    const open = async (id, list, meta = {}, serverFile = null) => {
        await ev(([id, f, l, m]) => { M.serverFiles[id] = f; return M.switchChat(id, l, m); }, [id, serverFile || file(list, meta), JSON.parse(JSON.stringify(list)), JSON.parse(JSON.stringify(meta))]);
        await wait(400);
    };
    // A QUICK save to load from, and a memory to copy.
    await ev(() => { M.add(8); });
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const qid = await ev(() => __savePoint.listSaves().find(x => x.quick)?.id);
    const memory = await ev(() => JSON.parse(JSON.stringify(__savePoint.home().st)));
    ok(!!qid && memory?.mem?.scenes?.length > 0, '준비: QUICK과 기억');
    let r;

    // 1. [P1] continue approved in a greeting-only room; while it waits in the room's queue the first message
    //    is edited and a second one is saved. The edited first message is never replaced.
    const greet = { name: 'Ari', is_user: false, is_system: false, mes: 'Hello! This is the very first greeting.', swipe_id: 0, swipes: ['Hello! This is the very first greeting.'], extra: {} };
    await open('roomP', [greet]);
    await ev(() => { M.confirm = 1; toastr.log.length = 0; M.metaDelay = 900; __savePoint.adoptPage(); __savePoint.persistSoon(); });
    await wait(450);                                 // the small save holds the queue
    await ev(id => { M.p = __savePoint.loadSave(id); }, qid);
    await wait(250);                                 // asked, checked and waiting its turn
    await ev(() => { const m = M.chat[0]; m.mes = 'An edited first line written here.'; m.swipes = [m.mes]; M.add(1); });
    await ev(() => M.p);
    await wait(300);
    r = await ev(() => ({ page: M.chat[0].mes, file: M.serverFiles.roomP[1].mes, n: M.serverFiles.roomP.length - 1, mem: !!M.mem('roomP'), t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.page === 'An edited first line written here.' && r.file === r.page && r.n === 2 && !r.mem && r.t.includes('확인하는 사이 대화나 기억이 바뀌어서'),
        `1. 이어하기를 기다리는 사이 고친 첫 메시지는 덮지 않음 (${r.file.slice(0, 16)}, ${r.n}, ${r.t.slice(0, 30)})`);
    await ev(() => { M.metaDelay = 0; });
    skip('1. 그대로면 이어하기는 평소대로', 'b3: #0 이어하기를 꺼 둠');

    // 2. [P2] an unconfirmed save is found in the file, but another device deleted the last message since:
    //    that file does not become the base, and the message does not come back.
    await open('roomQ', msgs(20, 'Que'));
    // v0.7.0-b2c: the unconfirmed save it started from was a memory in the chat file (now its own file, home-link); the
    // deleted message is the check.
    skip('2. 준비: 저장 확인 불가', '기억은 채팅 파일에 없음: 응답 없는 기억 쓰기는 home-link·h1-order');
    await ev(() => { M.serverFiles.roomQ.pop(); M.saves0 = M.saves; toastr.log.length = 0; });
    await ev(() => __savePoint.toggleKeep(2).catch(e => { M.qErr = e.message; }));
    r = await ev(() => ({ n: M.serverFiles.roomQ.length - 1, saves: M.saves - M.saves0, t: toastr.log.map(x => x[1]).join(' | '), err: M.qErr || '' }));
    ok(r.n === 19 && r.saves === 0 && r.err.includes('지운 메시지'), `2. 확인한 저장 뒤 다른 곳에서 지운 메시지가 되살아나지 않음 (${r.n}, ${r.saves}, ${r.err.slice(0, 20)})`);
    //    … nor when that message was edited here meanwhile (the page never saved the edit)
    await open('roomQ2', msgs(20, 'Qu2'));
    await ev(() => { M.serverFiles.roomQ2.pop(); M.chat[19].mes += ' (edited here)'; M.saves0 = M.saves; });
    await ev(() => __savePoint.toggleKeep(2).catch(e => { M.q2Err = e.message; }));
    r = await ev(() => ({ n: M.serverFiles.roomQ2.length - 1, saves: M.saves - M.saves0, err: M.q2Err || '' }));
    ok(r.n === 19 && r.saves === 0 && r.err.includes('지운 메시지'), `2. 지운 메시지를 여기서 고쳐 둔 경우도 되살리지 않음 (${r.n}, ${r.err.slice(0, 20)})`);
    //    … while a message deleted here and a new one after it save as usual
    await open('roomQ3', msgs(20, 'Qu3'));
    await ev(async () => { M.chat.pop(); await M.eventSource.emit('message_deleted', M.chat.length); M.noStSave = true; M.add(1, i => `A fresh line ${i} made here.`); M.noStSave = false; M.saves0 = M.saves; });
    await ev(() => __savePoint.toggleKeep(2).catch(e => { M.q3Err = e.message; }));
    r = await ev(() => ({ n: M.serverFiles.roomQ3.length - 1, saves: M.saves - M.saves0, err: M.q3Err || '', last: M.serverFiles.roomQ3.at(-1).mes }));
    ok(r.n === 20 && r.saves === 1 && !r.err && r.last.startsWith('A fresh line'), `2. 여기서 지우고 새로 쓴 메시지는 평소대로 저장 (${r.n}, ${r.err})`);

    // 3. (v0.7.0-b2c) the memory was read from the chat metadata the page had loaded; it is read from the room's memory file
    //    when the room opens (home-link), so an older one on the page is never there to write over a newer one.
    const arr = msgs(6, 'Ar');
    skip('3. 방을 열 때 서버 기억이 더 새로우면 덮어쓰지 않음', '기억은 방을 열 때 기억 파일에서 읽음 (home-link)');
    skip('3. 같은 기억이면 평소대로', '위와 같음');

    // 4. [P2] a quick save whose last unrecorded message is edited (and saved) while the save waits for its
    //    file check: nothing is recorded from the old text, and no "done".
    await open('roomS', msgs(6, 'Ess'));
    await ev(() => { M.readDelayFor = { roomS: 900 }; M.delay = 200; toastr.log.length = 0; M.c4 = M.calls.length; M.p = __savePoint.summarize(); });
    // v0.7.0-a: a room with no memory makes it at a turn of the room's queue first (after the room check), so the
    // request goes out later than before; the edit is made once the AI answered and the write waits for its file read.
    await page.waitForFunction(() => M.calls.length > M.c4, null, { timeout: 10000 });
    await wait(350);
    await ev(() => { const m = M.chat[5]; m.mes = 'The last line, rewritten while saving.'; m.swipes = [m.mes]; M.stSave(); });
    await ev(() => M.p);
    await wait(200);
    r = await ev(() => ({ last: __savePoint.state()?.lastIndex ?? -1, file: M.mem('roomS')?.lastIndex ?? -1, t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.last === -1 && r.file === -1 && !r.t.includes('퀵세이브 완료') && r.t.includes('바뀌어서'), `4. 저장을 기다리는 사이 고친 메시지는 예전 원문으로 기록하지 않음 (${r.last}, ${r.t.slice(0, 40)})`);
    await ev(() => { M.readDelayFor = null; M.delay = 0; });
    await ev(() => __savePoint.summarize());
    await wait(300);
    r = await ev(() => __savePoint.state()?.lastIndex);
    ok(r === 5, `4. 다시 누르면 고친 원문으로 저장 (${r})`);

    // 5. [P3] an old-format memory read while the room is being checked: a result marked 무시 there never
    //    reaches the room's metadata before the room is confirmed, and is then saved through the queue.
    //    (v0.7.0-b2c: the old memory is moved into the room's memory file when the room is linked; the 무시 lands there.)
    const old = JSON.parse(JSON.stringify(memory));
    old.mem.evidenceVersion = 0;
    old.check = { at: 1, status: 'done', scope: { from: 0, to: 5 }, issues: [{ id: 'c1', about: old.mem.records[0]?.id || 'r1', kind: 'partial', ignored: false, note: 'A note.' }] };
    await ev(() => { M.readDelayFor = { roomT: 900 }; });
    await open('roomT', arr, { savePoint: old });
    await ev(() => { M.st5 = __savePoint.state(); M.p = __savePoint.handle('check-ignore', 'c1').catch(e => { M.tErr = e.message; }); });
    await wait(100);
    // v0.7.0-b2c: the room's memory comes from its memory file once the room is linked: while it is being checked the page has
    // none (no copy to change), and the 무시 waits for its turn.
    r = await ev(() => ({ st: M.st5, file: M.mem('roomT') }));
    ok(r.st === null && r.file === null, `5. 방 확인 중에는 화면에 기억이 없어 바뀔 것도 없음 (${JSON.stringify(r).slice(0, 60)})`);
    await ev(() => M.p);
    await wait(300);
    r = await ev(() => ({ page: __savePoint.home().st.check.issues[0].ignored, file: M.mem('roomT').check.issues[0].ignored, err: M.tErr || '' }));
    ok(r.page === true && r.file === true && !r.err, `5. 확인이 끝나면 무시가 차례대로 저장됨 (${r.err})`);
    await ev(() => { M.readDelayFor = null; });

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
