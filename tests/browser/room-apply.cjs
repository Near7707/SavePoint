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
    // v0.6.62: what a change is checked against, and what happens when applying it fails (review of v0.6.61):
    // a load question while the memory is edited, an edit waiting behind a load, an error while applying.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, askResume: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const fileMem = () => ev(() => M.serverFiles[M.chatId]?.[0]?.chat_metadata?.savePoint?.mem || null);
    await ev(() => { M.add(8); });
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const qid = await ev(() => __savePoint.listSaves().find(x => x.quick)?.id);
    const title0 = await ev(() => __savePoint.state().mem.scenes[0]?.title);
    ok(!!qid && !!title0, '준비: QUICK과 장면');
    let r;

    // 1. [P2] the memory is edited (and saved) while the load's question is open: the load stops.
    await ev(() => {
        M.confirm = 1; toastr.log.length = 0;
        M.onPopup = async text => { if (text.includes('세이브 슬롯으로 바꿀까요')) { M.onPopup = null; await __savePoint.commitEdit(m => { m.scenes[0].title = 'Renamed while asked'; }); } };
    });
    await ev(id => __savePoint.loadSave(id), qid);
    await wait(300);
    r = { page: await ev(() => __savePoint.state().mem.scenes[0].title), file: (await fileMem())?.scenes?.[0]?.title, t: await ev(() => toastr.log.map(x => x[1]).join(' | ')) };
    ok(r.page === 'Renamed while asked' && r.file === r.page && r.t.includes('대화나 기억이 바뀌어서'), `1. 확인창이 열린 동안 고친 기억은 불러오기가 덮지 않음 (${r.file}, ${r.t.slice(-30)})`);
    await ev(() => { M.onPopup = null; });
    //    without an edit, the same load goes ahead
    await ev(id => __savePoint.loadSave(id), qid);
    await wait(300);
    r = (await fileMem())?.scenes?.[0]?.title;
    ok(r === title0, `1. 그대로면 불러오기는 평소대로 (${r})`);

    // 2. [P2] an edit waiting behind a load in the room's queue is not applied to the loaded memory, even
    //    though its scene has the same id.
    await ev(() => { M.readDelayFor = { [M.chatId]: 500 }; toastr.log.length = 0; M.e2 = ''; });
    await ev(id => { M.p = __savePoint.loadSave(id); }, qid);
    await wait(700);                                 // the load is in the queue, waiting for its turn's file read
    await ev(() => { M.p2 = __savePoint.commitEdit(m => { m.scenes[0].title = 'Edited the old memory'; }).catch(e => { M.e2 = e.message; }); });
    await ev(() => Promise.all([M.p, M.p2]));
    await wait(200);
    await ev(() => { M.readDelayFor = null; });
    r = { file: (await fileMem())?.scenes?.[0]?.title, page: await ev(() => __savePoint.state().mem.scenes[0].title), e: await ev(() => M.e2) };
    ok(r.file === title0 && r.page === title0 && r.e.includes('통째로 바뀌어서'), `2. 불러오기 뒤에 기다리던 예전 편집은 새 기억에 들어가지 않음 (${r.file}, ${r.e.slice(0, 20)})`);
    //    an edit pressed on the loaded memory applies as usual
    await ev(() => __savePoint.commitEdit(m => { m.scenes[0].title = 'Edited after load'; }));
    await wait(300);
    r = (await fileMem())?.scenes?.[0]?.title;
    ok(r === 'Edited after load', `2. 새 기억에서 누른 편집은 평소대로 (${r})`);

    // 3. [P2] an error while a change is applied: the page goes back, so SillyTavern's next own save keeps
    //    the memory the file had.
    const before = await fileMem();
    await ev(() => { toastr.log.length = 0; M.e3 = ''; });
    await ev(() => __savePoint.transact(() => { const st = __savePoint.state(); st.mem = { ...st.mem, scenes: [] }; throw new Error('half done'); }).catch(e => { M.e3 = e.message; }));
    await ev(() => M.stSave());
    r = { page: await ev(() => __savePoint.state().mem.scenes.length), file: (await fileMem())?.scenes?.length, e: await ev(() => M.e3) };
    ok(r.page === before.scenes.length && r.file === before.scenes.length && r.e.includes('적용하다 오류'), `3. 적용 중 오류면 화면도 되돌아가 다음 자체 저장이 빈 기억을 쓰지 않음 (${r.page}, ${r.file})`);
    //    a failing prompt refresh does not decide the change: a reset still happens and is saved
    await ev(() => { M.confirm = 1; M.promptThrow = 1; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('clear-room').catch(e => { M.e3b = e.message; }));
    await wait(300);
    r = { page: await ev(() => __savePoint.state().mem.scenes.length), file: (await fileMem())?.scenes?.length, undo: await ev(() => M.serverFiles[M.chatId][0].chat_metadata.savePoint.undoInfo?.kind), e: await ev(() => M.e3b || '') };
    ok(r.page === 0 && r.file === 0 && r.undo === 'reset' && !r.e, `3. 프롬프트 갱신 오류는 리셋 저장을 막지 않음 (${r.page}, ${r.file}, ${r.e})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
