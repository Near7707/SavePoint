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
        M.tweak = (data, { msgs, isRetry, prompt }) => {
            if (!isRetry && M.limitAt) M.settings.savePoint.inputChars = prompt.length + M.limitAt;
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
            // (a11) The first reply cites the message before the promise too; the retry writes the change anew over the promise only /
            // over the message after it.
            if (M.widen && (!isRetry || M.rewrite === 'same')) data.changes.forEach(c => { c.msgs = [c.msgs[0] - 1, c.msgs[0]]; });
            if (isRetry && M.rewrite) data.changes.forEach(c => { c.text = 'A promise is given, in other words.'; if (M.rewrite === 'away') c.msgs = [c.msgs[0] + 1]; });
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
    let why4 = await ev(() => { __savePoint.render(true); return { rep: __savePoint.reportText(__savePoint.state()), btn: !!document.querySelector('#sp_overlay [data-act="copy-report"]') }; });
    ok(why4.btn && /\[날 바뀜 재요청 답을 못 씀\] #\d+–#\d+ · unusable/.test(why4.rep) && why4.rep.includes('99999'), '4. (a14) 못 쓴 이유(검사 오류)가 결과 복사에 나오고 버튼도 보임');

    // 5. The second request itself fails: the first reply is saved.
    c0 = r.calls;
    await ev(() => { M.retryBad = false; M.retryThrows = true; }); await add('1024-04-18', '1024-04-20'); await run(); r = await snap();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 98 && !r.st.autoFail && r.st.autoLast?.status !== 'failed' && r.fix.includes('쓸 수 없어'), '5. 다시 묻는 요청이 실패해도 첫 응답을 저장');
    why4 = await ev(() => __savePoint.reportText(__savePoint.state()));
    ok(/\[날 바뀜 재요청 답을 못 씀\][^\n]*\n- request failed: [^\n]*Load failed/.test(why4), '5. (a14) 못 쓴 이유(요청 오류)가 결과 복사에 나옴');

    // 6. A reply with another problem is asked again for it, and (a10) told of the new day in the same request; requests stay at two.
    // The second reply fixes the problem but still keeps one scene: saved as received (the first reply was not usable), said so.
    c0 = r.calls;
    await ev(() => { M.retryThrows = false; M.throwNext = null; M.badOnce = true; }); await add('1024-04-20', '1024-04-22'); await run(); r = await snap();
    const last = await ev(() => M.calls.at(-1).split('YOUR PREVIOUS REPLY WAS REJECTED')[1] || '');
    ok(r.calls === c0 + 2 && r.st.lastIndex === 118 && /scenes\[0\] \(#99-#118\) runs into a new story day/.test(last) && last.includes('is not one of the new messages'), '6. (a10) 다른 검사 실패로 다시 물을 때 날이 바뀐 곳도 같이 알림(요청은 두 번까지)');
    ok(r.fix.includes('날이 바뀐 곳 1곳에서 장면을 나누지 못했어요') && !r.st.autoFail, '6. (a10) 그래도 안 나누면 저장하고 자동 보정 줄에 나누지 못했다고 남김');
    const s6 = await ev(() => { const a = M.calls.at(-2), b = M.calls.at(-1); const note = (b.match(/\n- scenes\[\d+\] \(#[^\n]*runs into a new story day[^\n]*/) || [''])[0];
        return { d: b.length - a.length, note: note.length }; });

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

    // 18. (a10, real use: a night into the next morning stayed one scene with no notice) Another problem and a new day in the first
    // reply: one more request for both, the second reply fixes the problem and splits → saved split, said so.
    c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.retryFlashback = false; M.badOnce = true; M.retrySplits = true; __savePoint.ui.lastFix = null; }); await add('1024-05-14', '1024-05-16'); await run(); r = await snap();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 358 && r.scenes.length === sc1 + 1 && !r.st.autoFail && r.fix.includes('장면도 나눴어요'), '18. (a10) 다른 검사 실패 + 날 바뀜: 한 번 더 물어 오류도 고치고 장면도 나눈 답을 저장');
    await ev(() => { M.badOnce = false; M.retrySplits = false; __savePoint.ui.lastFix = null; }); await add('1024-05-16', '1024-05-16'); await run(); r = await snap();
    ok(r.st.lastIndex === 378 && !r.fix, '18. (a10) 오류도 날 바뀜도 없으면 자동 보정 줄 없음');

    // 19. (a11, real use: all 18 changes counted as lost) Split as asked, each change written anew over fewer messages (one shared):
    // the same changes → the second reply is saved; the copy report has no comparison lines.
    let q19 = await recs(); c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.retrySplits = true; M.widen = true; M.rewrite = 'same'; __savePoint.ui.lastFix = null; }); await add('1024-05-16', '1024-05-18'); await run(); r = await snap(); q = await recs();
    let rep = await ev(() => __savePoint.reportText(__savePoint.state()));
    ok(r.calls === c0 + 2 && r.st.lastIndex === 398 && r.scenes.length === sc1 + 1 && q.n === q19.n + 1 && !r.fix && !rep.includes('날 바뀜 비교'), '19. (a13) 나눈 재응답이 새 약속을 말만 바꿔 같은 근거로 쓰면 같은 변경으로 보고 저장');
    // (a13, GPT review of a11, P2-2) A NEW promise written anew over fewer messages (one shared) is not taken for the same one any more.
    c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.rewrite = 'fewer'; __savePoint.ui.lastFix = null; }); await add('1024-05-18', '1024-05-20'); await run(); r = await snap();
    ok(r.calls === c0 + 2 && r.scenes.length === sc1 && r.fix.includes('상태 변경 1개'), '19. (a13) 새 약속은 근거 하나 겹침만으로는 같은 변경이 아님 → 첫 응답 저장');
    // The change moved to another message: lost, the first reply is saved, and the copy report says what was not matched.
    c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.rewrite = 'away'; __savePoint.ui.lastFix = null; }); await add('1024-05-20', '1024-05-22'); await run(); r = await snap();
    rep = await ev(() => __savePoint.reportText(__savePoint.state()));
    ok(r.calls === c0 + 2 && r.st.lastIndex === 438 && r.scenes.length === sc1 && r.fix.includes('상태 변경 1개'), '19. (a11) 다른 메시지로 옮긴 변경은 여전히 빠짐 → 첫 응답 저장');
    ok(/\[날 바뀜 비교에서 빠진 것\] #\d+–#\d+ · changes 1/.test(rep) && rep.includes('first reply change not kept:') && rep.includes('Promise made at') && rep.includes('second reply change unmatched:') && rep.includes('in other words'), '19. (a11) 결과 복사에 안 맞은 변경 두 쪽이 나옴');
    const copyBtn = await ev(() => { __savePoint.render(true); return !!document.querySelector('#sp_overlay [data-act="copy-report"]'); });
    ok(copyBtn, '19. (a12) 비교에서 빠진 것이 있으면 결과 복사 버튼이 보임');

    // 20. (a13, GPT review of a10, P2-1) The new-day note never stops a retry that fits without it: with an input limit between the
    // two, the retry goes out with the errors only and the reply is saved, said so.
    const limit0 = await ev(() => M.settings.savePoint.inputChars);
    c0 = r.calls;
    await ev(lim => { M.rewrite = false; M.widen = false; M.retrySplits = false; M.badOnce = true; M.limitAt = lim; __savePoint.ui.lastFix = null; }, s6.d - s6.note + Math.floor(s6.note / 2));
    await add('1024-05-22', '1024-05-24'); await run(); r = await snap();
    const last20 = await ev(() => M.calls.at(-1).split('YOUR PREVIOUS REPLY WAS REJECTED')[1] || '');
    ok(s6.note > 100 && r.calls === c0 + 2 && r.st.lastIndex === 458 && !r.st.autoFail && last20.includes('is not one of the new messages') && !last20.includes('runs into a new story day') && r.fix.includes('나누지 못했어요'), '20. (a13) 날짜 안내를 붙이면 한도를 넘을 때는 빼고 오류 재요청만 보내 저장');
    await ev(l => { M.limitAt = 0; M.settings.savePoint.inputChars = l; }, limit0);
    // 21. (a13, GPT review of a10, P3) The second reply fixes the error but only drops the new day (one scene): not "split as well".
    c0 = r.calls; sc1 = r.scenes.length;
    await ev(() => { M.badOnce = true; M.retryNoTimes = true; __savePoint.ui.lastFix = null; }); await add('1024-05-24', '1024-05-26'); await run(); r = await snap();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 478 && r.scenes.length === sc1 && r.fix.includes('답이 장면을 나누지 않았어요') && !r.fix.includes('장면도 나눴어요'), '21. (a13) 날짜만 빼고 한 장면으로 둔 답은 "나눴어요"가 아니라 "나누지 않았어요"');
    await ev(() => { M.badOnce = false; M.retryNoTimes = false; });
    // 22. (a13, GPT review of a11, P3) The manual copy box is emptied with the rest when the room changes.
    const box = await ev(async () => { __savePoint.ui.copyText = 'old report'; await M.switchChat('dbOther', [], {}); await M.opened(); return __savePoint.ui.copyText; });
    ok(box === null, '22. (a13) 방을 바꾸면 수동 복사 칸도 비움');
    await browser.close(); srv.close(); console.log(failures ? failures + ' FAILED' : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
