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
const line = (d, t) => `📅 Date: ${d} | 🕒 Time: ${t}`;
// A small story with real dates, an unknown time, a flashback, a vague jump and a promise. Invented text only.
async function storyMemory() {
    const { emptyMem, applyResult, normalizeResult, validateResult } = await import(path.join(EXT, 'core.js'));
    let mem = emptyMem(), n = 0;
    const part = p => {
        const w = `${p.words || 'x'}\n${(p.q || []).join('\n')}`;
        const chunk = { from: n, to: n, indices: [n], text: w, texts: { [n]: w } };
        const at = t => t && { ...t, msg: n };
        const d = { scenes: [{ scene: p.newScene ? 'new' : 'continue', title: p.title, where: 'Harbor', who: [], ended: !!p.ended, outline: p.outline, notes: '', points: [{ text: 'A point.', kind: 'moment', key: false, msgs: [n] }],
            time: { mode: p.mode || 'present', start: at(p.s), end: at(p.e) } }], entities: [], changes: (p.changes || []).map(c => ({ ...c, msgs: [n], terms: { msg: n, quote: c.terms }, due: { ...c.due, msg: n } })) };
        normalizeResult(d, { mem, chunk });
        const e = validateResult(d, { mem, chunk }); if (e.length) throw new Error(e.join('; '));
        mem = applyResult(mem, d, chunk, { room: 'r' }).mem; n++;
    };
    const ex = (d, t) => ({ relation: 'explicit', date: d, clock: t, quote: line(d, t) });
    part({ newScene: true, title: 'Lantern errand', s: ex('2026-10-25', '10:00'), e: ex('2026-10-25', '11:30'), q: [line('2026-10-25', '10:00'), line('2026-10-25', '11:30')], outline: 'The courier met the keeper at the harbor.' });
    part({ title: 'Lantern errand', ended: true, s: { relation: 'same' }, e: ex('2026-10-25', '15:00'), q: [line('2026-10-25', '15:00'), '내일 북쪽 부두에서 다시 만나자고 약속했다.'], outline: 'They agreed to meet at the north pier tomorrow.',
        changes: [{ op: 'add', type: 'quest', kind: 'promise', status: 'open', who: [], text: 'Meet at the north pier.', terms: '내일 북쪽 부두에서 다시 만나자고 약속했다', due: { expr: '내일', days: 1 } }] });
    part({ newScene: true, title: 'North pier', s: ex('2026-10-26', '09:00'), e: { relation: 'unknown' }, q: [line('2026-10-26', '09:00')], outline: 'Fog covered the north pier.' });
    part({ title: 'North pier', s: ex('2026-09-01', '18:00'), e: { relation: 'same' }, q: [line('2026-09-01', '18:00')], mode: 'flashback', outline: 'A memory of the night the lamp first failed.' });
    part({ title: 'North pier', ended: true, s: { relation: 'same' }, e: { relation: 'same' }, outline: 'The keeper did not come.' });
    part({ newScene: true, title: 'Weeks later', words: '몇 주 뒤', s: { relation: 'jump', elapsed: '몇 주 뒤', quote: '몇 주 뒤' }, e: { relation: 'same' }, outline: 'Weeks later the courier came back.' });
    return mem;
}

