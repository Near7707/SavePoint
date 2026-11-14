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
    // v0.7.0-b1a (review P3): the old name's QUICK is listed in the renamed room (sameRoom: the memory's `was`).
    const quickNew = await ev(() => __savePoint.listSaves().filter(x => x.quick && __savePoint.sameRoom(x.room) && x.room === JSON.stringify(['ari.png', 'oldRoom'])).length);
    ok(h.status === 'linked' && h.verdict === 'link' && quickOld >= 1 && quickNew === quickOld, `7. 새 이름으로 다시 열기 → 연결, 옛 이름의 QUICK이 이 방 목록에 (${JSON.stringify(h)}, 옛 QUICK ${quickOld} → 이 방 ${quickNew})`);

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
    // v0.7.0-b1a (review P3): nothing was written while the room was not linked (chat saves and user files).
    r = { ...r, sp2: await ev(() => M.spSaves), puts2: await ev(() => M.fileLog.filter(x => x[0] === 'put').length) };
    ok(r.sp2 === r.sp && r.puts2 === r.puts, `11. 읽기 실패 중 채팅 저장·파일 쓰기 0 (${JSON.stringify({ sp: [r.sp, r.sp2], puts: [r.puts, r.puts2] })})`);
    await ev(n => { M.fileState = {}; }, tag11);
    await ev(() => __savePoint.handle('home-recheck')); await wait(900);
    h = await H();
    ok(h.status === 'linked' && h.verdict === 'link', `11. 다시 확인 → 연결 (${JSON.stringify(h)})`);

    // ───── v0.7.0-b1a (review of b1) ─────
    const H12 = () => H();
    const hiddenOf = id => ev(id => (M.serverFiles[id] || []).slice(1).filter(m => m.is_system).length, id);
    // 12. P1-1: another room opened (and linked) while this room's memory write is on its way: the change writes no chat
    // file at all (not this room's, not the room open now).
    await ev(() => { M.settings.savePoint.hideMode = 'auto'; }); await ev(() => M.openFile('newRoom')); await wait(900);
    await ev(() => M.add(4));
    r = await ev(() => ({ sp: M.spSaves, b: JSON.stringify(M.serverFiles.branchB), n: JSON.stringify(M.serverFiles.newRoom) }));
    await ev(() => { M.beforeUpload = async name => { if (!name.startsWith('savepoint-mem-')) return; M.beforeUpload = null; await M.openFile('branchB'); await new Promise(r => setTimeout(r, 900)); }; });
    await ev(() => __savePoint.handle('run'));
    await wait(2500);
    h = await H12();
    r = { sp: [r.sp, await ev(() => M.spSaves)], bSame: await ev(() => JSON.stringify(M.serverFiles.branchB)) === r.b, nSame: await ev(() => JSON.stringify(M.serverFiles.newRoom)) === r.n, room: await ev(() => M.chatId), status: h.status };
    ok(r.sp[0] === r.sp[1] && r.bSame && r.nSame && r.room === 'branchB' && r.status === 'linked', `12. 기억 저장 중 다른 방 열림 → 어느 채팅 파일도 쓰지 않음 (${JSON.stringify(r)})`);

    // 12b. P1-1: another device adds a reply to the chat file while the memory write is on its way: the chat file is read
    // again before it is written, the reply stays, the room stops.
    await ev(() => M.openFile('newRoom')); await wait(900);
    await ev(() => M.add(4));
    r = await ev(() => ({ sp: M.spSaves, hid: M.serverFiles.newRoom.slice(1).filter(m => m.is_system).length }));
    await ev(() => { M.beforeUpload = async name => { if (!name.startsWith('savepoint-mem-')) return; M.beforeUpload = null; M.serverFiles.newRoom.push({ name: 'Other', is_user: false, mes: 'A reply saved on another device.', send_date: Date.now(), extra: {} }); }; });
    await ev(() => __savePoint.handle('run'));
    await wait(2500);
    r = { ...r, sp2: await ev(() => M.spSaves), kept: await ev(() => M.serverFiles.newRoom.some(m => m.mes === 'A reply saved on another device.')), hid2: await hiddenOf('newRoom'), page: await ev(() => M.chat.filter(m => m.is_system).length), gate: await ev(() => __savePoint.home().status) };
    ok(r.sp2 === r.sp && r.kept && r.hid2 === r.hid && r.page === r.hid, `12b. 기억 저장 중 다른 기기 답변 → 채팅 파일 쓰지 않음·답변 그대로·화면 숨김 되돌림 (${JSON.stringify(r)})`);

    // 13. P1-2: two 다시 확인 at once run one decision; a notice during an opening whose memory write got no answer never
    // decides the room again (the lost write may still land).
    const tag13 = await ev(async () => { const H = await import('/ext/home.js'); const n = H.tagName(JSON.stringify(['ari.png', 'newRoom'])); M.fileState[n] = 'error'; return n; });
    await ev(() => M.openFile('newRoom')); await wait(900);
    await ev(() => { M.fileState = {}; M.fileReads = []; });
    await ev(() => __savePoint.handle('home-recheck')); await wait(900);
    const one = await ev(n => M.fileReads.filter(x => x === n).length, tag13);
    await ev(n => { M.fileState[n] = 'error'; }, tag13);
    await ev(() => M.openFile('newRoom')); await wait(900);
    await ev(() => { M.fileState = {}; M.fileReads = []; });
    await ev(() => Promise.all([__savePoint.recheckHome(), __savePoint.recheckHome()])); await wait(900);
    h = await H12();
    const two = await ev(n => M.fileReads.filter(x => x === n).length, tag13);
    ok(h.status === 'linked' && one > 0 && two === one, `13. 다시 확인 두 번 → 판정 한 번 (이름표 읽기 ${one} / ${two}, ${h.status})`);
    // An old room moving out: its body upload loses its answer while a rename notice asks for another round.
    await ev(([o]) => { const list = JSON.parse(JSON.stringify(M.chat)); M.serverFiles.oldRoom2 = [{ chat_metadata: { integrity: 'old2-int', savePoint: { ...o, roomKey: JSON.stringify(['ari.png', 'oldRoom2']) } } }, ...list]; }, [old]);
    await ev(() => {
        const f = window.fetch;
        window.fetch = async (u, o) => {
            if (String(u) === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) {
                window.fetch = f; M.late = () => f(u, o);
                await M.eventSource.emit(M.event_types.CHAT_RENAMED, { avatarId: 'ari.png', oldFileName: 'zz-a.jsonl', newFileName: 'zz-b.jsonl' });
                throw new TypeError('Failed to fetch');
            }
            return f(u, o);
        };
    });
    const puts13 = await ev(() => M.fileLog.filter(x => x[0] === 'put' && x[1].startsWith('savepoint-mem-')).length);
    await ev(() => M.openFile('oldRoom2')); await wait(1500);
    h = await H12();
    r = { puts: (await ev(() => M.fileLog.filter(x => x[0] === 'put' && x[1].startsWith('savepoint-mem-')).length)) - puts13, status: h.status, pending: h.pending };
    ok(r.puts === 0 && r.status === 'pending' && r.pending, `13. 이전 중 응답 끊김 + 이름 변경 알림 → 다시 판정하지 않음, 기억 쓰기 0 (${JSON.stringify(r)})`);
    await ev(() => M.late && M.late()); await wait(200);

    // 14. P1-3: another device made this new room's memory first: the first change is not taken as written.
    await ev(() => { const list = JSON.parse(JSON.stringify(M.chat.slice(0, 6))); list.forEach(m => { delete m.is_system; if (m.extra) for (const k of Object.keys(m.extra)) if (k.startsWith('savepoint')) delete m.extra[k]; }); M.serverFiles.freshRoom = [{ chat_metadata: { integrity: 'fresh-int' } }, ...list]; });
    await ev(() => M.openFile('freshRoom')); await wait(900);
    h = await H12();
    const new14 = h.status;
    await ev(async ([o]) => {
        const H = await import('/ext/home.js'), hm = __savePoint.home(), addr = JSON.stringify(['ari.png', 'freshRoom']);
        const st = { ...o, roomKey: addr, linkedSave: null, lastIndex: 2, hashes: o.hashes.slice(0, 3), floor: 2, rev: 1, wid: 'other-first' };
        M.otherPut(H.memName(hm.id), H.memBody({ id: hm.id, state: st, wid: 'other-first', from: hm.from, home: { addr, integrity: 'fresh-int' } }));
        M.otherPut(H.tagName(addr), H.tagBody({ addr, integrity: 'fresh-int', mem: hm.id }));
    }, [old]);
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    h = await H12();
    const f14 = await memOf(h.id);
    r = { was: new14, wid: f14?.wid, stop: h.stop, log: await ev(() => toastr.log.slice(-1).map(x => x[1].slice(0, 60))), page: await ev(() => __savePoint.state()?.lastIndex ?? null) };
    ok(new14 === 'new' && f14?.wid === 'other-first' && h.stop === 'conflict' && r.page !== 5, `14. 다른 기기가 새 방 기억을 먼저 만듦 → 내 저장 성공 아님·멈춤 (${JSON.stringify(r)})`);

    // 15. P1-4: a room renamed in the list while an imported copy of it is open (just opened): the copy is never taken as
    // the renamed room. The room open itself renamed with a name the server cleans still is.
    await ev(() => M.openFile('newRoom')); await wait(900);
    const copy15 = await ev(() => M.importChat('newRoom'));
    await ev(n => M.openFile(n), copy15); await wait(900);
    const h15 = await H12();
    await ev(() => M.renameChat('newRoom', 'listRenamed')); await wait(900);
    h = await H12();
    r = await ev(n => ({ guess: __savePoint.settings().renames.some(x => x.to === JSON.stringify(['ari.png', n])), home: (() => { const t = [...M.files.keys()].filter(k => k.startsWith('savepoint-mem-')).map(k => JSON.parse(M.files.get(k)).home.addr); return t.includes(JSON.stringify(['ari.png', n])); })() }), copy15);
    ok(h15.status === 'held' && h.status === 'held' && !r.guess && !r.home, `15. 목록에서 다른 방 이름 변경 → 가져온 사본으로 기억을 옮기지 않음 (${h15.status}/${h.status} ${JSON.stringify(r)})`);
    await ev(() => M.openFile('listRenamed')); await wait(900);
    await ev(() => M.renameChat('listRenamed', 'clean:ed?', { saved: 'cleaned' })); await wait(1200);
    h = await H12();
    const home15 = await ev(() => { const t = M.files.get('savepoint-mem-' + __savePoint.home().id + '.json'); return t ? JSON.parse(t).home?.addr : null; });
    ok(h.status === 'linked' && home15 === JSON.stringify(['ari.png', 'cleaned']), `15. 열린 방 이름 변경(서버가 이름 정리) → 그대로 옮겨짐 (${JSON.stringify(h)} ${home15})`);

    // ───── v0.7.0-b1a (review of b1a) ─────
    const room = () => ev(() => M.chatId);
    const spSaves = () => ev(() => M.spSaves);
    // 18. P1-3: a background chat save (a hide set outside a queued change): another device adds a reply while the memory
    // file is read; the chat file is read after it, so the reply stays and nothing is written.
    await ev(() => M.openFile('cleaned')); await wait(900);
    r = await ev(() => {
        const i = M.chat.findIndex(m => m.is_system && m.extra?.savepointHidden);
        if (i < 0) return { i };
        const m = M.chat[i]; delete m.is_system; delete m.extra.savepointHidden;
        __savePoint.adoptPage();
        return { i, sp: M.spSaves };
    });
    await ev(() => {
        const f = window.fetch;
        window.fetch = async (u, o) => {
            if (String(u).startsWith('/user/files/savepoint-mem-')) { window.fetch = f; M.serverFiles[M.chatId].push({ name: 'Other', is_user: false, mes: 'Another device, background.', send_date: Date.now(), extra: {} }); }
            return f(u, o);
        };
    });
    await ev(() => __savePoint.syncHide());
    await wait(2500);
    r = { ...r, sp2: await spSaves(), kept: await ev(() => M.serverFiles[M.chatId].some(m => m.mes === 'Another device, background.')) };
    ok(r.i >= 0 && r.sp2 === r.sp && r.kept, `18. 백그라운드 채팅 저장: 기억 파일 읽는 사이 다른 기기 답변 → 채팅 파일 쓰지 않음·답변 그대로 (${JSON.stringify(r)})`);

    // 19. P1-4: a message this change hides is edited on this page (and saved by SillyTavern) during the last chat check:
    // no hide goes out, the edited message is shown.
    await ev(() => M.openFile('cleaned')); await wait(900);
    await ev(() => M.add(4));
    r = await spSaves();
    await ev(() => {
        const f = window.fetch;
        let up = false;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) up = true;
            else if (up && s === '/api/chats/get') {
                window.fetch = f;
                const server = M.serverFiles[M.chatId].slice(1), i = M.chat.findIndex((m, k) => m.is_system && !server[k]?.is_system);
                window.__edited = i;
                if (i >= 0) { M.chat[i].mes += ' (edited here)'; M.chat[i].swipes && (M.chat[i].swipes[M.chat[i].swipe_id || 0] = M.chat[i].mes); M.stSave(); }
            }
            return f(u, o);
        };
    });
    await ev(() => __savePoint.handle('run'));
    await wait(2500);
    r = { sp: [r, await spSaves()], ...(await ev(() => { const i = window.__edited, m = M.serverFiles[M.chatId][i + 1]; return { i, server: !!m?.is_system, page: !!M.chat[i]?.is_system, edited: /edited here/.test(m?.mes || '') }; })) };
    // The hide SillyTavern's own save carried (`server`) is P1-5 of the b1 review: b2 (H1) sets a hide only after its memory.
    // v0.7.0-b1c (review of b1b, P1-2): hides before the edited message rest on unchanged messages and may still go out (a
    // chat save then); the edited one is never hidden by SavePoint's write.
    ok(r.i >= 0 && (r.sp[0] === r.sp[1] || !r.server) && !r.page && r.edited, `19. 마지막 확인 중 숨길 원문이 바뀜 → SavePoint는 숨김 저장 안 함·화면 숨김 풀림 (${JSON.stringify(r)})`);

    // 20. P1-5: a rename seen before follows the room (A → B → C in the list); an imported copy renamed to B later is not
    // taken for A. Opening C still takes A's memory.
    await ev(() => M.openFile('cleaned')); await wait(900);
    const mem20 = (await H()).id;
    const copy20 = await ev(() => M.importChat('cleaned', 'copy20'));
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('cleaned', 'rB')); await ev(() => M.renameChat('rB', 'rC')); await ev(() => M.renameChat('copy20', 'rB'));
    await ev(() => M.openFile('rB')); await wait(1200);
    h = await H();
    const home20 = await ev(id => JSON.parse(M.files.get('savepoint-mem-' + id + '.json')).home.addr, mem20);
    ok(h.status === 'held' && h.verdict !== 'rename' && home20 === JSON.stringify(['ari.png', 'cleaned']), `20. 옛 이름을 이어받은 사본 → 원래 기억을 옮기지 않음 (${JSON.stringify(h)} ${home20})`);
    await ev(() => M.openFile('rC')); await wait(1200);
    h = await H();
    const home20c = await ev(id => JSON.parse(M.files.get('savepoint-mem-' + id + '.json')).home.addr, mem20);
    ok(h.status === 'linked' && h.verdict === 'rename' && h.id === mem20 && home20c === JSON.stringify(['ari.png', 'rC']), `20. 두 번 바꾼 원래 방 → 기억 이어받음 (${JSON.stringify(h)} ${home20c})`);

    // 16. P1-1: another device made this new room's memory first and the read after it fails: still not this change's.
    const newRoom = name => ev(([n, i]) => { const list = JSON.parse(JSON.stringify(M.chat.slice(0, 6))); list.forEach(m => { delete m.is_system; if (m.extra) for (const k of Object.keys(m.extra)) if (k.startsWith('savepoint')) delete m.extra[k]; }); M.serverFiles[n] = [{ chat_metadata: { integrity: i } }, ...list]; return M.openFile(n); }, [name, name + '-int']);
    await newRoom('fresh16'); await wait(900);
    const id16 = (await H()).id;
    await ev(async ([o]) => {
        const H = await import('/ext/home.js'), hm = __savePoint.home(), addr = JSON.stringify(['ari.png', 'fresh16']);
        const st = { ...o, roomKey: addr, linkedSave: null, lastIndex: 2, hashes: o.hashes.slice(0, 3), floor: 2, rev: 1, wid: 'other16' };
        M.otherPut(H.memName(hm.id), H.memBody({ id: hm.id, state: st, wid: 'other16', from: hm.from, home: { addr, integrity: 'fresh16-int' } }));
        M.otherPut(H.tagName(addr), H.tagBody({ addr, integrity: 'fresh16-int', mem: hm.id }));
        const f = window.fetch; let n = 0;
        window.fetch = async (u, op) => { if (String(u).startsWith('/user/files/' + H.memName(hm.id)) && ++n === 2) { window.fetch = f; return new Response('down', { status: 503 }); } return f(u, op); };
    }, [old]);
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    h = await H();
    await ev(() => __savePoint.commitEdit(mem => { if (mem.scenes[0]) mem.scenes[0].star = !mem.scenes[0].star; }).catch(() => {})); await wait(500);
    const f16 = await memOf(id16);
    ok(f16?.wid === 'other16' && h.stop === 'conflict', `16. 새 방 첫 저장: 다른 기기 기억 + 마지막 읽기 실패 → 충돌로 멈춤, 다음 편집도 안 덮음 (${JSON.stringify(h)} ${f16?.wid})`);

    // 17. P1-2: a rename notice while a new room's first memory write is on its way: the room is not decided again, and the
    // memory written stays on the page (the next change keeps it).
    await newRoom('fresh17'); await wait(900);
    await ev(() => { M.beforeUpload = async name => { if (!name.startsWith('savepoint-mem-')) return; M.beforeUpload = null; await M.eventSource.emit(M.event_types.CHAT_RENAMED, { avatarId: 'ari.png', oldFileName: 'zz-c.jsonl', newFileName: 'zz-d.jsonl' }); await new Promise(r => setTimeout(r, 600)); }; });
    await ev(() => __savePoint.handle('run'));
    await wait(2000);
    h = await H();
    await ev(() => __savePoint.commitEdit(mem => { mem.scenes[0].star = !mem.scenes[0].star; }).catch(e => e.message)); await wait(500);
    const f17 = await memOf(h.id);
    r = { page: await ev(() => __savePoint.state()?.lastIndex ?? null), file: f17?.state?.lastIndex ?? null, scenes: f17?.state?.mem?.scenes?.length ?? 0 };
    ok(h.status === 'linked' && r.page !== null && r.page >= 0 && r.file === r.page && r.scenes > 0, `17. 첫 저장 중 이름 변경 알림 → 다시 판정 안 함, 다음 편집도 기억 유지 (${JSON.stringify(h)} ${JSON.stringify(r)})`);

    // ───── v0.7.0-b1c (review of b1b) ─────
    const noNewHides = (before, after) => after.every((m, k) => !m?.is_system || !!before[k]?.is_system);
    // 21. P1-1: `다시 확인` (a rename notice) starts while the first change of a new room reads the chat file before its
    // memory write, and another device made this room's memory just then. The change is not applied and its outcome never
    // empties the page: the page keeps the other device's memory and its file stays theirs.
    await newRoom('fresh21'); await wait(900);
    const id21 = (await H()).id;
    await ev(async ([o]) => {
        const H = await import('/ext/home.js'), hm = __savePoint.home(), addr = JSON.stringify(['ari.png', 'fresh21']);
        const st = { ...o, roomKey: addr, linkedSave: null, lastIndex: 2, hashes: o.hashes.slice(0, 3), floor: 2, rev: 1, wid: 'other21' };
        const f = window.fetch; let armed = 'gen';
        M.lateDone = 0; M.delayOnce = 1;
        window.fetch = async (u, op) => {
            const s = String(u);
            if (armed === 'gen' && M.lateDone && s === '/api/chats/get') {
                armed = 'mem';
                M.otherPut(H.memName(hm.id), H.memBody({ id: hm.id, state: st, wid: 'other21', from: hm.from, home: { addr, integrity: 'fresh21-int' } }));
                M.otherPut(H.tagName(addr), H.tagBody({ addr, integrity: 'fresh21-int', mem: hm.id }));
                M.eventSource.emit(M.event_types.CHAT_RENAMED, { avatarId: 'ari.png', oldFileName: 'zz-e.jsonl', newFileName: 'zz-f.jsonl' });
                return f(u, op);
            }
            if (armed === 'mem' && s.startsWith('/user/files/' + H.memName(hm.id))) { armed = null; window.fetch = f; await new Promise(r => setTimeout(r, 700)); }
            return f(u, op);
        };
    }, [old]);
    await ev(() => __savePoint.handle('run'));
    await wait(3000);
    h = await H();
    r = { page: await ev(() => __savePoint.state()?.wid ?? null), last: h.last, file: (await memOf(id21))?.wid ?? null };
    ok(h.status === 'linked' && r.page === 'other21' && r.last === 2 && r.file === 'other21', `21. 첫 저장 중 다시 확인 → 변경 안 함, 화면은 다른 기기 기억 그대로·파일 안 덮음 (${JSON.stringify(h)} ${JSON.stringify(r)})`);

    // 22. P1-2: an earlier message hidden already is edited during the last chat check (saved by SillyTavern, as 19) while
    // this change hides later ones: no new hide goes out from SavePoint (they rest on the edited message) and the page
    // shows them again. (The hides SillyTavern's own save carried are P1-5 of the b1 review: b2.)
    await ev(() => M.openFile('rC')); await wait(900);
    await ev(() => M.add(4)); await wait(300);
    const before22 = await ev(() => M.chat.map(m => ({ is_system: !!m.is_system })));
    r = await spSaves();
    await ev(() => {
        const f = window.fetch; let up = false;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) up = true;
            else if (up && s === '/api/chats/get') {
                window.fetch = f;
                const server = M.serverFiles[M.chatId].slice(1), i = M.chat.findLastIndex((m, k) => m.is_system && server[k]?.is_system);
                window.__edited = i;
                window.__newHides = M.chat.filter((m, k) => m.is_system && !server[k]?.is_system).length;
                if (i >= 0) { M.chat[i].mes += ' (edited 22)'; M.chat[i].swipes && (M.chat[i].swipes[M.chat[i].swipe_id || 0] = M.chat[i].mes); M.stSave(); }
            }
            return f(u, o);
        };
    });
    await ev(() => __savePoint.handle('run'));
    await wait(2500);
    r = { sp: [r, await spSaves()], ...(await ev(() => ({ i: window.__edited, n: window.__newHides, page: M.chat.map(m => ({ is_system: !!m.is_system })), server: M.serverFiles[M.chatId].slice(1) }))) };
    // SavePoint may still write the marks that rest on nothing changed; what it writes then carries no new hide.
    ok(r.i >= 0 && r.n > 0 && noNewHides(before22, r.page) && (r.sp[0] === r.sp[1] || noNewHides(before22, r.server)), `22. 앞쪽 숨긴 원문이 바뀜 → 뒤쪽 새 숨김도 저장 안 함·화면에서도 풀림 (i=${r.i} n=${r.n} sp=${r.sp} page=${JSON.stringify(r.page.map(m => m.is_system))} server=${JSON.stringify(r.server.map(m => !!m.is_system))})`);

    // 23. P1-2: the same edit while SillyTavern saves during SavePoint's chat write (it sends the room again): the copy sent
    // again carries no new hide either.
    await ev(() => M.openFile('rC')); await wait(900);
    await ev(() => M.add(4)); await wait(300);
    const before23 = await ev(() => JSON.parse(JSON.stringify(M.serverFiles[M.chatId].slice(1))));
    await ev(() => {
        const f = window.fetch; let up = false;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) up = true;
            else if (up && s === '/api/chats/save') {
                window.fetch = f;
                M.stScript.setChatSaving(true);
                const server = M.serverFiles[M.chatId].slice(1), i = M.chat.findIndex((m, k) => m.is_system && server[k]?.is_system);
                window.__edited = i;
                if (i >= 0) { M.chat[i].mes += ' (edited 23)'; M.chat[i].swipes && (M.chat[i].swipes[M.chat[i].swipe_id || 0] = M.chat[i].mes); }
                setTimeout(() => M.stScript.setChatSaving(false), 400);
            }
            return f(u, o);
        };
    });
    await ev(() => __savePoint.handle('run'));
    await wait(3000);
    r = await ev(() => ({ i: window.__edited, after: M.serverFiles[M.chatId].slice(1), edited: M.serverFiles[M.chatId].some(m => /edited 23/.test(m.mes || '')) }));
    ok(r.i >= 0 && r.edited && noNewHides(before23, r.after), `23. 다시 보내는 채팅 저장도 새 숨김 없음 (i=${r.i} edited=${r.edited} ${JSON.stringify(r.after.map(m => !!m.is_system))} ← ${JSON.stringify(before23.map(m => !!m.is_system))})`);
    await ev(() => __savePoint.handle('home-recheck')).catch(() => {});

    // 24. P1-4: the room renamed in the list (rC → rD, not opened since); an imported copy of it takes the old name and moves
    // on (copy → rC → rE). Opening rE never moves the room's memory there.
    await ev(() => M.openFile('rC')); await wait(900);
    const mem24 = (await H()).id;
    const memHome = () => ev(id => JSON.parse(M.files.get('savepoint-mem-' + id + '.json')).home.addr, mem24);
    await ev(() => M.importChat('rC', 'copy24'));
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('rC', 'rD')); await ev(() => M.renameChat('copy24', 'rC')); await ev(() => M.renameChat('rC', 'rE'));
    await ev(() => M.openFile('rE')); await wait(1200);
    h = await H();
    r = await memHome();
    ok(h.verdict !== 'rename' && h.id !== mem24 && r === JSON.stringify(['ari.png', 'rC']), `24. 사본이 출발 이름 재사용(사본 → rC → rE) → 원본 기억 안 옮김 (${JSON.stringify(h)} ${r})`);
    // 25. A copy that takes the old name and is opened under it is not the room either (the tag there is the original's).
    await ev(() => M.importChat('rD', 'copy25'));
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('copy25', 'rC'));
    await ev(() => M.openFile('rC')); await wait(1200);
    h = await H();
    r = await memHome();
    ok(h.status === 'held' && r === JSON.stringify(['ari.png', 'rC']), `25. 옛 이름을 가져간 사본을 그 이름으로 열기 → 보류 (${JSON.stringify(h)} ${r})`);
    await ev(() => M.openFile('rD')); await wait(1200);
    h = await H();
    r = await memHome();
    ok(h.status === 'linked' && h.verdict === 'rename' && h.id === mem24 && r === JSON.stringify(['ari.png', 'rD']), `25. 원래 방(rD) → 기억 이어받음 (${JSON.stringify(h)} ${r})`);
    // 26. The room itself renamed away and back (rD → rX → rD in the list, not opened between): still its memory.
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('rD', 'rX')); await ev(() => M.renameChat('rX', 'rD'));
    await ev(() => M.openFile('rD')); await wait(1200);
    h = await H();
    ok(h.status === 'linked' && h.id === mem24, `26. 같은 방이 이름을 돌려받음(rD → rX → rD) → 그대로 연결 (${JSON.stringify(h)})`);
    // 27. P2-2: renamed twice in the list, the second time to a name the server cleans (rD → rG → "rH:x" = rHx): opening rHx
    // finds the memory.
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('rD', 'rG')); await ev(() => M.renameChat('rG', 'rH:x', { saved: 'rHx' }));
    await ev(() => M.openFile('rHx')); await wait(1200);
    h = await H();
    r = await memHome();
    ok(h.status === 'linked' && h.verdict === 'rename' && h.id === mem24 && r === JSON.stringify(['ari.png', 'rHx']), `27. 목록에서 두 번 바꾼 특수문자 이름 → 기억 찾음 (${JSON.stringify(h)} ${r})`);
    // 28. P1-4: SillyTavern names a deleted chat without ".jsonl" (a chat named "d28.jsonl" is sent as that): its record goes.
    await ev(() => M.eventSource.emit(M.event_types.CHAT_RENAMED, { avatarId: 'ari.png', oldFileName: 'zz-g.jsonl', newFileName: 'd28.jsonl.jsonl' }));
    const rec28 = () => ev(() => __savePoint.settings().renames.some(x => JSON.parse(x.to)[1] === 'd28.jsonl'));
    r = [await rec28()];
    await ev(() => M.deleteChat('d28.jsonl'));
    r.push(await rec28());
    ok(r[0] === true && r[1] === false, `28. 확장자처럼 보이는 이름의 방 삭제 → 그 기록 지움 (${JSON.stringify(r)})`);

    // 29. P2-3: a new room finds another device's memory on `다시 확인` (new → linked): the hides follow it at once.
    await ev(() => { M.settings.savePoint.hideMode = 'auto'; M.settings.savePoint.keepRecent = 2; });
    await newRoom('fresh29'); await wait(900);
    await ev(async ([o]) => {
        const H = await import('/ext/home.js'), hm = __savePoint.home(), addr = JSON.stringify(['ari.png', 'fresh29']);
        const st = { ...o, roomKey: addr, linkedSave: null, lastIndex: 4, hashes: M.chat.slice(0, 5).map(H.fingerprint), floor: 4, rev: 1, wid: 'other29' };
        M.otherPut(H.memName(hm.id), H.memBody({ id: hm.id, state: st, wid: 'other29', from: hm.from, home: { addr, integrity: 'fresh29-int' } }));
        M.otherPut(H.tagName(addr), H.tagBody({ addr, integrity: 'fresh29-int', mem: hm.id }));
        await M.eventSource.emit(M.event_types.CHAT_RENAMED, { avatarId: 'ari.png', oldFileName: 'zz-h.jsonl', newFileName: 'zz-i.jsonl' });
    }, [old]);
    await wait(1500);
    h = await H();
    r = await ev(() => M.chat.map(m => !!m.is_system));
    ok(h.status === 'linked' && h.last === 4 && r.some(Boolean), `29. 새 방 → 다시 확인으로 연결 → 바로 숨김 맞춤 (${JSON.stringify(h)} ${JSON.stringify(r)})`);

    // ───── v0.7.0-b1d (review of b1c) ─────
    const linkedRoom = async n => { await newRoom(n); await wait(900); await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000); return (await H()).id; };
    const hidOf = list => list.map(m => !!m?.is_system);
    const newHidesIn = (before, after) => after.filter((m, k) => m?.is_system && !before[k]?.is_system).length;
    const editHidden = n => { const server = M.serverFiles[M.chatId].slice(1), i = M.chat.findIndex((m, k) => m.is_system && server[k]?.is_system); if (i >= 0) { M.chat[i].mes += ` (edited ${n})`; M.chat[i].swipes && (M.chat[i].swipes[M.chat[i].swipe_id || 0] = M.chat[i].mes); } return i; };
    // 30. P1-1: room A's chat write (🔶 on a hidden message) is still on its way when room B is opened and saved; B's chat write is sent again
    // (SillyTavern saved meanwhile) after A's write ended. B's copy sent again still has its own check: no new hide resting on
    // a message edited in B goes out.
    await ev(() => { M.settings.savePoint.hideMode = 'auto'; M.settings.savePoint.keepRecent = 2; });
    await newRoom('b30'); await wait(900);
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    await ev(() => M.openFile('fresh29')); await wait(900);
    const k30 = await ev(() => M.chat.findLastIndex(m => m.is_system));
    await ev(() => {
        const f = window.fetch;
        window.__relA = null; window.__heldA = false; window.__b30 = null; window.__armB = false;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/chats/save' && JSON.parse(o.body).file_name === 'fresh29' && !window.__heldA) {
                window.__heldA = true;
                await new Promise(r => { window.__relA = r; });
            } else if (s === '/api/chats/save' && JSON.parse(o.body).file_name === 'b30' && window.__armB && !window.__b30) {
                M.stScript.setChatSaving(true);
                window.__b30 = { i: editHiddenB() };
                setTimeout(() => window.__relA?.(), 50);
                setTimeout(() => M.stScript.setChatSaving(false), 600);
            }
            return f(u, o);
        };
    });
    await ev(`window.editHiddenB = ${editHidden.toString().replace('n =>', '() =>').replace('${n}', '30')}`);
    await ev(k => { __savePoint.toggleKeep(k).catch(() => {}); }, k30);
    for (let i = 0; i < 40 && !(await ev(() => window.__heldA)); i++) await wait(100);
    await ev(() => M.openFile('b30')); await wait(900);
    await ev(() => M.add(4)); await wait(600);
    const before30 = await ev(() => JSON.parse(JSON.stringify(M.serverFiles.b30.slice(1))));
    await ev(() => { window.__armB = true; return __savePoint.handle('run').catch(() => {}); });
    await wait(4000);
    r = await ev(() => ({ b: window.__b30, held: window.__heldA, after: M.serverFiles.b30.slice(1), edited: M.serverFiles.b30.some(m => /edited 30/.test(m.mes || '')) }));
    ok(k30 >= 0 && r.held && r.b?.i >= 0 && r.edited && newHidesIn(before30, r.after) === 0, `30. 다른 방 저장이 끝난 뒤 다시 보내는 채팅 저장도 자기 검사 → 새 숨김 없음 (${JSON.stringify(r.b)} edited=${r.edited} ${JSON.stringify(hidOf(r.after))} ← ${JSON.stringify(hidOf(before30))})`);
    await ev(() => __savePoint.handle('home-recheck')).catch(() => {});

    // 31. P1-2: `다시 확인` asked while a change's memory is on its way runs after it, and links another device's reset of
    // this room's memory just written. The change's new hides rest on its own memory: none goes out; the room stays linked to
    // the reset (not stopped).
    await linkedRoom('r31');
    await ev(() => M.add(4)); await wait(300);
    const before31 = await ev(() => JSON.parse(JSON.stringify(M.serverFiles.r31.slice(1))));
    await ev(async () => {
        const H = await import('/ext/home.js'), hm = __savePoint.home(), name = H.memName(hm.id), f = window.fetch;
        let step = 'up';
        window.__posts31 = [];
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/chats/save') window.__posts31.push(JSON.parse(o.body).chat.slice(1).map(m => !!m.is_system));
            if (step === 'up' && s === '/api/files/upload' && JSON.parse(o.body).name === name) { step = 'back'; __savePoint.handle('home-recheck').catch(() => {}); return f(u, o); }
            if (step === 'back' && s.startsWith('/user/files/' + name)) {
                step = 'still';
                const res = await f(u, o);
                const cur = JSON.parse(M.files.get(name)), rev = cur.rev + 1;
                const st = { ...cur.state, lastIndex: -1, hashes: [], floor: -1, rev, wid: 'other31', mem: { ...cur.state.mem, scenes: [], records: [] } };
                M.otherPut(name, H.memBody({ id: hm.id, state: st, rev, wid: 'other31', from: cur.from, home: cur.home }));
                return res;
            }
            if (step === 'still' && s.startsWith('/user/files/' + name)) { step = null; await new Promise(r => setTimeout(r, 1500)); }
            return f(u, o);
        };
    });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(4000);
    h = await H();
    r = await ev(() => ({ posts: window.__posts31, wid: __savePoint.state()?.wid ?? null }));
    ok(r.wid === 'other31' && h.status === 'linked' && !h.stop && r.posts.every(p => newHidesIn(before31, p.map(x => ({ is_system: x }))) === 0), `31. 저장 뒤 다시 확인이 다른 기기 리셋을 연결 → 이전 기억 기준 새 숨김 안 보냄·방은 연결 그대로 (${JSON.stringify(h)} wid=${r.wid} posts=${JSON.stringify(r.posts)} ← ${JSON.stringify(hidOf(before31))})`);

    // 32. P1-3: the room renamed in the list (p32 → q32) and q32 deleted before it was opened; a copy of it under p32 (same
    // integrity) is still not the room: held, the room's memory is not written.
    const mem32 = await linkedRoom('p32');
    const file32 = await memOf(mem32);
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('p32', 'q32'));
    await ev(() => M.importChat('q32', 'p32'));
    await ev(() => M.deleteChat('q32'));
    await ev(() => M.openFile('p32')); await wait(1200);
    h = await H();
    r = await memOf(mem32);
    ok(h.status === 'held' && h.id !== mem32 && r?.wid === file32?.wid, `32. 이름을 바꾼 뒤 새 이름을 지움 → 옛 이름의 사본은 여전히 보류 (${JSON.stringify(h)} ${r?.wid} ${file32?.wid})`);

    // 33. The same with the room's rename pushed out of the last 20 by others (q33 still there): the copy is held.
    const mem33 = await linkedRoom('p33');
    const file33 = await memOf(mem33);
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('p33', 'q33'));
    await ev(async () => { for (let i = 0; i < 21; i++) await M.eventSource.emit(M.event_types.CHAT_RENAMED, { avatarId: 'ari.png', oldFileName: `zz33-${i}.jsonl`, newFileName: `zz33-${i}b.jsonl` }); });
    await ev(() => M.importChat('q33', 'p33'));
    await ev(() => M.openFile('p33')); await wait(1200);
    h = await H();
    r = { rec: await ev(() => __savePoint.settings().renames.some(x => JSON.parse(x.from)[1] === 'p33')), file: (await memOf(mem33))?.wid };
    ok(!r.rec && h.status === 'held' && h.id !== mem33 && r.file === file33?.wid, `33. 이름 변경 기록이 20개 밖으로 밀림 → 옛 이름의 사본은 보류 (${JSON.stringify(h)} ${JSON.stringify(r)})`);

    // 34. P2-1: SillyTavern saves during SavePoint's chat write and an earlier hidden message is edited (as 23): the copy sent
    // again (without the stale hides) is in the file, and the save counts as confirmed (the room is not left unsure).
    await linkedRoom('r34');
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    await ev(() => M.add(4)); await wait(300);
    await ev(() => {
        const f = window.fetch; let up = false;
        window.__i34 = null;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) up = true;
            else if (up && s === '/api/chats/save') {
                window.fetch = f;
                M.stScript.setChatSaving(true);
                window.__i34 = editHiddenB();
                setTimeout(() => M.stScript.setChatSaving(false), 400);
            }
            return f(u, o);
        };
    });
    await ev(() => { toastr.log.length = 0; return __savePoint.handle('run').catch(() => {}); });
    await wait(3000);
    r = await ev(() => ({ toast: toastr.log.filter(([k, m]) => /확인하지 못/.test(m)).map(([, m]) => m.slice(0, 60)), i: window.__i34, edited: M.serverFiles[M.chatId].some(m => /edited 30/.test(m.mes || '')), alert: document.querySelector('.sp-alert')?.textContent || '' }));
    const can34 = await ev(() => __savePoint.handle('run').then(() => 'ok', e => e.message));
    ok(r.i >= 0 && r.edited && !r.toast.length && !/확인하지 못|확인 못/.test(r.alert) && can34 === 'ok', `34. 다시 보낸 사본이 저장됨 → 저장 확인 성공·다음 저장 됨 (${JSON.stringify(r)} next=${can34})`);

    // 35. P2-2: 🔶 turned off on a message the same change then hides; an earlier hidden message is edited before the chat
    // write: the hide goes back, the 🔶 stays off (as the notice says), on the page and in the file.
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    const k35 = await ev(() => { const list = M.chat.map((m, i) => m.is_system ? i : -1).filter(i => i >= 0); return list[list.length - 1]; });
    await ev(k => __savePoint.toggleKeep(k), k35); await wait(1500);
    r = { on: await ev(k => ({ keep: !!M.chat[k].extra?.savepointKeep, hid: !!M.chat[k].is_system }), k35) };
    await ev(() => {
        const f = window.fetch; let up = false;
        window.__i35 = null;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) up = true;
            else if (up && s === '/api/chats/get') { window.fetch = f; window.__i35 = editHiddenB(); M.stSave(); }
            return f(u, o);
        };
    });
    const msg35 = await ev(k => __savePoint.toggleKeep(k).then(() => 'ok', e => e.message), k35);
    await wait(1500);
    r = { ...r, msg: msg35, i: await ev(() => window.__i35), page: await ev(k => ({ keep: !!M.chat[k].extra?.savepointKeep, hid: !!M.chat[k].is_system }), k35), file: await ev(k => { const m = M.serverFiles[M.chatId][k + 1]; return { keep: !!m.extra?.savepointKeep, hid: !!m.is_system }; }, k35) };
    ok(r.on.keep && !r.on.hid && r.i >= 0 && r.i < k35 && !r.page.keep && !r.page.hid && !r.file.keep && !r.file.hid, `35. 🔶 끄면서 생긴 숨김만 되돌림 → 🔶는 꺼진 그대로 (${JSON.stringify(r)})`);

    // 36. P3: every mark of a change is a new hide and all of them go back: no chat write.
    await linkedRoom('r36');
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    await ev(() => M.add(4)); await wait(300);
    const sp36 = await spSaves();
    await ev(() => {
        const f = window.fetch; let up = false;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) up = true;
            else if (up && s === '/api/chats/get') { window.fetch = f; window.__i36 = editHiddenB(); M.stSave(); }
            return f(u, o);
        };
    });
    const msg36 = await ev(() => __savePoint.handle('run').then(() => 'ok', e => e.message));
    await wait(1500);
    r = { i: await ev(() => window.__i36), sp: [sp36, await spSaves()], msg: msg36, err: await ev(() => __savePoint.ui.lastError?.message || String(__savePoint.ui.lastError || '')) };
    ok(r.i >= 0 && r.sp[0] === r.sp[1], `36. 새 숨김이 모두 되돌아감 → 채팅 파일 안 씀 (${JSON.stringify(r)})`);

    // ───── v0.7.0-b1e (review of b1d) ─────
    // 37. P1-1: `다시 확인` links another device's reset of this room's memory while the last chat file check reads (after the
    // memory check passed): no new hide resting on the memory this change wrote goes out.
    await linkedRoom('r37');
    await ev(() => M.add(4)); await wait(300);
    const before37 = await ev(() => JSON.parse(JSON.stringify(M.serverFiles.r37.slice(1))));
    await ev(async () => {
        const H = await import('/ext/home.js'), hm = __savePoint.home(), name = H.memName(hm.id), f = window.fetch;
        let step = 'up';
        window.__posts37 = [];
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/chats/save') window.__posts37.push(JSON.parse(o.body).chat.slice(1).map(m => !!m.is_system));
            if (step === 'up' && s === '/api/files/upload' && JSON.parse(o.body).name === name) { step = 'get'; return f(u, o); }
            if (step === 'get' && s === '/api/chats/get') {
                step = null;
                const cur = JSON.parse(M.files.get(name)), rev = cur.rev + 1;
                const st = { ...cur.state, lastIndex: -1, hashes: [], floor: -1, rev, wid: 'other37', mem: { ...cur.state.mem, scenes: [], records: [] } };
                M.otherPut(name, H.memBody({ id: hm.id, state: st, rev, wid: 'other37', from: cur.from, home: cur.home }));
                __savePoint.handle('home-recheck').catch(() => {});
                for (let i = 0; i < 40 && __savePoint.state()?.wid !== 'other37'; i++) await new Promise(r => setTimeout(r, 100));
                window.__relinked37 = __savePoint.state()?.wid;
            }
            return f(u, o);
        };
    });
    await ev(() => { toastr.log.length = 0; return __savePoint.handle('run').catch(() => {}); });
    await wait(5000);
    h = await H();
    r = await ev(() => ({ posts: window.__posts37, wid: __savePoint.state()?.wid ?? null, at: window.__relinked37 }));
    // v0.7.0-b1g (review of b1f, P1-1): the room follows the reset now — the only chat saves are the ones taking every hide of the
    // old memory away (none carries a hide), and the notice is the one of a memory linked during the change.
    r.said = await ev(() => toastr.log.map(([, m]) => String(m)).filter(m => /기억을 다시 확인|기억이 바뀌었어요/.test(m)).length);
    ok(r.at === 'other37' && r.wid === 'other37' && h.status === 'linked' && !h.stop && r.posts.every(p => !p.some(Boolean)) && r.said > 0 && r.posts.every(p => newHidesIn(before37, p.map(x => ({ is_system: x }))) === 0), `37. 기억 검사 뒤 마지막 채팅 읽기 중 다시 확인이 리셋 연결 → 새 숨김 안 보냄·리셋 따라 숨김 해제만 저장 (${JSON.stringify(h)} ${JSON.stringify(r)} ← ${JSON.stringify(hidOf(before37))})`);

    // 38. P1-2: the room renamed in the list (p38 → q38) and q38 deleted; a copy of it takes the old name and moves on
    // (c38 → p38 → s38). Opening s38 never moves the room's memory there.
    const mem38 = await linkedRoom('p38');
    const home38 = () => ev(id => JSON.parse(M.files.get('savepoint-mem-' + id + '.json')).home.addr, mem38);
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('p38', 'q38'));
    await ev(() => M.importChat('q38', 'c38'));
    await ev(() => M.deleteChat('q38'));
    await ev(() => M.renameChat('c38', 'p38')); await ev(() => M.renameChat('p38', 's38'));
    await ev(() => M.openFile('s38')); await wait(1200);
    h = await H();
    r = await home38();
    ok(h.verdict !== 'rename' && h.id !== mem38 && r === JSON.stringify(['ari.png', 'p38']), `38. 새 이름을 지운 뒤 사본이 옛 이름 거쳐 감(c38 → p38 → s38) → 원본 기억 안 옮김 (${JSON.stringify(h)} ${r})`);

    // 42. P1-2: the same with the copy's rename to the old name pushed out of the last 20 before it moves on (c42 → p42, 21
    // others, p42 → s42): the room kept as having left p42 still marks the copy's next rename as no proof.
    const mem42 = await linkedRoom('p42');
    const home42 = () => ev(id => JSON.parse(M.files.get('savepoint-mem-' + id + '.json')).home.addr, mem42);
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('p42', 'q42'));
    await ev(() => M.importChat('q42', 'c42'));
    await ev(() => M.deleteChat('q42'));
    await ev(() => M.renameChat('c42', 'p42'));
    await ev(async () => { for (let i = 0; i < 21; i++) await M.eventSource.emit(M.event_types.CHAT_RENAMED, { avatarId: 'ari.png', oldFileName: `zz42-${i}.jsonl`, newFileName: `zz42-${i}b.jsonl` }); });
    await ev(() => M.renameChat('p42', 's42'));
    await ev(() => M.openFile('s42')); await wait(1200);
    h = await H();
    r = await home42();
    ok(h.verdict !== 'rename' && h.id !== mem42 && r === JSON.stringify(['ari.png', 'p42']), `42. 사본의 옛 이름 기록이 20개 밖으로 밀린 뒤 다시 이름 변경 → 원본 기억 안 옮김 (${JSON.stringify(h)} ${r})`);

    // 39. P1-2: the same room's tag lost: a copy under the old name (same integrity) is not linked again from the memory file.
    const mem39 = await linkedRoom('p39');
    const file39 = await memOf(mem39);
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('p39', 'q39'));
    await ev(() => M.importChat('q39', 'p39'));
    await ev(async () => { const H = await import('/ext/home.js'); M.otherDel(H.tagName(JSON.stringify(['ari.png', 'p39']))); });
    await ev(() => M.openFile('p39')); await wait(1200);
    h = await H();
    r = await memOf(mem39);
    ok(h.status === 'held' && h.verdict !== 'relink' && h.id !== mem39 && r?.wid === file39?.wid && r?.home?.addr === file39?.home?.addr, `39. 이름표가 사라진 옛 이름의 사본 → 연결 복구 안 하고 보류 (${JSON.stringify(h)} ${r?.wid} ${file39?.wid})`);

    // 40. P2: the first copy (with new hides) is in the file; an earlier hidden message is edited meanwhile, and the copy sent
    // again to take them back is refused (400): the save is not reported as a success.
    await linkedRoom('r40');
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    await ev(() => M.add(4)); await wait(300);
    await ev(() => {
        const f = window.fetch; let up = false, n = 0;
        window.__i40 = null;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) up = true;
            else if (up && s === '/api/chats/save') {
                n++;
                if (n === 1) { M.stScript.setChatSaving(true); window.__i40 = editHiddenB(); setTimeout(() => M.stScript.setChatSaving(false), 400); }
                else { window.fetch = f; return new Response(JSON.stringify({ error: 'refused40' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
            }
            return f(u, o);
        };
    });
    const said = () => ev(() => [__savePoint.ui.lastError?.message || String(__savePoint.ui.lastError || ''), ...toastr.log.map(([, m]) => String(m))].join(' | '));
    await ev(() => { toastr.log.length = 0; __savePoint.ui.lastError = null; });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(1500);
    r = { i: await ev(() => window.__i40), msg: await said() };
    ok(r.i >= 0 && /다시 풀어 저장하려 했는데 실패/.test(r.msg), `40. 숨김을 푸는 재전송이 거절됨 → 성공으로 끝내지 않고 알림 (${JSON.stringify(r)})`);
    await ev(() => __savePoint.handle('home-recheck')).catch(() => {});

    // 41. P3 (the other side): SillyTavern saves the page after the last check (with the new hides on it) and an earlier hidden
    // message was edited just before: every new hide goes back inside the chat write, and a copy is still sent to take back
    // what SillyTavern's save carried.
    await linkedRoom('r41');
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    await ev(() => M.add(4)); await wait(300);
    const sp41 = await spSaves();
    const before41 = await ev(() => JSON.parse(JSON.stringify(M.serverFiles.r41.slice(1))));
    await ev(() => {
        const f = window.fetch; let up = false;
        window.__i41 = null;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) up = true;
            else if (up && s === '/api/chats/get') {
                window.fetch = f;
                M.stScript.setChatSaving(true);
                setTimeout(() => { window.__i41 = editHiddenB(); M.stSave(); }, 100);
                setTimeout(() => M.stScript.setChatSaving(false), 400);
            }
            return f(u, o);
        };
    });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(2000);
    r = { i: await ev(() => window.__i41), sp: [sp41, await spSaves()], after: await ev(() => M.serverFiles.r41.slice(1)) };
    ok(r.i >= 0 && r.sp[1] > r.sp[0] && newHidesIn(before41, r.after) === 0, `41. 실리태번이 그사이 저장 → 첫 요청 생략 안 하고 보내서 새 숨김 없음 (i=${r.i} sp=${r.sp} ${JSON.stringify(hidOf(r.after))} ← ${JSON.stringify(hidOf(before41))})`);

    // ───── v0.7.0-b1f (review of b1e) ─────
    // A reset of this room's memory put on the server by another device (rev + 1, nothing recorded).
    const resetMem = (H, hm, name, wid) => { const cur = JSON.parse(M.files.get(name)), rev = cur.rev + 1; M.otherPut(name, H.memBody({ id: hm.id, state: { ...cur.state, lastIndex: -1, hashes: [], floor: -1, rev, wid, mem: { ...cur.state.mem, scenes: [], records: [] } }, rev, wid, from: cur.from, home: cur.home })); };
    await ev(`window.resetMem = ${resetMem.toString()}`);
    // 43. P1: the first chat request (with the new hides) is in the file and `다시 확인` links another device's reset while its
    // answer is on the way: the write does not end on that copy — the hides go back and are sent again.
    await linkedRoom('r43');
    await ev(() => M.add(4)); await wait(300);
    const before43 = await ev(() => JSON.parse(JSON.stringify(M.serverFiles.r43.slice(1))));
    await ev(async () => {
        const H = await import('/ext/home.js'), hm = __savePoint.home(), name = H.memName(hm.id), f = window.fetch;
        let step = 'up';
        window.__first43 = null;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (step === 'up' && s === '/api/files/upload' && JSON.parse(o.body).name === name) { step = 'save'; return f(u, o); }
            if (step === 'save' && s === '/api/chats/save') {
                step = null;
                const res = await f(u, o);
                window.__first43 = M.serverFiles.r43.slice(1).map(m => !!m.is_system);
                resetMem(H, hm, name, 'other43');
                __savePoint.handle('home-recheck').catch(() => {});
                for (let i = 0; i < 40 && __savePoint.state()?.wid !== 'other43'; i++) await new Promise(r => setTimeout(r, 100));
                return res;
            }
            return f(u, o);
        };
    });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(5000);
    h = await H();
    r = await ev(() => ({ first: window.__first43, wid: __savePoint.state()?.wid ?? null, after: M.serverFiles.r43.slice(1) }));
    ok(h.last === -1 && h.status === 'linked' && newHidesIn(before43, r.first.map(x => ({ is_system: x }))) > 0 && newHidesIn(before43, r.after) === 0, `43. 첫 저장 응답을 기다리는 사이 다시 확인이 리셋 연결 → 숨김 되돌려 다시 보냄 (${JSON.stringify(h)} wid=${r.wid} first=${JSON.stringify(r.first)} after=${JSON.stringify(hidOf(r.after))} ← ${JSON.stringify(hidOf(before43))})`);

    // 44. P2-1: a room with no memory renamed in the list (a44 → b44); a new room (another integrity) made under a44 saves first
    // and is opened again: linked to its own memory, not held.
    await newRoom('a44'); await wait(900);
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('a44', 'b44'));
    await ev(() => { const list = JSON.parse(JSON.stringify(M.serverFiles.b44.slice(1))); M.serverFiles.a44 = [{ chat_metadata: { integrity: 'a44-new' } }, ...list]; return M.openFile('a44'); });
    await wait(900);
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    const h44 = await H();
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.openFile('a44')); await wait(1200);
    h = await H();
    ok(h44.status === 'linked' && !!h44.id && h.status === 'linked' && h.id === h44.id, `44. 옛 이름에 새로 만든 방 → 첫 저장 뒤 다시 열어도 자기 기억 연결 (${JSON.stringify(h44)} → ${JSON.stringify(h)})`);

    // 45. P2-2: 🔖 turned off on a message the same change hides, and `다시 확인` links another device's reset before the memory
    // check: only the new hide goes back (as in 37); the 🔖 stays off, on the page and in the file.
    await linkedRoom('r45');
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    const k45 = await ev(() => { const list = M.chat.map((m, i) => m.is_system ? i : -1).filter(i => i >= 0); return list[list.length - 1]; });
    await ev(k => __savePoint.toggleKeep(k), k45); await wait(1500);
    r = { on: await ev(k => ({ keep: !!M.chat[k].extra?.savepointKeep, hid: !!M.chat[k].is_system }), k45) };
    await ev(async () => {
        const H = await import('/ext/home.js'), hm = __savePoint.home(), name = H.memName(hm.id), f = window.fetch;
        let step = 'up';
        window.fetch = async (u, o) => {
            const s = String(u);
            if (step === 'up' && s === '/api/files/upload' && JSON.parse(o.body).name === name) { step = 'back'; __savePoint.handle('home-recheck').catch(() => {}); return f(u, o); }
            if (step === 'back' && s.startsWith('/user/files/' + name)) { step = 'still'; const res = await f(u, o); resetMem(H, hm, name, 'other45'); return res; }
            if (step === 'still' && s.startsWith('/user/files/' + name)) { step = null; await new Promise(r => setTimeout(r, 1500)); }
            return f(u, o);
        };
    });
    await ev(k => __savePoint.toggleKeep(k).catch(() => {}), k45);
    await wait(4000);
    r = { ...r, wid: await ev(() => __savePoint.state()?.wid ?? null), page: await ev(k => ({ keep: !!M.chat[k].extra?.savepointKeep }), k45), file: await ev(k => { const m = M.serverFiles.r45[k + 1]; return { keep: !!m.extra?.savepointKeep, hid: !!m.is_system }; }, k45) };
    ok(r.on.keep && !r.on.hid && r.wid === 'other45' && !r.page.keep && !r.file.keep && !r.file.hid, `45. 기억 검사 전에 다시 확인이 리셋 연결 → 새 숨김만 되돌리고 🔖는 꺼진 그대로 저장 (${JSON.stringify(r)})`);

    // ───── v0.7.0-b1g (review of b1f) ─────
    const spHid = list => list.map(m => !!(m?.is_system && m.extra?.savepointHidden));
    // 46. P1-1: the chat request (with the new hides) went through, and `다시 확인` links another device's reset while the chat
    // file is read back (entry.verify): the hides follow the reset at once, on the page and in the file, and the save does not
    // end as "saved" (one notice).
    await linkedRoom('r46');
    await ev(() => M.add(4)); await wait(300);
    const t46 = await ev(() => toastr.log.length);
    await ev(async () => {
        const H = await import('/ext/home.js'), hm = __savePoint.home(), name = H.memName(hm.id), f = window.fetch;
        let step = 'up';
        window.fetch = async (u, o) => {
            const s = String(u);
            if (step === 'up' && s === '/api/files/upload' && JSON.parse(o.body).name === name) { step = 'save'; return f(u, o); }
            if (step === 'save' && s === '/api/chats/save') { step = 'get'; return f(u, o); }
            if (step === 'get' && s === '/api/chats/get') {
                step = null;
                const res = await f(u, o);
                resetMem(H, hm, name, 'other46');
                __savePoint.handle('home-recheck').catch(() => {});
                for (let i = 0; i < 40 && __savePoint.state()?.wid !== 'other46'; i++) await new Promise(r => setTimeout(r, 100));
                return res;
            }
            return f(u, o);
        };
    });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(5000);
    h = await H();
    r = await ev(t => ({ wid: __savePoint.state()?.wid ?? null, toasts: toastr.log.slice(t).map(x => x[1]), page: M.chat.map(m => !!(m.is_system && m.extra?.savepointHidden)), file: M.serverFiles.r46.slice(1).map(m => !!(m.is_system && m.extra?.savepointHidden)) }), t46);
    ok(h.last === -1 && r.wid === 'other46' && !r.page.some(Boolean) && !r.file.some(Boolean) && r.toasts.some(t => t.includes('저장하는 사이 이 방의 기억이 바뀌었어요')) && !r.toasts.some(t => t.includes('퀵세이브 완료')),
        `46. 마지막 저장 확인 중 다시 확인이 리셋 연결 → 화면·파일 숨김 풀고 완료 안내 대신 한 번 알림 (${JSON.stringify(h)} ${JSON.stringify(r)})`);

    // 47. (4) a hide the server file still has on a message the page already shows (taken away on the page only): another
    // memory linked by `다시 확인` sends the file its own save.
    await linkedRoom('r47');
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    r = { before: await ev(() => M.serverFiles.r47.slice(1).filter(m => m.is_system && m.extra?.savepointHidden).length) };
    await ev(() => { M.chat.forEach((m, i) => { if (m.is_system && m.extra?.savepointHidden) { m.is_system = false; delete m.extra.savepointHidden; } }); });
    await ev(async () => { const H = await import('/ext/home.js'), hm = __savePoint.home(); resetMem(H, hm, H.memName(hm.id), 'other47'); await __savePoint.handle('home-recheck'); });
    await wait(3000);
    r = { ...r, wid: await ev(() => __savePoint.state()?.wid ?? null), file: await ev(() => M.serverFiles.r47.slice(1).filter(m => m.is_system && m.extra?.savepointHidden).length) };
    ok(r.before > 0 && r.wid === 'other47' && r.file === 0, `47. 화면만 풀린 숨김 → 다른 기억 연결 때 서버 파일도 풀어 저장 (${JSON.stringify(r)})`);

    // 48. P1-2: a room with no memory renamed (a48 → b48); an imported copy (the same integrity) put at a48 saves first; b48
    // opened then does not take the copy's memory (an old a48 → b48 rename is no proof for the tag at a48 now).
    await newRoom('a48'); await wait(900);
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('a48', 'b48'));
    await ev(() => { M.serverFiles.a48 = JSON.parse(JSON.stringify(M.serverFiles.b48)); return M.openFile('a48'); });
    await wait(900);
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    const h48 = await H();
    await ev(() => M.openFile('b48')); await wait(1200);
    h = await H();
    r = h48.id ? await memOf(h48.id) : null;
    ok(h48.status === 'linked' && !!h48.id && h.id !== h48.id && r?.home?.addr === JSON.stringify(['ari.png', 'a48']), `48. 옛 A → B 기록이 사본 A의 새 기억을 B로 안 옮김 (${JSON.stringify(h48)} → ${JSON.stringify(h)} home=${JSON.stringify(r?.home)})`);

    // 49. P1-2 (the gap): the same, but b49 is opened right after the copy's tag reached the server, before the first write is
    // confirmed: the rename was closed before the tag was written.
    await newRoom('a49'); await wait(900);
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('a49', 'b49'));
    await ev(() => { M.serverFiles.a49 = JSON.parse(JSON.stringify(M.serverFiles.b49)); return M.openFile('a49'); });
    await wait(900);
    await ev(async () => {
        const H = await import('/ext/home.js'), tag = H.tagName(JSON.stringify(['ari.png', 'a49'])), f = window.fetch;
        window.__h49 = null;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name === tag) {
                window.fetch = f;
                const res = await f(u, o);
                await M.openFile('b49');
                for (let i = 0; i < 30 && ['opening'].includes(__savePoint.home().status); i++) await new Promise(r => setTimeout(r, 100));
                await new Promise(r => setTimeout(r, 600));
                const hm = __savePoint.home();
                window.__h49 = { status: hm.status, id: hm.id };
                return res;
            }
            return f(u, o);
        };
    });
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run').catch(() => {})); await wait(4000);
    r = await ev(() => window.__h49);
    await ev(() => M.openFile('a49')); await wait(1200);
    h = await H();
    ok(!!r && h.status === 'linked' && !!h.id && r.id !== h.id, `49. 사본 이름표가 올라간 직후 B를 열어도 사본 기억을 안 가져감 (b49=${JSON.stringify(r)} a49=${JSON.stringify(h)})`);

    // 50. P1-2 (the other side): a new room renamed (a50 → c50) while its first write waits for an answer: c50 is still linked to
    // that memory (a rename seen during the write is not closed by it).
    await newRoom('a50'); await wait(900);
    await ev(async () => {
        const H = await import('/ext/home.js'), hm = __savePoint.home(), name = H.memName(hm.id), f = window.fetch;
        window.fetch = async (u, o) => {
            const s = String(u);
            if (s === '/api/files/upload' && JSON.parse(o.body).name === name) {
                window.fetch = f;
                const res = await f(u, o);
                await M.eventSource.emit(M.event_types.CHAT_RENAMED, { avatarId: 'ari.png', oldFileName: 'a50.jsonl', newFileName: 'c50.jsonl' });
                return res;
            }
            return f(u, o);
        };
    });
    const id50 = await ev(() => __savePoint.home().id);
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run').catch(() => {})); await wait(3000);
    await ev(() => { M.serverFiles.c50 = M.serverFiles.a50; delete M.serverFiles.a50; return M.openFile('branchB'); }); await wait(900);
    await ev(() => M.openFile('c50')); await wait(1200);
    h = await H();
    ok(h.status === 'linked' && h.id === id50, `50. 첫 저장 중 A → C 이름 변경 → C에서 같은 기억 연결 (${JSON.stringify(h)} id=${id50})`);

    // 51. P2: a51 → b51 (no memory), then another room (its own integrity) renamed x51 → a51 saves first there; renamed again
    // a51 → c51: c51 is linked (the takeover mark went with that room's first write), not held.
    await newRoom('a51'); await wait(900);
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('a51', 'b51'));
    await newRoom('x51'); await wait(900);
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('x51', 'a51'));
    await ev(() => M.openFile('a51')); await wait(1200);
    await ev(() => M.add(4)); await ev(() => __savePoint.handle('run')); await wait(2000);
    const h51 = await H();
    await ev(() => M.openFile('branchB')); await wait(900);
    await ev(() => M.renameChat('a51', 'c51'));
    await ev(() => M.openFile('c51')); await wait(1200);
    h = await H();
    ok(h51.status === 'linked' && !!h51.id && h.status === 'linked' && h.id === h51.id, `51. 옛 이름을 이어받은 방이 첫 저장 뒤 다시 이름 변경 → 보류 없이 연결 (${JSON.stringify(h51)} → ${JSON.stringify(h)})`);

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
