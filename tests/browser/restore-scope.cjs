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


// v0.6.81 (review of v0.6.76–79 P2-1, P2-3): 🔶 and the carried #0 follow the room's write result: a write
// that may be in the file (it landed, then the re-read failed or the room was blocked) is never taken back
// on the page; only a write that surely failed is (1–4). A change taken back puts back only the marks it set
// that nobody changed since: a message hidden by hand and a translation added while it waited stay (5).
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    async function session({ hideMode = 'off' } = {}) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.addInitScript(h => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: h } }; }, hideMode);
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
    const mine = { name: 'Me', is_user: true, is_system: false, mes: 'Written on this page.', swipe_id: 0, extra: {} };
    const other = { name: 'Me', is_user: true, is_system: false, mes: 'Written on the other device.', swipe_id: 0, extra: {} };
    // The first write of `file` lands; the page changes meanwhile (so it is sent again); then `then` runs
    // before the re-read ('unread': reads fail, 'other': another device adds a message).
    const landThen = (ev, file, then) => ev(([file, then, mine, other]) => {
        M.metaDelay = 400; let n = 0;
        M.beforeChatSave = async name => { if (name === file && ++n === 1) {
            M.readDelayFor = { [file]: 150 };
            setTimeout(() => { M.noStSave = true; M.chat.push(mine); }, 100);
            setTimeout(() => { if (then === 'unread') M.serverError = true; else M.serverFiles[name].push(other); }, 450);
        } };
    }, [file, then, mine, other]);
    const keepMarks = (ev, i) => ev(i => ({ body: !!M.chat[i].extra?.savepointKeep, page: M.chat[i].swipe_info.map(x => !!x.extra?.savepointKeep),
        file: M.serverFiles.chatA[i + 1].swipe_info.map(x => !!x.extra?.savepointKeep) }), i);

    // 1. 🔶 lands, the re-read fails → unconfirmed; the swipes keep their marks on the page, as in the file.
    {
        const { page, ev } = await session();
        await ev(() => { M.chat[3].swipe_info = [{ extra: {} }, { extra: {} }]; M.stSave(); });
        await landThen(ev, 'chatA', 'unread');
        const msg = await ev(() => __savePoint.toggleKeep(3).then(() => 'ok', e => `${e.name}: ${e.message}`));
        const r = await keepMarks(ev, 3);
        ok(/Unconfirmed/.test(msg) && r.body && r.page.every(Boolean) && r.file.every(Boolean), `1. 🔶 확인 못 함: 화면 스와이프 표시도 파일처럼 남음 (${JSON.stringify(r)})`);
        await page.close();
    }
    // 2. 🔶 refused by the server → the message and its swipes are put back.
    {
        const { page, ev } = await session();
        await ev(() => { M.chat[3].swipe_info = [{ extra: {} }, {}]; M.stSave(); M.failOnce = true; });
        const msg = await ev(() => __savePoint.toggleKeep(3).then(() => 'ok', e => `${e.name}: ${e.message}`));
        const r = await ev(() => ({ body: !!M.chat[3].extra?.savepointKeep, swipes: JSON.stringify(M.chat[3].swipe_info) }));
        ok(/취소했어요/.test(msg) && !r.body && r.swipes === '[{"extra":{}},{}]', `2. 🔶 거절: 메시지·스와이프 표시 되돌림 (${r.swipes})`);
        await page.close();
    }
    // 2b. 🔶 refused, but one swipe's mark was changed again while the write was on its way → that swipe
    //     keeps what it has now; the others are put back.
    {
        const { page, ev } = await session();
        await ev(() => { M.chat[3].swipe_info = [{ extra: {} }, { extra: {} }]; M.stSave(); M.metaDelay = 400; M.failOnce = true; });
        await ev(() => { window.__k = __savePoint.toggleKeep(3).then(() => 'ok', e => e.message); });
        await page.waitForTimeout(150);
        await ev(() => { M.chat[3].swipe_info[1].extra.savepointKeep = 7; });
        const msg = await ev(() => window.__k);
        const r = await ev(() => M.chat[3].swipe_info.map(x => x.extra?.savepointKeep ?? null));
        ok(/취소했어요/.test(msg) && r[0] === null && r[1] === 7, `2b. 🔶 거절: 그사이 다시 바뀐 스와이프 표시는 그대로 (${JSON.stringify(r)})`);
        await page.close();
    }
    // 3–4. Continuing in a new room: the new #0 and the memory are kept when the write landed and the room was
    //      then blocked (3); put back when the server refused it (4), except a #0 edited by hand meanwhile (4b) or
    //      one that got anything but SavePoint's own marks meanwhile: a translation, a hide by hand (4c, v0.6.84).
    for (const [n, how] of [[3, 'landed'], [4, 'refused'], [5, 'edited'], [6, 'marked']]) {
        const { page, ev } = await session();
        const qid = await ev(() => __savePoint.listSaves().find(x => x.quick)?.id);
        await ev(() => M.switchChat('chatNew', [{ name: 'Ari', is_user: false, is_system: false, mes: 'Hello! This is the very first greeting.', swipe_id: 0, swipes: ['Hello! This is the very first greeting.'], extra: {} }], {}));
        await page.waitForTimeout(600);
        if (how === 'landed') await landThen(ev, 'chatNew', 'other');
        else if (how === 'refused') await ev(() => { M.failOnce = true; });
        else if (how === 'edited') await ev(() => { M.metaDelay = 400; M.failOnce = true; let n = 0;
            M.beforeChatSave = async () => { if (++n === 1) setTimeout(() => { M.noStSave = true; M.chat[0].mes = 'Edited by hand.'; M.chat[0].swipes = [M.chat[0].mes]; }, 100); }; });
        else await ev(() => { M.metaDelay = 400; M.failOnce = true; let n = 0;
            M.beforeChatSave = async () => { if (++n === 1) setTimeout(() => { M.noStSave = true; M.chat[0].extra.display_text = 'Translated.'; M.chat[0].is_system = true; }, 100); }; });
        await ev(async id => { M.confirm = 1; await __savePoint.handle('load', id); }, qid);
        await page.waitForTimeout(1500);
        const r = await ev(() => ({ page0: M.chat[0].mes, file0: M.serverFiles.chatNew[1].mes, mem: !!__savePoint.state()?.mem?.scenes?.length, tr: M.chat[0].extra?.display_text ?? null, sys: M.chat[0].is_system === true }));
        if (how === 'landed') ok(r.page0 === r.file0 && r.page0 !== 'Hello! This is the very first greeting.' && r.mem, `3. 이어하기가 들어간 뒤 방 막힘: 화면 첫 메시지·기억 = 파일 (${r.page0.slice(0, 20)})`);
        else if (how === 'refused') ok(r.page0 === 'Hello! This is the very first greeting.' && r.file0 === r.page0 && !r.mem, `4. 이어하기 거절: 첫 메시지·기억 되돌림 (${r.page0.slice(0, 20)})`);
        else if (how === 'edited') ok(r.page0 === 'Edited by hand.' && !r.mem, `4b. 이어하기 거절, 그사이 손으로 고친 첫 메시지는 그대로 (${r.page0.slice(0, 20)})`);
        else ok(r.page0 !== 'Hello! This is the very first greeting.' && r.tr === 'Translated.' && r.sys && !r.mem, `4c. 이어하기 거절, 그사이 번역·직접 숨김이 붙은 새 첫 메시지는 그대로 (${JSON.stringify({ tr: r.tr, sys: r.sys })})`);
        await page.close();
    }
    // 5. Hide off: a memory edit waits for its write; meanwhile #8 is hidden by hand and #9 gets a translation
    //    (a new extra object). The write is refused → the edit goes back, #8 stays hidden, #9 keeps its translation.
    //    The change itself hides #2 (as SavePoint does): that goes back. Hide off and auto mode alike.
    for (const mode of ['off', 'auto']) {
        const { page, ev } = await session({ hideMode: mode });
        await ev(() => { M.metaDelay = 400; M.failOnce = true; });
        const before = await ev(() => M.chat.map(m => !!m.is_system));
        await ev(() => { window.__d = __savePoint.transact(() => { __savePoint.state().probe = 'edit'; const m = M.chat[2]; m.is_system = true; m.extra = m.extra || {}; m.extra.savepointHidden = 1; }, { rehide: true }).then(() => 'ok', e => e.message); });
        await page.waitForTimeout(150);
        await ev(() => { M.noStSave = true; M.chat[11].is_system = true; M.chat[10].extra = { ...(M.chat[10].extra || {}), display_text: 'Translated.' }; });
        const msg = await ev(() => window.__d);
        const r = await ev(() => ({ two: [!!M.chat[2].is_system, M.chat[2].extra?.savepointHidden ?? null], hid: M.chat[11].is_system === true, tr: M.chat[10].extra?.display_text ?? null, probe: __savePoint.state().probe ?? null, now: M.chat.map(m => !!m.is_system) }));
        ok(/취소했어요/.test(msg) && r.probe === null, `5(${mode}). 기억 편집은 되돌림`);
        ok(r.hid && r.tr === 'Translated.', `5(${mode}). 그사이 직접 숨긴 메시지·번역은 그대로 (${JSON.stringify({ hid: r.hid, tr: r.tr })})`);
        ok(r.now.slice(0, 11).every((x, i) => x === before[i]) && r.two[1] === null, `5(${mode}). 이번 변경이 숨긴 #2와 나머지 하이드는 변경 전 그대로 (${JSON.stringify(r.two)})`);
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
