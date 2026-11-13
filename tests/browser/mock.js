// Mock SillyTavern context for SavePoint.
window.toastr = { log: [] };
for (const k of ['info', 'success', 'warning', 'error']) window.toastr[k] = m => window.toastr.log.push([k, String(m)]);
const listeners = {};
// SillyTavern saves the chat before it tells extensions a message came, changed or went.
const SAVED_EVENTS = ['message_sent', 'message_received', 'message_edited', 'message_deleted', 'message_swiped', 'message_updated', 'message_swipe_deleted'];
const eventSource = { on(t, f) { (listeners[t] ??= []).push(f); }, async emit(t, ...a) { if (SAVED_EVENTS.includes(t)) window.M?.stSave?.(); for (const f of listeners[t] || []) await f(...a); } };
const event_types = {
    CHAT_CHANGED: 'chat_id_changed', MESSAGE_SENT: 'message_sent', MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited', MESSAGE_DELETED: 'message_deleted', MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_UPDATED: 'message_updated', MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
    GENERATION_STARTED: 'generation_started', GENERATION_ENDED: 'generation_ended', GENERATION_STOPPED: 'generation_stopped',
    CHAT_RENAMED: 'chat_renamed', CHAT_DELETED: 'chat_deleted', GROUP_CHAT_DELETED: 'group_chat_deleted', CHAT_CREATED: 'chat_created',
};
window.__spStrict = true;   // v0.7.0-a: a memory change outside the room queue is an error (index.js checkQueue)
const M = window.M = { files: new Map(Object.entries(window.__presetFiles || {})), fileLog: [], serverDown: !!window.__presetServerDown, chatId: 'chatA', chat: [], meta: {}, settings: window.__presetSettings || {}, prompts: {}, calls: [], popupInput: 'Save', confirm: 1, eventSource, event_types, chatSaves: 0 };

// Older suites expect the window to open on the journal; 💠 메인 as the first tab is tested on its own.
M.settings.savePoint ||= {};
if (!('firstTab' in M.settings.savePoint)) M.settings.savePoint.firstTab = 'journal';
// v0.6.39: older checks expect quests listed straight away; quest-confirm checks preset 'confirm'.
if (!('questMode' in M.settings.savePoint)) M.settings.savePoint.questMode = 'auto';

