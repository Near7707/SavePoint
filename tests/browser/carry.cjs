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

    // v0.7.0-b4a1 (review of b4a). P1: another link made at B after the last list read, before the body is written (a tag of another memory,
    // or a clue entry): nothing written, the memory left at A, A's tag untouched.
    const atMove = js => `window.__base = window.__log.lists; window.__listHook = async n => { if (n === window.__base + 2) { ${js} } return null; };`;
    for (const [tag, js] of [['tag', `M.otherPut(M.H.tagName(B), M.H.tagBody({ addr: B, integrity: M.meta.integrity, mem: 'mem-other-' + b }));`],
        ['clue', `M.otherPut(M.H.clueName(M.meta.integrity), M.H.clueBody(M.meta.integrity, [{ addr: B, mem: 'mem-other-' + b }]));`]]) {
        r = await listRoom('chatD' + tag, 'chatD' + tag + 'b');
        const x = r;
        r = await press(atMove(`const B = ${JSON.stringify(x.B)}, b = ${JSON.stringify('chatD' + tag + 'b')}; ${js}`));
        await ev(() => { window.__listHook = null; });
        m = await memAt(x.id, x.A, x.B);
        ok(x.carry && r.status === 'held' && r.why === 'carryChanged' && !r.ups.length && !r.puts.filter(n => !n.includes('mem-other')).length && r.saves === 0 && m.at === 'A' && m.tagA === 'linked',
            `9. (b4a1) 옮기기 직전 B에 다른 연결(${tag}) → 본체 쓰기 0, 기억·A 이름표 그대로 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    }
    // P2: the page moves to another room while the body is read again (writeMem's read, after the last list read): nothing uploaded.
    r = await listRoom('chatD2', 'chatD2b');
    const d2 = r;
    r = await press(`window.__base = window.__log.lists; const name = '/user/files/' + M.H.memName(${JSON.stringify(d2.id)}), g = window.fetch; let done = false;
        window.fetch = async (u, o) => { if (!done && window.__log.lists >= window.__base + 2 && String(u).startsWith(name)) { done = true; const res = await g(u, o); await M.switchChat('chatD2x', [], {}); window.fetch = g; return res; } return g(u, o); };
        window.__restore = () => { window.fetch = g; };`);
    await ev(() => { window.__restore?.(); window.__restore = null; });
    m = await memAt(d2.id, d2.A, d2.B);
    ok(d2.carry && !r.ups.length && !r.puts.length && r.saves === 0 && m.at === 'A' && !m.tagB && m.tagA === 'linked',
        `10. (b4a1) 본체를 다시 읽는 사이 방 이동 → 업로드 0, 기억 A에 그대로 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    // P3: another memory linked at B while the box is open (read by the decision made again): no "carried on" notice.
    r = await listRoom('chatD3', 'chatD3b');
    const d3 = r;
    r = await press(`const B = ${JSON.stringify(d3.B)}, doc = JSON.parse(M.files.get(M.H.memName(${JSON.stringify(d3.id)}))), id = 'mem-d3-other';
        M.otherPut(M.H.memName(id), { ...doc, id, rev: 0, wid: 'other.d3', recent: [{ rev: 0, wid: 'other.d3' }], home: { addr: B, integrity: doc.home.integrity }, closes: [] });
        M.otherPut(M.H.tagName(B), M.H.tagBody({ addr: B, integrity: doc.home.integrity, mem: id }));`);
    m = await memAt(d3.id, d3.A, d3.B);
    r.id = await ev(() => __savePoint.home().id);
    ok(d3.carry && r.status === 'linked' && r.id === 'mem-d3-other' && !r.toast.includes('이어서 이 방에 기억을 연결했어요') && r.toast.includes('다른 기억이 이미 연결돼') && m.at === 'A' && r.saves === 0,
        `11. (b4a1) 확인창 중 B에 다른 기억이 연결됨 → 이어받기 성공 안내 없음, 예전 기억 그대로 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);

    // v0.7.0-b4a2 (review of b4a1, P1): the agreed move cut off after its body was uploaded (the room left before the answer, a tag not
    // written): the body says so itself (`carried`: the record, the old name, that upload's receipt), and opening B again finishes the
    // links without writing the body again. Saved since (another receipt), another record, or another link at B: held, nothing written.
    // `cut(id, x)`: while the box is open, arrange to leave for room `x` right after the body's upload lands (before its answer is read).
    const cut = (id, x) => `window.__base = window.__log.lists; const name = M.H.memName(${JSON.stringify(id)}), g = window.fetch; let done = false;
        window.fetch = async (u, o = {}) => { if (!done && String(u) === '/api/files/upload' && JSON.parse(o.body).name === name) { done = true; const res = await g(u, o);
            await M.switchChat(${JSON.stringify(x)}, [], {}); window.fetch = g; return res; } return g(u, o); };
        window.__restore = () => { window.fetch = g; };`;
    // Open `b` again (from wherever the page is), with `before` (JS, `A`·`B`·`id`) run first; what this page wrote meanwhile.
    const reopen = (b, x, before = '') => ev(async ([b, x, before]) => {
        if (before) await (0, eval)(`(async (A, B, id) => { ${before} })`)(x.A, x.B, x.id);
        await M.switchChat(b + 'y', [], {}); await M.opened();
        const n = M.fileLog.length, m = __mark();
        await M.openFile(b); await M.opened(); await new Promise(z => setTimeout(z, 400)); await M.opened();
        const h = __savePoint.home();
        return { ...__look(), ...__since(m), id: h.id, puts: M.fileLog.slice(n).filter(x => x[0] === 'put' && /^savepoint-(mem|room|int|moved|moving|copy)-/.test(x[1])).map(x => x[1]) };
    }, [b, x, before]);
    const memPuts = r => r.puts.filter(n => /^savepoint-mem-/.test(n)).length;
    // 12. Left right after the body's upload: B opened again → the links made, the body not written again; then saves go on.
    r = await listRoom('chatE1', 'chatE1b');
    const e1 = r;
    r = await press(cut(e1.id, 'chatE1x'));
    await ev(() => { window.__restore?.(); window.__restore = null; });
    m = await memAt(e1.id, e1.A, e1.B);
    const carried = await ev(id => JSON.parse(M.files.get(M.H.memName(id))).carried || null, e1.id);
    ok(e1.carry && m.at === 'B' && !m.tagB && m.tagA === 'linked' && carried?.from === e1.A && !!carried?.id, `12. 본체 업로드 직후 방 이동 → 본체만 B, 이어 가기 표시 있음 (${JSON.stringify({ m, carried })})`);
    r = await reopen('chatE1b', e1);
    m = await memAt(e1.id, e1.A, e1.B);
    ok(r.status === 'linked' && r.id === e1.id && memPuts(r) === 0 && m.tagB && m.tagA === 'renamed' && r.saves === 0, `12. B를 다시 열면 이름표만 써서 연결, 본체 쓰기 0 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    r = await ev(async () => { M.add(2); await __savePoint.handle('run').catch(() => {}); const id = __savePoint.home().id, d = id ? JSON.parse(M.files.get(M.H.memName(id)) || 'null') : null;
        return { last: __savePoint.state()?.lastIndex, file: id ? M.mem()?.lastIndex : null, status: __savePoint.home().status, carried: d ? d.carried || null : 'none' }; });
    ok(r.last === 11 && r.file === 11 && r.status === 'linked' && !r.carried, `12. 그 뒤 세이브 평소대로, 표시는 다음 저장에서 사라짐 (${JSON.stringify(r)})`);
    // 12b. The tag at B refused after the move: stopped; B opened again → finished the same way.
    r = await listRoom('chatE2', 'chatE2b');
    const e2 = r;
    await ev(() => { M.failFile = 'savepoint-room-'; M.failFileStatus = 400; });
    r = await press();
    await ev(() => { M.failFile = null; M.failFileStatus = null; });
    m = await memAt(e2.id, e2.A, e2.B);
    ok(e2.carry && r.status !== 'linked' && m.at === 'B' && !m.tagB && m.tagA === 'linked', `12b. 옮긴 뒤 B 이름표 거절 → 본체만 B (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    r = await reopen('chatE2b', e2);
    m = await memAt(e2.id, e2.A, e2.B);
    ok(r.status === 'linked' && r.id === e2.id && memPuts(r) === 0 && m.tagB && m.tagA === 'renamed' && r.saves === 0, `12b. B를 다시 열면 이어서 연결, 본체 쓰기 0 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    // 12c. Cut the same way, then: saved elsewhere (another receipt, the mark copied along) / the record no longer the same / another
    // memory's clue entry at B → held, nothing written.
    for (const [tag, js] of [['saved', `const d = JSON.parse(M.files.get(M.H.memName(id))); M.otherPut(M.H.memName(id), { ...d, rev: d.rev + 1, wid: 'other.e3', recent: [...d.recent, { rev: d.rev + 1, wid: 'other.e3' }] });`],
        ['record', `const rec = M.settings.savePoint.renames.find(x => x.to === B); rec.at += 1;`],
        ['clue', `const d = JSON.parse(M.files.get(M.H.memName(id))); M.otherPut(M.H.clueName(d.home.integrity), M.H.clueBody(d.home.integrity, [{ addr: B, mem: 'mem-other-e3' }]));`]]) {
        r = await listRoom('chatE3' + tag, 'chatE3' + tag + 'b');
        const x = r;
        await press(cut(x.id, 'chatE3' + tag + 'x'));
        await ev(() => { window.__restore?.(); window.__restore = null; });
        r = await reopen('chatE3' + tag + 'b', x, js);
        m = await memAt(x.id, x.A, x.B);
        ok(x.carry && r.status === 'held' && !r.ups.length && !r.puts.length && r.saves === 0 && m.at === 'B' && !m.tagB && m.tagA === 'linked',
            `12c. 이어 가기 표시가 안 맞음(${tag}) → 보류, 쓰기 0 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    }
    // 12d. B's tag written, then the clue refused: B opened again links by its tag (row 3), saves go on (A's old tag is left as it was).
    r = await listRoom('chatE4', 'chatE4b');
    const e4 = r;
    await ev(() => { M.failFile = 'savepoint-int-'; M.failFileStatus = 400; });
    r = await press();
    await ev(() => { M.failFile = null; M.failFileStatus = null; });
    m = await memAt(e4.id, e4.A, e4.B);
    ok(e4.carry && r.status !== 'linked' && m.at === 'B' && m.tagB && m.tagA === 'linked', `12d. B 이름표 뒤 단서 거절 → 본체·B 이름표 있음 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    r = await reopen('chatE4b', e4);
    const r2 = await ev(async () => { M.add(2); await __savePoint.handle('run').catch(() => {}); return { last: __savePoint.state()?.lastIndex, file: M.mem()?.lastIndex, status: __savePoint.home().status }; });
    ok(r.status === 'linked' && r.id === e4.id && memPuts(r) === 0 && r.saves === 0 && r2.last === 11 && r2.file === 11 && r2.status === 'linked',
        `12d. B를 다시 열면 연결, 그 뒤 세이브 평소대로 (${JSON.stringify({ r: { ...r, text: '' }, r2 })})`);

    // v0.7.0-b4a3 (review of b4a2). P1: picking a cut move up checks the chat list first (the old name gone, this one there), like the move.
    // Not so (the old name back, or the list not read): no link written, held with `다시 확인`; once the list is right, `다시 확인` finishes it.
    const recheck = () => ev(async () => {
        const n = M.fileLog.length; await __savePoint.handle('home-recheck').catch(() => {}); await M.opened(); await new Promise(z => setTimeout(z, 400));
        const h = __savePoint.home();
        return { ...__look(), id: h.id, wid: h.line?.seen?.wid ?? null, puts: M.fileLog.slice(n).filter(x => x[0] === 'put' && /^savepoint-(mem|room|int|moved|moving|copy)-/.test(x[1])).map(x => x[1]) };
    });
    for (const [tag, js, why, says] of [['back', `M.serverFiles[JSON.parse(A)[1]] = [{ chat_metadata: { integrity: 'back-e5' } }];`, 'carryResumeGone', '예전 이름의 채팅이 다시 보이거나'],
        ['list', `window.__listHook = async () => new Response('down', { status: 500 });`, 'carryResumeList', '채팅 목록을 읽지 못해서']]) {
        r = await listRoom('chatE5' + tag, 'chatE5' + tag + 'b');
        const x = r;
        await press(cut(x.id, 'chatE5' + tag + 'x'));
        await ev(() => { window.__restore?.(); window.__restore = null; });
        r = await reopen('chatE5' + tag + 'b', x, js);
        m = await memAt(x.id, x.A, x.B);
        ok(x.carry && r.status === 'held' && r.why === why && r.text.includes(says) && r.text.includes('다시 확인') && r.btn === 0 && !r.puts.length && r.saves === 0 && m.at === 'B' && !m.tagB && m.tagA === 'linked',
            `13. (b4a3) 재개 전 목록 ${tag} → 이름표 쓰기 0, 보류 + 다시 확인 (${JSON.stringify({ r, m })})`);
        r = await ev(a => { window.__listHook = null; delete M.serverFiles[a]; }, JSON.parse(x.A)[1]);
        r = await recheck();
        m = await memAt(x.id, x.A, x.B);
        ok(r.status === 'linked' && r.id === x.id && !r.puts.some(n => /^savepoint-mem-/.test(n)) && m.tagB && m.tagA === 'renamed', `13. (b4a3) 목록이 맞으면 다시 확인으로 마저 연결, 본체 쓰기 0 (${JSON.stringify({ r: { ...r, text: '' }, m })})`);
    }
    // P2: another tab finishes the links and saves while this page picks the move up (at its list read): nothing written here, and the page
    // gets the memory as it is now (that tab's receipt), not the copy read for the decision. The read failing → no memory on the page.
    const other = (id, A, B) => `const d = JSON.parse(M.files.get(M.H.memName(${JSON.stringify(id)}))), t = JSON.parse(M.files.get(M.H.tagName(${JSON.stringify(A)})));
        M.otherPut(M.H.tagName(${JSON.stringify(B)}), M.H.tagBody({ addr: ${JSON.stringify(B)}, integrity: d.home.integrity, mem: d.id }));
        M.otherPut(M.H.clueName(d.home.integrity), M.H.clueBody(d.home.integrity, [{ addr: ${JSON.stringify(B)}, mem: d.id }]));
        M.otherPut(M.H.tagName(${JSON.stringify(A)}), M.H.renamedTag(t, ${JSON.stringify(B)}));
        M.otherPut(M.H.memName(d.id), M.H.nextMem(d, d.state, 'other.e6'));`;
    r = await listRoom('chatE6', 'chatE6b');
    const e6 = r;
    await press(cut(e6.id, 'chatE6x'));
    await ev(() => { window.__restore?.(); window.__restore = null; });
    r = await reopen('chatE6b', e6, `let once = false; window.__listHook = async () => { if (!once) { once = true; ${other(e6.id, e6.A, e6.B)} } return null; };`);
    await ev(() => { window.__listHook = null; });
    const wid6 = await ev(() => __savePoint.home().line?.seen?.wid ?? null);
    ok(r.status === 'linked' && r.id === e6.id && !r.puts.length && r.saves === 0 && wid6 === 'other.e6', `14. (b4a3) 재개 중 다른 탭이 마저 연결·저장 → 쓰기 0, 화면은 최신 기억 (${JSON.stringify({ r: { ...r, text: '' }, wid6 })})`);
    r = await ev(async () => { M.add(2); await __savePoint.handle('run').catch(() => {}); return { last: __savePoint.state()?.lastIndex, file: M.mem()?.lastIndex, status: __savePoint.home().status }; });
    ok(r.last === 11 && r.file === 11 && r.status === 'linked', `14. 그 뒤 세이브 평소대로 (${JSON.stringify(r)})`);
    r = await listRoom('chatE7', 'chatE7b');
    const e7 = r;
    await press(cut(e7.id, 'chatE7x'));
    await ev(() => { window.__restore?.(); window.__restore = null; });
    r = await reopen('chatE7b', e7, `let once = false; window.__listHook = async () => { if (!once) { once = true; M.memReadFail = true; } return null; };`);
    const st7 = await ev(() => { window.__listHook = null; M.memReadFail = false; return __savePoint.home().st ? 'some' : null; });
    ok(r.status === 'readFail' && !st7 && r.saves === 0, `14b. (b4a3) 붙이기 직전 기억 읽기 실패 → 화면 기억 없음 (${JSON.stringify({ r: { ...r, text: '' }, st7 })})`);
    r = await recheck();
    ok(r.status === 'linked' && r.id === e7.id && !r.puts.some(n => /^savepoint-mem-/.test(n)), `14b. 다시 확인 → 연결, 본체 쓰기 0 (${JSON.stringify({ ...r, text: '' })})`);

    // v0.7.0-b4a4 (review of b4a3, P1): while the picked-up move awaits its chat list, the files its decision read change (at the first list
    // request). Read again after the list, before any link: the body back at A (an old save from A landing late), another memory's clue at B,
    // the move's mark gone with a save elsewhere and no tag at B → held, nothing written. Another tab finished this very move (both tags,
    // no clue written here) → its body as it is now, nothing written.
    const atList = js => `let once = false; window.__listHook = async () => { if (!once) { once = true; const d = JSON.parse(M.files.get(M.H.memName(id))); ${js} } return null; };`;
    for (const [tag, js] of [['back', `M.otherPut(M.H.memName(id), { ...M.H.nextMem(d, d.state, 'other.f1'), home: { ...d.home, addr: A, was: [] } });`],
        ['clue', `M.otherPut(M.H.clueName(d.home.integrity), M.H.clueBody(d.home.integrity, [{ addr: B, mem: 'mem-other-f2' }]));`],
        ['saved', `M.otherPut(M.H.memName(id), M.H.nextMem(d, d.state, 'other.f3'));`]]) {
        r = await listRoom('chatF' + tag, 'chatF' + tag + 'b');
        const x = r;
        await press(cut(x.id, 'chatF' + tag + 'x'));
        await ev(() => { window.__restore?.(); window.__restore = null; });
        r = await reopen('chatF' + tag + 'b', x, atList(js));
        await ev(() => { window.__listHook = null; });
        m = await memAt(x.id, x.A, x.B);
        const clue = await ev(([id, B]) => { const d = JSON.parse(M.files.get(M.H.memName(id))); return JSON.parse(M.files.get(M.H.clueName(d.home.integrity)) || 'null')?.rooms?.filter(z => z.addr === B).length ?? 0; }, [x.id, x.B]);
        ok(x.carry && r.status === 'held' && r.why === 'carryResumeChanged' && r.text.includes('다시 확인') && !r.puts.length && r.saves === 0 && !m.tagB && m.tagA === 'linked'
            && clue === (tag === 'clue' ? 1 : 0), `15. (b4a4) 재개 목록을 기다리는 사이 ${tag} → 이름표 쓰기 0, 보류 (${JSON.stringify({ r, m, clue })})`);
    }
    r = await listRoom('chatFdone', 'chatFdoneb');
    const f4 = r;
    await press(cut(f4.id, 'chatFdonex'));
    await ev(() => { window.__restore?.(); window.__restore = null; });
    r = await reopen('chatFdoneb', f4, atList(`const t = JSON.parse(M.files.get(M.H.tagName(A)));
        M.otherPut(M.H.tagName(B), M.H.tagBody({ addr: B, integrity: d.home.integrity, mem: d.id }));
        M.otherPut(M.H.tagName(A), M.H.renamedTag(t, B));
        M.otherPut(M.H.memName(id), M.H.nextMem(d, d.state, 'other.f4'));`));
    await ev(() => { window.__listHook = null; });
    const wid15 = await ev(() => __savePoint.home().line?.seen?.wid ?? null);
    ok(r.status === 'linked' && r.id === f4.id && !r.puts.length && r.saves === 0 && wid15 === 'other.f4', `15. (b4a4) 같은 기억의 연결이 이미 끝남 → 쓰기 0, 화면은 최신 기억 (${JSON.stringify({ r: { ...r, text: '' }, wid15 })})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
