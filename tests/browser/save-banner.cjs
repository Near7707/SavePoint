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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.goto(`http://localhost:${srv.address().port}/`);
    await page.waitForFunction(() => !!globalThis.__savePoint);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const sleep = ms => page.waitForTimeout(ms);
    const banner = () => ev(() => { const b = document.getElementById('sp_save_banner'); return b ? { shown: !b.hidden, text: b.textContent, theme: b.getAttribute('data-theme') } : { shown: false, text: '' }; });

    // 1. a quick save shows the game-style banner above the chat, in the window's theme
    await ev(() => { M.settings.savePoint.check = false; M.settings.savePoint.auto = false; M.settings.savePoint.theme = 'eggpet'; M.add(30); M.delay = 900; });
    const p1 = ev(() => __savePoint.handle('run'));
    await sleep(300);
    let r = await banner();
    ok(r.shown && r.text.includes('저장 중입니다') && r.text.includes('다른 채팅방으로 이동하면 저장이 취소돼요') && r.theme === 'eggpet', `1. 저장 중 안내 창 (${r.text.trim()})`);
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'save-banner.png') });
    await p1; await sleep(100);
    r = await banner();
    ok(r.shown && r.text.includes('저장 완료') && r.text.includes('#0–#29'), `1. 끝나면 저장 완료로 바뀜 (${r.text.trim()})`);
    await sleep(3700);
    ok(!(await banner()).shown, '1. 잠시 뒤 사라짐');

    // 2. the banner stays hidden while the SavePoint window is open (it has its own progress)
    await ev(() => { $('#sp_wand').trigger('click'); M.add(6); });
    const p2 = ev(() => __savePoint.handle('run'));
    await sleep(300);
    ok(!(await banner()).shown, '2. SavePoint 창이 열려 있으면 안내 창은 숨김');
    await p2; await ev(() => $('#sp_overlay').trigger($.Event('click', { target: document.getElementById('sp_overlay') })));
    await ev(() => { __savePoint.ui.open = false; $('#sp_overlay').hide(); });
    await sleep(3700);

    // 3. leaving the room mid-save: the notice names the room and what was saved; the room is remembered
    await ev(() => { M.add(60, i => `Long message ${i} ${'words '.repeat(60)}`); M.settings.savePoint.inputChars = 20000; });
    const roomA = await ev(() => ({ chat: M.chat, meta: M.meta, key: JSON.stringify(['ari.png', M.chatId]) }));
    const p3 = ev(() => __savePoint.handle('run').catch(() => {}));
    await page.waitForFunction(() => __savePoint.state().lastIndex >= 40, null, { timeout: 15000 });
    const savedTo = await ev(() => __savePoint.state().lastIndex);
    await ev(async () => { window.__roomA = { chat: M.chat, meta: M.meta }; await M.switchChat('chatB', [], {}); M.add(2); });
    await p3; await sleep(200);
    r = await ev(() => ({ toast: toastr.log.filter(x => x[0] === 'warning').map(x => x.slice(1).join(' ')).pop() || '', all: toastr.log.slice(-4).map(x => x[1]).join(' | '), interrupted: M.settings.savePoint.interrupted }));
    ok(r.toast.includes('방을 나가서 저장을 멈췄어요') && r.toast.includes(`#36–#${savedTo}`) && r.toast.includes('다시 세이브'), `3. 방을 옮기면 어느 방에서 어디까지 저장됐는지 알림 (${r.toast.slice(0, 90)})`);
    ok(!r.all.includes('대화나 채팅방이 바뀌어서'), '3. 옮겨 간 방에서 헷갈리는 취소 문구는 다시 띄우지 않음');
    ok(Object.keys(r.interrupted || {}).length === 1, '3. 멈춘 방을 기억해 둠');
    ok(!(await banner()).shown, '3. 새 방에서는 안내 창이 사라짐');

    // 4. coming back: a notice, a HUD line with a button, cleared after the next save
    await ev(async () => { await M.switchChat('chatA', window.__roomA.chat, window.__roomA.meta); });
    await sleep(200);
    r = await ev(() => toastr.log.at(-1)?.[1] || '');
    ok(r.includes('중간에 멈췄어요') && r.includes(`#${savedTo + 1}부터 미기록`), `4. 돌아오면 이어서 저장하라고 안내 (${r.slice(0, 60)})`);
    await ev(() => { $('#sp_wand').trigger('click'); __savePoint.render(true); });
    r = await ev(() => $('.sp-hud').text());
    ok(r.includes('지난 저장이 방을 옮기면서 중간에 멈췄어요') && r.includes('퀵세이브로 이어서'), '4. 상태 칸에 이어서 저장 버튼');
    await ev(() => { M.delay = 0; });
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => ({ last: __savePoint.state().lastIndex, len: M.chat.length, interrupted: Object.keys(M.settings.savePoint.interrupted || {}).length, hud: $('.sp-hud').text() }));
    ok(r.last === r.len - 1 && r.interrupted === 0 && !r.hud.includes('중간에 멈췄어요'), '4. 이어서 저장하면 안내가 사라짐');

    await browser.close(); srv.close();
    console.log(failures ? `${failures} FAILED` : 'ALL PASS');
    process.exit(failures ? 1 : 0);
})();
