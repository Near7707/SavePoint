const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const EXT = process.env.EXT || path.resolve(__dirname, '../..');
const HERE = __dirname;

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

// v0.6.90 (review of v0.6.89): a write that may be in the file is judged against the copy of THIS write answered with
// success, or, when none was answered, against what was written. A file read during the write (SillyTavern was saving;
// the same content as before the write) is not a copy of this write.
// Reset-like write (verify). SillyTavern is saving when the request is about to leave: the file is read again (still the
// 12 messages from before). Then SillyTavern saves the page (the change and a 13th message), another tab deletes the
// 13th, and SavePoint's request gets SillyTavern's 500.
// 1. The read right after the 500 succeeds (settled at once). 1b. It fails; a later read settles it.
//    Both: the 13th deleted elsewhere is not written back, by the first 🔶 nor by the next one.
// 2. Same order without the deletion elsewhere: the write is in the file, no warning, the 🔶 after it saves.
// (A request answered with success stays the base: save-base.cjs 4–4b.)
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    async function session({ run = true } = {}) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: 'off' } }; });
        await page.goto(URL);
        await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
        await page.waitForTimeout(300);
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await ev(() => { M.add(12); });
        if (run) { await ev(() => __savePoint.handle('run')); await page.waitForTimeout(1500); }
        await ev(() => { M.saveBodies = []; M.toastLog = toastr.log.length; });
        return { page, ev };
    }
    const keep = (ev, i) => ev(i => __savePoint.toggleKeep(i).then(() => 'ok', e => `${e.name}: ${e.message}`), i);
    const toasts = ev => ev(() => toastr.log.slice(M.toastLog).map(x => String(x.msg ?? x)));
    const msg = t => ({ name: 'Me', is_user: true, is_system: false, mes: t, swipe_id: 0, extra: {} });

    // 1–1b, 2.
    for (const [name, readFails, deleteElsewhere] of [['1', false, true], ['1b', true, true], ['2', false, false]]) {
        const { page, ev } = await session();
        await ev(([readFails, del]) => { M.noStSave = true;
            M.beforeChatSave = async (n, data) => {
                M.beforeChatSave = null;
                M.serverFiles.chatA = JSON.parse(JSON.stringify(data));      // SillyTavern saved the page: the change and the 13th
                if (del) M.serverFiles.chatA.pop();                           // another tab deleted the 13th
                M.failOnce = true;                                            // SavePoint's request: SillyTavern's own 500
                M.readFailOnce = readFails;
            };
            const f = window.fetch; let armed = false;
            window.fetch = async (u, o) => {
                if (String(u) === '/api/chats/get' && armed && M.readFailOnce) { M.readFailOnce = false; return new Response('x', { status: 500 }); }
                const r = await f(u, o); if (String(u) === '/api/chats/save') armed = true; return r; };
        }, [readFails, deleteElsewhere]);
        const r1 = await ev(m => __savePoint.transact(() => { __savePoint.state().note = 'x'; M.chat.push(m);
            M.stScript.setChatSaving(true); setTimeout(() => M.stScript.setChatSaving(false), 150);
        }, { verify: true }).then(() => 'ok', e => `${e.name}: ${e.message}`), msg('Thirteenth.'));
        if (readFails) await page.waitForTimeout(3500);
        const r2 = await keep(ev, 5);
        await page.waitForTimeout(300);
        const r3 = await keep(ev, 7);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ n: M.serverFiles.chatA.length - 1, k5: !!M.serverFiles.chatA[6].extra?.savepointKeep, note: M.serverFiles.chatA[0].chat_metadata.savePoint?.note ?? null }));
        const warned = (await toasts(ev)).some(x => /다른 곳에서 지운/.test(x));
        if (deleteElsewhere) ok(f.n === 12 && !f.k5 && /다른 곳에서 지운/.test(r2) && /다른 곳에서 지운/.test(r3) && (readFails ? /Unconfirmed/.test(r1) && warned : /RoomBlocked: 이번 변경은 채팅 파일에 저장했어요/.test(r1)),
            `${name}. 실리태번 저장 중 다시 읽은 같은 파일은 기준이 아님: 다른 곳에서 지운 13번째를 다음 🔶 두 번 모두 되살리지 않음 (${r1.slice(0, 30)} / ${r2.slice(0, 30)} / ${r3.slice(0, 30)}, ${JSON.stringify(f)})`);
        else ok(r1 === 'ok' && r2 === 'ok' && f.n === 13 && f.k5 && f.note === 'x' && !warned,
            `${name}. 다른 곳 삭제가 없으면 경고 없이 이번 변경이 파일에 있고 🔶도 저장 (${r1.slice(0, 30)} / ${r2}, ${JSON.stringify(f)})`);
        await page.close();
    }
    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
