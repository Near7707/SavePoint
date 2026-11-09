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

// v0.6.91 (review of v0.6.90):
// 1–1b. While a reset-like write (verify) waits for SillyTavern, a 13th message comes and SillyTavern saves the page (this
//    change and 13 messages); SavePoint reads that file before sending. Then another tab deletes the 13th and SavePoint's
//    request gets SillyTavern's 500. The file read during the write holds it: it is the base (not the 12 messages written),
//    so the 13th deleted elsewhere is not written back by the next 🔶. 1: settled at once, 1b: by a later read.
// 1c. The same without the deletion elsewhere: no warning, the 🔶 saves.
// 2–2b. A background save of status marks only (no new receipt) gets the 500 while a 13th message is on the page but not in
//    the file yet: not taken for "saved" (the file still has the receipt), no "deleted elsewhere"; the next 🔶 saves the 13th.
//    2b: the same after a wait for SillyTavern's save (something may have landed): not left unconfirmed either.
// 3. A first request landed; then a continue starts and SillyTavern saves a middle state of it. The check before sending
//    again finds the reply running ahead: held back ('busy'), no warning, and the room is open again after the reply.
// (5–7: v0.6.92, below.)
// 4. A background save held back by a reply (it was reading the file when the reply started) goes through after the reply
//    even when a message event opens the room before the recheck timer.
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

    // 1–1c.
    for (const [name, readFails, del] of [['1', false, true], ['1b', true, true], ['1c', false, false]]) {
        const { page, ev } = await session();
        await ev(([readFails, del]) => { M.noStSave = true;
            M.beforeChatSave = async () => {
                M.beforeChatSave = null;
                if (del) M.serverFiles.chatA.pop();                               // another tab deletes the 13th
                M.failOnce = true; M.readFailOnce = readFails;                    // SavePoint's request: SillyTavern's 500
            };
            const f = window.fetch; let armed = false;
            window.fetch = async (u, o) => {
                if (String(u) === '/api/chats/get' && armed && M.readFailOnce) { M.readFailOnce = false; return new Response('x', { status: 500 }); }
                const r = await f(u, o); if (String(u) === '/api/chats/save') armed = true; return r; };
        }, [readFails, del]);
        const r1 = await ev(m => __savePoint.transact(() => { __savePoint.state().note = 'x';
            M.stScript.setChatSaving(true);
            setTimeout(() => {                                                    // a 13th; SillyTavern saves the change and it
                M.chat.push(m);
                M.serverFiles.chatA = JSON.parse(JSON.stringify([{ chat_metadata: M.meta }, ...M.chat]));
                M.stScript.setChatSaving(false);
            }, 150);
        }, { verify: true }).then(() => 'ok', e => `${e.name}: ${e.message}`), msg('Thirteenth.'));
        if (readFails) await page.waitForTimeout(3500);
        const r2 = await keep(ev, 5);
        await page.waitForTimeout(300);
        const r3 = await keep(ev, 7);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ n: M.serverFiles.chatA.length - 1, k5: !!M.serverFiles.chatA[6].extra?.savepointKeep, note: M.serverFiles.chatA[0].chat_metadata.savePoint?.note ?? null }));
        const warned = (await toasts(ev)).some(x => /다른 곳에서 지운/.test(x));
        if (del) ok(f.n === 12 && !f.k5 && /다른 곳에서 지운/.test(r2) && /다른 곳에서 지운/.test(r3) && (readFails ? /Unconfirmed/.test(r1) && warned : /RoomBlocked: 이번 변경은 채팅 파일에 저장했어요/.test(r1)),
            `${name}. 저장 중 읽은 파일에 이번 변경이 있으면 그 파일이 기준: 다른 곳에서 지운 13번째를 다음 🔶 두 번 모두 되살리지 않음 (${r1.slice(0, 30)} / ${r2.slice(0, 30)} / ${r3.slice(0, 30)}, ${JSON.stringify(f)})`);
        else ok(r1 === 'ok' && r2 === 'ok' && f.n === 13 && f.k5 && f.note === 'x' && !warned,
            `${name}. 다른 곳 삭제가 없으면 경고 없이 이번 변경이 파일에 있고 🔶도 저장 (${r1.slice(0, 30)} / ${r2}, ${JSON.stringify(f)})`);
        await page.close();
    }
    // 2–2b.
    for (const [name, stSaving] of [['2', false], ['2b', true]]) {
        const { page, ev } = await session();
        await ev(m => { M.noStSave = true; M.chat.push(m); M.failOnce = true; }, msg('Thirteenth.'));
        // 2b: SillyTavern starts saving while the background save reads the file (its own save does not land: the file stays as it was).
        await ev(st => { __savePoint.state().autoLast = { at: Date.now(), result: 'ok', status: '' }; __savePoint.persistSoon();
            if (st) { M.serverReadDelay = 400; setTimeout(() => { M.stScript.setChatSaving(true); setTimeout(() => { M.stScript.setChatSaving(false); M.serverReadDelay = 0; }, 600); }, 500); } }, stSaving);
        await page.waitForTimeout(2500);
        const t = await toasts(ev);
        const r = await keep(ev, 5);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ n: M.serverFiles.chatA.length - 1, k5: !!M.serverFiles.chatA[6].extra?.savepointKeep }));
        ok(!t.some(x => /저장했어요|지운|확인하지 못했어요/.test(x)) && t.some(x => /거절/.test(x)) && r === 'ok' && f.n === 13 && f.k5,
            `${name}. 상태만 바꾼 백그라운드 저장 실패${stSaving ? '(실리태번 저장을 기다린 뒤)' : ''}: "저장했어요"·"다른 곳에서 지운"·미확인 없이 거절만 알림, 다음 🔶가 13번째와 함께 저장 (${JSON.stringify(t.map(x => x.slice(0, 40)))}, 🔶 ${r.slice(0, 40)}, ${JSON.stringify(f)})`);
        await page.close();
    }
    // 3.
    {
        const { page, ev } = await session();
        await ev(() => {
            const f = window.fetch; let once = true;
            window.fetch = async (u, o) => {
                const r = await f(u, o);
                if (String(u) === '/api/chats/save' && once) { once = false;
                    SillyTavern.getContext().eventSource.emit('generation_started', 'continue', {}, false);
                    const m = M.chat.at(-1); m.mes += ' more';
                    M.serverFiles.chatA = JSON.parse(JSON.stringify([{ chat_metadata: M.meta }, ...M.chat]));   // a middle state
                    M.stScript.setChatSaving(true); setTimeout(() => M.stScript.setChatSaving(false), 150);
                    M.grow = setInterval(() => { m.mes += ' more'; }, 100);
                }
                return r;
            };
        });
        const r1 = await keep(ev, 5);
        await page.waitForTimeout(800);
        const during = { warned: (await toasts(ev)).some(x => /화면에 없는|하지만/.test(x)), blocked: await ev(() => __savePoint.autoBlocked()) };
        await ev(() => { clearInterval(M.grow); M.stSave(); SillyTavern.getContext().eventSource.emit('generation_ended', M.chat.length); });
        await page.waitForTimeout(4000);
        const after = await ev(() => __savePoint.autoBlocked());
        const r2 = await keep(ev, 7);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ k5: !!M.serverFiles.chatA[6].extra?.savepointKeep, k7: !!M.serverFiles.chatA[8].extra?.savepointKeep }));
        ok(r1 === 'ok' && !during.warned && during.blocked === 'busy' && after !== 'room' && r2 === 'ok' && f.k5 && f.k7,
            `3. 첫 요청 뒤 이어쓰기로 다시 보내기를 미룸: 경고·막힘 없이 busy, 답변 뒤 다시 열림 (${r1.slice(0, 40)}, ${JSON.stringify(during)} → ${after}, 🔶 ${r2}, ${JSON.stringify(f)})`);
        await page.close();
    }
    // 4.
    for (const phase of [0, 500, 1000]) {
        const { page, ev } = await session();
        await ev(m => { M.chat.push(m); M.stSave(); }, msg('Thirteenth.'));
        await page.waitForTimeout(500);
        await ev(() => { M.serverReadDelay = 400; __savePoint.state().note = 'held-change'; __savePoint.persistSoon(); });
        await page.waitForTimeout(450);
        await ev(() => { SillyTavern.getContext().eventSource.emit('generation_started', 'continue', {}, false);
            const m = M.chat.at(-1); M.grow = setInterval(() => { m.mes += ' more'; }, 100); });
        await page.waitForTimeout(3000 + phase);
        const during = await ev(() => M.saveBodies.length);
        // The reply ends. SillyTavern's own save does not carry the change here (only the grown message), and the
        // message event checks the room before the recheck timer.
        await ev(() => { clearInterval(M.grow); M.serverReadDelay = 0;
            const f = M.serverFiles.chatA; f[f.length - 1] = JSON.parse(JSON.stringify(M.chat.at(-1)));
            M.noStSave = true;
            SillyTavern.getContext().eventSource.emit('generation_ended', M.chat.length);
            SillyTavern.getContext().eventSource.emit('message_received', M.chat.length - 1); });
        await page.waitForTimeout(4000);
        const f = await ev(() => ({ sends: M.saveBodies.length, note: M.serverFiles.chatA[0].chat_metadata.savePoint?.note ?? null }));
        ok(during === 0 && f.sends >= 1 && f.note === 'held-change',
            `4. 답변 중 미룬 백그라운드 저장은 메시지 이벤트가 먼저 방을 열어도 답변 뒤 저장 (+${phase}ms: 답변 중 ${during}회 → ${JSON.stringify(f)})`);
        await page.close();
    }

    // 5–5b. v0.6.92: a status-only save; SillyTavern saved the new status and the 13th first. 5: another tab then deletes
    //    the 13th and SavePoint's request gets the 500: the file holds this save (the new status), so the 13th is a
    //    deletion elsewhere (blocked). 5b: no deletion: nothing said, the 🔶 saves.
    // 6. v0.6.92: a status-only save gets the 500 while the 13th is only on the page, and the first read after it fails.
    //    A later read finds the old status: not "in the file … deleted elsewhere"; the room goes on and the 🔶 saves the 13th.
    for (const kind of ['5', '5b', '6']) {
        const { page, ev } = await session();
        await ev(([kind, m]) => { M.noStSave = true; M.chat.push(m);
            const f = window.fetch; let armed = false;
            window.fetch = async (u, o) => {
                if (String(u) === '/api/chats/get' && armed && M.readFailOnce) { M.readFailOnce = false; return new Response('x', { status: 500 }); }
                const r = await f(u, o); if (String(u) === '/api/chats/save') armed = true; return r; };
            M.beforeChatSave = async () => { M.beforeChatSave = null; M.failOnce = true;
                if (kind === '6') { M.readFailOnce = true; return; }
                M.serverFiles.chatA = JSON.parse(JSON.stringify([{ chat_metadata: M.meta }, ...M.chat]));   // SillyTavern saved first
                if (kind === '5') M.serverFiles.chatA.pop(); };                                              // another tab deletes the 13th
        }, [kind, msg('Thirteenth.')]);
        await ev(() => { __savePoint.state().autoLast = { at: Date.now(), result: 'ok', status: '' }; __savePoint.persistSoon(); });
        await page.waitForTimeout(kind === '6' ? 5000 : 2000);
        const t = await toasts(ev);
        const r = await keep(ev, 5);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ n: M.serverFiles.chatA.length - 1, has13: M.serverFiles.chatA.some(x => x.mes === 'Thirteenth.'), k5: !!M.serverFiles.chatA[6].extra?.savepointKeep }));
        const said = JSON.stringify(t.map(x => x.slice(0, 40)));
        if (kind === '5') ok(t.some(x => /다른 곳에서 지운/.test(x)) && /다른 곳에서 지운/.test(r) && !f.has13 && !f.k5,
            `5. 실리태번이 새 상태와 13번째를 먼저 저장한 뒤 다른 탭 삭제: 이번 저장이 파일에 있다고 보고 13번째를 되살리지 않음 (${said}, 🔶 ${r.slice(0, 30)}, ${JSON.stringify(f)})`);
        else if (kind === '5b') ok(!t.some(x => /지운|거절|확인하지 못했어요/.test(x)) && r === 'ok' && f.has13 && f.k5,
            `5b. 같은 순서에 삭제가 없으면 아무 안내 없이 이어서 🔶 저장 (${said}, 🔶 ${r.slice(0, 30)}, ${JSON.stringify(f)})`);
        else ok(!t.some(x => /들어가 있어요|지운/.test(x)) && t.some(x => /들어가지 않았어요.*평소처럼/.test(x)) && r === 'ok' && f.has13 && f.k5,
            `6. 상태만 바꾼 저장 실패 + 첫 읽기 실패: 나중 확인도 예전 상태면 "들어가 있어요·지운" 없이 다시 저장, 🔶가 13번째와 저장 (${said}, 🔶 ${r.slice(0, 30)}, ${JSON.stringify(f)})`);
        await page.close();
    }
    // 7–7b. v0.6.92: a room without a memory. 🔶 waits for SillyTavern; meanwhile the last message is edited and a 13th comes,
    //    and SillyTavern saves the page (the 🔶 mark and 13). SavePoint reads that file before sending; then a 14th comes,
    //    another tab deletes the 13th, and the request gets the 500. The file read during the write holds it by the marks
    //    (the same rule as the file after it), so it is the base: the 13th is not written back. 7: at once, 7b: later.
    for (const [name, readFails] of [['7', false], ['7b', true]]) {
        const { page, ev } = await session({ run: false });
        await ev(([readFails, m13, m14]) => { M.noStSave = true; M.serverReadDelay = 400; M.readFailOnce = false; M.m13 = m13;
            const f = window.fetch; let armed = false;
            window.fetch = async (u, o) => {
                if (String(u) === '/api/chats/get' && armed && M.readFailOnce) { M.readFailOnce = false; return new Response('x', { status: 500 }); }
                const r = await f(u, o);
                if (String(u) === '/api/chats/get' && M.after13 && !M.pushed14) { M.pushed14 = true; M.chat.push(m14); }
                if (String(u) === '/api/chats/save') armed = true;
                return r; };
            M.beforeChatSave = async () => { M.beforeChatSave = null; M.serverFiles.chatA.pop(); M.failOnce = true; M.readFailOnce = readFails; };
        }, [readFails, msg('Thirteenth.'), msg('Fourteenth.')]);
        const p1 = ev(() => __savePoint.toggleKeep(5).then(() => 'ok', e => `${e.name}: ${e.message}`));
        await page.waitForTimeout(200);
        await ev(() => M.stScript.setChatSaving(true));
        await page.waitForTimeout(400);
        await ev(() => { M.chat.at(-1).mes += ' (edited)'; M.chat.push(M.m13);
            M.serverFiles.chatA = JSON.parse(JSON.stringify([{ chat_metadata: M.meta }, ...M.chat]));
            M.after13 = true; M.stScript.setChatSaving(false); });
        const r1 = await p1;
        await ev(() => { M.serverReadDelay = 0; });
        if (readFails) await page.waitForTimeout(3500);
        const r2 = await keep(ev, 7);
        await page.waitForTimeout(300);
        const r3 = await keep(ev, 8);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ pushed14: !!M.pushed14, has13: M.serverFiles.chatA.some(x => x.mes === 'Thirteenth.'), k5: !!M.serverFiles.chatA[6].extra?.savepointKeep }));
        ok(f.pushed14 && !f.has13 && f.k5 && /다른 곳에서 지운/.test(r2) && /다른 곳에서 지운/.test(r3) && (readFails ? /Unconfirmed/.test(r1) : /RoomBlocked: 이번 변경은 채팅 파일에 저장했어요/.test(r1)),
            `${name}. 기억 없는 방: 저장 중 읽은 파일도 🔶 표시로 판단해 기준으로, 다른 탭이 지운 13번째를 다음 🔶 두 번 모두 되살리지 않음 (${r1.slice(0, 30)} / ${r2.slice(0, 30)} / ${r3.slice(0, 30)}, ${JSON.stringify(f)})`);
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
