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

// v0.6.76 (review of v0.6.72): SavePoint's own chat file write never sends an older page over what another
// device saved meanwhile. 1–2: waiting for SillyTavern's write happens before the file check, not between
// the check and the write. 3–5: sending the page again (it changed while the first copy was on its way) reads
// the file first and stops when it holds something this page lacks or cannot be read. 6–7: a failure once
// the first copy landed does not take the change back on the page. 8: a page that only moved on by itself
// (SillyTavern saved it meanwhile) is still sent again, with no warning. 9: so is a page whose own older copy
// landed after SillyTavern's newer save.
// Open (not tested as fixed): a copy already on its way that lands after SillyTavern saved a newer page and
// after the room was left is not sent again (README, known limits).
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
        await ev(() => { M.add(12); });
        await ev(() => __savePoint.handle('run'));
        await page.waitForTimeout(1500);
        await ev(() => { M.saveBodies = []; M.toastLog = toastr.log.length; });
        return { page, ev };
    }
    const other = { name: 'Me', is_user: true, is_system: false, mes: 'Written on the other device.', swipe_id: 0, extra: {} };
    const mine = { name: 'Me', is_user: true, is_system: false, mes: 'Written on this page.', swipe_id: 0, extra: {} };
    const fileLast = ev => ev(() => M.serverFiles.chatA.at(-1).mes);
    const toasts = ev => ev(() => toastr.log.slice(M.toastLog).map(x => x.join(': ')).join(' / '));

    // 1. A small save waits for SillyTavern's write; another device adds a message meanwhile → nothing sent.
    {
        const { page, ev } = await session();
        ok(await ev(() => !!__savePoint.state()?.mem?.scenes?.length), '준비: 방 A에 기억이 있음 (12개)');
        await ev(() => { M.stScript.setChatSaving(true); __savePoint.state().probe = 'small'; __savePoint.persistSoon(); });
        await page.waitForTimeout(800);
        await ev(o => { M.serverFiles.chatA.push(o); }, other);
        await ev(() => M.stScript.setChatSaving(false));
        await page.waitForTimeout(2600);   // the file check reads up to three times (0, 0.5, 1.5 s)
        ok(await ev(() => M.saveBodies.length) === 0, '1. 기다리는 사이 다른 기기가 쓴 방에는 작은 저장을 보내지 않음');
        ok(await fileLast(ev) === other.mes && await ev(() => M.serverFiles.chatA.length - 1) === 13, '1. 다른 기기의 13번째 메시지가 파일에 그대로');
        const b1 = await ev(() => __savePoint.autoBlocked());
        ok(b1 === 'room', `1. 방을 막음(다음 저장도 멈춤) (${b1})`);
        await page.close();
    }

    // 2. The same through the queue (a button edit): checked after the wait, the change is not made at all.
    {
        const { page, ev } = await session();
        await ev(() => { M.stScript.setChatSaving(true); window.__done = __savePoint.transact(() => { __savePoint.state().probe = 'queued'; }).then(() => 'ok', e => e.message); });
        await page.waitForTimeout(600);
        await ev(o => { M.serverFiles.chatA.push(o); }, other);
        await ev(() => M.stScript.setChatSaving(false));
        const msg = await ev(() => window.__done);
        ok(msg !== 'ok' && await ev(() => M.saveBodies.length) === 0, `2. 대기열 변경도 대기 뒤 서버 확인에서 멈춤 (${String(msg).slice(0, 50)})`);
        ok(await ev(() => __savePoint.state().probe === undefined), '2. 화면의 기억도 바꾸지 않음');
        ok(await fileLast(ev) === other.mes, '2. 다른 기기의 메시지가 파일에 그대로');
        await page.close();
    }

    // 3. Sending again: the first copy lands, another device then saves a message, this page also gets one.
    //    The file is read before sending again → it holds the other device's message → not sent, room blocked;
    //    the change that landed stays on the page.
    {
        const { page, ev } = await session();
        await ev(() => {
            M.metaDelay = 400; let n = 0;
            M.beforeChatSave = async name => { if (++n === 1) { M.readDelayFor = { chatA: 150 }; setTimeout(() => M.serverFiles[name].push(window.__other), 450); } };
        });
        await ev(o => { window.__other = o; window.__done = __savePoint.transact(() => { __savePoint.state().probe = 'resend'; }).then(() => 'ok', e => e.message); }, other);
        await page.waitForTimeout(200);
        await ev(m => { M.noStSave = true; M.chat.push(m); }, mine);
        const msg = await ev(() => window.__done);
        ok(await ev(() => M.saveBodies.length) === 1, '3. 서버가 그사이 바뀌어서 다시 보내지 않음 (첫 요청 1번만)');
        ok(await fileLast(ev) === other.mes, '3. 다른 기기의 메시지가 파일에 그대로');
        ok(await ev(() => __savePoint.state().probe) === 'resend' && await ev(() => M.serverFiles.chatA[0].chat_metadata.savePoint.probe) === 'resend', '3. 들어간 변경은 화면에서 되돌리지 않음(파일에도 있음)');
        ok(/저장했어요/.test(msg) && !/취소/.test(msg), `3. 안내: 저장은 했고 더 저장하지 않음 (${String(msg).slice(0, 60)})`);
        ok(await ev(() => __savePoint.autoBlocked()) === 'room', '3. 방을 막음');
        await page.close();
    }

    // 4. Sending again, but the file cannot be read at that moment → not sent, "could not confirm", kept.
    {
        const { page, ev } = await session();
        await ev(() => { M.metaDelay = 400; let n = 0; M.beforeChatSave = async () => { if (++n === 1) { M.readDelayFor = { chatA: 150 }; setTimeout(() => { M.serverError = true; }, 450); } }; });
        await ev(() => { window.__done = __savePoint.transact(() => { __savePoint.state().probe = 'unread'; }).then(() => 'ok', e => `${e.name}: ${e.message}`); });
        await page.waitForTimeout(200);
        await ev(m => { M.noStSave = true; M.chat.push(m); }, mine);
        const msg = await ev(() => window.__done);
        ok(await ev(() => M.saveBodies.length) === 1, '4. 서버를 읽지 못하면 다시 보내지 않음');
        ok(await ev(() => __savePoint.state().probe) === 'unread', '4. 들어간 변경은 화면에서 되돌리지 않음');
        ok(/Unconfirmed/.test(msg) && /확인하지 못했어요/.test(msg), `4. 안내: 저장 확인 못 함 (${String(msg).slice(0, 50)})`);
        ok(await ev(() => __savePoint.autoBlocked()) === 'unsure', '4. 확인될 때까지 저장 멈춤');
        await ev(() => { M.serverError = false; });
        await page.waitForTimeout(3600);
        ok(await ev(() => __savePoint.autoBlocked()) !== 'unsure', '4. 다시 읽을 수 있게 되면 확인되고 풀림');
        await page.close();
    }

    // 5. The same for a small save: not sent again, the change stays, reported.
    {
        const { page, ev } = await session();
        await ev(() => {
            M.metaDelay = 400; let n = 0;
            M.beforeChatSave = async name => { if (++n === 1) { M.readDelayFor = { chatA: 150 }; setTimeout(() => M.serverFiles[name].push(window.__other), 450); } };
        });
        await ev(o => { window.__other = o; __savePoint.state().probe = 'small-resend'; __savePoint.persistSoon(); }, other);
        await page.waitForTimeout(500);
        await ev(m => { M.noStSave = true; M.chat.push(m); }, mine);
        await page.waitForTimeout(1500);
        ok(await ev(() => M.saveBodies.length) === 1 && await fileLast(ev) === other.mes, '5. 작은 저장도 서버가 바뀌었으면 다시 보내지 않음');
        ok(await ev(() => __savePoint.state().probe) === 'small-resend', '5. 화면의 변경은 그대로');
        ok(/더 저장하지 않았어요|저장하지 않았어요/.test(await toasts(ev)), '5. 안내가 뜸');
        await page.close();
    }

    // 6. P2: the first copy lands, the page changes, sending again gets a 500. Not taken back on the page.
    {
        const { page, ev } = await session();
        await ev(() => { M.metaDelay = 300; M.failNth = 2; setTimeout(() => { M.noStSave = true; M.chat.push(window.__mine); }, 100); });
        const msg = await ev(m => { window.__mine = m; return new Promise(r => setTimeout(r, 0)).then(() => __savePoint.transact(() => { __savePoint.state().probe = 'ON'; }).then(() => 'ok', e => e.message)); }, mine);
        ok(await ev(() => M.saveBodies.length) === 2, '6. 준비: 두 번째 요청이 500으로 실패');
        ok(await ev(() => __savePoint.state().probe) === 'ON' && await ev(() => M.serverFiles.chatA[0].chat_metadata.savePoint.probe) === 'ON', '6. 첫 요청이 들어갔으면 화면에서 되돌리지 않음(파일과 같음)');
        ok(msg === 'ok', `6. 파일을 읽어 이번 변경이 들어간 걸 확인 → "취소했어요" 없음 (${String(msg).slice(0, 50)})`);
        ok(await ev(() => __savePoint.autoBlocked()) !== 'unsure' && await ev(() => __savePoint.autoBlocked()) !== 'room', '6. 방도 막지 않음');
        await page.close();
    }

    // 7. A 500 on the very first copy is still taken back (nothing reached the file).
    {
        const { page, ev } = await session();
        await ev(() => { M.failOnce = true; });
        const msg = await ev(() => __savePoint.transact(() => { __savePoint.state().probe = 'first'; }).then(() => 'ok', e => e.message));
        ok(/취소했어요/.test(msg) && await ev(() => __savePoint.state().probe === undefined), '7. 첫 요청이 실패하면 지금처럼 되돌림');
        await page.close();
    }

    // 8. Ordinary: SillyTavern saves this page's new message while the first copy is on its way → sent again
    //    (the file holds nothing this page lacks), no warning, the room stays open.
    {
        const { page, ev } = await session();
        await ev(() => { M.metaDelay = 400; });
        await ev(() => { window.__done = __savePoint.transact(() => { __savePoint.state().probe = 'normal'; }).then(() => 'ok', e => e.message); });
        await page.waitForTimeout(150);
        await ev(() => M.add(1));
        const msg = await ev(() => window.__done);
        ok(msg === 'ok' && await ev(() => M.saveBodies.length) === 2, '8. 이 화면 자신의 새 메시지면 다시 보냄(경고 없음)');
        ok(await ev(() => M.serverFiles.chatA.length - 1) === 13 && await ev(() => M.serverFiles.chatA[0].chat_metadata.savePoint.probe) === 'normal', '8. 파일에 새 메시지와 변경이 모두 있음');
        ok(await ev(() => __savePoint.autoBlocked()) !== 'room' && !/저장하지 않았어요/.test(await toasts(ev)), '8. 방을 막지 않음');
        await page.close();
    }

    // 9. SillyTavern saves a newer page (an edited message and a new one) while the first copy is on its way,
    //    and the copy lands after it: the file is then this page's own older copy, not something foreign →
    //    sent again, the file ends with the newer page, no warning.
    {
        const { page, ev } = await session();
        await ev(() => { M.metaDelay = 400; });
        await ev(() => { window.__done = __savePoint.transact(() => { __savePoint.state().probe = 'late'; }).then(() => 'ok', e => e.message); });
        await page.waitForTimeout(150);
        await ev(() => { const m = M.chat[3]; m.mes = 'An edited line from this page.'; m.swipes = [m.mes]; M.add(1); });
        const msg = await ev(() => window.__done);
        ok(msg === 'ok' && await ev(() => M.saveBodies.length) === 2, `9. 늦게 도착한 내 사본 위에는 다시 보냄 (${String(msg).slice(0, 40)})`);
        ok(await ev(() => M.serverFiles.chatA[4].mes) === 'An edited line from this page.' && await ev(() => M.serverFiles.chatA.length - 1) === 13, '9. 파일이 지금 화면(고친 메시지·새 메시지)으로 끝남');
        ok(await ev(() => __savePoint.autoBlocked()) !== 'room' && await ev(() => __savePoint.autoBlocked()) !== 'unsure', '9. 방을 막지 않음');
        await page.close();
    }

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})();
