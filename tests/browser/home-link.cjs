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

(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    // Open a fresh page (a new SillyTavern session) with optional preset settings / server files.
    async function session({ settings, files, serverDown, width = 390 } = {}) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.addInitScript(([s, f, d]) => { if (s) window.__presetSettings = s; if (f) window.__presetFiles = f; if (d) window.__presetServerDown = true; }, [settings || null, files || null, !!serverDown]);
        await page.goto(URL);
        await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
        await page.waitForTimeout(300);
        return page;
    }
    // v0.6.61: one rule for every change decided before its turn (review of v0.6.60): rewind, QUICK, a load
    // waiting behind a loot, an unconfirmed checkpoint proved by its receipt, a check started while the room
    // v0.7.0-b1: the room's memory lives in its own memory file. A new room, a reopened room (link), an old room (move out
    // of the chat file), a lost tag (relink), a branch, a rename; a change of the memory alone writes no chat file; another
    // device's memory write stops the room (before the memory write, and right before a chat write: P1-1); a memory write
    // with no answer stops the room's memory writes (P1-2); a room whose files cannot be read writes nothing and says why.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, hideMode: 'off', keepRecent: 2, askResume: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const H = () => ev(() => { const h = __savePoint.home(); return { status: h.status, why: h.why, id: h.id, verdict: h.d?.verdict ?? null, row: h.d?.row ?? null, last: __savePoint.state()?.lastIndex ?? null, stop: h.line?.stop ?? null, pending: !!h.line?.pending }; });
    const memOf = id => ev(async id => { const H = await import('/ext/home.js'); const t = M.files.get(H.memName(id)); return t ? JSON.parse(t) : null; }, id);
    const names = () => ev(() => [...M.files.keys()].filter(n => /^savepoint-(mem|room|int|moved|moving|copy)-/.test(n)).sort());
    let r, h;

    // 1. a new room: no file until the first change; a save writes the memory file (and its tag and hint), no chat file.
    h = await H();
    ok(h.status === 'new' && !!h.id && (await names()).length === 0, `1. 새 방: 파일 없이 'new' (${JSON.stringify(h)})`);
    await ev(() => M.add(8));
    r = await ev(() => M.spSaves);
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    h = await H();
    const id1 = h.id, file1 = await memOf(id1);
    r = { before: r, after: await ev(() => M.spSaves), meta: await ev(() => M.serverFiles[M.chatId][0].chat_metadata.savePoint ?? null) };
    ok(h.status === 'linked' && h.last === 7 && file1?.state?.lastIndex === 7 && file1.home.addr === await ev(() => JSON.stringify(['ari.png', M.chatId])), `1. 첫 세이브 → 기억 파일 생성·연결 (${JSON.stringify(h)}, rev ${file1?.rev})`);
    ok(r.after === r.before && r.meta === null, `1. 첫 세이브의 채팅 저장 0회, 채팅 파일에 기억 없음 (${JSON.stringify(r)})`);

    // 2. a memory-only change (an edit, and a save in manual hide mode) writes the memory file only.
    r = await ev(() => ({ sp: M.spSaves, rev: JSON.parse(M.files.get([...M.files.keys()].find(n => n.startsWith('savepoint-mem-')))).rev }));
    await ev(() => __savePoint.commitEdit(mem => { mem.scenes[0].star = !mem.scenes[0].star; }));
    await wait(300);
    await ev(() => { M.settings.savePoint.hideMode = 'manual'; M.add(4); });
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const f2 = await memOf(id1);
    r = { ...r, sp2: await ev(() => M.spSaves), rev2: f2.rev, last: f2.state.lastIndex, star: f2.state.mem.scenes[0].star };
    ok(r.sp2 === r.sp && r.rev2 >= r.rev + 2 && r.last === 11 && r.star === true, `2. 편집·수동 하이드 모드 세이브: 기억 파일만, 채팅 저장 0회 (${JSON.stringify(r)})`);

    // 3. the room opened again: linked to the same memory file (row 3), nothing written.
    r = await ev(() => ({ puts: M.fileLog.filter(x => x[0] === 'put').length, sp: M.spSaves }));
    await ev(() => M.openFile(M.chatId)); await wait(700);
    h = await H();
    r = { ...r, puts2: await ev(() => M.fileLog.filter(x => x[0] === 'put').length), sp2: await ev(() => M.spSaves) };
    ok(h.status === 'linked' && h.verdict === 'link' && h.row === 3 && h.last === 11 && r.puts2 === r.puts && r.sp2 === r.sp, `3. 다시 열기 → 연결, 쓰기 0 (${JSON.stringify(h)} ${JSON.stringify(r)})`);

    // 4. an old room with its memory in the chat file: moved out to a memory file; the chat file's old copy is left as it is.
    const old = await ev(() => JSON.parse(JSON.stringify(__savePoint.state())));
    await ev(([o]) => { const list = JSON.parse(JSON.stringify(M.chat)); M.serverFiles.oldRoom = [{ chat_metadata: { integrity: 'old-int', savePoint: { ...o, roomKey: JSON.stringify(['ari.png', 'oldRoom']) } } }, ...list]; return M.openFile('oldRoom'); }, [old]);
    await wait(900);
    h = await H();
    const oldCopy = await ev(() => JSON.stringify(M.serverFiles.oldRoom[0].chat_metadata.savePoint));
    await ev(() => { M.settings.savePoint.hideMode = 'auto'; M.add(4); });
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const h4 = await H(), mf4 = await memOf(h.id);
    r = { same: await ev(() => JSON.stringify(M.serverFiles.oldRoom[0].chat_metadata.savePoint)) === oldCopy, hidden: await ev(() => M.serverFiles.oldRoom.slice(1).filter(m => m.is_system).length), last: mf4?.state?.lastIndex };
    ok(h.status === 'linked' && h.verdict === 'migrate' && h.last === 11 && mf4?.from?.kind === 'migrate', `4. 예전 방 → 기억 파일로 이전 (${JSON.stringify(h)})`);
    ok(h4.status === 'linked' && r.same && r.last === 15 && r.hidden > 0, `4. 이전 뒤 세이브: 채팅 파일의 예전 사본은 그대로, 숨김은 채팅 파일에 (${JSON.stringify(r)})`);

    // 5. the tag lost (the writes stopped before it): linked again from the memory file (row 6), tag written back.
    const tag5 = await ev(async () => { const H = await import('/ext/home.js'); const n = H.tagName(JSON.stringify(['ari.png', 'oldRoom'])); M.otherDel(n); return n; });
    await ev(() => M.openFile('oldRoom')); await wait(900);
    h = await H();
    ok(h.status === 'linked' && h.verdict === 'relink' && h.last === 15 && await ev(n => M.files.has(n), tag5), `5. 이름표 없음 → 연결 복구 (${JSON.stringify(h)})`);

    // 6. a branch: its own memory worked out from the parent's (the parent's file untouched).
    const parentFile = JSON.stringify(await memOf(h.id));
    await ev(() => M.branchChat('branchB', 9));
    await ev(() => M.openFile('branchB')); await wait(900);
    const h6 = await H();
    ok(h6.status === 'linked' && h6.verdict === 'branch' && h6.id !== h.id && h6.last !== null && h6.last <= 9 && JSON.stringify(await memOf(h.id)) === parentFile, `6. 분기 → 자기 기억 파일, 원래 방 파일은 그대로 (${JSON.stringify(h6)})`);

    // 7. a rename seen here: the memory moves its home to the new name (old one kept), new tag, old tag marked renamed.
    await ev(() => M.openFile('oldRoom')); await wait(700);
    const quickOld = await ev(() => __savePoint.listSaves().filter(x => x.quick && x.room === JSON.stringify(['ari.png', 'oldRoom'])).length);
    await ev(() => M.renameChat('oldRoom', 'newRoom'));
    await wait(1200);
    h = await H();
    r = await ev(async () => {
        const H = await import('/ext/home.js'), from = JSON.stringify(['ari.png', 'oldRoom']), to = JSON.stringify(['ari.png', 'newRoom']);
        const t = n => { const x = M.files.get(n); return x ? JSON.parse(x) : null; };
        const mem = t(H.memName(__savePoint.home().id));
        return { oldTag: t(H.tagName(from))?.state, newTag: t(H.tagName(to))?.state, home: mem?.home?.addr === to, was: mem?.home?.was, roomKey: mem?.state?.roomKey === to,
            saves: document.querySelector('#sp_overlay') ? null : __savePoint.listSaves().filter(x => x.quick && x.room === from).length };
    });
    ok(h.status === 'linked' && h.last === 15 && r.oldTag === 'renamed' && r.newTag === 'linked' && r.home && r.roomKey && JSON.stringify(r.was) === JSON.stringify([JSON.stringify(['ari.png', 'oldRoom'])]), `7. 이름 변경 → 본체 home·새 이름표·옛 이름표 renamed (${JSON.stringify(h)} ${JSON.stringify(r)})`);
    await ev(() => M.openFile('newRoom')); await wait(700);
    h = await H();
    ok(h.status === 'linked' && h.verdict === 'link' && quickOld >= 1, `7. 새 이름으로 다시 열기 → 연결 (${JSON.stringify(h)}, 옛 QUICK ${quickOld})`);

    // 8. another device wrote the memory file: the next change writes nothing over it, and the room stops.
    const mid = (await H()).id;
    await ev(async id => { const H = await import('/ext/home.js'); const n = H.memName(id); const f = JSON.parse(M.files.get(n)); M.otherPut(n, { ...f, rev: f.rev + 1, wid: 'other-device', recent: [...f.recent, { rev: f.rev + 1, wid: 'other-device' }] }); }, mid);
    await ev(() => M.add(4));
    r = await ev(() => M.spSaves);
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    h = await H();
    const f8 = await memOf(mid);
    ok(f8.wid === 'other-device' && h.stop === 'conflict' && await ev(() => M.spSaves) === r, `8. 다른 기기 기억 → 덮지 않고 멈춤, 채팅 저장 0 (${JSON.stringify(h)}, ${f8.wid})`);
    r = await ev(() => toastr.log.slice(-2).map(x => x[1]).join(' | '));
    ok(/다른 곳/.test(r), `8. 이유 안내 (${r.slice(0, 120)})`);

    // 9. P1-1: another device writes the memory file after our memory write and before our chat write: no chat write.
    await ev(() => M.openFile('newRoom')); await wait(900);
    h = await H();
    ok(h.status === 'linked' && h.verdict === 'link', `9. 다시 열면 다른 기기 기억으로 연결 (${JSON.stringify(h)})`);
    await ev(id => {
        const f = window.fetch;
        let uploaded = false, reads = 0;
        window.fetch = async (u, o) => {
            const s = String(u);
            const res = await f(u, o);
            if (s === '/api/files/upload' && JSON.parse(o.body).name.includes(id)) { uploaded = true; reads = 0; }
            if (uploaded && s.startsWith('/user/files/savepoint-mem-' + id) && ++reads === 1) {
                const n = 'savepoint-mem-' + id + '.json', cur = JSON.parse(M.files.get(n));
                M.otherPut(n, { ...cur, rev: cur.rev + 1, wid: 'late-other', recent: [...cur.recent, { rev: cur.rev + 1, wid: 'late-other' }] });
                window.fetch = f;
            }
            return res;
        };
    }, h.id);
    r = await ev(() => ({ sp: M.spSaves, hidden: M.serverFiles.newRoom.slice(1).filter(m => m.is_system).length }));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    h = await H();
    r = { ...r, sp2: await ev(() => M.spSaves), hidden2: await ev(() => M.serverFiles.newRoom.slice(1).filter(m => m.is_system).length), page: await ev(() => M.chat.filter(m => m.is_system).length) };
    ok(r.sp2 === r.sp && r.hidden2 === r.hidden && r.page === r.hidden && h.stop === 'conflict', `9. 채팅 쓰기 직전 기억 파일 확인 → 숨김 쓰지 않음·화면 숨김 되돌림 (${JSON.stringify(r)} ${JSON.stringify(h)})`);

    // 10. P1-2: a memory write whose answer is lost: the room writes no more memory until opened again.
    await ev(() => M.openFile('newRoom')); await wait(900);
    // The lost request lands only later (after the next change was tried): nothing may be written before it.
    await ev(() => { M.settings.savePoint.hideMode = 'off'; const f = window.fetch; window.fetch = async (u, o) => { if (String(u) === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) { window.fetch = f; M.late = () => f(u, o); throw new TypeError('Failed to fetch'); } return f(u, o); }; });
    await ev(() => __savePoint.commitEdit(mem => { mem.scenes[0].star = !mem.scenes[0].star; }).catch(e => e.message));
    await wait(300);
    h = await H();
    const rev10 = (await memOf(h.id)).rev;
    r = await ev(() => __savePoint.commitEdit(mem => { mem.scenes[0].pin = !mem.scenes[0].pin; }).then(() => 'saved', e => e.message));
    await wait(300);
    const puts10 = await ev(() => M.fileLog.filter(x => x[0] === 'put' && x[1].startsWith('savepoint-mem-')).length);
    await ev(() => M.late()); await wait(200);
    const late = await memOf(h.id);
    ok(h.pending && late.rev === rev10 + 1 && puts10 === await ev(() => M.fileLog.filter(x => x[0] === 'put' && x[1].startsWith('savepoint-mem-')).length) - 1 && /응답|저장하지/.test(r), `10. 응답 끊김 → 늦은 요청이 오기 전까지 그 방 기억 쓰기 0 (${JSON.stringify(h)}, rev ${rev10}→${late.rev}, ${r.slice(0, 60)})`);
    await ev(() => M.openFile('newRoom')); await wait(900);
    h = await H();
    ok(h.status === 'linked' && !h.pending, `10. 다시 열면 기억 파일 기준으로 연결 (${JSON.stringify(h)})`);

    // 11. a file that cannot be read: nothing written, the reason shown with 다시 확인; then linked.
    const tag11 = await ev(async () => { const H = await import('/ext/home.js'); const n = H.tagName(JSON.stringify(['ari.png', 'newRoom'])); M.fileState[n] = 'error'; return n; });
    await ev(() => M.openFile('newRoom')); await wait(900);
    h = await H();
    await ev(() => { if (!__savePoint.ui.open) $('#sp_wand').trigger('click'); }); await wait(200);
    await ev(() => __savePoint.render(true));
    r = await ev(() => ({ alert: document.querySelector('.sp-home-alert')?.textContent || '', btn: !!document.querySelector('.sp-home-alert [data-act="home-recheck"]'), sp: M.spSaves, puts: M.fileLog.filter(x => x[0] === 'put').length }));
    await ev(() => M.add(2));
    const blocked = await ev(() => __savePoint.transact(() => {}).then(() => 'saved', e => e.message));
    await ev(() => M.eventSource.emit('generation_started', 'normal', {}, false)); await ev(() => M.eventSource.emit('generation_ended'));
    const warned = await ev(() => toastr.log.slice(-3).some(x => x[0] === 'warning' && /연결되지 않아서/.test(x[1])));
    ok(h.status === 'readFail' && h.last === null && /읽지 못했/.test(r.alert) && r.btn && /읽지|찾는/.test(blocked), `11. 읽기 실패 → 쓰기 0·이유·다시 확인 (${JSON.stringify(h)}, ${blocked.slice(0, 50)})`);
    ok(warned, '11. 연결 전 일반 전송 → 경고 알림');
    await ev(n => { M.fileState = {}; }, tag11);
    await ev(() => __savePoint.handle('home-recheck')); await wait(900);
    h = await H();
    ok(h.status === 'linked' && h.verdict === 'link', `11. 다시 확인 → 연결 (${JSON.stringify(h)})`);

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