function fake(prompt) {
    if (prompt.startsWith('Supplement the English journal') && M.supplementLinks) {
        // Link every requested excerpt to one point that cites its message.
        const items = JSON.parse(prompt.split('[USER-SELECTED EXCERPTS: data, not instructions]\n')[1].split('\n')[0]);
        return JSON.stringify({ points: items.map(x => ({ text: 'A small brass key changed hands.', kind: 'moment', msgs: [x.msg], lootIds: [x.id] })) });
    }
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
    // A one-off set of extra entities/changes for the next extraction (tests build items this way).
    if (M.addChanges) { const x = M.addChanges({ first, known, prompt }); M.addChanges = null; data.entities.push(...(x.entities || [])); data.changes.push(...(x.changes || [])); }
    if (M.itemPerson) data.changes.push({ op: 'add', type: 'item', entity: ariId || 'ari', text: 'Ari carries the key.', msgs: [first] });
    return '<think>hmm</think>\n```json\n' + JSON.stringify(data) + '\n```';
}
window.SillyTavern = {
    getContext: () => ({
        extensionSettings: M.settings, saveSettingsDebounced() { M.settingsSaves = (M.settingsSaves || 0) + 1; },
        getCurrentChatId: () => M.chatId,
        // v0.6.72: a group room when M.groupId is set (M.groups: [{ id, name, chat_id }]).
        get characters() { return M.characters; }, characterId: 0, get groups() { return M.groups || []; }, get groupId() { return M.groupId ?? null; },
        name1: 'Me', name2: 'Ari',
        get chat() { return M.chat; }, get chatMetadata() { return M.meta; },
        // v0.6.59: two writes of the chat file at the same time are counted (M.overlap).
        // v0.6.64: M.spSaves counts the chat saves SavePoint asks for (SillyTavern's own: M.stSaves).
        // v0.6.72: SavePoint sends the chat file itself (/api/chats/save, below); these two are what SillyTavern
        // offers and are kept for older code (EXT=<old folder>). M.stLate: like SillyTavern, wait 0.1 s and
        // then save the room open by then (its name, messages and metadata).
        async saveMetadata() { return M.stLateSave(); },
        async saveChat() { return M.stLateSave(); },
        // v0.6.83: M.headerThrowNth — the n-th call (from now) throws, as a request that cannot be made ready.
        getRequestHeaders: () => { if (M.headerThrowNth && !--M.headerThrowNth) throw new Error('no token'); return { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }; },
        setExtensionPrompt(k, v, p, d, s, r) { if (M.promptThrow > 0) { M.promptThrow--; throw new Error('prompt update failed'); } M.prompts[k] = { v, p, d, r }; },
        eventSource, event_types,
        get ConnectionManagerRequestService() { return M.cm; },
        async generateRaw({ prompt }) { M.calls.push(prompt); if (M.throwNext) { const e = M.throwNext; M.throwNext = null; throw e; } if (M.badJson && !prompt.startsWith('You are checking')) return 'Sure! Here is the summary: {not json'; if (M.delay) await new Promise(r => setTimeout(r, M.delay)); if (M.delayOnce) { const d = M.delayOnce; M.delayOnce = 0; await new Promise(r => setTimeout(r, d)); M.lateDone = (M.lateDone || 0) + 1; } return fake(prompt); },
        // v0.6.86: drawing messages (SillyTavern's addOneMessage / updateMessageBlock: the screen only, no event, no save)
        // and reloading the chat from the server file (reloadCurrentChat: opens the room again; counted, M.reloads).
        // v0.6.88: forceId / insertBefore as SillyTavern takes them (the id given, put in front of that drawn message).
        addOneMessage(m, { forceId = null, insertBefore = null } = {}) { const i = M.chat.indexOf(m); M.draws = (M.draws || 0) + 1;
            drawMes(typeof forceId === 'number' ? forceId : typeof insertBefore === 'number' ? insertBefore - 1 : i >= 0 ? i : M.chat.length - 1, m, insertBefore); },
        updateMessageBlock(i, m) { M.redraws = (M.redraws || 0) + 1; drawMes(i, m); },
        async reloadCurrentChat() { M.reloads = (M.reloads || 0) + 1; await M.openFile(M.chatId); },
        callGenericPopup: async (text, type) => { (M.popups ||= []).push(String(text)); if (M.onPopup) await M.onPopup(String(text), type); return type === 3 ? M.popupInput : M.confirm; },
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3 },
    }),
};
// v0.6.58: the character card (its greetings decide whether a one-message room may get a carried #0).
M.characters = [{ avatar: 'ari.png', name: 'Ari', description: 'Ari is a courier with green hair.', first_mes: 'Hello! This is the very first greeting.',
    data: { alternate_greetings: ['Another greeting.', 'Fresh greeting for the failing room.', 'A brand new greeting.'] } }];
