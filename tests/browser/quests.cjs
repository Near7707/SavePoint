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
    // v0.6.39: found quests (confirm), result banner, accept / decline, untracked list, roles, and the
    // smaller screen fixes of the same version (translation view, party clamp, item groups).
    const page = await session({ settings: { savePoint: { firstTab: 'main', check: false, questMode: 'confirm' } } });
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const banner = () => ev(() => { const b = document.getElementById('sp_save_banner'); return { shown: !b.hidden, text: b.textContent, goto: b.dataset.goto }; });

    // 1. a save finds a quest: the result banner says so; the window is not opened by itself
    await ev(() => { M.add(8, i => i === 5 ? 'PROMISE: I will bring the lantern back tomorrow.' : ''); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    let r = await banner();
    ok(r.shown && r.text.includes('저장 완료') && r.text.includes('❗ 수락 대기 1') && r.goto === 'main-quests', `1. 저장 결과 배너에 수락 대기 퀘스트 (${r.text})`);
    ok(!(await ev(() => __savePoint.ui.open)), '1. 창을 억지로 띄우지 않음');

    // 2. the banner opens 메인 with the found list unfolded: summary, why (quote), accept / decline
    await page.click('#sp_save_banner');
    await page.waitForTimeout(300);
    r = await ev(() => ({ tab: $('.sp-tab.sp-active').attr('data-id'), open: $('details[data-group="main-quests"]').prop('open'), cand: $('.sp-qcand').first().text(), badge: $('.sp-tab[data-id="main"] em').text(), q: $('.sp-st-q').length, qtab: $('.sp-tab[data-id="quests"] em').text() }));
    ok(r.tab === 'main' && r.open && /근거 #5/.test(r.cand) && r.cand.includes('“PROMISE: I will bring th'), `2. 배너 → 메인, 후보 카드에 근거 원문 (${r.cand.replace(/\s+/g, ' ').trim()})`);
    ok(r.badge === '1' && r.q === 0 && !r.qtab, '2. 수락 전에는 진행 중 목록·퀘스트 탭 숫자에 없음');

    // 3. while waiting, the story finishes it: the card says so; accepting lists it as done
    const qid = await ev(() => __savePoint.state().mem.records.find(r => r.type === 'quest').id);
    await ev(id => { M.add(2); M.addChanges = () => ({ changes: [{ op: 'update', id, status: 'done', msgs: [M.chat.length - 1] }] }); }, qid);
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await ev(() => $('.sp-qcand').first().text());
    ok(r.includes('이미 완료'), '3. 대기 중에 이야기에서 지켜지면 후보도 이미 완료');
    await ev(id => __savePoint.handle('quest-accept', id), qid);
    await ev(() => __savePoint.handle('tab', 'quests'));
    r = await ev(id => ({ track: __savePoint.state().mem.records.find(r => r.id === id).track, done: $('.sp-q-done').text() }), qid);
    ok(r.track === undefined && r.done.includes('Promise made at 5'), '3. 수락하면 완료 목록에 (진행 중으로 새로 시작하지 않음)');

    // 4. decline = not tracked: out of the list and the injection, kept in a folded list, can come back
    await ev(() => { const b = M.chat.length; M.add(3, i => i === b + 1 ? 'PROMISE: I will buy you bread.' : ''); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    const q2 = await ev(() => __savePoint.state().mem.records.filter(r => r.type === 'quest').at(-1).id);
    await ev(id => __savePoint.handle('quest-decline', id), q2);
    await ev(() => __savePoint.refreshInjection());
    r = await ev(id => ({ track: __savePoint.state().mem.records.find(r => r.id === id).track, list: $('details[data-group="quests-declined"] summary').text(), inj: __savePoint.ui.inj?.text || '' }), q2);
    ok(r.track === 'declined' && r.list.includes('추적하지 않는 퀘스트 1'), '4. 거절 → 추적하지 않는 퀘스트로');
    ok(!new RegExp(`Promise made at ${await ev(id => __savePoint.state().mem.records.find(r => r.id === id).text.match(/\d+/)[0], q2)}`).test(r.inj), '4. 거절한 퀘스트는 주입에서 빠짐');
    await ev(id => __savePoint.handle('quest-accept', id), q2);
    ok((await ev(id => __savePoint.state().mem.records.find(r => r.id === id).track, q2)) === undefined, '4. 다시 추적');

    // 5. roles: "Ari → 나" on the card; editable
    await ev(id => { const st = __savePoint.state(); const r = st.mem.records.find(x => x.id === id); const ari = st.mem.entities.find(e => e.name === 'Ari'); st.mem.entities.push({ id: 'e90', type: 'person', name: 'Me', aliases: [] }); r.by = [ari.id]; r.to = ['e90']; __savePoint.render(true); }, q2);
    r = await ev(() => $('.sp-q-open .sp-role').first().text());
    ok(r === 'Ari → 나', `5. 약속 방향 표시, 사용자 페르소나는 나 (${r})`);
    await ev(id => __savePoint.handle('edit-rec', id), q2);
    r = await ev(() => ({ by: $('[data-edit="by"]').val(), to: $('[data-edit="to"]').val() }));
    ok(r.by && r.to === 'e90', '5. 편집 창에 지킬 사람·받는 사람');
    await ev(() => __savePoint.handle('edit-cancel'));

    // 6. auto mode lists new quests straight away; the banner says 자동 수락
    await ev(() => { M.settings.savePoint.questMode = 'auto'; const b = M.chat.length; M.add(3, i => i === b + 1 ? 'PROMISE: we meet at dawn.' : ''); $('#sp_overlay .sp-window').length && __savePoint.handle('close'); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    r = await banner();
    ok(r.text.includes('❗ 자동 수락 1') && r.goto === 'main-changes', `6. 자동 등록: 배너에 자동 수락 (${r.text})`);

    // 7. (fix) going back to 원문 during a translation keeps 원문 when it finishes
    await ev(() => { $('#sp_wand').trigger('click'); for (const r of __savePoint.state().mem.records) delete r.ko; M.delay = 800; });
    const tr = ev(() => __savePoint.handle('lang'));
    await page.waitForTimeout(200);
    await ev(() => __savePoint.handle('lang'));
    await tr; await ev(() => { M.delay = 0; });
    ok(!(await ev(() => __savePoint.settings().showKo)), '7. 번역 중 원문으로 바꾸면 끝나도 원문 유지');

    // 8. (fix) 메인: party cards are clamped and open on tap; items are grouped per holder
    await ev(() => { const st = __savePoint.state(); const ari = st.mem.entities.find(e => e.name === 'Ari');
        st.mem.records.push({ id: 'r900', type: 'party', entity: ari.id, aspect: 'condition', text: 'A very long condition. '.repeat(12), src: [], msgs: [], pin: false },
            { id: 'r901', type: 'item', entity: 'e91', holder: ari.id, text: 'A brass key on a red cord.', src: [], msgs: [], pin: false },
            { id: 'r902', type: 'item', entity: 'e92', holder: ari.id, text: 'A folded map of the harbor.', src: [], msgs: [], pin: false });
        st.mem.entities.push({ id: 'e91', type: 'item', name: 'Brass key', aliases: [] }, { id: 'e92', type: 'item', name: 'Harbor map', aliases: [] });
        st.mem.scenes.at(-1).who = [ari.id];
        __savePoint.handle('tab', 'main'); });
    r = await ev(() => { const c = $('.sp-st-p .c')[0]; return { clamp: getComputedStyle(c).webkitLineClamp, h: c.clientHeight, sh: c.scrollHeight }; });
    ok(r.clamp === '3' && r.sh > r.h, `8. 파티 상태는 3줄까지 (${JSON.stringify(r)})`);
    await page.click('.sp-st-p');
    r = await ev(() => { const c = $('.sp-st-p .c')[0]; return { full: $('.sp-st-p').hasClass('full'), h: c.clientHeight, sh: c.scrollHeight }; });
    ok(r.full && r.sh <= r.h + 1, '8. 누르면 전부 보임');
    r = await ev(() => ({ who: $('.sp-st-items .grp .who').first().text(), items: $('.sp-st-items .grp').first().find('.it').length }));
    ok(r.who.startsWith('Ari') && r.items === 2, `8. 아이템은 사람마다 묶음, 한 줄에 하나 (${r.who})`);

    // 9. (v0.6.40) a scene prop put away by the story shows as 자동 보관 · 정리됨; two keepers are not "서로"
    await ev(() => { const st = __savePoint.state(); st.mem.records.push({ id: 'r910', type: 'item', entity: 'e91', holder: null, text: 'Half a teapot left on the table.', src: [], msgs: [], pin: false });
        const rid = 'r910'; M.add(2); M.addChanges = () => ({ changes: [{ op: 'update', id: rid, text: 'Tea time is over; half a teapot is left.', retire: true, msgs: [M.chat.length - 1] }] }); });
    await ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(1200);
    await ev(() => { __savePoint.ui.savesOpen.set('itembox', true); __savePoint.handle('tab', 'items'); });
    r = await ev(() => ({ stored: __savePoint.state().mem.records.find(x => x.id === 'r910').stored, badge: $('.sp-box .sp-badge').map((i, e) => e.textContent).get().join('|') }));
    ok(r.stored?.reason === 'retired' && r.badge.includes('자동 보관 · 정리됨'), `9. 정리된 소품은 자동 보관 · 정리됨 (${r.badge})`);
    r = await ev(id => { const st = __savePoint.state(); const q = st.mem.records.find(x => x.id === id); q.to = undefined; delete q.to; q.by = [st.mem.entities.find(e => e.name === 'Ari').id, 'e90']; __savePoint.handle('tab', 'quests'); const a = $('.sp-q-open .sp-role').first().text(); q.mutual = true; __savePoint.render(true); return [a, $('.sp-q-open .sp-role').first().text()]; }, q2);
    ok(r[0] === 'Ari · 나' && r[1] === 'Ari · 나 서로', `9. 여러 명이 지킬 약속은 서로 표시가 있을 때만 서로 (${r.join(' / ')})`);

    // 10. (v0.6.43) a choice shows at once even while the chat file is still being written
    await ev(() => { __savePoint.handle('tab', 'party'); M.metaDelay = 1200; });
    const ari = await ev(() => __savePoint.state().mem.entities.find(e => e.name === 'Ari').id);
    const pending = ev(id => __savePoint.handle('person-mode', id + '|standby'), ari);
    await page.waitForTimeout(150);
    r = await ev(() => ({ on: $('.sp-party-mode .sp-on').map((i, e) => e.textContent).get(), saving: M.saves }));
    await pending; await ev(() => { M.metaDelay = 0; });
    ok(r.on.includes('대기'), `10. 저장이 끝나기 전에 화면에 선택 반영 (${r.on.join(',')})`);
    r = await ev(() => $('.sp-party-mode').first().find('.sp-on').length);
    ok(r === 1, '10. 한 사람에 선택 표시는 하나');

    // 11. (v0.6.44) an earlier write that fails late never undoes a later choice that was written
    const qid11 = await ev(() => __savePoint.state().mem.records.find(r => r.type === 'quest').id);
    const ent11 = await ev(() => __savePoint.state().mem.entities.find(e => e.name === 'Ari').id);
    await ev(() => { __savePoint.handle('tab', 'quests'); M.metaDelay = 600; M.failOnce = true; });
    const first = ev(id => __savePoint.handle('person-mode', id + '|exclude').then(() => 'ok', e => 'fail:' + e.message), ent11);   // fails late
    await page.waitForTimeout(100);
    const second = ev(id => __savePoint.handle('pin-rec', id).then(() => 'ok', e => 'fail:' + e.message), qid11);              // written after
    const [a, b2] = [await first, await second];
    await ev(() => { M.metaDelay = 0; });
    r = await ev(([q, e]) => { const st = __savePoint.state(); const saved = JSON.parse(JSON.stringify(M.meta.savePoint));
        return { pin: st.mem.records.find(x => x.id === q).pin, mode: st.mem.entities.find(x => x.id === e).standby, savedPin: saved.mem.records.find(x => x.id === q).pin, savedMode: saved.mem.entities.find(x => x.id === e).standby }; }, [qid11, ent11]);
    ok(r.pin === true && r.mode !== 'exclude', `11. 앞 저장 실패: 그 변경만 취소, 뒤의 ⚓는 남음 (${JSON.stringify(r)} · ${a} · ${b2})`);
    r = await ev(([q, e]) => { const f = M.serverChat?.[0]?.chat_metadata?.savePoint; return f ? { pin: f.mem.records.find(x => x.id === q).pin, mode: f.mem.entities.find(x => x.id === e).standby } : null; }, [qid11, ent11]);
    ok(r && r.pin === true && r.mode !== 'exclude', `11. 파일과 화면이 같음 (${JSON.stringify(r)})`);

    // 12–14. (v0.6.45) review: same toggle twice, a later write that already held the last change, a room move
    const pt = await ev(() => { const sc = __savePoint.state().mem.scenes[0], g = sc.segs[0]; return { id: `${sc.id}|${g.id}|0`, sid: sc.id }; });
    const keyOf = () => ev(p => { const [s, g, j] = p.split('|'); const pp = __savePoint.state().mem.scenes.find(x => x.id === s).segs.find(x => x.id === g).points[+j]; return { user: pp.keyUser, key: pp.key }; }, pt.id);
    const fileKey = () => ev(p => { const [s, g, j] = p.split('|'); const f = M.serverChat?.[0]?.chat_metadata?.savePoint; const pp = f.mem.scenes.find(x => x.id === s).segs.find(x => x.id === g).points[+j]; return { user: pp.keyUser, key: pp.key }; }, pt.id);
    const k0 = await keyOf();
    await ev(() => { M.metaDelay = 500; M.failOnce = true; });
    const t1 = ev(id => __savePoint.handle('key-toggle', id).then(() => 'ok', e => 'fail'), pt.id);
    await page.waitForTimeout(80);
    const t2 = ev(id => __savePoint.handle('key-toggle', id).then(() => 'ok', e => 'fail'), pt.id);
    await t1; await t2; await ev(() => { M.metaDelay = 0; });
    let k1 = await keyOf(), kf = await fileKey();
    const on = x => (x.user ?? x.key) === true;
    ok(on(k1) === on(k0) && on(kf) === on(k0), `12. ○→●→○에서 첫 저장 실패: 마지막 선택(○) 유지, 파일도 같음 (${JSON.stringify([k0, k1, kf])})`);

    await ev(() => { M.metaDelay = 400; });
    const a1 = ev(id => __savePoint.handle('key-toggle', id), pt.id);
    await page.waitForTimeout(60);
    const a2 = ev(id => __savePoint.handle('pin-rec', id), qid11);
    const a3 = ev(sid => __savePoint.handle('star', sid), pt.sid);
    await page.waitForTimeout(30);
    await ev(() => { M.failOnce = true; });   // would hit the write after the one that already held ★
    await a1.catch(() => {}); await a2.catch(() => {}); await a3.catch(() => {});
    await ev(() => { M.metaDelay = 0; M.failOnce = false; });
    r = await ev(([sid, q]) => { const st = __savePoint.state(), f = M.serverChat[0].chat_metadata.savePoint;
        return { star: !!st.mem.scenes.find(x => x.id === sid).star, fileStar: !!f.mem.scenes.find(x => x.id === sid).star, pin: st.mem.records.find(x => x.id === q).pin, filePin: f.mem.records.find(x => x.id === q).pin }; }, [pt.sid, qid11]);
    ok(r.star === r.fileStar && r.pin === r.filePin, `13. 연속 ●·⚓·★ 뒤 실패가 와도 화면과 파일이 같음 (${JSON.stringify(r)})`);

    const roomA = await ev(() => ({ id: M.chatId, chat: M.chat, meta: M.meta }));
    await ev(() => { M.metaDelay = 400; M.saveCalls = 0; });
    const m1 = ev(id => __savePoint.handle('key-toggle', id).then(() => 'ok', e => 'fail'), pt.id);
    await page.waitForTimeout(60);
    const m2 = ev(q => __savePoint.handle('pin-rec', q).then(() => 'ok', e => 'fail:' + e.message), qid11);
    await page.waitForTimeout(30);
    await ev(() => M.switchChat('roomQ', [], {}));
    const [o1, o2] = [await m1, await m2];
    await ev(() => { M.metaDelay = 0; });
    r = await ev(() => ({ bMeta: JSON.stringify(M.meta) }));
    ok(o2.startsWith('fail:채팅방을 옮겨서') && !r.bMeta.includes('savePoint'), `14. 방을 옮긴 뒤 이전 방의 대기 저장은 새 방을 저장하지 않고 알림 (${o1} · ${o2.slice(0, 40)})`);
    await ev(a => M.switchChat(a.id, a.chat, a.meta), roomA);

    // 15–17. (v0.6.46) replays address items by id; a gone target stops the replay; the file stays valid
    const setup = () => ev(() => { const st = __savePoint.state();
        for (const id of ['r950', 'r951']) if (!st.mem.records.some(x => x.id === id)) st.mem.records.push({ id, type: 'quest', kind: 'goal', status: 'open', who: [], text: `Thread ${id}.`, src: [], msgs: [], pin: false, questEvents: { created: null } });
        for (const x of st.mem.records) if (['r950', 'r951'].includes(x.id)) x.pin = false;
        __savePoint.render(true); });
    const both = () => ev(() => { const st = __savePoint.state(), f = M.serverChat[0].chat_metadata.savePoint;
        const pick = m => ['r950', 'r951'].map(id => { const x = m.records.find(r => r.id === id); return x ? (x.pin ? 'pin' : 'on') : 'gone'; }).join(',');
        return { page: pick(st.mem), file: pick(f.mem) }; });
    const slowFail = () => ev(() => { M.metaDelay = 400; M.failOnce = true; });
    const settle = async (...ps) => { for (const p of ps) await p.catch(() => {}); await ev(() => { M.metaDelay = 0; M.failOnce = false; }); };
    await setup(); await ev(() => __savePoint.handle('pin-rec', 'r950').then(() => __savePoint.handle('pin-rec', 'r950')));   // write the setup once
    await slowFail();
    let p1 = ev(() => __savePoint.handle('del-rec', 'r950')); await page.waitForTimeout(60);
    let p2 = ev(() => __savePoint.handle('pin-rec', 'r951'));
    await settle(p1, p2); r = await both();
    ok(r.page === 'on,pin' && r.file === r.page, `15. A 삭제 실패 + B ⚓: ⚓는 B에, A는 되돌아옴 (${JSON.stringify(r)})`);
    await setup(); await ev(() => __savePoint.handle('pin-rec', 'r951').then(() => __savePoint.handle('pin-rec', 'r951')));
    await slowFail();
    p1 = ev(() => __savePoint.handle('pin-rec', 'r950')); await page.waitForTimeout(60);
    p2 = ev(() => __savePoint.handle('del-rec', 'r951'));
    await settle(p1, p2); r = await both();
    ok(r.page === 'on,gone' && r.file === r.page, `16. A ⚓ 실패 + B 삭제: 실패한 ⚓는 되살아나지 않음 (${JSON.stringify(r)})`);
    await slowFail();
    p1 = ev(async () => { __savePoint.handle('add-rec', 'quest'); __savePoint.ui.edit.values.text = 'A brand new thread.'; return __savePoint.handle('edit-save'); }); await page.waitForTimeout(60);
    const newId = await ev(() => __savePoint.state().mem.records.find(x => x.text === 'A brand new thread.')?.id);
    p2 = ev(id => __savePoint.handle('pin-rec', id), newId);
    await settle(p1, p2);
    r = await ev(() => { const f = M.serverChat[0].chat_metadata.savePoint; const bad = f.mem.records.some(x => Array.isArray(x) || !x || !x.type);
        return { bad, pageHas: __savePoint.state().mem.records.some(x => x.text === 'A brand new thread.'), fileHas: f.mem.records.some(x => x.text === 'A brand new thread.') }; });
    ok(newId && !r.bad && !r.pageHas && !r.fileHas, `17. 추가 실패 + 그 항목 ⚓: 없는 자리를 만들지 않고 취소, 파일 형식 유지 (${JSON.stringify(r)})`);
    if (SHOTS) await page.locator('#sp_overlay .sp-window').screenshot({ path: path.join(OUT, 'quests-main.png') });

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
