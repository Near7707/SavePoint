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
// v0.7.0-b2c: a check that no longer applies (its reason given), or one kept for b3.
const skip = (msg, why) => console.log(`SKIP  ${msg} — ${why}`);

(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(s => { window.__presetSettings = s; }, { savePoint: { firstTab: 'journal', check: false, hideMode: 'off' } });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
    await page.waitForTimeout(300);
    const ev = (fn, arg) => page.evaluate(fn, arg);

    // v0.7.4-a1 (step ②): a held room (here: the copy of a deleted room, sameIntegrity) gets its own memory from a save slot whose recorded
    // originals are this room's first messages, picked on its card (`이 방에 연결`) and agreed to. The slot and the other room are untouched.
    await ev(() => {
        window.__log = { ups: [] };
        const g = window.fetch;
        window.fetch = async (u, o = {}) => { if (String(u) === '/api/files/upload') window.__log.ups.push(JSON.parse(o.body).name); return g(u, o); };
        window.__mark = () => ({ ups: window.__log.ups.length, saves: (M.saveBodies || []).length, popups: (M.popups || []).length, t: toastr.log.length });
        window.__since = m => ({ ups: window.__log.ups.slice(m.ups).filter(n => /^savepoint-(mem|room|int|moved|moving|copy|start)-/.test(n)), saves: (M.saveBodies || []).length - m.saves,
            popup: (M.popups || []).slice(m.popups).join('\n'), toast: toastr.log.slice(m.t).map(x => x[1]).join(' | ') });
        window.__look = () => {
            const h = __savePoint.home();
            if (!__savePoint.ui.open) $('#sp_wand').trigger('click');
            __savePoint.ui.tab = 'saves'; __savePoint.render(true);
            return { status: h.status, why: h.why, id: h.id ?? null, h2: h.h2?.why ?? null, slotOk: !!h.d?.slotOk, from: h.from ?? null, links: $('[data-act="slot-link"]').map((_, b) => $(b).attr('data-id')).get(),
                note: $('.sp-slot-note').text(), fit: $('[data-act="home-fit"]').length, last: __savePoint.state()?.lastIndex ?? null, text: $('.sp-home-alert').text() };
        };
        window.__files = (id, A) => JSON.stringify([M.files.get(M.H.memName(id)) ?? null, M.files.get(M.H.tagName(A)) ?? null]);
    });
    // Room `a`: 10 messages recorded and a FILE slot `name`, `more` after it; imported as `c` (`edit`: JS on the copy's file `f`), `a` deleted, `c` opened.
    const held = (a, c, { more = 0, edit = '' } = {}) => ev(async ([a, c, more, edit]) => {
        await M.switchChat(a, [], {}); await M.opened(); M.add(10); await __savePoint.handle('run').catch(() => {});
        for (let i = 0; i < 100 && !(__savePoint.home().status === 'linked' && __savePoint.state()?.lastIndex >= 0 && M.files.has(M.H.tagName(__savePoint.home().key))); i++) await new Promise(z => setTimeout(z, 50));
        M.popupInput = 'Slot ' + a; await __savePoint.handle('save-new');
        const slot = __savePoint.listSaves().find(x => x.name === 'Slot ' + a);
        if (more) M.add(more);
        const A = __savePoint.home().key, id = __savePoint.home().id, integrity = M.meta.integrity;
        M.importChat(a, c);
        if (edit) (0, eval)(`(f => { ${edit} })`)(M.serverFiles[c]);
        await M.switchChat(a + 'x', [], {}); await M.opened();
        await M.deleteChat(a);
        const m = __mark();
        await M.openFile(c); await M.opened();
        for (let i = 0; i < 40 && __savePoint.home().status === 'opening'; i++) await new Promise(z => setTimeout(z, 50));
        await new Promise(z => setTimeout(z, 200));
        const B = __savePoint.home().key;
        return { ...__look(), ...__since(m), A, B, id, integrity, slot: slot?.id ?? null, slotFile: slot?.file ?? null, own: M.H.homeId(B, integrity), orig: __files(id, A), slotBody: slot ? M.files.get(slot.file) : null };
    }, [a, c, more, edit]);
    const press = (slot, onPopup = '', answer = 1) => ev(async ([slot, onPopup, answer]) => {
        const m = __mark();
        M.confirm = answer;
        M.onPopup = onPopup ? async () => { await (0, eval)(`(async () => { ${onPopup} })`)(); } : null;
        await __savePoint.handle('slot-link', slot);
        M.onPopup = null; M.confirm = 1;
        await new Promise(z => setTimeout(z, 300));
        return { ...__look(), ...__since(m) };
    }, [slot, onPopup, answer]);

    // 1. Held, the slot offered on its card and in the alert; cancelling writes nothing.
    let r = await held('slA', 'slA imported');
    ok(r.status === 'held' && r.why === 'sameIntegrity' && r.slotOk && r.slot && r.links.includes(r.slot) && /원문과 기록이 맞는 세이브 슬롯이 \d+개/.test(r.note) && r.ups.length === 0 && r.saves === 0,
        `1. 보류 + 맞는 슬롯 카드에 \`이 방에 연결\`, 안내 한 줄, 쓰기 0 (${JSON.stringify({ ...r, orig: 0, slotBody: 0 })})`);
    let p = await press(r.slot, '', 0);
    ok(p.status === 'held' && p.ups.length === 0 && p.saves === 0 && /이 슬롯의 기억을 이 방에 연결할까요\?/.test(p.popup) && /#0–#9/.test(p.popup) && /⏪ 되돌릴 수 없어요/.test(p.popup) && /원문과 기억 맞추기/.test(p.popup),
        `1. 취소 → 쓰기 0, 확인창에 기록 범위·⏪ 안내·숨김 안내 (${JSON.stringify(p)})`);

    // 2. Agreed: this room's own memory from the slot, its origin the slot and that copy; the other room and the slot as they were.
    p = await press(r.slot);
    let after = await ev(([id, A]) => __files(id, A), [r.id, r.A]);
    let slotNow = await ev(f => M.files.get(f), r.slotFile);
    ok(p.status === 'linked' && p.id === r.own && p.from?.slot === r.slot && typeof p.from?.print === 'string' && p.last === 9 && p.saves === 0 && /이 슬롯의 기억으로 이 방의 새 기억을 만들어 연결했어요/.test(p.toast) && p.links.length === 0,
        `2. 확인 → 이 방의 새 기억(출처: 그 슬롯·그 저장본), 기록 #9까지, 채팅 저장 0, 완료 안내 (${JSON.stringify([p.status, p.id === r.own, p.from, p.last, p.saves, p.toast, p.links])})`);
    ok(after === r.orig && slotNow === r.slotBody, `2. 원래 방 기억·이름표, 슬롯은 그대로 (${JSON.stringify([after === r.orig, slotNow === r.slotBody])})`);
    let q = await ev(async () => { const m = __mark(); await M.switchChat('slAx2', [], {}); await M.opened(); await M.openFile('slA imported'); await M.opened(); await new Promise(z => setTimeout(z, 300)); return { ...__look(), ...__since(m) }; });
    ok(q.status === 'linked' && q.id === r.own && q.ups.length === 0 && q.links.length === 0, `2. 다시 열면 그 기억에 그대로 연결, 쓰기 0, 버튼 없음 (${JSON.stringify(q)})`);

    // 3. The slot written over while the confirm box is open (same id, another copy) → nothing written, told it changed.
    r = await held('slB', 'slB imported');
    p = await press(r.slot, `const b = JSON.parse(M.files.get(${JSON.stringify(r.slotFile)})); b.saves[0].mem.scenes = []; M.otherPut(${JSON.stringify(r.slotFile)}, b);`);
    after = await ev(own => M.files.get(M.H.memName(own)) ?? null, r.own);
    ok(p.status === 'held' && p.ups.length === 0 && after === null && /바뀌어서 연결하지 않았어요/.test(p.toast),
        `3. 확인창 중 슬롯이 덮어써짐 → 쓰기 0, 바뀌었다는 안내 (${JSON.stringify(p)})`);

    // 4. Another device links this room first while the confirm box is open → that memory stays, told someone linked first (GPT P2-3).
    r = await held('slC', 'slC imported');
    p = await press(r.slot, `const f = JSON.parse(M.files.get(M.H.memName(${JSON.stringify(r.id)}))); const B = __savePoint.home().key, I = M.meta.integrity, own = M.H.homeId(B, I);
        M.otherPut(M.H.memName(own), M.H.memBody({ id: own, state: { ...f.state, roomKey: B }, wid: 'other.dev', from: { kind: 'branch', addr: B, integrity: I, slot: 'zz', print: 'pp' }, home: { addr: B, integrity: I }, copy: null }));
        M.otherPut(M.H.tagName(B), M.H.tagBody({ addr: B, integrity: I, mem: own, copy: null, prints: M.H.pickPrints(f.state.hashes), closes: [] }));`);
    ok(p.status === 'linked' && p.id === r.own && p.from?.print === 'pp' && /다른 곳에서 먼저 이 방에 기억을 연결했어요/.test(p.toast) && !/새 기억을 만들어 연결했어요/.test(p.toast) && p.ups.length === 0,
        `4. 확인창 중 다른 기기가 먼저 연결 → 그 기억 그대로, 먼저 연결했다는 안내, 쓰기 0 (${JSON.stringify(p)})`);

    // 5. A SavePoint hide after the slot's place: linked, then stopped (H2) with the fit button and its own notice.
    r = await held('slD', 'slD imported', { more: 2, edit: "f[11].is_system = true; f[11].extra = { ...(f[11].extra || {}), savepointHidden: 1 };" });
    p = await press(r.slot);
    ok(r.links.includes(r.slot) && p.status === 'linked' && p.id === r.own && p.h2 === 'hides' && p.fit === 1 && /연결했지만.*숨김이 남아 있어서/.test(p.toast),
        `5. 슬롯 뒤 숨김 → 연결 후 멈춤(맞추기 버튼), 숨김 정리 안내 (${JSON.stringify(p)})`);

    // 6. A recorded original changed in the copy → the slot does not fit: no button.
    r = await held('slE', 'slE imported', { edit: "f[4].mes = 'changed here';" });
    ok(r.status === 'held' && r.slotOk && !r.links.includes(r.slot) && r.note === '', `6. 기록 범위 원문이 다름 → 버튼·안내 없음 (${JSON.stringify({ ...r, orig: 0, slotBody: 0 })})`);

    // 7. A linked room: no `이 방에 연결` anywhere.
    q = await ev(async () => { await M.switchChat('slF', [], {}); await M.opened(); M.add(4); await new Promise(z => setTimeout(z, 300)); return __look(); });
    ok(q.status !== 'held' && q.links.length === 0, `7. 보류가 아닌 방 → 버튼 없음 (${JSON.stringify(q)})`);

    // 8. Like a rescue copy (c4a), the memory made from a slot is checked against the chat file read after it was written: that read failing
    //    → readFail with its own notice, no done notice, the memory made stays; `다시 확인` then links it (row 6/3), the slot is not read again.
    await ev(() => {
        const g = window.fetch;
        window.__slHook = null;
        window.fetch = async (u, o = {}) => {
            const k = window.__slHook;
            if (k?.armed && String(u) === '/api/chats/get') { k.armed = false; k.failed = true; return new Response('{}', { status: 500 }); }
            const res = await g(u, o);
            if (k && !k.armed && !k.failed && String(u) === '/api/files/upload' && JSON.parse(o.body).name.startsWith('savepoint-mem-')) k.armed = true;
            return res;
        };
    });
    r = await held('slG', 'slG imported');
    await ev(() => { window.__slHook = { armed: false, failed: false }; });
    p = await press(r.slot);
    const hook = await ev(() => { const k = window.__slHook; window.__slHook = null; return k; });
    after = await ev(own => !!M.files.get(M.H.memName(own)), r.own);
    ok(hook.failed && p.status === 'readFail' && after && /만든 뒤 채팅 파일을 다시 확인하지 못해서/.test(p.toast) && !/새 기억을 만들어 연결했어요/.test(p.toast),
        `8. 만든 뒤 채팅 파일 다시 읽기 실패 → 읽기 실패 상태, 따로 안내, 완료 안내 없음 (${JSON.stringify([hook, p.status, after, p.toast])})`);
    q = await ev(async () => { const m = __mark(); await __savePoint.handle('home-recheck'); await new Promise(z => setTimeout(z, 300)); return { ...__look(), ...__since(m) }; });
    ok(q.status === 'linked' && q.id === r.own && q.from?.slot === r.slot && q.last === 9, `8. \`다시 확인\` → 만든 기억에 연결 (${JSON.stringify(q)})`);

    console.log(failures ? `\n${failures} FAIL` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
