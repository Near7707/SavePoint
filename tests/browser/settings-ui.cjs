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


    // Use the real flex orders: DOM placement by itself would put an unordered gem first.
    await ev(() => {
        M.add(5);
        M.settings.savePoint.auto = false; M.settings.savePoint.check = false;
        document.body.insertAdjacentHTML('beforeend', '<style>#leftSendForm{display:flex;width:120px}#options_button{order:2;width:32px;height:32px}#extensionsMenuButton{order:4;width:32px;height:32px}</style><div id="send_form"><div id="leftSendForm"><div id="options_button">☰</div><div id="extensionsMenuButton">🪄</div></div></div>');
        __savePoint.installLootBar(); __savePoint.installLootBar();
    });
    let r = await ev(() => {
        const rect = id => document.getElementById(id).getBoundingClientRect();
        return { n: document.querySelectorAll('#sp_loot_bar').length, good: rect('options_button').right <= rect('extensionsMenuButton').left && rect('extensionsMenuButton').right <= rect('sp_loot_bar').left, aligned: Math.abs((rect('sp_loot_bar').top + rect('sp_loot_bar').bottom) - (rect('extensionsMenuButton').top + rect('extensionsMenuButton').bottom)) <= 2, pill: getComputedStyle(document.getElementById('sp_loot_bar')).borderRadius === '999px' && getComputedStyle(document.getElementById('sp_loot_bar')).backgroundColor !== 'rgba(0, 0, 0, 0)' };
    });
    ok(r.n === 1 && r.good && r.aligned && r.pill, 'flex order가 있는 채팅창에서도 ☰ → 🪄 → 💎 정렬, 💎는 옅은 바탕의 버튼형');
    r = await ev(() => [...document.querySelectorAll('[data-settings-group]')].map(d => [d.dataset.settingsGroup, d.open]));
    ok(r.length === 5 && r.filter(x => x[1]).map(x => x[0]).join() === 'connection', '첫 화면은 5개 묶음 중 연결만 펼침');
    await page.click('[data-settings-group=injection] > summary');
    r = await ev(() => ({ marks: [...document.querySelectorAll('#sp_settings [data-reset-key]')].filter(b => !b.hidden).length, groupBtn: getComputedStyle(document.querySelector('[data-settings-group=injection] .sp-group-reset')).display, badge: document.querySelector('[data-changed-group=injection]').textContent, text: document.getElementById('sp_settings').textContent }));
    ok(r.marks === 0 && r.groupBtn === 'none' && r.badge === '' && !r.text.includes('기본값 '), '바꾼 설정이 없으면 기본값 안내·되돌리기 버튼이 하나도 안 보임');
    await page.fill('[data-set=budget]', '9200');
    r = await ev(() => { const b = document.querySelector('[data-reset-key=budget]'); return { summary: document.querySelector('[data-settings-summary=injection]').textContent, shown: !b.hidden, title: b.title, badge: document.querySelector('[data-changed-group=injection]').textContent, groupBtn: getComputedStyle(document.querySelector('[data-settings-group=injection] .sp-group-reset')).display }; });
    ok(r.summary.includes('9,200') && r.shown && r.title.includes('6,000') && r.badge === '변경 1' && r.groupBtn !== 'none', '바꾼 칸에만 ↺ (툴팁에 기본값), 묶음에 "변경 1"과 되돌리기 버튼');
    await page.click('[data-reset-key=budget]');
    r = await ev(() => ({ budget: M.settings.savePoint.budget, hidden: document.querySelector('[data-reset-key=budget]').hidden, badge: document.querySelector('[data-changed-group=injection]').textContent }));
    ok(r.budget === 6000 && r.hidden && r.badge === '', '↺를 누르면 그 칸만 기본값으로, 표시도 사라짐');
    await page.fill('[data-set=budget]', '9200');
    await page.click('[data-settings-group=recording] > summary');
    await page.fill('[data-set=guide]', 'Custom guide.');
    r = await ev(() => ({ shown: !document.querySelector('[data-reset-key=guide]').hidden, title: document.querySelector('[data-reset-key=guide]').title }));
    ok(r.shown && r.title.includes('기본 지침'), '기록 지침도 바꿨을 때만 ↺ 기본 지침');
    await page.click('[data-reset-key=guide]');
    await page.click('[data-settings-group=recording] > summary');
    await ev(() => __savePoint.handle('run'));
    await ev(() => __savePoint.addLoot(2, M.chat[2].mes, 'keep this note'));
    await ev(() => {
        M.settings.savePoint.localSaves.reviewMarker = { id: 'reviewMarker', mem: { note: 'keep' } };
        M.settings.savePoint.slotCache.push({ id: 'reviewMarker' });
        window.beforeReset = JSON.stringify({mem: __savePoint.state().mem, queue: __savePoint.state().lootQueue, local: M.settings.savePoint.localSaves, slots: M.settings.savePoint.slotCache});
        window.callsBeforeReset = M.calls.length;
    });
    await page.click('[data-reset-group=injection]');
    r = await ev(() => ({ budget: M.settings.savePoint.budget, other: M.settings.savePoint.auto, calls: M.calls.length === callsBeforeReset, kept: beforeReset === JSON.stringify({mem: __savePoint.state().mem, queue: __savePoint.state().lootQueue, local: M.settings.savePoint.localSaves, slots: M.settings.savePoint.slotCache}) }));
    ok(r.budget === 6000 && r.other === false && r.calls && r.kept, '묶음 복원은 해당 설정만 변경, 기억·대기열·세이브 유지, AI 호출 없음');
    await page.click('[data-settings-group=connection] > summary');
    await sleep(50);
    const saved = await ev(() => structuredClone(M.settings));
    const second = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await second.addInitScript(s => window.__presetSettings = s, saved);
    await second.goto(`http://localhost:${srv.address().port}/`);
    await second.waitForFunction(() => !!globalThis.__savePoint);
    r = await second.evaluate(() => ({ c: document.querySelector('[data-settings-group=connection]').open, i: document.querySelector('[data-settings-group=injection]').open }));
    ok(!r.c && r.i, '새 세션에서도 묶음 펼침 상태 유지');
    await second.close();
    await page.click('#sp_open');
    r = await ev(() => ({ over: document.querySelector('.sp-tab-nav').classList.contains('sp-overflow'), prev: document.querySelector('[data-tab-scroll=prev]').disabled }));
    ok(r.over && r.prev, '모바일 폭에서 화살표 표시, 처음에는 왼쪽 비활성');
    await page.click('[data-tab-scroll=next]'); await sleep(500);
    ok(await ev(() => document.querySelector('.sp-tab-nav .sp-tabs').scrollLeft) > 0, '오른쪽 화살표로 뒤쪽 탭에 접근');
    await page.locator('.sp-tab-nav .sp-tabs').hover(); await page.mouse.wheel(0, 600); await sleep(150);
    await page.click('.sp-tab-nav [data-id=inject]');
    r = await ev(() => ({ tab: __savePoint.ui.tab, rect: (() => { const a=document.querySelector('.sp-tab-nav .sp-active').getBoundingClientRect(), b=document.querySelector('.sp-tab-nav .sp-tabs').getBoundingClientRect(); return a.left>=b.left-1 && a.right<=b.right+1; })() }));
    ok(r.tab === 'inject' && r.rect, '마지막 주입 탭 선택 가능, 선택한 탭은 화면 안에 유지');
    await page.setViewportSize({width: 1280, height: 900}); await sleep(150);
    // Force overflow at desktop width by narrowing only the extension window.
    await page.addStyleTag({content: '#sp_overlay .sp-window {width:440px}'}); await sleep(100);
    await ev(() => { const t=document.querySelector('.sp-tab-nav .sp-tabs');t.scrollLeft=0; });
    await page.locator('.sp-tab-nav .sp-tabs').hover(); await page.mouse.wheel(0, 180); await sleep(100);
    ok(await ev(() => document.querySelector('.sp-tab-nav .sp-tabs').scrollLeft) > 0, 'PC 마우스 세로 휠로 탭을 좌우 이동');
    await page.addStyleTag({content:'#sp_overlay .sp-window {width:1100px}'}); await sleep(150);
    ok(await ev(() => !document.querySelector('.sp-tab-nav').classList.contains('sp-overflow')), '탭이 모두 들어가는 폭으로 넓히면 화살표 숨김');
    await page.setViewportSize({width:390,height:844});
    await page.addStyleTag({content:'#sp_overlay .sp-window {width:100vw}'});
    await ev(() => __savePoint.render(true)); await sleep(100);
    await page.screenshot({path:'/tmp/savepoint-ui-mobile.png'});
    await browser.close(); srv.close();
    console.log(failures ? `${failures} FAILED` : 'ALL PASS');
    process.exit(failures ? 1 : 0);
})();
