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
    // v0.6.61: one rule for every change decided before its turn (review of v0.6.60): rewind, QUICK, a load
    // waiting behind a loot, an unconfirmed checkpoint proved by its receipt, a check started while the room
    // is being checked, a stopped translation.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, hideMode: 'off', askResume: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, is_system: false, mes: `${tag} message ${i} ${'and more '.repeat(6)}.`, swipe_id: 0, swipes: [`${tag} message ${i} ${'and more '.repeat(6)}.`], extra: {} }));
    const file = (list, meta = {}) => JSON.parse(JSON.stringify([{ chat_metadata: meta }, ...list]));
    const open = async (id, list, meta = {}, serverFile = null) => {
        await ev(([id, f, l, m]) => { M.serverFiles[id] = f; return M.switchChat(id, l, m); }, [id, serverFile || file(list, meta), JSON.parse(JSON.stringify(list)), JSON.parse(JSON.stringify(meta))]);
        await wait(400);
    };
    const quickOf = () => ev(() => JSON.stringify(__savePoint.listSaves().find(x => x.quick && x.room === __savePoint.state()?.roomKey) || null));
    // A QUICK save to load from, and a memory to copy.
    await ev(() => { M.add(8); });
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const qid = await ev(() => __savePoint.listSaves().find(x => x.quick)?.id);
    const memory = await ev(() => JSON.parse(JSON.stringify(M.meta.savePoint)));
    ok(!!qid && memory?.mem?.scenes?.length > 0, '준비: QUICK과 기억');
    let r;

    // 1. [P2] a rewind approved while a reset waits for its file check: at its turn the rewind point is not the
    //    one it was asked about, so it does nothing (the reset and its own rewind point stay).
    await open('roomA', msgs(8, 'Ay'));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    await ev(() => { M.confirm = 1; toastr.log.length = 0; M.readDelayFor = { roomA: 800 }; M.p1 = __savePoint.handle('clear-room').catch(e => { M.e1 = e.message; }); });
    await wait(150);
    await ev(() => { M.p2 = __savePoint.undo().catch(e => { M.e2 = e.message; }); });
    await ev(() => Promise.all([M.p1, M.p2]));
    await wait(200);
    r = await ev(() => { const f = M.serverFiles.roomA[0].chat_metadata.savePoint; return { scenes: f.mem.scenes.length, undo: f.undoInfo?.kind || '', page: __savePoint.state().mem.scenes.length, t: toastr.log.map(x => x[1]).join(' | '), e: (M.e1 || '') + (M.e2 || '') }; });
    ok(r.scenes === 0 && r.page === 0 && r.undo === 'reset' && r.t.includes('되돌릴 지점이 바뀌어서') && !r.e, `1. 리셋을 기다리던 리와인드는 예전 대상을 적용하지 않음 (${r.scenes}, ${r.undo}, ${r.t.slice(-40)})`);
    await ev(() => { M.readDelayFor = null; });
    await ev(() => __savePoint.undo());
    await wait(300);
    r = await ev(() => M.serverFiles.roomA[0].chat_metadata.savePoint.mem.scenes.length);
    ok(r > 0, `1. 다시 누르면 리셋 전으로 되돌아감 (${r})`);

    // 2. [P2] hide off, the page has 8 messages and the file 9: a quick save with nothing new keeps the QUICK.
    await open('roomB', msgs(8, 'Bee'));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const quickB = await quickOf();
    await ev(() => { M.serverFiles.roomB.push({ name: 'Ari', is_user: false, is_system: false, mes: 'Written on another device.', swipe_id: 0, swipes: ['Written on another device.'], extra: {} }); toastr.log.length = 0; });
    await ev(() => __savePoint.summarize());
    await wait(400);
    r = { quick: await quickOf(), t: await ev(() => toastr.log.map(x => x[1]).join(' | ')) };
    ok(quickB !== 'null' && r.quick === quickB && r.t.includes('QUICK 백업도 바꾸지 않았어요'), `2. 서버가 더 최신이면 새 메시지 없는 퀵세이브도 QUICK을 바꾸지 않음 (${r.t.slice(-40)})`);
    //    … nor a scene close that the file check blocks
    await open('roomB2', msgs(8, 'Bo'));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const quickB2 = await quickOf();
    const openScene = await ev(() => __savePoint.state().mem.scenes.some(s => s.status === 'open'));
    await ev(() => { M.serverFiles.roomB2.push({ name: 'Ari', is_user: false, is_system: false, mes: 'Also from elsewhere.', swipe_id: 0, swipes: ['Also from elsewhere.'], extra: {} }); toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run-close'));
    await wait(400);
    r = await quickOf();
    ok(openScene && r === quickB2, `2. 관문에 막힌 장면 닫기도 QUICK을 바꾸지 않음 (${openScene})`);
    //    the usual quick save with nothing new still refreshes QUICK
    await open('roomB3', msgs(8, 'Bu'));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const quickB3 = await quickOf();
    await wait(20);
    await ev(() => __savePoint.summarize());
    await wait(400);
    r = await quickOf();
    ok(quickB3 !== 'null' && r !== 'null' && r !== quickB3, '2. 평소에는 새 메시지가 없어도 QUICK을 새로 저장');

    // 3. [P2] memory only, into a room without memory: a loot saved while the load waits for its file read stays.
    await open('roomC', msgs(6, 'Cee'));
    await ev(() => { M.readDelayFor = { roomC: 700 }; toastr.log.length = 0; });
    await ev(id => { M.p = __savePoint.loadSave(id); }, qid);
    await wait(100);
    await ev(() => __savePoint.addLoot(0, M.chat[0].mes.slice(0, 14)).catch(e => { M.e3 = e.message; }));
    await ev(() => M.p);
    await wait(300);
    r = await ev(() => ({ page: __savePoint.state()?.lootQueue?.length || 0, file: M.serverFiles.roomC[0].chat_metadata.savePoint?.lootQueue?.length || 0, scenes: M.serverFiles.roomC[0].chat_metadata.savePoint?.mem?.scenes?.length || 0, e: M.e3 || '' }));
    ok(r.page === 1 && r.file === 1 && r.scenes > 0 && !r.e, `3. 불러오기를 기다리는 사이 저장한 루팅이 남음 (${r.page}, ${r.file}, ${r.scenes})`);
    await ev(() => { M.readDelayFor = null; });
    //    … but a memory that appeared meanwhile stops it (the question was about an empty room)
    await open('roomC2', msgs(6, 'Cu'));
    await ev(() => { M.readDelayFor = { roomC2: 700 }; toastr.log.length = 0; });
    await ev(id => { M.p = __savePoint.loadSave(id); }, qid);
    await wait(100);
    await ev(m => { M.meta.savePoint = JSON.parse(JSON.stringify(m)); M.meta.savePoint.mem.scenes[0].title = 'Made meanwhile'; __savePoint.adoptPage(); M.stSave(); }, memory);
    await ev(() => M.p);
    r = await ev(() => ({ title: M.serverFiles.roomC2[0].chat_metadata.savePoint?.mem?.scenes?.[0]?.title, t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.title === 'Made meanwhile' && r.t.includes('바뀌어서'), `3. 그사이 기억이 생겼으면 불러오지 않음 (${r.title}, ${r.t.slice(0, 30)})`);
    await ev(() => { M.readDelayFor = null; });

    // 4. [P2] a checkpoint written but not confirmed; SillyTavern then saves the page with the "unconfirmed"
    //    note in it. The write is still found by its receipt.
    await open('roomD', msgs(4, 'Dee'));
    // v0.7.0-a: the checkpoint's start mark is its first write (at the room's turn); reads fail after the record's write.
    await ev(() => { M.add(8); M.readFailAfterNth = 2; toastr.log.length = 0; });
    await ev(() => __savePoint.summarize({ auto: true }));
    await wait(600);
    r = await ev(() => ({ b: __savePoint.autoBlocked(), last: __savePoint.state().autoLast?.status }));
    // v0.7.0-a (plan P2-3): the "unsure" result note is a memory change; with the room's writes stopped it is not
    // made (before: put on the page, then written by SillyTavern's own save — the path this version closes).
    ok(r.b === 'unsure' && r.last !== 'unsure', `4. 준비: 체크포인트 저장 확인 불가, 결과 메모는 기억에 넣지 않음 (${r.b}, ${r.last})`);
    await ev(() => { M.readFailAfterNth = 0; M.readFailAfterSave = false; M.serverError = false; M.add(1); toastr.log.length = 0; });
    r = await ev(() => M.serverFiles.roomD[0].chat_metadata.savePoint.autoLast?.status);
    ok(r !== 'unsure', `4. 실리태번 자체 저장이 SavePoint의 확인 불가 메모를 쓰지 않음 (${r})`);
    await wait(3600);
    r = await ev(() => ({ b: __savePoint.autoBlocked(), t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.b !== 'unsure' && r.t.includes('들어가 있는 걸 확인'), `4. 기록이 그대로면 확인 불가가 풀림 (${r.b}, ${r.t.slice(0, 30)})`);

    // 5. [P2] 기록 다시 확인 pressed while the room is still being checked: the first check is not blocked.
    const checked = JSON.parse(JSON.stringify(memory));
    checked.check = { at: 1, status: 'ok', scope: { records: [], segs: [] }, issues: [] };
    await ev(() => { M.readDelayFor = { roomE: 700 }; toastr.log.length = 0; });
    await open('roomE', msgs(6, 'Ee'), { savePoint: checked });
    await ev(() => { M.p = __savePoint.handle('check-rerun').catch(e => { M.e5 = e.message; }); });
    await ev(() => M.p);
    await wait(600);
    await ev(() => { M.readDelayFor = null; M.saves0 = M.saves; });
    await ev(() => __savePoint.toggleKeep(1).catch(e => { M.e5b = e.message; }));
    r = await ev(() => ({ mark: !!M.serverFiles.roomE[2].extra?.savepointKeep, e: (M.e5 || '') + (M.e5b || ''), t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.mark && !r.e && !r.t.includes('다른 기기에서'), `5. 방 확인 중 누른 기록 다시 확인이 방을 막지 않음 (${r.mark}, ${(r.e || r.t).slice(0, 30)})`);

    // 6. [P3] a translation stopped while its write waits for the file check is not saved.
    await open('roomF', msgs(6, 'Ef'));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    await ev(() => { M.readDelayFor = { roomF: 700 }; toastr.log.length = 0; M.p = __savePoint.handle('translate'); });
    await wait(300);
    await ev(() => __savePoint.handle('stop'));
    await ev(() => M.p);
    await wait(200);
    r = await ev(() => ({ file: JSON.stringify(M.serverFiles.roomF[0].chat_metadata.savePoint.mem).includes('한국어:'), page: JSON.stringify(__savePoint.state().mem).includes('한국어:'), t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(!r.file && !r.page && r.t.includes('중지했어요'), `6. 쓰기를 기다리는 사이 중지한 번역은 저장하지 않음 (${r.t.slice(0, 30)})`);
    await ev(() => { M.readDelayFor = null; });

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
