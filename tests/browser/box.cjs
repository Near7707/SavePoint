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
    const files = page => page.evaluate(() => Object.fromEntries(M.files));
    const page = await session();
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(() => { M.settings.savePoint.check = false; M.add(4); $('#sp_wand').trigger('click'); });
    // Two items: a lamp the story keeps and a coat the user will put away.
    await ev(() => { M.addChanges = () => ({ entities: [{ ref: 'lamp', type: 'item', name: 'Brass lamp', aliases: [] }, { ref: 'coat', type: 'item', name: 'Borrowed coat', aliases: [] }],
        changes: [{ op: 'add', type: 'item', entity: 'lamp', holder: null, text: 'A brass lamp on the desk.', msgs: [0] }, { op: 'add', type: 'item', entity: 'coat', holder: null, text: 'A borrowed coat hung on the sofa.', msgs: [0] }] }); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    const inj = () => ev(() => { __savePoint.refreshInjection(); return __savePoint.ui.inj?.text || ''; });
    const coatId = await ev(() => __savePoint.state().mem.records.find(r => r.text.includes('coat')).id);
    ok((await inj()).includes('borrowed coat'), '1. 처음엔 두 물건 모두 주입');

    // 1. 📦: the coat leaves the injection, stays in the record, the tab counts only the inventory
    await ev(() => __savePoint.handle('tab', 'items'));
    await ev(id => __savePoint.handle('item-store', id), coatId);
    await page.waitForTimeout(300);
    let r = await ev(() => ({ box: $('.sp-box > summary').text(), count: $('.sp-tab[data-id="items"] em').text(), boxed: $('.sp-box .sp-stored-item').text(), stored: __savePoint.state().mem.records.find(r => r.text.includes('coat')).stored }));
    ok(r.box.includes('📦 보관함 1') && r.count === '1' && r.boxed.includes('보관') && r.stored?.by === 'user', `1. 📦 보관함으로 이동, 인벤토리 숫자 1 (${r.box.trim()})`);
    ok(!(await inj()).includes('borrowed coat') && (await inj()).includes('brass lamp'), '1. 보관함 물건은 본편 AI에게 전달하지 않음');

    // 2. rewind brings back what was there before, and redo-by-hand works both ways
    await ev(() => __savePoint.handle('undo'));
    ok((await ev(() => !__savePoint.state().mem.records.find(r => r.text.includes('coat')).stored)) && (await inj()).includes('borrowed coat'), '2. 리와인드하면 보관 전으로');
    await ev(id => __savePoint.handle('item-store', id), coatId);

    // 3. the story mentions the coat again: the record is updated, it stays in the box (user's choice)
    const c0 = await ev(() => M.calls.length);
    await ev(id => { M.add(2); M.addChanges = () => ({ changes: [{ op: 'update', id, text: 'The borrowed coat, worn again.', msgs: [4] }] }); }, coatId);
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await ev(() => ({ rec: __savePoint.state().mem.records.find(r => r.text.includes('coat')), prompt: M.calls.filter(c => c.includes('[NEW MESSAGES]')).pop() }));
    ok(r.rec.text === 'The borrowed coat, worn again.' && r.rec.stored?.by === 'user' && r.rec.storedUpdated, '3. 보관 중 언급되면 기록만 갱신, 보관함에 그대로 (보관 중 갱신됨)');
    ok(/STORED ITEMS[\s\S]*Borrowed coat/.test(r.prompt) && !(await inj()).includes('worn again'), '3. 기록 AI에는 보관함 이름·상태 전달, 본편 AI에는 전달 안 함');

    // 4. the story uses up the lamp: it goes to the box as gone; taking it out keeps it gone
    const lampId = await ev(() => __savePoint.state().mem.records.find(r => r.text.includes('lamp')).id);
    await ev(id => { M.add(2); M.addChanges = () => ({ changes: [{ op: 'remove', id, text: 'Shattered on the floor.', msgs: [6] }] }); }, lampId);
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    await ev(() => __savePoint.handle('tab', 'items'));
    r = await ev(id => ({ rec: __savePoint.state().mem.records.find(r => r.id === id), badge: $('.sp-box').text() }), lampId);
    ok(r.rec.gone && r.rec.stored?.by === 'story' && r.rec.text === 'Shattered on the floor.' && r.badge.includes('사라짐'), '4. 이야기에서 사라진 물건은 마지막 상태로 보관함에 (사라짐)');
    await ev(id => __savePoint.handle('item-unstore', id), lampId);
    ok((await inj()).includes('[item, gone] Brass lamp: Shattered on the floor.'), '4. 꺼내도 사라진 상태 그대로 주입 (다시 쓸 수 있는 물건으로 돌아오지 않음)');

    // 5. saves keep the box: an AUTO written now holds the stored coat
    await page.waitForTimeout(1500);
    r = await ev(async () => { const a = __savePoint.listSaves().find(x => x.auto); const rec = await __savePoint.vault.read(a); return rec.mem.records.find(r => r.text.includes('coat'))?.stored?.by; });
    ok(r === 'user', '5. 세이브에도 보관함 상태가 함께 저장');

    // 6. rewinding a later save does not bring a stored item back into the injection
    await ev(() => { M.add(2); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    await ev(() => __savePoint.handle('undo'));
    r = await ev(() => __savePoint.state().mem.records.find(r => r.text.includes('coat'))?.stored?.by);
    ok(r === 'user' && !(await inj()).includes('borrowed coat'), '6. 다음 세이브를 리와인드해도 직접 보관한 물건은 보관함에 그대로');

    // 7. box mode "notify" (the default for a new install): one notice after the save, a status chip, 그대로 두기
    ok((await ev(() => __savePoint.settings().boxMode)) === 'notify', '7. 새로 설치하면 보관함 방식 기본값은 알림');
    await ev(id => { toastr.log.length = 0; M.add(2); M.addChanges = () => ({ changes: [{ op: 'update', id, text: 'Wearing the borrowed coat again.', back: true, msgs: [M.chat.length - 2] }] }); }, coatId);
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await ev(() => ({ toasts: toastr.log.map(x => x[1]).filter(t => t.includes('📦 보관함 물건')), chip: $('.sp-hud [data-act="tab"][data-id="main"]').text(), rec: __savePoint.state().mem.records.find(r => r.text.includes('coat')) }));
    ok(r.toasts.length === 1 && r.chip.includes('📦 복귀 확인 1') && r.rec.stored?.by === 'user' && r.rec.returnNotice, `7. 저장 뒤 알림 한 번 + 상태창 복귀 확인, 보관함에는 그대로 (${r.chip})`);
    await ev(() => { M.add(2); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    ok((await ev(() => toastr.log.filter(x => x[1].includes('📦 보관함 물건')).length)) === 1, '7. 다음 세이브에서 같은 알림을 반복하지 않음');
    await ev(id => __savePoint.handle('item-keep', id), coatId);
    ok(!(await ev(() => __savePoint.state().mem.records.find(r => r.text.includes('coat')).returnNotice)), '7. 그대로 두기 → 복귀 확인 닫힘');

    // 8. 🔒: even in auto mode the item stays and no notice is raised
    await ev(id => __savePoint.handle('item-lock', id), coatId);
    await ev(id => { M.settings.savePoint.boxMode = 'auto'; toastr.log.length = 0; M.add(2); M.addChanges = () => ({ changes: [{ op: 'update', id, text: 'Coat on again.', back: true, msgs: [M.chat.length - 2] }] }); }, coatId);
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await ev(() => ({ rec: __savePoint.state().mem.records.find(r => r.text.includes('Coat on again')), toasts: toastr.log.filter(x => x[1].includes('📦')).length }));
    ok(r.rec.stored?.lock && !r.rec.returnNotice && r.toasts === 0, '8. 🔒 걸면 자동 관리여도 보관함에 두고 알림 없음');

    // 9. party standby buttons; resting people are grouped
    await ev(() => __savePoint.handle('tab', 'party'));
    const ari = await ev(() => __savePoint.state().mem.entities.find(e => e.type === 'person').id);
    await ev(id => __savePoint.handle('person-mode', id + '|standby'), ari);
    r = await ev(() => ({ bench: $('.sp-bench > summary').text(), on: $('.sp-bench .sp-party-mode .sp-on').text(), mode: __savePoint.state().mem.entities.find(e => e.type === 'person').standby }));
    ok(r.mode === 'standby' && r.bench.includes('🪑 대기 1') && r.on === '대기', `9. 대기 멤버로 돌리면 아래 묶음으로 (${r.bench.trim()})`);
    await ev(id => __savePoint.handle('person-mode', id + '|'), ari);
    ok(!(await ev(() => __savePoint.state().mem.entities.find(e => e.type === 'person').standby)), '9. 다시 활성');

    // 10. someone already using SavePoint keeps the old behaviour (manual) after updating
    const old = await session({ settings: { savePoint: { theme: 'cream', budget: 6000 } } });
    ok((await old.evaluate(() => __savePoint.settings().boxMode)) === 'manual', '10. 기존 사용자는 직접 관리 유지');
    await old.close();

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
