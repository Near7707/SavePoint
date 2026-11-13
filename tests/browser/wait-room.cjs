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

// v0.7.0-a1 (review of v0.7.0-a, P1): a save belongs to the room it was started in. The waits v0.7.0-a added before a
// save's first request (the checkpoint's start mark, a changed original waiting for a reply) and between a failed
// checkpoint's two notes could outlast a room change: the save then read and sent the other room's messages, and
// saved its memory; a failure note landed in a branch that carries the same memory line.
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: 'off', askResume: false, autoReserve: 0 } }; });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
    await page.waitForTimeout(300);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, is_system: false, mes: `${tag} message ${i} ${'and more '.repeat(6)}.`, swipe_id: 0, swipes: [`${tag} message ${i} ${'and more '.repeat(6)}.`], extra: {} }));
    // Holds the next chat file write whose metadata passes `test` (a function body over `st`, the memory sent) until
    // M.release(); M.held says it is being held.
    const hold = test => ev(src => {
        const f = new Function('st', src);
        M.held = false;
        M.beforeChatSave = async (name, data) => {
            if (M.held || !f(data[0]?.chat_metadata?.savePoint)) return;
            M.held = name;
            await new Promise(r => { M.release = r; });
        };
    }, test);
    const settle = () => ev(() => { M.beforeChatSave = null; M.release?.(); });

    // Room A and room B, each with a memory of its first 8 messages, and new messages after it.
    await ev(() => { M.add(8); });
    await ev(() => __savePoint.handle('run'));
    await wait(1200);
    await ev(([l]) => { M.serverFiles.roomB = JSON.parse(JSON.stringify([{ chat_metadata: {} }, ...l])); return M.openFile('roomB'); }, [msgs(8, 'Bee')]);
    await wait(500);
    await ev(() => __savePoint.handle('run'));
    await wait(1200);
    await ev(() => M.add(6, i => `Bee new ${i} ${'words '.repeat(8)}`));
    await wait(300);
    const b0 = await ev(() => ({ page: __savePoint.state()?.lastIndex, file: M.serverFiles.roomB[0].chat_metadata.savePoint?.lastIndex }));
    await ev(() => M.openFile('chatA'));
    await wait(500);
    await ev(() => M.add(6, i => `Ay new ${i} ${'words '.repeat(8)}`));
    await wait(300);
    const a0 = await ev(() => __savePoint.state()?.lastIndex);
    const roomB = await ev(() => JSON.parse(JSON.stringify(M.serverFiles.roomB)));
    ok(a0 === 7 && b0.page === 7 && b0.file === 7, `준비: 두 방 모두 #7까지 기록, 새 메시지 6개씩 (${a0}, ${b0.page}, ${b0.file})`);
    const beeSent = c0 => ev(c => M.calls.slice(c).filter(p => p.includes('Bee new')).length, c0);
    let r, c0;

    // 1. A checkpoint in room A waits for its start mark to be written; room B is opened meanwhile.
    c0 = await ev(() => M.calls.length);
    await hold('return !!st?.autoAttemptAt');
    await ev(() => { M.p = __savePoint.summarize({ auto: true }); });
    await page.waitForFunction(() => M.held, null, { timeout: 5000 });
    await ev(() => M.openFile('roomB'));
    await wait(500);
    await settle();
    await ev(() => M.p);
    await wait(1200);
    r = await ev(c => ({ calls: M.calls.length - c, page: __savePoint.state()?.lastIndex, file: M.serverFiles.roomB[0].chat_metadata.savePoint?.lastIndex }), c0);
    ok(await beeSent(c0) === 0, `1. 시작 표시를 쓰는 사이 B방으로 옮김: B방 메시지를 요약 AI로 보내지 않음 (요청 ${r.calls}개)`);
    ok(r.page === 7 && r.file === 7, `1. B방 기억은 그대로 (화면 #${r.page}, 파일 #${r.file})`);

    // 2. A quick save in room A waits for a changed original (a reply is being made); room B is opened meanwhile and
    //    the reply ends there.
    await ev(() => M.openFile('chatA'));
    await wait(600);
    await ev(f => { M.serverFiles.roomB = f; }, roomB);           // each case starts from the same room B
    // A connection profile: a save may then run while a reply is being made.
    await ev(() => {
        M.settings.connectionManager = { profiles: [{ id: 'p', name: 'Side', mode: 'cc' }] };
        M.settings.savePoint.profileId = 'p';
        M.cm = { sendRequest: (id, payload) => SillyTavern.getContext().generateRaw({ prompt: payload[0].content }) };
    });
    c0 = await ev(() => M.calls.length);
    await ev(async () => {
        await SillyTavern.getContext().eventSource.emit('generation_started', 'normal', {}, false);
        M.chat[2].mes = 'Edited text of an early message.'; M.stSave();
        await SillyTavern.getContext().eventSource.emit('message_edited', 2);
    });
    await wait(400);
    await ev(() => { M.p = __savePoint.handle('run'); });
    await wait(300);
    await ev(() => M.openFile('roomB'));
    await wait(500);
    await ev(() => SillyTavern.getContext().eventSource.emit('generation_ended', M.chat.length));
    await ev(() => M.p);
    await wait(2500);
    r = await ev(c => ({ calls: M.calls.length - c, page: __savePoint.state()?.lastIndex, file: M.serverFiles.roomB[0].chat_metadata.savePoint?.lastIndex }), c0);
    ok(await beeSent(c0) === 0, `2. 원문 변경 처리를 기다리는 사이 B방으로 옮김: B방 메시지를 보내지 않음 (요청 ${r.calls}개)`);
    ok(r.page === 7 && r.file === 7, `2. B방 기억은 그대로 (화면 #${r.page}, 파일 #${r.file})`);
    await ev(() => { M.settings.savePoint.profileId = ''; });

    // 3. A failed checkpoint in room A: while its failure note is being written, a branch of A (the same memory line)
    //    is opened. The result note ("체크포인트 실패") is not written there.
    await ev(() => M.openFile('chatA'));
    await wait(1500);
    const branch = await ev(() => M.branchChat('Branch of A', M.chat.length - 1));
    await ev(() => { M.stSave(); });
    await wait(300);
    await hold('return !!st?.autoFail');
    await ev(() => { M.badJson = true; M.p = __savePoint.summarize({ auto: true }); });
    await page.waitForFunction(() => M.held, null, { timeout: 8000 });
    await ev(b => { M.badJson = false; return M.openFile(b); }, branch);
    await wait(600);
    await settle();
    await ev(() => M.p);
    await wait(1500);
    r = await ev(b => ({ same: __savePoint.state()?.line === JSON.parse(JSON.stringify(M.serverFiles.chatA[0].chat_metadata.savePoint)).line,
        page: __savePoint.state()?.autoLast?.status || null, file: M.serverFiles[b][0].chat_metadata.savePoint?.autoLast?.status || null,
        a: M.serverFiles.chatA[0].chat_metadata.savePoint?.autoFail ? 'fail' : null }), branch);
    ok(r.same, '3. 준비: 갈래 방은 A방과 같은 기억 줄');
    ok(r.page !== 'failed' && r.file !== 'failed', `3. A방의 체크포인트 실패 결과가 갈래 방에 기록되지 않음 (화면 ${r.page}, 파일 ${r.file})`);
    ok(r.a === 'fail', '3. A방에는 실패 기록이 남음');

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
