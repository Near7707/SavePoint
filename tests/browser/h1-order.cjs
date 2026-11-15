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

// v0.7.0-b2a (H1): the order of a change's memory file write and its chat file write of hides.
// A change that hides more writes its memory first and its new hides after it (nothing on the page or the server is hidden
// before the memory is proved); one that hides less writes the release first (read back) and its memory after it. A hide the
// server still has past what the new memory covers is released too (b2 design review P1-1). A memory written but not read back
// sets no new hide, later either (P1-2). A memory-only edit sets no new hide (P2).
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(s => { window.__presetSettings = s; }, { savePoint: { firstTab: 'journal', check: false, hideMode: 'auto', keepRecent: 2, askResume: false } });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
    await page.waitForTimeout(300);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    // The memory file of the room, its last recorded message, and the hides of the page and of the server chat file.
    const look = () => ev(async () => {
        const H = await import('/ext/home.js'), h = __savePoint.home(), t = h.id ? M.files.get(H.memName(h.id)) : null, f = t ? JSON.parse(t) : null;
        const hid = list => list.map((m, i) => (m?.is_system ? i : -1)).filter(i => i >= 0);
        return { file: f?.state?.lastIndex ?? null, page: hid(M.chat), server: hid((M.serverFiles[M.chatId] || []).slice(1)), sp: M.spSaves, stop: h.line?.stop ?? null, pending: !!h.line?.pending, unread: !!h.line?.unread };
    });
    // The server holds no hide its memory file does not cover (pass mark 5).
    const covered = x => x.server.every(i => i <= (x.file ?? -1));
    // The order of SavePoint's chat saves and memory uploads from now on.
    const logOrder = () => ev(() => {
        window.__order = [];
        if (window.__orderWrapped) return;
        window.__orderWrapped = true;
        const f = window.fetch;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/chats/save') window.__order.push('chat');
            else if (s === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) window.__order.push('mem');
            return f(u, o);
        };
    });
    const order = () => ev(() => window.__order.slice());
    let r, x, y;

    // 0. a first save: 8 messages, recorded to #7, the latest 2 kept → #0–#5 hidden.
    await ev(() => M.add(8));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    x = await look();
    ok(x.file === 7 && x.page.join() === '0,1,2,3,4,5' && x.server.join() === '0,1,2,3,4,5', `0. 첫 세이브: 기억 #7·숨김 #0–#5 (${JSON.stringify(x)})`);

    // 1. (b1 review P1-5) a save that hides more: while its memory upload is on its way the page shows the new messages and
    // SillyTavern's own save of the page carries no new hide; the hides go out after the memory.
    await ev(() => M.add(4));
    await logOrder();
    await ev(() => {
        M.beforeUpload = async name => {
            if (!name.startsWith('savepoint-mem-')) return;
            M.beforeUpload = null;
            window.__during = M.chat.map((m, i) => (m.is_system ? i : -1)).filter(i => i >= 0);
            M.stSave();
            window.__stCopy = M.serverFiles[M.chatId].slice(1).map((m, i) => (m.is_system ? i : -1)).filter(i => i >= 0);
        };
    });
    await ev(() => __savePoint.handle('run'));
    await wait(1800);
    x = await look();
    r = { during: await ev(() => window.__during), st: await ev(() => window.__stCopy), order: await order() };
    ok(r.during?.join() === '0,1,2,3,4,5' && r.st?.join() === '0,1,2,3,4,5', `1. 기억 업로드 중: 새 숨김 없음, 실리태번 저장에도 없음 (${JSON.stringify(r)})`);
    ok(x.file === 11 && x.page.join() === '0,1,2,3,4,5,6,7,8,9' && x.server.join() === x.page.join() && r.order.join() === 'mem,chat', `1. 기억 확인 뒤 새 숨김 저장 (기억 → 채팅) (${JSON.stringify(x)} ${JSON.stringify(r.order)})`);

    // 2. a rewind (hides less): the release goes to the chat file first, then the memory.
    await logOrder();
    await ev(() => { M.confirm = 1; return __savePoint.handle('undo'); });
    await wait(1800);
    x = await look();
    r = await order();
    // (12 messages, the latest 2 kept: recorded to #7 → #0–#7 hidden; #8, #9 released.)
    ok(x.file === 7 && x.page.join() === '0,1,2,3,4,5,6,7' && x.server.join() === x.page.join() && r[0] === 'chat' && r.includes('mem') && covered(x), `2. 리와인드: 숨김 풀기 저장 → 기억 (${JSON.stringify(x)} ${JSON.stringify(r)})`);

    // 3. a rewind whose release write fails: nothing changes (the memory file, the page and the server stay as they were).
    await ev(() => __savePoint.handle('run'));
    await wait(1800);
    y = await look();
    await logOrder();
    r = await ev(async () => { toastr.log.length = 0; M.failMeta = true; M.confirm = 1; try { await __savePoint.handle('undo'); return null; } catch (e) { return e.message; } });
    const err3 = r;
    await wait(1800);
    await ev(() => { M.failMeta = false; });
    x = await look();
    r = { order: await order(), err: err3 };
    ok(y.file === 11 && x.file === 11 && x.page.join() === y.page.join() && x.server.join() === y.server.join() && !r.order.includes('mem') && /저장하지 못해서/.test(r.err || '') && covered(x),
        `3. 숨김 풀기 저장 실패 → 기억도 그대로 (before=${JSON.stringify(y)} after=${JSON.stringify(x)} ${JSON.stringify(r)})`);

    // 4. (b2 design review P1-1) the page already shows what the server still hides (shown before the change's turn): a rewind
    // finds no mark to change on the page, but releases the server's hides before the memory shrinks.
    await ev(() => {
        for (const i of [6, 7, 8, 9]) { const m = M.chat[i]; m.is_system = false; delete m.extra.savepointHidden; $(`#chat .mes[mesid="${i}"]`).attr('is_system', 'false'); }
        __savePoint.adoptPage();
    });
    y = await look();
    await logOrder();
    await ev(() => { M.confirm = 1; return __savePoint.handle('undo'); });
    await wait(1800);
    x = await look();
    r = await order();
    // The rewind hides #6, #7 again (it may bring memory back) after its memory: release → memory → new hides.
    ok(y.server.join() === '0,1,2,3,4,5,6,7,8,9' && x.file === 7 && x.server.join() === '0,1,2,3,4,5,6,7' && x.page.join() === x.server.join() && covered(x) && r.join() === 'chat,mem,chat',
        `4. 서버에만 남은 숨김 → 풀기 저장 → 기억 (before=${JSON.stringify(y)} after=${JSON.stringify(x)} ${JSON.stringify(r)})`);

    // 5. (P2) a memory-only edit sets no new hide: a recorded message shown on the page and the server stays shown, no chat save.
    await ev(() => { const m = M.chat[2]; m.is_system = false; delete m.extra.savepointHidden; $('#chat .mes[mesid="2"]').attr('is_system', 'false'); M.stSave(); __savePoint.adoptPage(); });
    y = await look();
    await ev(() => __savePoint.commitEdit(mem => { mem.scenes[0].star = !mem.scenes[0].star; }));
    await wait(1200);
    x = await look();
    ok(!y.page.includes(2) && !x.page.includes(2) && !x.server.includes(2) && x.sp === y.sp, `5. 기억만 고치는 편집: 새 숨김 없음, 채팅 저장 0회 (before=${JSON.stringify(y)} after=${JSON.stringify(x)})`);
    // The next save hides it again (a save sets new hides).
    await ev(() => __savePoint.handle('run'));
    await wait(1800);
    x = await look();
    ok(x.page.includes(2) && x.server.includes(2) && covered(x), `5. 다음 세이브에서 다시 숨김 (${JSON.stringify(x)})`);

    // 6. (P1-2) a save whose memory is written but not read back: no new hide; a sync after it (a setting changed) hides nothing
    // either, until a read shows the memory (the next save).
    await ev(() => M.add(2));
    y = await look();
    await ev(async () => {
        const H = await import('/ext/home.js'), name = H.memName(__savePoint.home().id), f = window.fetch;
        window.fetch = async (u, o) => {
            const res = await f(u, o);
            if (String(u) === '/api/files/upload' && JSON.parse(o.body).name === name) { window.fetch = f; M.fileState[name] = 'error'; }
            return res;
        };
        window.__memName = name;
    });
    await ev(() => __savePoint.handle('run'));
    await wait(2000);
    x = await look();
    await ev(() => { delete M.fileState[window.__memName]; M.settings.savePoint.keepRecent = 1; __savePoint.syncHide(); });
    await wait(1200);
    const x2 = await look();
    ok(x.file === 13 && x.unread && x.page.join() === y.page.join() && x.server.join() === y.server.join(), `6. 기억을 다시 읽지 못함 → 새 숨김 안 함 (before=${JSON.stringify(y)} after=${JSON.stringify(x)})`);
    ok(x2.page.join() === y.page.join() && x2.server.join() === y.server.join() && x2.sp === x.sp, `6. 그 뒤 설정 변경에도 새 숨김 안 함 (${JSON.stringify(x2)})`);
    await ev(() => __savePoint.handle('run'));
    await wait(1800);
    x = await look();
    ok(!x.unread && x.file === 13 && x.page.includes(11) && x.server.join() === x.page.join() && covered(x), `6. 기억이 확인된 다음 세이브에서 숨김 (${JSON.stringify(x)})`);

    // 6b. (P1-2) a held hide is set again only on messages unchanged since the change: #14 edited while the memory is on its way →
    // nothing from #14 on is hidden. (b2a1, review of b2a P1-2: the hides are set right before the copy is made, so SillyTavern's
    // save in the wait after the memory read carries none of them, #13 included.)
    await ev(() => M.add(3));
    await ev(async () => {
        const H = await import('/ext/home.js'), name = H.memName(__savePoint.home().id), f = window.fetch;
        let up = false, reads = 0;
        window.__st6b = null;
        M.beforeUpload = async n => { if (n !== name) return; M.beforeUpload = null; up = true; M.chat[14].mes += ' (edited)'; };
        window.fetch = async (u, o) => {
            const res = await f(u, o);
            if (up && String(u).startsWith('/user/files/' + name) && ++reads === 2) {
                window.fetch = f;
                M.stSave();
                window.__st6b = M.serverFiles[M.chatId].slice(1).map((m, i) => (m.is_system ? i : -1)).filter(i => i >= 0);
            }
            return res;
        };
    });
    await ev(() => __savePoint.handle('run'));
    await wait(2000);
    r = { st: await ev(() => window.__st6b), x: await look() };
    ok(Array.isArray(r.st) && !r.st.includes(13) && !r.st.includes(14) && !r.st.includes(15) && r.x.server.includes(13) && !r.x.server.includes(14) && !r.x.page.includes(14),
        `6b. 기억 업로드 중 #14 수정 → 다시 걸 때 #14부터는 안 숨김 (${JSON.stringify(r)})`);
    // #14 back as it was recorded (its memory is not rolled back here).
    await ev(() => { M.chat[14].mes = M.chat[14].mes.replace(' (edited)', ''); });

    // 6c. (review of b2a, P1-2) #14 edited after the memory was read back, while the chat file is read right before the write, and
    // SillyTavern saves the page then: its copy carries no new hide, and none of #14–#16 is hidden on the server or the page.
    await ev(() => M.add(1));
    await ev(async () => {
        const H = await import('/ext/home.js'), name = H.memName(__savePoint.home().id), f = window.fetch;
        let up = false, reads = 0;
        window.__st6c = null;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name === name) up = true;
            if (up && s.startsWith('/user/files/' + name)) reads++;
            if (up && reads >= 2 && s === '/api/chats/get') {
                window.fetch = f;
                M.chat[14].mes += ' (edited later)';
                M.stSave();
                window.__st6c = M.serverFiles[M.chatId].slice(1).map((m, i) => (m.is_system ? i : -1)).filter(i => i >= 0);
            }
            return f(u, o);
        };
    });
    y = await look();
    await ev(async () => { try { await __savePoint.handle('run'); } catch { /* reported */ } });
    await wait(2000);
    r = { st: await ev(() => window.__st6c), x: await look() };
    ok(Array.isArray(r.st) && r.st.join() === y.server.join() && ![14, 15, 16].some(i => r.x.server.includes(i) || r.x.page.includes(i)),
        `6c. 기억 확인 뒤 채팅 읽기 중 #14 수정·실리태번 저장 → 새 숨김 없음 (before=${JSON.stringify(y)} ${JSON.stringify(r)})`);
    await ev(() => { M.chat[14].mes = M.chat[14].mes.replace(' (edited later)', ''); M.stSave(); });

    // 6d. (review of b2a, P2) hide turned off while the memory is on its way: the held hides are not set; what was hidden stays.
    await ev(() => M.add(1));
    y = await look();
    await ev(() => { M.beforeUpload = async n => { if (!n.startsWith('savepoint-mem-')) return; M.beforeUpload = null; M.settings.savePoint.hideMode = 'off'; }; });
    await ev(async () => { try { await __savePoint.handle('run'); } catch { /* reported */ } });
    await wait(2000);
    x = await look();
    ok(x.file === 18 && x.page.join() === y.page.join() && x.server.join() === y.server.join(), `6d. 저장 중 하이드 끔 → 새 숨김 안 걺, 이미 숨긴 건 그대로 (before=${JSON.stringify(y)} after=${JSON.stringify(x)})`);
    await ev(() => { M.settings.savePoint.hideMode = 'auto'; });

    // 7. a reset whose release is in the chat file but whose memory write gets no answer: the messages stay shown (never hidden
    // again), the memory file is as before, the room writes no memory until it is opened again.
    y = await look();
    await logOrder();
    await ev(async () => { M.failFile = 'savepoint-mem-'; M.confirm = 1; try { await __savePoint.handle('clear-room'); } catch { /* reported */ } });
    await wait(1800);
    await ev(() => { M.failFile = null; __savePoint.syncHide(); });
    await wait(1200);
    x = await look();
    r = await order();
    ok(r[0] === 'chat' && x.pending && x.file === y.file && x.page.length === 0 && x.server.length === 0 && covered(x),
        `7. 풀기 저장 뒤 기억 응답 없음 → 풀린 채로 멈춤 (before=${JSON.stringify(y)} after=${JSON.stringify(x)} ${JSON.stringify(r)})`);

    // 8. (review of b2a, P1-1) another device reset the room (memory emptied, every hide released on the server) while this tab still
    // shows the old hides: a rewind here sends nothing (the memory file is not the one this tab saw), the server keeps no hide.
    await ev(() => M.openFile(M.chatId)); await wait(1500);
    await ev(() => M.add(2));
    await ev(() => __savePoint.handle('run'));
    await wait(1800);
    y = await look();
    await ev(async () => {
        const H = await import('/ext/home.js'), name = H.memName(__savePoint.home().id), f = JSON.parse(M.files.get(name));
        const st = JSON.parse(JSON.stringify(f.state));
        st.mem = { scenes: [], records: [], entities: [] }; st.lastIndex = -1; st.hashes = []; st.undo = null; st.undoInfo = null;
        M.otherPut(name, H.nextMem(f, st, 'other8'));
        for (const m of M.serverFiles[M.chatId].slice(1)) { delete m.is_system; if (m.extra) delete m.extra.savepointHidden; }
    });
    await logOrder();
    r = await ev(async () => { M.confirm = 1; try { await __savePoint.handle('undo'); return null; } catch (e) { return e.message; } });
    await wait(1500);
    x = await look();
    const o8 = await order(), wid8 = await ev(async () => { const H = await import('/ext/home.js'); return JSON.parse(M.files.get(H.memName(__savePoint.home().id))).wid; });
    ok(y.page.length > 0 && x.server.length === 0 && o8.length === 0 && wid8 === 'other8' && x.sp === y.sp,
        `8. 다른 기기 리셋 뒤 오래된 화면의 리와인드 → 채팅 저장 안 함, 서버 숨김 0 (before=${JSON.stringify(y)} after=${JSON.stringify(x)} order=${JSON.stringify(o8)} err=${r})`);

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