const copy = v => JSON.parse(JSON.stringify(v));
// v0.6.86: the chat view (#chat .mes[mesid]); opening a room empties it, as SillyTavern's clearChat does.
function drawMes(i, m, before = null) {
    const box = document.querySelector('#chat');
    if (!box) return;
    let el = box.querySelector(`.mes[mesid="${i}"]`);
    const at = typeof before === 'number' ? box.querySelector(`.mes[mesid="${before}"]`) : null;
    if (!el) { el = document.createElement('div'); el.className = 'mes'; el.setAttribute('mesid', String(i)); if (at) at.before(el); else box.append(el); }
    el.dataset.text = String(m?.mes ?? '');
}
const clearDrawn = () => document.querySelectorAll('#chat .mes').forEach(el => el.remove());
// v0.6.72: one chat file write as the server does it (both /api/chats/save and SillyTavern's own path for
// older code). The knobs: M.metaDelay (ms before it lands), M.failMeta / M.failOnce / M.failNth (500),
// M.swallowMeta (answers ok, keeps nothing: like SillyTavern showing "could not be saved" and returning),
// M.silentSaveFail (answers ok, file unchanged), M.readFailAfterSave / M.readFailAfterNth (reads fail after).
// Like the server: metadata with `integrity` is checked against the file's (refused when they differ); without
// one the check is skipped and the file is overwritten.
const ST_500 = 'An error has occurred, see the console logs for more information.';
M.serverSave = async (name, data, { st = false } = {}) => {
    if (st) M.stSaves++; else { M.spSaves++; M.chatSaves++; } M.inSave = (M.inSave || 0) + 1; if (M.inSave > 1) M.overlap = (M.overlap || 0) + 1;
    try {
        if (M.beforeChatSave) await M.beforeChatSave(name, data);
        if (M.metaDelay) await new Promise(r => setTimeout(r, M.metaDelay));
        // v0.6.83: a failed write answers as SillyTavern's save handler does (its catch-all 500 sentence).
        if (M.failMeta) return { status: 500, error: ST_500 };
        if (M.failOnce) { M.failOnce = false; return { status: 500, error: ST_500 }; }
        if (M.failNth) { M.failNth--; if (!M.failNth) return { status: 500, error: ST_500 }; }
        if (M.swallowMeta) { M.swallowed = (M.swallowed || 0) + 1; if (M.readFailAfterSave) M.serverError = true; return { status: 200 }; }
        const sent = data[0]?.chat_metadata?.integrity, had = Array.isArray(M.serverFiles[name]) ? M.serverFiles[name][0]?.chat_metadata?.integrity : undefined;
        if (sent && had && sent !== had) { M.integrityRefused = (M.integrityRefused || 0) + 1; return { status: 400, error: 'integrity' }; }
        M.saves = (M.saves || 0) + 1;
        if (!M.silentSaveFail) { M.serverFiles[name] = copy(data); if (name === M.chatId) M.serverChat = M.serverFiles[name]; (M.writes ||= []).push(name); }
        if (M.readFailAfterSave) M.serverError = true;
        if (M.readFailAfterNth && !--M.readFailAfterNth) M.serverError = true;
        return { status: 200 };
    } finally { M.inSave--; }
};
M.stLateSave = async () => {
    if (M.stLate) await new Promise(r => setTimeout(r, 100));
    const r = await M.serverSave(M.chatId, [{ chat_metadata: M.meta }, ...M.chat]);
    if (r.status !== 200) throw new Error(r.error);
};
// v0.6.72: SillyTavern opening a room (openCharacterChat): the same message list is emptied, the name
// changes, the metadata becomes {} and the file is read later (M.openDelay ms). An empty file gets the
// card's greeting, which SillyTavern saves (saveChatConditional) before telling extensions (CHAT_CHANGED).
M.stOpen = async (id, { greeting = 'Hello there' } = {}) => {
    clearDrawn(); M.chat.splice(0); M.chatId = id; M.meta = {};
    await new Promise(r => setTimeout(r, M.openDelay ?? 400));
    const f = Array.isArray(M.serverFiles[id]) ? copy(M.serverFiles[id]) : [];
    const head = f[0] && 'chat_metadata' in f[0] ? f.shift().chat_metadata : {};
    M.meta = opened(head, id);
    M.chat.splice(0, M.chat.length, ...f);
    if (!M.chat.length) {
        M.chat.push({ name: 'Ari', is_user: false, is_system: false, mes: greeting, swipe_id: 0, extra: {} });
        await new Promise(r => setTimeout(r, 100));
        await M.serverSave(M.chatId, [{ chat_metadata: M.meta }, ...M.chat], { st: true });
    }
    await eventSource.emit('chat_id_changed');
};
// v0.6.58: the chat files on the server, one per room (null: no file). A room's file is what it held
// when it was opened; SavePoint's saves write it (/api/chats/save) and so does SillyTavern itself when
// messages come, change or go (M.stSave: M.add and the message events). While saves fail silently
// (M.silentSaveFail, M.swallowMeta) or M.serverFrozen is set, nothing changes it.
// M.serverEmpty: an empty answer (a missing file and a failed read look the same). M.serverError: 500.
M.serverFiles = {};
// Older suites write the open room's file directly.
M.writeServerChat = () => { if (M.silentSaveFail) return; M.serverChat = copy([{ chat_metadata: M.meta }, ...M.chat]); M.serverFiles[M.chatId] = M.serverChat; };
M.stSave = () => { if (M.serverFrozen || M.silentSaveFail || M.swallowMeta || M.noStSave) return; M.stSaves++; M.serverFiles[M.chatId] = copy([{ chat_metadata: M.meta }, ...M.chat]); };
M.spSaves = 0; M.stSaves = 0; M.chatSaves = 0;
M.serverFile = name => {
    if (M.serverEmpty) return {};
    if (M.serverError) return null;
    if (!Object.hasOwn(M.serverFiles, name)) {
        if (name !== M.chatId) return {};
        M.serverFiles[name] = copy([{ chat_metadata: M.meta }, ...M.chat]);   // the room as it was loaded
    }
    return M.serverFiles[name] ?? {};
};
M.add = (n, fn) => {
    for (let i = 0; i < n; i++) {
        const idx = M.chat.length, user = idx % 2 === 1;
        M.chat.push({ name: user ? 'Me' : 'Ari', is_user: user, is_system: false, mes: (fn ? fn(idx) : '') || `Message ${idx} from ${user ? 'Me' : 'Ari'} about the day ${'and more '.repeat(10)}.`, swipe_id: 0, extra: {} });
    }
    M.stSave();
};
// v0.6.59: SillyTavern keeps the same message list object for the next room (chat.splice(0, n, ...data)).
// v0.6.64: M.stIntegrity: like SillyTavern, a room opened without `integrity` gets one on the page only
// (it reaches the file with the next save). Off by default (older suites compare metadata as given).
const uuid = () => globalThis.crypto?.randomUUID?.() || 'u' + Math.random().toString(36).slice(2);
// v0.6.72: on by default (SillyTavern always does this when it loads a room; SavePoint does not write a room
// without it). M.noIntegrity turns it off. A file that has one gives it to the page, as reading the file would.
const opened = (meta, id) => {
    if (M.noIntegrity || !meta || typeof meta !== 'object' || meta.integrity) return meta;
    const f = Array.isArray(M.serverFiles?.[id]) ? M.serverFiles[id][0]?.chat_metadata?.integrity : undefined;
    meta.integrity = f || uuid();
    return meta;
};
M.switchSame = async (id, list, meta) => { clearDrawn(); opened(meta, id); M.chatId = id; M.chat.splice(0, M.chat.length, ...list); M.meta = meta; if (!Object.hasOwn(M.serverFiles, id)) M.serverFiles[id] = copy([{ chat_metadata: meta }, ...list]); await eventSource.emit('chat_id_changed'); };
M.switchChat = async (id, chatArr, meta) => { clearDrawn(); opened(meta, id); M.chatId = id; M.chat = chatArr; M.meta = meta; if (!Object.hasOwn(M.serverFiles, id)) M.serverFiles[id] = copy([{ chat_metadata: meta }, ...chatArr]); await eventSource.emit('chat_id_changed'); };

