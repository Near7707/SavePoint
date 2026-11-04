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
    await ev(() => { M.settings.savePoint.check = false; M.settings.savePoint.hudOpen = true; M.settings.savePoint.keepRecent = 4; $('#sp_wand').trigger('click'); });
    const hidden = () => ev(() => M.chat.map(m => m.is_system ? 'H' : '.').join(''));
    const button = () => ev(() => { const b = document.querySelector('#sp_overlay [data-act="hide-now"]'); return b ? { text: b.textContent, off: b.classList.contains('sp-disabled') } : null; });

    // 1. choosing manual in the settings: saves record, nothing is hidden, the button shows the count
    await ev(() => { const sel = document.querySelector('#sp_settings [data-set=hideMode]'); sel.value = 'manual'; $(sel).trigger('change'); });
    let r = await ev(() => ({ mode: M.settings.savePoint.hideMode, at: M.settings.savePoint.hideManualAt }));
    ok(r.mode === 'manual' && r.at > 0, '1. 설정에서 수동 선택 → 모드와 전환 시각 저장');
    await ev(() => M.add(12));
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    r = { last: await ev(() => __savePoint.state().lastIndex), hid: await hidden(), btn: await button() };
    ok(r.last === 11 && r.hid === '............' && r.btn?.text === '👻 하이드 8' && !r.btn.off, `1. 수동: 기록만 하고 숨기지 않음, 버튼에 숨길 개수 (${JSON.stringify(r)})`);

    // 2. pressing it hides the recorded messages outside the latest 4; the file has it
    await ev(() => __savePoint.handle('hide-now'));
    await page.waitForTimeout(300);
    r = { hid: await hidden(), btn: await button(), to: await ev(() => __savePoint.state().hideManual?.to), file: await ev(() => M.meta.savePoint?.hideManual?.to) };
    ok(r.hid === 'HHHHHHHH....' && r.btn?.text === '👻 하이드 0' && r.to === 7, `2. 👻 → 저장된 원문 8개 하이드, 최근 4개 남김, 버튼은 0으로 남음 (${JSON.stringify(r)})`);

    // 3. later saves record but do not grow the range
    await ev(() => M.add(6));
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    r = { last: await ev(() => __savePoint.state().lastIndex), hid: await hidden(), btn: await button() };
    ok(r.last === 17 && r.hid === 'HHHHHHHH..........' && r.btn?.text === '👻 하이드 6', `3. 다음 저장은 숨김 범위를 늘리지 않음 (${JSON.stringify(r)})`);

    // 4. cancelling the question changes nothing
    await ev(() => { M.confirm = 0; });
    await ev(() => __savePoint.handle('hide-now'));
    await page.waitForTimeout(200);
    ok((await hidden()) === 'HHHHHHHH..........', '4. 확인 창에서 취소하면 그대로');
    await ev(() => { M.confirm = 1; });

    // 5. while a save runs the button waits
    await ev(() => { M.add(3); M.delay = 700; });
    const running = ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(250);
    r = await button();
    await ev(() => __savePoint.handle('hide-now'));
    const midHid = await hidden();
    await running; await ev(() => { M.delay = 0; }); await page.waitForTimeout(300);
    ok(r?.off === true && midHid.startsWith('HHHHHHHH.'), `5. 저장 중에는 버튼이 흐리고 눌러도 숨기지 않음 (${JSON.stringify(r)})`);

    // 5b. a checkpoint finishing while the question is open: nothing is hidden, the count is asked again
    const beforeQ = await hidden();
    await ev(() => { M.confirm = new Promise(res => { window.__answer = res; }); });
    const asking = ev(() => __savePoint.handle('hide-now'));
    await page.waitForTimeout(150);
    await ev(() => { M.add(6); return __savePoint.handle('run'); });
    await page.waitForTimeout(900);
    await ev(() => window.__answer(1));
    await asking; await page.waitForTimeout(300); await ev(() => { M.confirm = 1; });
    r = { before: beforeQ, after: await hidden(), btn: await button() };
    ok(r.after.startsWith(r.before.slice(0, 9)) && r.after.split('').filter(c => c === 'H').length === 8 && / \d+$/.test(r.btn?.text || ''), `5b. 확인 창이 열린 사이 기록이 늘면 하이드하지 않고 다시 누르게 함 (${JSON.stringify(r)})`);

    // 5c. a message opened by the user stays shown after the next save in manual mode
    await ev(() => { M.chat[2].is_system = false; __savePoint.syncHide(); M.add(2); return __savePoint.handle('run'); });
    await page.waitForTimeout(900);
    r = await hidden();
    ok(r.slice(0, 8) === 'HH.HHHHH', `5c. 수동: 직접 펼친 메시지는 다음 세이브에도 보임 (${r})`);
    await ev(() => { const m = M.chat[2]; m.is_system = true; m.extra.savepointHidden = 1; delete m.extra.savepointVisible; __savePoint.syncHide(); });

    // 6. a failed write takes the hide back
    await ev(() => { M.failOnce = true; });
    await ev(() => __savePoint.handle('hide-now').catch(() => {}));
    await page.waitForTimeout(300);
    r = { hid: await hidden(), to: await ev(() => __savePoint.state().hideManual?.to), tried: await ev(() => M.failOnce === false) };
    ok(r.tried && r.hid.startsWith('HHHHHHHH.') && r.to === 7, `6. 저장 실패 → 숨김과 범위 모두 원래대로 (${JSON.stringify(r)})`);

    // 6b. a message the user hid themselves, then opened again, is not hidden by the next save
    await ev(() => { const m = M.chat[1]; delete m.extra.savepointHidden; m.is_system = false; __savePoint.syncHide(); M.add(2); return __savePoint.handle('run'); });
    await page.waitForTimeout(900);
    r = await hidden();
    ok(r.slice(0, 8) === 'H.HHHHHH', `6b. 직접 숨겼다 펼친 메시지는 다음 세이브에도 보임 (${r})`);
    await ev(() => { const m = M.chat[1]; m.is_system = true; m.extra.savepointHidden = 1; __savePoint.syncHide(); });

    // 7. (v0.6.55) the button sits in the one-row button line, in every skin, at 393 and 360px, and keeps its width as the count changes
    for (const w of [393, 360]) {
        await page.setViewportSize({ width: w, height: 844 });
        r = await ev(() => {
            const win = document.querySelector('#sp_overlay .sp-window'), bad = [];
            for (const t of [...document.querySelectorAll('#sp_settings [data-set=theme] option')].map(o => o.value)) {
                win.setAttribute('data-theme', t);
                const row = win.querySelector('.sp-actions'), bs = [...row.children].map(x => x.getBoundingClientRect());
                const b = win.querySelector('.sp-actions [data-act="hide-now"]'), n = b.querySelector('.sp-hide-n'), width0 = b.getBoundingClientRect().width;
                const keep = n.textContent; n.textContent = '999'; const width3 = b.getBoundingClientRect().width; n.textContent = keep;
                const order = [...row.querySelectorAll('[data-act]')].map(x => x.dataset.act).join(',');
                if (bs.some(x => Math.abs(x.top - bs[0].top) > 2) || row.scrollWidth > row.clientWidth + 1 || Math.abs(width3 - width0) > 0.5 || order !== 'run,undo,hide-now,lang' || b.scrollWidth > b.clientWidth + 1) bad.push(t + ':' + JSON.stringify({ rows: bs.map(x => Math.round(x.top)), sw: row.scrollWidth, cw: row.clientWidth, w0: width0, w3: width3, order, bsw: b.scrollWidth, bcw: b.clientWidth }));
            }
            return bad;
        });
        ok(!r.length, `7. 16개 스킨 × ${w}px: 퀵세이브·리와인드·하이드·번역 한 줄, 숫자가 바뀌어도 폭 같음 (${r.join(',')})`);
    }
    await page.setViewportSize({ width: 390, height: 844 });

    // 8. new icons: ⚓ for pinning, 🧿 for the injection tab
    r = await ev(() => ({ tab: [...document.querySelectorAll('#sp_overlay [data-act=tab]')].map(b => b.textContent).join(' '), html: document.querySelector('#sp_overlay').innerHTML }));
    ok(r.tab.includes('🧿') && !r.tab.includes('👁') && !r.html.includes('📌'), '8. 주입 탭 🧿, 📌 없음');
    await ev(() => __savePoint.handle('tab', 'journal'));
    ok(await ev(() => !!document.querySelector('#sp_overlay [data-act="pin"]')?.textContent.includes('⚓')), '8. 저널 고정 버튼 ⚓');

    // 9. off shows what SavePoint hid; a message hidden by the user stays hidden
    await ev(() => { M.chat[20].is_system = true; const sel = document.querySelector('#sp_settings [data-set=hideMode]'); sel.value = 'off'; $(sel).trigger('change'); });
    r = await hidden();
    ok(r.split('').filter(c => c === 'H').length === 1 && r[20] === 'H', `9. 끔 → SavePoint가 숨긴 것만 다시 보이고 직접 숨긴 건 유지 (${r})`);

    // 10. back to auto: the normal rule applies at once
    await ev(() => { const sel = document.querySelector('#sp_settings [data-set=hideMode]'); sel.value = 'auto'; $(sel).trigger('change'); });
    r = await ev(() => ({ hid: M.chat.map(m => m.is_system ? 'H' : '.').join(''), last: __savePoint.state().lastIndex, n: M.chat.length }));
    ok(r.hid.slice(0, r.n - 4).split('').every(c => c === 'H') && r.hid.slice(r.n - 4) === '....', `10. 자동으로 바꾸면 바로 자동 규칙 (${JSON.stringify(r)})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
