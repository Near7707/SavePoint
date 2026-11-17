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

    // v0.7.0-b3b2: the save timers (persistSoon, saveChatSoon: their callback is named `save`) are counted from here.
    await ev(() => {
        const st = window.setTimeout; window.__saveTimers = [];
        window.setTimeout = function (fn, ms, ...a) { if (typeof fn === 'function' && fn.name === 'save') window.__saveTimers.push({ ms, h2: !!__savePoint.home().h2, at: Date.now() }); return st.call(this, fn, ms, ...a); };
    });
    const timers = () => ev(() => window.__saveTimers.splice(0));

    // 14. (b3b2, b3b1 review P2-2) in the stopped room (6): a save asked for sets no timer.
    await timers();
    await ev(() => __savePoint.persistSoon());
    await wait(500);
    r = await timers();
    ok(r.length === 0, `14. 멈춘 방에서 저장을 예약해도 타이머가 생기지 않음 (${JSON.stringify(r)})`);
    // … nor a chat save asked by a hide pass (a SavePoint hide the user showed on the page: syncHide → saveChatSoon).
    c = await mark();
    x = await ev(() => { const m = M.chat[1]; m.extra = { ...(m.extra || {}), savepointHidden: 1 }; m.is_system = false; __savePoint.syncHide(); return { vis: !!m.extra.savepointVisible }; });
    await wait(1000);
    r = await timers();
    const s14 = await look(c);
    ok(x.vis && r.length === 0 && s14.s === 0, `14. 하이드 계산이 채팅 저장을 청해도 타이머 없음·저장 0 (${JSON.stringify({ x, r, s: s14.s })})`);

    // 12. (b3b2) a room whose hides are not set yet (recorded with hiding off, then on): opening it writes nothing — no chat save, no
    //     memory file write, no new hide on the page; the next save sets them.
    await recorded('h2q', 'off');
    c = await mark();
    await reopen('h2q', '');
    await wait(1500);
    r = await look(c);
    ok(r.status === 'linked' && !r.h2 && r.blocked !== 'room' && r.file === 7 && r.s === 0 && r.puts.length === 0 && r.page === '' && r.server === '',
        `12. 숨길 게 남은 정상 방을 열어도 채팅 저장 0, 기억 파일 쓰기 0, 새 숨김 없음 (${JSON.stringify(r)})`);
    await ev(() => M.add(2));
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(1800);
    r = await look();
    ok(r.file === 9 && r.page.startsWith('0,1,2,3,4,5') && r.server === r.page, `12. 그 뒤 세이브에서 숨김이 걸림 (${JSON.stringify(r)})`);

    // 13. (b3b2, review of the b3b2 plan P2) an old-format memory with a stale mark on the chat file (a "held" mark, taken off by any
    //     hide pass): opening it tidies the memory's form (one memory upload, as before) and writes no chat file; the mark is taken
    //     off on the page only.
    await recorded('h2o');
    await ev(() => { const d = M.memDoc('h2o'); d.state.mem.evidenceVersion = 0; M.files.set(M.H.memName(d.id), JSON.stringify(d)); });
    c = await mark();
    await reopen('h2o', `f[7].extra = { ...(f[7].extra || {}), savepointHeld: 1 };`);
    await wait(2000);
    r = await look(c);
    x = await ev(() => ({ ev: M.mem('h2o')?.mem?.evidenceVersion ?? null, pageHeld: !!M.chat[6].extra?.savepointHeld, serverHeld: !!M.serverFiles.h2o[7].extra?.savepointHeld }));
    ok(r.status === 'linked' && !r.h2 && r.s === 0 && r.puts.every(n => n.startsWith('savepoint-mem-')) && x.ev === 1 && !x.pageHeld && x.serverHeld,
        `13. 구형 기억 방을 열면 형식 정리(기억 업로드)만, 채팅 저장 0, 표시는 화면에서만 정리 (${JSON.stringify({ ...x, s: r.s, puts: r.puts })})`);

    // 15. (b3b2, b3b1 review P2-2) a save timer set in a working room while a reply is being made, then the room stops (H2): the timer
    //     neither saves nor is set again every 1.5 s. The stop is put on the room by hand, as the link would: a `다시 확인` asked during
    //     a reply is put off by the chat file check (busy), so it cannot stop the room inside the reply here.
    await recorded('h2w');
    await ev(async () => { await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false); });
    await timers();
    c = await mark();
    await ev(() => __savePoint.persistSoon());
    await wait(800);   // the timer fires during the reply: put off by 1.5 s
    r = await ev(() => { const h = __savePoint.home(); h.h2 = { why: 'source', at: 3, at2: Date.now() }; return { ...h.h2 }; });
    await wait(4000);
    x = await timers();
    const y15 = await look(c);
    await ev(async () => { await eventSource.emit(event_types.GENERATION_ENDED); __savePoint.home().h2 = null; });
    ok(r?.why === 'source' && x.filter(t => t.h2).length === 0 && y15.s === 0,
        `15. 답변 중 잡힌 저장 타이머는 방이 멈춘 뒤 다시 예약되지 않고 저장도 없음 (${JSON.stringify({ h2: r, timers: x, s: y15.s })})`);


    // 16. (b3b2a, review of b3b2 P2) an old-format memory (its tidy-up queued as the room opens) and a late save from elsewhere landing
    //     after the opening's last H2 read, before the tidy-up's turn reads the chat file: a hide of SavePoint's the memory does not
    //     cover (#9). That turn is left out — no chat save, no memory file write — and the room is not stopped by it (`다시 확인` and the
    //     opening decide that). A save pressed then says the chat and the memory differ; `다시 확인` stops the room (H2).
    await recorded('h2l');
    await ev(() => M.add(2));
    await wait(300);
    await ev(() => { const d = M.memDoc('h2l'); d.state.mem.evidenceVersion = 0; M.files.set(M.H.memName(d.id), JSON.stringify(d)); });
    c = await mark();
    x = await ev(async () => {
        const f = window.fetch, out = { late: false };
        window.fetch = async (u, o = {}) => {
            if (!out.late && String(u) === '/api/chats/get' && JSON.parse(o.body || '{}').file_name === 'h2l' && __savePoint.home().status === 'linked' && !__savePoint.home().h2) {
                const m = M.serverFiles.h2l[10]; m.is_system = true; m.extra = { ...(m.extra || {}), savepointHidden: 1 }; out.late = true;
            }
            return f(u, o);
        };
        try { await M.openFile('h2l'); await M.opened(); await new Promise(z => setTimeout(z, 2500)); } finally { window.fetch = f; }
        return { ...out, ev: M.mem('h2l')?.mem?.evidenceVersion ?? null };
    });
    r = await look(c);
    ok(x.late && r.s === 0 && r.puts.length === 0 && x.ev === 0 && !r.h2 && r.server.split(',').includes('9'),
        `16. 열기 확인 뒤·정리 차례 전에 늦은 숨김이 오면 그 정리 차례는 보류: 채팅 저장 0, 기억 파일 쓰기 0, 방은 멈추지 않음 (${JSON.stringify({ ...x, s: r.s, puts: r.puts, h2: r.h2, server: r.server })})`);
    c = await mark();
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(1500);
    r = await look(c);
    ok(r.s === 0 && r.puts.length === 0 && r.t.includes('채팅과 기억이 맞지 않아요') && r.t.includes('다시 확인') && !r.t.includes('기억 정리를 저장하지 못해서'), `16. 그때 누른 세이브 → "채팅과 기억이 맞지 않아요" 안내, 쓰기 0 (${JSON.stringify({ s: r.s, puts: r.puts, t: r.t })})`);
    await ev(async () => { await __savePoint.handle('home-recheck'); await M.opened(); });
    await wait(800);
    r = await look();
    ok(r.h2?.why === 'hides' && r.h2.at === 9 && r.blocked === 'room', `16. 다시 확인하면 정식 판정으로 멈춤 (${JSON.stringify(r.h2)})`);

    // 16b. (b3b2b, review of b3b2a P2; pair of 16) the same opening, but the late save is another tab's reset that empties the memory and
    //      takes away only some hides (#3–#5 shown, #0–#2 left hidden). The tidy-up's first chat read finds that release: it is not
    //      followed on its own (the user's rule), so nothing is written (chat or memory file) and the hides left stop the room (H2).
    await recorded('h2m');
    await ev(() => { const d = M.memDoc('h2m'); d.state.mem.evidenceVersion = 0; M.files.set(M.H.memName(d.id), JSON.stringify(d)); });
    await ev(async () => { window.__H = await import('/ext/home.js'); });
    c = await mark();
    x = await ev(async () => {
        const f = window.fetch, out = { late: false }, H = window.__H;
        window.fetch = async (u, o = {}) => {
            if (!out.late && String(u) === '/api/chats/get' && JSON.parse(o.body || '{}').file_name === 'h2m' && __savePoint.home().status === 'linked' && !__savePoint.home().h2) {
                out.late = true;
                for (const [i, m] of M.serverFiles.h2m.slice(1).entries()) if (i > 2 && m.extra?.savepointHidden) { m.is_system = false; delete m.extra.savepointHidden; }
                const name = H.memName(__savePoint.home().id), d = JSON.parse(M.files.get(name)), st = JSON.parse(JSON.stringify(d.state));
                st.mem = { scenes: [], records: [], entities: [] }; st.lastIndex = -1; st.hashes = []; st.undo = null; st.undoInfo = null;
                M.otherPut(name, H.nextMem(d, st, 'other16b'));
            }
            return f(u, o);
        };
        try { await M.openFile('h2m'); await M.opened(); await new Promise(z => setTimeout(z, 3000)); } finally { window.fetch = f; }
        return out;
    });
    r = await look(c);
    ok(x.late && r.s === 0 && r.puts.length === 0 && r.server === '0,1,2' && r.h2?.why === 'hides' && r.blocked === 'room',
        `16b. 열기 직후 다른 탭이 기억을 비우고 숨김 일부만 풀면: 따라가지 않고 채팅 저장 0, 기억 파일 쓰기 0, 남은 숨김으로 멈춤 (${JSON.stringify({ ...x, s: r.s, puts: r.puts, h2: r.h2, server: r.server, page: r.page, file: r.file })})`);
    c = await mark();
    await ev(async () => { await __savePoint.handle('home-recheck'); await M.opened(); });
    await wait(1000);
    r = await look(c);
    ok(r.h2?.why === 'hides' && r.blocked === 'room' && r.s === 0 && r.puts.length === 0 && r.server === '0,1,2', `16b. 다시 확인해도 멈춤 그대로, 쓰기 0 (${JSON.stringify({ h2: r.h2, s: r.s, puts: r.puts, server: r.server })})`);

    // ───── v0.7.0-b3c1: `원문과 기억 맞추기` (hides only) ─────
    const fit = async () => { await ev(async () => { await __savePoint.handle('home-fit'); }); await wait(600); };
    const fitBtn = () => ev(async () => {
        $('#sp_wand').trigger('click'); await new Promise(z => setTimeout(z, 200));
        const n = $('.sp-home-alert [data-act="home-fit"]').length; __savePoint.ui.open = false; $('#sp_overlay').hide(); return n;
    });
    // A room recorded to #7, two more messages, then another device hides #9 with SavePoint's mark: stopped (as 3).
    const stopped = async id => {
        await recorded(id);
        await ev(() => M.add(2));
        await wait(300);
        await reopen(id, `f[10].is_system = true; f[10].extra = { ...(f[10].extra || {}), savepointHidden: 1 };`);
        await wait(1200);
    };
    // The n-th read of this room's chat file from now (1: the fit's start check, 2: its turn's read before the write) runs `body` first.
    const onRead = (id, n, body) => ev(([id, n, body]) => {
        const f = window.fetch; let k = 0; window.__onRead = { done: false };
        window.fetch = async (u, o = {}) => {
            if (String(u) === '/api/chats/get' && JSON.parse(o.body || '{}').file_name === id && ++k === n) { window.fetch = f; new Function(body)(); window.__onRead.done = true; }
            return f(u, o);
        };
        window.__offRead = () => { window.fetch = f; };
    }, [id, n, body]);

    // 17. a room on an old-format memory, stopped by a hide of SavePoint's its memory does not cover (#9): only that hide goes — one chat
    //     save, no memory file write, no save timer meanwhile; both files read again → the room goes on. Its memory is not tidied then
    //     (no memory write), but by the next save; new hides only at that save.
    await recorded('h2fo');
    await ev(() => M.add(2));
    await wait(300);
    await ev(() => { const d = M.memDoc('h2fo'); d.state.mem.evidenceVersion = 0; M.files.set(M.H.memName(d.id), JSON.stringify(d)); });
    await reopen('h2fo', `f[10].is_system = true; f[10].extra = { ...(f[10].extra || {}), savepointHidden: 1 };`);
    await wait(1200);
    r = await look();
    x = await ev(() => ({ ev: M.mem('h2fo')?.mem?.evidenceVersion ?? null, btn: null }));
    x.btn = await fitBtn();
    ok(r.h2?.why === 'hides' && r.h2.at === 9 && x.ev === 0 && x.btn === 1, `17. 준비: 예전 형식 기억 방이 #9 숨김으로 멈춤, 맞추기 버튼 (${JSON.stringify({ h2: r.h2, ...x })})`);
    c = await mark();
    await timers();
    x = await ev(async () => {
        M.metaDelay = 600;
        const job = __savePoint.handle('home-fit');
        await new Promise(z => setTimeout(z, 300));
        __savePoint.persistSoon();
        await job; M.metaDelay = 0;
        await new Promise(z => setTimeout(z, 1500));
        return { ev: M.mem('h2fo')?.mem?.evidenceVersion ?? null };
    });
    r = await look(c);
    const t17 = await timers();
    ok(!r.h2 && r.blocked !== 'room' && r.s === 1 && r.puts.length === 0 && r.server === '0,1,2,3,4,5' && r.page === '0,1,2,3,4,5' && t17.length === 0,
        `17. 맞추기 → 채팅 저장 1번, 기억 파일 쓰기 0, 저장 타이머 0, #9만 풀림, 방 이어짐 (${JSON.stringify({ h2: r.h2, blocked: r.blocked, s: r.s, puts: r.puts, server: r.server, page: r.page, timers: t17 })})`);
    ok(x.ev === 0 && r.t.includes('맞췄어요'), `17. 예전 형식 기억은 그때 정리하지 않음(다음 세이브에서), 안내 (${JSON.stringify({ ...x, t: r.t.slice(0, 60) })})`);
    c = await mark();
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await wait(2000);
    r = await look(c);
    x = await ev(() => ({ ev: M.mem('h2fo')?.mem?.evidenceVersion ?? null }));
    ok(x.ev === 1 && r.file === 9 && r.server === '0,1,2,3,4,5,6,7', `17. 다음 세이브에서 기억 정리·기록·새 숨김 (${JSON.stringify({ ...x, file: r.file, server: r.server, puts: r.puts.length })})`);

    // 18. already put right elsewhere (the hide taken away on the server) before the fit reads: nothing written, the room goes on.
    await stopped('h2fa');
    c = await mark();
    await ev(() => { const m = M.serverFiles.h2fa[10]; m.is_system = false; delete m.extra.savepointHidden; });
    await fit();
    r = await look(c);
    ok(!r.h2 && r.blocked !== 'room' && r.s === 0 && r.puts.length === 0 && !r.server.split(',').includes('9') && r.t.includes('이미 맞아서'),
        `18. 이미 맞으면 쓰기 0으로 이어짐 (${JSON.stringify({ h2: r.h2, s: r.s, puts: r.puts, server: r.server, page: r.page, t: r.t.slice(0, 50) })})`);

    // 19. between the start check and the turn's read another tab hides #7 by hand (no mark): held back, nothing written, the user's
    //     hide and SavePoint's #9 stay. With a message only on this page, the notice asks to copy it first.
    await stopped('h2fb');
    c = await mark();
    await onRead('h2fb', 2, `const m = M.serverFiles.h2fb[8]; m.is_system = true;`);
    await fit();
    await ev(() => window.__offRead());
    r = await look(c);
    ok(r.h2?.why === 'hides' && r.s === 0 && r.puts.length === 0 && r.server.split(',').includes('7') && r.server.split(',').includes('9') && r.page.split(',').includes('9') && r.t.includes('숨김 상태') && !r.t.includes('복사'),
        `19. 다른 탭이 대상 밖 메시지를 직접 숨기면 보류, 쓰기 0, 직접 숨김·#9 그대로 (${JSON.stringify({ h2: r.h2, s: r.s, puts: r.puts, server: r.server, page: r.page, t: r.t.slice(0, 60) })})`);
    c = await mark();
    await ev(() => { const m = JSON.parse(JSON.stringify(M.chat[M.chat.length - 1])); m.mes = 'only on this page'; m.swipes = [m.mes]; M.chat.push(m); });
    await fit();
    r = await look(c);
    ok(r.s === 0 && r.t.includes('복사'), `19. 이 화면에만 있는 메시지가 있으면 복사 안내 (${r.t.slice(0, 120)})`);
    await ev(() => { M.chat.pop(); });

    // 20. right before the request: SillyTavern saves (the fit waits for it and reads again) and another tab has hidden #7 by hand: the
    //     guard holds it back — no request, #9 hidden again on the page (nothing touched it), the user's hide kept on the server.
    await stopped('h2fc');
    c = await mark();
    await onRead('h2fc', 2, `M.stScript.setChatSaving(true); setTimeout(() => { const m = M.serverFiles.h2fc[8]; m.is_system = true; M.stScript.setChatSaving(false); }, 300);`);
    await fit();
    await wait(400);
    await ev(() => window.__offRead());
    r = await look(c);
    ok(r.h2?.why === 'hides' && r.s === 0 && r.puts.length === 0 && r.server.split(',').includes('7') && r.server.split(',').includes('9') && r.page.split(',').includes('9'),
        `20. 쓰기 직전에 다른 탭이 직접 숨기면 요청 안 함, 화면 #9 되돌림, 직접 숨김 그대로 (${JSON.stringify({ h2: r.h2, s: r.s, puts: r.puts, server: r.server, page: r.page, t: r.t.slice(0, 60) })})`);

    // 21. the memory file saved elsewhere after the start check (another receipt): the turn stops, nothing written, the room stays stopped.
    await stopped('h2fd');
    await ev(async () => { window.__H = await import('/ext/home.js'); });
    c = await mark();
    await onRead('h2fd', 1, `const H = window.__H, name = H.memName(__savePoint.home().id), d = JSON.parse(M.files.get(name)); M.otherPut(name, H.nextMem(d, d.state, 'other21'));`);
    await fit();
    await ev(() => window.__offRead());
    r = await look(c);
    ok(r.s === 0 && r.puts.length === 0 && r.server.split(',').includes('9') && (r.h2 || r.stop) && r.blocked === 'room',
        `21. 시작 확인 뒤 기억 파일이 바뀌면 중단, 쓰기 0, 방은 계속 멈춤 (${JSON.stringify({ h2: r.h2, stop: r.stop, s: r.s, puts: r.puts, server: r.server, t: r.t.slice(0, 60) })})`);

    // 22. the chat write refused (SillyTavern's 500, not written): #9 hidden again on the page, the room stays stopped. Then an answer
    //     lost (the request may still land): #9 stays shown on the page, the room unconfirmed (no more writes), still stopped.
    await stopped('h2fe');
    c = await mark();
    await ev(() => { M.failOnce = true; });
    await fit();
    r = await look(c);
    ok(r.h2?.why === 'hides' && r.s === 1 && r.puts.length === 0 && r.server.split(',').includes('9') && r.page.split(',').includes('9') && r.t.includes('되돌렸어요'),
        `22. 저장 거절 → 화면 #9 다시 숨김, 방은 멈춤 (${JSON.stringify({ h2: r.h2, s: r.s, puts: r.puts, server: r.server, page: r.page, t: r.t.slice(0, 60) })})`);
    c = await mark();
    await ev(() => { const f = window.fetch; window.fetch = async (u, o) => { if (String(u) === '/api/chats/save') { window.fetch = f; (M.saveBodies ||= []).push({ lost: true }); return new Response('bad gateway', { status: 502 }); } return f(u, o); }; });
    await fit();
    r = await look(c);
    ok(r.h2?.why === 'hides' && r.s === 1 && r.puts.length === 0 && !r.page.split(',').includes('9') && ['unsure', 'room'].includes(r.blocked) && r.t.includes('확인하지 못했어요'),
        `22. 응답 끊김 → 화면은 펼친 채, 미확정으로 막힘, 방은 멈춤 (${JSON.stringify({ h2: r.h2, s: r.s, puts: r.puts, server: r.server, page: r.page, blocked: r.blocked, t: r.t.slice(0, 80) })})`);

    // ───── v0.7.0-b3c1a (review of b3c1) ─────
    // The fit's chat save, wrapped: `before` runs right before the first request of room `id` leaves, `after` right after it is answered.
    const onSave = (id, before, after) => ev(([id, before, after]) => {
        const f = window.fetch;
        window.fetch = async (u, o = {}) => {
            if (String(u) === '/api/chats/save' && JSON.parse(o.body || '{}').file_name === id) {
                window.fetch = f;
                if (before) new Function(before)();
                const res = await f(u, o);
                if (after) new Function(after)();
                return res;
            }
            return f(u, o);
        };
        window.__offSave = () => { window.fetch = f; };
    }, [id, before, after]);
    const NEW_MSG = `const m = JSON.parse(JSON.stringify(M.chat[M.chat.length - 1])); m.mes = 'new while fitting'; m.swipes = [m.mes]; M.chat.push(m); M.stSave();`;
    const serverHas = id => ev(id => ({ n: M.serverFiles[id].length - 1, last: M.serverFiles[id][M.serverFiles[id].length - 1].mes, keep7: !!M.serverFiles[id][8].extra?.savepointKeep, swipe7: !!M.serverFiles[id][8].swipe_info?.[0]?.extra?.savepointKeep }), id);

    // 23. P1, a pair. SillyTavern saves a newer page (a new message) just before the fit's request lands over it: the copy is sent again
    //     (two chat saves) and the new message is in the file. The same, but another tab then hides #7 by hand: no copy sent again (one
    //     save), the user's hide stays, #9's release stays, the room stays stopped, the notice asks to copy the message only on this page.
    await stopped('h2fp');
    c = await mark();
    await onSave('h2fp', NEW_MSG, null);
    await fit(); await wait(800);
    await ev(() => window.__offSave());
    r = await look(c); x = await serverHas('h2fp');
    ok(!r.h2 && r.s === 2 && x.n === 11 && x.last === 'new while fitting' && !r.server.split(',').includes('9') && r.t.includes('맞췄어요'),
        `23. 숨김이 같으면 다시 보내서 새 메시지 보존, 방 이어짐 (${JSON.stringify({ h2: r.h2, s: r.s, ...x, server: r.server, t: r.t.slice(0, 60) })})`);
    await stopped('h2fq');
    c = await mark();
    await onSave('h2fq', NEW_MSG, `M.serverFiles.h2fq[8].is_system = true;`);
    await fit(); await wait(800);
    await ev(() => window.__offSave());
    r = await look(c); x = await serverHas('h2fq');
    ok(r.h2?.why === 'hides' && r.s === 1 && x.n === 10 && r.server.split(',').includes('7') && !r.server.split(',').includes('9') && !r.page.split(',').includes('9')
        && r.t.includes('더 저장하지 않았어요') && r.t.includes('복사') && !r.t.includes('맞췄어요'),
        `23. 다른 탭이 직접 숨기면 다시 보내지 않음, 직접 숨김·#9 해제 그대로, 방은 멈춤, 복사 안내 (${JSON.stringify({ h2: r.h2, s: r.s, ...x, server: r.server, page: r.page, t: r.t.slice(0, 120) })})`);

    // 24. P2-1: 🔖 another tab put on #7 (the message, or one of its swipes) before the fit's read: held back, nothing written, the 🔖
    //     stays. After the first request (the copy sent again): no more sent, the 🔖 stays. Marks the page tidied alone (VISIBLE) do not
    //     hold it back.
    await stopped('h2fk');
    c = await mark();
    await onRead('h2fk', 2, `const m = M.serverFiles.h2fk[8]; m.extra = { ...(m.extra || {}), savepointKeep: 1 };`);
    await fit();
    await ev(() => window.__offRead());
    r = await look(c); x = await serverHas('h2fk');
    ok(r.h2?.why === 'hides' && r.s === 0 && x.keep7 && r.server.split(',').includes('9') && r.t.includes('🔖'),
        `24. 다른 탭이 넣은 🔖가 화면과 다르면 보류, 쓰기 0, 🔖 그대로 (${JSON.stringify({ h2: r.h2, s: r.s, ...x, t: r.t.slice(0, 60) })})`);
    await stopped('h2fw');
    c = await mark();
    await onRead('h2fw', 2, `const m = M.serverFiles.h2fw[8]; m.swipe_info = [{ extra: { savepointKeep: 1 } }];`);
    await fit();
    await ev(() => window.__offRead());
    r = await look(c); x = await serverHas('h2fw');
    ok(r.h2?.why === 'hides' && r.s === 0 && x.swipe7, `24. 스와이프의 🔖도 쓰기 0 (지금은 기존 채팅 비교가 먼저 막음) (${JSON.stringify({ h2: r.h2, s: r.s, ...x })})`);
    await stopped('h2fr');
    c = await mark();
    await onSave('h2fr', NEW_MSG, `const m = M.serverFiles.h2fr[8]; m.extra = { ...(m.extra || {}), savepointKeep: 1 };`);
    await fit(); await wait(800);
    await ev(() => window.__offSave());
    r = await look(c); x = await serverHas('h2fr');
    ok(r.h2?.why === 'hides' && r.s === 1 && x.keep7 && r.t.includes('더 저장하지 않았어요'), `24. 첫 저장 뒤 🔖가 생기면 다시 보내지 않음, 🔖 그대로 (${JSON.stringify({ h2: r.h2, s: r.s, ...x, t: r.t.slice(0, 60) })})`);
    await stopped('h2fv');
    c = await mark();
    await ev(() => { M.chat[7].extra = { ...(M.chat[7].extra || {}), savepointVisible: 1 }; });
    await fit();
    r = await look(c);
    ok(!r.h2 && r.s === 1 && r.t.includes('맞췄어요'), `24. 화면에서만 정리한 표시는 막지 않음 (${JSON.stringify({ h2: r.h2, s: r.s, t: r.t.slice(0, 60) })})`);

    // 25. P2-2: the chat file read last does not agree with the page (a message the memory does not cover edited elsewhere, or another
    //     file's integrity): the room stays stopped — when nothing was to be written (already right) and after the write.
    await stopped('h2fx');
    c = await mark();
    await onRead('h2fx', 1, `const f = M.serverFiles.h2fx; f[10].is_system = false; delete f[10].extra.savepointHidden; f[9].mes = 'edited elsewhere'; f[9].swipes = [f[9].mes];`);
    await fit();
    await ev(() => window.__offRead());
    r = await look(c);
    ok(r.h2?.why === 'hides' && r.s === 0 && r.blocked === 'room' && r.t.includes('맞지 않아서') && !r.t.includes('이미 맞아서'),
        `25. 이미 맞음 경로: 기록 밖 메시지가 서버에서 바뀌었으면 이어 가지 않음 (${JSON.stringify({ h2: r.h2, s: r.s, blocked: r.blocked, t: r.t.slice(0, 60) })})`);
    await stopped('h2fy');
    c = await mark();
    await onRead('h2fy', 1, `const f = M.serverFiles.h2fy; f[10].is_system = false; delete f[10].extra.savepointHidden; f[0].chat_metadata.integrity = 'int-elsewhere';`);
    await fit();
    await ev(() => window.__offRead());
    r = await look(c);
    ok(r.h2?.why === 'hides' && r.s === 0 && r.t.includes('맞지 않아서'), `25. 고유값이 바뀌었으면 이어 가지 않음 (${JSON.stringify({ h2: r.h2, s: r.s, t: r.t.slice(0, 60) })})`);
    await stopped('h2fz');
    c = await mark();
    await ev(() => {
        const f = window.fetch; let after = false, k = 0;
        window.fetch = async (u, o = {}) => {
            const b = JSON.parse(o.body || '{}');
            if (String(u) === '/api/chats/save' && b.file_name === 'h2fz') { const res = await f(u, o); after = true; return res; }
            if (after && String(u) === '/api/chats/get' && b.file_name === 'h2fz' && ++k === 2) { window.fetch = f; const s = M.serverFiles.h2fz; s[9].mes = 'edited elsewhere'; s[9].swipes = [s[9].mes]; }
            return f(u, o);
        };
        window.__offSave = () => { window.fetch = f; };
    });
    await fit(); await wait(400);
    await ev(() => window.__offSave());
    r = await look(c);
    ok(r.h2?.why === 'hides' && r.s === 1 && !r.server.split(',').includes('9') && r.t.includes('맞지 않아서') && !r.t.includes('맞췄어요'),
        `25. 저장 뒤 마지막 비교가 실패하면 이어 가지 않음 (${JSON.stringify({ h2: r.h2, s: r.s, server: r.server, t: r.t.slice(0, 60) })})`);

    // ───── v0.7.0-b3c1b (review of b3c1a) ─────
    const reopenSame = async id => { await ev(id => M.openFile(id), id); await ev(() => M.opened()); await wait(1200); };
    const flag = () => ev(() => __savePoint.home().fitReopen || null);
    // After the stop: `다시 확인`, the fit and a save write nothing and the room stays stopped.
    const tryAll = async () => {
        await ev(async () => { await __savePoint.handle('home-recheck'); });
        await wait(600);
        await fit();
        await ev(() => __savePoint.handle('run').catch(() => {}));
        await wait(1500);
    };

    // 26. P1: the copy sent again stopped for a hide another tab set by hand (as 23): the room stays stopped until it is opened again —
    //     the window says so (no buttons, the notice to copy), `다시 확인`, the fit and a save write nothing and the user's hide stays.
    //     Opened again: the room goes on and the hide is still kept.
    await stopped('h2g1');
    c = await mark();
    await onSave('h2g1', NEW_MSG, `M.serverFiles.h2g1[8].is_system = true;`);
    await fit(); await wait(800);
    await ev(() => window.__offSave());
    r = await look(c); x = { flag: await flag(), fitBtn: await fitBtn() };
    ok(r.h2?.why === 'hides' && r.s === 1 && x.flag?.n === 10 && x.fitBtn === 0 && r.btn === 0 && r.alert.includes('다시 열') && r.alert.includes('복사'),
        `26. 다시 보내기를 멈추면 다시 열 때까지 멈춤 표시, 창 안내(버튼 없음·복사) (${JSON.stringify({ h2: r.h2, s: r.s, ...x, btn: r.btn, alert: r.alert.slice(0, 120) })})`);
    c = await mark();
    await tryAll();
    r = await look(c);
    ok(r.h2 && r.s === 0 && r.puts.length === 0 && r.server.split(',').includes('7') && !!(await flag()),
        `26. 다시 확인·맞추기·세이브 모두 쓰기 0, 직접 숨김 그대로 (${JSON.stringify({ h2: r.h2, s: r.s, puts: r.puts, server: r.server, t: r.t.slice(0, 80) })})`);
    await reopenSame('h2g1');
    r = await look(); x = { flag: await flag() };
    ok(!r.h2 && !x.flag && r.blocked !== 'room' && r.server.split(',').includes('7') && r.page.split(',').includes('7'),
        `26. 다시 열면 풀림, 직접 숨김은 화면·서버 그대로 (${JSON.stringify({ h2: r.h2, ...x, blocked: r.blocked, server: r.server, page: r.page })})`);

    // 26b. the same for a 🔖 another tab put on #7 after the first request (as 24 h2fr): the fit tried again writes nothing, the 🔖 stays.
    await stopped('h2g2');
    c = await mark();
    await onSave('h2g2', NEW_MSG, `const m = M.serverFiles.h2g2[8]; m.extra = { ...(m.extra || {}), savepointKeep: 1 };`);
    await fit(); await wait(800);
    await ev(() => window.__offSave());
    c = await mark();
    await tryAll();
    r = await look(c); x = await serverHas('h2g2');
    ok(r.h2 && r.s === 0 && x.keep7 && !!(await flag()), `26b. 🔖로 멈춘 뒤 다시 확인·맞추기·세이브 쓰기 0, 🔖 그대로 (${JSON.stringify({ h2: r.h2, s: r.s, ...x, t: r.t.slice(0, 80) })})`);

    // 27. P1 (the final read): another tab took #9's hide away (already right) but hid #7 by hand: the room does not go on and stays
    //     stopped until opened again; a save writes nothing.
    await stopped('h2g3');
    c = await mark();
    await onRead('h2g3', 1, `const f = M.serverFiles.h2g3; f[10].is_system = false; delete f[10].extra.savepointHidden; f[8].is_system = true;`);
    await fit();
    await ev(() => window.__offRead());
    r = await look(c); x = { flag: await flag() };
    ok(r.h2 && r.s === 0 && !!x.flag && r.t.includes('이어 가지 않았어요') && !r.t.includes('이미 맞아서'),
        `27. 이미 맞음 경로: 숨김 상태가 다르면 이어 가지 않음, 다시 열 때까지 멈춤 (${JSON.stringify({ h2: r.h2, s: r.s, ...x, t: r.t.slice(0, 80) })})`);
    c = await mark();
    await tryAll();
    r = await look(c);
    ok(r.s === 0 && r.server.split(',').includes('7'), `27. 그 뒤 세이브도 쓰기 0, 직접 숨김 그대로 (${JSON.stringify({ s: r.s, server: r.server })})`);
    // 27b. after the write: the end read finds #7 hidden by hand.
    await stopped('h2g4');
    c = await mark();
    await ev(() => {
        const f = window.fetch; let after = false, k = 0;
        window.fetch = async (u, o = {}) => {
            const b = JSON.parse(o.body || '{}');
            if (String(u) === '/api/chats/save' && b.file_name === 'h2g4') { const res = await f(u, o); after = true; return res; }
            if (after && String(u) === '/api/chats/get' && b.file_name === 'h2g4' && ++k === 2) { window.fetch = f; M.serverFiles.h2g4[8].is_system = true; }
            return f(u, o);
        };
        window.__offSave = () => { window.fetch = f; };
    });
    await fit(); await wait(400);
    await ev(() => window.__offSave());
    r = await look(c); x = { flag: await flag() };
    ok(r.h2 && r.s === 1 && !!x.flag && r.t.includes('이어 가지 않았어요') && !r.t.includes('맞췄어요'),
        `27b. 저장 뒤 마지막 읽기에서 숨김 상태가 다르면 다시 열 때까지 멈춤 (${JSON.stringify({ h2: r.h2, s: r.s, ...x, t: r.t.slice(0, 80) })})`);
    // 27c. the final read (already right) finds a 🔖 another tab put on #7.
    await stopped('h2g5');
    c = await mark();
    await onRead('h2g5', 1, `const f = M.serverFiles.h2g5; f[10].is_system = false; delete f[10].extra.savepointHidden; f[8].extra = { ...(f[8].extra || {}), savepointKeep: 1 };`);
    await fit();
    await ev(() => window.__offRead());
    r = await look(c); x = await serverHas('h2g5');
    ok(r.h2 && r.s === 0 && x.keep7 && !!(await flag()), `27c. 마지막 읽기에서 🔖가 다르면 다시 열 때까지 멈춤 (${JSON.stringify({ h2: r.h2, s: r.s, ...x, t: r.t.slice(0, 80) })})`);

    // 28. (18 kept) the hide taken away elsewhere, only the page still has SavePoint's old hide on #9: not a difference — taken away on
    //     the page, the room goes on, nothing written, no stop until reopened.
    await stopped('h2g6');
    c = await mark();
    await ev(() => { const m = M.serverFiles.h2g6[10]; m.is_system = false; delete m.extra.savepointHidden; });
    await fit();
    r = await look(c); x = { flag: await flag(), hid9: await ev(() => !!M.chat[9].extra?.savepointHidden) };
    ok(!r.h2 && !x.flag && !x.hid9 && r.s === 0 && !r.page.split(',').includes('9') && r.alert === '' && r.t.includes('이미 맞아서'),
        `28. 화면에만 남은 예전 SavePoint 숨김은 걷어 내고 이어짐 (${JSON.stringify({ h2: r.h2, ...x, s: r.s, page: r.page, alert: r.alert.slice(0, 40) })})`);

    // 29. P2: the memory file saved elsewhere right after the first request is answered (no SillyTavern wait): no copy sent again, what was
    //     sent stays, the room stopped for the memory conflict, no success notice. Then the memory file unreadable at that point: the same.
    await stopped('h2g7');
    await ev(async () => { window.__H = await import('/ext/home.js'); });
    c = await mark();
    await onSave('h2g7', NEW_MSG, `const H = window.__H, name = H.memName(__savePoint.home().id), d = JSON.parse(M.files.get(name)); M.otherPut(name, H.nextMem(d, d.state, 'other29'));`);
    await fit(); await wait(800);
    await ev(() => window.__offSave());
    r = await look(c); x = await serverHas('h2g7');
    ok(r.s === 1 && x.n === 10 && !r.server.split(',').includes('9') && r.stop && r.blocked === 'room' && r.t.includes('기억 파일을 저장해서 더 저장하지 않았어요') && r.t.includes('복사') && !r.t.includes('맞췄어요'),
        `29. 첫 저장 뒤 다른 곳 기억 저장 → 다시 보내지 않음, 기억 충돌로 멈춤 (${JSON.stringify({ s: r.s, ...x, stop: r.stop, blocked: r.blocked, t: r.t.slice(0, 120) })})`);
    await stopped('h2g8');
    c = await mark();
    await onSave('h2g8', NEW_MSG, `M.memReadFail = true;`);
    await fit(); await wait(800);
    await ev(() => { window.__offSave(); M.memReadFail = false; });
    r = await look(c); x = await serverHas('h2g8');
    ok(r.s === 1 && x.n === 10 && r.h2 && r.t.includes('기억 파일을 다시 읽지 못해서 더 저장하지 않았어요') && !r.t.includes('맞췄어요'),
        `29. 그 순간 기억 파일을 못 읽으면 다시 보내지 않음, 멈춤 (${JSON.stringify({ s: r.s, ...x, h2: r.h2, t: r.t.slice(0, 120) })})`);

    // ───── v0.7.0-b3c1c (review of b3c1b) ─────
    const chk = () => ev(() => { const h = __savePoint.home(); return { check: h.fitCheck || null, reopen: h.fitReopen || null }; });
    const recheck = async () => { await ev(async () => { await __savePoint.handle('home-recheck'); }); await wait(800); };
    const saveTry = async () => { await ev(() => __savePoint.handle('run').catch(() => {})); await wait(1500); };
    // A fit whose first request lands, then `after` runs (another tab changes the files) and the copy sent again cannot be checked.
    const fitBroken = async (id, after) => {
        await stopped(id);
        await onSave(id, NEW_MSG, after);
        await fit(); await wait(800);
        await ev(() => { window.__offSave(); M.memReadFail = false; });
    };
    const HIDE7 = id => `M.serverFiles.${id}[8].is_system = true;`;
    const KEEP7 = id => `const m = M.serverFiles.${id}[8]; m.extra = { ...(m.extra || {}), savepointKeep: 1 };`;

    // 30. P1: the memory file unreadable before the copy sent again, another tab hid #7 by hand meanwhile: the room waits for the check
    //     (the window says so, with `다시 확인`); the memory readable again, `다시 확인` reads the chat file, sees #7 apart → stopped until
    //     reopened; a save writes nothing and the hide stays. The same with a 🔖. With nothing apart: `다시 확인` lets the room go on.
    await fitBroken('h2h1', `M.memReadFail = true; ${HIDE7('h2h1')}`);
    r = await look(); x = await chk();
    ok(!!x.check && r.blocked === 'room' && r.btn === 1, `30. 기억 읽기 실패로 끝나면 확인 대기, 다시 확인 버튼 (${JSON.stringify({ ...x, h2: r.h2, blocked: r.blocked, btn: r.btn, alert: r.alert.slice(0, 60) })})`);
    c = await mark();
    await recheck(); await saveTry();
    r = await look(c); x = await chk();
    ok(!!x.reopen && !x.check && r.s === 0 && r.server.split(',').includes('7'), `30. 다시 확인이 숨김 차이를 보면 다시 열 때까지 멈춤, 세이브 쓰기 0, 직접 숨김 그대로 (${JSON.stringify({ ...x, s: r.s, server: r.server })})`);
    await fitBroken('h2h2', `M.memReadFail = true; ${KEEP7('h2h2')}`);
    c = await mark();
    await recheck(); await saveTry();
    r = await look(c); x = { ...(await chk()), ...(await serverHas('h2h2')) };
    ok(!!x.reopen && r.s === 0 && x.keep7, `30. 🔖가 다르면 같음, 🔖 그대로 (${JSON.stringify({ ...x, s: r.s })})`);
    await fitBroken('h2h3', `M.memReadFail = true;`);
    c = await mark();
    await recheck();
    r = await look(c); x = await chk();
    ok(!x.check && !x.reopen && !r.h2 && r.blocked !== 'room' && r.s === 0, `30. 차이가 없으면 다시 확인으로 이어짐 (${JSON.stringify({ ...x, h2: r.h2, blocked: r.blocked, s: r.s })})`);
    c = await mark();
    await saveTry();
    r = await look(c); x = await serverHas('h2h3');
    ok(r.s >= 1 && x.last === 'new while fitting', `30. 그 뒤 세이브가 화면에만 있던 새 메시지까지 저장 (${JSON.stringify({ s: r.s, ...x })})`);

    // 31. P1: the memory file saved elsewhere before the copy sent again (the room stops for the conflict) and #7 hidden by hand: `다시 확인`
    //     links the new memory but the room stays stopped until reopened. 31b: the same with `다시 확인` pressed during the fit (run after it).
    await ev(async () => { window.__H = await import('/ext/home.js'); });
    const OTHER_MEM = `const H = window.__H, name = H.memName(__savePoint.home().id), d = JSON.parse(M.files.get(name)); M.otherPut(name, H.nextMem(d, d.state, 'other31'));`;
    await fitBroken('h2h4', `${OTHER_MEM} ${HIDE7('h2h4')}`);
    x = await chk();
    ok(!!x.check, `31. 준비: 기억 충돌로 끝나도 확인 대기 (${JSON.stringify(x)})`);
    c = await mark();
    await recheck(); await saveTry();
    r = await look(c); x = await chk();
    ok(!!x.reopen && r.s === 0 && r.puts.length === 0 && r.server.split(',').includes('7') && r.status === 'linked',
        `31. 다시 확인이 새 기억에 연결해도 숨김 차이면 다시 열 때까지 멈춤, 쓰기 0 (${JSON.stringify({ ...x, status: r.status, stop: r.stop, s: r.s, puts: r.puts, server: r.server })})`);
    await fitBroken('h2h5', `${OTHER_MEM} ${HIDE7('h2h5')} __savePoint.handle('home-recheck');`);
    await wait(800);
    c = await mark();
    await saveTry();
    r = await look(c); x = await chk();
    ok(!!x.reopen && r.s === 0 && r.server.split(',').includes('7'), `31b. 맞추기 도중 누른 다시 확인도 같은 검사 (${JSON.stringify({ ...x, stop: r.stop, s: r.s, server: r.server })})`);

    // 32. P1: the end check's chat read fails after the write: the room waits; #7 hidden by hand meanwhile → `다시 확인` stops it until
    //     reopened. With nothing apart: it goes on.
    const endReadFails = (id, body) => ev(([id, body]) => {
        const f = window.fetch; let after = false, k = 0;
        window.fetch = async (u, o = {}) => {
            const b = JSON.parse(o.body || '{}');
            if (String(u) === '/api/chats/save' && b.file_name === id) { const res = await f(u, o); after = true; return res; }
            if (after && String(u) === '/api/chats/get' && b.file_name === id && ++k === 2) { window.fetch = f; if (body) new Function(body)(); return new Response('down', { status: 500 }); }
            return f(u, o);
        };
        window.__offSave = () => { window.fetch = f; };
    }, [id, body]);
    await stopped('h2h6');
    await endReadFails('h2h6', HIDE7('h2h6'));
    await fit(); await wait(400);
    await ev(() => window.__offSave());
    x = await chk(); r = await look();
    ok(!!x.check && r.blocked === 'room', `32. 마지막 채팅 읽기 실패로 끝나면 확인 대기 (${JSON.stringify({ ...x, h2: r.h2, blocked: r.blocked })})`);
    c = await mark();
    await recheck(); await saveTry();
    r = await look(c); x = await chk();
    ok(!!x.reopen && r.s === 0 && r.server.split(',').includes('7'), `32. 다시 확인이 숨김 차이를 보면 다시 열 때까지 멈춤 (${JSON.stringify({ ...x, s: r.s, server: r.server })})`);
    await stopped('h2h7');
    await endReadFails('h2h7', null);
    await fit(); await wait(400);
    await ev(() => window.__offSave());
    c = await mark();
    await recheck();
    r = await look(c); x = await chk();
    ok(!x.check && !x.reopen && !r.h2 && r.blocked !== 'room' && r.s === 0, `32. 차이가 없으면 이어짐 (${JSON.stringify({ ...x, h2: r.h2, blocked: r.blocked, s: r.s })})`);

    // 33. stopped before the first request (as 20): no wait for a check — the room is as before (stopped by H2 only).
    await stopped('h2h8');
    await onRead('h2h8', 2, `M.stScript.setChatSaving(true); setTimeout(() => { const m = M.serverFiles.h2h8[8]; m.is_system = true; M.stScript.setChatSaving(false); }, 300);`);
    await fit(); await wait(400);
    await ev(() => window.__offRead());
    r = await look(); x = await chk();
    ok(r.h2?.why === 'hides' && !x.check && !x.reopen && r.btn === 1, `33. 첫 요청 전에 멈추면 확인 대기 없음 (${JSON.stringify({ ...x, h2: r.h2, btn: r.btn })})`);

    // ───── v0.7.0-b3c1d (review of b3c1c) ─────
    // A fit whose chat write lands but whose end read fails: the room waits for the check (fitCheck), still stopped by H2.
    const fitWaits = async id => {
        await stopped(id);
        await endReadFails(id, null);
        await fit(); await wait(400);
        await ev(() => window.__offSave());
    };
    // Another tab saves this room's memory recorded only to #3 (hides #4·#5 are past it now).
    const SHRINK = `const H = window.__H, name = H.memName(__savePoint.home().id), d = JSON.parse(M.files.get(name)), st = JSON.parse(JSON.stringify(d.state));
        st.lastIndex = 3; st.hashes = st.hashes.slice(0, 4); st.undo = null; st.undoInfo = null; M.otherPut(name, H.nextMem(d, st, 'other34'));`;

    // 34. P1: the wait for a check left by a first fit stays when a second fit ends with nothing sent. The first fit's end read fails;
    //     another tab saves a memory recorded to #3 → `다시 확인` links it, #4·#5 now stop the room (H2); a second fit is held back before
    //     its first request (a 🔖 on #7 set elsewhere while SillyTavern saves) → still waiting; the other tab takes away #4·#5 →
    //     `다시 확인` sees the 🔖 apart → stopped until reopened; a save writes nothing and the 🔖 stays.
    await ev(async () => { window.__H = await import('/ext/home.js'); });
    await fitWaits('h2i1');
    x = await chk();
    ok(!!x.check, `34. 준비: 첫 맞추기가 끝 확인을 못 해 확인 대기 (${JSON.stringify(x)})`);
    await ev(new Function(SHRINK));
    await recheck();
    r = await look(); x = await chk();
    ok(r.h2?.why === 'hides' && !!x.check && r.file === 3, `34. 준비: 다른 탭이 기억을 #3까지로 → 다시 확인 → #4·#5로 멈춤, 확인 대기 남음 (${JSON.stringify({ ...x, h2: r.h2, file: r.file, server: r.server })})`);
    c = await mark();
    await onRead('h2i1', 2, `M.stScript.setChatSaving(true); setTimeout(() => { ${KEEP7('h2i1')} M.stScript.setChatSaving(false); }, 300);`);
    await fit(); await wait(600);
    await ev(() => window.__offRead());
    r = await look(c); x = await chk();
    ok(r.s === 0 && !!x.check, `34. 두 번째 맞추기가 첫 요청 전에 멈춰도(저장 0) 앞 맞추기의 확인 대기는 남음 (${JSON.stringify({ ...x, s: r.s, t: r.t.slice(0, 80) })})`);
    await ev(() => { for (const m of M.serverFiles.h2i1.slice(1)) if (m.extra?.savepointHidden && M.serverFiles.h2i1.indexOf(m) - 1 > 3) { m.is_system = false; delete m.extra.savepointHidden; } });
    c = await mark();
    await recheck(); await saveTry();
    r = await look(c); x = { ...(await chk()), ...(await serverHas('h2i1')) };
    ok(!!x.reopen && r.s === 0 && x.keep7, `34. 다른 탭이 남은 숨김을 풀어도 다시 확인이 🔖 차이를 보고 다시 열 때까지 멈춤, 세이브 쓰기 0, 🔖 그대로 (${JSON.stringify({ ...x, h2: r.h2, s: r.s })})`);

    // 35. P2: an old-format memory resumed by `다시 확인` (fitCheck) is not tidied then (no memory write), but by the next save (as 17).
    await recorded('h2i2');
    await ev(() => M.add(2));
    await wait(300);
    await ev(() => { const d = M.memDoc('h2i2'); d.state.mem.evidenceVersion = 0; M.files.set(M.H.memName(d.id), JSON.stringify(d)); });
    await reopen('h2i2', `f[10].is_system = true; f[10].extra = { ...(f[10].extra || {}), savepointHidden: 1 };`);
    await wait(1200);
    await endReadFails('h2i2', null);
    await fit(); await wait(400);
    await ev(() => window.__offSave());
    x = await chk();
    ok(!!x.check, `35. 준비: 예전 형식 기억 방, 맞추기가 끝 확인을 못 해 확인 대기 (${JSON.stringify(x)})`);
    c = await mark();
    await recheck(); await wait(1500);
    r = await look(c); x = { ...(await chk()), ev: await ev(() => M.mem('h2i2')?.mem?.evidenceVersion ?? null) };
    ok(!x.check && !x.reopen && !r.h2 && r.puts.length === 0 && r.s === 0 && x.ev === 0, `35. 다시 확인으로 이어질 때 기억 파일 쓰기 0, 정리는 아직 (${JSON.stringify({ ...x, h2: r.h2, puts: r.puts, s: r.s })})`);
    c = await mark();
    await saveTry(); await wait(500);
    x = await ev(() => ({ ev: M.mem('h2i2')?.mem?.evidenceVersion ?? null }));
    ok(x.ev === 1, `35. 다음 세이브에서 정리 (${JSON.stringify(x)})`);

    // 36. (P3) `다시 확인` sees a SavePoint hide the linked memory covers (#2) taken away on the server only: that is a difference, not an
    //     old hide to clear (taken away right before the link's second chat read, after the first was fitted) — stopped until reopened, the page keeps #2 hidden.
    await fitWaits('h2i3');
    x = await chk();
    ok(!!x.check, `36. 준비: 확인 대기 (${JSON.stringify(x)})`);
    await onRead('h2i3', 2, `const m = M.serverFiles.h2i3[3]; m.is_system = false; delete m.extra.savepointHidden;`);
    c = await mark();
    await recheck();
    await ev(() => window.__offRead());
    r = await look(c); x = await chk();
    ok(!!x.reopen && !x.check && r.page.split(',').includes('2') && r.s === 0, `36. 기억 범위 안 숨김이 서버에서만 풀렸으면 다시 열 때까지 멈춤, 화면 #2 숨김 그대로 (${JSON.stringify({ ...x, page: r.page, server: r.server, s: r.s })})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