// v0.6.64: opening a room from its server file (the way SillyTavern reloads a room), and the room tools
// that make new chat files: rename, delete, branch (with a swipe), checkpoint, import.
M.chatList = () => Object.keys(M.serverFiles).filter(k => Array.isArray(M.serverFiles[k]));
M.openFile = async (id, { same = true } = {}) => {
    const f = copy(M.serverFiles[id]);
    const head = f[0] && 'chat_metadata' in f[0] ? f.shift().chat_metadata : {};
    await (same ? M.switchSame(id, f, head) : M.switchChat(id, f, head));
};
// SillyTavern renames on the server, reopens the room if it was open, and only then sends CHAT_RENAMED
// (names with .jsonl). Only the device that renamed gets the notice.
// v0.6.65: the server may clean the typed name (sanitizedFileName): the file and the reopened room get the
// cleaned name (`saved`), the notice still carries the typed one (`to`).
M.renameChat = async (from, to, { avatarId = 'ari.png', groupId = undefined, saved = to } = {}) => {
    M.serverFiles[saved] = M.serverFiles[from]; delete M.serverFiles[from];
    if (M.chatId === from) await M.openFile(saved);
    await eventSource.emit(event_types.CHAT_RENAMED, { avatarId, groupId, oldFileName: `${from}.jsonl`, newFileName: `${to}.jsonl` });
};
M.deleteChat = async (id, { group = false } = {}) => { delete M.serverFiles[id]; await eventSource.emit(group ? event_types.GROUP_CHAT_DELETED : event_types.CHAT_DELETED, id); };
// createBranch / createNewBookmark: the open room's messages up to `at` (the last one on `swipe` if given)
// and its whole metadata, plus main_chat and a new integrity (an older SillyTavern kept the old one:
// keepIntegrity). The branch name is added to that message's extra.branches on the page (not saved here).
const branchFile = (name, at, { swipe = null, keepIntegrity = false } = {}) => {
    const list = copy(M.chat.slice(0, at + 1));
    const last = list[at];
    if (swipe !== null) { last.swipe_id = swipe; last.mes = last.swipes[swipe]; if (last.swipe_info?.[swipe]) last.extra = copy(last.swipe_info[swipe].extra || {}); }
    const meta = { ...copy(M.meta), main_chat: M.chatId, ...(keepIntegrity ? {} : { integrity: uuid() }) };
    M.serverFiles[name] = [{ chat_metadata: meta }, ...list];
};
M.branchChat = (name, at, opts = {}) => {
    branchFile(name, at, opts);
    const m = M.chat[at]; m.extra ||= {}; (m.extra.branches ||= []).push(name);
    return name;
};
// v0.6.65: createNewBookmark: the same file as a branch, then the message gets `bookmark_link` and the
// original room is saved by SillyTavern itself (saveChatConditional).
M.checkpointChat = (at, n = 1) => {
    const name = `Checkpoint #${n} - ${M.chatId}`;
    branchFile(name, at);
    const m = M.chat[at]; m.extra ||= {}; m.extra.bookmark_link = name;
    M.stSave();
    return name;
};
// Importing a .jsonl copies the file as it is (same integrity) under a new name.
M.importChat = (id, name = `${id} imported`) => { M.serverFiles[name] = copy(M.serverFiles[id]); return name; };

