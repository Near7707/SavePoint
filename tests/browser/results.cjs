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
    await ev(() => { M.settings.savePoint.check = false; M.settings.savePoint.questMode = 'auto'; M.settings.savePoint.hideMode = 'off'; });
    const banner = () => ev(() => { const b = document.getElementById('sp_save_banner'); return { shown: !b.hidden, title: b.querySelector('.sp-sb-title').textContent, sub: b.querySelector('.sp-sb-sub').textContent,
        news: b.querySelector('.sp-sb-news').hidden ? '' : b.querySelector('.sp-sb-news').textContent, close: !b.querySelector('.sp-sb-close').hidden, tone: b.dataset.tone, goto: b.dataset.goto }; });

    // 1. one save, several kinds of change: one result, NEW 🎒 2 · 👥 1 · ❗ 자동 수락 1, with ✕
    await ev(() => { M.add(6, i => i === 3 ? 'PROMISE: I will be back by noon.' : ''); M.addChanges = () => ({
        entities: [{ ref: 'lamp', type: 'item', name: 'Brass lamp', aliases: [] }, { ref: 'coat', type: 'item', name: 'Grey coat', aliases: [] }],
        changes: [{ op: 'add', type: 'item', entity: 'lamp', holder: 'ari', text: 'Ari holds a brass lamp.', msgs: [1] }, { op: 'add', type: 'item', entity: 'coat', holder: 'ari', text: 'Ari wears a grey coat.', msgs: [2] },
            { op: 'add', type: 'party', entity: 'ari', aspect: 'condition', text: 'Ari is tired.', msgs: [4] }] }); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    let r = await banner();
    ok(r.shown && r.title === '저장 완료' && r.news === 'NEW🎒 2 · 👥 1 · ❗ 자동 수락 1' && r.close && r.goto === 'main-changes' && r.sub.includes('최근 변화'), `1. 저장 결과에 NEW 🎒 👥 ❗ 한 줄 + ✕ (${JSON.stringify(r)})`);

    // 2. ✕ closes only the banner; the window stays closed
    await page.click('#sp_save_banner .sp-sb-close');
    ok(!(await banner()).shown && !(await ev(() => __savePoint.ui.open)), '2. ✕는 배너만 닫음');

    // 3. a later save changes one item: NEW 🎒 1 only, main shows NEW on that item alone
    const coatId = await ev(() => __savePoint.state().mem.records.find(x => x.type === 'item' && x.text.includes('coat')).id);
    await ev(id => { M.add(2); M.addChanges = () => ({ changes: [{ op: 'update', id, text: 'Ari wears the grey coat, now torn.', msgs: [M.chat.length - 2] }] }); }, coatId);
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await banner();
    ok(r.news === 'NEW🎒 1', `3. 바뀐 종류만 (${r.news})`);

    // 4. a tap opens 💠 메인 with the last changes unfolded; NEW sits on the changed item only
    await page.click('#sp_save_banner');
    await page.waitForTimeout(300);
    r = await ev(() => ({ tab: __savePoint.ui.tab, open: !!document.querySelector('[data-group=main-changes]')?.open,
        items: [...document.querySelectorAll('.sp-st-items .it')].map(el => el.querySelector('b').textContent + (el.querySelector('.sp-new') ? '+NEW' : '')),
        party: [...document.querySelectorAll('.sp-st-p .n')].map(el => !!el.querySelector('.sp-new')) }));
    ok(r.tab === 'main' && r.open && r.items.includes('Grey coat+NEW') && r.items.includes('Brass lamp') && r.party.every(x => !x), `4. 메인 + 최근 변화 펼침, NEW는 바뀐 것에만 (${JSON.stringify(r)})`);

    // 5. with the window open, the result is a line at the top of the status panel
    await ev(id => { M.add(2); M.addChanges = () => ({ changes: [{ op: 'add', type: 'party', entity: 'ari', aspect: 'relation', text: 'Ari trusts Me a little more.', msgs: [M.chat.length - 1] }] }); });
    await ev(() => __savePoint.handle('tab', 'journal'));
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await ev(() => { const x = document.querySelector('#sp_overlay .sp-hud .sp-hud-result'); return { line: x?.textContent || '', banner: !document.getElementById('sp_save_banner').hidden, first: x && x.parentElement.firstElementChild === x }; });
    ok(r.line.includes('저장 완료') && r.line.includes('NEW👥 1') && !r.banner && r.first, `5. 창이 열려 있으면 상태칸 맨 위 한 줄 (${JSON.stringify(r)})`);
    await page.click('#sp_overlay [data-act="hud-result"]');
    await page.waitForTimeout(200);
    r = await ev(() => ({ tab: __savePoint.ui.tab, open: !!document.querySelector('[data-group=main-changes]')?.open, line: !!document.querySelector('.sp-hud-result'),
        party: [...document.querySelectorAll('.sp-st-p .n')].some(el => el.querySelector('.sp-new')) }));
    ok(r.tab === 'main' && r.open && !r.line && r.party, `5. 누르면 메인 최근 변화, 바뀐 인물에 NEW (${JSON.stringify(r)})`);

    // 6. the in-window line fades by itself, and ✕ closes it
    await ev(() => { M.add(2); M.addChanges = () => ({ changes: [{ op: 'update', id: __savePoint.state().mem.records.find(x => x.text.includes('lamp')).id, text: 'The lamp flickers.', msgs: [M.chat.length - 1] }] }); return __savePoint.handle('run'); });
    await page.waitForTimeout(1200);
    const had = await ev(() => !!document.querySelector('.sp-hud-result'));
    await page.click('#sp_overlay [data-act="hud-result-close"]');
    ok(had && !(await ev(() => !!document.querySelector('.sp-hud-result'))), '6. 상태칸 한 줄도 ✕로 닫힘');
    await ev(() => { M.add(2); M.addChanges = () => ({ changes: [{ op: 'update', id: __savePoint.state().mem.records.find(x => x.text.includes('lamp')).id, text: 'The lamp goes dark.', msgs: [M.chat.length - 1] }] }); return __savePoint.handle('run'); });
    await page.waitForTimeout(7400);
    ok(!(await ev(() => !!document.querySelector('.sp-hud-result'))), '6. 상태칸 한 줄은 6초 뒤 사라짐');
    await ev(() => __savePoint.handle('close'));

    // 7. nothing but scenes changed: the plain result, no NEW line
    await ev(() => { M.add(2); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await banner();
    ok(r.shown && r.title === '저장 완료' && !r.news, `7. 변화 없음 → 평소 완료 배너 (${JSON.stringify(r)})`);
    await page.click('#sp_save_banner .sp-sb-close');

    // 8. a partial save: the notice on top, what was saved below, and it stays until closed
    await ev(() => { M.add(30, i => i === M.chat.length + 2 ? '' : ''); M.addChanges = () => ({ changes: [{ op: 'update', id: __savePoint.state().mem.records.find(x => x.text.includes('lamp')).id, text: 'The lamp is relit.', msgs: [M.chat.length - 30] }] }); M.failAt = M.chat.length - 6; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    r = await banner();
    await page.waitForTimeout(6500);
    const still = (await banner()).shown;
    await ev(() => { delete M.failAt; });
    ok(r.shown && r.tone === 'warning' && r.title === '일부 저장' && r.news === 'NEW🎒 1' && still, `8. 일부 저장: 안내 위, 저장된 변화 아래, 닫을 때까지 유지 (${JSON.stringify(r)})`);
    await page.click('#sp_save_banner .sp-sb-close');

    // 10. (v0.6.54) the chat-file write of a later part fails: the partial notice and what was saved still show
    await ev(() => { M.add(30); M.addChanges = ({ first }) => ({ changes: [{ op: 'update', id: __savePoint.state().mem.records.find(x => x.text.includes('lamp')).id, text: 'The lamp is cleaned.', msgs: [first] }] }); M.failNth = 2; });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await page.waitForTimeout(1500);
    r = await banner();
    await ev(() => { M.failNth = 0; });
    ok(r.shown && r.tone === 'warning' && r.title === '일부 저장' && r.news === 'NEW🎒 1', `10. 파일 저장 실패로 멈춰도 일부 저장 안내와 변화 줄 (${JSON.stringify(r)})`);
    await page.click('#sp_save_banner .sp-sb-close');
    await ev(() => { M.add(1); return __savePoint.handle('run'); }); await page.waitForTimeout(1200); await page.click('#sp_save_banner .sp-sb-close').catch(() => {});

    // 11. (v0.6.54) the same content again is not NEW
    await ev(() => { const r = __savePoint.state().mem.records.find(x => x.text.includes('coat')); M.add(2); M.addChanges = () => ({ changes: [{ op: 'update', id: r.id, text: r.text, holder: r.holder, msgs: [M.chat.length - 1] }] }); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await banner();
    ok(r.shown && !r.news.includes('🎒'), `11. 같은 내용으로 갱신하면 NEW 아님 (${JSON.stringify(r)})`);
    await page.click('#sp_save_banner .sp-sb-close').catch(() => {});

    // 12. (v0.6.54) window open, page hidden: the result waits and its 6 seconds start when the page is seen again
    await ev(() => { $('#sp_wand').trigger('click'); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        M.add(2); M.addChanges = () => ({ changes: [{ op: 'add', type: 'party', entity: 'ari', aspect: 'condition', text: 'Ari is sleepy.', msgs: [M.chat.length - 1] }] }); return __savePoint.handle('run'); });
    await page.waitForTimeout(7000);
    const whileHidden = await ev(() => !!document.querySelector('.sp-hud-result'));
    await ev(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(300);
    const afterBack = await ev(() => document.querySelector('.sp-hud-result')?.textContent || '');
    ok(!whileHidden && afterBack.includes('NEW👥 1'), `12. 창을 열어 둔 채 다른 앱에 가도, 돌아오면 결과 한 줄 (${afterBack})`);
    await ev(() => __savePoint.handle('close'));

    // 9. phone width: the banner stays inside the screen in every skin
    r = await ev(() => {
        const b = document.getElementById('sp_save_banner'), bad = [];
        b.hidden = false; b.querySelector('.sp-sb-news').hidden = false; b.querySelector('.sp-sb-news').innerHTML = b.querySelector('.sp-sb-news').innerHTML || 'x';
        for (const t of [...document.querySelectorAll('#sp_settings [data-set=theme] option')].map(o => o.value)) {
            b.setAttribute('data-theme', t);
            const rc = b.getBoundingClientRect(), x = b.querySelector('.sp-sb-close').getBoundingClientRect();
            if (rc.right > innerWidth + 1 || rc.left < -1 || x.right > rc.right + 1) bad.push(t);
        }
        b.hidden = true; return bad;
    });
    ok(!r.length, `9. 16개 스킨 × 390px: 배너와 ✕가 화면 안 (${r.join(',')})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
