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


// v0.6.85 (review of v0.6.83–84):
// 1. A copy answered with success becomes the base for deletions, but a message this page deleted after that
//    copy left (SillyTavern saved the deletion before the answer came) is still this page's own deletion.
// 2. A room without a memory: SavePoint's request is refused, but SillyTavern saved the page with the change
//    and something more (a translation). The marks the change set decide: all in the file → kept (2, 2b: a 🔶
//    turned off is in when it is absent); all as before → taken back (2c); the message changed or moved → not
//    taken back, unconfirmed (2d).
// 3. A 200 without SillyTavern's success answer (a proxy's login page, an empty answer) is no answer: paused,
//    nothing more sent. SillyTavern's older answer ({ result: 'ok' }) is a success.
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
    const kept = (ev, i) => ev(i => ({ page: !!M.chat[i].extra?.savepointKeep, file: !!M.serverFiles.chatA[i + 1].extra?.savepointKeep }), i);

    // 1. The 🔶 write of 12 lands; before its answer comes back this page deletes #11 (SillyTavern saves the 11),
    //    then writes a new message (not saved yet). The answer arrives: the resend goes out, nothing blocked.
    for (const run of [true, false]) {
        const { page, ev } = await session({ run });
        await ev(() => { M.noStSave = false;
            const f = window.fetch; let k = 0;
            window.fetch = async (u, o) => { const r = await f(u, o); if (String(u) === '/api/chats/save' && ++k === 1) {
                M.chat.splice(11, 1); await SillyTavern.getContext().eventSource.emit('message_deleted', M.chat.length); M.stSave();
                M.noStSave = true; M.chat.push({ name: 'Me', is_user: true, is_system: false, mes: 'Written after the delete.', swipe_id: 0, extra: {} });
                await new Promise(x => setTimeout(x, 100)); } return r; };
        });
        const r1 = await keep(ev, 3);
        await page.waitForTimeout(500);
        const r = await ev(() => ({ n: M.serverFiles.chatA.length - 1, last: M.serverFiles.chatA.at(-1).mes, blocked: __savePoint.autoBlocked() }));
        ok(r1 === 'ok' && r.n === 12 && r.last === 'Written after the delete.' && (await kept(ev, 3)).file, `1(${run ? '기억' : '기억 없음'}). 응답 전에 이 화면에서 지운 메시지는 이 화면의 삭제: 다시 보내서 새 메시지까지 저장 (${r1.slice(0, 30)}, ${JSON.stringify(r)})`);
        await page.close();
    }
    // 2–2d. A room without a memory. SillyTavern saves the page first (2–2b: with the 🔶 set or turned off, and a new
    //    translation on #5; 2c: only the translation, before the 🔶; 2d: the 🔶 with #3 edited by hand); then
    //    SavePoint's own request gets SillyTavern's 500.
    for (const how of ['on', 'off', 'before', 'edited']) {
        const { page, ev } = await session({ run: false });
        if (how === 'off') { await keep(ev, 3); await ev(() => { M.saveBodies = []; }); }
        await ev(how => { M.noStSave = false; let n = 0;
            if (how === 'before') { M.chat[5].extra = { ...M.chat[5].extra, display_text: 'Translated.' }; M.stSave(); M.noStSave = true; M.failOnce = true; return; }
            M.beforeChatSave = async () => { if (++n !== 1) return;
                if (how === 'edited') M.chat[3].mes = 'Edited by hand.'; else M.chat[5].extra = { ...M.chat[5].extra, display_text: 'Translated.' };
                M.stSave(); M.noStSave = true; M.failOnce = true; }; }, how);
        const r1 = await keep(ev, 3);
        await page.waitForTimeout(300);
        const a = await kept(ev, 3);
        await ev(() => { M.beforeChatSave = null; M.noStSave = false; M.stSave(); });   // SillyTavern's next save of the page
        const b = await kept(ev, 3);
        const blocked = await ev(() => __savePoint.autoBlocked());
        if (how === 'on') ok(r1 === 'ok' && a.page && b.file, `2. 실리태번이 🔶를 먼저 저장(+다른 메시지 번역), SavePoint 요청은 500: 🔶 유지, 다음 저장 뒤에도 파일에 남음 (${r1.slice(0, 30)}, ${JSON.stringify(b)})`);
        else if (how === 'off') ok(r1 === 'ok' && !a.page && !b.file, `2b. 🔶 끄기도 같음: 표시 없음이 반영된 결과 (${r1.slice(0, 30)}, ${JSON.stringify(b)})`);
        else if (how === 'before') ok(/취소했어요/.test(r1) && !a.page && !b.file, `2c. 파일 전체는 다르지만 🔶가 없다고 확인됨: 되돌림 (${r1.slice(0, 30)})`);
        else ok(/Unconfirmed/.test(r1) && a.page && blocked === 'unsure', `2d. 그 메시지가 그사이 바뀌어 가릴 수 없음: 되돌리지 않고 확인 대기 (${r1.slice(0, 30)}, ${blocked})`);
        await page.close();
    }
    // 3. The write answered 200 with a page that is not SillyTavern's ({} too): paused, the next 🔶 sends nothing.
    //    3b: SillyTavern's older answer { result: 'ok' }: a success.
    for (const [n, body] of [['3', '<!DOCTYPE html><html><body>Login</body></html>'], ['3(빈 응답)', '{}'], ['3b', '{"result":"ok"}']]) {
        const { page, ev } = await session();
        await ev(([body, real]) => { const f = window.fetch; let k = 0;
            window.fetch = (u, o) => { if (String(u) !== '/api/chats/save' || ++k !== 1) return f(u, o);
                const answer = () => new Response(body, { status: 200, headers: { 'Content-Type': body.startsWith('<') ? 'text/html' : 'application/json' } });
                return real ? f(u, o).then(answer) : Promise.resolve(answer()); }; }, [body, n === '3b']);
        const r1 = await keep(ev, 3);
        const s0 = await ev(() => M.saveBodies.length);
        const r2 = await keep(ev, 5);
        const r = await ev(() => ({ sends: M.saveBodies.length, blocked: __savePoint.autoBlocked() }));
        if (n === '3b') ok(r1 === 'ok' && r2 === 'ok' && (await kept(ev, 5)).file, `3b. 예전 실리태번의 성공 응답({ result: 'ok' })은 성공 (${r1}, ${r2})`);
        else ok(/Unconfirmed/.test(r1) && /RoomBlocked: 응답을 받지 못한/.test(r2) && r.sends === s0 && r.blocked !== 'waiting' && !(await kept(ev, 3)).file, `${n}. 실리태번 성공 응답이 아닌 200: 성공으로 보지 않고 방 멈춤, 다음 🔶 보내지 않음 (${r1.slice(0, 24)} / ${r2.slice(0, 30)}, ${JSON.stringify(r)})`);
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
