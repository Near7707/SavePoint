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
// v0.7.0-b2c: a check that no longer applies (its reason given), or one kept for b3.
const skip = (msg, why) => console.log(`SKIP  ${msg} — ${why}`);

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
    // v0.7.0-b3b1 (b3 design, H2): a room whose chat file (read by the link, on the server) and memory disagree is stopped as it opens:
    // a recorded original changed or gone (even with no hide), or a hide of SavePoint's the memory does not cover. Nothing is written
    // (no rewind, no hide, no chat save), `다시 확인` checks again, and once they agree the room goes on.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, hideMode: 'auto', keepRecent: 2, askResume: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, is_system: false, mes: `${tag} message ${i} ${'and more '.repeat(6)}.`, swipe_id: 0, swipes: [`${tag} message ${i} ${'and more '.repeat(6)}.`], extra: {} }));
    const file = list => JSON.parse(JSON.stringify([{ chat_metadata: { integrity: 'int-' + Math.random().toString(36).slice(2) } }, ...list]));
    // A room recorded to #7 (8 messages; hides as the setting gives: auto, latest 2 kept → #0–#5).
    const recorded = async (id, mode = 'auto') => {
        await ev(m => { M.settings.savePoint.hideMode = m; }, mode);
        await ev(([id, f]) => { M.serverFiles[id] = f; return M.openFile(id); }, [id, file(msgs(8, id))]);
        await ev(() => M.opened());
        await ev(() => __savePoint.handle('run').catch(() => {}));
        await wait(1800);
        await ev(() => { M.settings.savePoint.hideMode = 'auto'; });
    };
    // What the room holds now; counts from `c` (chat saves, memory file writes).
    const mark = () => ev(() => ({ s: (M.saveBodies || []).length, n: M.fileLog.length, t: toastr.log.length }));
    const look = c => ev(async c => {
        const h = __savePoint.home(), hid = list => list.map((m, i) => (m?.is_system ? i : -1)).filter(i => i >= 0);
        $('#sp_wand').trigger('click'); await new Promise(z => setTimeout(z, 200));
        const alert = $('.sp-home-alert').text(), btn = $('.sp-home-alert [data-act="home-recheck"]').length;
        __savePoint.ui.open = false; $('#sp_overlay').hide();
        return { status: h.status, h2: h.h2 || null, stop: h.line?.stop ?? null, blocked: __savePoint.autoBlocked(), file: M.mem()?.lastIndex ?? null, page: hid(M.chat).join(), server: hid((M.serverFiles[M.chatId] || []).slice(1)).join(),
            s: c ? (M.saveBodies || []).length - c.s : 0, puts: c ? M.fileLog.slice(c.n).filter(x => x[0] === 'put').map(x => x[1]) : [], t: c ? toastr.log.slice(c.t).map(x => x[1]).join(' | ') : '', alert, btn };
    }, c);
    // Another device changes the room's chat file, then the room is opened again (as SillyTavern loads it).
    const reopen = async (id, edit) => {
        await ev(([id, edit]) => { const f = M.serverFiles[id]; new Function('f', edit)(f); }, [id, edit]);
        await ev(id => M.openFile(id), id);
        await ev(() => M.opened());
        await wait(300);
    };
    let r, c, x;

    // 0. a room recorded with hides
    await recorded('h2a');
    r = await look();
    ok(r.status === 'linked' && !r.h2 && r.file === 7 && r.page === '0,1,2,3,4,5' && r.server === '0,1,2,3,4,5', `0. 준비: 기록 #7, 숨김 #0~#5 (${JSON.stringify(r)})`);

    // 1. (first) a recorded original changed elsewhere, no hide at all: stopped; no rewind, nothing written.
    await recorded('h2s', 'off');
    r = await look();
    ok(r.file === 7 && r.server === '', `1. 준비: 숨김 없는 방, 기록 #7 (${JSON.stringify(r)})`);
    c = await mark();
    await reopen('h2s', `f[4].mes = 'changed elsewhere'; f[4].swipes = ['changed elsewhere'];`);
    await wait(1500);
    r = await look(c);
    ok(r.status === 'linked' && r.h2?.why === 'source' && r.h2.at === 3 && r.blocked === 'room' && r.file === 7 && r.s === 0 && r.puts.length === 0,
        `1. 원문이 바뀌었는데 숨김 0개인 방 → 멈춤, 되감기 없음, 기억·채팅 쓰기 0 (${JSON.stringify(r)})`);
    ok(r.t.includes('#3') && !r.t.includes('되감았') && r.alert.includes('#3') && r.btn === 1, `1. 안내(알림·창)와 다시 확인 버튼 (${r.t.slice(0, 60)} / ${r.alert.slice(0, 40)})`);

    // 5. in the stopped room: a source change notice, a reply starting, a 🔖 repair and a save write nothing and queue nothing.
    c = await mark();
    r = await ev(async () => {
        const m = M.chat[5]; m.swipe_info = [{ extra: { savepointKeep: 1 } }];
        await eventSource.emit(event_types.MESSAGE_EDITED, 3);
        await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(event_types.GENERATION_ENDED);
        const fixed = __savePoint.repairKeep(5);
        let err = ''; try { await __savePoint.handle('run'); } catch (e) { err = String(e?.message || e); }
        return { fixed, keep: !!m.extra?.savepointKeep, err };
    });
    await wait(2000);
    x = await look(c);
    ok(!r.fixed && !r.keep, `5. 멈춘 방에서 🔖 고치기는 화면 표시도 안 바꿈 (${JSON.stringify(r)})`);
    ok(x.h2?.why === 'source' && x.file === 7 && x.s === 0 && x.puts.length === 0, `5. 원문 변경 알림·답변 시작·🔖 고치기·세이브 → 저장·되감기 0 (${JSON.stringify(x)})`);
    await ev(() => { delete M.chat[5].swipe_info; });

    // 7. the original put back (on the page, saved by SillyTavern), `다시 확인`: the same memory (same receipt), the room goes on.
    c = await mark();
    await ev(async () => { const m = M.chat[3]; m.mes = 'h2s message 3 ' + 'and more '.repeat(6) + '.'; m.swipes = [m.mes]; M.stSave(); await eventSource.emit(event_types.MESSAGE_EDITED, 3); });
    await wait(400);
    await ev(async () => { await __savePoint.handle('home-recheck'); await M.opened(); });
    await wait(800);
    r = await look(c);
    ok(r.status === 'linked' && !r.h2 && r.blocked !== 'room' && r.file === 7 && r.puts.length === 0, `7. 원문을 되돌리고 다시 확인 → 같은 기억으로 이어짐, 기억 쓰기 0 (${JSON.stringify(r)})`);
    await ev(() => M.add(2));
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(1800);
    r = await look();
    ok(r.file === 9, `7. 그 뒤 세이브는 평소대로 (${r.file})`);

    // 8. (pair) an original changed in the room open now: rolled back at once, as before (the page's own change).
    c = await mark();
    await ev(async () => { const m = M.chat[4]; m.mes = 'edited here'; m.swipes = ['edited here']; M.stSave(); await eventSource.emit(event_types.MESSAGE_EDITED, 4); });
    await wait(2500);
    r = await look(c);
    ok(!r.h2 && r.file !== null && r.file < 4 && r.t.includes('되감았'), `8. (짝) 열어 둔 방에서 직접 고친 원문은 예전처럼 자동 되감기 (${JSON.stringify(r)})`);

    // 2. a recorded message gone (deleted elsewhere): stopped.
    await recorded('h2d');
    c = await mark();
    await reopen('h2d', `f.splice(7);`);
    await wait(1500);
    r = await look(c);
    ok(r.h2?.why === 'source' && r.h2.at === 6 && r.blocked === 'room' && r.file === 7 && r.s === 0 && r.puts.length === 0, `2. 기록한 메시지가 없어짐 → 멈춤, 쓰기 0 (${JSON.stringify(r)})`);

    // 11. (b3b1 🟡) the stopped room renamed while open: the rename's proof is taken (its link and receipt were confirmed), the memory
    //     follows, and the new name is checked again: still stopped.
    c = await mark();
    await ev(() => M.renameChat('h2d', 'h2d-new'));
    await ev(() => M.opened());
    await wait(500);
    r = await ev(() => ({ key: __savePoint.home().key, d: __savePoint.home().d?.verdict, addr: M.memDoc()?.home?.addr, why: __savePoint.home().why }));
    x = await look(c);
    ok(r.d === 'rename' && x.status === 'linked' && x.h2?.why === 'source' && r.addr === r.key && x.s === 0, `11. 멈춘 방의 이름을 바꾸면 기억이 따라가고 새 이름에서도 멈춤 (${JSON.stringify({ ...r, h2: x.h2, s: x.s })})`);

    // 3. a hide of SavePoint's the memory does not cover (another device rewound, or a copied hide): stopped, the hide left as it is.
    await recorded('h2h');
    await ev(() => M.add(2));
    await wait(300);
    c = await mark();
    await reopen('h2h', `f[10].is_system = true; f[10].extra = { ...(f[10].extra || {}), savepointHidden: 1 };`);
    await wait(1500);
    r = await look(c);
    ok(r.h2?.why === 'hides' && r.h2.at === 9 && r.blocked === 'room' && r.page.split(',').includes('9') && r.server.split(',').includes('9') && r.s === 0 && r.puts.length === 0,
        `3. 기억이 못 덮는 SavePoint 숨김 → 멈춤, 숨김 그대로, 쓰기 0 (${JSON.stringify(r)})`);
    ok(r.t.includes('#9') && r.btn === 1, `3. 안내 (${r.t.slice(0, 60)})`);

    // 4. what is left alone: a user's own hide (no mark), a shown original, a covered hide, a temporary release's value only.
    await recorded('h2n');
    await ev(() => M.add(2));
    await wait(300);
    await reopen('h2n', `f[9].is_system = true; f[10].extra = { ...(f[10].extra || {}), savepointLive: 'other.1' };`);
    await wait(1200);
    r = await look();
    ok(r.status === 'linked' && !r.h2 && r.blocked !== 'room' && r.server.startsWith('0,1,2,3,4,5'), `4. 사용자 숨김·보이는 원문·덮인 숨김·임시 해제 값만 → 멈추지 않음 (${JSON.stringify(r)})`);

    // 9. (GPT) the chat file read the second time (the link's last read) has a hide the first read had not, its originals the same: stopped.
    await recorded('h2r');
    await ev(() => M.add(2));
    await wait(300);
    c = await mark();
    await ev(async () => {
        const f = window.fetch; let reads = 0;
        window.fetch = async (u, o = {}) => {
            const res = await f(u, o);
            if (String(u) === '/api/chats/get' && JSON.parse(o.body || '{}').file_name === 'h2r' && ++reads === 1) { const m = M.serverFiles.h2r[10]; m.is_system = true; m.extra = { ...(m.extra || {}), savepointHidden: 1 }; window.__h2r = true; }
            return res;
        };
        try { await M.openFile('h2r'); await M.opened(); } finally { window.fetch = f; }
    });
    await wait(300);
    r = await look(c);
    ok(r.h2?.why === 'hides' && r.h2.at === 9 && r.s === 0 && r.puts.length === 0, `9. 두 번째 서버 읽기에서만 숨김이 늘어도(원문 같음) 멈춤 (${JSON.stringify(r)})`);
    // … that hide gone again, `다시 확인` with the same memory (same receipt): the room goes on.
    await ev(() => { const m = M.serverFiles.h2r[10]; m.is_system = false; delete m.extra.savepointHidden; });
    await ev(async () => { await __savePoint.handle('home-recheck'); await M.opened(); });
    await wait(800);
    r = await look();
    ok(r.status === 'linked' && !r.h2 && r.blocked !== 'room', `9. 그 숨김이 없어진 뒤 다시 확인 → 같은 영수증으로 이어짐 (${JSON.stringify(r)})`);

    // 6. a stop of the room's own comes first (the link unfinished: the tag refused): its notice, not H2; once linked, H2.
    await ev(() => { M.failFile = 'savepoint-room-'; M.failFileStatus = 400; M.settings.savePoint.hideMode = 'off'; });
    await ev(([id, f]) => { M.serverFiles[id] = f; return M.openFile(id); }, ['h2p', file(msgs(8, 'h2p'))]);
    await ev(() => M.opened());
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(1800);
    await ev(() => { M.settings.savePoint.hideMode = 'auto'; });
    r = await look();
    ok(r.stop === 'linkPart' && r.file === 7, `6. 준비: 이름표 거절로 연결 미완료 (${JSON.stringify(r)})`);
    await reopen('h2p', `f[3].mes = 'changed elsewhere'; f[3].swipes = ['changed elsewhere'];`);
    r = await look();
    ok(r.stop === 'linkPart' && !r.h2 && r.alert.includes('이름표'), `6. 기존 멈춤(연결 미완료) 안내가 먼저, H2 아님 (${JSON.stringify(r)})`);
    await ev(() => { M.failFile = null; M.failFileStatus = null; });
    c = await mark();
    await ev(async () => { await __savePoint.handle('home-recheck'); await M.opened(); });
    await wait(1500);
    r = await look(c);
    ok(!r.stop && r.h2?.why === 'source' && r.h2.at === 2 && r.file === 7 && r.s === 0 && r.puts.every(x => x.startsWith('savepoint-room-')),
        `6. 연결이 끝난 뒤 H2로 멈춤, 기억·채팅 쓰기 0 (${JSON.stringify(r)})`);


    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
