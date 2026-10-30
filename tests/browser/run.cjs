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
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('[SavePoint]')) console.log('CONSOLE', m.text()); });
    await page.goto(`http://localhost:${srv.address().port}/`);
    await page.waitForFunction(() => !!globalThis.__savePoint);
    await page.evaluate(() => { M.settings.savePoint.check = false; });   // the record check has its own suite (checks.cjs)
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const sleep = ms => page.waitForTimeout(ms);
    const SP = '__savePoint';

    // 1. first summary through the last message
    await ev(() => { M.add(40); __savePoint.handle('tab', 'journal'); $('#sp_wand').trigger('click'); });
    await ev(() => __savePoint.handle('run'));
    // Autosave is debounced and then writes asynchronously; wait for the result, not a fixed delay.
    await page.waitForFunction(() => __savePoint.listSaves().some(x => x.auto) && [...M.files.keys()].some(k => k.startsWith('savepoint-auto-')), null, { timeout: 10000 });
    let r = await ev(() => { const st = __savePoint.state(); return { last: st.lastIndex, scenes: st.mem.scenes.length, open: st.mem.scenes[0]?.status,
        hid: M.chat.map(m => m.is_system), inj: M.prompts.savepoint?.v || '', autos: __savePoint.listSaves().filter(x => x.auto).length, calls: M.calls.length, chatSaves: M.chatSaves, serverAuto: [...M.files.keys()].some(k => k.startsWith('savepoint-auto-')) }; });
    ok(r.last === 39, `마지막 메시지까지 정리 (#${r.last})`);
    ok(r.scenes === 1 && r.open === 'open', '장면 1개, 끝나지 않아 열린 상태');
    ok(r.hid.slice(0, 30).every(Boolean) && r.hid.slice(30).every(x => !x), '최근 10개만 남기고 하이드');
    ok(r.inj.startsWith('[SavePoint memory') && r.inj.includes('## Journal'), '영어 머리말로 주입');
    ok(r.autos === 1 && r.serverAuto, '오토세이브 1개 (서버 파일)');
    ok(r.calls === 2, `요약 호출 2번 (한 요청에 메시지 20개까지, ${r.calls})`);
    await sleep(700);
    ok(await ev(() => M.chatSaves) >= 1, '하이드 후 채팅 저장 요청');

    // 2. no new messages: run does nothing
    await ev(() => __savePoint.handle('run'));
    ok(await ev(() => M.calls.length) === 2 && (await ev(() => toastr.log.at(-1)[1])).includes('새 메시지가 없어요'), '새 메시지가 없으면 호출 안 함');

    // 3. swipe of the last message rolls back only the batch that holds it (#20–#39)
    await ev(async () => { M.chat[39].mes = 'Rerolled'; M.chat[39].swipe_id = 1; await M.eventSource.emit('message_swiped', 39); });
    await sleep(300);
    r = await ev(() => { const st = __savePoint.state(); return { last: st.lastIndex, scenes: st.mem.scenes.length, hid: M.chat.map(m => !!m.is_system), inj: M.prompts.savepoint?.v || '', calls: M.calls.length }; });
    ok(r.last === 19 && r.scenes === 1 && r.hid.slice(0, 20).every(Boolean) && r.hid.slice(20).every(x => !x) && r.inj !== '', `스와이프로 바뀐 #39가 든 구간(#20–#39)만 되감기 + 그 구간 하이드 해제 (#${r.last})`);
    ok(r.calls === 2, '스와이프는 자동 정리를 일으키지 않음');

    // 4. manual run again, then add more; multi-chunk with a failing middle chunk
    await ev(() => __savePoint.handle('run'));
    await ev(() => { M.add(60, i => (i === 50 ? 'SCENEBREAK at the market. PROMISE to meet. ' : '') + `Message ${i} ${'words '.repeat(60)}`); M.settings.savePoint.inputChars = 20000; M.failAt = 75; });
    const before = await ev(() => M.calls.length);
    await ev(() => __savePoint.handle('run'));
    r = await ev((b0) => { const st = __savePoint.state(); return { last: st.lastIndex, scenes: st.mem.scenes.map(s => [s.title, s.status, s.segs.length]), hid: M.chat.map(m => m.is_system),
        err: toastr.log.filter(x => x[0] === 'error').at(-1)?.[1] || '', calls: M.calls.length, maxPrompt: Math.max(...M.calls.slice(-6).map(p => p.length)), overShare: M.calls.slice(b0).filter(p => !p.includes('REJECTED')).map(p => { const m = p.split(/\[NEW MESSAGES\][^\n]*\n/)[1].split('\n\nReturn ONLY')[0]; return m.length - Math.max(4000, 20000 - (p.length - m.length)); }), quests: st.mem.records.filter(x => x.type === 'quest').length }; }, before);
    ok(r.last > 39 && r.last < 75, `실패 구간 전까지만 저장 (#${r.last})`);
    ok(/\d+개 구간\(\d+개 메시지\)은 저장했고/.test(r.err) && r.err.includes('그대로 남겨'), `실패 안내에 저장된 구간 수 표시 (${r.err.slice(-80)})`);
    const visibleFrom = r.hid.findIndex(x => !x);
    ok(visibleFrom === Math.min(r.last, 99 - 10) + 1 && r.hid.slice(visibleFrom).every(x => !x), `하이드는 저장된 범위 안에서만 (보이기 시작 #${visibleFrom})`);
    ok(r.calls - before >= 4, `실패 구간은 한 번 다시 요청 (호출 ${r.calls - before})`);
    ok(r.overShare.every(x => x <= 450), `입력 한도에 맞춰 나눠 보냄 (메시지 몫 = 한도 - 나머지, 최소 4000자; 초과 ${r.overShare.join(',')})`);
    ok(r.scenes.length === 2 && r.scenes[0][2] >= 2, `긴 장면은 같은 장면에 중간 기록으로 이어짐 (${JSON.stringify(r.scenes)})`);
    ok(r.quests === 1, '약속이 퀘스트로 기록');

    // 5. retry from the failure point
    await ev(() => { M.failAt = undefined; });
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => { const st = __savePoint.state(); return { last: st.lastIndex, scenes: st.mem.scenes.map(s => s.status) }; });
    ok(r.last === 99, '다시 누르면 실패 지점부터 끝까지 정리');
    ok(r.scenes.filter(s => s === 'open').length === 1 && r.scenes.at(-1) === 'open', '열린 장면은 항상 마지막 하나');

    // 6. undo restores the state before the last run
    await ev(() => __savePoint.handle('undo'));
    ok(await ev(() => __savePoint.state().lastIndex) < 99, '되돌리기 → 마지막 정리 전으로');
    await ev(() => __savePoint.handle('run'));

    // 7. Korean output is retried, bad evidence once is retried
    await ev(() => { M.add(4); M.korean = true; });
    let c0 = await ev(() => M.calls.length);
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => ({ last: __savePoint.state().lastIndex, calls: M.calls.length, retry: M.calls.at(-1).includes('not written in English') }));
    ok(r.last === 103 && r.calls - c0 === 2 && r.retry, '한국어 응답은 영어로 다시 요청 후 저장');
    await ev(() => { M.korean = false; M.add(4); M.badOnce = true; });
    c0 = await ev(() => M.calls.length);
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => ({ last: __savePoint.state().lastIndex, calls: M.calls.length }));
    ok(r.last === 107 && r.calls - c0 === 2, '범위 밖 근거는 거부 → 재요청 후 저장');
    await ev(() => { M.badOnce = false; });

    // 8. close the scene with no new messages
    await ev(() => __savePoint.handle('run-close'));
    ok(await ev(() => __savePoint.state().mem.scenes.every(s => s.status === 'closed')), '장면 끝내고 기록 → 열린 장면 닫힘');

    // 9. edit a hidden message in the middle → rollback from that batch
    const histLen = await ev(() => __savePoint.state().history.length);
    await ev(async () => { M.chat[45].mes = 'Edited text'; await M.eventSource.emit('message_edited', 45); });
    await sleep(300);
    r = await ev(() => { const st = __savePoint.state(); return { last: st.lastIndex, hist: st.history.length, hid46: M.chat[46].is_system }; });
    ok(r.last < 45 && r.hist < histLen && !r.hid46, `중간 원문 수정 → 그 구간부터 되감기 (#${r.last}), 숨김 해제`);
    await ev(() => __savePoint.handle('run'));
    ok(await ev(() => __savePoint.state().lastIndex) === 107, '다시 정리');

    // 10. delete a message
    await ev(async () => { M.chat.splice(80, 1); await M.eventSource.emit('message_deleted', 80); });
    await sleep(300);
    ok(await ev(() => __savePoint.state().lastIndex) < 80, '메시지 삭제 → 되감기');
    await ev(() => __savePoint.handle('run'));

    // 11. save file, load into another chat (detached), then exact restore in a branch
    await ev(() => { M.popupInput = 'Route A'; });
    await ev(() => __savePoint.handle('save-new'));
    await sleep(300);
    const saveId = await ev(() => __savePoint.listSaves().find(x => !x.auto).id);
    const mainChat = await ev(() => ({ chat: structuredClone(M.chat), last: __savePoint.state().lastIndex }));
    await ev(async () => { await M.switchChat('chatB', [], {}); M.add(3); });
    await ev(id => __savePoint.handle('load', id), saveId);
    r = await ev(() => { const st = __savePoint.state(); return { last: st.lastIndex, ext: st.mem.scenes.every(s => s.external), linked: st.linkedSave, inj: (M.prompts.savepoint?.v || '').length }; });
    ok(r.last === -1 && r.ext && r.linked === saveId && r.inj > 0, '다른 방에서 불러오기 → 기억만 가져오고 이 방 메시지는 정리 전, 슬롯에 플레이 중');
    await ev(() => __savePoint.handle('run'));
    ok(await ev(() => __savePoint.state().mem.scenes.length) > await ev(() => 0) , '새 방에서 이어서 기록');
    await ev(async c => { await M.switchChat('chatC', c.chat.map(m => ({ ...m, is_system: false, extra: {} })), {}); }, mainChat);
    await ev(id => __savePoint.handle('load', id), saveId);
    r = await ev(() => { const st = __savePoint.state(); return { last: st.lastIndex, ext: st.mem.scenes.some(s => s.external), linked: st.linkedSave, hid: M.chat[5].is_system }; });
    ok(r.last === mainChat.last && !r.ext && r.linked === saveId && r.hid, '같은 원문 분기에서 불러오기 → 저장 위치 그대로 복원 + 하이드');

    // 12. an edit before the restored floor needs a decision
    await ev(async () => { M.chat[3].mes = 'changed'; await M.eventSource.emit('message_edited', 3); });
    await sleep(300);
    r = await ev(() => ({ review: !!__savePoint.state().review, inj: M.prompts.savepoint?.v || '', hid: M.chat.some(m => m.is_system) }));
    ok(r.review && r.inj === '' && !r.hid, '기록 이전 원문 변경 → 안내 표시, 주입·하이드 중지');
    await ev(() => __savePoint.handle('review-accept'));
    r = await ev(() => ({ review: !!__savePoint.state().review, inj: M.prompts.savepoint?.v || '' }));
    ok(!r.review && r.inj.length > 0, '지금 원문 기준으로 인정 → 다시 사용');

    // 13. translation and Korean view
    await ev(() => __savePoint.handle('translate'));
    r = await ev(() => { const st = __savePoint.state(); return { ko: st.mem.scenes[0].segs[0].koOutline, show: M.settings.savePoint.showKo, html: $('.sp-outline').first().text() }; });
    ok(r.ko?.startsWith('한국어') && r.show && r.html.startsWith('한국어'), '번역 채우기 → 한국어 보기');

    // 14. manual edits through the UI
    await ev(() => __savePoint.handle('tab', 'quests'));
    await ev(() => __savePoint.handle('add-rec', 'quest'));
    await ev(() => { $('#sp_overlay [data-edit="text"]').val('Me owes Ari a coffee.').trigger('input'); $('#sp_overlay [data-edit="kind"]').val('debt').trigger('change'); });
    await ev(() => __savePoint.handle('edit-save'));
    r = await ev(() => __savePoint.state().mem.records.find(x => x.text === 'Me owes Ari a coffee.'));
    ok(r && r.kind === 'debt' && r.status === 'open', '퀘스트 직접 추가');
    await ev(id => __savePoint.handle('quest-done', id), r.id);
    ok(await ev(id => __savePoint.state().mem.records.find(x => x.id === id).status, r.id) === 'done', '퀘스트 완료 처리');
    const injText = await ev(() => M.prompts.savepoint.v);
    ok(injText.includes('Resolved threads') , '완료한 퀘스트는 해결됨으로 주입');

    // 15. all tabs render
    for (const t of ['journal', 'quests', 'party', 'items', 'world', 'saves', 'inject']) {
        await ev(t => __savePoint.handle('tab', t), t);
        const html = await ev(() => $('#sp_overlay .sp-body').html().length);
        ok(html > 50, `탭 ${t} 표시`);
    }
    // 16. metadata save failure keeps memory unchanged
    await ev(() => { M.add(3); M.failMeta = true; });
    const lastBefore = await ev(() => __savePoint.state().lastIndex);
    await ev(() => __savePoint.handle('run'));
    ok(await ev(() => __savePoint.state().lastIndex) === lastBefore, '저장 실패 시 기억·위치 그대로');
    await ev(() => { M.failMeta = false; });

    // 16b. every change path restores on a thrown save (review #3)
    r = await ev(async () => {
        const st = __savePoint.state(), sid = st.mem.scenes[0].id, before = st.mem.scenes[0].pin, histLen = st.history.length;
        M.failMeta = true;
        try { await __savePoint.handle('pin', sid); } catch { /* reported */ }
        M.failMeta = false;
        const now = __savePoint.state();
        return { before, after: now.mem.scenes[0].pin, hist: now.history.length === histLen, err: toastr.log.at(-1)[1] };
    });
    ok(r.after === r.before && r.hist, '편집 저장 실패 → 📌 변경과 이력 원복');
    r = await ev(async () => {
        const hiddenBefore = M.chat.filter(m => m.is_system).length;
        M.failMeta = true;
        try { await __savePoint.handle('clear-room'); } catch { /* reported */ }
        M.failMeta = false;
        return { scenes: __savePoint.state().mem.scenes.length, hidden: M.chat.filter(m => m.is_system).length, hiddenBefore };
    });
    ok(r.scenes > 0 && r.hidden === r.hiddenBefore, '기억 비우기 저장 실패 → 기억·하이드 그대로');
    // a save that SillyTavern swallows: the change stays in the page, memory and hide flags together
    await ev(() => { M.add(3); M.swallowMeta = true; });
    await ev(() => __savePoint.handle('run'));
    r = await ev(() => { const st = __savePoint.state(); const cut = Math.min(st.lastIndex, M.chat.length - 11);
        return { last: st.lastIndex, len: M.chat.length, swallowed: M.swallowed, consistent: M.chat.every((m, i) => !!m.is_system === (i <= cut) || !!m.extra?.savepointVisible) }; });
    ok(r.last === r.len - 1 && r.swallowed >= 1 && r.consistent, '조용히 실패한 저장 → 페이지의 기억과 하이드는 같은 상태로 유지 (다음 저장 때 함께 기록)');
    await ev(() => { M.swallowMeta = false; });
    // room switch while a failing save is in flight
    r = await ev(async () => {
        const oldMeta = M.meta, oldChat = M.chat, sid = __savePoint.state().mem.scenes[0].id, pinBefore = __savePoint.state().mem.scenes[0].pin;
        M.metaDelay = 200; M.failMeta = true;
        const p = __savePoint.handle('pin', sid).catch(() => {});
        await new Promise(r => setTimeout(r, 50));
        await M.switchChat('chatD', [], {}); M.add(2);
        await p;
        M.metaDelay = 0; M.failMeta = false;
        const res = { oldPin: oldMeta.savePoint.mem.scenes[0].pin === pinBefore, newState: !!__savePoint.state(), newInj: M.prompts.savepoint?.v || '', newHidden: M.chat.some(m => m.is_system) };
        await M.switchChat('chatC', oldChat, oldMeta);
        return res;
    });
    ok(r.oldPin && !r.newState && r.newInj === '' && !r.newHidden, '저장 중 방 이동 + 실패 → 원래 방만 원복, 새 방은 그대로');

    // 16c. person in the item slot, twice (v0.2.1): nothing saved, retry explains the fix
    r = await ev(async () => {
        M.add(4); M.itemPerson = true;
        const last = __savePoint.state().lastIndex, hid = M.chat.filter(m => m.is_system).length, c0 = M.calls.length;
        await __savePoint.handle('run');
        M.itemPerson = false;
        const retry = M.calls.at(-1);
        return { same: __savePoint.state().lastIndex === last, hid: M.chat.filter(m => m.is_system).length === hid, calls: M.calls.length - c0,
            hint: retry.includes('"entity" is the item itself') && retry.includes('reread the message it cites'), detail: $('.sp-err li').text() };
    });
    ok(r.same && r.hid && r.calls === 2, '물건 자리에 인물 2번 → 구간 저장 안 함, 원문·하이드 그대로');
    ok(r.hint && r.detail.includes('Ari carries the key.'), '재요청에 고치는 방법 포함, 상세에 문제 변경의 내용 표시');
    await ev(() => __savePoint.handle('run'));

    // 17. budget hard cap
    await ev(() => { M.settings.savePoint.budget = 600; __savePoint.refreshInjection(); });
    r = await ev(() => __savePoint.estTokens(M.prompts.savepoint.v));
    ok(r <= 610, `주입 상한 지킴 (${r} 토큰)`);

    // Supporting numbers must never take width away from state text, in any state tab.
    const recordLayoutBefore = await ev(() => ({ mem: structuredClone(__savePoint.state().mem), theme: M.settings.savePoint.theme }));
    const layoutFailures = [], recordThemes = await ev(() => [...document.querySelectorAll('#sp_settings [data-set="theme"] option')].map(x => x.value));
    await ev(() => {
        const mem = __savePoint.state().mem;
        mem.entities.push({ id: 'layout-person', type: 'person', name: 'Courier', aliases: [] },
            { id: 'layout-item', type: 'item', name: "Courier's weatherproof expedition jacket", aliases: [] },
            { id: 'layout-place', type: 'place', name: 'North harbor guest apartment', aliases: [] });
        const common = { text: 'A carefully repaired brass compass still points toward the northern harbor, even when carried through the crowded market. '.repeat(4), msgs: [3, 4, 12, 14, 25, 29], oldEvidence: [{ room: 'example-room', msgs: [48, 49] }], pin: true };
        mem.records.push({ ...common, id: 'layout-party', type: 'party', entity: 'layout-person', aspect: 'condition' },
            { ...common, id: 'layout-item-record', type: 'item', entity: 'layout-item', holder: 'layout-place' },
            { ...common, id: 'layout-world', type: 'world', kind: 'secret', knownBy: ['layout-person'] });
    });
    const recordLayoutSnapshot = await ev(() => ({ mem: JSON.stringify(__savePoint.state().mem), injection: M.prompts.savepoint?.v }));
    for (const width of [360, 390, 560, 1100]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of recordThemes) {
            for (const tab of ['party', 'items', 'world']) {
                const result = await ev(({ theme, tab }) => {
                    M.settings.savePoint.theme = theme; __savePoint.handle('tab', tab);
                    const rows = [...document.querySelectorAll('.sp-record-row')].filter(row => row.textContent.includes('carefully repaired brass compass'));
                    return rows.length === 1 && rows.every(row => {
                        const text = row.querySelector('.sp-rec-t').getBoundingClientRect(), refs = row.querySelector('.sp-evs').getBoundingClientRect();
                        const box = row.getBoundingClientRect();
                        const header = tab === 'items' ? row.closest('.sp-item').querySelector('.sp-item-h') : null;
                        const holder = header?.querySelector('.sp-holder').getBoundingClientRect(), name = header?.querySelector('.sp-ent-n').getBoundingClientRect();
                        const holderAtTop = !header || (Math.abs(holder.top - name.top) <= 1 && holder.left >= name.right + 7 && Math.abs(holder.right - header.getBoundingClientRect().right) <= 1
                            && header.scrollWidth <= header.clientWidth + 1 && text.top >= Math.max(holder.bottom, name.bottom));
                        return holderAtTop && refs.top >= text.bottom - 1 && Math.abs(text.width - row.clientWidth) <= 2 && refs.right <= box.right + 1 && row.scrollWidth <= row.clientWidth + 1
                            && row.querySelector('.sp-evs').title.includes('이전 방') && row.querySelectorAll('.sp-tools button').length === 3;
                    });
                }, { theme, tab });
                if (!result) layoutFailures.push(`${width}/${theme}/${tab}`);
            }
        }
    }
    ok(recordThemes.length > 0 && layoutFailures.length === 0, `상태 본문 전체 너비·하단 근거 번호·긴 물건 이름의 소지자 우측 상단 유지 (${recordThemes.length}개 테마·360–1100px): ${layoutFailures.join(', ') || '정상'}`);
    ok(await ev(before => JSON.stringify(__savePoint.state().mem) === before.mem && M.prompts.savepoint?.v === before.injection, recordLayoutSnapshot), '기록 배치를 바꿔도 기억과 주입은 그대로');
    await ev(before => { __savePoint.state().mem = before.mem; M.settings.savePoint.theme = before.theme; }, recordLayoutBefore);
    await page.setViewportSize({ width: 390, height: 844 });

    if (SHOTS) {
        await ev(() => { M.settings.savePoint.budget = 6000; M.settings.savePoint.showKo = false; __savePoint.refreshInjection(); });
        for (const theme of ['jrpg', 'cream', 'terminal', 'st']) {
            await ev(t => { M.settings.savePoint.theme = t; __savePoint.handle('tab', 'journal'); }, theme);
            await page.screenshot({ path: `${OUT}/m_${theme}.png` });
        }
        await page.setViewportSize({ width: 1100, height: 900 });
        await ev(() => { M.settings.savePoint.theme = 'jrpg'; });
        for (const t of ['journal', 'quests', 'party', 'items', 'world', 'saves', 'inject']) {
            await ev(t => __savePoint.handle('tab', t), t);
            await page.screenshot({ path: `${OUT}/d_${t}.png` });
        }
    }
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
