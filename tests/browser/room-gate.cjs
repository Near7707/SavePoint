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
    // v0.6.58: the room gate. A room counts as open only when the chat file read from the server is
    // covered by the page; every write checks the file again first; big saves read it back after.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, hideMode: 'off' } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, is_system: false, mes: `${tag} message ${i} ${'and more '.repeat(6)}.`, swipe_id: 0, swipes: [`${tag} message ${i} ${'and more '.repeat(6)}.`], extra: {} }));
    const file = (list, meta = {}) => JSON.parse(JSON.stringify([{ chat_metadata: meta }, ...list]));
    const fileLen = name => ev(n => (M.serverFiles[n]?.length ?? 0) - 1, name);
    const toasts = () => ev(() => toastr.log.map(x => x[1]).join(' | '));
    // A QUICK save in the first room, to load from elsewhere.
    await ev(() => { M.add(8); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    const qid = await ev(() => __savePoint.listSaves().find(x => x.quick)?.id);
    ok(!!qid, '준비: 첫 방 QUICK');

    // 1. a room still opening (new id, no messages, no CHAT_CHANGED yet): the previous room's "continue?"
    //    timer must not offer anything, and a load started then writes nothing.
    const twelve = msgs(12, 'Long');
    await ev(f => { M.serverFiles.chatB = f; }, file(twelve));
    await ev(() => M.switchChat('chatN', [], {}));            // an empty new room: its offer timer starts
    await ev(() => { M.chatId = 'chatB'; M.chat = []; M.meta = {}; toastr.log.length = 0; M.saves0 = M.saves; });
    await page.waitForTimeout(1100);
    let r = await ev(() => { const el = document.getElementById('sp_resume'); return !!el && !el.hidden; });
    ok(!r, '1. 열리는 중인 방에는 직전 방 타이머가 이어하기 창을 띄우지 않음');
    await ev(async id => { M.confirm = 1; await __savePoint.loadSave(id); }, qid);
    r = { len: await fileLen('chatB'), saves: await ev(() => M.saves - M.saves0), t: await toasts() };
    ok(r.len === 12 && r.saves === 0 && r.t.includes('방이 아직'), `1. 열리는 중에 이어하기 → 아무것도 쓰지 않음, 서버 12개 그대로 (${r.len}, ${r.t.slice(0, 30)})`);

    // 2. the same with "memory only": no write either.
    await ev(() => { M.onPopup = t => { M.confirm = t.includes('기억만') ? 1 : 0; }; });
    await ev(async id => { await __savePoint.loadSave(id); }, qid);
    r = { len: await fileLen('chatB'), saves: await ev(() => M.saves - M.saves0), meta: await ev(() => !!M.meta.savePoint) };
    ok(r.len === 12 && r.saves === 0 && !r.meta, `2. 열리는 중에 기억만 불러오기 → 저장 없음, 서버 12개 그대로 (${r.len})`);
    await ev(() => { M.onPopup = null; M.confirm = 1; });
    // finishing the load: the room is confirmed, has its own story, no offer, nothing changed
    await ev(f => M.switchChat('chatB', f.slice(1), {}), file(twelve));
    await page.waitForTimeout(1000);
    r = await ev(() => ({ offer: !!document.getElementById('sp_resume') && !document.getElementById('sp_resume').hidden, n: M.chat.length, file: M.serverFiles.chatB.length - 1 }));
    ok(!r.offer && r.n === 12 && r.file === 12, '1. 다 열린 뒤: 대화가 있는 방이라 이어하기를 묻지 않고 12개 그대로');

    // 3. an empty room asked about, and the messages arrive before the answer: nothing is changed.
    await ev(() => { M.serverFiles.chatE = [{ chat_metadata: {} }]; });
    await ev(() => M.switchChat('chatE', [], {}));
    await page.waitForTimeout(400);
    const five = msgs(5, 'Late');
    await ev(f => { toastr.log.length = 0; M.onPopup = () => { M.chat.push(...JSON.parse(JSON.stringify(f))); M.serverFiles.chatE = [{ chat_metadata: {} }, ...JSON.parse(JSON.stringify(f))]; M.onPopup = null; }; }, five);
    await ev(async id => { M.confirm = 1; await __savePoint.loadSave(id); }, qid);
    r = await ev(() => ({ first: M.chat[0]?.mes, n: M.chat.length, st: !!__savePoint.state(), t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.first === five[0].mes && r.n === 5 && !r.st && r.t.includes('바뀌어서'), `3. 질문 사이 메시지가 도착 → 첫 메시지·기억 그대로 (${r.t.slice(0, 40)})`);
    r = await ev(() => M.serverFiles.chatE.length - 1);
    ok(r === 5, '3. 서버 파일도 5개 그대로');

    // 4. one system message (or any message that is not the card's greeting) is never replaced.
    for (const [label, m] of [['시스템 메시지', { name: 'System', is_user: false, is_system: true, mes: 'Ari joined the chat.', extra: {} }],
                              ['인사말이 아닌 메시지', { name: 'Ari', is_user: false, is_system: false, mes: 'A story already going on here.', swipe_id: 0, swipes: ['A story already going on here.'], extra: {} }]]) {
        const id = 'chatS' + label.length;
        await ev(([id, m]) => { M.serverFiles[id] = [{ chat_metadata: {} }, m]; return M.switchChat(id, [JSON.parse(JSON.stringify(m))], {}); }, [id, m]);
        await page.waitForTimeout(400);
        await ev(async q => { M.confirm = 1; await __savePoint.loadSave(q); }, qid);
        r = await ev(id => ({ first: M.chat[0].mes, n: M.chat.length, mem: !!__savePoint.state()?.mem?.scenes?.length, file: M.serverFiles[id][1].mes, fn: M.serverFiles[id].length - 1 }), id);
        ok(r.first === m.mes && r.n === 1 && r.mem && r.file === m.mes && r.fn === 1, `4. ${label} 하나뿐인 방: 원문 교체 없이 기억만 불러옴`);
    }

    // 5. a stale screen (the file has 22 messages, the page 20): nothing writes — quicksave, 🔖, 👻 included.
    const twenty = msgs(22, 'Shared');
    await ev(f => { M.serverFiles.chatD = f; return M.switchChat('chatD', f.slice(1, 21), {}); }, file(twenty));
    await page.waitForTimeout(400);
    r = await ev(() => ({ ready: __savePoint.ui && true, offer: !!document.getElementById('sp_resume') && !document.getElementById('sp_resume').hidden }));
    await ev(() => { toastr.log.length = 0; M.saves0 = M.saves; M.calls0 = M.calls.length; });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await page.waitForTimeout(800);
    r = { len: await fileLen('chatD'), saves: await ev(() => M.saves - M.saves0), ai: await ev(() => M.calls.length - M.calls0), t: await toasts() };
    ok(r.len === 22 && r.saves === 0 && r.ai === 0 && r.t.includes('이 화면에 없는 내용'), `5. 오래된 화면(서버 22·화면 20) 퀵세이브 → AI 호출·저장 없음, 안내 (${r.t.slice(0, 40)})`);
    await ev(() => __savePoint.toggleKeep(3).catch(e => { M.keepErr = e.message; }));
    r = await ev(() => ({ mark: !!M.chat[3].extra?.savepointKeep, err: M.keepErr || '', saves: M.saves - M.saves0, file: M.serverFiles.chatD.length - 1 }));
    ok(!r.mark && r.err.includes('이 화면에 없는 내용') && r.saves === 0 && r.file === 22, '5. 🔖 원문 유지도 화면을 바꾸기 전에 막힘');
    // a middle message edited on another device, a swipe, an attachment: also blocked (another extension's metadata: v0.6.101)
    for (const [label, change] of [['다른 기기에서 고친 중간 메시지', f => { f[6].mes += ' (edited)'; }],
                                   ['다른 확장의 메타데이터', f => { f[0].chat_metadata.otherExt = { v: 2 }; }],
                                   ['다른 스와이프 본문', f => { f[4].swipes.push('A new swipe.'); }],
                                   ['첨부', f => { f[2].extra.image = 'pic.png'; }]]) {
        const base = file(msgs(6, 'Same'), { otherExt: { v: 1 } });
        await ev(([f, id]) => { M.serverFiles[id] = f; return M.switchChat(id, JSON.parse(JSON.stringify(f.slice(1))), JSON.parse(JSON.stringify(f[0].chat_metadata))); }, [base, 'chatX' + label.length]);
        await page.waitForTimeout(400);
        const changed = JSON.parse(JSON.stringify(base)); change(changed);
        await ev(([f, id]) => { M.serverFiles[id] = f; M.saves0 = M.saves; toastr.log.length = 0; }, [changed, 'chatX' + label.length]);
        await ev(() => __savePoint.toggleKeep(1).catch(() => {}));
        r = await ev(id => ({ saves: M.saves - M.saves0, mark: !!M.chat[1].extra?.savepointKeep, ext: JSON.stringify(M.serverFiles[id][0].chat_metadata.otherExt) }), 'chatX' + label.length);
        // v0.6.101: another extension's metadata is sent as the file has it, so it no longer blocks (the file keeps { v: 2 }).
        if (label === '다른 확장의 메타데이터') { ok(r.saves === 1 && r.mark && r.ext === '{"v":2}', `5. ${label}는 막지 않고 파일 값 그대로 저장 (${JSON.stringify(r)})`); continue; }
        ok(r.saves === 0 && !r.mark, `5. ${label}가 서버에만 있으면 쓰지 않음`);
    }

    // 6. SillyTavern swallows a failed save: the file is read back, the save is taken back, no QUICK.
    await ev(() => M.switchChat('chatA2', [], {}));
    await page.waitForTimeout(300);
    await ev(() => { M.add(10); });
    const quickBefore = await ev(() => JSON.stringify(__savePoint.listSaves().filter(x => x.quick).map(x => [x.id, x.updated])));
    // v0.6.83: only the run's own write is swallowed. SillyTavern answers success only after writing, and a copy
    // answered with success is taken as the file (the base for deletions); the status save that follows the
    // failure is written normally (before, it was swallowed too and later took that copy for the file).
    await ev(() => { M.swallowMeta = true; M.swallowed = 0; M.beforeChatSave = async () => { if (M.swallowed >= 1) { M.swallowMeta = false; M.beforeChatSave = null; } }; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    r = await ev(() => ({ last: __savePoint.state()?.lastIndex ?? -1, t: toastr.log.map(x => x[1]).join(' | '), quick: JSON.stringify(__savePoint.listSaves().filter(x => x.quick).map(x => [x.id, x.updated])) }));
    ok(r.last === -1 && r.t.includes('채팅 파일은 그대로') && r.quick === quickBefore, `6. 조용한 저장 실패 → 저장 위치 그대로, QUICK 백업 없음, 실패 안내 (${r.last})`);
    await ev(() => { M.swallowMeta = false; });

    // 7. an unconfirmed save (the read-back fails): nothing taken back; checkpoints and other writes wait
    //    until a later read confirms it.
    await ev(() => { M.settings.savePoint.auto = true; M.settings.savePoint.autoEvery = 5; M.settings.savePoint.autoReserve = 0; M.readFailAfterSave = true; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await ev(() => ({ last: __savePoint.state()?.lastIndex, t: toastr.log.map(x => x[1]).join(' | '), quick: JSON.stringify(__savePoint.listSaves().filter(x => x.quick).map(x => [x.id, x.updated])) }));
    ok(r.last === 9 && r.t.includes('확인하지 못했어요') && r.quick === quickBefore, `7. 저장 확인 불가 → 자동으로 되돌리지 않음, 성공 안내·QUICK 백업 보류 (${r.t.slice(0, 40)})`);
    await ev(() => { M.readFailAfterSave = false; M.add(7); M.calls0 = M.calls.length; M.saves0 = M.saves; });
    await ev(() => __savePoint.autoCollect());
    await ev(() => __savePoint.toggleKeep(2).catch(e => { M.keepErr2 = e.message; }));
    await page.waitForTimeout(300);
    r = await ev(() => ({ ai: M.calls.length - M.calls0, saves: M.saves - M.saves0, blocked: __savePoint.autoBlocked(), keep: M.keepErr2 || '', mark: !!M.chat[2].extra?.savepointKeep }));
    ok(r.ai === 0 && r.saves === 0 && r.blocked === 'unsure' && r.keep.includes('확인하지 못했어요') && !r.mark, `7. 확인 전에는 체크포인트·다음 쓰기 보류 (${r.blocked})`);
    await ev(() => { M.serverError = false; toastr.log.length = 0; M.calls0 = M.calls.length; });
    await page.waitForTimeout(5500);
    r = await ev(() => ({ blocked: __savePoint.autoBlocked(), t: toastr.log.map(x => x[1]).join(' | '), ai: M.calls.length - M.calls0, last: __savePoint.state().lastIndex, n: M.chat.length }));
    ok(r.blocked !== 'unsure' && r.t.includes('들어가 있는 걸 확인'), `7. 다시 읽어 확인되면 평소대로 (${r.blocked})`);
    ok(r.ai > 0 && r.last === r.n - 1, `7. 그 뒤 체크포인트는 확인된 위치부터 이어감 (#${r.last}/${r.n - 1})`);
    // the write that did not land: a later read finds the old memory → said so, still nothing written
    await ev(() => { M.settings.savePoint.auto = false; M.add(3); M.swallowMeta = true; M.readFailAfterSave = true; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(800);
    await ev(() => { M.readFailAfterSave = false; M.serverError = false; });
    await page.waitForTimeout(3600);
    r = await ev(() => ({ t: toastr.log.map(x => x[1]).join(' | '), blocked: __savePoint.autoBlocked() }));
    ok(r.t.includes('들어가지 않았어요'), `7. 나중에 읽어 보니 저장이 없으면 그렇다고 알리고 계속 멈춤 (${r.t.slice(-50)})`);
    await ev(() => { M.swallowMeta = false; });

    // 8. an empty answer from the server (a new room or a failed read, no way to tell): no "continue?".
    await ev(() => { M.serverEmpty = true; });
    await ev(() => M.switchChat('chatQ', [], {}));
    await page.waitForTimeout(1200);
    r = await ev(() => { const el = document.getElementById('sp_resume'); return !!el && !el.hidden; });
    ok(!r, '8. 서버가 빈 응답이면 이어하기를 묻지 않음');
    await ev(async id => { toastr.log.length = 0; M.saves0 = M.saves; await __savePoint.loadSave(id); }, qid);
    r = { saves: await ev(() => M.saves - M.saves0), t: await toasts(), first: await ev(() => M.chat.length) };
    ok(r.saves === 0 && r.first === 0 && r.t.includes('찾지 못해서'), `8. 빈 응답인 방에는 불러오기도 막음 (${r.t.slice(0, 30)})`);
    await ev(() => { M.serverEmpty = false; });

    // 9. ordinary use still works: a new room with the card's greeting continues from the save …
    await ev(() => M.switchChat('chatNew', [{ name: 'Ari', is_user: false, is_system: false, mes: 'Hello! This is the very first greeting.', swipe_id: 0, swipes: ['Hello! This is the very first greeting.'], extra: {} }], {}));
    await page.waitForTimeout(1100);
    r = await ev(() => { const el = document.getElementById('sp_resume'); return !!el && !el.hidden; });
    ok(r, '9. 정상적인 새 방: 이어하기 창');
    await page.click('#sp_resume [data-resume-act="open"]');
    await ev(() => { M.confirm = 1; toastr.log.length = 0; });
    await page.click(`#sp_resume [data-resume="${qid}"]`);
    await page.waitForTimeout(800);
    r = await ev(() => ({ first: M.chat[0].mes, file: M.serverFiles.chatNew?.[1]?.mes, mem: !!__savePoint.state()?.mem?.scenes?.length, t: toastr.log.map(x => x[1]).join(' | ') + ' // ' + (M.popups || []).slice(-2).join(' / ') }));
    ok(r.first !== 'Hello! This is the very first greeting.' && r.file === r.first && r.mem, `9. 이어하기: 첫 메시지가 저장 당시 메시지로 바뀌고 파일에도 저장 (${r.t.slice(0, 30)})`);

    // 10. … and a long room that is already open loads only the memory, keeping every message.
    const thirty = msgs(30, 'Own');
    await ev(f => M.switchChat('chatLong', f, {}), thirty);
    await page.waitForTimeout(400);
    await ev(async id => { M.confirm = 1; toastr.log.length = 0; await __savePoint.loadSave(id); }, qid);
    r = await ev(() => ({ n: M.chat.length, first: M.chat[0].mes, file: (M.serverFiles.chatLong?.length ?? 0) - 1, mem: !!M.serverFiles.chatLong?.[0]?.chat_metadata?.savePoint?.mem?.scenes?.length, t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.n === 30 && r.first === thirty[0].mes && r.file === 30 && r.mem && r.t.includes('불러왔어요'), `10. 이미 열린 긴 방: 원문 30개 그대로, 기억만 불러와 저장 (${r.t.slice(0, 30)})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
