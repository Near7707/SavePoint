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

// v0.7.0-a2 (review of v0.7.0-a1).
// P2-1: a recorded message edited while a checkpoint's start mark was being written: the old memory went out with the
//       new messages and was saved with fresh fingerprints (the edit was never found again).
// P2-2: with the tidy-up of an old-format memory refused once, 한국어 보기 and 주입 포인트 다시 고르기 changed the tidied
//       copy and said "done"; nothing was saved.
// P3-1: manual hides shown for a changed original stayed shown when the original was put back before its turn.
// P3-2: an empty checkpoint's result banner showed in the room opened while its note was being written.
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: 'off', askResume: false, autoReserve: 0 } }; });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
    await page.waitForTimeout(300);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const toasts = () => ev(() => toastr.log.map(x => x[1]).join(' | '));
    const hold = test => ev(src => {
        const f = new Function('st', src);
        M.held = false;
        M.beforeChatSave = async (name, data) => {
            if (M.held || !f(data[0]?.chat_metadata?.savePoint)) return;
            M.held = name;
            await new Promise(r => { M.release = r; });
        };
    }, test);
    const settle = () => ev(() => { M.beforeChatSave = null; M.release?.(); });
    let r;

    await ev(() => { M.add(8); });
    await ev(() => __savePoint.handle('run'));
    await wait(1200);
    const chatA = await ev(() => JSON.parse(JSON.stringify(M.serverFiles.chatA)));
    ok(chatA[0].chat_metadata.savePoint?.lastIndex === 7, '준비: #7까지 기록');
    const fresh = async () => { await ev(f => { M.serverFiles.chatA = f; }, chatA); await ev(() => M.openFile('chatA')); await wait(800); };

    // 1. [P2-1] Checkpoint: #0 is edited while its start mark is being written (with and without the edit event).
    for (const [label, event] of [['편집 알림 없이', false], ['편집 알림과 함께', true]]) {
        await fresh();
        await ev(() => M.add(6));
        await wait(300);
        const c0 = await ev(() => M.calls.length);
        await hold('return !!st?.autoAttemptAt');
        await ev(() => { toastr.log.length = 0; M.p = __savePoint.summarize({ auto: true }); });
        await page.waitForFunction(() => M.held, null, { timeout: 5000 });
        await ev(async ev2 => {
            M.chat[0].mes = 'An edited first message, changed during the start mark.'; M.stSave();
            if (ev2) await SillyTavern.getContext().eventSource.emit('message_edited', 0);
        }, event);
        await wait(400);
        await settle();
        await ev(() => M.p);
        await wait(2500);
        r = await ev(c => {
            const sent = M.calls.slice(c), st = M.serverFiles.chatA[0].chat_metadata.savePoint;
            const edited = sent.some(p => p.includes('edited first message'));
            return { stale: !edited && (st.lastIndex > 7 || __savePoint.state().lastIndex > 7), edited, file: st.lastIndex, page: __savePoint.state().lastIndex };
        }, c0);
        ok(!r.stale, `1. ${label}: 옛 요약에 새 메시지만 붙여 저장하지 않음`);
        ok(r.edited && r.file === 13 && r.page === 13, `1. ${label}: 고친 #0부터 다시 기록 (보냄 ${r.edited}, 화면 #${r.page}, 파일 #${r.file})`);
        ok((await toasts()).includes('되감았어요'), `1. ${label}: 되감기 안내`);
    }

    // 2. [P2-2] Tidy-up refused once, then 한국어 보기 / 주입 포인트 다시 고르기.
    const oldRoom = async () => {
        const f = JSON.parse(JSON.stringify(chatA));
        f[0].chat_metadata.savePoint.mem.evidenceVersion = 0;
        await ev(file => { M.serverFiles.chatA = file; M.failMeta = true; }, f);
        await ev(() => M.openFile('chatA'));
        await wait(1500);
        await ev(() => { M.failMeta = false; toastr.log.length = 0; });
        return ev(() => M.meta.savePoint.mem.evidenceVersion !== 1 && __savePoint.state().mem.evidenceVersion === 1);
    };
    ok(await oldRoom(), '2. 준비: 정리 저장 거절 → 읽기는 정리된 사본');
    await ev(() => __savePoint.handle('translate'));
    await wait(1500);
    r = await ev(() => ({ page: JSON.stringify(M.meta.savePoint.mem).includes('"ko'), file: JSON.stringify(M.serverFiles.chatA[0].chat_metadata.savePoint.mem).includes('"ko') }));
    let t = await toasts();
    ok(r.page && r.file || !t.includes('한국어 보기를 만들었어요'), `2. 한국어 보기: 저장하지 않고 완료라고 알리지 않음 (화면 ${r.page}, 파일 ${r.file})`);
    ok(r.page && r.file, '2. 한국어 보기: 정리부터 저장하고 번역도 저장됨');

    ok(await oldRoom(), '2. 준비(다시): 정리 저장 거절 → 읽기는 정리된 사본');
    const sid = await ev(() => __savePoint.state().mem.scenes[0]?.id);
    const before = await ev(() => JSON.stringify(M.serverFiles.chatA[0].chat_metadata.savePoint.mem.scenes));
    await ev(id => { M.rekeyCalls = 0; return __savePoint.handle('rekey-scene', id); }, sid);
    await wait(1500);
    r = await ev(b => ({ calls: M.rekeyCalls, file: JSON.stringify(M.serverFiles.chatA[0].chat_metadata.savePoint.mem.scenes) !== b, ev: M.serverFiles.chatA[0].chat_metadata.savePoint.mem.evidenceVersion }), before);
    t = await toasts();
    ok(r.calls >= 1 && r.file && r.ev === 1 || !t.includes('다시 골랐어요'), `2. 주입 포인트: 저장하지 않고 완료라고 알리지 않음 (요청 ${r.calls}, 파일 바뀜 ${r.file})`);
    ok(r.calls >= 1 && r.file && r.ev === 1, '2. 주입 포인트: 정리부터 저장하고 고른 포인트도 저장됨');

    // 2b. The tidy-up keeps failing: neither starts, and says why.
    await oldRoom();
    await ev(() => { M.failMeta = true; M.c0 = M.calls.length; });
    await ev(() => __savePoint.handle('translate'));
    await wait(1000);
    await ev(id => __savePoint.handle('rekey-scene', id), sid);
    await wait(1000);
    r = await ev(() => M.calls.length - M.c0);
    t = await toasts();
    ok(r === 0 && (t.match(/기억 정리를 저장하지 못해서/g) || []).length === 2 && !t.includes('만들었어요') && !t.includes('다시 골랐어요'), `2b. 정리가 계속 안 되면 요청 없이 알림 (요청 ${r}개, ${t.slice(0, 120)})`);
    await ev(() => { M.failMeta = false; });

    // 3. [P3-1] Manual hides: a hidden recorded message is edited, a reply starts, and the edit is put back exactly
    //    before the rollback's turn.
    await ev(() => { M.settings.savePoint.hideMode = 'manual'; M.settings.savePoint.hideManualAt = Date.now(); M.settings.savePoint.keepRecent = 4; M.confirm = 1; });
    await fresh();
    await ev(() => M.add(22));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    await ev(() => __savePoint.handle('hide-now'));
    await wait(500);
    const hidden = () => ev(() => M.chat.map(m => m.is_system ? 'H' : '.').join(''));
    const h0 = await hidden();
    ok(h0.startsWith('HHHHHHHHHH') && h0.endsWith('....'), `3. 준비: 수동 하이드 (${h0})`);
    // the user opens #2 themselves: it stays open
    await ev(() => { M.chat[2].is_system = false; __savePoint.syncHide(); });
    const text5 = await ev(() => M.chat[5].mes);
    const mid = await ev(async () => {
        M.chat[5].mes = 'An edited early message.'; M.stSave();
        await SillyTavern.getContext().eventSource.emit('message_edited', 5);
        await SillyTavern.getContext().eventSource.emit('generation_started', 'normal', {}, false);
        return { h: M.chat.map(m => m.is_system ? 'H' : '.').join(''), last: M.meta.savePoint.lastIndex };
    });
    ok(!mid.h.includes('H') && mid.last === 29, `3. 준비: 생성 시작 때 하이드가 풀림, 기억은 아직 그대로 (${mid.h}, #${mid.last})`);
    await ev(async t5 => { M.chat[5].mes = t5; M.stSave(); await SillyTavern.getContext().eventSource.emit('message_edited', 5); }, text5);
    await wait(400);
    await ev(() => SillyTavern.getContext().eventSource.emit('generation_ended', M.chat.length));
    await wait(2500);
    r = await ev(() => ({ h: M.chat.map(m => m.is_system ? 'H' : '.').join(''), file: M.serverFiles.chatA.slice(1).map(m => m.is_system ? 'H' : '.').join(''), last: M.meta.savePoint.lastIndex }));
    const want = h0.slice(0, 2) + '.' + h0.slice(3);
    ok(r.last === 29, `3. 기억은 그대로 (#${r.last})`);
    ok(r.h === want && r.file === want, `3. 원문을 되돌리면 SavePoint가 푼 하이드만 다시 숨김, 직접 연 #2는 그대로 (화면 ${r.h}, 파일 ${r.file})`);
    await ev(() => { M.settings.savePoint.hideMode = 'off'; });

    // 4. [P3-2] An empty checkpoint in room A; room B is opened while its result note is being written.
    await fresh();
    await ev(l => { M.serverFiles.roomB = JSON.parse(JSON.stringify([{ chat_metadata: {} }, ...l])); },
        Array.from({ length: 4 }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, is_system: false, mes: `Bee ${i}.`, swipe_id: 0, swipes: [`Bee ${i}.`], extra: {} })));
    await ev(() => { M.chat.length = 8; M.stSave(); });
    await wait(300);
    await hold("return st?.autoLast?.status === 'empty'");
    await ev(() => { M.p = __savePoint.summarize({ auto: true }); });
    await page.waitForFunction(() => M.held, null, { timeout: 5000 });
    await ev(() => M.openFile('roomB'));
    await wait(500);
    await settle();
    await ev(() => M.p);
    await wait(300);
    r = await ev(() => { const b = document.getElementById('sp_save_banner'); return { shown: !!b && !b.hidden && b.dataset.flash === '1', text: b?.textContent || '' }; });
    ok(!r.text.includes('기록할 메시지 없음'), `4. A방의 빈 체크포인트 배너가 B방에 뜨지 않음 (${r.shown ? r.text.slice(0, 40) : '없음'})`);

    // 5. [v0.7.0-a3, review of v0.7.0-a2 P2] Manual hides: a hidden recorded #0 is edited, a reply starts (#0 shown),
    //    then 🔶 on #7 is pressed while the edit is still there: its save turn must not hide #0 again.
    await ev(() => { M.settings.savePoint.hideMode = 'manual'; M.settings.savePoint.hideManualAt = Date.now(); M.settings.savePoint.keepRecent = 4; M.confirm = 1; });
    await fresh();
    await ev(() => M.add(22));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    await ev(() => __savePoint.handle('hide-now'));
    await wait(500);
    const h5 = await hidden();
    r = await ev(async () => {
        M.chat[0].mes = 'An edited first message, still edited.'; M.stSave();
        await SillyTavern.getContext().eventSource.emit('message_edited', 0);
        await SillyTavern.getContext().eventSource.emit('generation_started', 'normal', {}, false);
        return M.chat[0].is_system;
    });
    ok(h5.startsWith('HHHHHHHH') && r === false, `5. 준비: 수동 하이드 → #0 고치고 생성 시작 → #0 보임 (${h5})`);
    await ev(() => __savePoint.toggleKeep(7).catch(e => { M.kErr = e.message; }));
    await wait(800);
    r = await ev(() => ({ h0: M.chat[0].is_system, f0: M.serverFiles.chatA[1].is_system, last: M.meta.savePoint.lastIndex, err: M.kErr || '' }));
    ok(r.last === 29 && !r.err, `5. 🔶 저장 차례는 끝남, 기억은 아직 그대로 (#${r.last}${r.err ? ', ' + r.err : ''})`);
    ok(r.h0 === false && r.f0 === false, `5. 원문이 아직 바뀐 채면 🔶 저장 차례가 #0을 다시 숨기지 않음 (화면 ${r.h0}, 파일 ${r.f0})`);
    await ev(() => SillyTavern.getContext().eventSource.emit('generation_ended', M.chat.length));
    await wait(2500);
    r = await ev(() => ({ h0: M.chat[0].is_system, last: M.meta.savePoint.lastIndex }));
    ok(r.last < 0 && r.h0 === false, `5. 답변이 끝나면 평소처럼 되감기, #0은 보임 (#${r.last})`);
    await ev(() => { M.settings.savePoint.hideMode = 'off'; });

    // 6. [v0.7.0-a3, review P3] The tidy-up is shown but its write cannot be confirmed: 한국어 보기 sends no request.
    await oldRoom();
    await ev(() => {
        M.c0 = M.calls.length; M.noAns = true;
        if (!M.fetchWrapped) {
            M.fetchWrapped = true;
            const f = window.fetch;
            window.fetch = async (u, o) => {
                if (String(u) === '/api/chats/save' && M.noAns) { M.noAns = false; await f(u, o); throw new TypeError('Failed to fetch'); }
                return f(u, o);
            };
        }
    });
    await ev(() => __savePoint.handle('translate'));
    await wait(1500);
    r = await ev(() => ({ calls: M.calls.length - M.c0, gate: __savePoint.autoBlocked(), what: M.calls.slice(M.c0).map(p => p.slice(0, 60)).join(' / '), mem: M.meta.savePoint.mem.evidenceVersion }));
    t = await toasts();
    ok(r.calls === 0 && !t.includes('만들었어요'), `6. 정리 저장 응답을 확인하지 못하면 번역 요청 없음 (요청 ${r.calls}개, 기억 정리 화면 적용 ${r.mem === 1}, ${r.gate})`);
    await ev(() => { M.noAns = false; });

    // 7. [v0.7.0-a4, review of v0.7.0-a3 P2] Auto hides (the default): a hidden recorded #0 is edited, a reply starts
    //    (#0 shown), 🔶 on #7 is pressed and its write's answer is lost, then the next reply starts: #0 stays shown.
    await ev(() => { M.settings.savePoint.hideMode = 'auto'; M.settings.savePoint.keepRecent = 4; M.confirm = 1; });
    await fresh();
    await ev(() => M.add(22));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const h7 = await hidden();
    r = await ev(async () => {
        M.chat[0].mes = 'An edited first message, auto mode.'; M.stSave();
        await SillyTavern.getContext().eventSource.emit('message_edited', 0);
        await SillyTavern.getContext().eventSource.emit('generation_started', 'normal', {}, false);
        return M.chat[0].is_system;
    });
    ok(h7.startsWith('HHHHHHHH') && r === false, `7. 준비: 자동 하이드 → #0 고치고 생성 시작 → #0 보임 (${h7})`);
    await ev(() => { M.noAns = true; M.kErr = ''; });
    await ev(() => __savePoint.toggleKeep(7).catch(e => { M.kErr = e.message; }));
    await wait(800);
    await ev(() => { M.noAns = false; });
    r = await ev(() => ({ h0: M.chat[0].is_system, last: M.meta.savePoint.lastIndex, gate: __savePoint.autoBlocked() }));
    ok(r.h0 === false, `7. 🔶 저장 응답이 끊겨도 #0은 보임 (기억 #${r.last}, ${r.gate})`);
    r = await ev(async () => {
        await SillyTavern.getContext().eventSource.emit('generation_started', 'normal', {}, false);
        return { h0: M.chat[0].is_system, sent: !M.chat[0].is_system };
    });
    ok(r.h0 === false, '7. 다음 답변 시작 때도 고친 #0이 하이드로 빠지지 않음');
    await ev(() => { M.settings.savePoint.hideMode = 'off'; });

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
