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

// v0.6.72: SillyTavern's saveMetadata() waits 0.1 s and then saves whatever room is open by then. A room
// switch in that moment wrote the next room's name with no messages and no integrity (the server skips its
// check then), and the next room was left with only its greeting. SavePoint now sends the room it checked,
// taken at one moment, and never a room that is still opening.
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
        return page;
    }
    const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, is_system: false, mes: `${tag} message ${i} ${'and more '.repeat(6)}.`, swipe_id: 0, swipes: [`${tag} message ${i} ${'and more '.repeat(6)}.`], extra: {} }));
    const file = (list, meta) => JSON.parse(JSON.stringify([{ chat_metadata: meta }, ...list]));

    // 1. persistSoon in room A, then SillyTavern opens room B 0–450 ms later (the old code wrote B empty
    //    for a switch about 0.3 s after the call; every moment is tried here).
    {
        const page = await session();
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await ev(() => { M.stLate = true; M.add(20); });
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        ok(await ev(() => !!__savePoint.state()?.mem?.scenes?.length), '준비: 방 A에 기억이 있음');
        const roomA = await ev(() => JSON.parse(JSON.stringify(M.serverFiles.chatA)));
        const bad = [];
        for (const d of [0, 50, 100, 150, 200, 250, 300, 330, 350, 380, 400, 450]) {
            await ev(([a, b]) => { M.serverFiles.chatA = JSON.parse(JSON.stringify(a)); M.serverFiles.chatB = b; }, [roomA, file(msgs(10, 'Bee'), { integrity: 'int-b' })]);
            await ev(() => M.openFile('chatA'));
            await page.waitForFunction(() => __savePoint.autoBlocked() !== 'room', null, { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(400);
            await ev(() => { M.saveBodies = []; __savePoint.persistSoon(); });
            await page.waitForTimeout(d);
            await ev(() => M.stOpen('chatB'));
            await page.waitForTimeout(900);
            const r = await ev(() => ({ b: M.serverFiles.chatB.length - 1, bMeta: M.serverFiles.chatB[0].chat_metadata, a: M.serverFiles.chatA.length - 1,
                aMem: !!M.serverFiles.chatA[0].chat_metadata.savePoint, empty: (M.saveBodies || []).filter(x => !x.count || !x.integrity).length }));
            if (r.b !== 10 || r.bMeta.integrity !== 'int-b' || r.a !== 20 || !r.aMem || r.empty) bad.push(`${d}ms: B ${r.b}개 A ${r.a}개 A기억 ${r.aMem} 빈 저장 ${r.empty}`);
        }
        ok(!bad.length, `방을 옮기는 어느 순간에도 다른 방 파일을 덮지 않고 원래 방도 그대로 (${bad.join(' / ') || '12개 시점'})`);
        await page.close();
    }

    // 2. The room is reopened (same name) while SillyTavern is still writing: SavePoint waits for that write,
    //    then finds the room opening (no messages, no integrity) and sends nothing.
    {
        const page = await session();
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await ev(() => { M.add(12); });
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        ok(await ev(() => !!M.stScript), '준비: 실리태번 저장 중 표시를 읽을 수 있음');
        const before = await ev(() => JSON.stringify(M.serverFiles.chatA));
        await ev(() => { M.saveBodies = []; M.stScript.setChatSaving(true); toastr.log.length = 0; __savePoint.persistSoon(); });
        await page.waitForTimeout(700);
        const waited = await ev(() => (M.saveBodies || []).length);
        await ev(() => { M.openDelay = 1500; M.stOpen('chatA'); M.stScript.setChatSaving(false); });
        await page.waitForTimeout(400);
        const r = await ev(() => ({ sent: (M.saveBodies || []).length, file: JSON.stringify(M.serverFiles.chatA), toast: toastr.log.map(x => x[1]).join(' | ') }));
        ok(waited === 0, '실리태번이 저장하는 동안에는 보내지 않고 기다림');
        ok(r.sent === 0 && r.file === before, `다시 여는 중인 방(메시지·고유값 없음)은 저장하지 않음, 파일 그대로 (${r.sent})`);
        await page.waitForTimeout(1500);
        ok(await ev(() => M.serverFiles.chatA.length - 1) === 12, '다시 열린 방의 파일도 그대로 12개');
        await page.close();
    }

    // 2b. Each check on its own (they overlap in a real room switch): while SillyTavern writes, the page gets
    //     only one of: no messages / metadata without integrity / another room's name. Nothing is sent.
    {
        const page = await session();
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await ev(() => { M.add(12); });
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        const cases = {
            '메시지 없음': () => { M.chat.splice(0); },
            '고유값 없음': () => { const { integrity: _i, ...rest } = M.meta; M.meta = rest; },
            '다른 방 이름': () => { M.chatId = 'chatC'; },
        };
        for (const [name, how] of Object.entries(cases)) {
            const saved = await ev(() => JSON.stringify({ chat: M.chat, meta: M.meta, id: M.chatId }));
            await ev(() => { M.saveBodies = []; M.stScript.setChatSaving(true); __savePoint.persistSoon(); });
            await page.waitForTimeout(700);
            await ev(`(${how.toString()})()`);
            await ev(() => M.stScript.setChatSaving(false));
            await page.waitForTimeout(300);
            const sent = await ev(() => (M.saveBodies || []).length);
            ok(sent === 0, `${name}이면 저장하지 않음 (${sent})`);
            await ev(j => { const x = JSON.parse(j); M.chat.splice(0, M.chat.length, ...x.chat); M.meta = x.meta; M.chatId = x.id; }, saved);
        }
        await page.close();
    }

    // 3. The server refuses a file whose integrity differs (another file took the name between the check and
    //    the write): nothing is written, the change is taken back and the room stops saving.
    {
        const page = await session();
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await ev(() => { M.add(12); });
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        const lastBefore = await ev(() => __savePoint.state().lastIndex);
        await ev(() => { M.add(6); toastr.log.length = 0; M.beforeChatSave = name => { M.beforeChatSave = null; M.serverFiles[name][0].chat_metadata = { ...M.serverFiles[name][0].chat_metadata, integrity: 'someone-else' }; }; });
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        const r = await ev(() => ({ refused: M.integrityRefused || 0, last: __savePoint.state().lastIndex, fileLast: M.serverFiles.chatA[0].chat_metadata.savePoint?.lastIndex,
            toast: toastr.log.map(x => x[1]).join(' | '), blocked: __savePoint.autoBlocked() }));
        ok(r.refused === 1 && r.fileLast === lastBefore, `고유값이 다른 파일에는 쓰지 않음 (${r.refused} ${r.fileLast}/${lastBefore})`);
        ok(r.last === lastBefore && r.toast.includes('고유값') && r.blocked === 'room', `화면도 이전 상태로, 고유값 안내, 그 방 저장 멈춤 (${r.last} ${r.blocked} ${r.toast.slice(0, 120)})`);
        await page.close();
    }

    // 4. A group room is written to the group file it showed (/api/chats/group/save, by its chat id).
    {
        const page = await session();
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await ev(f => { M.groups = [{ id: 'g1', name: 'Team', chat_id: 'groupchat1' }]; M.groupId = 'g1'; M.serverFiles.groupchat1 = f; }, file(msgs(12, 'Dee'), { integrity: 'int-g' }));
        await ev(() => M.openFile('groupchat1'));
        await page.waitForTimeout(800);
        await ev(() => { M.saveBodies = []; });
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        const r = await ev(() => ({ bodies: M.saveBodies, mem: !!M.serverFiles.groupchat1[0].chat_metadata.savePoint, n: M.serverFiles.groupchat1.length - 1 }));
        ok(r.bodies.length > 0 && r.bodies.every(x => x.url === '/api/chats/group/save' && x.name === 'groupchat1' && x.integrity === 'int-g' && x.count === 12), `그룹방은 그룹 파일로 저장 (${JSON.stringify(r.bodies.slice(0, 2))})`);
        ok(r.mem && r.n === 12, '그룹 파일에 기억이 들어가고 메시지는 그대로');
        await page.close();
    }

    // 5. SavePoint's copy is on its way (a slow write) when SillyTavern saves a newer page (a new message):
    //    the older copy may land last, so the room as it is now is sent once more; the new message stays.
    {
        const page = await session();
        const ev = (fn, arg) => page.evaluate(fn, arg);
        await ev(() => { M.add(12); });
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        await ev(() => { M.saveBodies = []; M.metaDelay = 700; __savePoint.persistSoon(); });
        await page.waitForTimeout(500);
        await ev(() => M.add(1));
        await page.waitForTimeout(1800);
        const r = await ev(() => ({ n: M.serverFiles.chatA.length - 1, sent: M.saveBodies.map(x => x.count) }));
        ok(r.n === 13 && r.sent.join() === '12,13', `늦게 도착한 예전 사본이 새 메시지를 지우지 않음 — 지금 방을 한 번 더 보냄 (파일 ${r.n}개, 보낸 것 ${r.sent.join(',')})`);
        await ev(() => { M.metaDelay = 0; M.saveBodies = []; __savePoint.persistSoon(); });
        await page.waitForTimeout(800);
        ok(await ev(() => M.saveBodies.length) === 1, '그사이 바뀐 게 없으면 한 번만 보냄');
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? failures + ' FAILED' : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
