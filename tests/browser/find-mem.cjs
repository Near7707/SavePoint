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

// v0.7.1-a3 (v0.7.1 step 2): 🔍 백업 찾기 also lists this room's memory files, found by its own clues, shown only (no button).
// 1 linked room: the memory linked now, marked once, nothing written · 2 the memory file not readable → 읽지 못함 · 3 gone → 파일 없음
// · 4 the name tag not readable → a notice, the memory still found by the link · 5 a clue naming a memory recorded for another room
// · 6 a room left after a search: its result goes; a new room shows no memory · 7 a room left while the search runs (during the slot
// search, during the memory search): nothing of the old room is shown in the new one, or kept · 8 a second search in the same room
// wins · 9 a result kept for another room is never drawn · 10 (a4) a broken memory file: that row only, the slots still shown.
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: 'off', askResume: false, autoReserve: 0 } }; });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready && !!M.H);
    await page.evaluate(() => M.opened());
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    await ev(() => {
        window.__writes = 0;
        const f = window.fetch;
        window.fetch = (u, o) => { if (/\/api\/chats\/save|\/api\/files\/upload|\/api\/files\/delete|\/api\/chats\/group\/save/.test(String(u))) window.__writes++; return f(u, o); };
    });
    const writes = () => ev(() => window.__writes);
    const find = () => ev(() => __savePoint.handle('find'));
    // What the window shows of the search: the room's memory rows (kind, text), notices, and whether a result is drawn at all.
    const shown = () => ev(() => {
        const box = document.querySelector('#sp_overlay .sp-found');
        if (!box) return { box: false };
        const rows = [...box.querySelectorAll('.sp-found-mem')].map(x => ({ kind: x.dataset.kind, text: x.textContent.replace(/\s+/g, ' ').trim(), btn: x.querySelectorAll('button,[data-act]').length }));
        return { box: true, text: box.textContent.replace(/\s+/g, ' '), rows, now: box.querySelectorAll('.sp-badge-on').length, key: __savePoint.home().key };
    });
    let r;

    const A = await ev(() => M.chatId);
    await ev(() => { M.add(8); $('#sp_wand').trigger('click'); });
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const id = await ev(() => __savePoint.home().id);
    const memFile = await ev(i => M.H.memName(i), id);
    const tagFile = await ev(() => M.H.tagName(__savePoint.home().key));
    ok(!!id && (await ev(() => __savePoint.home().status)) === 'linked', `0. 기록 → 기억 연결됨 (${id})`);

    // 1. the linked memory, once, marked as the one linked now; no button; the search writes nothing
    let w0 = await writes();
    await find(); await wait(300);
    r = await shown();
    ok(r.box && r.rows.length === 1 && r.rows[0].kind === 'now' && r.now === 1 && r.text.includes('현재 연결된 기억'), `1. 기억 파일 한 줄, 현재 연결된 기억 표시 (${JSON.stringify(r.rows)})`);
    ok(r.rows[0]?.text.includes('메시지 8개 기록') && r.rows[0]?.text.includes('이 방 이름표') && r.rows[0]?.btn === 0, '1. 기록 범위·찾은 단서 표시, 버튼 없음');
    ok(r.text.includes('보여 주기만'), '1. 보여 주기만 한다는 안내');
    ok((await writes()) === w0, '1. 찾기만으로 저장·업로드·삭제 0');

    // 2. the memory file cannot be read: 읽지 못함 (not 파일 없음, not linked)
    await ev(n => { M.fileState[n] = 'error'; }, memFile);
    await find(); await wait(300);
    r = await shown();
    await ev(n => { delete M.fileState[n]; }, memFile);
    ok(r.rows.length === 1 && r.rows[0].kind === 'fail' && r.text.includes('읽지 못함') && !r.text.includes('파일 없음') && r.now === 0, `2. 기억 파일 읽기 실패 → 읽지 못함 (${JSON.stringify(r.rows)})`);

    // 3. the server has no such file: 파일 없음 (a clue names it)
    await ev(n => { M.fileState[n] = 'missing'; }, memFile);
    await find(); await wait(300);
    r = await shown();
    await ev(n => { delete M.fileState[n]; }, memFile);
    ok(r.rows.length === 1 && r.rows[0].kind === 'missing' && r.text.includes('파일 없음') && !r.text.includes('읽지 못함'), `3. 기억 파일 없음 → 파일 없음 (${JSON.stringify(r.rows)})`);

    // 4. the name tag cannot be read: said so; the memory linked now is still found
    await ev(n => { M.fileState[n] = 'error'; }, tagFile);
    await find(); await wait(300);
    r = await shown();
    await ev(n => { delete M.fileState[n]; }, tagFile);
    ok(r.text.includes('이 방 이름표을(를) 읽지 못해서') && r.rows.length === 1 && r.rows[0].kind === 'now' && !r.rows[0].text.includes('이 방 이름표에서'), `4. 이름표 읽기 실패 → 안내 + 연결된 기억은 그대로 (${JSON.stringify(r.rows)})`);

    // 5. a move-start mark naming a memory recorded for another room: shown with that note, not as the one linked
    await ev(() => {
        const addr = __savePoint.home().key, other = JSON.stringify([M.charKey(), 'fmOther']);
        const d = M.memDoc();
        M.otherPut(M.H.memName('mem-fm5'), { ...d, id: 'mem-fm5', wid: 'other.fm5', recent: [{ rev: d.rev, wid: 'other.fm5' }], home: { addr: other, integrity: null } });
        M.otherPut(M.H.startName(addr), M.H.startBody({ addr, copy: 'c-fm5', mem: 'mem-fm5', wid: 'other.fm5s' }));
    });
    w0 = await writes();
    await find(); await wait(300);
    r = await shown();
    await ev(() => { M.otherDel(M.H.startName(__savePoint.home().key)); M.otherDel(M.H.memName('mem-fm5')); });
    const five = r.rows.find(x => x.kind === 'ok');
    ok(r.rows.length === 2 && r.now === 1 && !!five && five.text.includes('fmOther') && five.text.includes('다른 방') && five.text.includes('옮기기 시작 표시'), `5. 다른 방 소속 기억 → 그 표시 (${JSON.stringify(r.rows)})`);
    ok((await writes()) === w0, '5. 쓰기 0');

    // 6. a room left after a search: its result goes at once; a new room has no memory files
    await find(); await wait(300);
    ok((await shown()).box, '6. 찾은 결과가 보임');
    await ev(() => M.switchChat('fmNew', [], {}));
    await ev(() => M.opened());
    r = await shown();
    ok(!r.box && (await ev(() => __savePoint.ui?.found ?? null)) === null, `6. 방을 바꾸면 이전 방 결과가 사라짐 (${JSON.stringify(r).slice(0, 120)})`);
    await find(); await wait(300);
    r = await shown();
    ok(r.box && r.rows.length === 0 && r.text.includes('이 방의 단서로 찾은 기억 파일이 없어요'), `6. 새 방: 찾은 기억 파일 없음 안내 (${JSON.stringify(r.rows)})`);

    // 7. a room left while the search runs: during the slot search (the list file slowed), during the memory search (the tag slowed)
    for (const [label, slow] of [['목록 찾는 중', 'savepoint-index.json'], ['기억 찾는 중', tagFile]]) {
        await ev(a => M.openFile(a), A); await ev(() => M.opened());
        await ev(n => { M.fileDelay[n] = 800; window.__found = __savePoint.handle('find'); }, slow);
        await wait(250);
        await ev(() => { window.__reads0 = M.fileReads.length; return M.openFile('fmNew'); }); await ev(() => M.opened());
        await ev(() => window.__found); await wait(900);
        await ev(n => { delete M.fileDelay[n]; }, slow);
        r = await shown();
        ok(!r.box || !r.rows.some(x => x.kind === 'now' || x.text.includes('저장 ')), `7. ${label} 방을 바꿈 → 새 방에 이전 방 기억이 안 뜸 (${JSON.stringify(r.rows || [])})`);
        ok(!r.box, `7. ${label} 방을 바꿈 → 이전 방 결과 자체가 안 뜸`);
        ok((await ev(() => __savePoint.ui.found)) === null, `7. ${label} 방을 바꿈 → 이전 방 결과를 들고 있지도 않음`);
        if (slow !== tagFile) ok(!(await ev(n => M.fileReads.slice(window.__reads0).includes(n), tagFile)), `7. ${label} 방을 바꿈 → 이전 방 기억 단서를 더 읽지 않음`);
    }

    // 8. two searches in one room: the later one's result stays (the earlier, slower one does not replace it)
    await ev(a => M.openFile(a), A); await ev(() => M.opened());
    await ev(n => { M.fileState[n] = 'error'; M.fileDelay[n] = 800; window.__found = __savePoint.handle('find'); }, memFile);
    await wait(200);
    await ev(n => { delete M.fileState[n]; delete M.fileDelay[n]; }, memFile);
    await find(); await wait(300);
    await ev(() => window.__found); await wait(300);
    r = await shown();
    ok(r.box && r.rows.length === 1 && r.rows[0].kind === 'now', `8. 늦게 끝난 앞 검색이 뒤 검색 결과를 덮지 않음 (${JSON.stringify(r.rows)})`);

    // 9. a result kept for another room (as if every other guard missed it) is never drawn here
    r = await ev(() => { const f = __savePoint.ui.found; __savePoint.ui.found = { ...f, key: JSON.stringify(['x.png', 'fmElse']) }; __savePoint.render(true); const n = document.querySelectorAll('#sp_overlay .sp-found').length; __savePoint.ui.found = f; __savePoint.render(true); return { n, back: document.querySelectorAll('#sp_overlay .sp-found').length }; });
    ok(r.n === 0 && r.back === 1, `9. 다른 방 결과는 그리지 않음 (${JSON.stringify(r)})`);

    // 10. (a4, review of a3 P2) a memory file that passes the shape check but breaks the numbers (a null in its records): that row
    // 읽지 못함, the slots found and the memory linked now still shown
    await ev(() => {
        const addr = __savePoint.home().key, d = M.memDoc();
        const state = JSON.parse(JSON.stringify(d.state)); state.mem.records = [null];
        M.otherPut(M.H.memName('mem-fm10'), { ...d, id: 'mem-fm10', wid: 'other.fm10', recent: [{ rev: d.rev, wid: 'other.fm10' }], state });
        M.otherPut(M.H.startName(addr), M.H.startBody({ addr, copy: 'c-fm10', mem: 'mem-fm10', wid: 'other.fm10s' }));
    });
    w0 = await writes();
    await find(); await wait(300);
    r = await shown();
    const slots = await ev(() => document.querySelectorAll('#sp_overlay .sp-found .sp-rec:not(.sp-found-mem)').length);
    await ev(() => { M.otherDel(M.H.startName(__savePoint.home().key)); M.otherDel(M.H.memName('mem-fm10')); });
    ok(r.box && slots > 0, `10. 망가진 기억 파일이 있어도 슬롯 목록은 그대로 (${slots})`);
    ok(r.rows.length === 2 && r.rows.some(x => x.kind === 'now') && r.rows.some(x => x.kind === 'fail' && x.text.includes('옮기기 시작 표시')), `10. 그 기억만 읽지 못함, 연결된 기억은 그대로 (${JSON.stringify(r.rows)})`);
    ok((await writes()) === w0, '10. 쓰기 0');

    if (SHOTS) {
        await page.screenshot({ path: path.join(OUT, 'find-mem.png'), fullPage: false });
    }
    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
