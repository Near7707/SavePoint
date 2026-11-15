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

// v0.7.0-b2b: another device's write in the gaps of a chat write (two files cannot be checked at once).
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
    const memName = () => ev(async () => { const H = await import('/ext/home.js'); return H.memName(__savePoint.home().id); });
    // Another device resets the room: every SavePoint hide taken away in the chat file (first), then (full) its memory emptied.
    const RESET = tag => `async () => {
        for (const m of M.serverFiles[M.chatId].slice(1)) { if (m.extra?.savepointHidden) { m.is_system = false; delete m.extra.savepointHidden; } }
        if (${JSON.stringify(tag)}) {
            const H = await import('/ext/home.js'), name = H.memName(__savePoint.home().id), f = JSON.parse(M.files.get(name));
            const st = JSON.parse(JSON.stringify(f.state));
            st.mem = { scenes: [], records: [], entities: [] }; st.lastIndex = -1; st.hashes = []; st.undo = null; st.undoInfo = null;
            M.otherPut(name, H.nextMem(f, st, ${JSON.stringify(tag)}));
        }
    }`;
    // Another device saves the memory (the same memory, a new receipt): no hide changes in the chat file.
    const OTHER_SAVE = tag => `async () => {
        const H = await import('/ext/home.js'), name = H.memName(__savePoint.home().id), f = JSON.parse(M.files.get(name));
        M.otherPut(name, H.nextMem(f, JSON.parse(JSON.stringify(f.state)), ${JSON.stringify(tag)}));
    }`;
    // `body` runs right after the n-th read of the room's memory file (counted from now; after an upload of it when `up`), before
    // anything else answers.
    const afterMem = (n, body, { up = false } = {}) => ev(`(async () => {
        const H = await import('/ext/home.js'), name = H.memName(__savePoint.home().id), f = window.fetch;
        let seen = !${up}, reads = 0, done = false;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name === name) seen = true;
            const res = await f(u, o);
            if (!done && seen && s.startsWith('/user/files/' + name) && ++reads >= ${n}) { done = true; window.fetch = f; await (${body})(); }
            return res;
        };
    })()`);
    // `body` runs when the chat file read right after the second memory read following the upload answers.
    const afterCheck = body => ev(`(async () => {
        const H = await import('/ext/home.js'), name = H.memName(__savePoint.home().id), f = window.fetch;
        let up = false, reads = 0, armed = false;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name === name) up = true;
            if (up && s.startsWith('/user/files/' + name)) reads++;
            const res = await f(u, o);
            if (up && reads >= 2 && !armed && s === '/api/chats/get') { armed = true; window.fetch = f; await (${body})(); }
            return res;
        };
    })()`);
    const said = re => ev(src => toastr.log.map(([, m]) => String(m)).filter(m => new RegExp(src).test(m)).length, re.source);
    const wid = () => ev(async () => { const H = await import('/ext/home.js'); return JSON.parse(M.files.get(H.memName(__savePoint.home().id)) || 'null')?.wid ?? null; });
    const fresh = async () => {
        await ev(() => M.openFile(M.chatId)); await wait(1500);
        await ev(async () => { M.confirm = 1; try { await __savePoint.handle('clear-room'); } catch { /* reported */ } }); await wait(1500);
        await ev(() => M.add(6));
        await ev(() => __savePoint.handle('run').catch(() => {}));
        await wait(2000);
        return look();
    };

    // 0. a first save: 8 messages, recorded to #7, the latest 2 kept → #0–#5 hidden.
    await ev(() => M.add(8));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    x = await look();
    ok(x.file === 7 && x.page.join() === '0,1,2,3,4,5' && x.server.join() === '0,1,2,3,4,5', `0. 첫 세이브 (${JSON.stringify(x)})`);

    // 1. a save; right after its memory check (the second read after the upload) another device's reset ends (hides taken away, memory
    // emptied). The chat file read next shows the hides gone: nothing is sent, the page shows them, the room follows the new memory.
    await ev(() => M.add(3));
    y = await look();
    await afterMem(2, RESET('other1'), { up: true });
    await ev(() => { toastr.log.length = 0; return __savePoint.handle('run').catch(() => {}); });
    await wait(3000);
    x = await look();
    r = { held: await said(/채팅 저장은 보류/), wid: await wid() };
    ok(x.sp === y.sp && x.server.length === 0 && x.page.length === 0 && r.held > 0 && x.file === -1,
        `1. 일반 세이브: 기억 확인 뒤 리셋 완료 → 옛 숨김 요청 0회, 새 기억 따름 (before=${JSON.stringify(y)} after=${JSON.stringify(x)} ${JSON.stringify(r)})`);

    // 2. a background chat save (outside a change); the same reset ends right after its memory check.
    await ev(() => { toastr.log.length = 0; });
    y = await fresh();
    ok(y.page.length > 0 && y.page.join() === y.server.join(), `2. 준비 (${JSON.stringify(y)})`);
    await afterMem(1, RESET('other2'));
    await ev(() => __savePoint.persistSoon());
    await wait(3000);
    x = await look();
    r = { wid: await wid() };
    ok(x.sp === y.sp && x.server.length === 0 && x.page.length === 0 && x.file === -1,
        `2. 백그라운드 저장: 기억 확인 뒤 리셋 완료 → 요청 0회, 새 기억 따름 (before=${JSON.stringify(y)} after=${JSON.stringify(x)} ${JSON.stringify(r)})`);

    // 3. half a reset: the hides are taken away in the chat file, the memory is not (yet). The save sends nothing; the page shows the
    // released messages and keeps them shown after the memory is checked again (same receipt), through an automatic record (with
    // and without new messages), a recount and the time a held save would take. A save pressed again hides them.
    y = await fresh();
    const w3 = await wid();
    await ev(() => M.add(3));
    y = await look();
    await afterMem(2, RESET(''), { up: true });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(3000);
    x = await look();
    ok(x.sp === y.sp && x.server.length === 0 && x.page.length === 0 && await wid() !== w3 && !x.stop,
        `3. 리셋 절반: 요청 0회, 풀린 원문 화면에도 보임 (before=${JSON.stringify(y)} after=${JSON.stringify(x)})`);
    const R3 = y.page.slice(), shownR = x => !x.page.some(i => R3.includes(i)) && !x.server.some(i => R3.includes(i));
    const w3b = await wid();
    await ev(() => { __savePoint.syncHide(); return __savePoint.recheckHome(); });
    await wait(2500);
    x = await look();
    ok(x.page.length === 0 && x.server.length === 0 && x.sp === y.sp && await wid() === w3b, `3. 재확인·숨김 재계산·보류된 저장 → 그대로 보임, 자동 재시도 없음 (${JSON.stringify(x)})`);
    await ev(() => __savePoint.summarize({ auto: true }).catch(() => {}));
    await wait(2500);
    x = await look();
    ok(shownR(x) && x.page.join() === x.server.join() && covered(x), `3. 자동 기록(새 메시지 없음) → 풀린 원문은 그대로 (${JSON.stringify(x)})`);
    await ev(() => M.add(3));
    const before3 = await look();
    await ev(() => __savePoint.summarize({ auto: true }).catch(() => {}));
    await wait(2500);
    x = await look();
    ok(x.file > before3.file && shownR(x) && x.page.length > 0 && x.page.join() === x.server.join() && covered(x),
        `3. 자동 기록(새 메시지) → 풀린 원문은 그대로, 그 뒤만 숨김 (before=${JSON.stringify(before3)} after=${JSON.stringify(x)})`);
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(2500);
    x = await look();
    ok(x.page[0] === 0 && x.page.length === x.file - 1 && x.page.join() === x.server.join() && covered(x), `3. 새로 누른 세이브 → 다시 숨김 (${JSON.stringify(x)})`);

    // 4. right after a save's memory check SillyTavern saves (a wait follows), and another device saves the memory in that wait (no
    // hide changes in the chat file): the memory is checked again after the wait; nothing is sent.
    await ev(() => M.add(3));
    y = await look();
    await afterMem(2, `() => { M.stScript.setChatSaving(true); setTimeout(async () => { await (${OTHER_SAVE('other4')})(); M.stScript.setChatSaving(false); }, 300); }`, { up: true });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(3000);
    x = await look();
    ok(x.sp === y.sp && x.server.join() === y.server.join() && !!x.stop, `4. 일반 세이브: 기다리는 사이 기억 바뀜 → 다시 확인해서 요청 0회 (before=${JSON.stringify(y)} after=${JSON.stringify(x)})`);
    // a background save, the same.
    y = await fresh();
    await afterMem(1, `() => { M.stScript.setChatSaving(true); setTimeout(async () => { await (${OTHER_SAVE('other4b')})(); M.stScript.setChatSaving(false); }, 300); }`);
    await ev(() => __savePoint.persistSoon());
    await wait(3000);
    x = await look();
    ok(x.sp === y.sp && !!x.stop, `4. 백그라운드 저장: 기다리는 사이 기억 바뀜 → 요청 0회 (before=${JSON.stringify(y)} after=${JSON.stringify(x)})`);
    // the chat write's own wait (after the last chat read): the memory is read again before its first request.
    y = await fresh();
    await ev(() => M.add(3));
    y = await look();
    await afterCheck(`() => { M.stScript.setChatSaving(true); setTimeout(async () => { await (${OTHER_SAVE('other4c')})(); M.stSave(); M.stScript.setChatSaving(false); }, 300); }`);
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(3000);
    x = await look();
    ok(x.sp === y.sp && x.server.join() === y.server.join() && !!x.stop, `4. 채팅 쓰기의 기다림 중 기억 바뀜 → 첫 요청 전에 다시 확인, 요청 0회 (before=${JSON.stringify(y)} after=${JSON.stringify(x)})`);

    // 5. (known limit) the reset ends after the last check, while this tab's request is on its way: the old hides land over the
    // release. Put right when the memory is checked again (다시 확인): the room follows the emptied memory and shows them, also on the server.
    y = await fresh();
    await ev(() => M.add(3));
    y = await look();
    await ev(`(() => {
        const f = window.fetch;
        window.fetch = async (u, o) => {
            if (String(u) === '/api/chats/save') { window.fetch = f; await (${RESET('other5')})(); return f(u, o); }
            return f(u, o);
        };
    })()`);
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(2500);
    x = await look();
    ok(x.sp === y.sp + 1 && x.server.length > 0, `5. (한계) 마지막 확인 뒤 리셋이 끝나고 이미 떠난 요청이 그 위에 도착 → 옛 숨김이 서버에 남음 (${JSON.stringify(x)})`);
    await ev(() => __savePoint.recheckHome()); await wait(2500);
    x = await look();
    ok(x.page.length === 0 && x.server.length === 0 && x.file === -1, `5. 다시 확인 → 새 기억을 따라 모두 보임 (${JSON.stringify(x)})`);

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
