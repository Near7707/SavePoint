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


// v0.6.87 (review of v0.6.85–86): a file read after a write becomes the base for the next write (`seen`) only by the
// same rule as before a write.
// 1. A room without a memory: SillyTavern saves the 🔶 first, another device writes a memory, SavePoint's request
//    gets SillyTavern's 500. The 🔶 is in the file, but the next 🔶 must not write over that memory (1: settled
//    at once, 1b: settled by a later read).
// 2. One write sends 12 (ok), a new message comes, 13 are sent again (ok); another device deletes the 13th before
//    the read-back (2) or before the later read (2b). The next 🔶 must not bring it back.
// 3. A load's look before its questions while a 🔶 write is on its way: a message this page deleted after the
//    request left stays this page's own deletion (the 🔶 write goes on and saves the new message).
// 4. (v0.6.89) 13 sent (ok); this page deletes the 13th; 12 sent again (ok); the read-back fails; a new message on
//    this page. The later check uses the newest copy (the 12): no warning, the 🔶 saves (4: at once, 4b: after the timer).
// 5. (v0.6.89, kept) 12 ok, new message, 13 ok, then the file becomes exactly the copy before the write (written by
//    someone who never saw it): the write is cancelled and the next 🔶 puts the 13th back.
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

    // 1–1b.
    for (const later of [false, true]) {
        const { page, ev } = await session({ run: false });
        await ev(later => { M.noStSave = false; let n = 0;
            M.beforeChatSave = async () => { if (++n !== 1) return;
                M.stSave();
                M.serverFiles.chatA[0].chat_metadata = { ...M.serverFiles.chatA[0].chat_metadata, savePoint: { rev: 7, by: 'otherdev', wid: 'w-other', mem: { scenes: [], records: [{ id: 'r1', text: 'Kept by the other device.' }], entities: [] } } };
                M.noStSave = true; M.failOnce = true; if (later) M.serverError = true; }; }, later);
        const r1 = await keep(ev, 3);
        if (later) { await ev(() => { M.serverError = false; }); await page.waitForTimeout(3500); }
        const r2 = await keep(ev, 5);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ mem: M.serverFiles.chatA[0].chat_metadata.savePoint?.mem?.records?.[0]?.text ?? null, k3: !!M.serverFiles.chatA[4].extra?.savepointKeep, k5: !!M.serverFiles.chatA[6].extra?.savepointKeep, blocked: __savePoint.autoBlocked() }));
        ok(f.mem === 'Kept by the other device.' && f.k3 && !f.k5 && /RoomBlocked: 다른 기기에서 이 방의 SavePoint 기억/.test(r2) && (later ? /Unconfirmed/.test(r1) : /RoomBlocked: 이번 변경은 채팅 파일에 저장했어요/.test(r1)),
            `1${later ? 'b' : ''}. 첫 🔶는 파일에 있음, 다른 기기 기억은 기준이 되지 않아 다음 🔶가 덮지 않음 (${r1.slice(0, 30)} / ${r2.slice(0, 30)}, ${JSON.stringify(f)})`);
        await page.close();
    }
    // 2–2b.
    for (const later of [false, true]) {
        const { page, ev } = await session();
        await ev(later => { M.noStSave = true; const f = window.fetch; let k = 0;
            window.fetch = async (u, o) => { const r = await f(u, o);
                if (String(u) === '/api/chats/save') { k++;
                    if (k === 1) M.chat.push({ name: 'Me', is_user: true, is_system: false, mes: 'Sent again with the write.', swipe_id: 0, extra: {} });
                    if (k === 2) { M.serverFiles.chatA.pop(); if (later) M.serverError = true; } }
                return r; }; }, later);
        const r1 = await ev(() => __savePoint.transact(() => { __savePoint.state().note = 'x'; }, { verify: true }).then(() => 'ok', e => `${e.name}: ${e.message}`));
        if (later) { await ev(() => { M.serverError = false; }); await page.waitForTimeout(3500); }
        const sends = await ev(() => M.saveBodies.length);
        const r2 = await keep(ev, 5);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ n: M.serverFiles.chatA.length - 1, sends: M.saveBodies.length }));
        ok(sends === 2 && f.n === 12 && f.sends === 2 && /RoomBlocked: 다른 곳에서 지운 메시지/.test(r2),
            `2${later ? 'b' : ''}. 성공한 13개 사본이 기준: 다른 기기에서 지운 13번째를 되살리지 않음 (${r1.slice(0, 30)} / ${r2.slice(0, 30)}, ${JSON.stringify(f)})`);
        await page.close();
    }
    // 3.
    for (const withLoad of [false, true]) {
        const { page, ev } = await session();
        const qid = await ev(() => __savePoint.listSaves().find(x => x.quick)?.id);
        await ev(([withLoad, qid]) => { M.noStSave = true; M.confirm = 1; const f = window.fetch; let k = 0;
            window.fetch = async (u, o) => { const r = await f(u, o);
                if (String(u) === '/api/chats/save' && ++k === 1) {
                    M.chat.splice(11, 1); await SillyTavern.getContext().eventSource.emit('message_deleted', M.chat.length);
                    M.noStSave = false; M.stSave(); M.noStSave = true;
                    M.chat.push({ name: 'Me', is_user: true, is_system: false, mes: 'Written after the delete.', swipe_id: 0, extra: {} });
                    if (withLoad) M.loading = __savePoint.loadSave(qid);
                    await new Promise(x => setTimeout(x, 400)); }
                return r; }; }, [withLoad, qid]);
        const r1 = await keep(ev, 3);
        await page.waitForTimeout(800);
        const f = await ev(() => ({ n: M.serverFiles.chatA.length - 1, last: M.serverFiles.chatA.at(-1).mes, blocked: __savePoint.autoBlocked() }));
        ok(r1 === 'ok' && f.n === 12 && f.last === 'Written after the delete.' && f.blocked !== 'room',
            `3${withLoad ? '' : '(불러오기 없음)'}. 저장이 가는 사이 이 화면이 지운 메시지는 ${withLoad ? '불러오기 사전 확인 뒤에도 ' : ''}이 화면의 삭제 (${r1.slice(0, 30)}, ${JSON.stringify({ n: f.n, blocked: f.blocked })})`);
        await page.close();
    }

    // 4–4b.
    for (const wait of [0, 3500]) {
        const { page, ev } = await session();
        await ev(() => { M.noStSave = true; M.chat.push({ name: 'Me', is_user: true, is_system: false, mes: 'Deleted here.', swipe_id: 0, extra: {} });
            const f = window.fetch; let k = 0;
            window.fetch = async (u, o) => { const r = await f(u, o);
                if (String(u) === '/api/chats/save') { k++;
                    if (k === 1) { M.chat.pop(); await SillyTavern.getContext().eventSource.emit('message_deleted', M.chat.length); }
                    if (k === 2) M.serverError = true; }
                return r; }; });
        const r1 = await ev(() => __savePoint.transact(() => { __savePoint.state().note = 'x'; }, { verify: true }).then(() => 'ok', e => `${e.name}: ${e.message}`));
        await ev(() => { M.serverError = false; M.chat.push({ name: 'Me', is_user: true, is_system: false, mes: 'Brand new.', swipe_id: 0, extra: {} }); });
        await page.waitForTimeout(wait);
        const r2 = await keep(ev, 5);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ n: M.serverFiles.chatA.length - 1, last: M.serverFiles.chatA.at(-1).mes, k5: !!M.serverFiles.chatA[6].extra?.savepointKeep, warned: toastr.log.slice(M.toastLog).some(x => /다른 곳에서 지운/.test(String(x.msg ?? x))) }));
        ok(/Unconfirmed/.test(r1) && r2 === 'ok' && f.n === 13 && f.last === 'Brand new.' && f.k5 && !f.warned,
            `4${wait ? 'b' : ''}. 나중 확인은 가장 최근 성공 사본(내 삭제 반영)을 기준으로: 다른 곳 삭제 경고 없음, 🔶 저장 (${r2.slice(0, 40)}, ${JSON.stringify(f)})`);
        await page.close();
    }
    // 5.
    {
        const { page, ev } = await session();
        await ev(() => { M.noStSave = true; M.pre = JSON.parse(JSON.stringify(M.serverFiles.chatA)); const f = window.fetch; let k = 0;
            window.fetch = async (u, o) => { const r = await f(u, o);
                if (String(u) === '/api/chats/save') { k++;
                    if (k === 1) M.chat.push({ name: 'Me', is_user: true, is_system: false, mes: 'Thirteenth.', swipe_id: 0, extra: {} });
                    if (k === 2) M.serverFiles.chatA = JSON.parse(JSON.stringify(M.pre)); }
                return r; }; });
        const r1 = await ev(() => __savePoint.transact(() => { __savePoint.state().note = 'x'; }, { verify: true }).then(() => 'ok', e => `${e.name}: ${e.message}`));
        const r2 = await keep(ev, 5);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ n: M.serverFiles.chatA.length - 1, last: M.serverFiles.chatA.at(-1).mes, note: M.serverFiles.chatA[0].chat_metadata.savePoint?.note ?? null, page: __savePoint.state().note ?? null }));
        ok(/그대로예요/.test(r1) && r2 === 'ok' && f.n === 13 && f.last === 'Thirteenth.' && f.note === null && f.page === null,
            `5. 파일이 쓰기 전 사본 그대로면 이번 변경은 취소, 다음 🔶가 13번째를 다시 씀(덮은 쪽은 13번째를 본 적 없음) (${r1.slice(0, 30)} / ${r2}, ${JSON.stringify(f)})`);
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
