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


// v0.6.86 (review of v0.6.83–84):
// 1. Continuing in a new room draws the new #0 on the screen only (addOneMessage on an empty chat view,
//    updateMessageBlock when #0 is drawn): it never reloads the chat from the file. A continue whose request got
//    no answer leaves the room paused (1: nothing more sent, the late request lands, the page keeps the new
//    messages); a normal continue draws #0 once (1b, 1c).
// 2. A refused continue whose new #0 changed meanwhile (a translation) keeps that #0 and the edited-chat mark
//    (tainted) with it, and says so (2); a #0 put back takes the mark back too (2b).
// 3. AUTO stores the slot made when its write was confirmed: a later edit whose answer has not come (3: lost,
//    the read-back slow; 3b: A's timer runs while B is still on its way, then B is refused) is not backed up.
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    async function session() {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: 'off' } }; });
        await page.goto(URL);
        await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
        await page.waitForTimeout(300);
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await ev(() => { M.add(12); });
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        await ev(() => { M.saveBodies = []; M.toastLog = toastr.log.length; });
        return { page, ev };
    }
    const GREETING = 'Hello! This is the very first greeting.';
    const greetingRoom = () => [{ name: 'Ari', is_user: false, is_system: false, mes: GREETING, swipe_id: 0, swipes: [GREETING], extra: {} }];
    const keep = (ev, i) => ev(i => __savePoint.toggleKeep(i).then(() => 'ok', e => `${e.name}: ${e.message}`), i);
    // Opens `room` (empty or with the greeting, drawn as SillyTavern draws it) and continues there from the QUICK slot.
    async function carry(page, ev, room, before) {
        const qid = await ev(() => __savePoint.listSaves().find(x => x.quick)?.id);
        await ev(r => M.switchChat('chatNew', r, {}), room);
        if (room.length) await ev(() => SillyTavern.getContext().addOneMessage(M.chat[0]));
        await page.waitForTimeout(600);
        await ev(() => { M.draws = 0; M.redraws = 0; M.reloads = 0; M.saveBodies = []; M.toastLog = toastr.log.length; });
        if (before) await before();
        await ev(async id => { M.confirm = 1; await __savePoint.handle('load', id); }, qid);
        await page.waitForTimeout(800);
        return ev(() => ({ draws: M.draws, redraws: M.redraws, reloads: M.reloads, page0: M.chat[0]?.mes ?? null, shown: document.querySelectorAll('#chat .mes').length,
            toasts: toastr.log.slice(M.toastLog).map(t => JSON.stringify(t)).join(' ') }));
    }
    // The next chat save gets no answer and lands `ms` later (counted in M.saveBodies only when it lands).
    const late = (ev, ms) => ev(ms => { const f = window.fetch; let k = 0;
        window.fetch = (u, o) => { if (String(u) !== '/api/chats/save' || ++k !== 1) return f(u, o); setTimeout(() => f(u, o), ms); return Promise.reject(new TypeError('Failed to fetch')); }; }, ms);

    // 1. An empty room; the continue gets no answer (it lands 4 s later). Then two new messages and a 🔶.
    {
        const { page, ev } = await session();
        const r = await carry(page, ev, [], () => late(ev, 4000));
        const carried = r.page0;
        await ev(() => { M.chat.push({ name: 'Me', is_user: true, is_system: false, mes: 'New one.', swipe_id: 0, extra: {} }, { name: 'Ari', is_user: false, is_system: false, mes: 'New two.', swipe_id: 0, extra: {} }); M.stSave(); });
        const k = await keep(ev, 1);
        const sends = await ev(() => M.saveBodies.length);
        ok(r.reloads === 0 && r.draws === 1 && r.shown === 1 && carried && carried !== GREETING && /RoomBlocked: 응답을 받지 못한/.test(k) && sends === 0,
            `1. 응답 없는 이어하기: 방을 다시 읽지 않고 첫 메시지를 한 번 그림, 방은 멈춘 채 다음 🔶 요청 0회 (${JSON.stringify({ reloads: r.reloads, draws: r.draws, sends })}, ${k.slice(0, 26)})`);
        await page.waitForTimeout(4300);
        const f = await ev(() => ({ page: M.chat.map(m => m.mes), sends: M.saveBodies.length, reloads: M.reloads }));
        ok(f.page.length === 3 && f.page[0] === carried && f.page[2] === 'New two.' && f.sends === 1 && f.reloads === 0, `1. 늦은 요청 도착 뒤에도 화면은 첫 메시지와 새 메시지 둘 그대로, SavePoint 추가 요청 없음 (${JSON.stringify(f)})`);
        await page.close();
    }
    // 1b–1c. A normal continue: into an empty room (drawn once, added) and over the greeting (that message redrawn).
    for (const [n, room] of [['1b', []], ['1c', greetingRoom()]]) {
        const { page, ev } = await session();
        const r = await carry(page, ev, room);
        const file = await ev(() => ({ n: M.serverFiles.chatNew.length - 1, first: M.serverFiles.chatNew[1]?.mes, mem: !!M.serverFiles.chatNew[0].chat_metadata.savePoint }));
        const drawn = n === '1b' ? r.draws === 1 && r.redraws === 0 : r.draws === 0 && r.redraws === 1;
        ok(r.reloads === 0 && drawn && r.shown === 1 && file.n === 1 && file.first === r.page0 && r.page0 !== GREETING && file.mem,
            `${n}. 이어하기 성공(${n === '1b' ? '빈 방' : '인사말 방'}): 첫 메시지를 한 번만 그리고 방을 다시 읽지 않음 (${JSON.stringify({ draws: r.draws, redraws: r.redraws, reloads: r.reloads })})`);
        await page.close();
    }
    // 2. Over the greeting, refused (500) while the new #0 gets a translation: it stays, with tainted, and the notice
    //    says so. 2b: refused with nothing changed: #0 and tainted go back.
    for (const how of ['translated', 'plain']) {
        const { page, ev } = await session();
        const r = await carry(page, ev, greetingRoom(), () => ev(how => { M.metaDelay = 400; M.failOnce = true; let n = 0;
            if (how === 'translated') M.beforeChatSave = async () => { if (++n === 1) setTimeout(() => { M.noStSave = true; M.chat[0].extra.display_text = 'Translated.'; }, 100); }; }, how));
        await ev(() => { M.metaDelay = 0; M.beforeChatSave = null; M.noStSave = false; M.stSave(); });   // SillyTavern's next save
        const s = await ev(() => ({ tainted: M.meta.tainted === true, fileTainted: M.serverFiles.chatNew[0].chat_metadata.tainted === true, tr: M.chat[0].extra?.display_text ?? null, mem: !!__savePoint.state()?.mem?.scenes?.length }));
        if (how === 'translated') ok(r.page0 !== GREETING && s.tr === 'Translated.' && s.tainted && s.fileTainted && !s.mem && /그대로 두었어요/.test(r.toasts) && !/첫 메시지와 기억은 불러오기 전 그대로/.test(r.toasts),
            `2. 이어하기 거절, 번역이 붙은 첫 메시지는 남기고 편집된 채팅 표시도 남김, 안내도 그렇게 (${JSON.stringify(s)})`);
        else ok(r.page0 === GREETING && !s.tainted && !s.fileTainted && !s.mem && /첫 메시지와 기억은 불러오기 전 그대로/.test(r.toasts), `2b. 이어하기 거절, 첫 메시지를 되돌리면 편집된 채팅 표시도 되돌림 (${JSON.stringify(s)})`);
        await page.close();
    }
    // 3. Title A is saved (its AUTO waits 1.2 s); title B's write gets no answer and its read-back is slow.
    //    3b. A's timer runs while B is still on its way (2 s); then B is refused (SillyTavern's 500).
    const lastAuto = ev => ev(() => __savePoint.listSaves().filter(s => s.auto).sort((a, b) => (b.created || 0) - (a.created || 0))[0]?.stats?.lastTitle ?? null);
    for (const how of ['lost', 'slow']) {
        const { page, ev } = await session();
        await ev(() => __savePoint.commitEdit(m => { m.scenes.at(-1).title = 'Title A'; }));
        if (how === 'lost') await ev(() => { const f = window.fetch; let k = 0; window.fetch = (u, o) => { if (String(u) !== '/api/chats/save' || ++k !== 1) return f(u, o);
            M.readDelayFor = { chatA: 2500 }; setTimeout(() => f(u, o), 20000); return Promise.reject(new TypeError('Failed to fetch')); }; });
        else await ev(() => { M.metaDelay = 2000; M.failOnce = true; });
        await ev(() => { window.__b = __savePoint.commitEdit(m => { m.scenes.at(-1).title = 'Title B'; }).then(() => 'ok', e => `${e.name}: ${e.message}`); });
        await page.waitForTimeout(1600);
        const mid = await lastAuto(ev);
        const b = await ev(() => window.__b);
        await page.waitForTimeout(1500);
        const end = await lastAuto(ev), file = await ev(() => M.serverFiles.chatA[0].chat_metadata.savePoint.mem.scenes.at(-1).title);
        ok(mid === 'Title A' && end === 'Title A' && file === 'Title A' && !/^ok/.test(b), `${how === 'lost' ? '3' : '3b'}. AUTO는 확인된 저장(A)만: ${how === 'lost' ? '응답 끊긴 B' : 'B가 응답을 기다리는 사이 A 타이머 실행, B는 거절'} (${JSON.stringify({ mid, end, file })}, ${b.slice(0, 20)})`);
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
