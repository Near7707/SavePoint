const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const EXT = process.env.EXT || path.resolve(__dirname, '../..');
const TABS = ['journal', 'timeline', 'queue', 'quests', 'party', 'items', 'world', 'saves', 'inject'];
const THEMES = ['jrpg', 'neon', 'glass', 'archive', 'pastel', 'terminal', 'eggpet', 'dualwhite', 'ink', 'cream', 'consolenight', 'cranelemon', 'gingerbread', 'xmasknit', 'st'];
let failures = 0;
const ok = (condition, message) => { console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`); if (!condition) failures++; };

(async () => {
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0]);
        const file = url.startsWith('/ext/') ? path.join(EXT, url.slice(5)) : url === '/jquery.js' ? '/usr/share/javascript/jquery/jquery.min.js' : path.join(__dirname, url === '/' ? 'page.html' : url);
        fs.readFile(file, (error, data) => {
            if (error) { res.writeHead(404); return res.end(); }
            res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
            res.end(data);
        });
    });
    await new Promise(resolve => server.listen(0, resolve));
    let browser;
    try {
        browser = await chromium.launch();
        for (const width of [390, 1100]) {
            const page = await browser.newPage({ viewport: { width, height: 844 } });
            page.on('pageerror', error => { console.log('PAGE ERROR', error.message); failures++; });
            await page.goto(`http://localhost:${server.address().port}/`);
            await page.waitForFunction(() => !!globalThis.__savePoint);
            await page.evaluate(async () => {
                M.settings.savePoint.auto = false; M.settings.savePoint.check = false;
                M.add(90, i => (i % 5 === 0 ? 'SCENEBREAK ' : '') + 'A traveler reached the station and checked the map.');
                await __savePoint.handle('run'); $('#sp_wand').trigger('click');
            });
            const ev = fn => page.evaluate(fn);
            const initial = await ev(async () => {
                const body = () => document.querySelector('.sp-body');
                body().scrollTop = 900;
                await __savePoint.handle('tab', 'queue'); const firstQueue = body().scrollTop;
                await __savePoint.handle('tab', 'journal'); const journal = body().scrollTop;
                await __savePoint.handle('tab', 'timeline'); const firstTimeline = body().scrollTop;
                body().scrollTop = 300;
                await __savePoint.handle('tab', 'journal'); const journalAgain = body().scrollTop;
                await __savePoint.handle('tab', 'timeline');
                return { firstQueue, journal, firstTimeline, journalAgain, timeline: body().scrollTop };
            });
            ok(initial.firstQueue === 0 && initial.journal === 900, `${width}px: empty queue does not reset journal position`);
            ok(initial.firstTimeline === 0 && initial.journalAgain === 900 && initial.timeline === 300, `${width}px: first visit starts at top; long tabs remember independent positions`);
            await ev(() => {
                const st = __savePoint.state(), person = st.mem.entities.find(e => e.type === 'person').id;
                for (const type of ['party', 'item', 'world', 'quest']) for (let i = 0; i < 24; i++) st.mem.records.push({
                    id: `scroll-${type}-${i}`, type, entity: type === 'party' ? person : null, holder: null,
                    aspect: 'condition', kind: type === 'quest' ? 'goal' : 'rule', status: 'open', who: [person], knownBy: [],
                    text: `Record ${i}: The traveler checked a different route and kept the supplies ready for the journey.`, msgs: [0], src: [], pin: false,
                });
                __savePoint.render(true);
            });
            for (const theme of THEMES) {
                const result = await page.evaluate(async ({ theme, tabs }) => {
                    __savePoint.settings().theme = theme; __savePoint.render(true);
                    const body = () => document.querySelector('.sp-body');
                    const expected = {}, errors = [];
                    for (const [i, tab] of tabs.entries()) {
                        await __savePoint.handle('tab', tab);
                        body().scrollTop = 170 + i * 37; expected[tab] = body().scrollTop;
                    }
                    for (let round = 0; round < 3; round++) for (const tab of [...tabs].reverse()) {
                        await __savePoint.handle('tab', tab);
                        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                        if (Math.abs(body().scrollTop - expected[tab]) > 1) errors.push({ tab, expected: expected[tab], actual: body().scrollTop });
                    }
                    const before = body().scrollTop; __savePoint.render(true);
                    if (Math.abs(body().scrollTop - before) > 1) errors.push({ rerender: true });
                    return errors;
                }, { theme, tabs: TABS });
                ok(!result.length, `${width}px ${theme}: all nine tabs survive repeated switches and redraws${result.length ? ' ' + JSON.stringify(result) : ''}`);
            }
            const focused = await ev(async () => {
                __savePoint.settings().theme = 'jrpg';
                await __savePoint.handle('tab', 'journal'); document.querySelector('.sp-body').scrollTop = 120;
                await __savePoint.handle('tab', 'timeline'); document.querySelector('.sp-body').scrollTop = 300;
                const scene = __savePoint.state().mem.scenes[8], seg = scene.segs[0];
                await __savePoint.handle('tl-goto', `${scene.id}|${seg.id}`);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const el = document.getElementById('sp-seg-' + seg.id), body = document.querySelector('.sp-body');
                const a = el.getBoundingClientRect(), b = body.getBoundingClientRect();
                const top = body.scrollTop, visible = a.bottom > b.top && a.top < b.bottom, highlighted = el.classList.contains('sp-focus');
                await __savePoint.handle('tab', 'timeline'); const timeline = document.querySelector('.sp-body').scrollTop;
                await __savePoint.handle('tab', 'journal');
                return { visible, highlighted, top, timeline, returned: document.querySelector('.sp-body').scrollTop };
            });
            ok(focused.visible && focused.highlighted && focused.top !== 120, `${width}px: timeline jump overrides the remembered journal position`);
            ok(focused.timeline === 300 && focused.returned === focused.top, `${width}px: timeline and the jumped-to journal position are both retained`);
            const reopened = await ev(async () => {
                document.querySelector('.sp-body').scrollTop = 600;
                await __savePoint.handle('close'); $('#sp_wand').trigger('click');
                return document.querySelector('.sp-body').scrollTop;
            });
            ok(reopened === 600, `${width}px: closing and reopening keeps the reading position`);
            const rooms = await ev(async () => {
                window.scrollRoomA = { chat: M.chat, meta: M.meta };
                await M.switchChat('chatB', [], {}); const fresh = document.querySelector('.sp-body').scrollTop;
                M.add(45, i => (i % 5 === 0 ? 'SCENEBREAK ' : '') + 'A traveler stopped near another station.');
                await __savePoint.handle('run'); document.querySelector('.sp-body').scrollTop = 250;
                const roomB = { chat: M.chat, meta: M.meta }, bBefore = document.querySelector('.sp-body').scrollTop;
                await M.switchChat('chatA', window.scrollRoomA.chat, window.scrollRoomA.meta); const aReturned = document.querySelector('.sp-body').scrollTop;
                await M.switchChat('chatB', roomB.chat, roomB.meta);
                return { fresh, aReturned, bBefore, bReturned: document.querySelector('.sp-body').scrollTop, calls: M.calls.length };
            });
            ok(rooms.fresh === 0 && rooms.aReturned === 600 && rooms.bBefore === 250 && rooms.bReturned === 250, `${width}px: each chat room keeps its own tab position`);
            await page.close();
        }
    } finally { await browser?.close(); server.close(); }
    console.log(failures ? `${failures} FAILED` : 'ALL PASS'); process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
