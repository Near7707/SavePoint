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
    // v0.7.0-b2c: a room file has its integrity (SillyTavern's own; a memory file is made only for a room that has one).
    const file = (list, meta = {}) => JSON.parse(JSON.stringify([{ chat_metadata: { integrity: 'int-' + Math.random().toString(36).slice(2), ...meta } }, ...list]));
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
    r = { len: await fileLen('chatB'), saves: await ev(() => M.saves - M.saves0), meta: await ev(() => !!__savePoint.home().st) };
    ok(r.len === 12 && r.saves === 0 && !r.meta, `2. 열리는 중에 기억만 불러오기 → 저장 없음, 서버 12개 그대로 (${r.len})`);
    await ev(() => { M.onPopup = null; M.confirm = 1; });
    // finishing the load: the room is confirmed, has its own story, no offer, nothing changed
    await ev(f => M.switchChat('chatB', f.slice(1), {}), file(twelve));
    await page.waitForTimeout(1000);
    r = await ev(() => ({ offer: !!document.getElementById('sp_resume') && !document.getElementById('sp_resume').hidden, n: M.chat.length, file: M.serverFiles.chatB.length - 1 }));
    ok(!r.offer && r.n === 12 && r.file === 12, '1. 다 열린 뒤: 대화가 있는 방이라 이어하기를 묻지 않고 12개 그대로');

    // 3. an empty room asked about, and the messages arrive before the answer: nothing is changed.
    await ev(() => { M.serverFiles.chatE = [{ chat_metadata: { integrity: 'int-E' } }]; });   // v0.7.0-b2c: a room file has its integrity
    await ev(() => M.switchChat('chatE', [], {}));
    await page.waitForTimeout(400);
    const five = msgs(5, 'Late');
    await ev(f => { toastr.log.length = 0; M.onPopup = () => { M.chat.push(...JSON.parse(JSON.stringify(f))); M.serverFiles.chatE = [{ chat_metadata: { integrity: 'int-E' } }, ...JSON.parse(JSON.stringify(f))]; M.onPopup = null; }; }, five);
    await ev(async id => { M.confirm = 1; await __savePoint.loadSave(id); }, qid);
    r = await ev(() => ({ first: M.chat[0]?.mes, n: M.chat.length, st: !!__savePoint.state(), t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.first === five[0].mes && r.n === 5 && !r.st && r.t.includes('바뀌어서'), `3. 질문 사이 메시지가 도착 → 첫 메시지·기억 그대로 (${r.t.slice(0, 40)})`);
    r = await ev(() => M.serverFiles.chatE.length - 1);
    ok(r === 5, '3. 서버 파일도 5개 그대로');

    // 4. one system message (or any message that is not the card's greeting) is never replaced.
    for (const [label, m] of [['시스템 메시지', { name: 'System', is_user: false, is_system: true, mes: 'Ari joined the chat.', extra: {} }],
                              ['인사말이 아닌 메시지', { name: 'Ari', is_user: false, is_system: false, mes: 'A story already going on here.', swipe_id: 0, swipes: ['A story already going on here.'], extra: {} }]]) {
        const id = 'chatS' + label.length;
        await ev(([id, m]) => { M.serverFiles[id] = [{ chat_metadata: { integrity: 'int-' + id } }, m]; return M.switchChat(id, [JSON.parse(JSON.stringify(m))], {}); }, [id, m]);
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
    //    v0.7.0-b2c: the memory file write answers ok but is not written (M.memSwallowOnce): a new room's first save.
    await ev(() => M.switchChat('chatA2', [], {}));
    await ev(() => M.opened());
    await page.waitForTimeout(300);
    await ev(() => { M.add(10); });
    const quickBefore = await ev(() => JSON.stringify(__savePoint.listSaves().filter(x => x.quick).map(x => [x.id, x.updated])));
    await ev(() => { M.memSwallowOnce = true; M.memFails = []; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    r = await ev(() => ({ last: __savePoint.state()?.lastIndex ?? -1, file: M.mem()?.lastIndex ?? null, f: M.memFails.join(), t: toastr.log.map(x => x[1]).join(' | '), quick: JSON.stringify(__savePoint.listSaves().filter(x => x.quick).map(x => [x.id, x.updated])) }));
    ok(r.f === 'swallowed' && r.last === -1 && r.file === null && r.t.includes('저장하지 않았어요') && !r.t.includes('완료') && r.quick === quickBefore, `6. 조용한 저장 실패 → 저장 위치 그대로, QUICK 백업 없음, 실패 안내 (${r.last})`);
    // v0.7.0-b2c2b (D): said as a file not there, not as another device's save.
    ok(r.t.includes('파일이 없어서') && !r.t.includes('다른 곳'), `6. (b2c2b D) 조용한 실패를 다른 기기 탓으로 말하지 않음 (${r.t.slice(0, 80)})`);

    // 7. an unconfirmed save (the read-back fails): nothing taken back.
    //    v0.7.0-b2c: the memory file written, its read-back failing (M.memReadFailAfterWrite): the memory is the page's and the
    //    file's (a memory file answered ok is in the file: v0.7.0-b2a keeps only new hides off it until a read shows it); the
    //    next write after reads come back goes on as usual (older: the chat file, checkpoints and writes held).
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    await ev(() => { M.add(4); M.memReadFailAfterWrite = true; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    r = await ev(() => ({ last: __savePoint.state()?.lastIndex, file: (M.memReadFail = false, M.mem()?.lastIndex), unread: !!__savePoint.home().line?.unread, blocked: __savePoint.autoBlocked() }));
    ok(r.last === 13 && r.file === 13 && r.unread && r.blocked !== 'room', `7. (b2c) 기억 다시 읽기만 실패 → 되돌리지 않음, 새 숨김만 보류 표시 (${JSON.stringify(r)})`);
    await ev(() => { M.add(2); toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    r = await ev(() => ({ last: __savePoint.state()?.lastIndex, file: M.mem()?.lastIndex, unread: !!__savePoint.home().line?.unread, t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.last === 15 && r.file === 15 && !r.unread && r.t.includes('완료'), `7. (b2c) 다시 읽히면 평소대로 (${JSON.stringify(r)})`);
    // the write that did not land, and its read-back failing: a later write finds the old memory → said so, the room stops.
    await ev(() => { M.add(3); M.memSwallowOnce = true; M.memReadFail = true; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    await ev(() => { M.memReadFail = false; M.add(2); toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await page.waitForTimeout(1500);
    r = await ev(() => ({ t: toastr.log.map(x => x[1]).join(' | '), blocked: __savePoint.autoBlocked(), file: M.mem()?.lastIndex }));
    ok(r.t.includes('저장하지 않') && !r.t.includes('완료') && r.blocked === 'room' && r.file === 15, `7. 나중에 읽어 보니 저장이 없으면 그렇다고 알리고 계속 멈춤 (${r.t.slice(-60)})`);
    // 7c. a new room's first save written, its read-back failing: the memory written is not dropped from the page.
    //     v0.7.0-b2c2b (E): the server took the body but it was not read back (before its tag): the room stops with that said, no
    //     new hide and no later save until a read proves it; `다시 확인` then links the memory file found under its id without
    //     writing its body again (7d: opening the room again does the same).
    const hideWas = await ev(() => { const was = [M.settings.savePoint.hideMode, M.settings.savePoint.keepRecent]; Object.assign(M.settings.savePoint, { hideMode: 'auto', keepRecent: 2 }); return was; });   // so a save hides
    await ev(() => M.switchChat('chatA3', [], {}));
    await ev(() => M.opened());
    await ev(() => { M.add(10); M.memReadFailAfterWrite = true; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await page.waitForTimeout(1500);
    r = await ev(() => ({ last: __savePoint.state()?.lastIndex ?? -1, file: (M.memReadFail = false, M.mem()?.lastIndex ?? null), t: toastr.log.map(x => x[1]).join(' | '),
        blocked: __savePoint.autoBlocked(), hid: M.chat.filter(m => m.extra?.savepointHidden).length }));
    Object.assign(r, await ev(async () => { $('#sp_wand').trigger('click'); await new Promise(z => setTimeout(z, 200));
        const out = { alert: $('.sp-home-alert').text(), btn: $('.sp-home-alert [data-act="home-recheck"]').length };
        __savePoint.ui.open = false; $('#sp_overlay').hide(); return out; }));
    ok(r.file === 9 && r.last === 9 && !r.t.includes('다른 곳'), `7c. (b2c) 새 방 첫 저장이 다시 읽기만 실패: 저장한 기억을 화면에서 버리지 않음 (화면 #${r.last}, 파일 #${r.file}, ${r.t.slice(0, 50)})`);
    ok(r.t.includes('다시 읽어 확인하지 못했어요') && r.blocked === 'room' && r.hid === 0 && !r.t.includes('완료'), `7c. (b2c2b E) 방을 멈추고 확인 못 함을 알림, 새 숨김 없음 (${JSON.stringify({ blocked: r.blocked, hid: r.hid })} ${r.t.slice(0, 60)})`);
    ok(r.alert.includes('다시 읽어 확인하지 못했어요') && r.btn === 1, `7c. (b2c2b E) 창에 같은 안내와 다시 확인 버튼 (${r.alert.slice(0, 50)})`);
    // a later save is held (nothing written) while it is unproved
    r = await ev(async () => { const n = M.fileLog.length; M.add(2); toastr.log.length = 0; await __savePoint.handle('run').catch(() => {}); return { n, last: __savePoint.state()?.lastIndex, file: M.mem()?.lastIndex, t: toastr.log.map(x => x[1]).join(' | ') }; });
    ok(r.last === 9 && r.file === 9 && (await ev(n => M.fileLog.slice(n).filter(x => x[0] === 'put' && x[1].startsWith('savepoint-mem-')).length, r.n)) === 0, `7c. (b2c2b E) 확인 전 다음 세이브는 기억 파일을 쓰지 않음 (${r.t.slice(0, 60)})`);
    // reads back: `다시 확인` links the memory in the file, its body not written again
    r = await ev(async () => { const n = M.fileLog.length; await __savePoint.handle('home-recheck'); await M.opened(); await new Promise(z => setTimeout(z, 300));
        return { n, puts: M.fileLog.slice(n).filter(x => x[0] === 'put').map(x => x[1]), status: __savePoint.home().status, stop: __savePoint.home().line?.stop ?? null, unread: !!__savePoint.home().line?.unread,
            last: __savePoint.state()?.lastIndex, blocked: __savePoint.autoBlocked()}; });
    ok(r.status === 'linked' && !r.stop && !r.unread && r.last === 9 && r.blocked !== 'room' && !r.puts.some(x => x.startsWith('savepoint-mem-')) && r.puts.some(x => x.startsWith('savepoint-room-')),
        `7c. (b2c2b E) 다시 확인 → 파일의 기억에 연결, 기억 본체는 다시 쓰지 않음 (${JSON.stringify(r)})`);
    await ev(() => { M.add(2); toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await page.waitForTimeout(1500);
    r = await ev(() => ({ last: __savePoint.state()?.lastIndex, file: M.mem()?.lastIndex, hid: M.chat.filter(m => m.extra?.savepointHidden).length, t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.last === 13 && r.file === 13 && r.hid > 0 && r.t.includes('완료'), `7c. (b2c2b E) 그 뒤 세이브는 평소대로(새 숨김도) (${JSON.stringify(r).slice(0, 120)})`);
    // 7d. the same, then the room opened again (no `다시 확인`): linked to the file's memory, its body not written again.
    await ev(() => M.switchChat('chatA4', [], {}));
    await ev(() => M.opened());
    await ev(() => { M.add(10); M.memReadFailAfterWrite = true; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run').catch(() => {}));
    await page.waitForTimeout(1500);
    r = await ev(async () => { M.memReadFail = false; const n = M.fileLog.length, stop = __savePoint.home().line?.stop ?? null; await M.openFile('chatA4'); await M.opened(); await new Promise(z => setTimeout(z, 300));
        return { stop, puts: M.fileLog.slice(n).filter(x => x[0] === 'put').map(x => x[1]), status: __savePoint.home().status, last: __savePoint.state()?.lastIndex, file: M.mem()?.lastIndex, blocked: __savePoint.autoBlocked() }; });
    ok(r.stop === 'firstUnsure' && r.status === 'linked' && r.last === 9 && r.file === 9 && r.blocked !== 'room' && !r.puts.some(x => x.startsWith('savepoint-mem-')),
        `7d. (b2c2b E) 멈춘 뒤 방을 다시 열면 파일의 기억에 연결, 기억 본체는 다시 쓰지 않음 (${JSON.stringify(r)})`);
    await ev(([m, k]) => { Object.assign(M.settings.savePoint, { hideMode: m, keepRecent: k }); }, hideWas);

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
    skip('9. 이어하기: 첫 메시지가 저장 당시 메시지로 바뀌고 파일에도 저장', 'b3: #0 이어하기를 꺼 둠 (지금은 기억만 불러옴)');

    // 10. … and a long room that is already open loads only the memory, keeping every message.
    const thirty = msgs(30, 'Own');
    await ev(f => M.switchChat('chatLong', f, {}), thirty);
    await page.waitForTimeout(400);
    await ev(async id => { M.confirm = 1; toastr.log.length = 0; await __savePoint.loadSave(id); }, qid);
    r = await ev(() => ({ n: M.chat.length, first: M.chat[0].mes, file: (M.serverFiles.chatLong?.length ?? 0) - 1, mem: !!M.mem('chatLong')?.mem?.scenes?.length, t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(r.n === 30 && r.first === thirty[0].mes && r.file === 30 && r.mem && r.t.includes('불러왔어요'), `10. 이미 열린 긴 방: 원문 30개 그대로, 기억만 불러와 저장 (${r.t.slice(0, 30)})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
