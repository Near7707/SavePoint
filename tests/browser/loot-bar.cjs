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
    for (const t of ['jrpg', 'eggpet', 'consolenight', 'cranelemon', 'st']) {
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
    // 8. a reply that did not link the excerpt says why, in the queue, the toast and the copy report
    r = await ev(() => {
        if (!document.querySelector('.sp-window')?.offsetParent) document.querySelector('#sp_open')?.click();
        __savePoint.handle('tab', 'queue');
        const card = document.querySelector('.sp-queued')?.textContent || '';
        return { card, toast: (toastr.log || []).map(x => x[1]).filter(t => String(t).includes('반영되지 않았어요')).pop() || '', report: __savePoint.reportText(__savePoint.state()) };
    });
    ok(r.card.includes('반영 연결을 찾지 못했어요') && r.card.includes('다음 세이브 때 저널 보충으로 다시 시도해요'), '8. 대기열 카드에 반영 실패 이유와 다시 시도 안내');
    ok(r.toast.includes('반영 연결을 찾지 못했어요') && r.toast.includes('다음 세이브 때 다시 시도해요'), `8. 알림에 첫 번째 이유 (${r.toast.slice(0, 40)})`);
    ok(r.report.includes('[루팅 반영 실패') && r.report.includes('반영 연결을 찾지 못했어요'), '8. 결과 복사에 항목별 이유');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'loot-fail-reason.png') });
    // 9. ↻ retries only that item as a journal supplement, and removes it only after saving
    r = await ev(() => ({ n: (__savePoint.state().lootQueue || []).length, btn: !!document.querySelector('.sp-queued [data-act=loot-retry]'), calls: M.calls.length, records: JSON.stringify(__savePoint.state().mem.records) }));
    ok(r.btn, '9. 기록된 메시지의 실패 항목에 ↻ 다시 반영 버튼');
    await ev(() => { M.supplementLinks = true; });
    await page.click('.sp-queued [data-act=loot-retry]');
    await sleep(600);
    const after = await ev(() => ({ n: (__savePoint.state().lootQueue || []).length, calls: M.calls.length, records: JSON.stringify(__savePoint.state().mem.records), linked: __savePoint.state().mem.scenes.flatMap(s => s.segs.flatMap(g => g.points)).some(p => p.loot?.length) }));
    ok(after.n === r.n - 1 && after.calls === r.calls + 1 && after.linked && after.records === r.records, `9. 그 항목만 한 번 요청해 저널에 보충하고 대기열에서 제거, 현재 상태는 그대로 (${r.n}→${after.n})`);
    await ev(() => { M.supplementLinks = false; });
    // 10. other states never promise an automatic retry they will not do
    await ev(async () => { M.add(1, () => 'The ferry horn sounded across the water.'); const n = M.chat.length - 1; M.chat[n].is_user = false; await __savePoint.addLoot(n, 'The ferry horn sounded'); });
    r = await ev(() => {
        const st = __savePoint.state(), base = st.lootQueue[0], fresh = st.lootQueue.at(-1);
        const view = q => { const div = document.createElement('div'); div.innerHTML = __savePoint.queueHtml({ ...st, lootQueue: [q] }); return div.textContent; };
        return { pending: view({ ...fresh, error: '반영 실패 · AI 응답에서 이 구절의 반영 연결을 찾지 못했어요' }), changed: view({ ...base, id: 'Lc', hash: 'no-longer-matches' }), room: view({ ...base, id: 'Lr', room: 'another-room' }) };
    });
    ok(r.pending.includes('퀵세이브로 반영') && !r.pending.includes('다시 반영'), '10. 미기록 메시지는 퀵세이브로 반영 안내');
    ok(r.changed.includes('다시 담은 뒤') && !r.changed.includes('다시 시도해요'), '10. 원문이 바뀐 항목은 다시 담기 안내, 자동 재시도 약속 없음');
    ok(r.room.includes('다른 방에서 담은 항목') && !r.room.includes('다시 시도해요'), '10. 다른 방 항목은 반영하지 않는다고 안내');
    // 11. when the chat file itself cannot be written, the item keeps its reason on screen
    await ev(async () => { M.failMeta = true; try { await __savePoint.summarize(); } catch {} });
    await sleep(300);
    r = await ev(() => { M.failMeta = false; const q = __savePoint.state().lootQueue || []; const x = q.find(i => i.text === 'The ferry horn sounded'); return { err: x?.error || '', fails: x?.fails || 0 }; });
    ok(r.err.includes('disk full') && r.fails === 1, `11. 파일 저장 실패에도 항목별 이유와 횟수가 남음 (${r.err} · ${r.fails})`);
    // 12. the same for ↻: a failed file write updates that item's reason and count
    await ev(async () => { M.failMeta = false; await __savePoint.handle('tab', 'queue'); });
    r = await ev(() => { const x = (__savePoint.state().lootQueue || []).find(i => i.error && i.msg <= __savePoint.state().lastIndex && document.querySelector(`[data-act=loot-retry][data-id="${i.id}"]`)); return x ? { id: x.id, fails: x.fails || 0 } : null; });
    if (r) {
        await ev(() => { M.supplementLinks = true; M.failMeta = true; });
        await page.click(`[data-act=loot-retry][data-id="${r.id}"]`);
        await sleep(600);
        const after = await ev(id => { M.failMeta = false; M.supplementLinks = false; const x = __savePoint.state().lootQueue.find(i => i.id === id); return x ? { err: x.error, fails: x.fails } : null; }, r.id);
        ok(after && after.err.includes('disk full') && after.fails === r.fails + 1, `12. ↻ 중 파일 저장 실패도 이유·횟수 갱신, 항목 보존 (${after?.fails})`);
    } else ok(false, '12. ↻ 버튼이 있는 실패 항목을 찾지 못함');
    // 13. a re-translated on-screen text is only a warning: ↻ stays available
    r = await ev(() => {
        const st = __savePoint.state(), base = st.lootQueue.find(i => i.msg <= st.lastIndex);
        const real = M.chat[base.msg]; const hadView = real.extra?.display_text;
        real.extra = { ...(real.extra || {}), display_text: 'A newer translation of the same line.' };
        const div = document.createElement('div');
        div.innerHTML = __savePoint.queueHtml({ ...st, lootQueue: [{ ...base, view: true, viewHash: 'translated-earlier', error: '반영 실패 · AI 응답에서 이 구절의 반영 연결을 찾지 못했어요' }] });
        if (hadView === undefined) delete real.extra.display_text; else real.extra.display_text = hadView;
        return { text: div.textContent, retry: !!div.querySelector('[data-act=loot-retry]') };
    });
    ok(r.text.includes('번역문이 바뀜') && r.retry && !r.text.includes('자동으로 반영하지 않아요'), '13. 재번역은 경고만, ↻ 다시 반영 유지');

    await browser.close(); srv.close();
    console.log(failures ? `${failures} FAILED` : 'ALL PASS');
    process.exit(failures ? 1 : 0);
})();