(async () => {
    const mem = await storyMemory();
    const srv = await serve();
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1 });
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); failures++; });
    await page.goto(`http://localhost:${srv.address().port}/`);
    await page.waitForFunction(() => !!globalThis.__savePoint);
    const ev = (fn, arg) => page.evaluate(fn, arg);
    await ev(m => { for (let i = 0; i < 8; i++) M.chat.push({ name: i % 2 ? 'User' : 'Char', is_user: i % 2 === 1, mes: 'Message ' + i, extra: {} });
        M.meta.savePoint = { v: 1, roomKey: null, mem: m, lastIndex: -1, hashes: [], history: [], floor: -1, linkedSave: null, undo: null, review: null, rev: 0, lootQueue: [] }; }, mem);
    await page.click('#sp_open');
    const injBefore = await ev(() => { __savePoint.refreshInjection(); return M.prompts.savepoint?.v || ''; });
    const memBefore = await ev(() => JSON.stringify(__savePoint.state().mem));
    await ev(() => __savePoint.handle('tab', 'timeline'));
    let r = await ev(() => ({ tab: !!document.querySelector('.sp-tab[data-id=timeline]'), refs: [...document.querySelectorAll('.sp-tl-ref')].map(x => x.textContent), days: [...document.querySelectorAll('.sp-tl-day')].map(x => x.textContent),
        flash: document.querySelectorAll('.sp-tl-flash').length, unknown: document.querySelectorAll('.sp-tl-unknown').length, rows: document.querySelectorAll('.sp-tl-row').length, due: document.querySelectorAll('.sp-tl-due').length,
        order: [...document.querySelectorAll('.sp-tl-row [data-act=tl-goto]')].map(b => b.dataset.id.split('|')[1]),
        unknownDay: (() => { let el = document.querySelector('[data-act=tl-goto][data-id$="|g5"]').closest('.sp-tl-row').previousElementSibling;
            while (el && !el.classList.contains('sp-tl-day')) el = el.previousElementSibling; return el?.textContent; })() }));
    ok(r.tab && r.rows === 6 && r.order.join(',') === 'g6,g5,g4,g3,g2,g1', `1. 📅 연표 탭에 최신 구간부터 (${r.order.join(',')})`);
    ok(r.refs[0].includes('몇 주 뒤') && r.refs[1] === '실제 날짜' && r.refs.length === 2, `1. 실제 날짜와 모호한 점프 뒤 기준을 합치지 않음 (${r.refs.join(' / ')})`);
    ok(r.days.slice(-2).join(',') === '2026-10-26,2026-10-25', `1. 날짜도 최신 기록부터, 같은 날은 머리 하나 아래 (${r.days.join(', ')})`);
    ok(r.unknownDay === '2026-10-26', '1. 미확인 구간은 이후 시간 점프가 아닌 원래 날짜 묶음에 남음');
    ok(r.flash === 1 && r.unknown >= 2, '1. 회상과 시간 미확인을 구분해 표시');
    ok(r.due === 2, '1. 약속 기한이 위쪽 목록과 약속한 구간 두 곳에 연결됨');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'timeline.png'), fullPage: true });
    const injAfter = await ev(() => { __savePoint.refreshInjection(); return M.prompts.savepoint?.v || ''; });
    ok(injAfter === injBefore && !injAfter.includes('실제 날짜'), '2. 연표를 열어도 주입은 그대로');
    ok((await ev(() => JSON.stringify(__savePoint.state().mem))) === memBefore, '2. 화면 순서를 뒤집어도 저장된 장면·구간 순서와 시간은 그대로');

    // 3. jumps: journal part, time edit, quest
    const ids = await ev(() => { const s = __savePoint.state().mem.scenes; return { sid: s[1].id, gid: s[1].segs[0].id, q: __savePoint.state().mem.records[0].id }; });
    await page.click(`[data-act=tl-goto][data-id="${ids.sid}|${ids.gid}"]`);
    r = await ev(id => { const el = document.getElementById('sp-seg-' + id); const b = el?.getBoundingClientRect(); return { tab: __savePoint.ui.tab, focus: el?.classList.contains('sp-focus'), visible: !!b && b.top >= 0 && b.bottom <= innerHeight + 1 }; }, ids.gid);
    ok(r.tab === 'journal' && r.focus && r.visible, '3. 저널에서 보기: 그 구간이 펼쳐지고 화면 안에 강조');
    await ev(() => __savePoint.handle('tab', 'timeline'));
    await page.click(`[data-act=tl-edit][data-id="${ids.sid}|${ids.gid}"]`);
    r = await ev(() => ({ edit: __savePoint.ui.edit, form: !!document.querySelector('.sp-edit [data-edit=date]') }));
    ok(r.edit?.kind === 'segtime' && r.edit.id.startsWith(`${ids.sid}|${ids.gid}`) && r.form, `3. ✎ 시간: 그 구간 시간 편집 창 (${r.edit?.id})`);
    await page.click('[data-act=edit-cancel]');
    await ev(() => __savePoint.handle('tab', 'timeline'));
    await page.click(`.sp-tl-row [data-act=tl-quest][data-id="${ids.q}"]`);
    r = await ev(id => ({ tab: __savePoint.ui.tab, focus: document.getElementById('sp-quest-' + id)?.classList.contains('sp-focus') }), ids.q);
    ok(r.tab === 'quests' && r.focus, '3. 퀘스트 보기: 그 약속으로 이동해 강조');

    // 4. link a date to the undated "weeks later" reference
    await ev(() => __savePoint.handle('tab', 'timeline'));
    const jumpBtn = await ev(() => [...document.querySelectorAll('.sp-tl-ref [data-act=ref-link]')].map(b => b.dataset.id));
    ok(jumpBtn.length === 1, `4. 날짜 없는 기준에만 📅 날짜 연결 버튼 (${jumpBtn.length})`);
    await page.click('.sp-tl-ref [data-act=ref-link]');
    await page.fill('.sp-tl-ref [data-edit=date]', '2026-02-30');
    await page.click('.sp-tl-ref [data-act=edit-save]');
    r = await ev(() => ({ form: !!document.querySelector('.sp-tl-ref [data-edit=date]'), toast: (toastr.log || []).map(x => x[1]).join(' | ') }));
    ok(r.form && r.toast.includes('실제 날짜'), '4. 없는 날짜는 저장하지 않고 창 유지');
    await page.fill('.sp-tl-ref [data-edit=date]', '2026-11-20');
    await page.click('.sp-tl-ref [data-act=edit-save]');
    await page.waitForTimeout(200);
    r = await ev(() => ({ refs: [...document.querySelectorAll('.sp-tl-ref')].map(x => x.textContent), days: [...document.querySelectorAll('.sp-tl-day')].map(x => x.textContent), inj: (__savePoint.refreshInjection(), M.prompts.savepoint?.v || '') }));
    ok(r.refs.some(x => x.includes('날짜 연결됨')) && r.days.includes('2026-11-20'), `4. 연결하면 그 기준의 날이 날짜로 보임 (${r.days.join(', ')})`);
    ok(r.inj.includes('Last recorded story time: 2026-11-20'), '4. 마지막 기록 시간 주입에도 연결한 날짜');
    await ev(() => __savePoint.undo());
    r = await ev(() => { __savePoint.handle('tab', 'timeline'); return [...document.querySelectorAll('.sp-tl-day')].map(x => x.textContent); });
    ok(!r.includes('2026-11-20'), '4. 리와인드하면 연결 전으로');
    if (SHOTS) await page.screenshot({ path: path.join(OUT, 'timeline-link.png'), fullPage: true });

    await browser.close(); srv.close();
    console.log(failures ? `${failures} FAILED` : 'ALL PASS');
    process.exit(failures ? 1 : 0);
})();
