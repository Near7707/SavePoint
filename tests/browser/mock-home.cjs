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
    // v0.6.64 (step 0): the mock pieces the planned memory files need, checked against what SillyTavern does,
    // and checked through home.js's own reader. Nothing in SavePoint uses them yet.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, askResume: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    let r;

    // 1. user files: missing / broken / error / ok, a slow read, and the reads are counted.
    r = await ev(async () => {
        const H = await import('/ext/home.js');
        const read = name => H.readUserFile(fetch, name);
        M.otherPut('savepoint-mem-a.json', { a: 1 });
        M.otherPut('savepoint-mem-b.json', { b: 1 });
        const out = { none: (await read('savepoint-mem-zz.json')).kind, ok: (await read('savepoint-mem-a.json')).kind };
        M.fileState = { 'savepoint-mem-a.json': 'broken', 'savepoint-mem-b.json': 'error', 'savepoint-mem-c.json': 'broken', 'savepoint-mem-d.json': 'missing' };
        M.otherPut('savepoint-mem-d.json', { d: 1 });
        out.broken = (await read('savepoint-mem-a.json')).kind;
        out.error = (await read('savepoint-mem-b.json')).kind;
        out.brokenNone = (await read('savepoint-mem-c.json')).kind;
        out.hidden = (await read('savepoint-mem-d.json')).kind;
        M.fileState = {}; M.fileDelay = { 'savepoint-mem-a.json': 300 };
        const t = Date.now(); out.slow = (await read('savepoint-mem-a.json')).kind; out.waited = Date.now() - t;
        M.fileDelay = {};
        out.reads = M.fileReads.filter(n => n.startsWith('savepoint-mem-')).length;
        return out;
    });
    ok(r.none === 'missing' && r.ok === 'ok' && r.broken === 'broken' && r.error === 'error' && r.brokenNone === 'broken' && r.hidden === 'missing', `1. 사용자 파일 읽기 네 가지 (${JSON.stringify(r)})`);
    ok(r.slow === 'ok' && r.waited >= 280 && r.reads === 7, `1. 읽기 지연과 횟수 (${r.waited}ms, ${r.reads})`);

    // 2. another device writes between our read and our write.
    r = await ev(async () => {
        M.otherPut('savepoint-mem-x.json', { rev: 1, wid: 'w1' });
        const seen = await (await fetch('/user/files/savepoint-mem-x.json')).json();
        M.beforeUpload = async name => { if (name === 'savepoint-mem-x.json') { M.beforeUpload = null; M.otherPut(name, { rev: 2, wid: 'other' }); } };
        const between = [];
        const put = obj => fetch('/api/files/upload', { method: 'POST', body: JSON.stringify({ name: 'savepoint-mem-x.json', data: btoa(JSON.stringify(obj)) }) });
        await put({ rev: seen.rev + 1, wid: 'mine' });
        between.push(...M.fileLog.filter(x => x[1] === 'savepoint-mem-x.json').map(x => x[0]));
        return { between, now: JSON.parse(M.files.get('savepoint-mem-x.json')) };
    });
    ok(r.between.join() === 'other-put,other-put,put' && r.now.wid === 'mine', `2. 두 기기: 읽기와 쓰기 사이에 끼어든 쓰기 (${r.between.join()})`);

    // 3. chat saves: SavePoint's and SillyTavern's own are counted apart.
    await ev(() => { M.add(8); });
    r = await ev(() => ({ sp: M.spSaves, st: M.stSaves }));
    await ev(() => __savePoint.handle('run'));
    await wait(1500);
    const after = await ev(() => ({ sp: M.spSaves, st: M.stSaves, mem: !!M.serverFiles[M.chatId][0].chat_metadata.savePoint }));
    ok(r.sp === 0 && r.st >= 1 && after.sp >= 1 && after.mem, `3. 채팅 저장 횟수: SavePoint ${r.sp}→${after.sp}, 실리태번 ${r.st}→${after.st}`);
    await ev(() => { M.add(1); });
    const after2 = await ev(() => ({ sp: M.spSaves, st: M.stSaves }));
    ok(after2.st === after.st + 1, `3. 메시지 추가는 실리태번 저장으로만 셈 (${after.sp}→${after2.sp}, ${after.st}→${after2.st})`);

    // 4. branch, branch on a swipe, checkpoint, import: the files SillyTavern makes.
    r = await ev(() => {
        M.meta.integrity = 'i-main';
        M.chat[4].swipes = [M.chat[4].mes, 'Another way it went.']; M.chat[4].swipe_info = [{ extra: {} }, { extra: {} }];
        M.stSave();
        const stBefore = M.stSaves;
        const b = M.branchChat('Branch #1', 4), s = M.branchChat('Branch #2', 4, { swipe: 1 }), o = M.branchChat('Branch #3', 4, { keepIntegrity: true }), c = M.checkpointChat(6);
        const i = M.importChat('chatA');
        const f = n => M.serverFiles[n];
        return {
            b: [f(b).length - 1, f(b)[0].chat_metadata.main_chat, f(b)[0].chat_metadata.integrity !== 'i-main', !!f(b)[0].chat_metadata.savePoint],
            s: [f(s)[5].mes, f(s)[5].swipe_id], o: f(o)[0].chat_metadata.integrity, c: [c, f(c).length - 1, f(c)[0].chat_metadata.main_chat],
            i: [i, f(i)[0].chat_metadata.integrity, f(i).length === f('chatA').length], marks: M.chat[4].extra.branches,
            link: [M.chat[6].extra.bookmark_link, M.serverFiles.chatA[7].extra?.bookmark_link, M.chat[6].extra.branches ?? null, stBefore, M.stSaves],
            list: M.chatList().sort(),
        };
    });
    ok(r.b.join() === '5,chatA,true,true' && r.s.join() === 'Another way it went.,1' && r.o === 'i-main', `4. 분기·스와이프 분기·예전 분기 (${JSON.stringify([r.b, r.s, r.o])})`);
    ok(r.c[1] === 7 && r.c[2] === 'chatA' && r.i.join() === 'chatA imported,i-main,true' && r.marks.join() === 'Branch #1,Branch #2,Branch #3', `4. 체크포인트·가져오기 (${JSON.stringify([r.c, r.i])})`);
    ok(r.link[0] === r.c[0] && r.link[1] === r.c[0] && r.link[2] === null && r.link[4] === r.link[3] + 1, `4. 체크포인트는 원래 방 메시지에 bookmark_link를 붙이고 실리태번이 원래 방을 저장 (${JSON.stringify(r.link)})`);
    r = await ev(async () => (await (await fetch('/api/characters/chats', { method: 'POST', body: JSON.stringify({ avatar_url: 'ari.png', simple: true }) })).json()).map(x => x.file_name));
    ok(r.includes('chatA.jsonl') && r.includes('Branch #2.jsonl') && r.includes('chatA imported.jsonl'), `4. 채팅 목록 (${r.length}개)`);

    // 5. rename: the open room is reopened first, then CHAT_RENAMED (with .jsonl); delete sends its own notice.
    r = await ev(async () => {
        const order = [];
        M.eventSource.on('chat_id_changed', () => order.push('changed:' + M.chatId));
        M.eventSource.on('chat_renamed', d => order.push(`renamed:${d.oldFileName}>${d.newFileName}:${M.chatId}`));
        M.eventSource.on('chat_deleted', n => order.push('deleted:' + n));
        await M.renameChat('chatA', 'chatR');
        await M.renameChat('Branch #1', 'Branch one');
        await M.deleteChat('Branch #3');
        await M.renameChat('chatR', 'chat:R?', { saved: 'chat_R_' });
        return { order, list: M.chatList(), open: M.chatId, len: M.chat.length };
    });
    ok(r.order.join(' ') === 'changed:chatR renamed:chatA.jsonl>chatR.jsonl:chatR renamed:Branch #1.jsonl>Branch one.jsonl:chatR deleted:Branch #3 changed:chat_R_ renamed:chatR.jsonl>chat:R?.jsonl:chat_R_', `5. 이름 바꾸기·삭제 알림 순서 (${r.order.join(' ')})`);
    ok(r.open === 'chat_R_' && r.len === 9 && !r.list.includes('chatA') && !r.list.includes('chatR') && r.list.includes('chat_R_') && r.list.includes('Branch one') && !r.list.includes('Branch #3'), `5. 서버가 정리한 이름으로 파일·방, 알림은 입력한 이름 (${r.list.join(', ')})`);
    await wait(500);

    // 6. integrity like SillyTavern (opt-in): added on the page when a room opens without one, not in the file.
    r = await ev(async () => {
        M.stIntegrity = true;
        M.serverFiles['old'] = [{ chat_metadata: {} }, { name: 'Ari', is_user: false, mes: 'Hi', swipe_id: 0, extra: {} }];
        await M.openFile('old');
        return { page: M.meta.integrity, file: M.serverFiles['old'][0].chat_metadata.integrity ?? null };
    });
    ok(!!r.page && r.file === null, `6. 고유값은 화면에서만 생기고 파일엔 다음 저장 때 (${r.page}, ${r.file})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
