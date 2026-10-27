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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.goto(`http://localhost:${srv.address().port}/`);
    await page.waitForFunction(() => !!globalThis.__savePoint);
    const ev = (fn, arg) => page.evaluate(fn, arg);

    // The mock model dates every part and, for "PROMISE" messages, reads "내일" as a one-day deadline.
    await ev(() => {
        M.settings.savePoint.check = false; M.settings.savePoint.auto = false;
        M.step = 'start';
        const getContext = SillyTavern.getContext;
        SillyTavern.getContext = () => {
            const c = getContext();
            return { ...c, generateRaw: async args => {
                const raw = await c.generateRaw(args);
                const data = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
                if (data.scenes) for (const sc of data.scenes) {
                    const n = sc.points[0].msgs.find(Number.isInteger);
                    sc.time = M.step === 'start' ? { mode: 'present', start: { relation: 'explicit', date: '2026-10-24', msg: n, quote: '2026-10-24' }, end: { relation: 'same' } }
                        : M.step === 'next' ? { mode: 'present', start: { relation: 'advance', days: 1, msg: n, quote: '다음 날' }, end: { relation: 'same' } }
                        : M.step === 'jump' ? { mode: 'present', start: { relation: 'jump', elapsed: '몇 주 뒤', msg: n, quote: '몇 주 뒤' }, end: { relation: 'same' } }
                        : { mode: 'present', start: { relation: 'same' }, end: { relation: 'same' } };
                }
                for (const ch of data.changes || []) if (ch.kind === 'promise' && M.chat[ch.terms.msg].mes.includes('내일')) ch.due = { expr: '내일', days: 1, msg: ch.terms.msg };
                return JSON.stringify(data);
            } };
        };
        M.add(2, i => i === 0 ? 'It was 2026-10-24 at the gate.' : '');
    });
    await ev(() => __savePoint.handle('run'));
    await ev(() => { M.step = 'same'; M.add(2, i => i === 3 ? 'PROMISE: 내일 성문에서 다시 만나자.' : ''); });
    await ev(() => __savePoint.handle('run'));
    await ev(() => { $('#sp_wand').trigger('click'); __savePoint.handle('tab', 'quests'); });
    let r = await ev(() => ({ due: $('.sp-due').text(), cls: $('.sp-due').attr('class') || '', inj: M.prompts.savepoint.v }));
    ok(r.due.includes('“내일”') && r.due.includes('2026-10-25') && r.due.includes('1일 남음 (마지막 기록 기준)'), `1. 약속 기한과 남은 날 표시 (${r.due})`);
    ok(r.inj.includes('1 day left as of the last record'), '1. 주입에도 마지막 기록 기준의 기한');

    for (const step of ['next', 'next']) { await ev(s => { M.step = s; M.add(2, () => '다음 날 아침이 밝았다.'); }, step); await ev(() => __savePoint.handle('run')); }
    await ev(() => __savePoint.handle('tab', 'quests'));
    r = await ev(() => ({ due: $('.sp-due').text(), cls: $('.sp-due').attr('class') || '', status: __savePoint.state().mem.records.find(x => x.type === 'quest').status, inj: M.prompts.savepoint.v }));
    ok(r.due.includes('기한 지남') && r.due.includes('약속을 어겼다는 뜻은 아니에요') && r.cls.includes('sp-due-past'), `2. 이틀 뒤 기한 지남 표시 (${r.due})`);
    ok(r.status === 'open' && r.inj.includes('not necessarily broken'), '2. 기한이 지나도 약속은 진행 중 그대로');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'deadline-past.png') });

    // 3. the user sets the deadline day by hand; a later AI reading does not replace it
    const qid = await ev(() => __savePoint.state().mem.records.find(x => x.type === 'quest').id);
    await ev(id => __savePoint.handle('edit-rec', id), qid);
    r = await ev(() => $('.sp-edit').text());
    ok(r.includes('기한 직접 지정') && r.includes('YYYY-MM-DD') && r.includes('2026-10-26'), '3. 편집 창에 기한 칸과 지금 시간 안내');
    await page.fill('.sp-edit [data-edit=dueDay]', '2026-10-29');
    await ev(() => __savePoint.handle('edit-save'));
    r = await ev(() => ({ due: $('.sp-due').text(), d: __savePoint.state().mem.records.find(x => x.type === 'quest').due }));
    ok(r.d.manual && r.d.manual.day === 5 && r.due.includes('2026-10-29') && r.due.includes('3일 남음') && r.due.includes('직접 지정'), `3. 직접 지정한 기한 (${r.due})`);
    await ev(id => __savePoint.handle('edit-rec', id), qid);
    await page.fill('.sp-edit [data-edit=dueDay]', '0');
    await ev(() => __savePoint.handle('edit-save').catch(e => { window.__dueErr = e.message; }));
    r = await ev(() => ({ err: window.__dueErr || '', open: !!document.querySelector('.sp-edit'), day: __savePoint.state().mem.records.find(x => x.type === 'quest').due.manual.day }));
    ok(r.err.includes('1 이상의 일 수나') && r.day === 5, `3. 잘못된 기한 일 수는 저장하지 않음 (${r.err})`);
    await ev(() => __savePoint.handle('edit-cancel'));
    await ev(() => __savePoint.handle('undo'));
    r = await ev(() => __savePoint.state().mem.records.find(x => x.type === 'quest').due);
    ok(!r.manual && r.days === 1, '3. 리와인드하면 직접 지정 전으로');

    // 4. after a vague time jump the deadline cannot be compared
    await ev(() => { M.step = 'jump'; M.add(2, () => '몇 주 뒤, 다시 성문 앞.'); });
    await ev(() => __savePoint.handle('run'));
    await ev(() => __savePoint.handle('tab', 'quests'));
    r = await ev(() => ({ due: $('.sp-due').text(), inj: M.prompts.savepoint.v }));
    ok(r.due.includes('확인 필요') && !r.due.includes('지남') && r.inj.includes('cannot be compared'), `4. 모호한 점프 뒤에는 확인 필요 (${r.due})`);

    // 5. completing the promise removes the countdown
    await ev(id => __savePoint.handle('quest-done', id), qid);
    r = await ev(() => $('.sp-due').text());
    ok(r.includes('“내일”') && !/남음|지남|확인 필요/.test(r), `5. 완료한 약속은 기한 표현만 (${r})`);

    await browser.close(); srv.close();
    console.log(failures ? `${failures} FAILED` : 'ALL PASS');
    process.exit(failures ? 1 : 0);
})();
