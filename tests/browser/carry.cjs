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

    // v0.7.0-b4a (b4 design): a personal chat renamed A → B in the chat list (the room not open) is held (renameUnproven). When that rename is
    // the one direct record to B, A's tag links a memory at home at A, nothing links B yet and the chat list shows A gone and B there, the
    // hold offers `이름 변경 이어서 연결`; the move is made after the user agrees, the chat list read again right before it. No chat file write.
    await ev(() => {
        // What this page sent: uploads of the rooms' memory files (a room left also gets its AUTO backup), chat saves, chat list reads.
        window.__log = { ups: [], lists: 0 };
        const g = window.fetch;
        window.fetch = async (u, o = {}) => {
            if (String(u) === '/api/files/upload') window.__log.ups.push(JSON.parse(o.body).name);
            if (String(u) === '/api/characters/chats') { window.__log.lists++; if (window.__listHook) { const x = await window.__listHook(window.__log.lists); if (x) return x; } }
            return g(u, o);
        };
        window.__mark = () => ({ ups: window.__log.ups.length, saves: (M.saveBodies || []).length, lists: window.__log.lists, popups: (M.popups || []).length });
        window.__since = m => ({ ups: window.__log.ups.slice(m.ups).filter(n => /^savepoint-(mem|room|int|moved|moving|copy)-/.test(n)), saves: (M.saveBodies || []).length - m.saves, lists: window.__log.lists - m.lists, popup: (M.popups || []).slice(m.popups).pop() || '' });
        window.__look = () => {
            const h = __savePoint.home();
            $('#sp_wand').trigger('click');
            return { status: h.status, why: h.why, d: h.d?.verdict, carry: !!h.carry, btn: $('[data-act="home-carry"]').length, text: $('.sp-home-alert').text() };
        };
    });
    // A room with a memory (10 recorded) at `a`, left for another room, renamed in the list to `b`, then `b` opened.
    // `between(A, B)`: run after the rename, before `b` is opened.
    const listRoom = (a, b, between = '') => ev(async ([a, b, between]) => {
        await M.switchChat(a, [], {}); await M.opened(); M.add(10); await __savePoint.handle('run').catch(() => {});
        const A = __savePoint.home().key, id = __savePoint.home().id, st = __savePoint.state();
        await M.switchChat(a + 'x', [], {}); await M.opened();
        await M.renameChat(a, b);
        const B = JSON.stringify([M.charKey(), b]);
        if (between) await (0, eval)(`(async (A, B, a, b) => { ${between} })`)(A, B, a, b);
        const m = __mark();
        await M.openFile(b); await M.opened();
        for (let i = 0; i < 40 && !__savePoint.home().carry; i++) await new Promise(z => setTimeout(z, 50));
        await new Promise(z => setTimeout(z, 200));
        return { A, B, id, last: st?.lastIndex ?? null, at: st?.lastRecord?.at ?? null, m, ...__look(), ...__since(m) };
    }, [a, b, between]);
    // Press the button with `onPopup` (JS run while the confirm box is open) and the answer `answer`.
    const press = (onPopup = '', answer = 1) => ev(async ([onPopup, answer]) => {
        toastr.log.length = 0;
        M.confirm = answer;
        M.onPopup = onPopup ? (0, eval)(`(async () => { ${onPopup} })`) : null;
        const n = M.fileLog.length, m = __mark();
        try { await __savePoint.handle('home-carry'); } finally { M.onPopup = null; M.confirm = 1; }
        await M.opened(); await new Promise(z => setTimeout(z, 300)); await M.opened();
        const h = __savePoint.home();
        return { ...__look(), ...__since(m), puts: M.fileLog.slice(n).filter(x => x[0] === 'put' && /^savepoint-(mem|room|int|moved|moving|copy)-/.test(x[1])).map(x => x[1]), toast: toastr.log.map(x => x[1]).join(' | '), key: h.key };
    }, [onPopup, answer]);
    const memAt = (id, A, B) => ev(([id, A, B]) => { const b = JSON.parse(M.files.get(M.H.memName(id))); return { at: b.home.addr === B ? 'B' : b.home.addr === A ? 'A' : b.home.addr, was: b.home.was || [], rev: b.rev,
        tagB: M.files.has(M.H.tagName(B)), tagA: JSON.parse(M.files.get(M.H.tagName(A)) || 'null')?.state ?? null }; }, [id, A, B]);

    // 1. The plain A → B: held with the offer; cancelling writes nothing; agreeing moves the memory (no chat save), then saves go on.
    let r = await listRoom('chatC1', 'chatC1b');
    ok(r.status === 'held' && r.why === 'renameUnproven' && r.carry && r.btn === 1 && r.lists >= 1 && r.text.includes('이름 변경 이어서 연결') && !r.ups.length && r.saves === 0,
        `1. 목록에서 A → B: 보류 + 이어서 연결 버튼, 채팅 목록 읽기만 (${JSON.stringify({ ...r, text: r.text.slice(0, 40) })})`);
    const one = r;
    r = await press('', 0);
    ok(r.status === 'held' && r.carry && !r.ups.length && !r.puts.length && r.saves === 0 && r.popup.includes('chatC1') && r.popup.includes('chatC1b') && r.popup.includes('#0–#9')
        && r.popup.includes('이 기억을 현재 방에 연결합니다') && r.popup.includes('마지막 대화 기록'),
        `1. 확인창(예전·지금 이름, #0–#9, 마지막 기록 시각) 취소 → 파일 쓰기 0 (${JSON.stringify({ ...r, text: '' })})`);
    r = await press();
    let m = await memAt(one.id, one.A, one.B);
    ok(r.status === 'linked' && m.at === 'B' && m.was.includes(one.A) && m.tagB && m.tagA === 'renamed' && r.saves === 0 && r.lists >= 2 && r.toast.includes('이어서 이 방에 기억을 연결했어요'),
        `1. 확인 → 목록 다시 읽고 기억을 B로 옮김, 이름표 B·A 표시, 채팅 저장 0 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    r = await ev(async () => { M.add(2); await __savePoint.handle('run').catch(() => {}); return { last: __savePoint.state()?.lastIndex, file: M.mem()?.lastIndex, status: __savePoint.home().status }; });
    ok(r.last === 11 && r.file === 11 && r.status === 'linked', `1. 그 뒤 세이브 평소대로 (${JSON.stringify(r)})`);

    // 2. An empty file still under the old name (the list names files, not their contents): no offer.
    r = await listRoom('chatC2', 'chatC2b', `M.serverFiles[a] = [];`);
    ok(r.status === 'held' && r.why === 'renameUnproven' && !r.carry && r.btn === 0 && r.lists >= 1 && !r.ups.length && r.saves === 0,
        `2. 예전 이름에 빈 파일이 남음 → 버튼 없음, 쓰기 0 (${JSON.stringify({ ...r, text: '' })})`);
    // 2b. An imported copy taking the old name (same integrity, same messages): no offer either.
    r = await listRoom('chatC3', 'chatC3b', `M.serverFiles[a] = JSON.parse(JSON.stringify(M.serverFiles[b]));`);
    ok(r.status === 'held' && !r.carry && r.btn === 0 && !r.ups.length && r.saves === 0, `2b. 예전 이름을 가져간 사본(같은 고유값·원문) → 버튼 없음 (${JSON.stringify({ ...r, text: '' })})`);

    // 3. The chat list cannot be read (500, an error answer, an empty list, not a list of file names): no offer.
    for (const [tag, js] of [['500', `new Response('down', { status: 500 })`], ['error', `new Response(JSON.stringify({ error: true }))`], ['empty', `new Response('[]')`], ['odd', `new Response(JSON.stringify([{ name: 'x' }]))`]]) {
        r = await listRoom('chatC4' + tag, 'chatC4' + tag + 'b', `window.__listHook = async () => ${js};`);
        await ev(() => { window.__listHook = null; });
        ok(r.status === 'held' && !r.carry && r.btn === 0 && r.lists >= 1 && !r.ups.length && r.saves === 0, `3. 채팅 목록 읽기 ${tag} → 버튼 없음, 쓰기 0 (${JSON.stringify({ ...r, text: '' })})`);
    }
    // 3b. Offered, then the list read after agreeing fails: nothing written, held.
    r = await listRoom('chatC5', 'chatC5b');
    const five = r;
    r = await press(`window.__listHook = async () => new Response('down', { status: 500 });`);
    await ev(() => { window.__listHook = null; });
    m = await memAt(five.id, five.A, five.B);
    ok(five.carry && r.status === 'held' && !r.ups.length && !r.puts.length && r.saves === 0 && m.at === 'A' && !m.tagB && r.toast.includes('채팅 목록을 읽지 못해서'),
        `3b. 확인 뒤 목록 읽기 실패 → 쓰기 0, 기억 A에 그대로 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);

    // 4. The old name made again while the box is open: nothing written.
    r = await listRoom('chatC6', 'chatC6b');
    const six = r;
    r = await press(`M.serverFiles['chatC6'] = [{ chat_metadata: { integrity: 'new-c6' } }];`);
    m = await memAt(six.id, six.A, six.B);
    ok(six.carry && r.status === 'held' && !r.carry && !r.ups.length && !r.puts.length && r.saves === 0 && m.at === 'A' && r.toast.includes('예전 이름의 채팅이 아직 보이거나'),
        `4. 확인창 중 예전 이름 다시 생김 → 쓰기 0, 버튼 내림 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    // 4b. Made again later, after the check of the button and before the move (the list read right before it): nothing written, held.
    r = await listRoom('chatC7', 'chatC7b');
    const seven = r;
    r = await press(`window.__listHook = async n => { if (n === ${seven.m.lists + 2 + 1}) M.serverFiles['chatC7'] = [{ chat_metadata: { integrity: 'new-c7' } }]; return null; };`);
    await ev(() => { window.__listHook = null; });
    m = await memAt(seven.id, seven.A, seven.B);
    ok(seven.carry && r.status === 'held' && r.why === 'carryGone' && !r.ups.length && !r.puts.length && r.saves === 0 && m.at === 'A' && !m.tagB,
        `4b. 옮기기 직전 목록에서 예전 이름 다시 보임 → 쓰기 0, 보류 (${JSON.stringify({ r: { ...r, text: '' }, m, lists: seven.m.lists })})`);

    // 5. Moved to another room while the box is open: nothing written; back in B the offer is there again.
    r = await listRoom('chatC8', 'chatC8b');
    const eight = r;
    r = await press(`await M.switchChat('chatC8x', [], {}); await M.opened();`);
    ok(eight.carry && !r.ups.length && !r.puts.length && r.saves === 0 && r.toast.includes('다른 방으로 옮겨서'), `5. 확인창 중 방 이동 → 쓰기 0 (${JSON.stringify({ ...r, text: '' })})`);
    r = await ev(async () => { await M.openFile('chatC8b'); await M.opened(); for (let i = 0; i < 40 && !__savePoint.home().carry; i++) await new Promise(z => setTimeout(z, 50)); return __look(); });
    ok(r.status === 'held' && r.carry && r.btn === 1, `5. 다시 B를 열면 버튼 그대로 (${JSON.stringify({ ...r, text: '' })})`);

    // 6. The memory saved elsewhere while the box is open (another receipt): not moved by this consent; held, offered again.
    r = await listRoom('chatC9', 'chatC9b');
    const nine = r;
    r = await press(`const id = ${JSON.stringify(nine.id)}, d = JSON.parse(M.files.get(M.H.memName(id)));
        M.otherPut(M.H.memName(id), { ...d, rev: d.rev + 1, wid: 'other.c9', recent: [...d.recent, { rev: d.rev + 1, wid: 'other.c9' }] });`);
    m = await memAt(nine.id, nine.A, nine.B);
    ok(nine.carry && r.status === 'held' && r.why === 'renameUnproven' && !r.ups.length && !r.puts.length && r.saves === 0 && m.at === 'A' && r.toast.includes('기억이 바뀌어서'),
        `6. 확인창 중 다른 곳에서 기억 저장 → 이번 동의로 안 옮김, 쓰기 0 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    r = await ev(async () => { for (let i = 0; i < 40 && !__savePoint.home().carry; i++) await new Promise(z => setTimeout(z, 50)); return { ...__look(), rev: __savePoint.home().carry?.rev }; });
    ok(r.carry && r.rev === m.rev, `6. 새 영수증으로 다시 물어봄 (${JSON.stringify({ ...r, text: '' })})`);

    // 7. Another tab finishes the same move while the box is open (body at B, B's tag, A's tag renamed): read and linked, nothing written here.
    r = await listRoom('chatC10', 'chatC10b');
    const ten = r;
    r = await press(`const id = ${JSON.stringify(ten.id)}, A = ${JSON.stringify(ten.A)}, B = ${JSON.stringify(ten.B)}, d = JSON.parse(M.files.get(M.H.memName(id))), t = JSON.parse(M.files.get(M.H.tagName(A)));
        M.otherPut(M.H.memName(id), { ...d, rev: d.rev + 1, wid: 'other.c10', recent: [...d.recent, { rev: d.rev + 1, wid: 'other.c10' }], home: { addr: B, integrity: d.home.integrity, was: [A] }, closes: [] });
        M.otherPut(M.H.tagName(B), M.H.tagBody({ addr: B, integrity: t.integrity, mem: id }));
        M.otherPut(M.H.tagName(A), M.H.renamedTag(t, B));`);
    ok(ten.carry && r.status === 'linked' && r.d === 'link' && !r.ups.length && !r.puts.length && r.saves === 0, `7. 확인창 중 다른 탭이 이동을 끝냄 → 읽어서 연결만, 쓰기 0 (${JSON.stringify({ ...r, text: '' })})`);
    // 7b. Another tab half way (body moved, no tag at B yet): not picked up by this consent; held, no offer.
    r = await listRoom('chatC11', 'chatC11b');
    const eleven = r;
    r = await press(`const id = ${JSON.stringify(eleven.id)}, A = ${JSON.stringify(eleven.A)}, B = ${JSON.stringify(eleven.B)}, d = JSON.parse(M.files.get(M.H.memName(id)));
        M.otherPut(M.H.memName(id), { ...d, rev: d.rev + 1, wid: 'other.c11', recent: [...d.recent, { rev: d.rev + 1, wid: 'other.c11' }], home: { addr: B, integrity: d.home.integrity, was: [A] }, closes: [] });`);
    ok(eleven.carry && r.status === 'held' && r.why === 'renameUnproven' && !r.carry && !r.ups.length && !r.puts.length && r.saves === 0,
        `7b. 확인창 중 다른 탭이 이동 중간 → 보류, 버튼 없음, 쓰기 0 (${JSON.stringify({ ...r, text: '' })})`);

    // 8. Renamed twice in the list (A → B → C: the record now reads A → C, not direct): no offer.
    r = await ev(async () => {
        await M.switchChat('chatC12', [], {}); await M.opened(); M.add(10); await __savePoint.handle('run').catch(() => {});
        await M.switchChat('chatC12x', [], {}); await M.opened();
        await M.renameChat('chatC12', 'chatC12b'); await M.renameChat('chatC12b', 'chatC12c');
        const rec = M.settings.savePoint.renames.filter(x => x.to === JSON.stringify([M.charKey(), 'chatC12c']));
        await M.openFile('chatC12c'); await M.opened(); await new Promise(z => setTimeout(z, 600));
        return { ...__look(), recs: rec.length, direct: rec.map(x => !!x.direct) };
    });
    ok(r.status === 'held' && r.why === 'renameUnproven' && !r.carry && r.btn === 0, `8. 목록에서 두 번 바꿈(A → B → C) → 버튼 없음 (${JSON.stringify({ ...r, text: '' })})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
