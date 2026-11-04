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
    await ev(() => { M.settings.savePoint.check = false; M.settings.savePoint.hudOpen = true; $('#sp_wand').trigger('click'); });
    const lastPopup = () => ev(() => (M.popups || []).at(-1) || '');
    const toasts = () => ev(() => toastr.log.map(x => x[1]).join(' | '));

    // 1. nothing to rewind: it says so instead of doing nothing
    await ev(() => { toastr.log.length = 0; return __savePoint.handle('undo'); });
    ok((await toasts()).includes('되돌릴 작업이 없어요'), '1. 되돌릴 게 없으면 알림');

    // 2. a save is the rewind point; the question names it
    await ev(() => M.add(6));
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    let r = await ev(() => ({ info: __savePoint.state().undoInfo, title: document.querySelector('#sp_overlay [data-act="undo"]').title, close: !!document.querySelector('#sp_overlay .sp-actions [data-act="run-close"]') }));
    ok(r.info?.kind === 'quicksave' && r.title.includes('퀵세이브 #0–#5') && !r.close, `2. 퀵세이브가 리와인드 지점, 버튼 줄에 장면 클리어 없음 (${JSON.stringify(r)})`);

    // 3. an edit after it does not take the rewind step; the question says it goes back too
    await ev(() => __savePoint.handle('tab', 'journal'));
    await ev(() => __savePoint.handle('star', __savePoint.state().mem.scenes[0].id));
    r = await ev(() => __savePoint.state().undoInfo);
    ok(r.kind === 'quicksave' && r.edits === 1, `3. ★ 편집은 리와인드 지점을 바꾸지 않고 편집 수만 셈 (${JSON.stringify(r)})`);
    await ev(() => { M.confirm = 0; return __savePoint.handle('undo'); });
    r = { q: await lastPopup(), last: await ev(() => __savePoint.state().lastIndex) };
    ok(r.q.includes('퀵세이브 #0–#5 전으로') && r.q.includes('그 뒤에 한 편집 1개') && r.last === 5, `3. 확인창이 무엇을 되돌리는지 알림, 취소하면 그대로 (${r.q})`);
    await ev(() => { M.confirm = 1; return __savePoint.handle('undo'); });
    r = await ev(() => ({ last: __savePoint.state().lastIndex, undo: __savePoint.state().undo, star: __savePoint.state().mem.scenes.length }));
    ok(r.last === -1 && !r.undo && r.star === 0, `3. 확인하면 저장 전으로 (${JSON.stringify(r)})`);

    // 4. 기록하고 장면 닫기 lives on the open scene in 📜 저널
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    await ev(() => { M.add(2); __savePoint.handle('tab', 'journal'); });
    r = await ev(() => { const b = document.querySelector('#sp_overlay .sp-scene.sp-open [data-act="run-close"]'); return b?.textContent || ''; });
    ok(r.includes('기록하고 장면 닫기'), `4. 저널의 진행 중 장면에 '기록하고 장면 닫기' (${r})`);
    await ev(() => document.querySelector('#sp_overlay .sp-scene.sp-open [data-act="run-close"]').click());
    await page.waitForTimeout(900);
    r = await ev(() => ({ open: __savePoint.state().mem.scenes.some(s => s.status === 'open'), last: __savePoint.state().lastIndex, kind: __savePoint.state().undoInfo?.kind }));
    ok(!r.open && r.last === 7 && r.kind === 'sceneclear', `4. 누르면 끝까지 저장하고 장면을 닫음, 리와인드 지점 (${JSON.stringify(r)})`);

    // 5. a reset is a rewind point named as such
    await ev(() => __savePoint.handle('clear-room'));
    await ev(() => { M.confirm = 0; return __savePoint.handle('undo'); });
    ok((await lastPopup()).includes('리셋 전으로'), '5. 리셋도 리와인드로 되돌릴 수 있고 확인창이 알려 줌');
    await ev(() => { M.confirm = 1; return __savePoint.handle('undo'); });
    ok(await ev(() => __savePoint.state().lastIndex === 7), '5. 리셋 되돌리기');

    // 6. deleting a record asks first (it cannot be rewound)
    await ev(() => { M.popups.length = 0; M.confirm = 0; });
    const rec = await ev(() => { const st = __savePoint.state(); st.mem.records.push({ id: 'rx1', type: 'world', kind: 'rule', text: 'Doors close at dusk.', src: [], msgs: [] }); return 'rx1'; });
    await ev(id => __savePoint.handle('del-rec', id), rec);
    r = { q: await lastPopup(), still: await ev(() => !!__savePoint.state().mem.records.find(x => x.id === 'rx1')) };
    ok(r.q.includes('지울까요') && r.still, `6. 🗑는 확인 후 지움 (${r.q})`);
    await ev(() => { M.confirm = 1; });

    // 7. wording: 미저장 / 마지막 저장 / 저장 N / M
    await ev(() => { M.add(1); __savePoint.render(true); });
    r = await ev(() => document.querySelector('#sp_overlay .sp-hud').textContent);
    ok(r.includes('미저장') && !r.includes('미기록') && r.includes('마지막 저장') && /저장 \d+ \/ \d+/.test(r), '7. 상태칸 용어: 미저장·마지막 저장·저장 N / M');

    // 8. (v0.6.56) a delete question open while the room changes: the other room (same ids) is left alone
    const ask = () => ev(() => { M.confirm = new Promise(res => { window.__answer = res; }); });
    await ev(() => { const st = __savePoint.state(); st.mem.records.push({ id: 'rx2', type: 'world', kind: 'rule', text: 'Lamps stay lit.', src: [], msgs: [] }); });
    const roomA = await ev(() => ({ chat: M.chat, meta: M.meta, id: M.chatId }));
    const copyB = await ev(() => structuredClone({ chat: M.chat, meta: M.meta }));
    for (const what of ['rec', 'point']) {
        await ask();
        const pid = await ev(() => { const s = __savePoint.state().mem.scenes[0], g = s.segs[0]; return `${s.id}|${g.id}|0`; });
        const asking = what === 'rec' ? ev(() => __savePoint.handle('del-rec', 'rx2')) : ev(id => __savePoint.handle('del-point', id), pid);
        await page.waitForTimeout(150);
        await ev(b => M.switchChat('room-B-' + Math.random(), b.chat, b.meta), copyB);
        await page.waitForTimeout(150);
        await ev(() => window.__answer(1)); await asking; await page.waitForTimeout(200);
        r = await ev(pid => ({ rec: !!__savePoint.state().mem.records.find(x => x.id === 'rx2'), point: (() => { const [sid, gid] = pid.split('|'); return __savePoint.state().mem.scenes.find(x => x.id === sid).segs.find(x => x.id === gid).points.length; })(), toast: toastr.log.at(-1)?.[1] || '' }), pid);
        const pointsBefore = copyB.meta.savePoint.mem.scenes[0].segs[0].points.length;
        ok(r.rec && r.point === pointsBefore && r.toast.includes('다시 눌러'), `8. ${what === 'rec' ? '항목' : '포인트'} 삭제 확인 중 방이 바뀌면 새 방의 같은 ID를 지우지 않음 (${JSON.stringify(r)})`);
        await ev(a => M.switchChat(a.id, a.chat, a.meta), roomA);
        await page.waitForTimeout(150);
    }
    await ev(() => { M.confirm = 1; });

    // 9. (v0.6.56) a checkpoint lands while the rewind question is open: nothing goes back
    await ev(() => { M.add(2); return __savePoint.handle('run'); });
    await page.waitForTimeout(900);
    const before9 = await ev(() => __savePoint.state().lastIndex);
    await ask();
    const asking9 = ev(() => __savePoint.handle('undo'));
    await page.waitForTimeout(150);
    await ev(() => { M.settings.savePoint.autoEvery = 5; M.settings.savePoint.autoReserve = 0; M.add(6); return __savePoint.autoCollect(); });
    await page.waitForTimeout(900);
    const after9 = await ev(() => __savePoint.state().lastIndex);
    await ev(() => window.__answer(1)); await asking9; await page.waitForTimeout(200);
    r = { before: before9, saved: after9, now: await ev(() => __savePoint.state().lastIndex), toast: await ev(() => toastr.log.at(-1)?.[1] || '') };
    ok(r.saved > r.before && r.now === r.saved && r.toast.includes('다시 눌러'), `9. 리와인드 확인 중 새 저장이 끝나면 되돌리지 않고 다시 누르게 함 (${JSON.stringify(r)})`);
    await ev(() => { M.confirm = 1; });

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
