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
            if (!isRetry && M.retryThrows) M.throwNext = new Error('Load failed');
        };
        window.addDays = (n, a, b) => M.add(n, i => `[Date: ${M.chat.length - window.__base < 10 ? a : b} | Time: 09:${String(10 + (M.chat.length % 50)).padStart(2, '0')}] The courier waited by the gate ${'and waited '.repeat(8)}.`);
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
    ok(r.calls === c0 + 2 && r.st.lastIndex === 58 && r.scenes.length === 2 && !r.st.autoFail, '3. 다시 물어도 안 나누면 받은 대로 저장(구간을 잃지 않음)');
    ok(r.fix.includes('나뉘지 않아'), '3. 자동 보정 줄에 나뉘지 않았다고 알림');

    // 4. The second reply does not pass the checks: the first reply is saved.
    c0 = r.calls;
    await ev(() => { M.retryBad = true; }); await add('1024-04-16', '1024-04-18'); await run(); r = await snap();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 78 && !r.st.autoFail && r.st.autoLast?.status !== 'failed' && r.fix.includes('그 요청이 실패해'), '4. 다시 물은 답이 검사를 못 넘으면 첫 응답을 저장');

    // 5. The second request itself fails: the first reply is saved.
    c0 = r.calls;
    await ev(() => { M.retryBad = false; M.retryThrows = true; }); await add('1024-04-18', '1024-04-20'); await run(); r = await snap();
    ok(r.calls === c0 + 2 && r.st.lastIndex === 98 && !r.st.autoFail && r.st.autoLast?.status !== 'failed' && r.fix.includes('그 요청이 실패해'), '5. 다시 묻는 요청이 실패해도 첫 응답을 저장');

    // 6. A reply with another problem is asked again for that problem only, and its second reply is not asked a third time.
    c0 = r.calls;
    await ev(() => { M.retryThrows = false; M.throwNext = null; M.badOnce = true; }); await add('1024-04-20', '1024-04-22'); await run(); r = await snap();
    const last = await ev(() => M.calls.at(-1));
    ok(r.calls === c0 + 2 && r.st.lastIndex === 118 && !last.includes('new story day by your own') && r.fix.includes('나뉘지 않아') === false, '6. 다른 검사 실패의 재요청에는 끼지 않고, 요청은 두 번까지만');
    await browser.close(); srv.close(); console.log(failures ? failures + ' FAILED' : 'ALL PASS'); process.exit(failures ? 1 : 0);
})();
