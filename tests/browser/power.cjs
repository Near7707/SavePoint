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

// v0.6.75: SavePoint on/off as a power button at the top of ⚙ 빠른 설정 (켜짐/꺼짐, ⏻ ON/OFF, colour only),
// 퀘스트 수락 wording, 🔶 하이드 제외.
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, askResume: false, keepRecent: 2 } }; });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
    await page.waitForTimeout(300);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    await ev(() => { M.add(12); return __savePoint.handle('run'); });
    await wait(1500);
    await ev(() => $('#sp_wand').trigger('click'));
    await wait(200);
    await ev(() => __savePoint.handle('qs'));
    await wait(200);
    const look = () => ev(() => { const p = document.querySelector('#sp_overlay .sp-qs .sp-power'), b = p?.querySelector('.sp-power-btn');
        return { first: p && p.previousElementSibling?.classList.contains('sp-qs-h'), cls: p?.className, text: p?.querySelector('.sp-power-t')?.textContent, btn: b?.textContent,
            bg: b && getComputedStyle(b).backgroundColor, shadow: b && getComputedStyle(b).boxShadow, h: p && Math.round(p.getBoundingClientRect().height),
            enabled: M.settings.savePoint.enabled, box: document.querySelector('#sp_settings [data-set=enabled]')?.checked,
            hid: M.chat.map(m => m.is_system ? 'H' : '.').join(''), prompt: M.extPrompt ?? null }; });
    let on = await look();
    ok(on.first && on.cls.includes('sp-on') && on.text === 'SavePoint 켜짐' && on.btn === '⏻ ON' && on.enabled && on.box, `1. 빠른 설정 맨 위 전원 버튼: 켜짐 · ⏻ ON (${JSON.stringify(on)})`);
    ok(on.h <= 50 && on.shadow === 'none', `1. 한 줄 높이, 그림자 없음 (${on.h}px, ${on.shadow})`);
    await ev(() => __savePoint.handle('power'));
    await wait(500);
    let off = await look();
    ok(off.cls.includes('sp-off') && off.text === 'SavePoint 꺼짐' && off.btn === '⏻ OFF' && !off.enabled && off.box === false, `2. 누르면 꺼짐 · ⏻ OFF, 전체 설정의 사용도 꺼짐 (${JSON.stringify(off)})`);
    ok(off.bg !== on.bg && off.shadow === 'none', `2. 켜짐/꺼짐은 색으로만 구분 (${on.bg} → ${off.bg})`);
    ok(off.hid === on.hid && on.hid.includes('H'), `2. 꺼도 이미 숨긴 원문은 그대로 (${off.hid})`);
    await ev(() => __savePoint.handle('power'));
    await wait(500);
    const back = await look();
    ok(back.cls.includes('sp-on') && back.btn === '⏻ ON' && back.enabled && back.box, '3. 다시 누르면 켜짐');
    // 3b. v0.6.79 (review P3): no skin's hover glow reaches the button (neon had one), on and off.
    const themes = await ev(() => [...document.querySelectorAll('#sp_settings [data-set=theme] option')].map(o => o.value));
    const glow = [];
    for (const state of ['on', 'off']) {
        if (state === 'off') { await ev(() => __savePoint.handle('power')); await wait(300); }
        for (const t of themes) {
            await ev(t => document.querySelector('#sp_overlay .sp-window').setAttribute('data-theme', t), t);
            await page.mouse.move(0, 0);
            await page.hover('#sp_overlay .sp-qs .sp-power-btn');
            const sh = await ev(() => getComputedStyle(document.querySelector('#sp_overlay .sp-qs .sp-power-btn')).boxShadow);
            if (sh !== 'none') glow.push(`${t}/${state}: ${sh}`);
        }
    }
    await ev(() => __savePoint.handle('power')); await wait(300);
    await page.mouse.move(0, 0);
    ok(themes.length >= 16 && !glow.length, `3b. 스킨 ${themes.length}개 모두 마우스를 올려도 그림자 없음 (켜짐·꺼짐) ${glow.join(' / ')}`);
    // 4. 퀘스트 수락 wording (quick and full settings)
    const q = await ev(() => { const more = document.querySelector('#sp_overlay .sp-qs details'); if (more) more.open = true;
        return { qs: document.querySelector('#sp_overlay [data-qs=questMode]')?.closest('label')?.querySelector('span')?.textContent,
            opts: [...document.querySelectorAll('#sp_settings [data-set=questMode] option')].map(o => o.textContent), full: document.querySelector('#sp_settings [data-set=questMode]')?.closest('label')?.firstChild?.textContent.trim() }; });
    ok(q.qs === '퀘스트 수락' && q.full === '퀘스트 수락' && q.opts.join('|') === '자동 수락 · 바로 진행 중 목록에|확인 후 수락 · 후보로 모아 수락·거절', `4. 퀘스트 수락 용어 (${JSON.stringify(q)})`);
    // 5. 🔶 하이드 제외: menu button and the mark beside the name
    await ev(() => __savePoint.handle('qs'));
    await ev(() => { M.settings.savePoint.hudOpen = true; __savePoint.render(true);
        if (!document.getElementById('message_template')) document.body.insertAdjacentHTML('beforeend', '<div id="message_template" hidden><div class="mes"><div class="ch_name"><span class="name_text"></span></div><div class="mes_buttons"><div class="extraMesButtons"></div></div></div></div>');
        document.getElementById('chat').innerHTML = M.chat.map((m, i) => `<div class="mes" mesid="${i}" is_system="${m.is_system}"><div class="ch_name"><span class="name_text">${m.name}</span></div><div class="mes_buttons"><div class="extraMesButtons"></div></div></div>`).join('');
        __savePoint.paintKeep(); toastr.log.length = 0; });
    const grey = await ev(() => getComputedStyle(document.querySelector('#chat .mes[mesid="3"] .sp-keep-btn')).filter);
    await ev(() => document.querySelector('#chat .mes[mesid="3"] .sp-keep-btn')?.click());
    await wait(500);
    const k = await ev(() => ({ btn: document.querySelector('#chat .mes[mesid="3"] .sp-keep-btn')?.textContent, title: document.querySelector('#chat .mes[mesid="3"] .sp-keep-btn')?.title,
        mark: document.querySelector('#chat .mes[mesid="3"] .sp-keep-mark')?.textContent, hud: document.querySelector('#sp_overlay .sp-hud')?.textContent || '', toast: toastr.log.map(x => x[1]).join(' | ') }));
    const lit = await ev(() => getComputedStyle(document.querySelector('#chat .mes[mesid="3"] .sp-keep-btn')).filter);
    ok(grey.includes('grayscale') && lit === 'none', `5. 메뉴 버튼은 꺼지면 회색, 켜지면 제 색 (${grey} → ${lit})`);
    ok(k.btn === '🔶' && k.mark === '🔶' && k.title.includes('하이드 제외') && k.hud.includes('🔶 하이드 제외 1개') && k.toast.includes('🔶 하이드 제외') && !/🔖|원문 유지/.test(k.hud + k.toast + k.title), `5. 🔶 하이드 제외 (${JSON.stringify(k).slice(0, 200)})`);
    await browser.close(); srv.close();
    console.log(failures ? failures + ' FAILED' : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
