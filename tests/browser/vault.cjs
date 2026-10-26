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

    const oldMem = { scenes: [{ id: 's1', title: 'Old scene', where: '', who: [], status: 'closed', star: false, pin: false, segs: [{ id: 'g1', from: 0, to: 3, outline: 'Old outline.', points: [], notes: '' }] }], entities: [], records: [], next: { s: 2, g: 2, e: 1, r: 1 } };
    const room = JSON.stringify(['ari.png', 'chatA']);
    let page, st, f;
    // ── 2. a slot kept only in settings stays there while the server cannot be written ──
    page = await session({ serverDown: true, settings: { savePoint: { localSaves: { m2: { id: 'm2', name: 'Keep me', auto: false, room, char: 'Ari', created: 1, updated: 2, stats: {}, msgCount: 1, pos: null, mem: oldMem } } } } });
    st = await settingsOf(page);
    ok(st.savePoint.localSaves.m2?.mem && (await page.evaluate(() => __savePoint.listSaves().length)) === 1, '2. 서버를 쓸 수 없으면 기존 슬롯은 설정에 그대로');
    await page.evaluate(() => { __savePoint.handle('tab', 'saves'); $('#sp_wand').trigger('click'); });
    ok((await page.evaluate(() => $('.sp-body').text())).includes('서버 백업을 쓸 수 없어요'), '2. 서버 백업 불가 안내');
    await page.close();

    // ── 3. normal play: quicksaves rotate 3 autosaves; 저장 button; linked badge ──
    page = await session();
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(() => { M.add(30); $('#sp_wand').trigger('click'); });
    for (let i = 0; i < 4; i++) {
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        await ev(() => M.add(4));
    }
    f = await files(page);
    const autosOnServer = Object.keys(f).filter(k => k.startsWith('savepoint-auto-'));
    const idx = JSON.parse(f['savepoint-index.json']);
    ok(autosOnServer.length === 3 && idx.saves.filter(e => e.auto).length === 3, `3. 오토세이브 방마다 3개 (서버 파일 ${autosOnServer.length}개)`);
    ok(f['savepoint-index.prev.json'] && JSON.parse(f['savepoint-index.prev.json']).saves.length === 3, '3. 이전 목록 보관');
    const autos = await ev(() => __savePoint.listSaves().filter(x => x.auto).map(x => x.msgCount));
    ok(autos[0] > autos[1] && autos[1] > autos[2], `3. 최신 → 이전 → 그 전 순서 (${autos})`);
    await ev(() => { M.popupInput = 'Route A'; return __savePoint.handle('save-new'); });
    const slotId = await ev(() => __savePoint.listSaves().find(x => !x.auto).id);
    await ev(() => __savePoint.handle('tab', 'saves'));
    let html = await ev(() => $('.sp-body').html());
    ok(!html.includes('덮어쓰기:') && (html.match(/data-act="save-over"/g) || []).length === 1, '3. 위쪽 덮어쓰기 없음, 저장 버튼은 FILE 슬롯에만');
    ok(html.includes('▶ 플레이 중') && !html.includes('이어하기') && !html.includes('루트 분기'), '3. 이 방에서 쓰는 슬롯에 플레이 중 표시, 불러오기 버튼은 하나');
    await ev(() => M.add(4));
    await ev(() => __savePoint.handle('run'));
    const before = await ev(id => __savePoint.listSaves().find(x => x.id === id).msgCount, slotId);
    await ev(id => __savePoint.handle('save-over', id), slotId);
    const after = await ev(id => __savePoint.listSaves().find(x => x.id === id).msgCount, slotId);
    ok(after > before, `3. 저장 → 슬롯 덮어쓰기 (메시지 ${before} → ${after})`);

    // ── 4. loading an older autosave restores the record position and the hiding ──
    const oldest = await ev(() => __savePoint.listSaves().filter(x => x.auto).at(-1));
    await ev(id => __savePoint.handle('load', id), oldest.id);
    let r = await ev(() => ({ last: __savePoint.state().lastIndex, hidden: M.chat.filter(m => m.is_system).length, len: M.chat.length }));
    ok(r.last === oldest.msgCount - 1 && r.hidden === Math.min(r.last + 1, r.len - 10), `4. 오토세이브 불러오기 → 그때 위치(#${r.last})와 하이드로 돌아감`);
    await ev(() => __savePoint.handle('undo'));
    r = await ev(() => __savePoint.state().lastIndex);
    ok(r === after - 1, '4. ⏪ 리와인드로 불러오기 전으로');

    // ── 5. tab strip keeps its scroll; labels ──
    await ev(() => { const t = $('.sp-tabs')[0]; t.scrollLeft = t.scrollWidth; });
    await ev(() => __savePoint.handle('tab', 'inject'));
    r = await ev(() => { const t = $('.sp-tabs')[0], a = $('.sp-tab.sp-active')[0]; return { left: t.scrollLeft, visible: a.offsetLeft - t.offsetLeft >= t.scrollLeft - 1 && a.offsetLeft - t.offsetLeft + a.offsetWidth <= t.scrollLeft + t.clientWidth + 1 }; });
    ok(r.left > 0 && r.visible, `5. 탭을 눌러도 탭 줄이 처음으로 돌아가지 않음 (scroll ${r.left})`);
    html = await ev(() => $('.sp-hud').text());
    ok(html.includes('⏪ 리와인드') && html.includes('🌐 번역') && !html.includes('가 번역'), '5. 리와인드 / 번역 이름');
    const serverFiles = await files(page);
    await page.close();

    // ── 6. settings lost: the server list comes back by itself ──
    page = await session({ files: serverFiles });
    r = await page.evaluate(() => __savePoint.listSaves().map(x => x.name));
    ok(r.includes('Route A') && r.filter(n => n.startsWith('오토세이브')).length === 3, '6. 설정이 비어도 서버 목록에서 슬롯이 그대로 보임');
    await page.evaluate(() => { M.add(10); });
    await page.evaluate(id => __savePoint.handle('load', id), slotId);
    ok((await page.evaluate(() => __savePoint.state()?.mem.scenes.length)) > 0, '6. 서버 파일에서 슬롯 불러오기');
    await page.close();

    // ── 7. both lists lost: 백업 찾기 finds this room's autosaves only; 복구 puts one back ──
    const noIndex = { ...serverFiles }; delete noIndex['savepoint-index.json']; delete noIndex['savepoint-index.prev.json'];
    page = await session({ files: noIndex });
    ok((await page.evaluate(() => __savePoint.listSaves().length)) === 0, '7. 목록 파일 둘 다 없으면 목록은 비어 있음');
    await page.evaluate(() => { $('#sp_wand').trigger('click'); return __savePoint.handle('find'); });
    await page.waitForTimeout(300);
    r = await page.evaluate(() => ({ text: $('.sp-found').text(), n: $('.sp-found [data-act="restore"]').length, list: __savePoint.listSaves().length }));
    ok(r.n === 3 && r.text.includes('이 방 오토세이브 이름') && !r.text.includes('Route A') && r.list === 0, '7. 백업 찾기 → 이 방 오토세이브 3개만 보여 주고 아무것도 바꾸지 않음');
    ok(r.text.includes('savepoint-slot-'), '7. 직접 만든 슬롯은 수동으로 가져오라는 안내');
    const file = await page.evaluate(() => $('.sp-found [data-act="restore"]').first().attr('data-id'));
    await page.evaluate(fl => __savePoint.handle('restore', fl), file);
    r = await page.evaluate(() => ({ list: __savePoint.listSaves().length, idx: JSON.parse(M.files.get('savepoint-index.json')).saves.length }));
    ok(r.list === 1 && r.idx === 1, '7. 복구 → 고른 하나만 목록에 다시 생김');
    await page.close();

    // ── 8. index lost, previous list present: notice + find shows the previous list ──
    const onlyPrev = { ...serverFiles }; delete onlyPrev['savepoint-index.json'];
    page = await session({ files: onlyPrev });
    await page.evaluate(() => { $('#sp_wand').trigger('click'); __savePoint.handle('tab', 'saves'); });
    ok((await page.evaluate(() => $('.sp-body').text())).includes('목록 파일이 없어요'), '8. 목록 파일만 없으면 백업 찾기 안내');
    await page.evaluate(() => __savePoint.handle('find'));
    await page.waitForTimeout(300);
    ok((await page.evaluate(() => $('.sp-found').text())).includes('이전 목록에서 찾음'), '8. 이전 목록에서 찾은 백업 표시');
    await page.close();

    // ── 9. a save while the server is down stays in settings, then moves on the next start ──
    page = await session();
    await page.evaluate(() => { M.add(12); M.serverDown = true; });
    await page.evaluate(() => __savePoint.handle('run'));
    await page.waitForTimeout(1600);
    st = await settingsOf(page);
    const localAuto = Object.values(st.savePoint.localSaves).filter(x => x.auto).length;
    ok(localAuto === 1 && (await page.evaluate(() => __savePoint.state().lastIndex)) === 11, '9. 서버가 안 되면 오토세이브는 설정에 보관 (기억 기록은 정상)');
    await page.close();
    page = await session({ settings: st });
    st = await settingsOf(page);
    ok(Object.keys(st.savePoint.localSaves).length === 0 && (await files(page))['savepoint-index.json'], '9. 다음 시작 때 서버로 옮김');
    await page.close();

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
