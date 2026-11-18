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

    // 7. The 🔖 turned off in the chat file elsewhere (another tab): the turn writes nothing and leaves the page as it is.
    c = await mark();
    await gen(true);
    await swipe(12, 'new');
    await ev(() => { const f = M.serverFiles[M.chatId][13]; delete f.extra.savepointKeep; for (const s of f.swipe_info) delete s.extra.savepointKeep; });
    await gen(false); await wait(2500);
    r = await look(12, c);
    ok(!r.keep && r.s === 0 && !r.fkeep && r.fproof.indexOf('1') < 0, `7. 서버에서 🔖 해제 → 쓰기 0 (${JSON.stringify(r)})`);
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

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
