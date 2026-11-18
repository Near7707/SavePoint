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
    // v0.7.0-b3d (b3d design, GPT 1·2차): a 🔖 a swipe took off comes back at the room's turn, chat file only. While it waits the message is
    // hidden by nothing new; a stopped room asks nothing; at its turn the ask, the page and the chat file are looked at again.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, hideMode: 'auto', keepRecent: 4, askResume: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    let r, c;
    await ev(() => M.add(12));
    await ev(() => __savePoint.handle('run'));
    await wait(1200);
    await ev(() => M.add(2));   // #12, #13: not recorded yet (swipes there change no recorded original)
    await wait(300);
    // A message with two swipes, kept by the 🔖 (written).
    const keepOn = async i => {
        if (await ev(i => !!M.chat[i].extra?.savepointKeep, i)) { await ev(i => __savePoint.toggleKeep(i), i); await wait(400); }
        await ev(i => { const m = M.chat[i]; m.swipes = [m.mes, m.mes + ' (alt)']; m.swipe_info = [{ extra: {} }, { extra: {} }]; m.swipe_id = 0; M.stSave(); }, i);
        await ev(i => __savePoint.toggleKeep(i), i);
        await wait(400);
    };
    // A swipe: to swipe k ('new': a new one, with an extra of its own; 'same': the event again), the message's extra from that swipe. In place
    // (`still`): a new swipe entry on a recorded message whose swipe and text stay (as keep.cjs 4: no original changes there).
    const swipe = (i, k, { emit = true, still = false } = {}) => ev(([i, k, emit, still]) => {
        const m = M.chat[i];
        if (still) { m.swipe_info.push({ extra: {} }); m.extra = {}; }
        else {
            if (k === 'new') { k = m.swipes.length; m.swipes.push(`swipe ${k} of ${i} ${'and more '.repeat(5)}`); m.swipe_info.push({ extra: {} }); }
            if (k !== 'same') m.swipe_id = k; else k = m.swipe_id; m.mes = m.swipes[k]; m.extra = JSON.parse(JSON.stringify(m.swipe_info[k].extra || {}));
        }
        return emit ? M.eventSource.emit('message_swiped', i) : null;
    }, [i, k, emit, still]);
    const gen = on => ev(on => M.eventSource.emit(on ? 'generation_started' : 'generation_ended'), on);
    const mark = () => ev(() => ({ s: (M.saveBodies || []).length, t: toastr.log.length }));
    const look = (i, c) => ev(([i, c]) => {
        const m = M.chat[i], f = (M.serverFiles[M.chatId] || [])[i + 1];
        const k = x => !!x?.extra?.savepointKeep, p = x => (x?.swipe_info || []).map(s => s?.extra?.savepointKeep ? 1 : 0).join('');
        return { keep: k(m), proof: p(m), hid: !!m.is_system, mark: !!m.extra?.savepoint_hidden || !!m.extra?.savepointHidden, fkeep: k(f), fproof: p(f), fhid: !!f?.is_system,
            s: c ? (M.saveBodies || []).length - c.s : 0, t: c ? toastr.log.slice(c.t).map(x => x.join(':')).join(' | ') : '' };
    }, [i, c]);

    // 1. A swipe to a new reply: the 🔖 comes back at the turn, one chat save, the file kept too.
    await keepOn(13);
    c = await mark();
    await swipe(13, 'new');
    await wait(1200);
    r = await look(13, c);
    ok(r.keep && r.proof === '111' && r.fkeep && r.fproof === '111' && r.s === 1, `1. 차례에서 🔖 복구 · 채팅 저장 1회 · 서버도 🔖 (${JSON.stringify(r)})`);

    // 2. Swipes while a reply is made: one ask per message, the last swipe; back to a kept swipe (A→B→A): nothing to write.
    c = await mark();
    await gen(true);
    await swipe(13, 'new'); await swipe(13, 'new'); await wait(300);
    r = await look(13, c);
    ok(!r.keep && r.s === 0, `2. 답변 중에는 기다림(쓰기 0) (${JSON.stringify(r)})`);
    await gen(false); await wait(2500);
    r = await look(13, c);
    ok(r.keep && r.proof === '11111' && r.fkeep && r.s === 1 && (await ev(() => M.chat[13].swipe_id)) === 4, `2. 빠른 스와이프 두 번 → 마지막 스와이프로 한 번만 저장 (${JSON.stringify(r)})`);
    c = await mark();
    await gen(true);
    await swipe(13, 'new'); await swipe(13, 0);
    await gen(false); await wait(2500);
    r = await look(13, c);
    ok(r.keep && r.s === 0, `2. A→B→A: 🔖 있는 스와이프로 돌아오면 쓰기 0 (${JSON.stringify(r)})`);

    // 3. Kept out of new hides while it waits (a recorded message, in the hide range): a hide pass and a reply started leave it shown;
    // the turn puts the 🔖 back.
    await keepOn(3);
    r = await look(3);
    ok(r.keep && !r.hid, `3. 준비: #3 🔖로 보임 (${JSON.stringify(r)})`);
    c = await mark();
    await gen(true);
    await swipe(3, 0, { still: true });
    await ev(() => __savePoint.syncHide());
    await ev(() => M.eventSource.emit('message_edited', 12)); await wait(400);
    await gen(true);
    r = await look(3, c);
    ok(!r.keep && !r.hid && r.s === 0, `3. 기다리는 동안 하이드 계산·답변 시작에도 #3 보임 (${JSON.stringify(r)})`);
    await gen(false); await wait(2500);
    r = await look(3, c);
    ok(r.keep && !r.hid && r.fkeep && !r.fhid && r.s === 1, `3. 차례에서 🔖 복구 (${JSON.stringify(r)})`);

    // 4. The message replaced meanwhile (no event yet): the protection goes; the hide pass hides it. Its event asks again and the turn
    // puts the 🔖 back and takes SavePoint's hide away.
    c = await mark();
    await gen(true);
    await swipe(3, 0, { still: true });
    await ev(() => { M.chat[3] = JSON.parse(JSON.stringify(M.chat[3])); });
    await ev(() => __savePoint.syncHide());
    r = await look(3, c);
    ok(!r.keep && r.hid && r.mark, `4. 메시지가 바뀌면 대기 보호가 사라짐(SavePoint가 숨김) (${JSON.stringify(r)})`);
    await ev(() => M.eventSource.emit('message_swiped', 3));
    await gen(false); await wait(2500);
    r = await look(3, c);
    ok(r.keep && !r.hid && !r.mark && r.fkeep && !r.fhid, `4. 다시 요청 → 차례에서 🔖 복구·SavePoint 숨김 풂 (${JSON.stringify(r)})`);
    // 4b. Another swipe chosen with no event yet: the turn writes nothing (its swipe is not the one asked); the event asks again.
    await keepOn(13);
    c = await mark();
    await gen(true);
    await swipe(13, 'new');
    await swipe(13, 'new', { emit: false });
    await gen(false); await wait(2500);
    r = await look(13, c);
    ok(!r.keep && r.s === 0, `4b. 차례 전에 스와이프가 바뀜 → 쓰기 0 (${JSON.stringify(r)})`);
    await swipe(13, 'same'); await wait(1500);
    r = await look(13, c);
    ok(r.keep && r.s === 1, `4b. 그 스와이프의 이벤트 → 복구 (${JSON.stringify(r)})`);

    // 5. A 🔖 turned off by hand ahead in the queue: the repair after it does not turn it on again, and the protection goes with the mark.
    c = await mark();
    await ev(() => M.stScript.setChatSaving(true));
    await ev(() => { window.__t5 = __savePoint.toggleKeep(3).catch(e => String(e)); });
    await wait(200);
    await swipe(3, 0, { still: true });
    await ev(() => __savePoint.syncHide());
    r = await look(3, c);
    ok(!r.keep && !r.hid, `5. 끄기 차례 전: 대기 보호로 보임 (${JSON.stringify(r)})`);
    await ev(() => M.stScript.setChatSaving(false));
    await ev(() => window.__t5); await wait(2500);
    await ev(() => __savePoint.syncHide());
    r = await look(3, c);
    ok(!r.keep && r.proof.indexOf('1') < 0 && !r.fkeep && r.s === 1 && r.hid, `5. 직접 끄기 뒤 🔖 복구 안 함 · 저장 1회(끄기) · 보호 사라져 숨김 (${JSON.stringify(r)})`);

    // 6. The message replaced or deleted while it waits: nothing is written for it.
    await keepOn(12);
    c = await mark();
    await gen(true);
    await swipe(12, 'new');
    await ev(() => { M.chat[12] = JSON.parse(JSON.stringify(M.chat[12])); });
    await gen(false); await wait(2500);
    r = await look(12, c);
    ok(!r.keep && r.s === 0, `6. 기다리는 동안 메시지 교체 → 쓰기 0 (${JSON.stringify(r)})`);
    await keepOn(13);
    c = await mark();
    await gen(true);
    await swipe(13, 'new');
    const n6 = await ev(() => { const m = M.chat.pop(); window.__m6 = m; M.stSave(); return M.chat.length; });
    await gen(false); await wait(2500);
    r = await ev(() => ({ kept: !!window.__m6.extra?.savepointKeep, s: (M.saveBodies || []).length }));
    ok(!r.kept && r.s === c.s, `6. 기다리는 동안 메시지 삭제 → 쓰기 0 (${JSON.stringify(r)})`);
    await ev(() => { M.chat.push(window.__m6); M.stSave(); }); await wait(300);

    // 7. The 🔖 turned off in the chat file elsewhere (another tab): the turn writes nothing.
    // v0.7.0-b3d1 (review of b3d, P1): and takes the 🔖 off the page too (the swipes' marks with it), so a later save of another 🔖 does not
    // send the old one back (7c).
    c = await mark();
    await gen(true);
    await swipe(12, 'new');
    await ev(() => { const f = M.serverFiles[M.chatId][13]; delete f.extra.savepointKeep; for (const s of f.swipe_info) delete s.extra.savepointKeep; });
    await gen(false); await wait(2500);
    r = await look(12, c);
    ok(!r.keep && r.s === 0 && !r.fkeep && r.fproof.indexOf('1') < 0, `7. 서버에서 🔖 해제 → 쓰기 0 (${JSON.stringify(r)})`);
    ok(r.proof.indexOf('1') < 0, `7. (b3d1) 화면 스와이프의 🔖 흔적도 지움 (${JSON.stringify(r)})`);
    // 7c. Another message's 🔖 saved after it: the chat file keeps #12 off.
    c = await mark();
    await ev(() => __savePoint.toggleKeep(2)); await wait(600);
    r = await look(12, c);
    ok(r.s === 1 && !r.fkeep && r.fproof.indexOf('1') < 0, `7c. (b3d1) 다른 메시지 🔖 저장 뒤에도 서버의 해제 유지 (${JSON.stringify(r)})`);
    await ev(() => __savePoint.toggleKeep(2)); await wait(600);
    await keepOn(12);
    // 7b. Put back already in the chat file (another tab repaired it): the page only, no write.
    await ev(() => M.stSave());
    c = await mark();
    await gen(true);
    await swipe(12, 'same');
    await ev(() => { const f = M.serverFiles[M.chatId][13]; f.extra.savepointKeep = 1; for (const s of f.swipe_info) s.extra.savepointKeep = 1; });
    await gen(false); await wait(2500);
    r = await look(12, c);
    ok(r.keep && r.fkeep && r.s === 0, `7b. 서버에 이미 🔖 → 화면만 맞추고 쓰기 0 (${JSON.stringify(r)})`);

    // 8. Refused: the page goes back as it was, an error is told; the swipe's 🔖 is still there for the next ask.
    c = await mark();
    await gen(true);
    await swipe(12, 'new');
    await ev(() => { M.failOnce = true; });
    await gen(false); await wait(2500);
    r = await look(12, c);
    ok(!r.keep && r.proof.indexOf('1') >= 0 && !r.fkeep && r.s === 1 && /error:/.test(r.t), `8. 저장 거절 → 화면 되돌림·오류 안내 (${JSON.stringify(r)})`);
    // 8b. No answer: the page keeps it, the room waits for a check (unsure), nothing more is written.
    c = await mark();
    await ev(() => { window.__plain8 = window.fetch; window.fetch = async (u, o) => String(u).includes('/api/chats/save') ? new Response('bad gateway', { status: 502 }) : window.__plain8(u, o); });
    await gen(true);
    await swipe(12, 'new');
    await gen(false); await wait(2500);
    await ev(() => { window.fetch = window.__plain8; });
    r = { ...(await look(12, c)), blocked: await ev(() => __savePoint.autoBlocked()) };
    ok(r.keep && !r.fkeep && r.blocked === 'unsure', `8b. 응답 없음 → 화면 🔖 유지·확인 대기 (${JSON.stringify(r)})`);
    await ev(() => M.openFile(M.chatId)); await ev(() => M.opened()); await wait(800);

    // 9. A stopped room (H2): a swipe there puts nothing on the page and writes nothing; an ask whose room stopped while it waited is dropped,
    // and not run when the room goes on (a new swipe asks again).
    await keepOn(13);
    c = await mark();
    await ev(() => { __savePoint.home().h2 = { why: 'hides', at: Date.now() }; });
    await swipe(13, 'new'); await wait(1500);
    r = await look(13, c);
    ok(!r.keep && r.s === 0, `9. 멈춘 방: 스와이프해도 표시·쓰기 0 (${JSON.stringify(r)})`);
    await ev(() => { __savePoint.home().h2 = null; });
    await gen(true);
    await swipe(13, 'new');
    await ev(() => { __savePoint.home().h2 = { why: 'hides', at: Date.now() }; });
    await gen(false); await wait(2500);
    await ev(() => { __savePoint.home().h2 = null; }); await wait(2000);
    r = await look(13, c);
    ok(!r.keep && r.s === 0, `9. 기다리던 중 멈춘 요청은 버림, 풀린 뒤 자동 실행 안 함 (${JSON.stringify(r)})`);
    await swipe(13, 'same'); await wait(1500);
    r = await look(13, c);
    ok(r.keep && r.s === 1, `9. 새 스와이프 이벤트에서 다시 요청 → 복구 (${JSON.stringify(r)})`);

    // 10. The 🔖 turned off elsewhere after the turn's read, while SillyTavern was saving: the read before the request (after waiting for it)
    // sees it gone and nothing is sent; the page goes back.
    await keepOn(13);
    c = await mark();
    await gen(true);
    await swipe(13, 'new');
    await ev(() => {
        const plain = window.fetch; let armed = true;
        window.fetch = async (u, o) => {
            const res = await plain(u, o);
            if (armed && String(u).includes('/api/chats/get')) {
                armed = false; window.fetch = plain;
                M.stScript.setChatSaving(true);
                setTimeout(() => { const f = M.serverFiles[M.chatId][14]; delete f.extra.savepointKeep; for (const s of f.swipe_info) delete s.extra.savepointKeep; M.stScript.setChatSaving(false); }, 300);
            }
            return res;
        };
    });
    await gen(false); await wait(3000);
    r = await look(13, c);
    ok(!r.keep && r.s === 0 && r.fproof.indexOf('1') < 0, `10. 차례 읽기 뒤 다른 곳에서 🔖 해제 → 요청 직전 확인에서 멈춤, 쓰기 0 (${JSON.stringify(r)})`);
    // v0.7.0-b3d1 (review of b3d, P1): taken back first, then the 🔖 the file turned off is taken off the page too (not put back by keepBack).
    ok(r.proof.indexOf('1') < 0, `10. (b3d1) 되돌린 뒤 화면 스와이프의 🔖 흔적도 지움 (${JSON.stringify(r)})`);
    c = await mark();
    await ev(() => __savePoint.toggleKeep(2)); await wait(600);
    r = await look(13, c);
    ok(r.s === 1 && !r.fkeep && r.fproof.indexOf('1') < 0, `10. (b3d1) 다른 메시지 🔖 저장 뒤에도 서버의 해제 유지 (${JSON.stringify(r)})`);
    await ev(() => __savePoint.toggleKeep(2)); await wait(600);

    // 11. v0.7.0-b3d1 (review of b3d, P2): a room that stopped and went on again before the waiting ask looked (a real H2: #9 hidden by
    // SavePoint on the server past what the memory covers, then taken away again and `다시 확인`): the ask is dropped, nothing written.
    await keepOn(13);
    c = await mark();
    await gen(true);
    await swipe(13, 'new');
    await ev(async () => {
        const f = M.serverFiles[M.chatId][13]; f.is_system = true; f.extra = { ...(f.extra || {}), savepointHidden: 1 };
        await __savePoint.handle('home-recheck');
    });
    const h11 = await ev(() => __savePoint.home().h2?.why || null);
    await ev(async () => {
        const f = M.serverFiles[M.chatId][13]; delete f.is_system; delete f.extra.savepointHidden;
        await __savePoint.handle('home-recheck');
    });
    r = { ...(await look(13, c)), h2: h11, now: await ev(() => __savePoint.home().h2?.why || null) };
    ok(r.h2 === 'hides' && !r.now && !r.keep && r.s === 0, `11. 준비: 기다리는 사이 실제 H2 → 다시 확인으로 재개 (${JSON.stringify(r)})`);
    await gen(false); await wait(3000);
    r = await look(13, c);
    ok(!r.keep && r.s === 0, `11. (b3d1) 멈췄다 재개된 방의 옛 요청은 버림 · 쓰기 0 (${JSON.stringify(r)})`);
    await swipe(13, 'same'); await wait(1500);
    r = await look(13, c);
    ok(r.keep && r.s === 1, `11. 새 스와이프 이벤트에서 다시 요청 → 복구 (${JSON.stringify(r)})`);

    // 12. v0.7.0-b3d1 (review of b3d, P1): the 🔖 turned off elsewhere after the first request, seen before a copy is sent again (SillyTavern
    // saved a newer page with a new message first): nothing more sent, and the 🔖 goes from the page; a later save keeps it off.
    await keepOn(13);
    c = await mark();
    await gen(true);
    await swipe(13, 'new');
    await ev(() => {
        const f = window.fetch;
        window.fetch = async (u, o = {}) => {
            if (String(u) === '/api/chats/save') {
                window.fetch = f;
                const m = JSON.parse(JSON.stringify(M.chat[M.chat.length - 1])); m.mes = 'new while repairing'; m.swipes = [m.mes]; m.swipe_id = 0; m.swipe_info = [{ extra: {} }]; m.extra = {};
                M.chat.push(m); M.stSave();
                const res = await f(u, o);
                const g = M.serverFiles[M.chatId][14]; delete g.extra.savepointKeep; for (const s of g.swipe_info || []) if (s?.extra) delete s.extra.savepointKeep;
                return res;
            }
            return f(u, o);
        };
    });
    await gen(false); await wait(3000);
    r = await look(13, c);
    ok(/🔖를 다시 붙이는 저장 중에/.test(r.t) && r.s === 1 && !r.fkeep, `12. 준비: 다시 보내기 전 서버 🔖 해제 → 더 안 보냄 (${JSON.stringify(r)})`);
    ok(!r.keep && r.proof.indexOf('1') < 0, `12. (b3d1) 화면 🔖·스와이프 흔적 지움 (${JSON.stringify(r)})`);
    c = await mark();
    await ev(() => __savePoint.toggleKeep(2)); await wait(600);
    r = await look(13, c);
    ok(r.s >= 1 && !r.fkeep && r.fproof.indexOf('1') < 0, `12. (b3d1) 다른 메시지 🔖 저장 뒤에도 서버의 해제 유지 (${JSON.stringify(r)})`);
    await ev(() => __savePoint.toggleKeep(2)); await wait(600);

    // 13. v0.7.0-b3d1 (review of b3d, P2): a save waiting for its memory write holds new hides; a 🔖 repair asked meanwhile for one of those
    // messages (#9: its swipe changed with no event before the save, the event during the wait) keeps it out when the held hides are put
    // back (putHeldHides): the save's chat request does not hide it, and the repair puts the 🔖 back.
    await keepOn(9);
    await swipe(9, 0, { still: true, emit: false });
    await ev(() => M.stSave());
    c = await mark();
    await ev(() => {
        M.holdMem(() => true);
        window.__s13 = [];
        const f = window.fetch;
        window.fetch = async (u, o = {}) => {
            const res = await f(u, o);
            if (String(u) === '/api/chats/save') { const g = M.serverFiles[M.chatId][10]; window.__s13.push(!!g?.is_system); if (window.__s13.length >= 2) window.fetch = f; }
            return res;
        };
        window.__r13 = __savePoint.handle('run').catch(e => String(e));
    });
    for (let k = 0; k < 40 && !(await ev(() => M.held)); k++) await wait(100);
    r = { held: await ev(() => M.held) };
    await ev(() => M.eventSource.emit('message_swiped', 9)); await wait(300);
    r.wait = await look(9);
    await ev(() => M.release && M.release());
    await ev(() => window.__r13); await wait(3000);
    r = { ...r, saves: await ev(() => window.__s13), ...(await look(9, c)) };
    ok(!!r.held && !r.wait.keep && !r.wait.hid, `13. 준비: 세이브가 기억 쓰기를 기다리는 사이 #9 복구 요청 (${JSON.stringify(r)})`);
    ok(r.saves.length >= 1 && !r.saves[0], `13. (b3d1) 세이브의 채팅 저장이 #9를 숨기지 않음 (${JSON.stringify(r)})`);
    ok(r.keep && !r.hid && r.fkeep && !r.fhid, `13. 그 뒤 차례에서 🔖 복구 (${JSON.stringify(r)})`);
    // v0.7.0-b3d2 (review of b3d1, P3): the hide left out only for the waiting 🔖 is no failure: the save ends with no error, nothing said of
    // an original changed.
    r.run = await ev(async () => { const v = await window.__r13; return v === undefined ? null : String(v); });
    ok(!/원문이 바뀌어서|error/i.test(String(r.run || '')) && !/원문이 바뀌어서|^error:/m.test(r.t.split(' | ').join('\n')), `13. (b3d2) 복구 대기로만 건너뛴 숨김은 오류 없이 성공 (${JSON.stringify(r)})`);

    // 14. v0.7.0-b3d2 (review of b3d1, P2): the message before the one repaired deleted right after the repair's first request (SillyTavern
    // saves the page without it, a copy is sent again): the check before the copy sent again does not read the turn's old copy at the old
    // place (another message there, no 🔖) as the 🔖 turned off. The 🔖 stays on the page and in the file through the next save.
    await ev(() => { const m = M.chat[12]; m.extra = {}; for (const s of m.swipe_info || []) if (s && typeof s === 'object') s.extra = {}; delete m.is_system; M.stSave(); });
    await keepOn(13);
    c = await mark();
    await gen(true);
    await swipe(13, 'new');
    await ev(() => {
        const f = window.fetch;
        window.fetch = async (u, o = {}) => {
            if (String(u) === '/api/chats/save') {
                window.fetch = f;
                const res = await f(u, o);
                M.chat.splice(12, 1); await M.eventSource.emit('message_deleted', 12); M.stSave();
                return res;
            }
            return f(u, o);
        };
    });
    await gen(false); await wait(3000);
    r = await look(12, c);
    ok(r.keep && r.proof.indexOf('1') >= 0 && r.fkeep && r.s >= 1 && !/🔖를 다시 붙이는 저장 중에/.test(r.t), `14. (b3d2) 복구 저장 직후 앞 메시지 삭제 → 화면·서버 🔖 유지 (${JSON.stringify(r)})`);
    c = await mark();
    await ev(() => __savePoint.toggleKeep(2)); await wait(600);
    r = await look(12, c);
    ok(r.s >= 1 && r.keep && r.fkeep, `14. (b3d2) 다음 일반 저장 뒤에도 서버 🔖 유지 (${JSON.stringify(r)})`);
    await ev(() => __savePoint.toggleKeep(2)); await wait(600);

    // 15. v0.7.0-b3d3 (review of b3d2, P2): two messages alike (text, speaker, swipes), the 🔖 on the later one only. Right as the repair's
    // first request leaves, the earlier one is deleted and SillyTavern saves the page first; the repair's request lands after it, so the file
    // is the copy sent (before the deletion). The check before a copy sent again reads that copy at the moved place (the earlier message, no
    // 🔖): it is this write's own copy, no 🔖 turned off. Nothing more is sent, the page keeps the 🔖 and the swipes' marks; the next save
    // takes the deletion to the file and keeps the 🔖 there.
    await ev(() => M.add(2)); await wait(300);   // #14, #15
    await keepOn(15);
    c = await mark();
    await gen(true);
    await swipe(15, 'new');
    await ev(() => {
        const a = M.chat[14], b = JSON.parse(JSON.stringify(M.chat[15]));
        b.extra = {}; for (const s of b.swipe_info || []) if (s && typeof s === 'object') s.extra = {};
        delete b.is_system;
        for (const k of Object.keys(a)) delete a[k];
        Object.assign(a, b);
        M.stSave();
        const f = window.fetch;
        window.__s15 = [];
        window.fetch = async (u, o = {}) => {
            if (String(u) === '/api/chats/save') {
                window.__s15.push(1);
                if (window.__s15.length === 1) {
                    M.chat.splice(14, 1); await M.eventSource.emit('message_deleted', 14); M.stSave();
                    return f(u, o);
                }
            }
            return f(u, o);
        };
        window.__off15 = () => { window.fetch = f; };
    });
    await gen(false); await wait(3000);
    r = { ...(await look(14, c)), sent: await ev(() => window.__s15.length), n: await ev(() => [M.chat.length, M.serverFiles[M.chatId].length - 1]) };
    await ev(() => window.__off15());
    ok(r.sent === 1 && r.n[0] + 1 === r.n[1] && /🔖를 다시 붙이는 저장 중에/.test(r.t), `15. 준비: 앞의 같은 메시지 삭제 뒤 내 첫 요청이 늦게 들어감 → 재전송 멈춤 (${JSON.stringify(r)})`);
    ok(r.keep && r.proof.indexOf('1') >= 0, `15. (b3d3) 내 사본을 🔖 해제로 안 봄 → 화면 🔖·스와이프 흔적 유지 (${JSON.stringify(r)})`);
    // SillyTavern's next save of the page (the deletion it already made) puts it in the file.
    await ev(() => M.stSave()); await wait(300);
    r = { ...(await look(14)), n: await ev(() => [M.chat.length, M.serverFiles[M.chatId].length - 1]) };
    ok(r.n[0] === r.n[1] && r.keep && r.fkeep && r.fproof.indexOf('1') >= 0, `15. (b3d3) 다음 일반 저장에서 삭제 반영·서버 🔖 유지 (${JSON.stringify(r)})`);
    c = await mark();
    await ev(() => __savePoint.toggleKeep(2)); await wait(600);
    r = await look(14, c);
    ok(r.s >= 1 && r.keep && r.fkeep, `15. (b3d3) 그 뒤 SavePoint 저장도 평소대로·서버 🔖 유지 (${JSON.stringify(r)})`);
    await ev(() => __savePoint.toggleKeep(2)); await wait(600);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
