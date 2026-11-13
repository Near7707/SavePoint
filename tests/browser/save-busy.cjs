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

// v0.6.90: while SillyTavern makes a reply, the page runs ahead of the file (a continued or swiped message grows on the
// page only). A SavePoint check that meets that difference is 'busy': it writes nothing, blocks nothing, warns nothing,
// and the room is checked again once the reply is done.
// 1. A background save (persistSoon) is reading the file when a continue starts: no warning; after the reply the room is
//    open again without reloading and the save goes through.
// 2. 🔶 during the reply: refused with the "making a reply" reason, nothing written; after the reply it saves.
// 3. Something really foreign in the file stays a block after the reply (another device added a message meanwhile).
// 4. The block says which difference it found: more messages (from #N), a message that differs (#N).
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    async function session({ run = true } = {}) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: 'off' } }; });
        await page.goto(URL);
        await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
        await page.waitForTimeout(300);
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await ev(() => { M.add(12); });
        if (run) { await ev(() => __savePoint.handle('run')); await page.waitForTimeout(1500); }
        await ev(() => { M.saveBodies = []; M.toastLog = toastr.log.length; });
        return { page, ev };
    }
    const keep = (ev, i) => ev(i => __savePoint.toggleKeep(i).then(() => 'ok', e => `${e.name}: ${e.message}`), i);
    const toasts = ev => ev(() => toastr.log.slice(M.toastLog).map(x => String(x.msg ?? x)));
    const msg = t => ({ name: 'Me', is_user: true, is_system: false, mes: t, swipe_id: 0, extra: {} });
    const startReply = ev => ev(() => {
        SillyTavern.getContext().eventSource.emit('generation_started', 'continue', {}, false);
        const m = M.chat.at(-1); M.grow = setInterval(() => { m.mes += ' more'; }, 100);
    });
    const endReply = (ev, save = true) => ev(save => {
        clearInterval(M.grow);
        if (save) M.stSave();
        SillyTavern.getContext().eventSource.emit('generation_ended', M.chat.length);
    }, save);
    const foreign = ev => ev(() => { const f = M.serverFiles.chatA; f.push({ ...JSON.parse(JSON.stringify(f.at(-1))), mes: 'From the other device.' }); });

    // 1.
    {
        const { page, ev } = await session();
        await ev(() => { M.serverReadDelay = 400; __savePoint.adoptPage(); __savePoint.persistSoon(); });
        await page.waitForTimeout(450);
        await startReply(ev);
        await page.waitForTimeout(4500);
        const during = { sends: await ev(() => M.saveBodies.length), warned: (await toasts(ev)).some(x => /화면에 없는/.test(x)) };
        await endReply(ev);
        await page.waitForTimeout(4000);
        const after = await ev(() => ({ sends: M.saveBodies.length, blocked: __savePoint.autoBlocked() }));
        const r = await keep(ev, 5);
        ok(!during.warned && r === 'ok' && after.sends >= 1,
            `1. 백그라운드 저장 확인 중 이어쓰기: 경고·막힘 없음, 답변 뒤 새로고침 없이 저장 (${JSON.stringify(during)} → ${JSON.stringify(after)}, 🔶 ${r})`);
        await page.close();
    }
    // 2.
    {
        const { page, ev } = await session();
        await startReply(ev);
        await page.waitForTimeout(300);
        const r1 = await keep(ev, 5);
        const during = await ev(() => M.saveBodies.length);
        await endReply(ev);
        await page.waitForTimeout(2500);
        const r2 = await keep(ev, 5);
        await page.waitForTimeout(300);
        const f = await ev(() => ({ sends: M.saveBodies.length, k5: !!M.serverFiles.chatA[6].extra?.savepointKeep }));
        ok(/답변을 만드는 중/.test(r1) && during === 0 && r2 === 'ok' && f.k5,
            `2. 답변 중 🔶는 이유를 말하고 저장 안 함, 답변 뒤 🔶 저장 (${r1.slice(0, 50)} / ${r2}, ${JSON.stringify(f)})`);
        await page.close();
    }
    // 3.
    {
        const { page, ev } = await session();
        await startReply(ev);
        await foreign(ev);
        await page.waitForTimeout(300);
        const r1 = await keep(ev, 5);
        await endReply(ev, false);
        await page.waitForTimeout(3500);
        const r2 = await keep(ev, 5);
        const f = await ev(() => ({ n: M.serverFiles.chatA.length - 1, last: M.serverFiles.chatA.at(-1).mes, sends: M.saveBodies.length }));
        ok(/답변을 만드는 중/.test(r1) && /화면에 없는 내용.*파일에 메시지가 더 있어요: #12부터/.test(r2) && f.n === 13 && f.last === 'From the other device.' && f.sends === 0,
            `3. 답변 뒤에도 다른 기기가 더한 메시지는 막음 (${r1.slice(0, 30)} / ${r2.slice(0, 90)}, ${JSON.stringify(f)})`);
        await page.close();
    }
    // 4.
    for (const kind of ['more', 'diff']) {
        const { page, ev } = await session();
        await ev(kind => { const f = M.serverFiles.chatA;
            if (kind === 'more') f.push({ ...JSON.parse(JSON.stringify(f.at(-1))), mes: 'From the other device.' });
            else f[4] = { ...f[4], mes: 'Edited on the other device.' }; }, kind);
        const r = await keep(ev, 5);
        const toast = (await toasts(ev)).join(' | ');
        const want = kind === 'more' ? /파일에 메시지가 더 있어요: #12부터/ : /메시지 #3의 내용이 화면과 달라요/;
        ok(want.test(r), `4. 막은 이유 표시 (${kind}): ${r.slice(0, 110)}`);
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