// v0.6.64: the user files folder for the planned memory files.
// M.fileState[name]: 'broken' (200 with something that is not the file), 'error' (500), 'missing' (404
// even though it is there). M.fileDelay[name] (or ['*']): ms before a read answers. M.fileReads: names read.
// M.beforeUpload(name, text): awaited right before a write lands (another device can write in between:
// M.otherPut). M.otherPut / M.otherDel: another device's writes, straight to the folder.
M.fileState = {}; M.fileDelay = {}; M.fileReads = [];
M.otherPut = (name, obj) => { M.files.set(name, typeof obj === 'string' ? obj : JSON.stringify(obj)); M.fileLog.push(['other-put', name]); };
M.otherDel = name => { M.files.delete(name); M.fileLog.push(['other-del', name]); };

// Fake SillyTavern files API (/api/files/upload|delete|verify, /user/files/<name>).
const realFetch = window.fetch;
const fromB64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const res = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    // SillyTavern's chat read-back: the copy last written by a save that "succeeded" on the server.
    // M.silentSaveFail mimics SillyTavern swallowing a server error: the call returns, the file stays old.
    if (u === '/api/chats/get' || u === '/api/chats/group/get') {
        M.serverReads = (M.serverReads || 0) + 1;
        const b = JSON.parse(opts.body || '{}'), fileName = u === '/api/chats/get' ? b.file_name : b.id;
        const delay = M.readDelayFor?.[fileName] ?? M.serverReadDelay;
        if (delay) await new Promise(r => setTimeout(r, delay));
        const f = M.serverFile(fileName);
        return f === null ? res('down', 500) : res(f);
    }
    // v0.6.72: the chat file writes SavePoint sends (personal and group rooms).
    if (u === '/api/chats/save' || u === '/api/chats/group/save') {
        const b = JSON.parse(opts.body || '{}');
        (M.saveBodies ||= []).push({ url: u, name: b.file_name ?? b.id, count: (b.chat?.length || 1) - 1, integrity: b.chat?.[0]?.chat_metadata?.integrity ?? null });
        const r = await M.serverSave(u === '/api/chats/save' ? b.file_name : b.id, b.chat);
        return r.status === 200 ? res({ ok: true }) : res({ error: r.error }, r.status);
    }
    // v0.6.64: the chat list of a character (simple form), from the server files.
    if (u === '/api/characters/chats') return res(M.chatList().map(id => ({ file_name: `${id}.jsonl`, file_id: id })));
    if (!u.startsWith('/api/files/') && !u.startsWith('/user/files/')) return realFetch(url, opts);
    if (M.serverDown) return res('down', 503);
    if (u === '/api/files/upload') {
        const b = JSON.parse(opts.body);
        if (!/^[a-zA-Z0-9_\-.]+$/.test(b.name)) return res('bad name', 400);
        if (M.failFile && b.name.includes(M.failFile)) return res('fail', 500);
        if (M.beforeUpload) await M.beforeUpload(b.name, fromB64(b.data));
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
    M.fileReads.push(name);
    const wait = M.fileDelay[name] ?? M.fileDelay['*'];
    if (wait) await new Promise(r => setTimeout(r, wait));
    const st = M.fileState[name];
    if (st === 'error') return res('down', 500);
    if (st === 'missing') return res('nf', 404);
    if (st === 'broken' && M.files.has(name)) { const t = M.files.get(name); return res(t.slice(0, Math.max(1, Math.floor(t.length / 2)))); }
    if (st === 'broken') return res('<!DOCTYPE html><html><body>not found</body></html>');
    return M.files.has(name) ? res(M.files.get(name)) : res('nf', 404);
};
// v0.6.72: SillyTavern's own module (isChatSaving), served as /script.js for SavePoint's import.
import('/script.js').then(m => { M.stScript = m; }, () => {});
// v0.6.72: the first room is loaded like any other (it gets its integrity).
opened(M.meta, M.chatId);
