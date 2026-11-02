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
    const saves = () => ev(() => __savePoint.listSaves().map(x => ({ id: x.id, name: x.name, quick: !!x.quick, auto: !!x.auto, room: x.room, title: x.stats?.lastTitle })));
    await ev(() => { M.settings.savePoint.check = false; M.add(8); $('#sp_wand').trigger('click'); });

    // 1. a manual quicksave makes this room's QUICK; a checkpoint does not replace it
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1800);
    let list = await saves();
    let q = list.filter(x => x.quick);
    ok(q.length === 1 && q[0].title, `1. 퀵세이브 → 이 방 QUICK 1개, 저장 당시 장면 제목 (${q[0]?.title})`);
    const firstQuick = await ev(() => JSON.stringify(__savePoint.listSaves().find(x => x.quick)));
    await ev(() => { M.add(25); return __savePoint.autoCollect(); });
    await page.waitForTimeout(1800);
    ok((await ev(() => JSON.stringify(__savePoint.listSaves().find(x => x.quick)))) === firstQuick, '1. 체크포인트는 QUICK을 바꾸지 않음');
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1800);
    list = await saves();
    ok(list.filter(x => x.quick).length === 1 && (await ev(() => JSON.stringify(__savePoint.listSaves().find(x => x.quick)))) !== firstQuick, '1. 다시 퀵세이브하면 QUICK 1칸이 새로 바뀜');
    const f = await ev(() => [...M.files.keys()].filter(k => k.startsWith('savepoint-quick-')));
    ok(f.length === 1, `1. 서버의 QUICK 파일은 하나만 남음 (${f.join(', ')})`);

    // 2. cards: QUICK first, "사본 저장" instead of 저장/이름, the tab counts this room
    await ev(() => __savePoint.handle('tab', 'saves'));
    let r = await ev(() => ({ first: $('details[data-group="here"] .sp-save').first().find('.sp-slot').text(),
        quickBtns: $('details[data-group="here"] .sp-save-quick [data-act]').map((i, e) => e.textContent.trim()).get(),
        title: $('details[data-group="here"] .sp-save-quick .sp-save-title').text(),
        count: $('.sp-tab[data-id="saves"] em').text(), here: $('details[data-group="here"] .sp-save').length }));
    ok(r.first === 'QUICK' && r.quickBtns.includes('사본 저장') && !r.quickBtns.includes('저장') && !r.quickBtns.includes('이름') && r.title.includes('🎬'), `2. QUICK 카드: 맨 위, 사본 저장, 장면 제목 (${r.quickBtns.join('/')})`);
    ok(r.count === String(r.here), `2. 세이브 탭 숫자 = 이 방 슬롯 수 (${r.count})`);
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'quick-saves.png'), fullPage: false });
    const qid = (await saves()).find(x => x.quick).id;
    await ev(async id => { M.popupInput = 'Kept copy'; await __savePoint.handle('save-rename', id); }, qid);
    list = await saves();
    ok(list.some(x => x.name === 'Kept copy' && !x.quick && !x.auto) && list.some(x => x.id === qid && x.quick), '2. 사본 저장 → FILE 슬롯 생성, QUICK은 그대로');

    // 3. a new chat with only a greeting: resume box, then start from the carried reply
    const lastText = await ev(() => { const c = M.chat; for (let i = c.length - 1; i >= 0; i--) if (!c[i].is_user) return c[i].mes; });
    await ev(() => M.switchChat('chatNew', [{ name: 'Ari', is_user: false, is_system: false, mes: 'Hello! This is the very first greeting.', swipe_id: 0, swipes: ['Hello! This is the very first greeting.', 'Another greeting.'], extra: {} }], {}));
    await page.waitForTimeout(400);
    await ev(() => { $('#sp_wand').trigger('click'); __savePoint.handle('tab', 'saves'); });
    r = await ev(() => ({ resume: $('.sp-resume .sp-save-quick').length, label: $('.sp-resume .sp-save-meta').text() }));
    ok(r.resume === 1 && r.label.includes('🗝️'), `3. 새 방: 이어하기 칸에 다른 방 QUICK (${r.label.trim().slice(0, 40)})`);
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'quick-resume.png') });
    await ev(async id => { M.confirm = 1; await __savePoint.handle('load', id); }, qid);
    await page.waitForTimeout(400);
    r = await ev(() => ({ mes: M.chat[0].mes, swipes: M.chat[0].swipes.length, last: __savePoint.state().lastIndex, carry: __savePoint.state().carry, n: M.chat.length }));
    ok(r.mes === lastText && r.swipes === 1 && r.n === 1, '3. 첫 인사말이 저장 당시 마지막 캐릭터 메시지로 바뀜');
    ok(r.last === 0 && r.carry && r.carry.recorded, '3. 이미 기록된 메시지라 #0은 기록된 것으로 연결');
    await ev(() => { M.add(3); });
    const c0 = await ev(() => M.calls.length);
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    r = await ev(c0 => M.calls.slice(c0).join('\n'), c0);
    ok(!/^#0 /m.test(r) && /^#1 /m.test(r), '3. 새 방 기록은 #1부터 (#0 다시 기록 안 함)');

    // 4. other characters: one folder per character (👾), rooms split (🗝️) when there are several
    await ev(async () => {
        const st = __savePoint.state();
        const base = { mem: st.mem, msgCount: 3, pos: null, version: 'x', auto: false, created: 1, updated: 1 };
        await __savePoint.vault.put({ ...base, id: 'w1', name: 'W one', stats: { lastTitle: 'Harbor talk' }, room: JSON.stringify(['wren.png', 'Wren - 2026-01-01@10h00m00s000ms']), char: 'Wren' });
        await __savePoint.vault.put({ ...base, id: 'w2', name: 'W two', updated: 5, stats: { lastTitle: 'Night market' }, room: JSON.stringify(['wren.png', 'Wren - 2026-02-01@09h30m00s000ms']), char: 'Wren' });
        __savePoint.handle('tab', 'saves');
    });
    r = await ev(() => ({ char: $('details[data-group="char:wren.png"] > summary').text().trim(), rooms: $('details[data-group="char:wren.png"] details[data-group^="room:"] > summary').map((i, e) => e.textContent.trim()).get() }));
    if (SHOTS) { await ev(() => { $('details[data-group="others"], details[data-group="char:wren.png"]').attr('open', ''); }); await page.screenshot({ path: path.join(OUT, 'quick-folders.png'), fullPage: true }); }
    ok(r.char.startsWith('👾') && r.rooms.length === 2 && r.rooms[0].includes('🗝️ 2026-02-01 09:30 채팅 · Night market'), `4. 캐릭터 👾 → 방 🗝️ 폴더, 최신 방 먼저·장면 제목 (${r.rooms.join(' | ')})`);

    // 5. importing QUICK files gives independent FILE slots (two rooms' QUICKs do not replace each other)
    const body = await ev(async () => { const q = __savePoint.listSaves().find(x => x.quick); return JSON.stringify(await __savePoint.vault.read(q)); });
    const mk = (room, n) => JSON.stringify({ format: 'savepoint', saves: [{ ...JSON.parse(body), id: 'quick_x' + n, room, name: 'Imported ' + n }] });
    for (const [n, room] of [[1, '["a.png","A - 2026-01-01@10h00m00s000ms"]'], [2, '["b.png","B - 2026-01-02@10h00m00s000ms"]']]) {
        await page.setInputFiles('#sp_file', { name: `q${n}.json`, mimeType: 'application/json', buffer: Buffer.from(mk(room, n)) });
        await page.waitForTimeout(500);
    }
    list = await saves();
    const imp = list.filter(x => x.name.startsWith('Imported'));
    ok(imp.length === 2 && imp.every(x => !x.quick && !x.auto), `5. 가져온 QUICK 2개는 각각 FILE 슬롯 (${imp.map(x => x.name).join(', ')})`);

    // 6. a newer copy kept in settings (failed server write) is the only card for that id
    r = await ev(() => {
        const q = __savePoint.listSaves().find(x => x.quick && !x.local);
        __savePoint.settings().localSaves[q.id] = { ...q, name: 'Newer local QUICK', updated: Date.now() + 1000, mem: __savePoint.state().mem };
        const same = __savePoint.listSaves().filter(x => x.id === q.id);
        delete __savePoint.settings().localSaves[q.id];
        return same.map(x => [x.name, !!x.local]);
    });
    ok(r.length === 1 && r[0][0] === 'Newer local QUICK' && r[0][1], `6. 같은 ID는 설정에 보관한 최신 사본 하나만 표시 (${JSON.stringify(r)})`);

    // 7. SillyTavern swallows a server error and returns: the read-back finds the old file and everything is undone
    const qid2 = (await saves()).find(x => x.quick && x.room.includes('chatA')).id;
    await ev(() => M.switchChat('chatFail', [{ name: 'Ari', is_user: false, is_system: false, mes: 'Fresh greeting for the failing room.', swipe_id: 0, swipes: ['Fresh greeting for the failing room.'], extra: {} }], {}));
    await page.waitForTimeout(300);
    await ev(() => { M.writeServerChat(); M.silentSaveFail = true; toastr.log.length = 0; });
    await ev(async id => { M.confirm = 1; await __savePoint.handle('load', id); }, qid2);
    await page.waitForTimeout(300);
    r = await ev(() => ({ mes: M.chat[0].mes, st: __savePoint.state(), tainted: Object.hasOwn(M.meta, 'tainted'), toast: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.mes === 'Fresh greeting for the failing room.' && !r.st && !r.tainted && r.toast.includes('되돌렸어요'), `7. 서버 저장이 조용히 실패하면 첫 메시지·기억·수정 표시를 되돌림 (${r.toast.slice(0, 60)})`);
    await ev(() => { M.silentSaveFail = false; });

    // 8. a new chat asks "이어서 할까요?": 이어하기 lists the saves to pick from; 새로 하기 is remembered for the room
    await ev(() => __savePoint.handle('close'));
    const greet = () => [{ name: 'Ari', is_user: false, is_system: false, mes: 'A brand new greeting.', swipe_id: 0, swipes: ['A brand new greeting.'], extra: {} }];
    await ev(g => M.switchChat('chatResume', g, {}), greet());
    await page.waitForTimeout(1000);
    r = await ev(() => { const el = document.getElementById('sp_resume'); return { shown: !!el && !el.hidden, text: el?.textContent || '' }; });
    ok(r.shown && r.text.includes('이어서 할까요?') && r.text.includes('불러오기') && r.text.includes('새로 하기'), '8. 새 채팅에 불러오기·새로 하기 선택 칸');
    await page.click('#sp_resume [data-resume-act="open"]');
    r = await ev(() => [...document.querySelectorAll('#sp_resume [data-resume]')].map(b => b.querySelector('.sp-slot').textContent));
    ok(r.length >= 2 && r[0] === 'QUICK', `8. 이어하기를 누르면 고를 목록 (QUICK 먼저: ${r.join(',')})`);
    await ev(() => { M.confirm = 1; });
    await page.click('#sp_resume [data-resume]');
    await page.waitForTimeout(600);
    r = await ev(() => ({ hidden: document.getElementById('sp_resume').hidden, mem: !!__savePoint.state()?.mem?.scenes?.length, first: M.chat[0].mes }));
    ok(r.hidden && r.mem && r.first !== 'A brand new greeting.', '8. 고르면 불러오고 선택 칸은 닫힘');
    await ev(g => M.switchChat('chatFresh', g, {}), greet());
    await page.waitForTimeout(1000);
    await page.click('#sp_resume [data-resume-act="fresh"]');
    await ev(() => M.switchChat('chatA', M.chatA || [], {}));
    await ev(g => M.switchChat('chatFresh', g, {}), greet());
    await page.waitForTimeout(1000);
    r = await ev(() => { const el = document.getElementById('sp_resume'); return !!el && !el.hidden; });
    ok(!r && !(await ev(() => __savePoint.state()?.mem?.scenes?.length)), '8. 새로 하기를 고른 방은 다시 묻지 않고 아무것도 바뀌지 않음');

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
