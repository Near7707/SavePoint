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
// v0.7.0-b2c: a check that no longer applies (its reason given), or one kept for b3.
const skip = (msg, why) => console.log(`SKIP  ${msg} — ${why}`);

(async () => {
    const srv = await serve();
    const browser = await chromium.launch();
    const URL = `http://localhost:${srv.address().port}/`;
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.addInitScript(s => { window.__presetSettings = s; }, { savePoint: { firstTab: 'journal', check: false, hideMode: 'off' } });
    await page.goto(URL);
    await page.waitForFunction(() => !!globalThis.__savePoint && __savePoint.vault.ready);
    await page.waitForTimeout(300);
    const ev = (fn, arg) => page.evaluate(fn, arg);

    // v0.7.1-a5 (step 4): a held room's `자세히 보기` shows what the decision kept (holdFacts) — reason, candidates, the comparison as kept —
    // and opening it reads and writes nothing. Setup as rescue.cjs: a room imported, its original deleted (sameIntegrity).
    await ev(() => {
        window.__log = { ups: [], reads: 0 };
        const g = window.fetch;
        window.fetch = async (u, o = {}) => {
            if (String(u) === '/api/files/upload') window.__log.ups.push(JSON.parse(o.body).name);
            if (/\/user\/files\/savepoint-|\/api\/chats\/get/.test(String(u))) window.__log.reads++;
            return g(u, o);
        };
        window.__mark = () => ({ ups: window.__log.ups.length, reads: window.__log.reads, saves: (M.saveBodies || []).length, popups: (M.popups || []).length });
        window.__since = m => ({ ups: window.__log.ups.length - m.ups, reads: window.__log.reads - m.reads, saves: (M.saveBodies || []).length - m.saves, popups: (M.popups || []).length - m.popups });
        window.__look = () => {
            if (!__savePoint.ui.open) $('#sp_wand').trigger('click');
            const h = __savePoint.home(), d = $('.sp-home-alert .sp-hold-detail');
            return { status: h.status, why: h.why, more: $('.sp-home-alert [data-act="home-detail"]').text(), open: d.length, own: d.attr('data-own') ?? null, cmp: d.attr('data-cmp') ?? null,
                text: d.text(), rooms: d.find('.sp-hold-room').map((i, e) => e.dataset.role + ':' + $(e).find('b').text()).get(), mems: d.find('.sp-hold-mem').map((i, e) => e.dataset.state).get().join(','),
                caveat: d.find('.sp-hold-caveat:visible').length, under: d.find('.sp-hold-caveat').prev().text(), line: $('#sp_overlay .sp-roomline').attr('data-kind') ?? null, gone: d.find('.sp-hold-gone').length, rescueBtn: $('[data-act="home-rescue"]').length };
        };
    });
    const held = (a, c, { edit = '' } = {}) => ev(async ([a, c, edit]) => {
        await M.switchChat(a, [], {}); await M.opened(); M.add(10); await __savePoint.handle('run').catch(() => {});
        for (let i = 0; i < 100 && !(__savePoint.home().status === 'linked' && __savePoint.state()?.lastIndex >= 0 && M.files.has(M.H.tagName(__savePoint.home().key))); i++) await new Promise(z => setTimeout(z, 50));
        const id = __savePoint.home().id;
        M.importChat(a, c);
        if (edit) (0, eval)(`(f => { ${edit} })`)(M.serverFiles[c]);
        await M.switchChat(a + 'x', [], {}); await M.opened();
        await M.deleteChat(a);
        await M.openFile(c); await M.opened();
        for (let i = 0; i < 40 && __savePoint.home().status === 'opening'; i++) await new Promise(z => setTimeout(z, 50));
        await new Promise(z => setTimeout(z, 200));
        return { ...__look(), id };
    }, [a, c, edit]);
    const toggle = () => ev(async () => { const m = __mark(); await __savePoint.handle('home-detail'); await new Promise(z => setTimeout(z, 200)); return { ...__look(), ...__since(m) }; });
    // The page's decision replaced by one of another reason (what decideRoom keeps for it: home.test), then drawn again.
    const as = (d, why) => ev(async ([d, why]) => { const h = __savePoint.home(); h.d = d; h.why = why; __savePoint.render(); await new Promise(z => setTimeout(z, 100)); return __look(); }, [d, why]);

    // 1. Held with the rescue offer: the button only; opened, every recorded original matched, the other room and its memory; no read, no write.
    let r = await held('hdA', 'hdA imported');
    ok(r.status === 'held' && r.why === 'sameIntegrity' && r.more === '자세히 보기' && r.open === 0, `1. 보류 → 자세히 보기 버튼만, 상세는 닫힘 (${JSON.stringify(r)})`);
    let p = await toggle();
    ok(p.open === 1 && p.own === 'true' && p.cmp === 'all' && p.text.includes('기억에 기록된 원문 10개가 모두 일치해요') && p.rooms.join() === 'same:hdA' && p.mems === ''
        && p.text.includes(`기억 ${r.id.slice(0, 6)}`) && p.text.includes('같은 고유값의 다른 방에 이미 기억이 있어요') && p.text.includes('이 방에 기억 복사해 복구') && p.more === '자세히 접기',
        `1. 상세: 이유·후보 방·기억 파일·전체 일치 10개·복사 복구 안내 (${JSON.stringify(p)})`);
    ok(p.gone === 1 && p.text.includes('같은 고유값으로 기억이 연결된 기록이 있는 방: hdA') && p.text.includes('지운 방도 여기 남아 있을 수 있어요(SavePoint는 방이 지워졌는지 알 수 없어요).'),
        `1. (a6) 후보는 "기록이 있는 방" + 지운 방도 남을 수 있다는 한 줄 (${JSON.stringify(p)})`);
    ok(p.ups === 0 && p.saves === 0 && p.reads === 0 && p.popups === 0 && p.status === 'held' && p.line === 'held', `1. 상세를 열어도 읽기·쓰기·확인창 0, 상태 그대로 (${JSON.stringify(p)})`);
    ok(!/같은 방(이에요|인지 확인했|확인 완료)/.test(p.text), `1. 전체 일치여도 "같은 방 확인" 표현 없음 (${p.text})`);
    p = await toggle();
    ok(p.open === 0 && p.more === '자세히 보기' && p.ups === 0 && p.reads === 0, `1. 다시 누르면 접힘 (${JSON.stringify(p)})`);

    // 2. Open, the room left and opened again: closed (bound to that opening of the room).
    await toggle();
    p = await ev(async () => { await M.switchChat('hdOther', [], {}); await M.opened(); await M.openFile('hdA imported'); await M.opened(); await new Promise(z => setTimeout(z, 300)); return __look(); });
    ok(p.status === 'held' && p.open === 0 && p.more === '자세히 보기', `2. 방을 바꿨다 다시 열면 상세는 닫혀 있음 (${JSON.stringify(p)})`);

    // 3. A recorded original differs: no offer, no comparison kept → said so, not guessed.
    r = await held('hdB', 'hdB imported', { edit: "f[4].mes = 'changed here';" });
    p = await toggle();
    ok(r.rescueBtn === 0 && p.open === 1 && p.cmp === 'none' && p.text.includes('이번 확인에서는 원문 비교 결과가 없어요') && !p.text.includes('복사해 복구') && p.rooms.join() === 'same:hdB' && !/번째/.test(p.text),
        `3. 원문 하나가 다름 → 비교 결과 없음이라고만, 복구 안내 없음 (${JSON.stringify(p)})`);

    // 4. A sample comparison (row 3/6 unproven): counted as kept, the caveat right under it and shown; no first place, no whole match.
    p = await as({ verdict: 'hold', why: 'unproven', prints: { total: 5, matched: 3, first: 2 } }, 'unproven');
    ok(p.cmp === 'sample' && p.text.includes('확인한 표본 5곳 중 3곳 일치') && p.caveat === 1 && p.under === '확인한 표본 5곳 중 3곳 일치' && p.text.includes('일부 메시지만 비교한 결과예요. 이것만으로 같은 방인지 확인할 수는 없어요.')
        && !/번째|모두 일치/.test(p.text) && p.text.includes('연결할 기억 파일을 확인하지 못했어요'), `4. 표본 5곳 중 3곳 + 바로 아래 주의 문구(보임), 처음 다른 곳·전체 일치 없음 (${JSON.stringify(p)})`);
    p = await as({ verdict: 'hold', why: 'unproven', mem: 'abcdef123', prints: { total: 5, matched: 5, first: -1 } }, 'unproven');
    ok(p.cmp === 'sample' && p.text.includes('확인한 표본 5곳 중 5곳 일치') && p.caveat === 1 && !p.text.includes('모두 일치') && p.text.includes('기억 abcdef'), `4. 표본이 모두 맞아도 표본 결과와 주의 문구 (${JSON.stringify(p)})`);
    p = await as({ verdict: 'hold', why: 'unproven', prints: { total: 0, matched: 0, first: -1 } }, 'unproven');
    ok(p.cmp === 'empty' && p.text.includes('비교할 표본이 없었어요') && p.caveat === 0, `4. 표본 0곳 → 비교할 표본이 없었어요 (${JSON.stringify(p)})`);

    // 5. A branch: the first difference found over the parent's whole record, worded as the first one found (not "from N on").
    const P = JSON.stringify(['Ava', 'Ava - 2026-10-01@10h05m00s000ms']);
    p = await as({ verdict: 'hold', why: 'branchUnproven', parent: P, at: 7, reason: 'floor' }, 'branchUnproven');
    ok(p.cmp === 'diff' && p.text.includes('처음 확인된 차이: 8번째 메시지') && !/부터 다름|부터 달라/.test(p.text) && p.rooms.join() === 'parent:2026-10-01 10:05 채팅' && p.caveat === 0,
        `5. 갈래: 처음 확인된 차이 8번째, 원래 방 표시 (${JSON.stringify(p)})`);
    p = await as({ verdict: 'hold', why: 'parentGone', parent: P }, 'parentGone');
    ok(p.cmp === 'none' && p.text.includes('기억 파일 없음') && p.rooms.join() === 'parent:2026-10-01 10:05 채팅' && p.gone === 0, `5. 원래 방 기억 파일 없음 (${JSON.stringify(p)})`);
    p = await as({ verdict: 'hold', why: 'memGone', mem: 'zzzzzz99', from: P }, 'memGone');
    ok(p.mems === 'missing' && p.text.includes('파일 없음') && p.rooms.join() === 'from:2026-10-01 10:05 채팅', `5. 이름표는 있는데 기억 파일 없음 → 파일 없음 (${JSON.stringify(p)})`);

    // 5b. (a6) rooms an old copy was moved to: also "recorded", with the same note; a rename's rooms get no note.
    p = await as({ verdict: 'hold', why: 'copyMoved', from: P }, 'copyMoved');
    ok(p.rooms.join() === 'moved:2026-10-01 10:05 채팅' && p.text.includes('이 방의 예전 기억을 옮겨 간 기록이 있는 방') && p.gone === 1, `5b. 옮겨 간 방도 "기록이 있는 방" + 지운 방 한 줄 (${JSON.stringify(p)})`);
    p = await as({ verdict: 'hold', why: 'renameUnproven', from: P }, 'renameUnproven');
    ok(p.rooms.join() === 'from:2026-10-01 10:05 채팅' && p.gone === 0, `5b. 이름 변경 후보에는 그 한 줄 없음 (${JSON.stringify(p)})`);

    // 6. A hold made later for another reason (here, while writing): only that reason; nothing from the decision kept for the earlier one.
    p = await as({ verdict: 'hold', why: 'sameIntegrity', candidates: [P], rescue: { from: P, mem: 'abcdef123', last: 9 } }, 'tagChanged');
    ok(p.own === 'false' && p.cmp === 'none' && !p.rooms.length && p.text.includes('기억 이름표가 그사이 바뀌었어요') && p.text.includes('연결할 기억 파일을 확인하지 못했어요') && !p.text.includes('모두 일치'),
        `6. 판정 뒤 다른 이유로 보류 → 이유만, 후보·비교 없음 (${JSON.stringify(p)})`);

    // 7. A linked room: no detail button, nothing drawn.
    p = await ev(async () => { await M.switchChat('hdLinked', [], {}); await M.opened(); M.add(3); await new Promise(z => setTimeout(z, 300)); return __look(); });
    ok(p.status !== 'held' && p.more === '' && p.open === 0, `7. 보류가 아닌 방 → 자세히 보기 없음 (${JSON.stringify(p)})`);
    // the toggle called anyway (an old click) opens nothing
    p = await toggle();
    ok(p.open === 0 && p.more === '' && p.ups === 0, `7. 보류가 아닐 때 누르기가 와도 열리지 않음 (${JSON.stringify(p)})`);

    if (SHOTS) {
        await ev(() => $('#sp_wand').trigger('click'));
        await page.screenshot({ path: path.join(OUT, 'hold-detail.png') });
    }
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
