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


// v0.6.80 (review of v0.6.76–79):
// 1. The copy this page sent counts as its own only when the file is exactly that copy: a file that lost a
//    message since (deleted on another device) is not resent over (the deleted message is not brought back).
// 2–3. A request that got no answer (the connection dropped) may be in the file or still on its way: never
//    taken back. Found in the file → done; the file still as it was → unconfirmed (never "did not go in"),
//    and confirmed once it lands. 4. A refused request (the server answered with an error) is still taken back.
// 5–6. A room without a SavePoint memory (no receipt) is confirmed by the messages and marks written.
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
    const mine = { name: 'Me', is_user: true, is_system: false, mes: 'Written on this page.', swipe_id: 0, extra: {} };
    const toasts = ev => ev(() => toastr.log.slice(M.toastLog).map(x => x.join(': ')).join(' / '));
    const count = ev => ev(() => M.serverFiles.chatA.length - 1);
    // The first chat save: the request reaches the server after `land` ms (never: null), the page gets no answer.
    const noAnswer = (ev, land) => ev(land => {
        const f = window.fetch; let n = 0;
        window.fetch = (u, o) => {
            if (String(u) !== '/api/chats/save' || ++n !== 1) return f(u, o);
            if (land === 0) return f(u, o).then(() => { throw new TypeError('Failed to fetch'); });
            if (land !== null) setTimeout(() => { f(u, o); }, land);
            return Promise.reject(new TypeError('Failed to fetch'));
        };
    }, land);

    // 1. The first copy lands; this page edits #0 meanwhile (so the page is sent again) and another device
    //    deletes the last message. The file is no longer the copy sent → not resent, the room is blocked.
    {
        const { page, ev } = await session();
        await ev(() => {
            M.metaDelay = 300; let n = 0;
            M.beforeChatSave = async name => { if (++n === 1) {
                M.readDelayFor = { chatA: 150 };
                setTimeout(() => { M.noStSave = true; const m = M.chat[0]; m.mes = 'Edited here.'; m.swipes = [m.mes]; }, 100);
                setTimeout(() => { M.serverFiles[name].pop(); }, 360);
            } };
        });
        const before = await count(ev);
        const msg = await ev(() => __savePoint.transact(() => { __savePoint.state().probe = 'one'; }).then(() => 'ok', e => `${e.name}: ${e.message}`));
        await page.waitForTimeout(300);
        const r = await ev(() => ({ sends: M.saveBodies.length, probe: __savePoint.state().probe ?? null, blocked: __savePoint.autoBlocked() }));
        ok(await count(ev) === before - 1 && r.sends === 1, `1. 다른 기기에서 지운 메시지를 되살리지 않음 (파일 ${await count(ev)}개, 보낸 것 ${r.sends})`);
        ok(/RoomBlocked/.test(msg) && r.blocked === 'room', `1. 방을 막고 알림 (${msg.slice(0, 50)})`);
        ok(r.probe === 'one', '1. 첫 사본은 들어갔으니 화면의 변경은 그대로');
        await page.close();
    }
    // 2. The request reaches the file, only the answer is lost → done, nothing taken back.
    {
        const { page, ev } = await session();
        await noAnswer(ev, 0);
        const msg = await ev(() => __savePoint.transact(() => { __savePoint.state().probe = 'two'; }).then(() => 'ok', e => `${e.name}: ${e.message}`));
        const r = await ev(() => ({ page: __savePoint.state().probe ?? null, file: M.serverFiles.chatA[0].chat_metadata.savePoint.probe ?? null, blocked: __savePoint.autoBlocked() }));
        ok(msg === 'ok' && r.page === 'two' && r.file === 'two', `2. 응답만 끊김: 파일에서 찾아 성공 (${msg.slice(0, 40)}, ${JSON.stringify(r)})`);
        await page.close();
    }
    // 3. The request is still on its way when the file is read (it lands 4 s later) → kept on the page,
    //    unconfirmed, never "did not go in"; once it lands the next change confirms it and goes on.
    {
        const { page, ev } = await session();
        await noAnswer(ev, 4000);
        const msg = await ev(() => __savePoint.transact(() => { __savePoint.state().probe = 'three'; }).then(() => 'ok', e => `${e.name}: ${e.message}`));
        let r = await ev(() => ({ page: __savePoint.state().probe ?? null, file: M.serverFiles.chatA[0].chat_metadata.savePoint.probe ?? null, blocked: __savePoint.autoBlocked() }));
        ok(/Unconfirmed/.test(msg) && r.page === 'three' && r.file === null && r.blocked === 'unsure', `3. 아직 가는 중: 화면은 그대로, 확인 못 함 (${JSON.stringify(r)})`);
        await page.waitForTimeout(3500);
        ok(!/들어가지 않았어요/.test(await toasts(ev)), '3. 파일이 아직 그대로여도 "들어가지 않았어요"라고 하지 않음');
        await page.waitForTimeout(1000);
        const msg2 = await ev(() => __savePoint.transact(() => { __savePoint.state().probe2 = 'after'; }).then(() => 'ok', e => `${e.name}: ${e.message}`));
        r = await ev(() => ({ file: M.serverFiles.chatA[0].chat_metadata.savePoint.probe ?? null, file2: M.serverFiles.chatA[0].chat_metadata.savePoint.probe2 ?? null, blocked: __savePoint.autoBlocked() }));
        ok(msg2 === 'ok' && r.file === 'three' && r.file2 === 'after', `3. 늦게 들어간 뒤 확인하고 다음 변경 저장 (${msg2.slice(0, 40)}, ${JSON.stringify(r)})`);
        await page.close();
    }
    // 4. The server answers with an error → the change is taken back, as before.
    {
        const { page, ev } = await session();
        await ev(() => { M.failOnce = true; });
        const msg = await ev(() => __savePoint.transact(() => { __savePoint.state().probe = 'four'; }).then(() => 'ok', e => `${e.name}: ${e.message}`));
        const r = await ev(() => ({ page: __savePoint.state().probe ?? null, blocked: __savePoint.autoBlocked() }));
        ok(/취소했어요/.test(msg) && r.page === null && r.blocked !== 'unsure', `4. 서버가 거절: 되돌림 (${msg.slice(0, 40)})`);
        await page.close();
    }
    // 5. No memory in the room: 🔶 lands, the page changes meanwhile and the re-read fails → unconfirmed;
    //    once reads work again it is confirmed by the marks written (no receipt there).
    {
        const { page, ev } = await session({ run: false });
        await ev(m => { window.__mine = m; M.metaDelay = 400; let n = 0;
            M.beforeChatSave = async () => { if (++n === 1) { M.readDelayFor = { chatA: 150 };
                setTimeout(() => { M.noStSave = true; M.chat.push(window.__mine); }, 100);
                setTimeout(() => { M.serverError = true; }, 450); } }; }, mine);
        const msg = await ev(() => __savePoint.toggleKeep(3).then(() => 'ok', e => `${e.name}: ${e.message}`));
        ok(/Unconfirmed/.test(msg) && await ev(() => __savePoint.autoBlocked()) === 'unsure', `5. 기억 없는 방: 다시 읽기 실패 → 확인 못 함 (${msg.slice(0, 30)})`);
        await ev(() => { M.serverError = false; M.readDelayFor = null; });
        await page.waitForTimeout(3500);
        const r = await ev(() => ({ blocked: __savePoint.autoBlocked(), keep: !!M.serverFiles.chatA[4].extra?.savepointKeep }));
        ok(r.blocked !== 'unsure' && r.keep && /들어가 있는 걸 확인했어요/.test(await toasts(ev)), `5. 읽기가 돌아오면 보낸 표시로 확인 (${JSON.stringify(r)})`);
        await page.close();
    }
    // 6. No memory, and the answer to 🔶 is lost after it reached the file → done.
    {
        const { page, ev } = await session({ run: false });
        await noAnswer(ev, 0);
        const msg = await ev(() => __savePoint.toggleKeep(3).then(() => 'ok', e => `${e.name}: ${e.message}`));
        const r = await ev(() => ({ page: !!M.chat[3].extra?.savepointKeep, file: !!M.serverFiles.chatA[4].extra?.savepointKeep, blocked: __savePoint.autoBlocked() }));
        ok(msg === 'ok' && r.page && r.file && r.blocked !== 'unsure', `6. 기억 없는 방, 응답만 끊김: 보낸 표시로 성공 (${msg.slice(0, 40)}, ${JSON.stringify(r)})`);
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
