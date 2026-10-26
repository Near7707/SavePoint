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

    // A chat drawn like SillyTavern's: #2 is shown through a translator (display_text), #1 and #3 are the user.
    await ev(() => {
        M.add(5);
        M.chat[2].mes = 'The guide handed over a small brass key at the door. She promised to come back tomorrow.';
        M.chat[2].extra.display_text = '안내인은 문 앞에서 작은 놋쇠 열쇠를 건넸다. 그녀는 내일 다시 오겠다고 약속했다.';
        M.chat[4].mes = 'The lantern flickered while the rain kept falling on the roof.';
        const box = document.getElementById('chat');
        box.innerHTML = M.chat.map((m, i) => `<div class="mes" mesid="${i}"><div class="mes_text">${m.extra.display_text || m.mes}</div></div>`).join('');
        document.body.insertAdjacentHTML('beforeend', '<div id="send_form"><div id="leftSendForm"><div id="options_button">≡</div><div id="extensionsMenuButton">✦</div></div><textarea id="send_textarea"></textarea></div>');
        __savePoint.installLootBar(); __savePoint.installLootBar();
    });
    let r = await ev(() => ({ n: document.querySelectorAll('#sp_loot_bar').length, after: document.getElementById('sp_loot_bar')?.previousElementSibling?.id }));
    ok(r.n === 1 && r.after === 'extensionsMenuButton', '1. 채팅창 지팡이 옆에 💎 하나');

    // 2. no selection: latest AI reply in full, ◀ ▶ skip user messages
    await page.click('#sp_loot_bar');
    r = await ev(() => ({ head: document.querySelector('#sp_loot_dialog .sp-loot-head b')?.textContent, text: document.querySelector('#sp_loot_dialog textarea').value }));
    ok(r.head === '#4' && r.text.startsWith('The lantern'), '2. 선택 없이 누르면 가장 최근 AI 답변 전체');
    await page.click('#sp_loot_dialog .sp-loot-prev');
    r = await ev(() => ({ head: document.querySelector('#sp_loot_dialog .sp-loot-head b').textContent, text: document.querySelector('#sp_loot_dialog textarea').value }));
    ok(r.head === '#2' && r.text.startsWith('The guide'), '2. ◀는 사용자 메시지를 건너뛰고 이전 AI 답변으로 (원문 표시)');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'loot-full.png') });
    await page.click('#sp_loot_dialog .sp-loot-cancel');

    // 3. a phrase selected in the on-screen translation, then 💎 (real mouse press)
    const selectIn = (i, phrase, j = i, phrase2 = phrase) => ev(([i, phrase, j, phrase2]) => {
        const node = k => document.querySelector(`.mes[mesid="${k}"] .mes_text`).firstChild;
        const a = node(i), b = node(j), range = document.createRange();
        range.setStart(a, a.data.indexOf(phrase)); range.setEnd(b, b.data.indexOf(phrase2) + phrase2.length);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }, [i, phrase, j, phrase2]);
    await selectIn(2, '작은 놋쇠 열쇠를 건넸다');
    await sleep(50);
    await page.click('#sp_loot_bar');
    r = await ev(() => ({ head: document.querySelector('#sp_loot_dialog .sp-loot-head b')?.textContent, text: document.querySelector('#sp_loot_dialog textarea').value, nav: !!document.querySelector('#sp_loot_dialog .sp-loot-prev') }));
    ok(r.head === '#2' && r.text === '작은 놋쇠 열쇠를 건넸다' && !r.nav, '3. 드래그한 구절이 있으면 그 메시지·구절로 열림');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'loot-selection.png') });
    r = await ev(() => [...document.querySelectorAll('#sp_loot_dialog .sp-tab')].map(t => [t.textContent.trim(), t.classList.contains('sp-active')]));
    ok(r.length === 2 && r[0][1] && !r[1][1], '3. 드래그 루팅이면 [선택한 구절 | 원문 전체] 탭, 선택 탭이 먼저');
    await page.click('#sp_loot_dialog .sp-tab[data-tab="full"]');
    r = await ev(() => ({ head: document.querySelector('#sp_loot_dialog .sp-loot-head b').textContent, text: document.querySelector('#sp_loot_dialog textarea').value, nav: !!document.querySelector('#sp_loot_dialog .sp-loot-prev') }));
    ok(r.head === '#2' && r.text.startsWith('The guide') && r.nav, '3. 원문 전체 탭은 선택한 메시지의 원문 전체 (◀ ▶ 있음)');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'loot-full-tab.png') });
    await page.click('#sp_loot_dialog .sp-tab[data-tab="sel"]');
    r = await ev(() => document.querySelector('#sp_loot_dialog textarea').value);
    ok(r === '작은 놋쇠 열쇠를 건넸다', '3. 선택 탭으로 돌아오면 구절 그대로');
    await ev(() => { document.querySelector('#sp_loot_dialog [name=note]').value = 'key matters'; });
    await page.click('#sp_loot_dialog [type=submit]');
    await sleep(100);
    r = await ev(() => ({ q: __savePoint.state().lootQueue, toast: toastr.log.at(-1)?.[1] || '' }));
    ok(r.q.length === 1 && r.q[0].msg === 2 && r.q[0].view === true && r.q[0].viewHash && r.q[0].note === 'key matters', '3. 번역문 구절로 대기열에 담김 (번역문 표시)');
    ok(r.toast.includes('대기열에 담았어요'), '3. 짧은 알림');

    // 4. a selection across #0..#2 (with the user's #1 between) is split per AI message
    await selectIn(0, 'from Ari', 2, '그녀는 내일');
    await page.click('#sp_loot_bar');
    r = await ev(() => [...document.querySelectorAll('#sp_loot_dialog .sp-loot-part')].map(p => [p.querySelector('b').textContent, p.querySelector('textarea').value]));
    ok(r.length === 2 && r[0][0] === '#0' && r[1][0] === '#2' && r[1][1].endsWith('그녀는 내일'), `4. 여러 메시지에 걸친 선택은 AI 답변별로 나눔 (${r.map(x => x[0]).join(',')})`);
    await page.click('#sp_loot_dialog [type=submit]');
    await sleep(100);
    r = await ev(() => __savePoint.state().lootQueue.map(x => [x.msg, !!x.view]));
    ok(r.length === 3 && r[1][0] === 0 && !r[1][1] && r[2][0] === 2 && r[2][1], '4. 메시지별로 각각 담김 (#0 원문, #2 번역문)');

    // 5. phones: the tap may clear the selection just before the click; the last one is remembered
    await selectIn(4, 'rain kept falling');
    await sleep(30);
    await ev(() => getSelection().removeAllRanges());
    await sleep(30);
    await page.click('#sp_loot_bar');
    r = await ev(() => document.querySelector('#sp_loot_dialog textarea').value);
    ok(r === 'rain kept falling', '5. 누르는 순간 선택이 풀려도 방금 고른 구절 사용');
    await page.click('#sp_loot_dialog .sp-loot-cancel');
    await sleep(1700);
    await page.click('#sp_loot_bar');
    r = await ev(() => document.querySelector('#sp_loot_dialog .sp-loot-head b').textContent);
    ok(r === '#4' && await ev(() => !!document.querySelector('#sp_loot_dialog .sp-loot-prev')), '5. 오래전에 푼 선택은 쓰지 않음 (전체 보기)');
    await page.click('#sp_loot_dialog .sp-loot-cancel');

    // 5b. submitting from the whole-reply tab queues the whole reply
    await selectIn(4, 'rain kept falling');
    await page.click('#sp_loot_bar');
    await page.click('#sp_loot_dialog .sp-tab[data-tab="full"]');
    await page.click('#sp_loot_dialog [type=submit]');
    await sleep(100);
    r = await ev(() => __savePoint.state().lootQueue.at(-1));
    ok(r.msg === 4 && r.text.startsWith('The lantern flickered') && !r.view, '5b. 원문 전체 탭에서 담으면 전체 원문으로 담김');

    // 5c. the dialog wears the status window's theme
    for (const t of ['jrpg', 'eggpet', 'consolenight', 'st']) {
        await ev(t => { M.settings.savePoint.theme = t; }, t);
        await selectIn(2, '작은 놋쇠 열쇠를 건넸다');
        await page.click('#sp_loot_bar');
        r = await ev(() => { const d = document.getElementById('sp_loot_dialog'); return { theme: d.getAttribute('data-theme'), win: d.classList.contains('sp-window'), bg: getComputedStyle(d).backgroundImage + getComputedStyle(d).backgroundColor }; });
        ok(r.theme === t && r.win, `5c. 루팅 창이 상태창 테마를 따름 (${t})`);
        if (SHOTS) await page.screenshot({ path: path.join(OUT, `loot-theme-${t}.png`) });
        await page.click('#sp_loot_dialog .sp-loot-cancel');
    }
    await ev(() => { M.settings.savePoint.theme = 'jrpg'; });

    // 6. a selection only in a user message is not taken
    await selectIn(1, 'from Me');
    await page.click('#sp_loot_bar');
    r = await ev(() => ({ open: !!document.querySelector('#sp_loot_dialog'), toast: toastr.log.at(-1)?.[1] || '' }));
    ok(!r.open && r.toast.includes('AI 답변에서 골라'), '6. 사용자 메시지만 고르면 안내');

    // 7. a changed translation is flagged; the save request says which excerpts are translations
    r = await ev(() => {
        const keep = M.chat[2].extra.display_text;
        M.chat[2].extra.display_text = '안내인은 문 앞에서 작은 놋쇠 열쇠를 주었다.';
        const html = __savePoint.queueHtml(__savePoint.state());
        M.chat[2].extra.display_text = keep;
        return html;
    });
    ok(r.includes('번역문이 바뀜'), '7. 번역문이 바뀌면 대기열에 표시');
    await ev(() => { M.settings.savePoint.check = false; __savePoint.handle('run'); });
    await sleep(900);
    r = await ev(() => M.calls.some(p => p.includes('"excerpt_is_translation":true') && p.includes('translation wording is only a pointer')));
    ok(r, '7. 세이브 요청에 번역문 구절임을 알림');

    await browser.close(); srv.close();
    console.log(failures ? `${failures} FAILED` : 'ALL PASS');
    process.exit(failures ? 1 : 0);
})();
