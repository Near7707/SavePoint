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
    const files = page => page.evaluate(() => Object.fromEntries(M.files));
    const page = await session();
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(() => { M.settings.savePoint.check = false; M.settings.savePoint.hudOpen = true; M.settings.savePoint.keepRecent = 4; });
    const hidden = () => ev(() => M.chat.map(m => m.is_system ? 'H' : '.').join(''));
    // A SillyTavern-like chat: the message template and one .mes per message, each with a "…" menu.
    const draw = () => ev(() => {
        if (!document.getElementById('message_template')) document.body.insertAdjacentHTML('beforeend', '<div id="message_template" hidden><div class="mes"><div class="ch_name"><span class="name_text"></span></div><div class="mes_buttons"><div class="extraMesButtons"></div></div></div></div>');
        const chat = document.getElementById('chat');
        chat.innerHTML = M.chat.map((m, i) => `<div class="mes" mesid="${i}" is_system="${m.is_system}"><div class="ch_name"><span class="name_text">${m.name}</span></div><div class="mes_buttons"><div class="extraMesButtons"></div></div></div>`).join('');
        __savePoint.paintKeep();
    });
    const click = i => ev(i => { document.querySelector(`#chat .mes[mesid="${i}"] .sp-keep-btn`).click(); }, i);

    await ev(() => M.add(12));
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    await draw();
    ok((await hidden()) === 'HHHHHHHH....', '0. 자동 하이드로 #0–#7 숨김');
    let r = await ev(() => ({ tpl: !!document.querySelector('#message_template .sp-keep-btn'), all: [...document.querySelectorAll('#chat .mes')].every(el => el.querySelector('.extraMesButtons .sp-keep-btn')) }));
    ok(r.tpl && r.all, '1. … 메뉴(새 메시지 틀과 보이는 메시지 모두)에 🔖 버튼');

    // 2. turning it on shows the message at once, marks it, and the window shows the count
    await ev(() => { M.chat[3].swipe_info = [{ extra: {} }, { extra: {} }]; });
    const saves0 = await ev(() => M.saves || 0);
    await click(3); await page.waitForTimeout(300);
    await ev(() => $('#sp_wand').trigger('click'));
    r = { hid: await hidden(), mark: await ev(() => !!document.querySelector('#chat .mes[mesid="3"] .name_text + .sp-keep-mark')), on: await ev(() => document.querySelector('#chat .mes[mesid="3"] .sp-keep-btn').classList.contains('sp-on')),
        swipes: await ev(() => M.chat[3].swipe_info.every(x => x.extra.savepointKeep === 1)), hud: await ev(() => document.querySelector('#sp_overlay .sp-hud').textContent.includes('🔖 원문 유지 1개')), saved: (await ev(() => M.saves || 0)) > saves0 };
    ok(r.hid === 'HHH.HHHH....' && r.mark && r.on && r.swipes && r.hud && r.saved, `2. 켜면 바로 보이고 🔖 표시·상태칸 개수·파일 저장 (${JSON.stringify(r)})`);
    await ev(() => $('#sp_overlay').hide());

    // 3. a save keeps it shown
    await ev(() => { M.add(2); return __savePoint.handle('run'); });
    await page.waitForTimeout(900); await draw();
    ok((await hidden()).startsWith('HHH.HHHHHH'), '3. 다음 세이브에도 보임');

    // 4. a swipe to a new reply brings an extra without the mark; the mark comes back
    await ev(() => { const m = M.chat[3]; m.swipe_info.push({ extra: {} }); m.extra = {}; return M.eventSource.emit('message_swiped', 3); });
    await page.waitForTimeout(200); await draw();
    r = { keep: await ev(() => M.chat[3].extra.savepointKeep), hid: await hidden() };
    ok(r.keep === 1 && r.hid[3] === '.', `4. 스와이프해도 원문 유지 (${JSON.stringify(r)})`);

    // 5. off in auto mode: hidden again at once, the mark goes
    await click(3); await page.waitForTimeout(300);
    r = { hid: await hidden(), mark: await ev(() => !!document.querySelector('#chat .mes[mesid="3"] .sp-keep-mark')), swipes: await ev(() => M.chat[3].swipe_info.some(x => x.extra.savepointKeep)) };
    ok(r.hid[3] === 'H' && !r.mark && !r.swipes, `5. 자동 모드에서 끄면 바로 숨김, 표시 사라짐 (${JSON.stringify(r)})`);

    // 6. a failed write takes both back
    await ev(() => { M.chat[5].swipe_info = [{ extra: {} }]; M.failOnce = true; });
    await click(5); await page.waitForTimeout(300);
    r = { hid: await hidden(), keep: await ev(() => !!M.chat[5].extra.savepointKeep), swipe: await ev(() => !!M.chat[5].swipe_info[0].extra.savepointKeep), mark: await ev(() => !!document.querySelector('#chat .mes[mesid="5"] .sp-keep-mark')), err: await ev(() => toastr.log.some(([k]) => k === 'error')) };
    ok(r.hid[5] === 'H' && !r.keep && !r.swipe && !r.mark && r.err, `6. 저장 실패 → 🔖와 숨김 모두 원래대로 (${JSON.stringify(r)})`);

    // 7. manual mode: left out of the 👻 count, turning it off waits for the next 👻
    await ev(() => { const sel = document.querySelector('#sp_settings [data-set=hideMode]'); sel.value = 'manual'; $(sel).trigger('change'); });
    await click(6); await page.waitForTimeout(300);
    await ev(() => $('#sp_wand').trigger('click'));
    const count = () => ev(() => document.querySelector('#sp_overlay [data-act="hide-now"]')?.textContent || '');
    r = { hid: await hidden(), btn: await count() };
    ok(r.hid[6] === '.' && r.btn === '👻 하이드 0', `7. 수동: 켜면 보이고, 숨길 게 없으면 👻 0 (${JSON.stringify(r)})`);
    await click(6); await page.waitForTimeout(300); await ev(() => __savePoint.render(true));
    r = { hid: await hidden(), btn: await count() };
    ok(r.hid[6] === '.' && r.btn === '👻 하이드 1', `7. 수동: 끄면 다음 👻까지 보이고 개수에 들어감 (${JSON.stringify(r)})`);
    await ev(() => $('#sp_overlay').hide());

    // 8. the off option says what it does
    ok(await ev(() => [...document.querySelectorAll('#sp_settings [data-set=hideMode] option')].some(o => o.value === 'off' && o.textContent === '끔 · 숨긴 원문 다시 표시')), '8. 끔 설명: 숨긴 원문 다시 표시');

    // 9. v0.6.57: the 🔖 list in the status area — go to, turn one off, turn all off (manual mode)
    await click(2); await click(3); await click(6); await page.waitForTimeout(300);
    await ev(() => $('#sp_wand').trigger('click'));
    await ev(() => __savePoint.handle('keep-list'));
    r = await ev(() => ({ rows: $('.sp-keep-row').map((i, e) => e.querySelector('b').textContent).get(), all: $('[data-act="keep-off-all"]').text() }));
    ok(r.rows.join() === '#2,#3,#6' && r.all.includes('3'), `9. 🔖 목록: 번호·이동·해제·모두 해제 (${JSON.stringify(r)})`);
    await ev(() => __savePoint.handle('keep-off', '3'));
    await page.waitForTimeout(300);
    r = await ev(() => ({ rows: $('.sp-keep-row').length, kept3: !!M.chat[3].extra.savepointKeep, mark: !!document.querySelector('#chat .mes[mesid="3"] .sp-keep-mark') }));
    ok(r.rows === 2 && !r.kept3 && !r.mark, `9. 해제 하나: 목록에서 빠지고 메시지 표시도 사라짐 (${JSON.stringify(r)})`);
    await ev(() => __savePoint.handle('keep-go', '6'));
    r = await ev(() => ({ closed: !$('#sp_overlay').is(':visible'), focus: document.querySelector('#chat .mes[mesid="6"]').classList.contains('sp-focus') }));
    ok(r.closed && r.focus, `9. 이동: 창을 닫고 그 메시지로 감 (${JSON.stringify(r)})`);
    await ev(() => $('#sp_wand').trigger('click'));
    await ev(() => { M.confirm = false; });
    await ev(() => __savePoint.handle('keep-off-all')); await page.waitForTimeout(200);
    ok((await ev(() => M.chat.filter(m => m.extra?.savepointKeep).length)) === 2, '9. 모두 해제: 확인창에서 취소하면 그대로');
    await ev(() => { M.confirm = true; });
    await ev(() => __savePoint.handle('keep-off-all')); await page.waitForTimeout(300);
    r = await ev(() => ({ left: M.chat.filter(m => m.extra?.savepointKeep || m.swipe_info?.some(x => x?.extra?.savepointKeep)).length, list: $('.sp-keeplist').length, hud: $('.sp-hud').text().includes('원문 유지'), popup: M.popups.at(-1) }));
    ok(!r.left && !r.list && !r.hud && /모두 해제/.test(r.popup || ''), `9. 모두 해제: 확인 후 전부 꺼짐 (${JSON.stringify(r)})`);
    await ev(() => $('#sp_overlay').hide());

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
