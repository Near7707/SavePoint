const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const EXT = process.env.EXT || path.resolve(__dirname, '../..');
const HERE = __dirname;

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


// v0.6.101: chat metadata keys SavePoint does not own (another extension's state, here a made-up `extState`) are sent as
// the file last read has them, and no longer stop a write. Such an extension may change its key on the page and save it
// later, or never (until SillyTavern saves the page): v0.6.59–0.6.100 blocked the room ("채팅 정보 … 화면과 달라요").
// 1. Right after a room opens (no file confirmed yet) the extension fixes its key on the page and adds one: the save goes
//    through; the file keeps its own value, the page-only key is not written, the page keeps its values.
// 2. Another device changed the key in the file: SavePoint keeps that value (never the page's).
// 3. A key only the file has stays in the file.
// 4. `tainted` and `integrity` are still compared: a file with `tainted` the page lacks blocks the room.
// 5. The copy sent (not the page) is the copy SavePoint knows as its own: it landed after SillyTavern's newer save
//    (the file is that copy, the page edited #3 since), so the page goes on and the edit is sent again.
// 6. A failed write later confirmed: the file equals what SavePoint would send now → no longer unconfirmed.
// 7. (v0.6.102) A read answered after SillyTavern saved a newer value of such a key is read again, so that value stays.
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    async function session() {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: 'off' } }; });
        await page.goto(URL);
        await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
        await page.waitForTimeout(300);
        const ev = (fn, arg) => page.evaluate(fn, arg);
        return { page, ev };
    }
    // Opens room `id` with `extState: { v: 1 }` in its file and on the page; `fix` runs on the page at once (before the
    // room's first check, like an extension reacting to the room opening).
    const openRoom = (ev, id, fileMeta = {}) => ev(([id, fileMeta]) => {
        const list = []; for (let i = 0; i < 13; i++) list.push(i ? { name: i % 2 ? 'Me' : 'Ay', is_user: i % 2 === 1, is_system: false, mes: `Message ${i} words words words.`, swipe_id: 0, extra: {} } : { name: 'Ay', is_user: false, is_system: false, mes: 'Hello there', swipe_id: 0, extra: {} });
        const meta = { integrity: `i-${id}`, extState: { v: 1 } };
        M.serverFiles[id] = JSON.parse(JSON.stringify([{ chat_metadata: { ...meta, ...fileMeta } }, ...list]));
        M.switchChat(id, JSON.parse(JSON.stringify(list)), JSON.parse(JSON.stringify(meta)));
        M.meta.extState.fix = [];          // the extension fixes its key on the page and does not save it
        M.meta.pageOnly = 5;               // and adds one the file never had
    }, [id, fileMeta]);
    const run = async (ev, page) => { const r = await ev(() => __savePoint.handle('run').then(() => 'ok', e => `${e.name}: ${e.message}`)); await page.waitForTimeout(800); return r; };
    const look = (ev, id) => ev(id => { const m = M.serverFiles[id][0].chat_metadata; return {
        saved: m.savePoint?.lastIndex ?? null, ext: JSON.stringify(m.extState), pageOnly: Object.hasOwn(m, 'pageOnly'), fileOnly: m.fileOnly ?? null,
        pageExt: JSON.stringify(M.meta.extState), blocked: __savePoint.autoBlocked(), t: toastr.log.map(x => x[1]).join(' | ').slice(0, 160) }; }, id);

    {   // 1, 3
        const { page, ev } = await session();
        await openRoom(ev, 'roomF', { fileOnly: 'kept' });
        await page.waitForTimeout(600);
        const r1 = await run(ev, page), r = await look(ev, 'roomF');
        ok(r1 === 'ok' && r.saved === 12 && r.ext === '{"v":1}' && !r.pageOnly && r.pageExt === '{"v":1,"fix":[]}' && !['room', 'unsure'].includes(r.blocked) && !/채팅 정보/.test(r.t),
            `1. 방을 연 직후 다른 확장이 화면에서 키를 고쳐도 저장됨, 파일 값 유지·화면에만 있는 키는 안 씀 (${r1.slice(0, 40)}, ${JSON.stringify(r)})`);
        ok(r.fileOnly === 'kept', `3. 파일에만 있는 키는 그대로 남음 (${r.fileOnly})`);
        // A second save after SillyTavern saved the page (the extension's value is in the file now) keeps that value too.
        await ev(() => { M.stSave(); M.add(2); });
        await page.waitForTimeout(300);
        const r2 = await run(ev, page), q = await look(ev, 'roomF');
        ok(r2 === 'ok' && q.saved === 14 && q.ext === '{"v":1,"fix":[]}' && q.pageOnly && !['room', 'unsure'].includes(q.blocked), `1b. 실리태번이 화면을 저장한 뒤의 저장은 그 값을 유지 (${JSON.stringify(q)})`);
        await page.close();
    }
    {   // 2
        const { page, ev } = await session();
        await openRoom(ev, 'roomG');
        await page.waitForTimeout(600);
        await ev(() => { M.serverFiles.roomG[0].chat_metadata.extState = { v: 9 }; });
        const r1 = await run(ev, page), r = await look(ev, 'roomG');
        ok(r1 === 'ok' && r.saved === 12 && r.ext === '{"v":9}' && r.pageExt === '{"v":1,"fix":[]}', `2. 다른 기기가 파일에서 바꾼 값은 덮지 않음 (${r1.slice(0, 40)}, ${JSON.stringify(r)})`);
        await page.close();
    }
    {   // 4
        const { page, ev } = await session();
        await openRoom(ev, 'roomH', { tainted: true });
        await page.waitForTimeout(600);
        const r1 = await run(ev, page), r = await look(ev, 'roomH');
        ok(r.saved === null && r.blocked === 'room' && /tainted/.test(r1 + r.t), `4. tainted는 여전히 비교해서 막음 (${r1.slice(0, 80)}, ${JSON.stringify(r)})`);
        await page.close();
    }
    {   // 5
        const { page, ev } = await session();
        await openRoom(ev, 'roomI');
        await page.waitForTimeout(600);
        // 🔶 on #3: right after SavePoint's copy lands, the page edits #5 and SillyTavern starts saving (it never lands
        // here: the file stays SavePoint's copy). The resend finds the file is its own copy and sends the edit too.
        await ev(() => { M.noStSave = true; const f = window.fetch; let k = 0;
            window.fetch = async (u, o) => { const r = await f(u, o); if (String(u) === '/api/chats/save' && ++k === 1) {
                M.chat[5].mes = 'Edited after the copy left.'; M.stScript.setChatSaving(true); setTimeout(() => M.stScript.setChatSaving(false), 150); } return r; }; });
        const r1 = await ev(() => __savePoint.toggleKeep(3).then(() => 'ok', e => `${e.name}: ${e.message}`));
        await page.waitForTimeout(800);
        const r = await look(ev, 'roomI'), f = await ev(() => ({ mes: M.serverFiles.roomI[6].mes, keep: !!M.serverFiles.roomI[4].extra?.savepointKeep }));
        ok(r1 === 'ok' && f.mes === 'Edited after the copy left.' && f.keep && r.ext === '{"v":1}' && !['room', 'unsure'].includes(r.blocked),
            `5. 보낸 사본이 내 사본: 실리태번 저장 중 편집까지 다시 보냄 (${r1.slice(0, 60)}, ${JSON.stringify(f)}, ${JSON.stringify(r)})`);
        await page.close();
    }
    {   // 6
        const { page, ev } = await session();
        await openRoom(ev, 'roomJ');
        await page.waitForTimeout(600);
        // The write gets SillyTavern's 500 and the read after it fails: unconfirmed. Then SillyTavern saves the page, and
        // the extension changes its key on the page again. The file is what SavePoint would send now: confirmed.
        await ev(() => { M.noStSave = true; M.failOnce = true; const f = window.fetch; let after = false, k = 0;
            window.fetch = async (u, o) => { if (String(u) === '/api/chats/save') after = true;
                else if (after && String(u) === '/api/chats/get' && ++k === 1) return new Response('x', { status: 500 });
                return f(u, o); }; });
        const r1 = await run(ev, page);
        const u = await ev(() => __savePoint.autoBlocked());
        await ev(() => { M.failOnce = false; M.noStSave = false; M.stSave(); M.noStSave = true; M.meta.extState.fix2 = true; toastr.log.length = 0; });
        const r2 = await ev(() => __savePoint.toggleKeep(3).then(() => 'ok', e => `${e.name}: ${e.message}`));
        await page.waitForTimeout(800);
        const r = await look(ev, 'roomJ');
        ok(u === 'unsure' && r2 === 'ok' && !['room', 'unsure'].includes(r.blocked) && r.ext === '{"v":1,"fix":[]}', `6. 미확인 뒤 파일이 SavePoint가 보낼 내용과 같으면 확인 (${u}, ${r2.slice(0, 60)}, ${JSON.stringify(r)})`);
        await page.close();
    }
    {   // 7
        const { page, ev } = await session();
        await openRoom(ev, 'roomK');
        await page.waitForTimeout(600);
        // v0.6.102 (review P2): the file is read with { v: 1 }; before that answer comes back, SillyTavern saves the page
        // with the extension's new value { v: 2 } and is done. That read is stale: SavePoint reads again and keeps { v: 2 }.
        await ev(() => { M.meta.extState = { v: 2 }; const f = window.fetch; let armed = true;
            window.fetch = async (u, o) => { const r = await f(u, o);
                if (armed && String(u) === '/api/chats/get') { armed = false; const body = await r.text(); M.stSave(); return new Response(body, { status: 200 }); }
                return r; }; });
        const r1 = await run(ev, page), r = await look(ev, 'roomK');
        ok(r1 === 'ok' && r.saved === 12 && r.ext === '{"v":2}' && !['room', 'unsure'].includes(r.blocked), `7. 읽는 사이 실리태번이 저장한 새 값을 옛 값으로 되돌리지 않음 (${r1.slice(0, 60)}, ${JSON.stringify(r)})`);
        await page.close();
    }
    await browser.close(); srv.close();
    console.log(failures ? `${failures} FAILED` : 'ALL PASS');
    process.exit(failures ? 1 : 0);
})();
