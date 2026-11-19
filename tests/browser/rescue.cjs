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

    // v0.7.0-c4 (c4 design): a room held because another room of its integrity holds the memory (sameIntegrity: here, the room the copy was
    // imported from, deleted) is offered `이 방에 기억 복사해 복구` when every recorded original is this room's. After the user agrees, the
    // room gets its own copy (a branch: its own memory file, tag and clue entry); the other room's memory and tag are never touched.
    await ev(() => {
        window.__log = { ups: [] };
        const g = window.fetch;
        window.fetch = async (u, o = {}) => { if (String(u) === '/api/files/upload') window.__log.ups.push(JSON.parse(o.body).name); return g(u, o); };
        window.__mark = () => ({ ups: window.__log.ups.length, saves: (M.saveBodies || []).length, popups: (M.popups || []).length, t: toastr.log.length });
        window.__since = m => ({ ups: window.__log.ups.slice(m.ups).filter(n => /^savepoint-(mem|room|int|moved|moving|copy|start)-/.test(n)), saves: (M.saveBodies || []).length - m.saves,
            popup: (M.popups || []).slice(m.popups).join('\n'), toast: toastr.log.slice(m.t).map(x => x[1]).join(' | ') });
        window.__look = () => {
            const h = __savePoint.home();
            $('#sp_wand').trigger('click');
            return { status: h.status, why: h.why, id: h.id ?? null, h2: h.h2?.why ?? null, rescue: !!h.rescue, btn: $('[data-act="home-rescue"]').length,
                fit: $('[data-act="home-fit"]').length, stop: h.line?.stop ?? null, again: $('[data-act="home-recheck"]').length, text: $('.sp-home-alert').text(), last: __savePoint.state()?.lastIndex ?? null };
        };
        window.__files = (id, A) => JSON.stringify([M.files.get(M.H.memName(id)) ?? null, M.files.get(M.H.tagName(A)) ?? null]);
    });
    // A room `a` with a memory (10 messages, recorded), `more` messages after it, imported as `c` (`edit`: JS run on the copy's server file
    // `f`), `a` deleted, then `c` opened.
    const held = (a, c, { more = 0, edit = '' } = {}) => ev(async ([a, c, more, edit]) => {
        await M.switchChat(a, [], {}); await M.opened(); M.add(10); await __savePoint.handle('run').catch(() => {});
        if (more) M.add(more);
        for (let i = 0; i < 100 && !(__savePoint.home().status === 'linked' && __savePoint.state()?.lastIndex >= 0 && M.files.has(M.H.tagName(__savePoint.home().key))); i++) await new Promise(z => setTimeout(z, 50));
        const A = __savePoint.home().key, id = __savePoint.home().id, integrity = M.meta.integrity, last = __savePoint.state()?.lastIndex ?? null;
        M.importChat(a, c);
        if (edit) (0, eval)(`(f => { ${edit} })`)(M.serverFiles[c]);
        await M.switchChat(a + 'x', [], {}); await M.opened();
        await M.deleteChat(a);
        const m = __mark();
        await M.openFile(c); await M.opened();
        for (let i = 0; i < 40 && __savePoint.home().status === 'opening'; i++) await new Promise(z => setTimeout(z, 50));
        await new Promise(z => setTimeout(z, 200));
        const B = __savePoint.home().key;
        const now = { ...__look(), ...__since(m) };
        return { ...now, idNow: now.id, lastNow: now.last, A, B, id, integrity, last, own: M.H.homeId(B, integrity), orig: __files(id, A), m };
    }, [a, c, more, edit]);
    // Press the button: `answer` to the confirm box, `onPopup` run while it is open.
    const press = (onPopup = '', answer = 1) => ev(async ([onPopup, answer]) => {
        const m = __mark();
        M.confirm = answer;
        M.onPopup = onPopup ? async () => { await (0, eval)(`(async () => { ${onPopup} })`)(); } : null;
        await __savePoint.handle('home-rescue');
        M.onPopup = null; M.confirm = 1;
        await new Promise(z => setTimeout(z, 300));
        return { ...__look(), ...__since(m) };
    }, [onPopup, answer]);
    const recheck = () => ev(async () => { const m = __mark(); await __savePoint.handle('home-recheck'); await new Promise(z => setTimeout(z, 300)); return { ...__look(), ...__since(m) }; });
    const reopen = (id, x) => ev(async ([id, x]) => {
        const m = __mark();
        await M.switchChat(x, [], {}); await M.opened(); await M.openFile(id); await M.opened();
        await new Promise(z => setTimeout(z, 300));
        return { ...__look(), ...__since(m) };
    }, [id, x]);

    // 1. Held with the offer; cancelling writes nothing and keeps it.
    let r = await held('rsA', 'rsA imported');
    ok(r.status === 'held' && r.why === 'sameIntegrity' && r.rescue && r.btn === 1 && r.idNow === null && r.id && r.last === 9 && /이 방에 기억 복사해 복구/.test(r.text) && r.ups.length === 0 && r.saves === 0,
        `1. 지운 방의 복제본 → 보류 + 복사 복구 버튼, 쓰기 0 (${JSON.stringify(r)})`);
    let p = await press('', 0);
    ok(p.status === 'held' && p.btn === 1 && p.ups.length === 0 && p.saves === 0 && /이 방에 기억 사본을 만들어 복구할까요\?/.test(p.popup) && /#0–#9/.test(p.popup) && /rsA/.test(p.popup),
        `1. 취소 → 쓰기 0, 버튼 그대로, 확인창에 다른 방 이름·기록 범위 (${JSON.stringify(p)})`);

    // 2. Agreed: this room's own memory (a new file), its tag and clue entry; no chat write; the other room's files as they were.
    p = await press();
    let after = await ev(([id, A]) => __files(id, A), [r.id, r.A]);
    ok(p.status === 'linked' && p.id === r.own && p.id !== r.id && p.last === r.last && p.saves === 0 && /기억 사본을 만들어 연결했어요/.test(p.toast) && p.btn === 0,
        `2. 확인 → 이 방의 새 기억으로 연결, 기록 범위 그대로, 채팅 저장 0, 완료 안내 (${JSON.stringify([p.status, p.id, r.own, r.id, p.last, r.last, p.saves, p.toast, p.btn])})`);
    ok(p.ups.length > 0 && after === r.orig, `2. 원래 방의 기억 파일·이름표는 그대로 (${JSON.stringify([p.ups, after === r.orig])})`);
    let q = await reopen('rsA imported', 'rsAx2');
    ok(q.status === 'linked' && q.id === r.own && q.ups.length === 0 && q.saves === 0, `2. 다시 열면 그 사본에 그대로 연결, 쓰기 0 (${JSON.stringify(q)})`);
    // A third copy (imported from the rescued one): two rooms hold this integrity now → held, no offer.
    q = await ev(async () => { M.importChat('rsA imported', 'rsA third'); await M.openFile('rsA third'); await M.opened(); await new Promise(z => setTimeout(z, 300)); return __look(); });
    ok(q.status === 'held' && q.why === 'sameIntegrity' && !q.rescue && q.btn === 0, `2. 세 번째 복제본 → 후보 둘이라 보류, 버튼 없음 (${JSON.stringify(q)})`);

    // 3. One recorded original differs in the copy → no offer.
    r = await held('rsB', 'rsB imported', { edit: "f[4].mes = 'changed here';" });
    ok(r.status === 'held' && r.why === 'sameIntegrity' && !r.rescue && r.btn === 0 && !/복사해 복구/.test(r.text), `3. 기록 범위 원문 하나가 다름 → 버튼 없음 (${JSON.stringify(r)})`);

    // 4. The other room's memory saved elsewhere while the confirm box is open → nothing written, the offer made again.
    r = await held('rsC', 'rsC imported');
    p = await press(`const f = JSON.parse(M.files.get(M.H.memName(${JSON.stringify(r.id)}))); M.otherPut(M.H.memName(${JSON.stringify(r.id)}), M.H.nextMem(f, f.state, 'other.c4'));`);
    after = await ev(id => JSON.parse(M.files.get(M.H.memName(M.H.homeId(__savePoint.home().key, M.meta.integrity))) || 'null'), r.id);
    ok(p.status === 'held' && p.ups.length === 0 && p.saves === 0 && /바뀌어서 기억 사본을 만들지 않았어요/.test(p.toast) && after === null,
        `4. 확인창 중 원래 기억이 다른 곳에서 저장됨 → 쓰기 0, 바뀌었다는 안내 (${JSON.stringify(p)})`);
    q = await ev(() => __look());
    ok(q.btn === 1, `4. 그 뒤 새 상태로 버튼이 다시 나옴 (${JSON.stringify(q)})`);

    // 5. A SavePoint hide the memory does not cover in the copy: the copy is made, the room stops (H2) with the fit button and its own notice.
    r = await held('rsD', 'rsD imported', { more: 2, edit: "f[12].is_system = true; f[12].extra = { ...(f[12].extra || {}), savepointHidden: 1 };" });
    p = await press();
    ok(r.btn === 1 && p.status === 'linked' && p.id === r.own && p.h2 === 'hides' && p.fit === 1 && /사본을 만들어 연결했지만.*숨김이 남아 있어서/.test(p.toast) && p.saves === 0,
        `5. 기록 밖 숨김 → 사본은 만들고 멈춤(맞추기 버튼), 숨김 정리 안내 (${JSON.stringify([r.btn, p])})`);

    // 6. The tag refused: the room stops with `다시 확인`; that writes the links only (the body is not written again, the other room's memory
    //    changed meanwhile is not copied again).
    r = await held('rsE', 'rsE imported');
    await ev(() => { M.failFile = 'savepoint-room-'; M.failFileStatus = 400; });
    p = await press();
    ok(p.status !== 'linked' && p.again === 1 && !/연결했어요/.test(p.toast) && p.ups.some(n => n.startsWith('savepoint-mem-')), `6. 이름표 거절 → 연결 안 됨, 다시 확인 버튼 (${JSON.stringify(p)})`);
    await ev(id => { M.failFile = null; M.failFileStatus = null; const f = JSON.parse(M.files.get(M.H.memName(id))); M.otherPut(M.H.memName(id), M.H.nextMem(f, { ...f.state, lastIndex: 3, hashes: f.state.hashes.slice(0, 4) }, 'other.e')); }, r.id);
    q = await recheck();
    ok(q.status === 'linked' && q.id === r.own && q.last === r.last && !q.ups.some(n => n.startsWith('savepoint-mem-')) && q.ups.some(n => n.startsWith('savepoint-room-')) && q.saves === 0,
        `6. 다시 확인 → 이름표만 써서 연결, 기억 파일 다시 안 씀·원래 기억 다시 복사 안 함 (${JSON.stringify(q)})`);

    // 7. The tag got no answer: `다시 확인` writes nothing (linkLate); opening the room again finishes the links.
    r = await held('rsF', 'rsF imported');
    await ev(() => { M.failFile = 'savepoint-room-'; M.failFileStatus = 500; });
    p = await press();
    await ev(() => { M.failFile = null; M.failFileStatus = null; });
    q = await recheck();
    ok(p.status !== 'linked' && (q.status !== 'linked' || q.stop) && q.ups.length === 0 && q.saves === 0, `7. 이름표 응답 없음 → 다시 확인은 쓰기 0, 아직 저장 안 함 (${JSON.stringify([p.status, p.why, q.status, q.why, q.stop, q.ups])})`);
    q = await reopen('rsF imported', 'rsFx2');
    ok(q.status === 'linked' && !q.stop && q.id === r.own && !q.ups.some(n => n.startsWith('savepoint-mem-')) && q.saves === 0, `7. 다시 열면 이름표만 마저 써서 연결 (${JSON.stringify(q)})`);

    await page.close();
    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
