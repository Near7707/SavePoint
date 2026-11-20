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

// v0.7.1 (main 4324bb6, brought into the branch at 0.7.1-a7): the settings box goes in the left column (#extensions_settings) like
// other extensions, its place (#sp_settings_slot) taken as soon as index.js loads, so an extension loaded later sits below it;
// with no left column it falls back to the right one. 1 left column, before a later extension · 2 one slot, one box · 3 fallback.
(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const base = `http://localhost:${srv.address().port}/`;
    const page0 = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');
    // A later extension (a module after index.js) adds its own box to the left column right away.
    const later = '<script type="module">document.getElementById("extensions_settings").insertAdjacentHTML("beforeend", "<div id=\\"otherExt\\"></div>");</script>';
    const open = async html => {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
        await page.route(base, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
        await page.goto(base);
        await page.waitForFunction(() => !!globalThis.__savePoint && !!document.getElementById('sp_settings'));
        return page;
    };
    const look = page => page.evaluate(() => {
        const box = document.getElementById('sp_settings'), slot = document.getElementById('sp_settings_slot'), other = document.getElementById('otherExt');
        return { col: box.closest('#extensions_settings, #extensions_settings2')?.id ?? null, inSlot: !!slot && slot.contains(box), slots: document.querySelectorAll('#sp_settings_slot').length,
            boxes: document.querySelectorAll('#sp_settings').length, beforeOther: !!other && !!slot && !!(slot.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) };
    });

    // 1-2. both columns (as in SillyTavern), another extension loaded after: left column, in the slot, above that extension
    let p = await open(page0.replace('</body>', `${later}</body>`));
    let r = await look(p);
    ok(r.col === 'extensions_settings' && r.inSlot && r.beforeOther, `1. 왼쪽 칸, 자리 안, 나중에 불린 확장보다 위 (${JSON.stringify(r)})`);
    await p.evaluate(() => __savePoint.fillSettings && __savePoint.fillSettings());
    r = await look(p);
    ok(r.slots === 1 && r.boxes === 1, `2. 자리 하나, 설정 칸 하나 (${JSON.stringify(r)})`);
    await p.close();

    // 3. no left column: the right one, as before
    p = await open(page0.replace('<div id="extensions_settings"></div>', ''));
    r = await look(p);
    ok(r.col === 'extensions_settings2' && r.boxes === 1, `3. 왼쪽 칸이 없으면 오른쪽 칸 (${JSON.stringify(r)})`);
    await p.close();

    await browser.close(); srv.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
