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
    // A streaming connection profile: reasoning arrives in pieces, then the JSON body.
    await ev(() => {
        M.settings.connectionManager = { profiles: [{ id: 'p', name: 'Stream test', mode: 'cc' }] };
        Object.assign(M.settings.savePoint, { profileId: 'p', requestStream: true, timeoutSec: 5, timeoutTotalMin: 20, check: false, hudOpen: true });
        M.cm = { async sendRequest(id, payload, max, opts) {
            const prompt = payload[0].content; M.calls.push(prompt);
            const plan = M.streamPlan;
            return async function* () {
                let thought = '';
                for (const step of plan) {
                    if (step === 'stall') await new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
                    await new Promise(r => setTimeout(r, step));
                    thought += 'thinking ';
                    yield { text: '', state: { reasoning: thought } };
                }
                yield { text: fake(prompt), state: { reasoning: thought } };
            };
        } };
        M.add(6); $('#sp_wand').trigger('click');
    });

    // 1. thinking for longer than the wait limit is fine while new output keeps arriving
    await ev(() => { M.streamPlan = [1500, 1500, 1500, 1500, 1500]; });
    const p1 = ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(3200);
    let r = await ev(() => $('.sp-progress').text());
    ok(/수신 중 .*사고 [\d,]+자.*대기 5초 · 출력 중 연장 · 최대 20분/.test(r), `1. 진행 표시에 제한 방식 (${r.trim()})`);
    r = await ev(() => ['eggpet', 'dualwhite', 'pastel', 'gingerbread', 'xmasknit'].map(t => {
        const w = document.querySelector('#sp_overlay .sp-window'); w.setAttribute('data-theme', t);
        const run = w.querySelector('.sp-actions [data-act="run"]'), stop = w.querySelector('.sp-actions [data-act="stop"]');
        return [t, stop && Math.abs(stop.getBoundingClientRect().top - run.getBoundingClientRect().top) < 2 && stop.scrollWidth <= stop.clientWidth + 1];
    }));
    ok(r.every(x => x[1]), `1. 폭 390에서 중지 버튼이 모든 테마에서 같은 줄 끝 (${r.filter(x => !x[1]).map(x => x[0]).join(',') || 'ok'})`);
    await p1;
    r = await ev(() => ({ last: __savePoint.state().lastIndex, req: __savePoint.ui.lastRequest }));
    ok(r.last === 5 && r.req.status === 'received' && r.req.ms > 7000, `1. 대기 제한(5초)보다 오래 사고해도 출력이 이어지면 저장 (${Math.round(r.req.ms / 100) / 10}초)`);

    // 2. output that stops: cut after the wait limit, with its own reason
    await ev(() => { M.streamPlan = [300, 'stall']; M.add(3); });
    const t0 = Date.now();
    await ev(() => __savePoint.handle('run'));
    const took = Date.now() - t0;
    r = await ev(() => ({ last: __savePoint.state().lastIndex, err: $('.sp-err').text(), toast: toastr.log.map(x => x[1]).pop(), report: __savePoint.reportText(__savePoint.state()) }));
    ok(r.last === 5 && took > 5000 && took < 9000, `2. 새 출력이 멈추면 대기 제한 뒤 취소, 저장 안 함 (${Math.round(took / 100) / 10}초)`);
    ok(r.toast.includes('마지막 출력 뒤 5초 동안 새 출력이 없었어요') && r.err.includes('새 출력 없음 → 대기 제한으로 취소'), `2. 이유: 새 출력 없음 (${r.toast})`);
    ok(r.report.includes('시간 제한: 새 출력 대기 5초 · 전체 최대 20분') && r.report.includes('중단 이유: 새 출력 없음'), '2. 결과 복사에 제한 방식과 중단 이유');

    // 3. no live progress (main API): one limit for the whole request, shown as such
    await ev(() => { M.settings.savePoint.profileId = ''; M.settings.savePoint.timeoutSec = 300; M.delay = 1500; });
    const p3 = ev(() => __savePoint.handle('run'));
    await page.waitForTimeout(700);
    r = await ev(() => $('.sp-progress').text());
    ok(/응답 대기 \d초 · 전체 제한 5분/.test(r), `3. 실시간 수신이 없으면 전체 제한으로 표시 (${r.trim()})`);
    await p3;
    await ev(() => { M.delay = 0; });

    await page.close();
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    await browser.close(); srv.close();
    process.exit(failures ? 1 : 0);
})();
