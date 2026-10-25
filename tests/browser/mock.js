// Mock SillyTavern context for SavePoint.
window.toastr = { log: [] };
for (const k of ['info', 'success', 'warning', 'error']) window.toastr[k] = m => window.toastr.log.push([k, String(m)]);
const listeners = {};
const eventSource = { on(t, f) { (listeners[t] ??= []).push(f); }, async emit(t, ...a) { for (const f of listeners[t] || []) await f(...a); } };
const event_types = {
    CHAT_CHANGED: 'chat_id_changed', MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited', MESSAGE_DELETED: 'message_deleted', MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_UPDATED: 'message_updated', MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
    GENERATION_STARTED: 'generation_started', GENERATION_ENDED: 'generation_ended', GENERATION_STOPPED: 'generation_stopped',
};
const M = window.M = { files: new Map(Object.entries(window.__presetFiles || {})), fileLog: [], serverDown: !!window.__presetServerDown, chatId: 'chatA', chat: [], meta: {}, settings: window.__presetSettings || {}, prompts: {}, calls: [], popupInput: 'Save', confirm: 1, eventSource, event_types, chatSaves: 0 };

function fake(prompt) {
    if (prompt.startsWith('Translate')) {
        const items = JSON.parse(prompt.slice(prompt.indexOf('Items:\n') + 7));
        return JSON.stringify(items.map(x => ({ id: x.id, ko: '한국어: ' + x.text.slice(0, 15) })));
    }
    if (prompt.startsWith('You are checking the memory')) {
        M.checkCalls = (M.checkCalls || 0) + 1; M.lastCheck = prompt;
        if (M.checkBad) return 'not json at all';
        if (typeof M.checkReply === 'function') return JSON.stringify(M.checkReply(prompt));
        if (M.checkUnclear) {
            const rid = (prompt.split('[RECORDS]')[1].match(/^(r\d+): /m) || [])[1];
            const sg = (prompt.split('[JOURNAL]')[1].match(/^(g\d+): /m) || [])[1];
            return JSON.stringify({ issues: [{ about: rid, also: sg, kind: 'unclear', problem: 'The record and the outline disagree.', conflict: ['one', 'two'], msgs: [] }] });
        }
        if (!M.checkIssues) return JSON.stringify({ issues: [] });
        const seg = (prompt.split('[JOURNAL]')[1].match(/^(g\d+): /m) || [])[1];
        const msg = Number((prompt.split('[ORIGINAL MESSAGES]')[1].match(/^#(\d+) /m) || [])[1]);
        return JSON.stringify({ issues: [{ about: seg, kind: 'misread', problem: 'The outline turns a joke into a debt.', conflict: ['so Theo owes the dishes', 'The one who loses washes. The one who wins dries.'], msgs: [msg] }, { about: 'zz9', problem: 'unknown id, dropped' }] });
    }
    if (prompt.startsWith('You are tidying the memory')) {
        M.rekeyCalls = (M.rekeyCalls || 0) + 1;
        const ids = [...prompt.split('[POINTS]')[1].matchAll(/^(g\d+\.\d+): /gm)].map(m => m[1]);
        return JSON.stringify({ keys: Object.fromEntries(ids.map((id, i) => [id, i === 0])) });
    }
    if (prompt.startsWith('You are marking scene boundaries')) {
        M.bCalls = (M.bCalls || 0) + 1; M.lastBoundary = prompt;
        const sec2 = prompt.split(/\[NEW MESSAGES\][^\n]*\n/)[1].split('\n\nReturn ONLY')[0];
        const ms = [...sec2.matchAll(/^#(\d+) ([^:]+): (.*)$/gm)].map(m => ({ n: Number(m[1]), text: m[3] }));
        const open = !/\[OPEN SCENE\][^\n]*\n\(none\)/.test(prompt);
        const starts = [ms[0].n, ...ms.filter((m, i) => i > 0 && m.text.includes('SCENEBREAK')).map(m => m.n)];
        const scenes = starts.map((st, i) => ({ start: st, label: 'x', ended: i < starts.length - 1 }));
        if (M.bBadOnce && !prompt.includes('REJECTED')) scenes.push({ start: 99999, ended: false });
        if (M.bBad) scenes.push({ start: 99999, ended: false });
        return JSON.stringify({ continues_open_scene: open && !ms[0].text.includes('SCENEBREAK'), scenes });
    }
    const sec = prompt.split(/\[NEW MESSAGES\][^\n]*\n/)[1].split('\n\nReturn ONLY')[0];
    const msgs = [...sec.matchAll(/^#(\d+) ([^:]+): (.*)$/gm)].map(m => ({ n: Number(m[1]), name: m[2], text: m[3] }));
    const hasOpen = !/\[OPEN SCENE\][^\n]*\n\(none\)/.test(prompt);
    const known = prompt.split('[KNOWN ENTITIES]\n')[1].split('\n\n')[0];
    const ariId = (known.match(/^(e\d+) person: Ari/m) || [])[1];
    const isRetry = prompt.includes('YOUR PREVIOUS REPLY WAS REJECTED');
    const first = msgs[0].n, last = msgs[msgs.length - 1].n;
    const breaks = msgs.filter(m => m.text.includes('SCENEBREAK') && m.n !== first).map(m => m.n);
    const starts = [first, ...breaks];
    const scenes = starts.map((st, i) => {
        const end = i + 1 < starts.length ? starts[i + 1] - 1 : last;
        const inScene = msgs.filter(m => m.n >= st && m.n <= end);
        return {
            scene: i === 0 && hasOpen && !M.forceNew && !msgs[0].text.includes('SCENEBREAK') ? 'continue' : 'new', ...(i ? { start: st } : {}),
            title: `Scene from ${st}`, where: 'Rail Street', who: [ariId || 'ari'],
            points: [{ text: `Something happened at ${inScene[0].n}.`, kind: 'moment', key: false, msgs: [inScene[0].n] },
                     ...inScene.filter(m => m.text.includes('GIFT')).map(m => ({ text: `Ari received a gift at ${m.n}.`, kind: 'change', key: true, msgs: [m.n] }))],
            notes: `Detailed notes about messages ${st}-${end}.`,
            outline: `Things happened between ${st} and ${end}.`, ended: false, star: false,
        };
    });
    const openIds = [...(prompt.split('[OPEN SCENE]')[1] || '').split('[RECENT SCENES]')[0].matchAll(/^(g\d+\.\d+): /gm)].map(m => m[1]);
    if (scenes[0].scene === 'continue' && !M.noKeys) scenes[0].keys = Object.fromEntries(openIds.map(id => [id, false]));
    if (M.firstContinue) scenes[0].scene = 'continue';
    if (M.laterContinue && scenes[1]) scenes[1].scene = 'continue';
    if (M.korean && !isRetry) scenes[0].outline = '아리와 함께 거리를 걸었다. 많은 일이 있었다.';
    if (M.failAt !== undefined && msgs.some(m => m.n === M.failAt)) scenes[0].points[0].msgs = [99999];
    if (M.badOnce && !isRetry) scenes[0].points[0].msgs = [first - 1000];
    const data = { checklist: { promises: 'none' }, scenes,
        entities: ariId ? [] : [{ ref: 'ari', type: 'person', name: 'Ari', aliases: ['아리'] }],
        changes: msgs.filter(m => m.text.includes('PROMISE')).map(m => ({ op: 'add', type: 'quest', kind: 'promise', who: [ariId || 'ari'], text: `Promise made at ${m.n}.`, ...(M.noTerms ? {} : { terms: { msg: m.n, quote: M.badQuote && !isRetry ? 'words nobody said at all' : m.text.slice(0, 24) } }), msgs: M.promiseRange ? [first, m.n] : [m.n] })) };
    if (M.manyPoints) for (const sc of scenes) {
        const st0 = sc.start ?? first;
        const ins = msgs.filter(m => m.n >= st0 && (scenes[scenes.indexOf(sc) + 1]?.start ?? Infinity) > m.n);
        sc.points.push(...ins.map(m => ({ text: `Detail at ${m.n}.`, kind: 'moment', key: false, msgs: [m.n] })));
        const pr = ins.find(m => m.text.includes('PROMISE'));
        if (pr) sc.points.push({ text: `The game leading to the promise.`, kind: 'change', key: true, msgs: ins.filter(m => m.n >= pr.n - 3 && m.n <= pr.n).map(m => m.n) });
    }
    if (M.bareNames) {
        for (const sc of scenes) sc.who = ['Ari'];
        for (const c of data.changes) if (c.who) c.who = ['ARI'];
    }
    if (M.itemPerson) data.changes.push({ op: 'add', type: 'item', entity: ariId || 'ari', text: 'Ari carries the key.', msgs: [first] });
    return '<think>hmm</think>\n```json\n' + JSON.stringify(data) + '\n```';
}
window.SillyTavern = {
    getContext: () => ({
        extensionSettings: M.settings, saveSettingsDebounced() { M.settingsSaves = (M.settingsSaves || 0) + 1; },
        getCurrentChatId: () => M.chatId,
        characters: [{ avatar: 'ari.png', name: 'Ari', description: 'Ari is a courier with green hair.' }], characterId: 0, groups: [],
        name1: 'Me', name2: 'Ari',
        get chat() { return M.chat; }, get chatMetadata() { return M.meta; },
        async saveMetadata() { if (M.metaDelay) await new Promise(r => setTimeout(r, M.metaDelay)); if (M.failMeta) throw new Error('disk full'); if (M.swallowMeta) { M.swallowed = (M.swallowed || 0) + 1; return; } M.saves = (M.saves || 0) + 1; },
        async saveChat() { M.chatSaves++; },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
        setExtensionPrompt(k, v, p, d, s, r) { M.prompts[k] = { v, p, d, r }; },
        eventSource, event_types,
        async generateRaw({ prompt }) { M.calls.push(prompt); if (M.throwNext) { const e = M.throwNext; M.throwNext = null; throw e; } if (M.badJson && !prompt.startsWith('You are checking')) return 'Sure! Here is the summary: {not json'; if (M.delay) await new Promise(r => setTimeout(r, M.delay)); if (M.delayOnce) { const d = M.delayOnce; M.delayOnce = 0; await new Promise(r => setTimeout(r, d)); M.lateDone = (M.lateDone || 0) + 1; } return fake(prompt); },
        callGenericPopup: async (text, type) => (type === 3 ? M.popupInput : M.confirm),
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3 },
    }),
};
M.add = (n, fn) => {
    for (let i = 0; i < n; i++) {
        const idx = M.chat.length, user = idx % 2 === 1;
        M.chat.push({ name: user ? 'Me' : 'Ari', is_user: user, is_system: false, mes: (fn ? fn(idx) : '') || `Message ${idx} from ${user ? 'Me' : 'Ari'} about the day ${'and more '.repeat(10)}.`, swipe_id: 0, extra: {} });
    }
};
M.switchChat = async (id, chatArr, meta) => { M.chatId = id; M.chat = chatArr; M.meta = meta; await eventSource.emit('chat_id_changed'); };

// Fake SillyTavern files API (/api/files/upload|delete|verify, /user/files/<name>).
const realFetch = window.fetch;
const fromB64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const res = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    if (!u.startsWith('/api/files/') && !u.startsWith('/user/files/')) return realFetch(url, opts);
    if (M.serverDown) return res('down', 503);
    if (u === '/api/files/upload') {
        const b = JSON.parse(opts.body);
        if (!/^[a-zA-Z0-9_\-.]+$/.test(b.name)) return res('bad name', 400);
        if (M.failFile && b.name.includes(M.failFile)) return res('fail', 500);
        M.files.set(b.name, fromB64(b.data)); M.fileLog.push(['put', b.name]);
        return res({ path: 'user/files/' + b.name });
    }
    if (u === '/api/files/delete') {
        const name = JSON.parse(opts.body).path.replace('user/files/', '');
        if (!M.files.has(name)) return res('nf', 404);
        M.files.delete(name); M.fileLog.push(['del', name]); return res('ok');
    }
    if (u === '/api/files/verify') {
        const urls = JSON.parse(opts.body).urls;
        return res(Object.fromEntries(urls.map(x => [x, M.files.has(x.replace('user/files/', ''))])));
    }
    const name = u.slice('/user/files/'.length).split('?')[0];
    return M.files.has(name) ? res(M.files.get(name)) : res('nf', 404);
};
