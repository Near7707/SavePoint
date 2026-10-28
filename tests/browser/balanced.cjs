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
    const srv = await serve(), browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.goto(`http://localhost:${srv.address().port}/`);
    await page.waitForFunction(() => !!globalThis.__savePoint);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const snapshot = () => ev(() => {
        const st = __savePoint.state();
        return { last: st.lastIndex, scenes: st.mem.scenes.length, open: st.mem.scenes.at(-1)?.status,
            ranges: st.mem.scenes.flatMap(s => s.segs.map(g => [g.from, g.to])),
            hidden: M.chat.map(m => !!m.is_system), calls: M.calls.length };
    });
    await ev(() => { M.settings.savePoint.check = false; M.settings.savePoint.auto = false;
        M.settings.savePoint.keepRecent = 0; M.add(30, i => `Short message ${i}.`); });
    await ev(() => __savePoint.summarize());
    let r = await snapshot();
    ok(JSON.stringify(r.ranges) === JSON.stringify([[0,14],[15,29]]) && r.calls === 2, 'manual 30 messages -> 15 + 15');
    ok(r.last === 29 && r.scenes === 1 && r.open === 'open', 'balanced requests preserve one open scene and complete coverage');
    await ev(() => __savePoint.undo()); r = await snapshot();
    ok(r.last === -1 && r.hidden.every(x => !x), 'rewind removes the complete save and restores visibility');

    await ev(() => { M.failAt = 20; });
    await ev(() => __savePoint.summarize()); r = await snapshot();
    ok(r.last === 14 && r.hidden.slice(0,15).every(Boolean) && r.hidden.slice(15).every(x => !x), 'later failure commits only the balanced first prefix');
    await ev(() => { delete M.failAt; });
    await ev(() => __savePoint.summarize()); r = await snapshot();
    ok(r.last === 29 && JSON.stringify(r.ranges) === JSON.stringify([[0,14],[15,29]]), 'retry resumes at the next unsaved original message without duplicates');

    await ev(async () => { await M.switchChat('balanced-auto', [], {}); M.add(32, i => `Short message ${i}.`);
        M.chat.at(-1).is_user = false; M.chat.at(-1).name = 'Ari';
        M.settings.savePoint.auto = true; M.settings.savePoint.autoEvery = 30; M.settings.savePoint.autoReserve = 2; });
    await ev(() => __savePoint.autoCollect()); r = await snapshot();
    ok(r.last === 29 && JSON.stringify(r.ranges) === JSON.stringify([[0,14],[15,29]]), 'checkpoint balances only the prefix before its reserve');
    ok(r.hidden.slice(30).every(x => !x), 'the two retained messages stay visible');
    await ev(() => __savePoint.summarize()); r = await snapshot();
    ok(r.last === 31 && r.ranges.at(-1)[0] === 30, 'manual quicksave still includes the retained tail');

    await ev(async () => { await M.switchChat('balanced-25', [], {}); M.settings.savePoint.auto = false; M.add(25, i => `Short message ${i}.`); });
    await ev(() => __savePoint.summarize()); r = await snapshot();
    ok(JSON.stringify(r.ranges) === JSON.stringify([[0,12],[13,24]]), 'manual 25 messages -> 13 + 12');

    await ev(() => {
        const mem = __savePoint.state().mem;
        mem.entities.push({ id: 'e40', type: 'person', name: 'Theo', aliases: ['테오'] });
        mem.records.push({ id: 'r40', type: 'party', entity: 'e40', aspect: 'condition', text: 'Theo: tired', ko: '테오: 피곤함', src: [], msgs: [] });
        __savePoint.handle('tab', 'inject');
    });
    const names = await ev(() => ({ rec: __savePoint.state().mem.records.find(x => x.id === 'r40'), injection: M.prompts.savepoint?.v || '' }));
    ok(names.rec.text === 'tired' && names.rec.ko === '피곤함', 'opening legacy metadata cleans both record languages');
    ok(names.injection.includes('[condition] Theo: tired') && !names.injection.includes('Theo: Theo:'), 'injected state contains a single owner label');
    await browser.close(); srv.close(); console.log(failures ? failures + ' FAILED' : 'ALL PASS'); process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
