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


// v0.6.83 (review of v0.6.80–82):
// 1. The copy of a request answered with success is at once the base for deletions: a message it carried that
//    another device deleted is not brought back (by the resend, by the next 🔶; with and without a memory).
// 2. A request with no answer keeps the room paused whatever the file shows: no SavePoint write goes out until
//    the room is opened again, even after an earlier request was confirmed (2) and even when SillyTavern saved
//    the very same copy first (3, 3b: found by the later check). Opening the room again lets it save (9).
// 4–6. Gateway errors and a 500 that is not SillyTavern's are treated as no answer (paused, nothing taken back);
//    SillyTavern's own 500 ends the request and the file is read: the copy there → kept, not paused.
// 7. Settling uses the copy actually sent (a translation added while it waited for SillyTavern).
// 8. A first write that succeeded is kept when only the resend fails.
// 10. A request that fails while it is made ready (headers) sent nothing: taken back, not paused.
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
    const msg = t => ({ name: 'Me', is_user: true, is_system: false, mes: t, swipe_id: 0, extra: {} });
    const keep = (ev, i) => ev(i => __savePoint.toggleKeep(i).then(() => 'ok', e => `${e.name}: ${e.message}`), i);
    const texts = ev => ev(() => M.serverFiles.chatA.slice(1).map(m => m.mes));
    const sends = ev => ev(() => M.saveBodies.length);
    // The n-th chat save of this page: 'late' — no answer, it reaches the server `ms` later; 'cut' — it reaches
    // the server, the answer is lost; a number — it reaches the server and that status comes back (body: `body`).
    const answer = (ev, n, how, { ms = 3000, body = null } = {}) => ev(([n, how, ms, body]) => {
        const f = window.fetch; let k = 0;
        window.fetch = (u, o) => {
            if (String(u) !== '/api/chats/save' || ++k !== n) return f(u, o);
            if (how === 'late') { setTimeout(() => f(u, o), ms); return Promise.reject(new TypeError('Failed to fetch')); }
            if (how === 'cut') return f(u, o).then(() => { throw new TypeError('Failed to fetch'); });
            return f(u, o).then(() => new Response(JSON.stringify(body ?? {}), { status: how, headers: { 'Content-Type': 'application/json' } }));
        };
    }, [n, how, ms, body]);
    const ST_500 = { error: 'An error has occurred, see the console logs for more information.' };

    // 1. Server 12, page 13: the write of 13 succeeds; another device deletes the 13th; the page gets a 14th.
    for (const mode of ['resend', 'next', 'next-nomem']) {
        const { page, ev } = await session({ run: mode !== 'next-nomem' });
        await ev(m => { M.noStSave = true; M.chat.push(m); }, msg('Thirteenth, only on this page.'));
        if (mode === 'resend') await ev(m => { window.__m = m; M.metaDelay = 300; let n = 0;
            M.beforeChatSave = async name => { if (++n === 1) { M.readDelayFor = { chatA: 150 };
                setTimeout(() => { M.chat.push(window.__m); }, 100);
                setTimeout(() => { M.serverFiles[name].splice(13, 1); }, 360); } }; }, msg('Fourteenth.'));
        const r1 = await keep(ev, 3);
        let r2 = '';
        if (mode !== 'resend') { await ev(m => { M.serverFiles.chatA.splice(13, 1); M.chat.push(m); }, msg('Fourteenth.')); r2 = await keep(ev, 5); }
        await page.waitForTimeout(300);
        const f = await texts(ev);
        ok(!f.some(t => t.startsWith('Thirteenth')) && /RoomBlocked/.test(mode === 'resend' ? r1 : r2), `1(${mode}). 다른 기기에서 지운 13번째를 되살리지 않고 방을 멈춤 (파일 ${f.length}개, ${(mode === 'resend' ? r1 : r2).slice(0, 30)})`);
        await page.close();
    }
    // 2. The first write (🔶) succeeds; the page changes meanwhile; the resend of 13 gets no answer and lands 3 s
    //    later. The page goes on (a 14th, a second 🔶): nothing more is sent; the late request lands.
    for (const run of [true, false]) {
        const { page, ev } = await session({ run });
        await ev(m => { window.__m = m; M.metaDelay = 300; let n = 0;
            M.beforeChatSave = async () => { if (++n === 1) setTimeout(() => { M.noStSave = true; M.chat.push(window.__m); }, 100); }; }, msg('Thirteenth.'));
        await answer(ev, 2, 'late');
        const r1 = await keep(ev, 3);
        await ev(m => { M.metaDelay = 0; M.beforeChatSave = null; M.chat.push(m); }, msg('Fourteenth.'));
        const s0 = await sends(ev);
        const r2 = await keep(ev, 5);
        const r = await ev(() => ({ blocked: __savePoint.autoBlocked(), kept5: !!M.chat[5].extra?.savepointKeep, kept3: !!M.chat[3].extra?.savepointKeep }));
        ok(/RoomBlocked/.test(r2) && await sends(ev) === s0 && !r.kept5 && r.kept3 && r.blocked === 'room', `2(${run ? '기억' : '기억 없음'}). 응답 없는 재전송 뒤 다음 🔶는 보내지 않음, 첫 🔶는 화면에 남음 (${r1.slice(0, 20)} / ${r2.slice(0, 20)})`);
        await page.waitForTimeout(3300);
        const late = await texts(ev);
        ok(late.length === 13 && late[12] === 'Thirteenth.' && !(await ev(() => M.saveBodies.some(b => b.count >= 14))), `2(${run ? '기억' : '기억 없음'}). 늦게 온 요청이 도착해도 SavePoint가 보낸 14개짜리 저장은 없음 (파일 ${late.length}개)`);
        await page.close();
    }
    // 3. The same, but SillyTavern saves the very same 13 first (1 s), so the file shows that copy before the
    //    late request lands: the room stays paused anyway.
    {
        const { page, ev } = await session();
        await ev(m => { window.__m = m; M.metaDelay = 300; let n = 0;
            M.beforeChatSave = async () => { if (++n === 1) setTimeout(() => { M.chat.push(window.__m); }, 100); }; }, msg('Thirteenth.'));
        await answer(ev, 2, 'late', { ms: 3000 });
        await keep(ev, 3);
        await page.waitForTimeout(1000);
        await ev(() => { M.metaDelay = 0; M.beforeChatSave = null; M.noStSave = false; M.stSave(); });
        await page.waitForTimeout(3500);   // the unconfirmed check runs (3 s) and finds the same copy
        await ev(m => { M.noStSave = true; M.chat.push(m); }, msg('Fourteenth.'));
        const s0 = await sends(ev);
        const r2 = await keep(ev, 5);
        ok(/RoomBlocked/.test(r2) && await sends(ev) === s0 && await ev(() => __savePoint.autoBlocked()) === 'room', `3. 실리태번이 같은 사본을 먼저 저장해도 보류 유지, 다음 저장 안 보냄 (${r2.slice(0, 30)})`);
        await page.close();
    }
    // 3b. The first request itself gets no answer (it lands 4.5 s later); SillyTavern saves the same page at 1 s,
    //     so the unconfirmed check (3 s) finds the change in the file: confirmed, but still paused.
    {
        const { page, ev } = await session();
        await answer(ev, 1, 'late', { ms: 4500 });
        const r1 = await keep(ev, 3);
        await page.waitForTimeout(1000);
        await ev(() => M.stSave());
        await page.waitForTimeout(2800);
        const t = await ev(() => toastr.log.slice(M.toastLog).map(x => x.join(':')).join(' / '));
        await ev(m => { M.noStSave = true; M.chat.push(m); }, msg('Thirteenth.'));
        const s0 = await sends(ev);
        const r2 = await keep(ev, 5);
        ok(/Unconfirmed/.test(r1) && /들어가 있어요/.test(t) && /RoomBlocked/.test(r2) && await sends(ev) === s0, `3b. 첫 요청이 응답 없음 → 같은 사본으로 확인돼도 보류 유지 (${r2.slice(0, 30)})`);
        await page.waitForTimeout(2000);
        await page.close();
    }
    // 4–6. A gateway's 504, a 500 that is not SillyTavern's (after the write reached the file), SillyTavern's own 500.
    for (const [n, status, body, paused] of [[4, 504, null, true], [5, 500, { error: 'Bad gateway upstream' }, true], [6, 500, ST_500, false]]) {
        const { page, ev } = await session();
        await answer(ev, 1, status, { body });
        const r1 = await keep(ev, 3);
        const r = await ev(() => ({ page: !!M.chat[3].extra?.savepointKeep, file: !!M.serverFiles.chatA[4].extra?.savepointKeep, blocked: __savePoint.autoBlocked() }));
        ok(r.page && r.file && (paused ? r.blocked === 'room' : r.blocked !== 'room' && r.blocked !== 'unsure'), `${n}. ${status}${body ? ' (' + body.error.slice(0, 14) + ')' : ''}: 파일에 들어간 🔶는 화면에 남고 ${paused ? '방은 멈춤' : '평소대로'} (${r1.slice(0, 30)}, ${JSON.stringify(r)})`);
        await page.close();
    }
    // 7. No memory: 🔶 waits for SillyTavern's save; a translation is added and saved meanwhile, so the copy
    //    sent carries it; that copy lands and SillyTavern's own 500 comes back → found in the file, kept.
    {
        const { page, ev } = await session({ run: false });
        await ev(() => { M.readDelayFor = { chatA: 300 }; setTimeout(() => M.stScript.setChatSaving(true), 150);
            setTimeout(() => { M.readDelayFor = null; M.chat[3].extra = { ...(M.chat[3].extra || {}), display_text: 'Translated.' }; M.stSave(); M.stScript.setChatSaving(false); }, 600); });
        await answer(ev, 1, 500, { body: ST_500 });
        const r1 = await keep(ev, 3);
        const r = await ev(() => ({ blocked: __savePoint.autoBlocked(), keep: !!M.serverFiles.chatA[4].extra?.savepointKeep, tr: M.serverFiles.chatA[4].extra?.display_text ?? null, page: !!M.chat[3].extra?.savepointKeep }));
        ok(r1 === 'ok' && r.keep && r.tr === 'Translated.' && r.page && r.blocked !== 'unsure', `7. 실제 보낸 사본(번역 포함)으로 확인 (${r1.slice(0, 30)}, ${JSON.stringify(r)})`);
        await page.close();
    }
    // 8. The first write succeeds; the page changes meanwhile; the resend gets SillyTavern's 500 → the first
    //    change stays on the page.
    {
        const { page, ev } = await session();
        await ev(m => { window.__m = m; M.metaDelay = 300; let n = 0;
            M.beforeChatSave = async () => { if (++n === 1) setTimeout(() => { M.noStSave = true; M.chat.push(window.__m); }, 100); }; }, msg('Thirteenth.'));
        await ev(() => { M.failNth = 2; });
        const r1 = await ev(() => __savePoint.transact(() => { __savePoint.state().probe = 'eight'; }).then(() => 'ok', e => `${e.name}: ${e.message}`));
        const r = await ev(() => ({ page: __savePoint.state().probe ?? null, file: M.serverFiles.chatA[0].chat_metadata.savePoint.probe ?? null }));
        ok(r.page === 'eight' && r.file === 'eight', `8. 첫 저장 성공 뒤 재전송만 실패: 첫 변경은 화면에 남음 (${r1.slice(0, 30)})`);
        await page.close();
    }
    // 9. Paused by a lost answer; the room is opened again → it saves again.
    {
        const { page, ev } = await session();
        await answer(ev, 1, 'cut');
        await keep(ev, 3);
        ok(await ev(() => __savePoint.autoBlocked()) === 'room', '9. 응답 끊김 → 방 멈춤');
        await ev(() => M.openFile('chatA'));
        await page.waitForTimeout(800);
        const r2 = await keep(ev, 5);
        ok(r2 === 'ok' && await ev(() => !!M.serverFiles.chatA[6].extra?.savepointKeep), `9. 방을 다시 열면 다시 저장 (${r2.slice(0, 30)})`);
        await page.close();
    }
    // 10. Making the request ready fails (headers): nothing was sent → taken back, not paused.
    {
        const { page, ev } = await session();
        await ev(() => { M.headerThrowNth = 2; });   // 1: the file check before the write, 2: the write itself
        const r1 = await keep(ev, 3);
        const r = await ev(() => ({ page: !!M.chat[3].extra?.savepointKeep, sends: M.saveBodies.length, blocked: __savePoint.autoBlocked() }));
        ok(!r.page && r.sends === 0 && r.blocked !== 'room' && r.blocked !== 'unsure', `10. 요청 준비 오류: 보낸 것 없음, 되돌림, 방은 평소대로 (${r1.slice(0, 30)}, ${JSON.stringify(r)})`);
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
