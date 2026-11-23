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

// v0.7.5-a1: a reply that keeps one scene across a new story day (by its own time stamps) is asked once more to split there;
// the first reply is never lost to that second request. Invented text only.
(async () => {
    const srv = await serve(), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.goto(`http://localhost:${srv.address().port}/`); await page.waitForFunction(() => !!globalThis.__savePoint);
    const ev = (fn, arg) => page.evaluate(fn, arg), run = () => ev(() => __savePoint.autoCollect());
    const snap = () => ev(() => ({ st: __savePoint.state(), calls: M.calls.length, fix: __savePoint.ui.lastFix?.text || '', retry: M.calls.filter(p => p.includes('new story day by your own time stamps')).length,
        scenes: __savePoint.state().mem.scenes.map(s => s.segs.map(g => `${g.from}-${g.to}`).join(',')) }));
    await ev(() => {
        M.settings.savePoint.check = false; $('#sp_wand').trigger('click');
        // Every message carries its date; the reply's scenes take the first and last one of their messages.
        const stampOf = m => { const x = /Date: (\d{4}-\d{2}-\d{2}) \| Time: (\d{2}:\d{2})/.exec(m.text); return { relation: 'explicit', date: x[1], clock: x[2], period: 'morning', msg: m.n, quote: x[0] }; };
        const day = m => stampOf(m).date;
        M.tweak = (data, { msgs, isRetry }) => {
            M.seen = (M.seen || 0) + 1;
            if (isRetry && M.retryThrows) return;
            if (isRetry && M.retryBad) { data.scenes[0].points[0].msgs = [99999]; return; }
            // (a2) A second reply that passes by leaving things out: no times and no state changes, still one scene.
            if (isRetry && M.retryStrips) { data.changes = []; return; }
            if (isRetry && M.retrySplits) {
                // One scene per story day, as asked.
                const first = data.scenes[0], starts = msgs.filter((m, i) => i === 0 || day(m) !== day(msgs[i - 1]));
                data.scenes = starts.map((m, i) => ({ ...first, scene: i ? 'new' : first.scene, ...(i ? { start: m.n } : {}), title: `Day ${day(m)}`, ended: i < starts.length - 1,
                    points: [{ text: `Something happened at ${m.n}.`, kind: 'moment', key: false, msgs: [m.n] }] }));
            }
            data.scenes.forEach((sc, i) => {
                const from = sc.start ?? msgs[0].n, to = (data.scenes[i + 1]?.start ?? msgs.at(-1).n + 1) - 1, mine = msgs.filter(m => m.n >= from && m.n <= to);
                sc.time = { mode: 'present', start: stampOf(mine[0]), end: stampOf(mine.at(-1)) };
            });
            // (a2) Split as asked, but the state changes are gone / a place comes back in Korean.
            if (isRetry && M.retryNoChanges) data.changes = [];
            if (isRetry && M.retryKoreanPlace) data.scenes.at(-1).where = '낡은 역 앞 광장';
            // (a3) Split, but every time stamp is gone / the promise is swapped for another change with the same count.
            if (isRetry && M.retryNoTimes) data.scenes.forEach(sc => { delete sc.time; });
            if (isRetry && M.retrySwap) data.changes = data.changes.map(c => ({ ...c, text: 'Something else was agreed.', msgs: [c.msgs[0] - 1], terms: c.terms && { ...c.terms, msg: c.msgs[0] - 1, quote: msgs.find(m => m.n === c.msgs[0] - 1).text.slice(0, 24) } }));
            if (isRetry && M.retryReword) data.changes = data.changes.map(c => ({ ...c, text: 'A promise was given here.' }));
            // (a4) A promise with a deadline (its words are in the message) / split, but the last stamp's quote or the deadline is gone.
            if (M.withDue) data.changes.forEach(c => { c.due = { expr: 'tomorrow', days: 1, msg: c.msgs[0] }; });
            if (isRetry && M.retryNoQuote) delete data.scenes.at(-1).time.end.quote;
            if (isRetry && M.retryNoDue) data.changes.forEach(c => { delete c.due; });
            // (a5) Split, but the new day is told as a flashback (same date, clock and quote).
            if (isRetry && M.retryFlashback) data.scenes.at(-1).time.mode = 'flashback';
            if (!isRetry && M.retryThrows) M.throwNext = new Error('Load failed');
        };
        window.addDays = (n, a, b) => M.add(n, i => `[Date: ${M.chat.length - window.__base < 10 ? a : b} | Time: 09:${String(10 + (M.chat.length % 50)).padStart(2, '0')}] The courier waited by the gate ${'and waited '.repeat(8)}.${window.__promise && M.chat.length - window.__base === 4 ? ` PROMISE${window.__due ? ' to come back tomorrow' : ''}` : ''}`);
    });
    const add = (a, b) => ev(([a, b]) => { window.__base = M.chat.length; addDays(M.chat.length ? 20 : 21, a, b); }, [a, b]);

    // The checkpoint leaves the newest messages for later: each round records up to three before the end (the last message must be the character's: 21 first, then 20).
    // 1. One day throughout: one request, as before.
    await add('1024-04-12', '1024-04-12'); await run(); let r = await snap();
    ok(r.st.lastIndex === 18 && r.calls === 1 && r.retry === 0 && r.scenes.length === 1 && !r.fix, '1. 날이 그대로면 요청 한 번, 다시 묻지 않음');

    // 2. Two days later inside the continued scene: asked once more, the second reply splits → saved split.
    let c0 = r.calls;
    await ev(() => { M.retrySplits = true; }); await add('1024-04-12', '1024-04-14'); await run(); r = await snap();
    ok(r.calls === c0 + 2 && r.retry === 1, '2. 한 장면 안에서 날이 바뀌면 한 번 더 물음(날이 바뀐 곳에서 나누라는 안내 포함)');
    ok(r.st.lastIndex === 38 && r.scenes.length === 2 && r.scenes[0] === '0-18,19-30' && r.scenes[1] === '31-38' && !r.st.autoFail && !r.fix, '2. 나눈 답이 저장됨(앞 장면은 날이 바뀌기 전까지, 새 장면은 그 메시지부터)');
    const asked = await ev(() => M.calls.at(-1).split('YOUR PREVIOUS REPLY WAS REJECTED')[1] || '');
    ok(/scenes\[0\] \(#19-#38\) runs into a new story day/.test(asked) && asked.includes('1024-04-12') && asked.includes('1024-04-14') && asked.includes('shown at #38'), '2. 다시 묻는 말에 장면 범위·두 날짜·근거 메시지');

    // 3. The second reply still does not split: saved as received, said so.
    c0 = r.calls;
    await ev(() => { M.retrySplits = false; }); await add('1024-04-14', '1024-04-16'); await run(); r = await snap();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 58 && r.scenes.length === 2 && !r.st.autoFail, '3. 다시 물어도 안 나누면 첫 응답을 저장(구간을 잃지 않음)');
    ok(r.fix.includes('나뉘지 않아'), '3. 자동 보정 줄에 나뉘지 않았다고 알림');

    // 4. The second reply does not pass the checks: the first reply is saved.
    c0 = r.calls;
    await ev(() => { M.retryBad = true; }); await add('1024-04-16', '1024-04-18'); await run(); r = await snap();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 78 && !r.st.autoFail && r.st.autoLast?.status !== 'failed' && r.fix.includes('쓸 수 없어'), '4. 다시 물은 답이 검사를 못 넘으면 첫 응답을 저장');

    // 5. The second request itself fails: the first reply is saved.
    c0 = r.calls;
    await ev(() => { M.retryBad = false; M.retryThrows = true; }); await add('1024-04-18', '1024-04-20'); await run(); r = await snap();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 98 && !r.st.autoFail && r.st.autoLast?.status !== 'failed' && r.fix.includes('쓸 수 없어'), '5. 다시 묻는 요청이 실패해도 첫 응답을 저장');

    // 6. A reply with another problem is asked again for that problem only, and its second reply is not asked a third time.
    c0 = r.calls;
    await ev(() => { M.retryThrows = false; M.throwNext = null; M.badOnce = true; }); await add('1024-04-20', '1024-04-22'); await run(); r = await snap();
    const last = await ev(() => M.calls.at(-1));
    ok(r.calls === c0 + 2 && r.st.lastIndex === 118 && !last.includes('new story day by your own') && r.fix.includes('나뉘지 않아') === false, '6. 다른 검사 실패의 재요청에는 끼지 않고, 요청은 두 번까지만');

    // 7. (a2, GPT P2-1) The second reply drops its times and its state change and is still one scene: it would pass every check, and
    // without a date nothing looks like a new day any more → the first reply is the one saved (its promise and its dates are there).
    const recs = () => ev(() => ({ n: __savePoint.state().mem.records.length, end: __savePoint.state().mem.scenes.at(-1).segs.at(-1).time?.end?.date || '' }));
    let q0 = (await recs()).n; c0 = r.calls;
    await ev(() => { M.badOnce = false; M.retryStrips = true; window.__promise = true; }); await add('1024-04-22', '1024-04-24'); await run(); r = await snap(); let q = await recs();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 138 && q.n === q0 + 1 && q.end === '1024-04-24' && r.fix.includes('나뉘지 않아'), '7. (a2) 날짜·상태 변경을 빼고 안 나눈 재응답은 쓰지 않고 첫 응답 저장(약속·날짜 그대로)');

    // 8. (a2) Split, but the state change is left out: the first reply is saved.
    q0 = q.n; c0 = r.calls;
    await ev(() => { M.retryStrips = false; M.retrySplits = true; M.retryNoChanges = true; }); await add('1024-04-24', '1024-04-26'); await run(); r = await snap(); q = await recs();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 158 && q.n === q0 + 1 && r.fix.includes('상태 변경이 빠져') && /빠진 것: 상태 변경 \d+개\)$/.test(r.fix), '8. (a2) 나눴어도 상태 변경이 줄어든 재응답은 쓰지 않고 첫 응답 저장 (a3) 알림은 "빠져" (a7) 빠진 것도 적음');

    // 9. (a2) Split, but a place is not in English: the first reply (its place is fine) is saved, nothing is blanked.
    q0 = q.n; c0 = r.calls; const sc0 = r.scenes.length;
    await ev(() => { M.retryNoChanges = false; M.retryKoreanPlace = true; }); await add('1024-04-26', '1024-04-28'); await run(); r = await snap(); q = await recs();
    const where = await ev(() => __savePoint.state().mem.scenes.at(-1).where);
    ok(r.calls === c0 + 2 && r.st.lastIndex === 178 && r.scenes.length === sc0 && where === 'Rail Street' && r.fix.includes('쓸 수 없어') && !r.fix.includes('비워'), '9. (a2) 장소가 영어가 아닌 재응답은 쓰지 않고 첫 응답 저장(장소를 비우지 않음)');

    // 10. Split in full, with the change kept: the second reply is saved.
    q0 = q.n; c0 = r.calls;
    await ev(() => { M.retryKoreanPlace = false; __savePoint.ui.lastFix = null; /* the line of the round before stays until the next one */ }); await add('1024-04-28', '1024-04-30'); await run(); r = await snap(); q = await recs();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 198 && r.scenes.length === sc0 + 1 && q.n === q0 + 1 && !r.fix, '10. (a2) 다 갖춰 나눈 재응답은 저장');

    // 11. (a3, GPT P2-1) Split at the right message, but the reply's time stamps are all gone: the first reply is saved.
    q0 = q.n; c0 = r.calls; let sc1 = r.scenes.length;
    await ev(() => { M.retryNoTimes = true; __savePoint.ui.lastFix = null; }); await add('1024-04-30', '1024-05-02'); await run(); r = await snap(); q = await recs();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 218 && r.scenes.length === sc1 && q.n === q0 + 1 && q.end === '1024-05-02' && r.fix.includes('날짜나 상태 변경이 빠져'), '11. (a3) 나눴지만 날짜를 모두 뺀 재응답은 쓰지 않고 첫 응답 저장(날짜 그대로)');

    // 12. (a3) Split, the promise swapped for another change (same count): the first reply is saved, its promise kept.
    q0 = q.n; c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.retryNoTimes = false; M.retrySwap = true; __savePoint.ui.lastFix = null; }); await add('1024-05-02', '1024-05-04'); await run(); r = await snap(); q = await recs();
    const lastRec = await ev(() => __savePoint.state().mem.records.at(-1)?.text || '');
    ok(r.calls === c0 + 2 && r.st.lastIndex === 238 && r.scenes.length === sc1 && q.n === q0 + 1 && /Promise made at/.test(lastRec) && r.fix.includes('상태 변경이 빠져'), '12. (a3) 상태 변경을 다른 것으로 바꾼 재응답은 쓰지 않고 첫 응답 저장(약속 그대로)');

    // 13. (a3) Split, the promise reworded over the same messages: the same change → the second reply is saved.
    q0 = q.n; c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.retrySwap = false; M.retryReword = true; __savePoint.ui.lastFix = null; }); await add('1024-05-04', '1024-05-06'); await run(); r = await snap(); q = await recs();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 258 && r.scenes.length === sc1 + 1 && q.n === q0 + 1 && !r.fix, '13. (a3) 같은 메시지의 같은 변경을 말만 바꾼 재응답은 저장');

    // 14. (a4, GPT review of a3, P2-1) Split, the same date, clock and message, but the last stamp's quote is gone: saved it would be
    // unconfirmed → the first reply is saved, its last date kept.
    q0 = q.n; c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.retryReword = false; M.retryNoQuote = true; __savePoint.ui.lastFix = null; }); await add('1024-05-06', '1024-05-08'); await run(); r = await snap(); q = await recs();
    let endSure = await ev(() => __savePoint.state().mem.scenes.at(-1).segs.at(-1).time?.end?.certainty);
    ok(r.calls === c0 + 2 && r.st.lastIndex === 278 && r.scenes.length === sc1 && q.n === q0 + 1 && q.end === '1024-05-08' && endSure === 'explicit' && r.fix.includes('날짜나 상태 변경이 빠져') && /빠진 것: 시간 \d+개\)$/.test(r.fix), '14. (a4) 날짜 값은 같아도 인용을 뺀 재응답은 쓰지 않고 첫 응답 저장(날짜 확정 그대로)');

    // 15. (a4, P2-2) Split, the promise kept but its deadline gone: the first reply is saved, the deadline with it.
    const dueOf = () => ev(() => __savePoint.state().mem.records.at(-1)?.due?.expr || '');
    q0 = q.n; c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.retryNoQuote = false; M.withDue = true; M.retryNoDue = true; window.__due = true; __savePoint.ui.lastFix = null; }); await add('1024-05-08', '1024-05-10'); await run(); r = await snap(); q = await recs();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 298 && r.scenes.length === sc1 && q.n === q0 + 1 && (await dueOf()) === 'tomorrow' && r.fix.includes('상태 변경이 빠져'), '15. (a4) 약속 기한을 뺀 재응답은 쓰지 않고 첫 응답 저장(기한 그대로)');

    // 16. (a4) Split with the deadline kept: the second reply is saved.
    q0 = q.n; c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.retryNoDue = false; __savePoint.ui.lastFix = null; }); await add('1024-05-10', '1024-05-12'); await run(); r = await snap(); q = await recs();
    endSure = await ev(() => __savePoint.state().mem.scenes.at(-1).segs.at(-1).time?.end?.certainty);
    ok(r.calls === c0 + 2 && r.st.lastIndex === 318 && r.scenes.length === sc1 + 1 && q.n === q0 + 1 && (await dueOf()) === 'tomorrow' && endSure === 'explicit' && !r.fix, '16. (a4) 기한·인용을 다 갖춰 나눈 재응답은 저장');

    // 17. (a5, GPT review of a4, P2-2) Split, but the new day's scene is a flashback: saved, the present would stay behind → the first reply.
    q0 = q.n; c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.retryFlashback = true; __savePoint.ui.lastFix = null; }); await add('1024-05-12', '1024-05-14'); await run(); r = await snap(); q = await recs();
    const modeEnd = await ev(() => { const t = __savePoint.state().mem.scenes.at(-1).segs.at(-1).time; return `${t?.mode} ${t?.end?.date}`; });
    ok(r.calls === c0 + 2 && r.st.lastIndex === 338 && r.scenes.length === sc1 && modeEnd === 'present 1024-05-14' && r.fix.includes('날짜나 상태 변경이 빠져'), '17. (a5) 새날 장면을 회상으로 바꾼 재응답은 쓰지 않고 첫 응답 저장(현재 시간 그대로)');
    await browser.close(); srv.close(); console.log(failures ? failures + ' FAILED' : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
