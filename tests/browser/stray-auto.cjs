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

// v0.7.3-a1 (v0.7.1 step 5): an AUTO marked with a memory write the memory file (as read on opening) does not show → one notice
// per tab and a badge on that AUTO card; nothing read, saved or blocked for it.
// 0 an AUTO after a confirmed write carries its mark (memory id, rev, receipt) · 1 opened again unchanged: no notice
// · 2 another device wrote the same rev over ours: notice once, badge, no backup written by the opening · 3 opened again: no second notice,
// badge still there · 4 this page's own AUTO made after opening is not checked against that opening · 5 AUTOs without a mark (older
// versions): silent · 6 a write not read back: its AUTO carries no mark.
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
        window.__slotWrites = 0;
        const f = window.fetch;
        window.fetch = (u, o) => {
            if (String(u) === '/api/files/upload') { try { if (/^savepoint-(auto|index|quick|slot)/.test(JSON.parse(o.body).name)) window.__slotWrites++; } catch { /* not json */ } }
            return f(u, o);
        };
    });
    const slotWrites = () => ev(() => window.__slotWrites);
    const notices = () => ev(() => toastr.log.filter(x => x[1].includes('다른 저장본이 백업에 남아')).length);
    const autos = () => ev(() => { const rh = __savePoint.vault.entries.find(e => e.auto)?.roomHash; return __savePoint.vault.entries.filter(e => e.auto && e.roomHash === rh).sort((a, b) => b.updated - a.updated).map(e => ({ id: e.id, mark: e.memMark ?? null })); });
    const reopen = async () => { const at = await ev(() => __savePoint.home().at); await wait(5); await ev(() => M.openFile(M.chatId)); await ev(() => M.opened()); await wait(200); return (await ev(() => __savePoint.home().at)) !== at; };
    const badges = async () => { await ev(() => { if (!__savePoint.ui.open) $('#sp_wand').trigger('click'); __savePoint.handle('tab', 'saves'); }); await wait(150); return ev(() => [...document.querySelectorAll('#sp_overlay .sp-save')].filter(c => c.querySelector('.sp-stray')).map(c => c.querySelector('[data-act="load"]')?.dataset.id)); };
    const save = async n => { await ev(k => { M.add(k); if (!__savePoint.ui.open) $('#sp_wand').trigger('click'); }, n); await ev(() => __savePoint.handle('run')); await wait(1500); await wait(1700); };
    let r;

    // 0. a confirmed save → its AUTO carries the mark of the write
    await save(8);
    const seen = await ev(() => ({ id: __savePoint.home().id, rev: __savePoint.home().line.seen.rev, wid: __savePoint.home().line.seen.wid, status: __savePoint.home().status }));
    r = await autos();
    ok(seen.status === 'linked' && r.length === 1 && JSON.stringify(r[0].mark) === JSON.stringify({ id: seen.id, rev: seen.rev, wid: seen.wid }), `0. AUTO에 기억 ID·번호·영수증 표식 (${JSON.stringify(r)})`);
    const first = r[0].id;

    // 1. opened again, nothing changed → nothing
    ok(await reopen(), '1. 방을 다시 엶(새 열기)');
    ok((await notices()) === 0 && (await ev(() => __savePoint.home().stray?.length ?? -1)) === 0, '1. 바뀐 것 없으면 안내 없음');
    ok((await badges()).length === 0, '1. 카드 표시 없음');

    // 2. another device wrote the same rev over ours (its own receipt), then the room is opened again
    await ev(() => {
        const d = M.memDoc(), wid = 'other-device';
        const next = { ...d, wid, recent: [...d.recent.slice(0, -1), { rev: d.rev, wid }], state: { ...d.state, wid } };
        M.otherPut(M.H.memName(d.id), next);
    });
    let w0 = await slotWrites();
    ok(await reopen(), '2. 방을 다시 엶');
    r = await ev(() => ({ status: __savePoint.home().status, stray: __savePoint.home().stray }));
    ok(r.status === 'linked' && JSON.stringify(r.stray) === JSON.stringify([first]), `2. 덮인 AUTO 하나가 후보 (${JSON.stringify(r)})`);
    ok((await notices()) === 1, '2. 안내 한 번');
    ok(JSON.stringify(await badges()) === JSON.stringify([first]), '2. 그 AUTO 카드에만 다른 저장본 표시');
    ok((await slotWrites()) === w0, '2. 열기·안내로 백업 쓰기 0');
    ok(await ev(() => !__savePoint.gate().unsure && __savePoint.roomStatus().kind === 'linked'), '2. 저장을 막지 않음(상태 그대로 연결됨)');

    // 3. opened again: told once per tab, the badge stays
    ok(await reopen(), '3. 방을 다시 엶');
    ok((await notices()) === 1, '3. 같은 탭에서 안내는 다시 안 뜸');
    ok(JSON.stringify(await badges()) === JSON.stringify([first]), '3. 카드 표시는 남음');

    // 4. this page's own AUTO after opening is not checked against that opening
    await save(2);
    r = await autos();
    ok(r.length === 2 && !!r[0].mark && r[0].mark.rev > (await ev(() => __savePoint.home().opened.rev)), `4. 새 AUTO(이 열기 뒤)에도 표식 (${JSON.stringify(r)})`);
    await ev(() => { __savePoint.home().strayDone = false; __savePoint.render(); });
    ok(JSON.stringify(await ev(() => __savePoint.home().stray)) === JSON.stringify([first]), '4. 열기 뒤 이 페이지가 만든 AUTO는 후보 아님');
    ok((await notices()) === 1, '4. 안내 다시 안 뜸');

    // 5. AUTOs without a mark (made by an older version): silent
    await ev(() => { for (const e of __savePoint.vault.entries) delete e.memMark; });
    ok(await reopen(), '5. 방을 다시 엶');
    ok((await ev(() => __savePoint.home().stray.length)) === 0 && (await badges()).length === 0, '5. 표식 없는 AUTO는 조용히 넘어감');

    // 6. a write answered but not read back (unread): its AUTO carries no mark
    await ev(() => { M.beforeUpload = async name => { if (name.startsWith('savepoint-mem-')) M.fileState[name] = 'error'; }; });
    await save(2);
    await ev(() => { M.beforeUpload = null; M.fileState = {}; });
    r = await autos();
    ok(r.length === 3 && r[0].mark === null, `6. 다시 읽어 확인 못 한 저장의 AUTO는 표식 없음 (${JSON.stringify(r[0])})`);

    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
