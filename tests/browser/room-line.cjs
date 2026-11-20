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

// v0.7.1-a1: the room status line at the top of the window (확인 필요 · 연결 보류 · 확인 대기 · 확인 중… · 아직 저장된 기억 없음 ·
// 기억 연결됨) and its short reason. It reads the existing room states only: drawing it writes nothing.
// 1 new room (not an error) · 2 linked · 3 chat file not read → back · 4 deleted elsewhere → reopen → back · 5 a reply being made
// (확인 대기) and what comes before it (unanswered write, unconfirmed write, memory problem) → back after the reply · 6 held,
// with a chat file problem on top → back · 7 an edit open: the line moves, the text typed stays · 8 room move: the old
// room's line goes · 9 opening (확인 중…).
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(() => { window.__presetSettings = { savePoint: { firstTab: 'journal', check: false, hideMode: 'off', askResume: false, autoReserve: 0 } }; });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
    await page.evaluate(() => M.opened());
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    // Writes the page sends (chat file saves and file uploads), counted from the start.
    await ev(() => {
        window.__writes = 0;
        const f = window.fetch;
        window.fetch = (u, o) => { const s = String(u); if (window.__getFail && s.includes('/api/chats/get')) return Promise.resolve(new Response('down', { status: 500 })); if (/\/api\/chats\/save|\/api\/files\/upload|\/api\/chats\/group\/save/.test(s)) window.__writes++; return f(u, o); };
    });
    const writes = () => ev(() => window.__writes);
    const line = () => ev(() => {
        const all = document.querySelectorAll('#sp_overlay .sp-roomline'), el = all[0];
        if (!el) return { n: 0 };
        const lab = el.querySelector('.sp-roomline-label'), danger = (() => { const t = document.createElement('span'); t.style.color = 'var(--sp-danger)'; el.appendChild(t); const c = getComputedStyle(t).color; t.remove(); return c; })();
        return { n: all.length, kind: el.dataset.kind, label: lab?.textContent || '', why: el.querySelector('.sp-roomline-why')?.textContent || '', red: getComputedStyle(lab).color === danger,
            first: el.previousElementSibling?.classList.contains('sp-top') };
    });
    const redraw = () => ev(() => __savePoint.render());
    const keep = i => ev(i => __savePoint.toggleKeep(i).then(() => 'ok', e => `${e.name}: ${e.message}`), i);
    let r;

    await ev(() => { M.add(8); document.querySelector('#sp_open').click(); });
    await wait(300);

    // 1. a new room: no memory yet, shown plainly (not as a problem), and drawing writes nothing
    r = await line();
    ok(r.n === 1 && r.first && r.kind === 'empty' && r.label === '아직 저장된 기억 없음' && !r.red && r.why.includes('첫 저장'), `1. 새 방: 아직 저장된 기억 없음, 오류 색 아님, 창 맨 위 (${JSON.stringify(r)})`);
    let w0 = await writes();
    for (let i = 0; i < 3; i++) { await redraw(); await ev(() => __savePoint.handle('hud-toggle')); }
    await wait(300);
    ok((await writes()) === w0, '1. 상태 줄을 여러 번 그려도 저장 요청 0');

    // 2. recorded: linked
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    r = await line();
    ok(r.kind === 'linked' && r.label === '기억 연결됨' && !r.why && !r.red, `2. 기록 뒤: 기억 연결됨 (${JSON.stringify(r)})`);

    // 3. the chat file can't be read: 확인 필요, try again later → back once it reads
    await ev(() => { window.__getFail = true; });
    const k3 = await keep(3);
    r = await line();
    ok(r.kind === 'check' && r.label === '확인 필요' && r.red && r.why.includes('읽지 못했어요') && r.why.includes('잠시 뒤 다시'), `3. 채팅 파일 읽기 실패: 확인 필요 · 잠시 뒤 다시 (${k3.slice(0, 40)} · ${JSON.stringify(r)})`);
    // a check that ends without a redraw (퀵세이브 pressed with an edit open: the room reads fine again, the save stops at the
    // edit and nothing is drawn) still moves the line on
    await ev(() => { __savePoint.handle('tab', 'world'); __savePoint.handle('add-rec', 'world'); window.__getFail = false; });
    await ev(() => __savePoint.handle('run'));
    await wait(300);
    r = await line();
    ok(r.kind === 'linked' && (await ev(() => !!__savePoint.ui.edit)), `3. 편집 중 퀵세이브의 방 확인이 통과하면(다시 그리지 않아도) 기억 연결됨 (${r.kind})`);
    await ev(() => __savePoint.handle('edit-cancel'));
    const k3b = await keep(3);
    await wait(300);
    r = await line();
    ok(k3b === 'ok' && r.kind === 'linked', `3. 다시 읽히면 기억 연결됨으로 돌아옴 (${k3b} · ${r.kind})`);

    // 4. a message deleted elsewhere is still on this page: reopen → back after reopening
    await ev(() => M.add(2));
    const k4a = await keep(3);
    await ev(() => { M.serverFiles.chatA.pop(); });
    const k4 = await keep(3);
    r = await line();
    ok(r.kind === 'check' && r.why.includes('지운 메시지') && r.why.includes('방을 다시 열거나 새로고침'), `4. 다른 곳에서 지운 메시지: 확인 필요 · 방을 다시 열기 (${k4a} · ${k4.slice(0, 40)} · ${JSON.stringify(r)})`);
    await ev(async () => { await M.openFile('chatA'); await M.opened(); });
    await wait(600);
    r = await line();
    ok(r.kind === 'linked' && r.n === 1, `4. 다시 열면 기억 연결됨 (${JSON.stringify(r)})`);

    // 5. a reply being made: 확인 대기 (not red); an unanswered or unconfirmed write, or a memory problem, comes first
    await ev(() => {
        SillyTavern.getContext().eventSource.emit('generation_started', 'continue', {}, false);
        const m = M.chat.at(-1); M.grow = setInterval(() => { m.mes += ' more'; }, 100);
    });
    await wait(300);
    const k5 = await keep(4);
    r = await line();
    const busy = await ev(() => __savePoint.gate().status);
    ok(busy === 'busy' && r.kind === 'wait' && r.label === '확인 대기' && !r.red && r.why.includes('답변이 끝나면 채팅 파일을 다시 확인'), `5. 답변 중 확인을 미룸: 확인 대기, 오류 색 아님 (${busy} · ${k5.slice(0, 30)} · ${JSON.stringify(r)})`);
    await ev(() => { __savePoint.gate().pending = { at: Date.now() }; __savePoint.render(); });
    r = await line();
    ok(r.kind === 'check' && r.why.includes('응답을 받지 못한 저장'), `5. 응답 없는 저장 + 답변 대기: 확인 필요가 먼저 (${r.kind})`);
    await ev(() => { __savePoint.gate().pending = null; __savePoint.gate().unsure = { at: Date.now(), tries: 0 }; __savePoint.render(); });
    r = await line();
    ok(r.kind === 'check' && r.why.includes('확인하는 중') && r.why.includes('잠시 뒤 다시'), `5. 저장 확인 대기 + 답변 대기: 확인 필요가 먼저 (${r.kind} · ${r.why})`);
    await ev(() => { __savePoint.gate().unsure = null; __savePoint.home().h2 = { why: 'source', at: 2 }; __savePoint.render(); });
    r = await line();
    ok(r.kind === 'check' && r.why.includes('#2') && r.why.includes('원문과 기억 맞추기'), `5. 기억 쪽 문제 + 답변 대기: 기억 문제가 먼저 (${r.kind})`);
    await ev(() => { __savePoint.home().h2 = null; __savePoint.render(); });
    ok((await line()).kind === 'wait', '5. 겹친 문제가 풀리면 다시 확인 대기');
    await ev(() => { clearInterval(M.grow); M.stSave(); SillyTavern.getContext().eventSource.emit('generation_ended', M.chat.length); });
    await page.waitForFunction(() => document.querySelector('#sp_overlay .sp-roomline')?.dataset.kind === 'linked', null, { timeout: 8000 }).catch(() => {});
    r = await line();
    ok(r.kind === 'linked', `5. 답변이 끝나면 다시 확인해 기억 연결됨 (${r.kind})`);

    // 6. held (the memory file named by the tag is missing): 연결 보류; a chat file problem on top comes first → back
    const memFile = await ev(async () => { const H = await import('/ext/home.js'); const name = H.memName(__savePoint.home().id); window.__memKeep = M.files.get(name); M.files.delete(name); return name; });
    await ev(async () => { await M.openFile('chatA'); await M.opened(); });
    await wait(400);
    r = await line();
    const h6 = await ev(() => ({ status: __savePoint.home().status, why: __savePoint.home().why, btn: $('#sp_overlay [data-act=home-recheck]').length }));
    ok(h6.status === 'held' && r.kind === 'held' && r.label === '연결 보류' && !r.red && r.why.includes('기억 파일이 없어요') && h6.btn === 1, `6. 기억 파일 없음: 연결 보류 + 기존 다시 확인 버튼 (${JSON.stringify(h6)} · ${JSON.stringify(r)})`);
    await ev(() => { __savePoint.gate().status = 'unread'; __savePoint.render(); });
    r = await line();
    ok(r.kind === 'check' && r.why.includes('채팅 파일을 읽지 못했어요'), `6. 채팅 오류 + 연결 보류: 확인 필요가 먼저 (${r.kind})`);
    await ev(() => { __savePoint.gate().status = 'ready'; __savePoint.render(); });
    ok((await line()).kind === 'held', '6. 채팅 오류가 풀리면 다시 연결 보류');
    await ev(name => { M.files.set(name, window.__memKeep); __savePoint.handle('home-recheck'); }, memFile);
    await wait(1200);
    r = await line();
    ok(r.kind === 'linked', `6. 기억 파일을 되돌리고 다시 확인: 기억 연결됨 (${r.kind})`);

    // 7. an edit open: render keeps the window (half-typed text), the status line still changes
    await ev(() => { __savePoint.handle('tab', 'world'); __savePoint.handle('add-rec', 'world'); });
    await page.fill('.sp-edit [data-edit=text]', 'Half-typed note');
    w0 = await writes();
    await ev(() => { __savePoint.gate().status = 'unread'; __savePoint.render(); });
    r = await line();
    let t7 = await ev(() => ({ text: $('.sp-edit [data-edit=text]').val(), edit: !!__savePoint.ui.edit }));
    ok(r.kind === 'check' && r.n === 1 && t7.text === 'Half-typed note' && t7.edit, `7. 편집 중: 상태 줄은 확인 필요로 바뀌고 쓰던 글은 그대로 (${r.kind} · ${JSON.stringify(t7)})`);
    await ev(() => { __savePoint.gate().status = 'ready'; __savePoint.render(); });
    r = await line();
    t7 = await ev(() => $('.sp-edit [data-edit=text]').val());
    ok(r.kind === 'linked' && t7 === 'Half-typed note', `7. 편집 중 복귀도 상태 줄에 반영, 글 그대로 (${r.kind})`);
    ok((await writes()) === w0, '7. 편집 중 상태 줄을 바꿔도 저장 요청 0');
    await ev(() => __savePoint.handle('edit-cancel'));

    // 8. a room move: the old room's problem does not stay on the new room
    await ev(() => { __savePoint.gate().status = 'unread'; __savePoint.render(); });
    ok((await line()).kind === 'check', '8. 준비: 이전 방은 확인 필요');
    await ev(async () => { await M.switchChat('chatB', [{ name: 'Ari', is_user: false, is_system: false, mes: 'Hello.', swipe_id: 0, extra: {} }], {}); await M.opened(); });
    await wait(400);
    r = await line();
    ok(r.n === 1 && r.kind === 'empty' && !r.red, `8. 새 방으로 옮기면 이전 방 표시가 사라지고 새 방 상태 (${JSON.stringify(r)})`);
    await ev(async () => { await M.openFile('chatA'); await M.opened(); });
    await wait(400);
    ok((await line()).kind === 'linked', '8. 돌아오면 그 방 상태(기억 연결됨)');

    // 9. while the room is opening: 확인 중…
    await ev(() => { M.serverReadDelay = 1200; window.__p9 = M.openFile('chatA'); });
    await wait(300);
    r = await line();
    ok(r.kind === 'checking' && r.label === '확인 중…' && !r.red, `9. 방을 여는 중: 확인 중… (${JSON.stringify(r)})`);
    await ev(async () => { await window.__p9; await M.opened(); M.serverReadDelay = 0; });
    await page.waitForFunction(() => document.querySelector('#sp_overlay .sp-roomline')?.dataset.kind === 'linked', null, { timeout: 8000 }).catch(() => {});
    ok((await line()).kind === 'linked', '9. 다 열리면 기억 연결됨');

    await page.close();
    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
