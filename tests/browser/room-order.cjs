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
    // v0.6.59: room order (review of v0.6.58): waits tied to the room they started in, one line per room,
    // the file compared with the last confirmed read, and the shapes SillyTavern rewrites.
    const page = await session({ settings: { savePoint: { firstTab: 'journal', check: false, hideMode: 'off', askResume: false } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const msgs = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Me' : 'Ari', is_user: i % 2 === 1, is_system: false, mes: `${tag} message ${i} ${'and more '.repeat(6)}.`, swipe_id: 0, swipes: [`${tag} message ${i} ${'and more '.repeat(6)}.`], extra: {} }));
    const file = (list, meta = {}) => JSON.parse(JSON.stringify([{ chat_metadata: meta }, ...list]));
    const toasts = () => ev(() => toastr.log.map(x => x[1]).join(' | '));
    const open = async (id, list, meta = {}, serverFile = null) => {
        await ev(([id, f, l, m]) => { M.serverFiles[id] = f; return M.switchChat(id, l, m); }, [id, serverFile || file(list, meta), JSON.parse(JSON.stringify(list)), JSON.parse(JSON.stringify(meta))]);
        await page.waitForTimeout(400);
    };
    // A QUICK save to load from.
    await ev(() => { M.add(8); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    const qid = await ev(() => __savePoint.listSaves().find(x => x.quick)?.id);
    ok(!!qid, '준비: QUICK');
    let r;

    // 1. [P1] a load pressed in room A while A is still being checked; room B opens and is ready first.
    await ev(() => { M.readDelayFor = { roomA: 900 }; toastr.log.length = 0; });
    await ev(f => { M.serverFiles.roomA = f; return M.switchChat('roomA', f.slice(1), {}); }, file(msgs(6, 'Ay')));
    await ev(id => { M.confirm = 1; M.p = __savePoint.loadSave(id); }, qid);
    await page.waitForTimeout(100);
    await ev(f => { M.serverFiles.roomB = f; return M.switchChat('roomB', JSON.parse(JSON.stringify(f.slice(1))), {}); }, file(msgs(6, 'Bee')));
    await page.waitForTimeout(1300);
    await ev(() => M.p);
    r = await ev(() => ({ page: !!M.meta.savePoint, file: !!M.serverFiles.roomB[0].chat_metadata.savePoint, a: !!M.serverFiles.roomA[0].chat_metadata.savePoint, t: toastr.log.map(x => x[1]).join(' | ') }));
    ok(!r.page && !r.file && !r.a && r.t.includes('바뀌어서'), `1. A방에서 누른 불러오기가 B방 기억을 바꾸지 않음 (${r.t.slice(0, 40)})`);
    await ev(() => { M.readDelayFor = null; });

    // 2. [P1] a continue in empty room C is cancelled after the room changed to D (SillyTavern keeps
    //    the same message list): D's first message and its "edited" mark stay.
    await open('roomC', [], {}, [{ chat_metadata: {} }]);
    await ev(() => { M.confirm = 1; toastr.log.length = 0; M.onPopup = () => { M.metaDelay = 400; M.failOnce = true; M.onPopup = null; }; });
    await ev(id => { M.p = __savePoint.loadSave(id); }, qid);
    await page.waitForTimeout(150);
    r = await ev(() => M.chat.length);
    ok(r === 1, `2. 준비: 이어하기 메시지가 C방에 들어가 저장을 기다림 (${r})`);
    const dee = msgs(5, 'Dee');
    await ev(f => { M.serverFiles.roomD = [{ chat_metadata: {} }, ...JSON.parse(JSON.stringify(f))]; return M.switchSame('roomD', JSON.parse(JSON.stringify(f)), {}); }, dee);
    await page.waitForTimeout(700);
    await ev(() => M.p);
    r = await ev(() => ({ n: M.chat.length, first: M.chat[0]?.mes, tainted: Object.hasOwn(M.meta, 'tainted') }));
    ok(r.n === 5 && r.first === dee[0].mes && !r.tainted, `2. C방 이어하기 취소가 D방 첫 메시지·표시를 건드리지 않음 (${r.n}, ${String(r.first).slice(0, 12)})`);
    await ev(() => { M.metaDelay = 0; M.failOnce = false; });

    // 3. [P2] the last message deleted on another device does not come back; a message made here still saves.
    const ee = msgs(20, 'Ee');
    await open('roomE', ee);
    await ev(() => { M.serverFiles.roomE.pop(); M.saves0 = M.saves; toastr.log.length = 0; });
    await ev(() => __savePoint.toggleKeep(2).catch(e => { M.goneErr = e.message; }));
    await ev(() => __savePoint.persistSoon());
    await page.waitForTimeout(700);
    r = await ev(() => ({ file: M.serverFiles.roomE.length - 1, saves: M.saves - M.saves0, err: M.goneErr || '', mark: !!M.chat[2].extra?.savepointKeep }));
    ok(r.file === 19 && r.saves === 0 && r.err.includes('지운 메시지') && !r.mark, `3. 다른 곳에서 지운 마지막 메시지가 되살아나지 않음 (${r.file}, ${r.err.slice(0, 20)})`);
    await open('roomF', msgs(20, 'Ef'));
    await ev(() => { M.noStSave = true; M.add(1); M.noStSave = false; M.saves0 = M.saves; });
    await ev(() => __savePoint.toggleKeep(2).catch(e => { M.newErr = e.message; }));
    r = await ev(() => ({ file: M.serverFiles.roomF.length - 1, saves: M.saves - M.saves0, err: M.newErr || '' }));
    ok(r.file === 21 && r.saves === 1 && !r.err, `3. 여기서 새로 생긴 메시지는 평소대로 저장 (${r.file}, ${r.err})`);

    // 4. [P2] a SavePoint memory saved by another device (same rev, other content) is never overwritten.
    await open('roomG', msgs(6, 'Gee'));
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    await ev(() => { const m = M.serverFiles.roomG[0].chat_metadata.savePoint; m.mem.records = []; m.mem.scenes = []; m.by = 'other-device'; M.saves0 = M.saves; toastr.log.length = 0; });
    await ev(() => __savePoint.toggleKeep(1).catch(e => { M.memErr = e.message; }));
    r = await ev(() => ({ scenes: M.serverFiles.roomG[0].chat_metadata.savePoint.mem.scenes.length, saves: M.saves - M.saves0, err: M.memErr || '' }));
    ok(r.scenes === 0 && r.saves === 0 && r.err.includes('다른 기기에서'), `4. 다른 기기가 저장한 기억은 덮어쓰지 않음 (${r.err.slice(0, 24)})`);
    //    … and an unconfirmed save is not "confirmed" by that other memory with the same rev.
    await open('roomH', msgs(6, 'Ha'));
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    await ev(() => { M.add(4); M.readFailAfterSave = true; toastr.log.length = 0; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await ev(() => __savePoint.autoBlocked());
    ok(r === 'unsure', `4. 준비: 저장 확인 불가 (${r})`);
    await ev(() => { M.readFailAfterSave = false; M.serverError = false; const f = JSON.parse(JSON.stringify(M.meta.savePoint)); f.mem.scenes = []; f.mem.records = []; f.by = 'other-device'; M.serverFiles.roomH[0].chat_metadata.savePoint = f; toastr.log.length = 0; M.saves0 = M.saves; });
    await page.waitForTimeout(3600);
    await ev(() => __savePoint.toggleKeep(1).catch(e => { M.unsureErr = e.message; }));
    r = await ev(() => ({ blocked: __savePoint.autoBlocked(), t: toastr.log.map(x => x[1]).join(' | '), saves: M.saves - M.saves0, scenes: M.serverFiles.roomH[0].chat_metadata.savePoint.mem.scenes.length, err: M.unsureErr || '' }));
    ok(r.blocked === 'unsure' && !r.t.includes('들어가 있는 걸 확인') && r.saves === 0 && r.scenes === 0 && r.err.includes('확인하지 못했어요'), `4. 같은 rev의 다른 기억으로는 확인되지 않고 덮어쓰지도 않음 (${r.blocked}, ${r.t.slice(0, 30)})`);

    // 5. [P2] one line per room: 🔖 shows only after the file check, never before.
    await open('roomI', msgs(6, 'Eye'));
    await ev(() => { M.serverReadDelay = 500; M.p = __savePoint.toggleKeep(1).catch(() => {}); });
    await page.waitForTimeout(150);
    r = await ev(() => !!M.chat[1].extra?.savepointKeep);
    ok(!r, '5. 서버 비교가 끝나기 전에는 🔖가 화면에 붙지 않음');
    await ev(() => M.p);
    r = await ev(() => ({ page: !!M.chat[1].extra?.savepointKeep, file: !!M.serverFiles.roomI[2].extra?.savepointKeep }));
    ok(r.page && r.file, '5. 확인이 끝나면 붙고 저장됨');
    await ev(() => { M.serverFiles.roomI[4].mes += ' (edited elsewhere)'; M.p = __savePoint.toggleKeep(2).catch(() => {}); });
    await page.waitForTimeout(150);
    r = await ev(() => !!M.chat[2].extra?.savepointKeep);
    await ev(() => M.p);
    const after = await ev(() => !!M.chat[2].extra?.savepointKeep);
    ok(!r && !after, '5. 막히는 경우 중간에도 끝에도 🔖가 붙지 않음');
    await ev(() => { M.serverReadDelay = 0; });
    //    a small save asked for during a big save waits for it (no two writes at once)
    await open('roomJ', msgs(6, 'Jay'));
    await ev(() => { M.add(4); M.overlap = 0; M.metaDelay = 500; });
    await ev(() => { __savePoint.handle('run'); });
    await page.waitForFunction(() => M.inSave > 0);
    await ev(() => __savePoint.persistSoon());
    await page.waitForTimeout(2500);
    r = await ev(() => ({ overlap: M.overlap || 0, last: __savePoint.state()?.lastIndex, n: M.chat.length }));
    ok(r.overlap === 0 && r.last === r.n - 1, `5. 큰 저장 중 작은 저장은 기다렸다가 함 (겹침 ${r.overlap})`);
    await ev(() => { M.metaDelay = 0; });

    // 6. [P2] a loot supplement whose save cannot be confirmed: no "quicksave done".
    await open('roomK', msgs(6, 'Kay'));
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1500);
    await ev(async () => { const n = 2; M.chat[n].is_user = false; M.stSave(); await __savePoint.addLoot(n, M.chat[n].mes.slice(0, 12)); M.supplementLinks = true; M.add(4, i => `Fresh talk ${i}.`); });
    await page.waitForTimeout(400);
    await ev(() => { M.saves0 = M.saves; toastr.log.length = 0; M.readFailAfterNth = 2; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1800);
    r = await ev(() => ({ t: toastr.log.map(x => `${x[0]}:${x[1]}`).join(' | '), blocked: __savePoint.autoBlocked(), saves: M.saves - M.saves0 }));
    ok(!r.t.includes('퀵세이브 완료') && r.t.includes('확인하지 못했어요') && r.blocked === 'unsure', `6. 루팅 보충 저장을 확인 못 하면 완료 안내 대신 확인 불가 (${r.saves}, ${r.t.slice(0, 80)})`);
    await ev(() => { M.supplementLinks = false; M.readFailAfterNth = 0; M.serverError = false; });

    // 7. [P2] what SillyTavern rewrites when a room opens is not a stale screen: older attachment fields
    //    and author's-note keys saved as null.
    const ell = msgs(4, 'Ell');
    const shown = JSON.parse(JSON.stringify(ell)); shown[1].extra = { media: [{ type: 'image', url: 'user/images/a.png' }] }; shown[3].extra = { files: [{ url: 'user/files/b.txt', name: 'b.txt', size: 3 }] };
    const stored = JSON.parse(JSON.stringify(ell)); stored[1].extra = { image: 'user/images/a.png' }; stored[3].extra = { file: { url: 'user/files/b.txt', name: 'b.txt', size: 3 } };
    await open('roomL', shown, { note_prompt: '', note_interval: 1, note_depth: 4, note_position: 1, note_role: 0 },
        file(stored, { note_prompt: null, note_interval: null, note_depth: null, note_position: null, note_role: null }));
    await ev(() => { M.saves0 = M.saves; toastr.log.length = 0; });
    await ev(() => __savePoint.toggleKeep(2).catch(e => { M.lErr = e.message; }));
    r = await ev(() => ({ saves: M.saves - M.saves0, err: M.lErr || '', mark: !!M.serverFiles.roomL[3].extra?.savepointKeep }));
    ok(r.saves === 1 && !r.err && r.mark, `7. 예전 첨부 형식·작가 노트 빈 값이 있는 방도 평소대로 저장 (${r.err.slice(0, 30)})`);

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
