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
    const settingsOf = page => page.evaluate(() => JSON.parse(JSON.stringify(M.settings)));
    const page = await session();
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(() => { M.add(14); $('#sp_wand').trigger('click'); });

    // 1. "continue" with no open scene is read as "new" (first scene only)
    await ev(() => { M.firstContinue = true; });
    const c0 = await ev(() => M.calls.length);
    await ev(() => __savePoint.handle('run'));
    let r = await ev(() => ({ last: __savePoint.state().lastIndex, scenes: __savePoint.state().mem.scenes.length }));
    ok(r.last === 13 && r.scenes === 1, '1. 열린 장면 없이 온 continue → new로 받아 저장');
    ok((await ev(c => M.calls.slice(c).filter(p => !p.startsWith('You are checking')).length, c0)) === 1, '1. 재요청 없이 한 번에 통과');
    ok((await ev(() => M.calls.find(p => p.includes('[OPEN SCENE]')).includes('there is no open scene, so the first scene must be "new"'))), '1. 프롬프트에 열린 장면 없음 명시');
    await ev(() => { M.firstContinue = false; });

    // 2. record check ran after the save: no issues
    await page.waitForTimeout(800);
    r = await ev(() => ({ calls: M.checkCalls, status: __savePoint.state().check?.status, hud: $('.sp-hud').text(), prompt: M.lastCheck }));
    ok(r.calls === 1 && r.status === 'ok' && r.hud.includes('기록 확인: 문제 없음'), '2. 저장 후 기록 확인 1회, 문제 없음 표시');
    ok(r.prompt.includes('[ORIGINAL MESSAGES]') && /#\d+ (Ari|Me): Message/.test(r.prompt) && r.prompt.includes('[JOURNAL]'), '2. 확인 입력에 관련 저널과 근거 원문 포함');

    // 3. issues: shown with both sentences and the original excerpt; edit / ignore; nothing changed
    await ev(() => { M.add(6); M.checkIssues = true; });
    const memBefore = await ev(() => JSON.stringify(__savePoint.state().mem));
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(800);
    r = await ev(() => ({ st: __savePoint.state().check, hud: $('.sp-checks').text() }));
    ok(r.st.status === 'issues' && r.st.issues.length === 1, '3. 확인 필요 1건 (목록에 없는 id 항목은 버림)');
    ok(r.hud.includes('확인 필요 1건') && r.hud.includes('so Theo owes the dishes') && r.hud.includes('The one who loses washes') && /#\d+ (Ari|Me):/.test(r.hud), '3. 충돌한 두 문장과 원문 발췌 표시');
    const memAfter = await ev(() => JSON.stringify(__savePoint.state().mem));
    ok(memAfter !== memBefore && !(await ev(() => __savePoint.state().mem.scenes[0].segs.some(g => /dishes/.test(g.outline || '')))), '3. 확인은 기록을 고치지 않음');
    const issueId = r.st.issues[0].id;
    await ev(id => __savePoint.handle('check-edit', id), issueId);
    r = await ev(() => ({ edit: __savePoint.ui.edit?.kind, open: $('.sp-more[open] .sp-edit').length }));
    ok(r.edit === 'segoutline' && r.open === 1, '3. 편집 → 해당 구간 개요 편집이 바로 열림');
    await ev(() => __savePoint.handle('edit-cancel'));
    await ev(id => __savePoint.handle('check-ignore', id), issueId);
    ok(!(await ev(() => $('.sp-checks').length)), '3. 무시하면 경고가 사라짐');
    await ev(() => { M.checkIssues = false; });

    // 4. a failed check is not "no problems"
    await ev(() => { M.add(6); M.checkBad = true; });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    r = await ev(() => ({ st: __savePoint.state().check.status, hud: $('.sp-hud').text() }));
    ok(r.st === 'failed' && r.hud.includes('기록 확인 실패') && !r.hud.includes('문제 없음'), '4. 확인 실패는 "문제 없음"과 구분해서 표시');
    await ev(() => { M.checkBad = false; });
    await ev(() => __savePoint.handle('check-rerun'));
    ok((await ev(() => __savePoint.state().check.status)) === 'ok', '4. 다시 확인');

    // 5. the last failure line clears after a success
    await ev(() => { M.add(4); M.failAt = M.chat.length - 2; });
    await ev(() => __savePoint.handle('run'));
    ok((await ev(() => $('.sp-err').length)) === 1, '5. 실패하면 "마지막 실패" 표시');
    await ev(() => { M.failAt = undefined; });
    await ev(() => __savePoint.handle('run'));
    ok((await ev(() => $('.sp-err').length)) === 0, '5. 성공하면 "마지막 실패" 표시가 사라짐');

    // 6. setting off: no check call
    await page.waitForTimeout(900);
    const k0 = await ev(() => M.checkCalls);
    await ev(() => { M.settings.savePoint.check = false; M.add(4); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(700);
    ok((await ev(() => M.checkCalls)) === k0, '6. 설정을 끄면 기록 확인 안 함');

    // 7. saves: manual slots stay on top in creation order; other characters per card
    await page.waitForTimeout(1400);
    await ev(async () => { M.popupInput = 'First'; await __savePoint.handle('save-new'); });
    await page.waitForTimeout(20);
    await ev(async () => { M.popupInput = 'Second'; await __savePoint.handle('save-new'); });
    const firstId = await ev(() => __savePoint.listSaves().find(x => x.name === 'First').id);
    await ev(async id => { M.popupInput = 'First renamed'; await __savePoint.handle('save-rename', id); }, firstId);
    await ev(async () => {
        const st = __savePoint.state();
        const base = { mem: st.mem, stats: {}, msgCount: 3, pos: null, version: 'x', auto: false, created: 1, updated: 1 };
        await __savePoint.vault.put({ ...base, id: 'o1', name: 'Other A', room: JSON.stringify(['wren.png', 'Wren - 2026-01-01@10h00m00s000ms']), char: 'Wren' });
        await __savePoint.vault.put({ ...base, id: 'o2', name: 'Other B', room: JSON.stringify(['ivy.png', 'Ivy - 2026-01-02@10h00m00s1ms']), char: 'Ivy' });
        __savePoint.handle('tab', 'saves');
    });
    r = await ev(() => ({ here: $('details[data-group="here"] .sp-save-n').map((i, e) => e.textContent).get(), chars: $('details[data-group^="char:"] > summary').map((i, e) => e.textContent.trim()).get() }));
    ok(r.here[0] === 'Second' && r.here[1] === 'First renamed' && r.here.slice(2).every(n => n.startsWith('오토세이브')), `7. 직접 만든 슬롯은 맨 위, 만든 순서로 고정 (${r.here.slice(0, 3).join(' / ')})`);
    ok(r.chars.length === 2 && r.chars.some(t => t.includes('Wren')) && r.chars.some(t => t.includes('Ivy')), '7. 다른 캐릭터는 캐릭터 카드별로 묶음');

    // 8. bare names instead of ids are linked; nothing to retry
    await ev(() => { __savePoint.handle('tab', 'journal'); M.settings.savePoint.check = false; M.bareNames = true; const b8 = M.chat.length; M.add(4, i => (i === b8 + 1 ? 'PROMISE to race again' : '')); });
    const c8 = await ev(() => M.calls.length);
    await ev(() => __savePoint.handle('run'));
    r = await ev(c => ({ calls: M.calls.length - c, err: $('.sp-err').length, last: __savePoint.state().lastIndex, len: M.chat.length,
        q: __savePoint.state().mem.records.filter(x => x.type === 'quest').pop() }), c8);
    ok(r.calls === 1 && r.err === 0 && r.last === r.len - 1, '8. 이름("Ari")을 번호 대신 써도 연결해서 한 번에 저장');
    ok(r.q && /^e\d+$/.test(r.q.who[0]), `8. 퀘스트 who가 인물 번호로 저장 (${r.q?.who})`);
    await ev(() => { M.bareNames = false; });

    // 9. long failure / warning lists scroll inside themselves and stay open across redraws
    await ev(() => {
        const st = __savePoint.state();
        st.check = { at: Date.now(), status: 'issues', scope: { records: [], segs: [] }, issues: Array.from({ length: 12 }, (_, i) => ({
            id: 'c' + i, about: st.mem.scenes[0].segs[0].id, kind: 'misread', problem: 'Problem number ' + i + ' '.repeat(3) + 'x'.repeat(120), conflict: ['a sentence', 'another sentence'], msgs: [1], excerpt: ['#1 Ari: some original text '.repeat(4)], ignored: false })) };
        __savePoint.ui.lastError = { at: Date.now(), range: '#0–#55', detail: Array.from({ length: 30 }, (_, i) => `changes[${i}].holder "${i % 2 ? 'Theo' : 'Mara'}" is not a known entity id or a ref declared in "entities".`).concat(Array.from({ length: 25 }, (_, i) => `scenes[0].points[${i}] needs "text".`)) };
        M.settings.savePoint.check = true;
        __savePoint.render(true);
    });
    await page.click('.sp-checks > summary');
    await page.click('.sp-err > summary');
    const scrollInfo = () => ev(() => [...document.querySelectorAll('.sp-hud .sp-scroll')].map(e => ({ sh: e.scrollHeight, ch: e.clientHeight, inView: e.getBoundingClientRect().bottom <= window.innerHeight + 1 })));
    let sc = await scrollInfo();
    ok(sc.length === 2 && sc.every(x => x.sh > x.ch && x.ch > 50), `9. 두 목록 모두 높이 제한 + 안에서 스크롤 (${sc.map(x => x.ch + '/' + x.sh).join(', ')})`);
    const box = await page.locator('.sp-checks .sp-scroll').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
    ok((await ev(() => document.querySelector('.sp-checks .sp-scroll').scrollTop)) > 100, '9. 경고 목록이 실제로 아래로 내려감');
    r = await ev(() => $('.sp-err li').map((i, e) => e.textContent).get());
    ok(r[0].includes('"Mara" ×15') && r[0].includes('"Theo" ×15') && r.length === 26, `9. 같은 이름 오류는 한 줄로 묶음 (${r.length}줄)`);
    await ev(() => __savePoint.render(true));
    ok((await ev(() => $('.sp-checks').prop('open') && $('.sp-err').prop('open'))), '9. 다시 그려도 펼친 상태 유지');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'v027_scroll.png') });
    await ev(() => { __savePoint.ui.lastError = null; __savePoint.state().check = null; __savePoint.render(true); });

    // 10. the check sees the whole event behind a changed record first, and says what was left out
    await ev(() => {
        M.settings.savePoint.inputChars = 60000; M.manyPoints = true;
        const base = M.chat.length;
        M.add(90, i => (i === base + 80 ? 'PROMISE: picnic on Sunday. ' : `Note ${i}: `) + 'the band plays on and the crowd claps along. '.repeat(14));
    });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(900);
    r = await ev(() => {
        const p = M.lastCheck, orig = p.split('[ORIGINAL MESSAGES]')[1];
        const pt = __savePoint.state().mem.scenes.flatMap(sc => sc.segs.flatMap(g => g.points)).filter(x => x.text.startsWith('The game leading')).pop();
        const rec = __savePoint.state().mem.records.filter(x => x.type === 'quest').pop();
        return { range: pt.msgs.join(','), rec: rec.msgs.join(','), has: pt.msgs.length > 1 && pt.msgs.every(k => orig.includes(`\n#${k} `)), shown: [...orig.matchAll(/\n#(\d+) /g)].map(m => m[1]).join(','), notShown: /not shown for length: #\d+/.test(orig), rule: p.includes('If the message that would support it is simply not shown') };
    });
    ok(r.has, `10. 바뀐 기록(#${r.rec})이 걸린 사건 전체(#${r.range})를 먼저 넣음 [보낸 원문 ${r.shown}]`);
    ok(r.notShown && r.rule, '10. 길이 때문에 뺀 원문 번호를 알려 주고, 안 보인 원문은 문제로 삼지 않게 함');
    await ev(() => { M.manyPoints = false; });

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
