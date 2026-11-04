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
    const page = await session({ settings: { savePoint: { firstTab: 'main', check: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(() => { M.add(8, i => i === 5 ? 'PROMISE: meet at the old gate tomorrow.' : ''); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);

    // 1. a new install opens on 💠 메인 (STATUS): basis line, scene, open threads, party, folded changes
    await ev(() => $('#sp_wand').trigger('click'));
    let r = await ev(() => ({ tab: $('.sp-tab.sp-active').text(), body: $('.sp-body').text(), hero: $('.sp-st-hero').text(), quest: $('.sp-st-q').text(), party: $('.sp-st-p').text(),
        changes: $('.sp-st-changes > summary').text(), open: $('.sp-st-changes').prop('open'), head: $('.sp-top-r').text().replace(/\s+/g, ' ').trim() }));
    ok(r.tab.includes('메인') && r.body.includes('STATUS') && r.body.includes('마지막 저장 기준 #7'), `1. 처음 여는 탭은 💠 메인, STATUS와 기준 줄 (${r.tab.trim()})`);
    ok(r.hero.includes('SCENE 01') && r.quest.includes('약속') && r.party.includes('Ari'), '1. 장면·진행 중·현재 파티');
    ok(/최근 변화 · 퀵세이브 #0–#7 · \d+개/.test(r.changes) && !r.open, `1. 최근 변화는 접힌 채 제목과 개수 (${r.changes.trim()})`);
    ok(!/EN/.test(r.head) && r.head.includes('⚙'), `1. 상단은 방 이름 · ⚙ · ✕ (EN 없음: ${r.head})`);
    await page.click('.sp-st-changes > summary');
    ok((await ev(() => $('.sp-st-log div').length)) >= 2, '1. 펼치면 바뀐 기록 목록');

    // 2. the loot queue lives in 메인's alert area; the tab shows a red count; the old shortcut opens it
    await ev(async () => { M.add(1, () => 'The ferry horn sounded across the water.'); const n = M.chat.length - 1; M.chat[n].is_user = false; await __savePoint.addLoot(n, 'The ferry horn sounded'); __savePoint.render(true); });
    r = await ev(() => ({ alert: $('details.sp-st-alert summary').text(), badge: $('.sp-tab[data-id="main"] em.sp-em-alert').text(), queueTab: $('.sp-tab[data-id="queue"]').length }));
    ok(r.alert.includes('⏳ 대기열 1') && r.badge === '1' && r.queueTab === 0, '2. 대기열은 메인 알림 칸으로 (탭 숫자 빨간색, 대기열 탭 없음)');
    await ev(() => __savePoint.handle('tab', 'journal'));
    await ev(() => __savePoint.handle('tab', 'queue'));
    r = await ev(() => ({ tab: $('.sp-tab.sp-active').attr('data-id'), open: $('details.sp-st-alert').prop('open'), items: $('details.sp-st-alert .sp-queued').length }));
    ok(r.tab === 'main' && r.open && r.items === 1, '2. 대기열 바로가기는 메인에서 펼쳐서 보여 줌');

    // 3. ⚙ quick settings: same values as the settings panel; summarizer changes wait while saving
    await ev(() => __savePoint.handle('qs'));
    r = await ev(() => ({ panel: $('.sp-qs').length, keys: $('.sp-qs [data-qs]').map((i, e) => e.dataset.qs).get() }));
    ok(r.panel === 1 && ['theme', 'budget', 'auto', 'autoEvery', 'profileId'].every(k => r.keys.includes(k)), `3. 빠른 설정 (${r.keys.join(',')})`);
    await page.fill('.sp-qs [data-qs="budget"]', '9000'); await page.dispatchEvent('.sp-qs [data-qs="budget"]', 'change');
    ok((await ev(() => [__savePoint.settings().budget, $('#sp_settings [data-set="budget"]').val()])).join() === '9000,9000', '3. 주입 상한이 설정 패널과 같은 값으로 바뀜');
    await ev(() => { M.settings.connectionManager = { profiles: [{ id: 'p2', name: 'Other', mode: 'cc' }] }; M.delay = 2500; M.add(3); });
    const running = ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(400);
    await ev(() => { __savePoint.handle('qs'); __savePoint.handle('qs'); });
    await page.selectOption('.sp-qs [data-qs="profileId"]', 'p2');
    r = await ev(() => ({ now: __savePoint.settings().profileId, note: $('.sp-qs').text() }));
    ok(r.now === '' && r.note.includes('다음 저장부터'), '3. 저장 중에 바꾼 요약 AI는 지금 저장에 섞이지 않음');
    await running; await ev(() => { M.delay = 0; });
    ok((await ev(() => __savePoint.settings().profileId)) === 'p2', '3. 저장이 끝나면 적용');
    await ev(() => { __savePoint.settings().profileId = ''; });

    // 4. one language button: 번역 → (translate) → 원문
    r = await ev(() => $('.sp-actions [data-act="lang"], .sp-actions [data-act="translate"]').text().trim());
    ok(r === '🌐 번역', `4. 원문 보기 중에는 🌐 번역 (${r})`);
    await ev(() => __savePoint.handle('lang'));
    await page.waitForTimeout(800);
    r = await ev(() => ({ ko: __savePoint.settings().showKo, label: $('.sp-actions [data-act="lang"], .sp-actions [data-act="translate"]').text().trim() }));
    ok(r.ko && r.label === '🌐 원문', `4. 누르면 번역하고 한국어 보기, 버튼은 🌐 원문 (${r.label})`);
    await ev(() => __savePoint.handle('lang'));
    ok(!(await ev(() => __savePoint.settings().showKo)), '4. 🌐 원문 → 영어 원문 보기');

    // 5. the first-tab setting applies when the window first opens for a room; an open window keeps its tab
    await ev(() => __savePoint.handle('tab', 'party'));
    await ev(() => __savePoint.render(true));
    ok((await ev(() => $('.sp-tab.sp-active').attr('data-id'))) === 'party', '5. 열려 있는 동안에는 보던 탭 유지');

    // 6. (v0.6.38) a failed translation leaves 🌐 원문 usable; filling is a small separate button
    await ev(() => { for (const r of __savePoint.state().mem.records) delete r.ko; });
    await ev(() => { M.throwNext = new Error('translator down'); return __savePoint.handle('lang'); }).catch(() => {});
    await page.waitForTimeout(800);
    r = await ev(() => ({ ko: __savePoint.settings().showKo, main: $('.sp-actions .sp-langbtn').text().trim(), act: $('.sp-actions .sp-langbtn').attr('data-act'), fill: $('.sp-actions .sp-langfill').text().trim(), lit: $('.sp-actions .sp-langbtn').hasClass('sp-on') }));
    ok(r.ko && r.main === '🌐 원문' && r.act === 'lang', `6. 번역이 실패해도 주 버튼은 🌐 원문 (${r.main})`);
    ok(r.fill === '' && r.lit, `6. (v0.6.55) +N 숫자 없음, 한국어 보기 중이면 번역 버튼이 켜진 색 (${r.fill})`);
    await ev(() => __savePoint.handle('lang'));
    ok(!(await ev(() => __savePoint.settings().showKo)), '6. 원문으로 돌아감');

    // 7. (v0.6.38) each room keeps the tab it was left on
    const roomA = await ev(() => ({ id: M.chatId, chat: M.chat, meta: M.meta }));
    await ev(() => __savePoint.handle('tab', 'party'));
    await ev(() => $('#sp_overlay').length && __savePoint.handle('close'));
    await ev(() => M.switchChat('roomB', [], {}));
    await ev(() => $('#sp_wand').trigger('click'));
    const tabB = await ev(() => $('.sp-tab.sp-active').attr('data-id'));
    await ev(a => M.switchChat(a.id, a.chat, a.meta), roomA);
    await ev(() => $('#sp_wand').trigger('click'));
    r = await ev(() => $('.sp-tab.sp-active').attr('data-id'));
    ok(tabB === 'main' && r === 'party', `7. B방은 처음이라 메인, A방은 고른 파티 탭 그대로 (B ${tabB}, A ${r})`);
    await ev(() => __savePoint.handle('tab', 'main'));

    // 8. (v0.6.38) a loot supplement for an older message in the same save keeps 최근 변화 and its range
    await ev(async () => { const n = 2; M.chat[n].is_user = false; await __savePoint.addLoot(n, M.chat[n].mes.slice(0, 12)); M.supplementLinks = true; M.add(4, i => `Fresh talk ${i}.`); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    await ev(() => { M.supplementLinks = false; __savePoint.render(true); });
    r = await ev(() => ({ last: __savePoint.state().lastIndex, lr: __savePoint.state().lastRecord, changes: $('.sp-st-changes > summary').text(), hud: $('.sp-auto-line').text() }));
    ok(r.lr.run && r.lr.kind === 'quicksave' && r.lr.to === r.last && r.lr.supplement?.from === 2, `8. 마지막 기록은 새 범위 유지, 루팅 보충은 따로 (${JSON.stringify(r.lr)})`);
    ok(/최근 변화 · 퀵세이브/.test(r.changes), `8. 최근 변화가 사라지지 않음 (${r.changes.trim()})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
