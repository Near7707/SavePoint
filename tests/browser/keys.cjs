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
    const settingsOf = page => page.evaluate(() => JSON.parse(JSON.stringify(M.settings)));
    const page = await session();
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(() => { M.add(14, i => (i === 6 ? 'GIFT ' : '') + `Message ${i} words.`); $('#sp_wand').trigger('click'); });
    await ev(() => __savePoint.handle('run'));
    let r = await ev(() => ({ inj: M.prompts.savepoint.v, pts: __savePoint.state().mem.scenes[0].segs[0].points }));
    ok(!r.inj.includes('Something happened at 0') && r.inj.includes('Ari received a gift at 6') && r.pts.length === 2, '1. 열린 장면도 key 포인트만 주입, 나머지는 저장만');
    // continue: earlier points are judged again (mock answers false for all of them)
    await ev(() => M.add(6));
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => ({ inj: M.prompts.savepoint.v, prompt: M.calls.at(-1), pts: __savePoint.state().mem.scenes[0].segs.flatMap(g => g.points) }));
    ok(r.pts[1].key === true && r.inj.includes('gift at 6'), '2. 이어서 기록해도 예전 포인트 선택은 다시 판단하지 않음 (v0.2.5)');
    r = await ev(() => __savePoint.state().mem.scenes[0].segs.map(g => g.outline));
    ok(r.length === 2 && r[0].includes('between 0 and') && r[1].includes('between 14 and'), '2. 구간마다 개요가 따로 남음 (앞 구간 개요가 지워지지 않음)');
    // the user's choice is kept
    await ev(() => __savePoint.handle('key-toggle', __savePoint.state().mem.scenes[0].id + '|g1|1'));
    ok(!(await ev(() => M.prompts.savepoint.v)).includes('gift at 6'), '3. ● → ○ 직접 지정하면 바로 빠짐');
    await ev(() => __savePoint.handle('key-toggle', __savePoint.state().mem.scenes[0].id + '|g1|1'));
    ok((await ev(() => M.prompts.savepoint.v)).includes('gift at 6') && (await ev(() => __savePoint.state().mem.scenes[0].segs[0].points[1].keyUser)) === true, '3. 다시 켜도 직접 선택(●)으로 남음');
    await ev(() => __savePoint.handle('key-toggle', __savePoint.state().mem.scenes[0].id + '|g1|0'));
    await ev(() => M.add(6));
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => ({ inj: M.prompts.savepoint.v, p: __savePoint.state().mem.scenes[0].segs[0].points[1] }));
    r = await ev(() => ({ inj: M.prompts.savepoint.v, p: __savePoint.state().mem.scenes[0].segs[0].points[0] }));
    ok(r.p.keyUser === true && r.p.key === false && r.inj.includes('Something happened at 0'), '3. ○ → ● 직접 지정은 다음 정리 뒤에도 유지');
    // A point pin is separate from the scene pin and restores the old selection when removed.
    await ev(() => __savePoint.handle('tab', 'journal'));
    r = await ev(() => document.querySelector('[data-act="key-toggle"][data-id="s1|g1|0"]').textContent);
    ok(r === '●', '4. 선택된 포인트는 ●로 통일');
    await ev(() => __savePoint.handle('pin-point', 's1|g1|0'));
    r = await ev(() => ({ symbol: document.querySelector('[data-act="key-toggle"][data-id="s1|g1|0"]').textContent,
        pin: __savePoint.state().mem.scenes[0].segs[0].points[0].pin, inj: M.prompts.savepoint.v }));
    ok(r.pin && r.symbol === '📌' && r.inj.includes('## Pinned points'), '4. 포인트 핀은 📌로 표시하고 별도로 주입');
    await ev(() => __savePoint.handle('key-toggle', 's1|g1|0'));
    ok((await ev(() => document.querySelector('[data-act="key-toggle"][data-id="s1|g1|0"]').textContent)) === '●', '4. 📌를 누르면 고정 전 직접 선택으로 복귀');
    // reset label
    await ev(() => __savePoint.handle('tab', 'saves'));
    r = await ev(() => $('.sp-body [data-act="clear-room"]').text());
    ok(r.trim() === '리셋', '6. 이 방 기억 비우기 → 리셋');
    // journal shows the counts
    await ev(() => __savePoint.handle('tab', 'journal'));
    ok(/포인트 \d+ \(주입 \d+\)/.test(await ev(() => $('.sp-more summary').first().text())), '7. 저널에 포인트 수와 주입 수 표시');
    // Injection tab: how each scene is written, why scenes are left out, and the limit that fits all outlines
    {
        const r2 = await page.evaluate(() => {
            const st = __savePoint.state(); const extra = [];
            for (let i = 0; i < 30; i++) extra.push({ id: 'sx' + i, title: 'Errand ' + i, where: 'Harbor', who: [], status: 'closed', segs: [{ id: 'gx' + i, from: 0, to: 0, outline: 'They walked the long harbor road and talked about the tides and the lantern routes in detail. They agreed to meet again.', points: [] }] });
            st.mem.scenes = [...extra, ...st.mem.scenes];
            if (!__savePoint.ui.open) document.querySelector('#sp_open').click();
            M.settings.savePoint.budget = 900; __savePoint.refreshInjection(); __savePoint.handle('tab', 'inject');
            const t = document.querySelector('#sp_overlay .sp-window')?.textContent || '';
            st.mem.scenes = st.mem.scenes.filter(x => !x.id.startsWith('sx')); M.settings.savePoint.budget = 6000; __savePoint.refreshInjection();
            return t;
        });
        ok(/장면 \d+개 · .*짧은 개요 \d+/.test(r2) && r2.includes('모든 장면의 개요를 포함하려면 주입 상한 약') && r2.includes('회상 후보'), '주입 탭: 장면별 단계, 필요한 상한, 회상 안내');
        ok(/주입 상한\(900토큰\)이 차서 제목도 넣지 못한 장면|짧은 개요/.test(r2), '주입 탭: 빠진 이유 표시');
    }
    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();


