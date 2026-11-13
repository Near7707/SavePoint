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

// v0.7.0-a1 (review of v0.7.0-a, P2-2): a recorded (and hidden) message is edited and a reply starts right away. Since
// v0.7.0-a the rollback this needs is made at a turn of the room's queue, and while a reply is being made that turn
// waits for it to end; the reply was made with the old briefing and with the edited message still hidden. Now the
// reply gets what the rollback will leave (v0.6.104 made the rollback at once): no briefing of the rolled-back part,
// the edited message shown. The memory itself changes at the turn, after the reply.
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, askResume: false } }; });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
    await page.waitForTimeout(300);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const look = () => ev(() => ({ inj: M.prompts.savepoint?.v || '', hidden: M.chat.filter(m => m.is_system).length, h5: !!M.chat[5].is_system, page: M.meta.savePoint.lastIndex, file: M.serverFiles.chatA[0].chat_metadata.savePoint.lastIndex }));
    let r;

    await ev(() => { M.add(30); });
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const chatA = await ev(() => JSON.parse(JSON.stringify(M.serverFiles.chatA)));
    r = await look();
    ok(r.page === 29 && r.hidden === 20 && r.h5 && r.inj.startsWith('[SavePoint memory'), `준비: #29까지 기록, 20개 하이드, 브리핑 있음 (${r.page}, ${r.hidden})`);

    for (const [label, gap, slow] of [['고치자마자', 0, false], ['되감기 저장이 파일 확인을 기다리는 중', 400, true]]) {
        await ev(f => { M.serverFiles.chatA = f; }, chatA);
        await ev(() => M.openFile('chatA'));
        await wait(800);
        if (slow) await ev(() => { M.readDelayFor = { chatA: 1500 }; });
        await ev(async () => {
            M.chat[5].mes = 'An edited early message.'; M.stSave();
            await SillyTavern.getContext().eventSource.emit('message_edited', 5);
        });
        await wait(gap);
        r = await ev(async () => {
            await SillyTavern.getContext().eventSource.emit('generation_started', 'normal', {}, false);
            return { inj: M.prompts.savepoint?.v || '', hidden: M.chat.filter(m => m.is_system).length, h5: !!M.chat[5].is_system, page: M.meta.savePoint.lastIndex };
        });
        ok(r.page === 29, `${label}: 준비: 생성 시작 때 기억은 아직 그대로 (#${r.page})`);
        ok(!r.h5 && r.hidden === 0, `${label}: 생성 시작 때 고친 메시지(#5)가 하이드에서 풀림 (하이드 ${r.hidden}개)`);
        ok(r.inj === '', `${label}: 생성 시작 때 되감길 기억은 브리핑에 넣지 않음 (${r.inj.length}자)`);
        await wait(500);
        await ev(() => { M.readDelayFor = null; return SillyTavern.getContext().eventSource.emit('generation_ended', M.chat.length); });
        await wait(2500);
        r = await look();
        ok(r.page === -1 && r.file === -1 && r.hidden === 0 && r.inj === '', `${label}: 생성이 끝나면 되감기가 저장됨 (화면 #${r.page}, 파일 #${r.file}, 하이드 ${r.hidden})`);
    }

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
