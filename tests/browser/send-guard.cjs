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
    // v0.7.0-c1: the send guard (sendGuard, SillyTavern's generation interceptor). A normal send whose reply would leave out
    // originals SavePoint hid that the briefing's memory does not cover is asked once: 취소 stops it, 이번만 lets it go; a group
    // keeps "이번만" for one send. Other kinds of reply are not asked. Found while the room is still opening: a short wait.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, hideMode: 'auto', keepRecent: 2, askResume: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const wait = ms => page.waitForTimeout(ms);
    const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, is_system: false, mes: `${tag} message ${i} ${'and more '.repeat(6)}.`, swipe_id: 0, swipes: [`${tag} message ${i} ${'and more '.repeat(6)}.`], extra: {} }));
    const file = list => JSON.parse(JSON.stringify([{ chat_metadata: { integrity: 'int-' + Math.random().toString(36).slice(2) } }, ...list]));
    // A room with no memory whose #0–#3 are SavePoint hides (copied from elsewhere): everything hidden is a gap.
    const copied = tag => file(msgs(8, tag).map((m, i) => (i < 4 ? { ...m, is_system: true, extra: { savepointHidden: 1 } } : m)));
    const recorded = async id => {
        await ev(([id, f]) => { M.serverFiles[id] = f; return M.openFile(id); }, [id, file(msgs(8, id))]);
        await ev(() => M.opened());
        await ev(() => __savePoint.handle('run').catch(() => {}));
        await wait(1800);
    };
    const openRoom = async (id, f) => { await ev(([id, f]) => { if (f) M.serverFiles[id] = f; return M.openFile(id); }, [id, f || null]); await ev(() => M.opened()); await wait(400); };
    // One reply as SillyTavern makes it: GENERATION_STARTED, GENERATION_AFTER_COMMANDS, then the interceptor (abort(true) recorded),
    // then the end. `pre`: run (as page code) right before the start, without waiting for the room (a send made while it opens).
    // `mid`: run after the start, before the interceptor (v0.7.0-c1a). A dry run never reaches the interceptor (SillyTavern skips it).
    const send = (type = 'normal', { dry = false, pre = null, during = null, mid = null } = {}) => ev(async ([type, dry, pre, during, mid]) => {
        const c = { p: (M.popups || []).length, t: toastr.log.length, s: M.stops || 0 };
        if (pre) await new Function(`return (async () => { ${pre} })()`)();
        await M.eventSource.emit('generation_started', type, {}, dry);
        await M.eventSource.emit('generation_after_commands', type, {}, dry);
        if (mid) await new Function(`return (async () => { ${mid} })()`)();
        let aborted = null; const t0 = Date.now();
        if (dry) return { aborted, pop: (M.popups || []).slice(c.p), toast: toastr.log.slice(c.t).map(x => x[1]).join(' | ') };
        const run = globalThis.savePointSendGuard([], 4096, now => { aborted = now; }, type);
        if (during) await new Function(`return (async () => { ${during} })()`)();
        await run;
        const ms = Date.now() - t0;
        await M.eventSource.emit('generation_ended');
        const h = __savePoint.home();
        return { aborted, ms, pop: (M.popups || []).slice(c.p), toast: toastr.log.slice(c.t).map(x => x[1]).join(' | '), stops: (M.stops || 0) - c.s,
            ok: M.popupOpts?.okButton || null, status: h.status, pending: !!(h.status === 'pending' || h.line?.pending), h2: h.h2?.why || null, inj: (M.prompts.savepoint?.v || '').length };
    }, [type, dry, pre, during, mid]);
    // v0.7.0-c1a: a group as SillyTavern runs it. A send: Generate (start + after commands, no interceptor: it hands over to the
    // group run) → GROUP_WRAPPER_STARTED → each member's reply (send) → FINISHED. A regenerate: the old replies deleted
    // (MESSAGE_DELETED) → the group run straight away, its members 'normal'. Auto mode: the run with type 'auto'.
    const outer = (type = 'normal') => ev(async type => { await M.eventSource.emit('generation_started', type, {}, false); await M.eventSource.emit('generation_after_commands', type, {}, false); }, type);
    const wrapStart = (type = 'normal') => ev(type => M.eventSource.emit('group_wrapper_started', { selected_group: 'g1', type }), type);
    const wrapEnd = (type = 'normal') => ev(type => M.eventSource.emit('group_wrapper_finished', { selected_group: 'g1', type }), type);
    const groupSend = async () => { await outer(); await wrapStart(); };
    let r;

    // 1. a recorded room: its hides (#0–#5) are covered by the memory → not asked, not stopped. Other kinds too.
    await recorded('sgA');
    r = await send();
    ok(r.aborted === null && !r.pop.length && r.status === 'linked', `1. 기록한 방의 숨김은 기억이 덮음 → 묻지 않고 진행 (${JSON.stringify(r)})`);
    r = await send('regenerate');
    ok(r.aborted === null && !r.pop.length, `1. 재생성도 그대로 (${JSON.stringify(r)})`);
    r = await send('normal', { dry: true });
    ok(r.aborted === null && !r.pop.length, `1. 미리 계산(dry run)은 확인 단계까지 안 감 (${JSON.stringify(r)})`);

    // 2. a room with no hides of SavePoint's (no memory) → not asked.
    await openRoom('sgN', file(msgs(6, 'sgN')));
    r = await send();
    ok(r.aborted === null && !r.pop.length, `2. 숨김 없는 새 방 → 묻지 않음 (${JSON.stringify(r)})`);

    // 3. hides copied into a room with no memory (held: SavePoint's marks but no memory found): asked; 취소 stops the reply (the message sent stays), 이번만 lets it go.
    await openRoom('sgC', copied('sgC'));
    await ev(() => { M.confirm = 0; });
    r = await send();
    ok(r.aborted === true && r.pop.length === 1 && /#0–#3\(4개\)/.test(r.pop[0]) && /보류했어요/.test(r.pop[0]) && r.status === 'held' && r.ok === '이번만 그대로 답변 만들기'
        && /이번 답변은 만들지 않았어요/.test(r.toast) && /빈 전송 문구/.test(r.toast) && !/캐릭터 답하기/.test(r.toast) && r.stops === 0, `3. 취소 → 이 답변만 멈춤·안내, 1:1은 전체 중단 안 부름 (${JSON.stringify(r)})`);
    await ev(() => { M.confirm = 1; });
    r = await send();
    ok(r.aborted === null && r.pop.length === 1 && !r.toast, `3. 이번만 그대로 → 진행 (${JSON.stringify(r)})`);
    r = await send();
    ok(r.pop.length === 1, `3. 1:1의 "이번만"은 그 답변 한 번 → 다음 전송은 다시 물음 (${JSON.stringify(r)})`);
    for (const t of ['regenerate', 'swipe', 'continue', 'impersonate', 'quiet']) {
        r = await send(t);
        ok(r.aborted === null && !r.pop.length, `3. ${t}는 묻지 않음 (${JSON.stringify(r)})`);
    }
    await ev(() => { M.confirm = null; });
    r = await send();
    ok(r.aborted === true && /만들지 않았어요/.test(r.toast), `3. 창 닫기(답 없음) = 취소 (${JSON.stringify(r)})`);
    await ev(() => { M.confirm = 1; });

    // 4. a room whose memory file cannot be read: the memory is not on the page, every hide is a gap.
    await recorded('sgR');
    await ev(() => { M.memReadFail = true; });
    await openRoom('sgR');
    r = await send();
    ok(r.status === 'readFail' && r.pop.length === 1 && /#0–#5\(6개\)/.test(r.pop[0]) && /읽지 못했어요/.test(r.pop[0]) && r.aborted === null, `4. 기억 읽기 실패 방 → 물음, 이번만 → 진행 (${JSON.stringify(r)})`);
    await ev(() => { M.memReadFail = false; });

    // 5. a recorded original changed elsewhere (H2 source): the briefing is the memory rolled back from it (liveState); one record's
    //    scene covers #0–#7, so rolled back from #3 nothing is left: no briefing, every hide is a gap.
    await recorded('sgS');
    await ev(() => { const f = M.serverFiles.sgS; f[4].mes = f[4].swipes[0] = 'changed elsewhere #3'; });
    await openRoom('sgS');
    r = await send();
    ok(r.h2 === 'source' && r.pop.length === 1 && /#0–#5\(6개\)/.test(r.pop[0]) && /원문이 바뀌어서/.test(r.pop[0]) && r.inj === 0, `5. 원문이 바뀐 방 → 되감은 기억(브리핑 없음) 기준으로 물음 (${JSON.stringify(r)})`);
    //    saving stopped (a memory write with no answer: pending), but the memory on the page still covers every hide: not asked.
    await recorded('sgT');
    await ev(() => { M.memFailOnce = 'lost'; });
    await ev(() => __savePoint.toggleKeep(7).catch(() => {}));
    await wait(600);
    r = await send();
    ok(!!r.pending && !r.pop.length && r.aborted === null && r.inj > 0, `5. 저장이 멈췄어도 기억이 숨김을 덮으면 묻지 않음 (${JSON.stringify(r)})`);

    // 6. sent while the room still opens (its memory file slow): waits, then the memory covers the hides → not asked, briefing in.
    await ev(() => { M.fileDelay['*'] = 1200; });
    r = await send('normal', { pre: "await M.openFile('sgA');" });
    ok(r.aborted === null && !r.pop.length && r.ms >= 700 && r.status === 'linked' && r.inj > 0, `6. 방 여는 중 전송 → 기다렸다가 기억 연결 → 묻지 않고 브리핑 포함 (${JSON.stringify(r)})`);
    //    the page's hides change while it waits: the messages to send were copied before → stopped, told.
    r = await send('normal', { pre: "await M.openFile('sgS');", during: "await new Promise(z => setTimeout(z, 300)); M.chat[1].is_system = false; delete M.chat[1].extra.savepointHidden;" });
    ok(r.aborted === true && !r.pop.length && /바뀌어서, 이번 답변은 만들지 않았어요/.test(r.toast), `6. 기다리는 사이 숨김이 바뀜 → 멈추고 안내 (${JSON.stringify(r)})`);
    await ev(() => { M.fileDelay = {}; });
    await openRoom('sgA');

    // 7. the room changes while the question is open: that reply stops (answer ignored).
    await ev(() => { M.confirm = 1; M.onPopup = async () => { await M.openFile('sgA'); }; });
    await openRoom('sgC');
    r = await send();
    ok(r.aborted === true && /방이 바뀌어서/.test(r.toast) && r.stops === 0, `7. 확인창 중 방 이동 → 그 답변 멈춤 (${JSON.stringify(r)})`);
    await ev(() => { M.onPopup = null; });
    //    an error in the check = 취소.
    await openRoom('sgC');
    await ev(() => { M.onPopup = async () => { M.promptThrow = 1; }; });
    r = await send();
    ok(r.aborted === true && /오류가 나서/.test(r.toast), `7. 확인 중 오류 → 취소로 (${JSON.stringify(r)})`);
    await ev(() => { M.onPopup = null; M.promptThrow = 0; });

    // 8. a group: "이번만" holds for the replies of one send; 취소 stops the whole group (only the reply going now).
    await ev(f => { M.groups = [{ id: 'g1', name: 'Team', chat_id: 'sgG' }]; M.groupId = 'g1'; M.serverFiles.sgG = f; }, copied('sgG'));
    await openRoom('sgG');
    await groupSend();
    r = await send();
    const r2 = await send();
    ok(r.pop.length === 1 && r.aborted === null && !r2.pop.length && r2.aborted === null, `8. 그룹: 한 번 묻고 같은 전송의 다음 캐릭터는 그대로 (${JSON.stringify([r, r2])})`);
    //    within the same send, a gap that changed (another hide of SavePoint's) is asked again.
    await ev(() => { M.chat[5].is_system = true; M.chat[5].extra = { savepointHidden: 1 }; });
    r = await send();
    ok(r.pop.length === 1 && /#0–#3, #5\(5개\)/.test(r.pop[0]) && r.aborted === null, `8. 같은 전송 안에서도 빠지는 구간이 바뀌면 다시 물음 (${JSON.stringify(r)})`);
    await ev(() => { M.chat[5].is_system = false; M.chat[5].extra = {}; });
    await wrapEnd();
    await ev(() => { M.confirm = 0; });
    await groupSend();
    r = await send();
    await wrapEnd();
    ok(r.pop.length === 1 && r.aborted === true && r.stops === 1 && /캐릭터 답하기/.test(r.toast) && /빈 전송 문구/.test(r.toast), `8. 다음 전송은 다시 물음, 취소 → 그룹 전체 중단 + 그룹 안내 (${JSON.stringify(r)})`);
    //    the room changes while asked: that reply stops at once (the old group's loop too, nothing else goes yet); the window answered
    //    later, after a reply started in the new room, changes nothing (no second stop).
    await ev(() => { M.confirm = 1; M.onPopup = async () => { M.groupId = null; await M.openFile('sgA'); await new Promise(z => setTimeout(z, 100)); window.__s0 = M.stops || 0; await M.eventSource.emit('generation_started', 'quiet', {}, false); await new Promise(z => setTimeout(z, 100)); }; });
    await groupSend();
    r = await send();
    await wrapEnd();
    await wait(500);   // the window (onPopup) is answered only now, after the new room's reply started
    const late = await ev(() => (M.stops || 0) - window.__s0);
    ok(r.aborted === true && r.stops === 1 && late === 0 && /방이 바뀌어서/.test(r.toast), `8. 확인창 중 방 이동 → 그때 멈춤, 늦게 닫힌 창은 새 방 생성을 안 멈춤 (${JSON.stringify({ r, late })})`);
    await ev(() => { M.onPopup = null; M.groupId = 'g1'; });
    await openRoom('sgG');
    //    a reply of the group already moved on (another generation started meanwhile, same room): the answer stops nothing else.
    await ev(() => { M.confirm = 0; M.onPopup = async () => { await M.eventSource.emit('generation_started', 'quiet', {}, false); }; });
    await groupSend();
    r = await send();
    await wrapEnd();
    ok(r.aborted === true && r.stops === 0, `8. 묻는 사이 다른 생성이 시작됨 → 전체 중단은 안 부름 (${JSON.stringify(r)})`);
    await ev(() => { M.onPopup = null; });

    // ───── v0.7.0-c1a: review of c1 ─────
    // 9. (P1) a group regenerate deletes the old replies, then runs its members as 'normal': not asked, not stopped (cancelling would
    //    lose the deleted replies). Auto mode the same. A send is still asked, once.
    await ev(() => { M.confirm = 0; });
    await groupSend(); r = await send(); await wrapEnd();
    ok(r.pop.length === 1 && r.aborted === true, `9. 그룹 일반 전송은 여전히 물음 (${JSON.stringify(r)})`);
    await ev(() => M.eventSource.emit('message_deleted', M.chat.length));
    await wrapStart(); r = await send(); const r9b = await send(); await wrapEnd();
    ok(!r.pop.length && r.aborted === null && r.stops === 0 && !r9b.pop.length && r9b.aborted === null, `9. 그룹 재생성(답변 삭제 → 묶음) → 묻지 않고 진행 (${JSON.stringify([r, r9b])})`);
    await wrapStart('auto'); r = await send(); await wrapEnd('auto');
    ok(!r.pop.length && r.aborted === null, `9. 그룹 자동 진행 → 묻지 않음 (${JSON.stringify(r)})`);
    //    a send ended by a slash command: GENERATION_STARTED only (no after-commands, no end) — the regenerate that follows is not asked.
    await ev(() => M.eventSource.emit('generation_started', 'normal', {}, false));
    await wrapStart(); r = await send(); await wrapEnd();
    ok(!r.pop.length && r.aborted === null, `9. 슬래시 명령으로 끝난 전송 뒤 재생성 → 묻지 않음 (${JSON.stringify(r)})`);
    //    a send whose group run never started (it returned before: no connection), then a regenerate: its deletion drops the candidate.
    await outer();
    await ev(() => M.eventSource.emit('message_deleted', M.chat.length));
    await wrapStart(); r = await send(); await wrapEnd();
    ok(!r.pop.length && r.aborted === null, `9. 묶음이 시작 안 된 전송의 후보는 삭제로 버려짐 → 그 뒤 재생성은 묻지 않음 (${JSON.stringify(r)})`);
    //    a send whose group run never started, then another generation started (and ended by a command, no end signal) before a
    //    group run (a regenerate that deleted nothing): the candidate is not that run's.
    await outer();
    await ev(() => M.eventSource.emit('generation_started', 'normal', {}, false));
    await wrapStart(); r = await send(); await wrapEnd();
    ok(!r.pop.length && r.aborted === null, `9. 후보 뒤 다른 생성이 시작됨 → 그 뒤 묶음은 묻지 않음 (${JSON.stringify(r)})`);
    //    a dry run (prompt preview) started in between does not change that: the send's member is still asked.
    await groupSend();
    r = await send('normal', { mid: "await M.eventSource.emit('generation_started', 'normal', {}, true); await M.eventSource.emit('generation_after_commands', 'normal', {}, true);" });
    await wrapEnd();
    ok(r.pop.length === 1 && r.aborted === true, `9. 그룹 전송 중 미리 계산이 끼어도 물음 (${JSON.stringify(r)})`);
    await ev(() => { M.onPopup = null; M.groupId = null; M.groups = []; });

    // 10. (P2-2) 1:1: a dry run started after the send started (before its interceptor) does not let the send pass unasked.
    await openRoom('sgC');
    r = await send('normal', { mid: "await M.eventSource.emit('generation_started', 'normal', {}, true); await M.eventSource.emit('generation_after_commands', 'normal', {}, true);" });
    ok(r.pop.length === 1 && r.aborted === true, `10. 전송 중 미리 계산이 끼어도 물음 (${JSON.stringify(r)})`);
    // 11. (P2-1) a hide of the start taken away before the interceptor (the copy to send still leaves it out): stopped, told.
    r = await send('normal', { mid: "for (const m of M.chat) if (m.is_system && m.extra?.savepointHidden) { m.is_system = false; delete m.extra.savepointHidden; }" });
    ok(r.aborted === true && !r.pop.length && /바뀌어서, 이번 답변은 만들지 않았어요/.test(r.toast), `11. 시작 뒤 숨김이 모두 풀림 → 멈추고 안내 (${JSON.stringify(r)})`);
    //    the same with a dry run started in between (it keeps no start of its own).
    await openRoom('sgC', copied('sgC2'));
    r = await send('normal', { mid: "await M.eventSource.emit('generation_started', 'normal', {}, true); for (const m of M.chat) if (m.is_system && m.extra?.savepointHidden) { m.is_system = false; delete m.extra.savepointHidden; }" });
    ok(r.aborted === true && !r.pop.length && /바뀌어서/.test(r.toast), `11. 사이에 미리 계산이 끼어도 시작 숨김과 비교 (${JSON.stringify(r)})`);
    //    a recorded room: a hide added after the start (covered) is no change; the message at a hidden place replaced is.
    await recorded('sgH');
    r = await send('normal', { mid: "const i = M.chat.findIndex(m => !m.is_system); M.chat[i].is_system = true; M.chat[i].extra = { ...(M.chat[i].extra || {}), savepointHidden: 1 };" });
    ok(r.aborted === null && !r.pop.length, `11. 시작 뒤 숨김이 늘어난 건 멈추지 않음 (${JSON.stringify(r)})`);
    r = await send('normal', { mid: "const i = M.chat.findIndex(m => m.is_system && m.extra?.savepointHidden); M.chat[i] = JSON.parse(JSON.stringify(M.chat[i]));" });
    ok(r.aborted === true && /바뀌어서/.test(r.toast), `11. 숨긴 자리의 메시지가 바뀜 → 멈춤 (${JSON.stringify(r)})`);

    await page.close();
    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
