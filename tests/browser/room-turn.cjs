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
    // v0.6.60: each change checked again at its turn (review of v0.6.59): what was approved or read is still
    // what the page shows, a confirmed save only becomes the base when the page still covers it, and the
    // first read of a room compares its memory too.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, hideMode: 'off', askResume: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, is_system: false, mes: `${tag} message ${i} ${'and more '.repeat(6)}.`, swipe_id: 0, swipes: [`${tag} message ${i} ${'and more '.repeat(6)}.`], extra: {} }));
    const file = (list, meta = {}) => JSON.parse(JSON.stringify([{ chat_metadata: meta }, ...list]));
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
    const memory = await ev(() => JSON.parse(JSON.stringify(M.meta.savePoint)));
    ok(!!qid && memory?.mem?.scenes?.length > 0, '준비: QUICK과 기억');
    let r;

    // 1. [P1] continue approved in a greeting-only room; while it waits in the room's queue the first message
    //    is edited and a second one is saved. The edited first message is never replaced.
    const greet = { name: 'Ari', is_user: false, is_system: false, mes: 'Hello! This is the very first greeting.', swipe_id: 0, swipes: ['Hello! This is the very first greeting.'], extra: {} };
    await open('roomP', [greet]);
    await ev(() => { M.confirm = 1; toastr.log.length = 0; M.metaDelay = 900; __savePoint.persistSoon(); });
    await wait(450);                                 // the small save holds the queue
    await ev(id => { M.p = __savePoint.loadSave(id); }, qid);
    await wait(250);                                 // asked, checked and waiting its turn
    await ev(() => { const m = M.chat[0]; m.mes = 'An edited first line written here.'; m.swipes = [m.mes]; M.add(1); });
    await ev(() => M.p);
    await wait(300);
    r = await ev(() => ({ page: M.chat[0].mes, file: M.serverFiles.roomP[1].mes, n: M.serverFiles.roomP.length - 1, mem: !!M.serverFiles.roomP[0].chat_metadata.savePoint, t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.page === 'An edited first line written here.' && r.file === r.page && r.n === 2 && !r.mem && r.t.includes('확인하는 사이 대화나 기억이 바뀌어서'),
        `1. 이어하기를 기다리는 사이 고친 첫 메시지는 덮지 않음 (${r.file.slice(0, 16)}, ${r.n}, ${r.t.slice(0, 30)})`);
    await ev(() => { M.metaDelay = 0; });
    //    the same continue with nothing changed still works
    await open('roomP2', [greet]);
    await ev(id => __savePoint.loadSave(id), qid);
    await wait(300);
    r = await ev(() => ({ file: M.serverFiles.roomP2[1].mes, mem: !!M.serverFiles.roomP2[0].chat_metadata.savePoint }));
    ok(r.file !== greet.mes && r.mem, '1. 그대로면 이어하기는 평소대로');

    // 2. [P2] an unconfirmed save is found in the file, but another device deleted the last message since:
    //    that file does not become the base, and the message does not come back.
    await open('roomQ', msgs(20, 'Que'));
    await ev(() => { M.readFailAfterSave = true; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    r = await ev(() => __savePoint.autoBlocked());
    ok(r === 'unsure', `2. 준비: 저장 확인 불가 (${r})`);
    await ev(() => { M.readFailAfterSave = false; M.serverError = false; M.serverFiles.roomQ.pop(); M.saves0 = M.saves; toastr.log.length = 0; });
    await wait(3600);                                // the 3-second re-read
    await ev(() => __savePoint.persistSoon());
    await wait(800);
    await ev(() => __savePoint.toggleKeep(2).catch(e => { M.qErr = e.message; }));
    r = await ev(() => ({ n: M.serverFiles.roomQ.length - 1, saves: M.saves - M.saves0, t: toastr.log.map(x => x[1]).join(' | '), err: M.qErr || '' }));
    ok(r.n === 19 && r.saves === 0 && r.t.includes('들어가 있어요') && r.err.includes('지운 메시지'), `2. 확인한 저장 뒤 다른 곳에서 지운 메시지가 되살아나지 않음 (${r.n}, ${r.saves}, ${r.err.slice(0, 20)})`);
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

    // 3. [P2] the page loaded an older memory; by the room's first read another device had saved a newer one.
    const newer = JSON.parse(JSON.stringify(memory)); newer.by = 'other-device';
    const older = JSON.parse(JSON.stringify(memory)); older.mem.scenes = []; older.mem.records = [];
    const arr = msgs(6, 'Ar');
    await ev(() => { toastr.log.length = 0; });
    await open('roomR', arr, { savePoint: older }, file(arr, { savePoint: newer }));
    await ev(() => { M.saves0 = M.saves; __savePoint.persistSoon(); });
    await wait(700);
    await ev(() => __savePoint.toggleKeep(1).catch(e => { M.rErr = e.message; }));
    r = await ev(() => ({ scenes: M.serverFiles.roomR[0].chat_metadata.savePoint.mem.scenes.length, saves: M.saves - M.saves0, err: M.rErr || '' }));
    ok(r.scenes > 0 && r.saves === 0 && r.err.includes('다른 기기에서'), `3. 방을 열 때 서버 기억이 더 새로우면 덮어쓰지 않음 (${r.scenes}, ${r.saves}, ${r.err.slice(0, 20)})`);
    //    the same memory on both sides opens as usual
    await open('roomR2', arr, { savePoint: older });
    await ev(() => { M.saves0 = M.saves; });
    await ev(() => __savePoint.toggleKeep(1).catch(e => { M.r2Err = e.message; }));
    r = await ev(() => ({ saves: M.saves - M.saves0, err: M.r2Err || '' }));
    ok(r.saves === 1 && !r.err, `3. 같은 기억이면 평소대로 (${r.err})`);

    // 4. [P2] a quick save whose last unrecorded message is edited (and saved) while the save waits for its
    //    file check: nothing is recorded from the old text, and no "done".
    await open('roomS', msgs(6, 'Ess'));
    await ev(() => { M.readDelayFor = { roomS: 900 }; M.delay = 200; toastr.log.length = 0; M.p = __savePoint.summarize(); });
    await wait(550);                                 // the AI answered; the write waits for its file read
    await ev(() => { const m = M.chat[5]; m.mes = 'The last line, rewritten while saving.'; m.swipes = [m.mes]; M.stSave(); });
    await ev(() => M.p);
    await wait(200);
    r = await ev(() => ({ last: __savePoint.state()?.lastIndex ?? -1, file: M.serverFiles.roomS[0].chat_metadata.savePoint?.lastIndex ?? -1, t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.last === -1 && r.file === -1 && !r.t.includes('퀵세이브 완료') && r.t.includes('바뀌어서'), `4. 저장을 기다리는 사이 고친 메시지는 예전 원문으로 기록하지 않음 (${r.last}, ${r.t.slice(0, 40)})`);
    await ev(() => { M.readDelayFor = null; M.delay = 0; });
    await ev(() => __savePoint.summarize());
    await wait(300);
    r = await ev(() => __savePoint.state()?.lastIndex);
    ok(r === 5, `4. 다시 누르면 고친 원문으로 저장 (${r})`);

    // 5. [P3] an old-format memory read while the room is being checked: a result marked 무시 there never
    //    reaches the room's metadata before the room is confirmed, and is then saved through the queue.
    const old = JSON.parse(JSON.stringify(memory));
    old.mem.evidenceVersion = 0;
    old.check = { at: 1, status: 'done', scope: { from: 0, to: 5 }, issues: [{ id: 'c1', about: old.mem.records[0]?.id || 'r1', kind: 'partial', ignored: false, note: 'A note.' }] };
    await ev(() => { M.readDelayFor = { roomT: 900 }; });
    await open('roomT', arr, { savePoint: old });
    await ev(() => { __savePoint.state().check.issues[0].note = 'changed on the copy'; M.p = __savePoint.handle('check-ignore', 'c1').catch(e => { M.tErr = e.message; }); });
    await wait(100);
    r = await ev(() => ({ ignored: M.meta.savePoint.check.issues[0].ignored, note: M.meta.savePoint.check.issues[0].note }));
    ok(r.ignored === false && r.note === 'A note.', `5. 방 확인 중에는 원본 기록 확인 결과가 바뀌지 않음 (${r.ignored}, ${r.note})`);
    await ev(() => M.p);
    await wait(300);
    r = await ev(() => ({ page: M.meta.savePoint.check.issues[0].ignored, file: M.serverFiles.roomT[0].chat_metadata.savePoint.check.issues[0].ignored, err: M.tErr || '' }));
    ok(r.page === true && r.file === true && !r.err, `5. 확인이 끝나면 무시가 차례대로 저장됨 (${r.err})`);
    await ev(() => { M.readDelayFor = null; });

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
