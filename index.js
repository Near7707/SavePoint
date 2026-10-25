// SavePoint: scene journal + current state memory for SillyTavern, kept per chat room,
// with game-style save files. Summaries run only when the user presses a button.
import {
    emptyMem, cleanMem, detachMem, chunkMessages, promptContext, validateResult, resultLanguageIssues,
    applyResult, closeOpenScene, pushHistory, rollbackFrom, buildInjection, openScene, memStats, validateBoundary,
    pointInjected, rekeyItems, validateRekey, applyRekey, needsRekey, sceneOutlineText, sceneOutlineParts,
    normalizeResult, validateCheck, checkScope, dupState, pointId,
    recordLine, entityName, estTokens, QUEST_KINDS, WORLD_KINDS, ENTITY_TYPES,
    groupErrors, findQuote, normQuote,
} from './core.js';
import { Vault, roomHash } from './vault.js';
import { DEFAULT_GUIDE, guideHash, OLD_GUIDE_HASHES, OUTPUT_FORMAT, buildCheckPrompt, buildRekeyPrompt, buildExtractPrompt, buildBoundaryPrompt, batchNote, retryNote, TRANSLATE_PROMPT } from './prompts.js';

const MODULE = 'savePoint';
const PROMPT_KEY = 'savepoint';
const HIDE_KEY = 'savepointHidden';
const VISIBLE_KEY = 'savepointVisible';
const VERSION = '0.3.1';

const ctx = () => SillyTavern.getContext();
const clone = v => structuredClone(v);

const DEFAULTS = {
    enabled: true, check: true, auto: true, autoEvery: 20, profileId: '', responseLength: 8000, inputChars: 60000, timeoutSec: 300,
    budget: 6000, titleCap: 600, recentScenes: 3, recall: true, rawRecall: false,
    hide: true, keepRecent: 10, position: 1, depth: 4, role: 0,
    theme: 'jrpg', showKo: false, autoKeep: 30, guide: DEFAULT_GUIDE, slotCache: [], localSaves: {},
};
const THEMES = { jrpg: '클래식 JRPG', neon: '네온 아케이드', glass: '글래스 사이버', archive: '다크 아카이브', pastel: '파스텔 드림', parchment: '양피지', terminal: '터미널', st: '실리 테마 따라가기' };
const TABS = [
    ['journal', '📜', '저널'], ['quests', '❗', '퀘스트'], ['party', '👥', '파티'],
    ['items', '🎒', '인벤토리'], ['world', '🗺', '월드'], ['saves', '💾', '세이브'], ['inject', '👁', '주입'],
];
const KIND_KO = {
    promise: '약속', goal: '목표', debt: '빚', mystery: '수수께끼',
    place: '장소', rule: '규칙', name: '별명·이름', secret: '비밀',
    relation: '관계', condition: '상태', person: '인물', item: '물건',
};
const QUEST_ICON = { promise: '🤝', goal: '🎯', debt: '💰', mystery: '❓' };

const ui = { open: false, tab: 'journal', run: null, progress: '', edit: null, inj: null, lastError: null, found: null, savesOpen: new Map() };
let roomEpoch = 0;
let mainGenerating = false;
let persistTimer = null;
let chatSaveTimer = null;
let sourceTimer = null;

// ───────── settings ─────────

function settings() {
    const es = ctx().extensionSettings;
    if (!es[MODULE] || typeof es[MODULE] !== 'object') es[MODULE] = clone(DEFAULTS);
    const s = es[MODULE];
    for (const k of Object.keys(DEFAULTS)) if (!(k in s)) s[k] = clone(DEFAULTS[k]);
    if (OLD_GUIDE_HASHES.includes(guideHash(s.guide))) s.guide = DEFAULT_GUIDE;
    // v0.2.1 and earlier kept whole slots (with memory) in settings. Keep them locally until
    // they are safely on the server (see migrateLocal).
    if (s.saves && typeof s.saves === 'object' && !Array.isArray(s.saves)) {
        if (!s.localSaves || typeof s.localSaves !== 'object') s.localSaves = {};
        for (const [id, rec] of Object.entries(s.saves)) if (rec && rec.mem && !s.localSaves[id]) s.localSaves[id] = rec;
        if (s.autoKeep === 20) s.autoKeep = 30;
        delete s.saves;
    }
    if (!Array.isArray(s.slotCache)) s.slotCache = [];
    if (!s.localSaves || typeof s.localSaves !== 'object' || Array.isArray(s.localSaves)) s.localSaves = {};
    return s;
}
function saveSettings() { ctx().saveSettingsDebounced(); }
function num(key, min, max) {
    const n = Number(settings()[key]);
    return Math.min(max, Math.max(min, Number.isFinite(n) ? Math.floor(n) : DEFAULTS[key]));
}
function profiles() {
    const list = ctx().extensionSettings?.connectionManager?.profiles;
    return Array.isArray(list) ? list : [];
}
function profileLabel() {
    const id = settings().profileId;
    if (!id) return '메인 API';
    return profiles().find(p => p.id === id)?.name || '찾을 수 없는 프로필';
}
function mainBusy() {
    const p = ctx().streamingProcessor;
    return mainGenerating || !!(p && !p.isFinished && !p.isStopped);
}

// ───────── room ─────────

function newId() { return globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2); }
function charInfo() {
    const c = ctx();
    if (c.groupId !== undefined && c.groupId !== null && c.groupId !== '') {
        const g = c.groups?.find(x => String(x.id) === String(c.groupId));
        return { key: 'group:' + c.groupId, name: g?.name || '그룹' };
    }
    const ch = c.characters?.[c.characterId];
    return ch ? { key: ch.avatar, name: ch.name } : null;
}
function chatId() {
    const c = ctx();
    return (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : c.chatId) ?? null;
}
function roomKey() {
    const ci = charInfo(), id = chatId();
    return ci && id !== null && id !== '' ? JSON.stringify([ci.key, String(id)]) : null;
}
function hasChat() { return roomKey() !== null; }
function chat() { return ctx().chat || []; }
function state() {
    const st = ctx().chatMetadata?.[MODULE];
    return st && st.v === 1 ? st : null;
}
function freshState(extra = {}) {
    return { v: 1, roomKey: roomKey(), mem: emptyMem(), lastIndex: -1, hashes: [], history: [], floor: -1, linkedSave: null, undo: null, review: null, rev: 0, ...extra };
}
function ensureState() {
    let st = state();
    if (st) return st;
    st = freshState();
    ctx().chatMetadata[MODULE] = st;
    return st;
}
function hasMemory(mem) { return !!(mem && (mem.scenes.length || mem.records.length)); }
async function persist() { if (hasChat()) await ctx().saveMetadata(); }

// Every change to a room's memory goes through here.
// The memory (chat metadata) and the hide flags on messages are stored in the same chat file and
// written by the same request, so both are updated in the page first and then saved once; a file
// never ends up with one half of a change. If the save call throws, the previous state is put back.
// SillyTavern's saveMetadata() handles most server failures itself (it shows "Chat could not be
// saved" and returns normally). That case cannot be detected here: the change stays in the page and
// is written together with the next successful chat save.
// The automatic save file lives in the settings file and is only a convenience copy.
async function transact(change, { undoable = true, autosave: doAutosave = true } = {}) {
    const meta = ctx().chatMetadata, key = roomKey(), epoch = roomEpoch;
    const prev = meta[MODULE] ? clone(meta[MODULE]) : undefined;
    if (change() === false) return false;
    const st = state();
    if (st) {
        if (undoable && prev) { const { undo: _u, ...rest } = prev; st.undo = clone(rest); }
        st.rev = (prev?.rev || 0) + 1;
    }
    syncHide(); refreshInjection();
    try { await persist(); }
    catch (e) {
        if (prev === undefined) delete meta[MODULE]; else meta[MODULE] = prev;
        if (roomKey() === key && roomEpoch === epoch) { syncHide(); refreshInjection(); render(); }
        throw new Error(`채팅 파일에 저장하지 못해서 이번 변경을 취소했어요. (${e?.message || e})`);
    }
    if (roomKey() === key && roomEpoch === epoch) { if (doAutosave) autosave(state()); render(); }
    return true;
}
function persistSoon() {
    clearTimeout(persistTimer);
    const key = roomKey(), epoch = roomEpoch;
    persistTimer = setTimeout(function save() {
        if (roomKey() !== key || roomEpoch !== epoch) return;
        if (mainBusy()) { persistTimer = setTimeout(save, 1500); return; }
        persist().catch(reportError);
    }, 300);
}
function saveChatSoon() {
    clearTimeout(chatSaveTimer);
    const key = roomKey(), epoch = roomEpoch;
    chatSaveTimer = setTimeout(function save() {
        if (roomKey() !== key || roomEpoch !== epoch) return;
        if (mainBusy()) { chatSaveTimer = setTimeout(save, 1500); return; }
        const c = ctx();
        Promise.resolve((c.saveChatConditional || c.saveChat)?.call(c)).catch(reportError);
    }, 500);
}

// ───────── source fingerprints ─────────

function hashString(text) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        const n = text.charCodeAt(i);
        a = Math.imul(a ^ n, 16777619);
        b = Math.imul(b, 33) ^ n;
    }
    return `${text.length}:${a >>> 0}:${b >>> 0}`;
}
// Visibility (hide/unhide) is not content, so it is not part of the fingerprint.
function fingerprint(m) {
    if (!m || typeof m !== 'object') return 'x';
    return hashString(JSON.stringify([m.name || '', !!m.is_user, m.mes || '', m.swipe_id ?? null]));
}
function hashesTo(end) { return chat().slice(0, end + 1).map(fingerprint); }
function digest(list) { return hashString(list.join('|')); }
function firstMismatch(hashes) {
    const list = chat();
    for (let i = 0; i < hashes.length; i++) if (i >= list.length || hashes[i] !== fingerprint(list[i])) return i;
    return -1;
}

// ───────── messages ─────────

function cleanText(t) {
    return String(t || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();
}
function speaker(m) { return m.name || (m.is_user ? ctx().name1 : ctx().name2) || 'Someone'; }
// Our own hidden messages still count; messages the user hid themselves are left out.
function eligible(m) { return m && (!m.is_system || m.extra?.[HIDE_KEY]) && cleanText(m.mes); }
function collect(start, end) {
    const out = [];
    for (let i = Math.max(0, start); i <= end; i++) {
        const m = chat()[i];
        if (eligible(m)) out.push({ index: i, name: speaker(m), text: cleanText(m.mes) });
    }
    return out;
}
function pendingCount() {
    const st = state();
    return collect((st?.lastIndex ?? -1) + 1, chat().length - 1).length;
}
function cardText() {
    const c = ctx();
    const ch = c.characters?.[c.characterId];
    const persona = c.powerUserSettings?.persona_description || globalThis.power_user?.persona_description || '';
    const parts = [];
    if (ch) {
        parts.push(`Character: ${ch.name}`);
        for (const k of ['description', 'personality', 'scenario']) {
            const v = cleanText(ch[k] || ch.data?.[k]);
            if (v) parts.push(`${k}: ${v.slice(0, 2500)}`);
        }
    }
    parts.push(`User persona: ${c.name1 || 'User'}`);
    if (persona) parts.push(`persona: ${cleanText(persona).slice(0, 1500)}`);
    return parts.join('\n');
}
function names() { return { char: ctx().name2 || charInfo()?.name || 'the character', user: ctx().name1 || 'the user' }; }

// ───────── hiding ─────────

function setHidden(m, i, hidden) {
    m.is_system = hidden;
    $(`#chat .mes[mesid="${i}"]`).attr('is_system', String(hidden));
}
function syncHide() {
    const st = state(), s = settings(), list = chat();
    const can = s.enabled && s.hide && st && !st.review && hasMemory(st.mem);
    const cutoff = can ? Math.min(st.lastIndex, list.length - 1 - num('keepRecent', 0, 200)) : -1;
    let changed = false;
    list.forEach((m, i) => {
        const mark = m.extra?.[HIDE_KEY];
        if (mark && !m.is_system) {
            // The user unhid it on purpose; leave it visible from now on.
            delete m.extra[HIDE_KEY]; m.extra[VISIBLE_KEY] = true; changed = true; return;
        }
        if (mark && i > cutoff) { setHidden(m, i, false); delete m.extra[HIDE_KEY]; changed = true; }
        else if (!mark && i <= cutoff && !m.is_system && !m.extra?.[VISIBLE_KEY]) {
            m.extra ||= {}; m.extra[HIDE_KEY] = 1; setHidden(m, i, true); changed = true;
        }
    });
    if (changed) { ctx().swipe?.refresh?.(); saveChatSoon(); }
    return changed;
}
function unhideAll() {
    let changed = false;
    chat().forEach((m, i) => {
        if (!m.extra?.[HIDE_KEY]) return;
        setHidden(m, i, false); delete m.extra[HIDE_KEY]; changed = true;
    });
    if (changed) { ctx().swipe?.refresh?.(); saveChatSoon(); }
}

// ───────── change detection ─────────

// Returns false while the room needs a decision from the user.
function reconcile() {
    const st = state();
    if (!st) return true;
    if (st.review) return false;
    if (st.lastIndex < 0) return true;
    const k = firstMismatch(st.hashes);
    if (k < 0) return true;
    cancelRun();
    if (rollbackFrom(st, k)) {
        st.hashes = st.hashes.slice(0, st.lastIndex + 1);
        st.undo = null; st.rev++;
        syncHide(); persistSoon();
        toastr.warning(`기록된 원문 #${k}이(가) 바뀌어서 그 구간부터 기록을 되감았어요. 다음 체크포인트나 퀵세이브 때 다시 기록돼요.`, 'SavePoint');
        return true;
    }
    st.review = { at: k };
    unhideAll(); persistSoon();
    return false;
}
async function acceptCurrentSource() {
    if (!state()) return;
    await transact(() => {
        const st = state();
        st.lastIndex = Math.min(st.lastIndex, chat().length - 1);
        st.hashes = hashesTo(st.lastIndex);
        st.floor = st.lastIndex; st.history = []; st.review = null; st.undo = null;
    }, { undoable: false });
}

// ───────── injection ─────────

function recentQuery() {
    const list = chat();
    const out = [];
    for (let i = list.length - 1; i >= 0 && out.length < 6; i--) {
        const m = list[i];
        if (m && !m.is_system && cleanText(m.mes)) out.unshift(cleanText(m.mes));
    }
    return out.join('\n').slice(-5000);
}
function rawExcerpt(scene) {
    if (scene.external) return '';
    for (const g of scene.segs) for (const p of g.points) for (const n of p.msgs) {
        if (Number.isInteger(n) && chat()[n]) return cleanText(chat()[n].mes).slice(0, 600);
    }
    return '';
}
function refreshInjection() {
    const st = state(), s = settings();
    let text = '';
    ui.inj = null;
    if (s.enabled && st && hasChat() && !st.review && hasMemory(st.mem)) {
        ui.inj = buildInjection(st.mem, {
            budget: num('budget', 300, 100000), titleCap: num('titleCap', 0, 20000), recentScenes: num('recentScenes', 0, 20),
            query: recentQuery(), recall: !!s.recall, rawRecall: s.rawRecall ? rawExcerpt : null,
            ignoreNames: [names().char, names().user, charInfo()?.name].filter(Boolean),
        });
        text = ui.inj.text;
    }
    ctx().setExtensionPrompt(PROMPT_KEY, text, Number(s.position), num('depth', 0, 999), false, Number(s.role));
}

// ───────── AI calls ─────────

class Cancelled extends Error {}
class RequestTimeout extends Error {}
function cancelRun() {
    if (!ui.run) return;
    ui.run.cancelled = true;
    try { ui.run.ctrl?.abort(); } catch { /* ignore */ }
    for (const f of ui.run.onCancel || []) { try { f(); } catch { /* ignore */ } }
}
// One request. What the extension can know is only: waiting for a reply, reply received, or
// asking again. Whether the model is still thinking or the server is stalled cannot be told apart.
// A request that passes the time limit is abandoned: its signal is aborted and, if a reply still
// arrives later, nobody is waiting for it any more, so it can neither be saved nor touch the
// progress line of a newer task.
let reqSeq = 0, reqTicker = null;
const fmtSec = ms => { const t = Math.floor(ms / 1000); return t >= 60 ? `${Math.floor(t / 60)}분 ${String(t % 60).padStart(2, '0')}초` : `${t}초`; };
function reqText() {
    const r = ui.req;
    if (!r) return '';
    const step = r.attempt ? `재요청${r.why ? ` (${r.why})` : ''}` : '첫 요청';
    return r.phase === 'got' ? `${step} · 응답 받음 (${fmtSec(r.ms)}) · 검사 중` : `${step} · 응답 대기 ${fmtSec(Date.now() - r.start)}`;
}
function tickReq() {
    clearInterval(reqTicker);
    reqTicker = setInterval(() => {
        if (!ui.req || ui.req.phase !== 'wait') { clearInterval(reqTicker); reqTicker = null; return; }
        $('#sp_overlay .sp-req').text(reqText());
    }, 1000);
}
async function llm(prompt, run, { attempt = 0, why = '' } = {}) {
    const s = settings(), c = ctx(), max = num('responseLength', 500, 64000);
    const limit = num('timeoutSec', 5, 3600) * 1000;
    const id = ++reqSeq;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    if (run?.ctrl?.signal?.aborted) ctrl?.abort(); else run?.ctrl?.signal?.addEventListener?.('abort', () => ctrl?.abort());
    const send = async () => {
        if (s.profileId) {
            const svc = c.ConnectionManagerRequestService;
            if (!svc?.sendRequest) throw new Error('이 실리태번 버전에서는 연결 프로필로 요청할 수 없어요. 설정에서 요약 AI를 메인 API로 바꿔 주세요.');
            const p = profiles().find(x => x.id === s.profileId);
            if (!p) throw new Error('선택한 연결 프로필을 찾을 수 없어요. 설정에서 요약 AI를 다시 골라 주세요.');
            const payload = p.mode === 'tc' ? prompt : [{ role: 'user', content: prompt }];
            const res = await svc.sendRequest(p.id, payload, max,
                { stream: false, signal: ctrl?.signal ?? null, extractData: true, includePreset: true, includeInstruct: true });
            return typeof res === 'string' ? res : String(res?.content ?? '');
        }
        return String(await c.generateRaw({ prompt, responseLength: max }) ?? '');
    };
    const start = Date.now();
    if (run) { ui.req = { id, attempt, why, start, phase: 'wait' }; render(); tickReq(); }
    let timer, onCancel;
    const request = send();
    request.catch(() => {});   // a late failure after the time limit is ignored
    const limitP = new Promise((_, reject) => { timer = setTimeout(() => reject(new RequestTimeout(`응답이 ${fmtSec(limit)} 안에 오지 않았어요.`)), limit); });
    const cancelP = new Promise((_, reject) => { onCancel = () => reject(new Cancelled('중지했어요.')); if (run) (run.onCancel ||= []).push(onCancel); });
    try {
        const raw = await Promise.race([request, limitP, cancelP]);
        if (run && ui.req?.id === id) { ui.req = { ...ui.req, phase: 'got', ms: Date.now() - start }; render(); }
        return raw;
    } catch (e) {
        if (e instanceof RequestTimeout) { try { ctrl?.abort(); } catch { /* ignore */ } }
        throw e;
    } finally {
        clearTimeout(timer);
        if (run?.onCancel) run.onCancel = run.onCancel.filter(f => f !== onCancel);
    }
}
// The full error text: SillyTavern wraps the real error as "API request failed" with the
// original in .cause, so walk the chain and add any status code found on the way.
function errorText(e) {
    const parts = [], seen = new Set();
    let status = null, cur = e;
    for (let k = 0; cur && k < 5 && !seen.has(cur); k++) {
        seen.add(cur);
        const msg = typeof cur === 'string' ? cur : cur.message || cur.error?.message || (typeof cur.error === 'string' ? cur.error : '') || cur.statusText || '';
        if (msg && !parts.includes(String(msg))) parts.push(String(msg).slice(0, 300));
        status ??= cur.status ?? cur.statusCode ?? cur.response?.status ?? cur.error?.code ?? null;
        cur = typeof cur === 'object' ? cur.cause : null;
    }
    if (!parts.length) parts.push(String(e));
    return parts.join(' ← ') + (status !== null && status !== undefined && status !== '' ? ` (상태 ${status})` : '');
}
// What a reply looked like, for the failure details.
function replyKind(raw) {
    const t = String(raw ?? '');
    if (!t.trim()) return '빈 응답';
    const rest = t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/^[\s\S]*?<\/think(?:ing)?>/i, '').trim();
    if (!rest) return '생각(think) 부분만 있음';
    return null;
}
function parseJson(text, open = '{', close = '}') {
    const t = String(text || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/^[\s\S]*?<\/think(?:ing)?>/i, '').replace(/```[a-z]*\n?/gi, '').trim();
    if (!t) throw new Error('요약 AI가 빈 응답을 보냈어요. 띵킹 모델이면 설정의 "응답 최대 토큰"을 늘려 주세요.');
    const a = t.indexOf(open), b = t.lastIndexOf(close);
    if (a < 0 || b <= a) throw new Error('요약 AI가 JSON 형식으로 답하지 않았어요.');
    const body = t.slice(a, b + 1);
    try { return JSON.parse(body); } catch { /* lenient */ }
    try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch { /* fall through */ }
    throw new Error('요약 AI 응답을 해석하지 못했어요 (JSON 오류). 응답 최대 토큰이 부족해 잘렸을 수 있어요.');
}
function newRun(st, end) {
    const run = { st, key: roomKey(), epoch: roomEpoch, cancelled: false, hashes: hashesTo(end),
        viaMain: !settings().profileId, ctrl: typeof AbortController === 'function' ? new AbortController() : null };
    ui.run = run;
    return run;
}
function assertValid(run, upTo) {
    const ok = !run.cancelled && run.key === roomKey() && run.epoch === roomEpoch && state() === run.st &&
        !run.st.review && firstMismatch(run.hashes.slice(0, upTo + 1)) === -1 && !(run.viaMain && mainBusy());
    if (!ok) { run.cancelled = true; throw new Cancelled('대화나 채팅방이 바뀌어서 이 구간은 저장하지 않았어요.'); }
}
function endRun(run) {
    if (ui.run === run) { ui.run = null; ui.progress = ''; ui.req = null; }
    render();
}
function checkpoint(st) {
    const { undo, ...rest } = st;
    return clone(rest);
}

// One chunk: ask, check, retry once with the problems listed, then give up without saving.
function extractPrompt(mem, chunk, note = '') {
    return buildExtractPrompt({ guide: settings().guide || DEFAULT_GUIDE, names: names(), card: cardText(), context: promptContext(mem, chunk.text), chunk, note });
}
async function extractChunk(mem, chunk, run, { note = '', expectContinue } = {}) {
    const prompt = extractPrompt(mem, chunk, note);
    let data = null, errors = [], lang = [];
    const tries = [];   // what each request did, for the failure details
    let lastKind = '';
    const fail = (head, detail) => {
        ui.lastError = { at: Date.now(), range: `#${chunk.from}–#${chunk.to}`, detail: [...tries.map((t, k) => `${k ? '재요청' : '첫 요청'}: ${t}`), ...detail] };
        const err = new Error(head);
        err.detail = ui.lastError.detail;
        return err;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        let raw;
        const start = Date.now();
        const why = attempt ? lastKind : '';
        try { raw = await llm(attempt ? prompt + retryNote(groupErrors(errors), lang) : prompt, run, { attempt, why }); }
        catch (e) {
            if (run.cancelled || e instanceof Cancelled) throw new Cancelled('중지했어요.');
            if (e instanceof RequestTimeout) {
                tries.push(`${fmtSec(Date.now() - start)} · 응답 없음 → 제한 시간 초과로 취소`);
                throw fail(`${e.message} 이 구간(#${chunk.from}–#${chunk.to})은 취소했고 저장하지 않았어요.`, ['늦게 도착하는 응답은 버려요. 띵킹 모델이면 설정의 "요청 제한 시간"을 늘려 볼 수 있어요.']);
            }
            tries.push(`${fmtSec(Date.now() - start)} · 요청 오류: ${errorText(e)}`);
            throw fail(`요약 AI 요청이 실패했어요 (#${chunk.from}–#${chunk.to}): ${errorText(e)}`, []);
        }
        if (run.cancelled) throw new Cancelled('중지했어요.');
        const took = `${fmtSec(Date.now() - start)} · 응답 ${String(raw ?? '').length.toLocaleString()}자`;
        const kind = replyKind(raw);
        let parsed = false;
        let fixes = [];
        try { data = parseJson(raw); parsed = true; fixes = normalizeResult(data, { mem, chunk }); errors = validateResult(data, { mem, chunk, expectContinue }); }
        catch (e) { data = null; errors = [parsed ? `Could not read the reply: ${e.message}` : 'The reply was not valid JSON.']; }
        lang = data ? resultLanguageIssues(data) : [];
        lastKind = kind || (!parsed ? 'JSON 해석 실패' : !data ? '응답 처리 오류' : errors.length ? `검사 실패 ${errors.length}건` : lang.length ? `영어 아님 ${lang.length}곳` : '통과');
        tries.push(`${took} · ${lastKind}`);
        if (!errors.length && !lang.length) {
            const merged = fixes.filter(f => f.startsWith('merged:')).length;
            if (merged) ui.lastFix = { at: Date.now(), range: `#${chunk.from}–#${chunk.to}`, text: `AI가 "앞 장면에 이어짐"으로 표시한 장면 ${merged}개를 앞 장면에 합쳤어요` };
            return data;
        }
    }
    const detail = [...errors, ...(lang.length ? [`Not English: ${lang.join(', ')}`] : [])];
    return Promise.reject(fail(`요약 AI 응답이 검사를 통과하지 못했어요 (#${chunk.from}–#${chunk.to}). 이 구간은 저장하지 않았어요.`, detail));
}

async function summarize({ close = false } = {}) {
    if (ui.run) { toastr.info('이미 기록 중이에요.'); return; }
    if (!hasChat()) { toastr.warning('채팅방을 먼저 열어 주세요.'); return; }
    if (ui.edit) { toastr.warning('편집 중인 항목을 먼저 저장하거나 취소해 주세요.'); return; }
    if (!settings().profileId && mainBusy()) { toastr.info('본편 생성이 끝난 뒤 눌러 주세요. (연결 프로필을 고르면 생성 중에도 정리할 수 있어요.)'); return; }
    const st = ensureState();
    if (!reconcile()) { render(); toastr.warning('예전 원문이 바뀌었어요. 창 위쪽 안내에서 먼저 처리해 주세요.'); return; }
    const end = chat().length - 1;
    const start = st.lastIndex + 1;
    const msgs = collect(start, end);
    if (!msgs.length) {
        if (close && openScene(st.mem)) {
            try {
                await transact(() => {
                    const cur = state(), before = cur.mem;
                    cur.mem = closeOpenScene(before); pushHistory(cur, before, cur.mem, { kind: 'edit' });
                });
                toastr.success('진행 중이던 장면을 닫았어요.');
            } catch (e) { reportError(e); }
        } else toastr.info('기록할 새 메시지가 없어요.');
        return;
    }
    // Message budget = input limit minus everything else in the prompt.
    const all = msgs.map(m => `#${m.index} ${m.name}: ${m.text}`).join('\n\n');
    const ctxNow = promptContext(st.mem, all);
    const fixed = (settings().guide || DEFAULT_GUIDE).length + OUTPUT_FORMAT.length + 600 + cardText().length +
        ctxNow.entities.length + ctxNow.state.length + ctxNow.open.length + ctxNow.recent.length;
    const msgBudget = Math.max(4000, num('inputChars', 5000, 1000000) - fixed);
    const chunks = chunkMessages(msgs, msgBudget);
    st.autoMark = end; st.autoHold = null; persistSoon();
    const run = newRun(st, end);
    const undoPoint = checkpoint(st);
    const memBefore = st.mem;
    let done = 0;
    try {
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const last = i === chunks.length - 1;
            ui.progress = `${close ? '장면 클리어' : '퀵세이브'} ${chunks.length > 1 ? `${i + 1}/${chunks.length}구간 ` : ''}#${chunk.from}–#${chunk.to}`;
            render();
            const data = await extractChunk(st.mem, chunk, run);
            const coverTo = last ? end : chunk.to;
            assertValid(run, coverTo);
            const { mem: next } = applyResult(st.mem, data, chunk, { close: close && last });
            // Memory, position and hiding change together; a failed save puts all of it back.
            await transact(() => {
                const before = st.mem;
                st.mem = next;
                pushHistory(st, before, next, { kind: 'summary', from: st.lastIndex + 1, to: coverTo });
                st.lastIndex = coverTo; st.hashes = run.hashes.slice(0, coverTo + 1);
                st.undo = undoPoint;
            }, { undoable: false, autosave: false });
            done++;
        }
        ui.lastError = null;
        toastr.success(close ? '장면 클리어! 진행 중이던 장면까지 기록하고 닫았어요.' : '퀵세이브 완료. 마지막 메시지까지 기록했어요.', 'SavePoint');
    } catch (e) {
        const left = chunks.length - done;
        const where = done ? ` ${chunks.length}개 구간 중 ${done}개는 저장했고, 나머지 ${left}개 구간의 원문은 그대로 남겨 뒀어요.` : ' 기억과 원문은 바뀌지 않았어요.';
        if (e instanceof Cancelled) toastr.info(e.message + where, 'SavePoint');
        else { console.error('[SavePoint]', e, e.detail || ''); toastr.error(e.message + where, 'SavePoint', { timeOut: 12000 }); }
    } finally {
        endRun(run);
        if (done) { autosave(state()); if (state() === st) queueCheck(st, memBefore); }
    }
}

// ───────── automatic collection (finished scenes only) ─────────
//
// Counts complete user/character messages since the last automatic attempt. Every `autoEvery`
// messages, after a character reply has finished:
//   1. one short call marks scene boundaries in the uncollected messages (checked in code);
//   2. only the messages up to the end of the last confirmed-finished scene are summarized,
//      so the scene still in progress cannot leak into the journal or the state lists.
// If the open scene simply ended before the new messages, it is closed with no extraction.
// The scene in progress stays as original text. Nothing is cut or force-closed: when the
// uncollected text is over the input limit, automatic collection holds until a manual run.

const HOLD_TEXT = '미기록 내용이 입력 한도를 넘어 체크포인트를 멈췄어요. `퀵세이브`를 눌러 주세요.';
let autoTimer = null;
function autoCount(st) {
    const mark = Math.max(st?.autoMark ?? -1, st?.lastIndex ?? -1);
    return collect(mark + 1, chat().length - 1).length;
}
function autoBlocked() {
    const s = settings(), st = state();
    if (!s.enabled || !s.auto || !hasChat()) return 'off';
    if (ui.run || ui.edit || mainBusy()) return 'busy';
    if (st?.review || st?.autoHold) return 'hold';
    const last = chat()[chat().length - 1];
    if (!last || last.is_user) return 'waiting';
    return autoCount(st) >= num('autoEvery', 5, 500) ? null : 'count';
}
function scheduleAuto(delay = 1200) {
    clearTimeout(autoTimer);
    const epoch = roomEpoch;
    autoTimer = setTimeout(() => {
        if (epoch !== roomEpoch) return;
        if (autoBlocked() === 'busy') { scheduleAuto(3000); return; }
        if (!autoBlocked()) autoCollect().catch(reportError);
    }, delay);
}
function noteAuto(st, result, { moveMark = true, end = chat().length - 1 } = {}) {
    st.autoLast = { at: Date.now(), result };
    if (moveMark) st.autoMark = end;
    persistSoon(); render();
}
async function autoCollect() {
    if (autoBlocked()) return;
    const st = ensureState();
    if (!reconcile()) return;
    const end = chat().length - 1;
    const msgs = collect(st.lastIndex + 1, end);
    if (!msgs.length) return;
    const indices = msgs.map(m => m.index);
    const text = msgs.map(m => `#${m.index} ${m.name}: ${m.text}`).join('\n\n');
    const open = openScene(st.mem);
    const limit = num('inputChars', 5000, 1000000);
    const bPrompt = buildBoundaryPrompt({ names: names(), open: open && { ...open, outlineText: sceneOutlineText(open) }, from: indices[0], to: indices[indices.length - 1], text });
    if (bPrompt.length > limit) { st.autoHold = { at: Date.now() }; noteAuto(st, '정지: 입력 한도 초과', { end }); return; }
    const run = newRun(st, end);
    run.auto = true;
    const before0 = st.mem;
    let checkAfter = null;
    try {
        // Step 1: where do scenes start, and which are confirmed over?
        ui.progress = '체크포인트 · 장면 경계 확인'; render();
        let plan = null, errors = [], bKind = '';
        for (let attempt = 0; attempt < 2 && !plan; attempt++) {
            const raw = await llm(attempt ? bPrompt + retryNote(errors, []) : bPrompt, run, { attempt, why: attempt ? bKind : '' });
            if (run.cancelled) throw new Cancelled('중지했어요.');
            let parsed = null;
            try { parsed = parseJson(raw); } catch { /* below */ }
            if (parsed) ({ errors, plan } = validateBoundary(parsed, { indices, hasOpen: !!open }));
            else { errors = ['The reply was not valid JSON.']; plan = null; }
            bKind = replyKind(raw) || (!parsed ? 'JSON 해석 실패' : `검사 실패 ${errors.length}건`);
        }
        if (!plan) {
            ui.lastError = { at: Date.now(), range: `자동 · 경계 #${indices[0]}–#${indices[indices.length - 1]}`, detail: errors };
            throw new Error('장면 경계 응답이 검사를 통과하지 못했어요.');
        }
        assertValid(run, end);
        if (plan.boundary === null) {
            if (plan.closeOpen) {
                // The recorded open scene ended before these messages; the new scene stays uncollected.
                await transact(() => {
                    const before = st.mem;
                    st.mem = closeOpenScene(before); pushHistory(st, before, st.mem, { kind: 'edit' });
                    st.autoMark = end; st.autoLast = { at: Date.now(), result: `열린 장면 "${open.title}" 닫음 · 새 장면은 진행 중` };
                });
            } else noteAuto(st, '끝난 장면 없음', { end });
            return;
        }
        // Step 2: summarize only the finished part.
        const base = plan.closeOpen ? closeOpenScene(st.mem) : st.mem;
        const part = collect(st.lastIndex + 1, plan.boundary);
        const chunk = chunkMessages(part, Infinity)[0];
        const note = batchNote({ boundary: plan.boundary, continuesOpen: plan.continuesOpen });
        if (extractPrompt(base, chunk, note).length > limit) { st.autoHold = { at: Date.now() }; noteAuto(st, '정지: 입력 한도 초과', { end }); return; }
        ui.progress = `체크포인트 #${chunk.from}–#${plan.boundary}`; render();
        const data = await extractChunk(base, chunk, run, { note, expectContinue: plan.continuesOpen });
        assertValid(run, end);
        const { mem: next } = applyResult(base, data, chunk, { close: true });
        const count = data.scenes.length;
        await transact(() => {
            const before = st.mem;
            st.mem = next;
            pushHistory(st, before, next, { kind: 'summary', from: st.lastIndex + 1, to: plan.boundary });
            st.lastIndex = plan.boundary; st.hashes = run.hashes.slice(0, plan.boundary + 1);
            st.autoMark = end;
            st.autoLast = { at: Date.now(), result: `장면 ${count}개 기록 (#${chunk.from}–#${plan.boundary})` };
        });
        ui.lastError = null;
        checkAfter = before0;
    } catch (e) {
        if (e instanceof Cancelled) { if (state() === st) { st.autoLast = { at: Date.now(), result: '취소됨 (다음 응답 뒤 다시 시도)' }; render(); } }
        else {
            console.error('[SavePoint] auto', e, e.detail || '');
            if (state() === st) noteAuto(st, '실패: ' + errorText(e), { end });
        }
    } finally {
        endRun(run);
        if (checkAfter && state() === st) queueCheck(st, checkAfter);
    }
}

// ───────── record check (AI, warnings only) ─────────
//
// After a batch is saved, one extra call looks for contradictions between the changed state
// records and the journal, and for misreadings of the original messages. Nothing is changed:
// each finding shows the two conflicting sentences and the evidence, with "편집" or "무시".

// The message numbers behind a record, a point (g2.4) or a part outline (g2).
function evidenceOf(mem, id) {
    const ints = l => (l || []).filter(Number.isInteger);
    if (/^r\d+$/.test(id)) { const r = mem.records.find(x => x.id === id); return r ? [...ints(r.msgs), ...(r.terms ? [r.terms.msg] : [])] : []; }
    const [gid, j] = String(id).split('.');
    for (const sc of mem.scenes) for (const g of sc.segs) {
        if (g.id !== gid) continue;
        if (j === undefined) return g.points.flatMap(p => ints(p.msgs));
        return ints(g.points[Number(j)]?.msgs);
    }
    return [];
}
// Does a line the check quotes as its counter-evidence really appear in what was sent?
function seenInSent(lines, sent) {
    const texts = Object.values(sent || {});
    const pieces = [];
    for (const l of lines || []) {
        const t = String(l || '');
        pieces.push(t.replace(/^[^:"“']{1,24}:\s*/, ''));
        for (const m of t.matchAll(/["“'‘]([^"”’]{12,}?)["”'’](?=[\s,.;)/]|$)/g)) pieces.push(m[1]);
    }
    return pieces.some(q => normQuote(q).length >= 12 && texts.some(tx => findQuote(tx, q)));
}
function checkInput(st, scope) {
    const mem = st.mem;
    const recs = mem.records.filter(r => scope.records.includes(r.id));
    const segIds = new Set(scope.segs);
    // Parts that the records point to count too.
    for (const r of recs) for (const g of r.src || []) segIds.add(g);
    const lines = [], ids = new Set(recs.map(r => r.id)), points = [];
    for (const sc of mem.scenes) for (const g of sc.segs) {
        if (!segIds.has(g.id)) continue;
        if (g.outline) { lines.push(`${g.id}: ${g.outline}`); ids.add(g.id); }
        g.points.forEach((p, j) => { lines.push(`${pointId(g, j)}: ${p.text}`); ids.add(pointId(g, j)); points.push(p); });
    }
    // Which original messages to show, most useful first:
    //   0. for a debt or promise with terms: EVERY message from its first to its last evidence,
    //      so a later change of terms (#52 between #48 and #54) is never left out. If any of these
    //      cannot be sent whole, that record is marked "근거 일부 누락 · 판단 보류", not checked;
    //   1. messages the changed records cite;
    //   2. every message of a point that shares one of those (a game point citing #10-#16 when the
    //      record cites #15), so the whole event is seen, not just its last line;
    //   3. the rest of the cited messages.
    const ints = l => (l || []).filter(Number.isInteger);
    const required = new Map();   // message -> record ids that need it whole
    const termLines = [];
    for (const r of recs) {
        if (r.type !== 'quest' || !r.terms) continue;
        const all = [...ints(r.msgs), r.terms.msg];
        for (let n = Math.min(...all); n <= Math.max(...all); n++) { if (!required.has(n)) required.set(n, []); required.get(n).push(r.id); }
        termLines.push(`${r.id} (#${r.terms.msg}): "${r.terms.quote}"\n  context: ${r.terms.context}`);
    }
    const tier1 = new Set(recs.flatMap(r => ints(r.msgs)));
    const tier2 = new Set();
    for (const p of points) { const m = ints(p.msgs); if (m.some(n => tier1.has(n))) m.forEach(n => tier2.add(n)); }
    const tier3 = new Set(points.flatMap(p => ints(p.msgs)));
    const asc = set => [...set].sort((x, y) => x - y);
    const order = [...new Set([...asc(required.keys()), ...asc(tier1), ...asc(tier2), ...asc(tier3)])];
    const fixed = lines.join('\n').length + termLines.join('\n').length + recs.reduce((n, r) => n + recordLine(mem, r, false).length + 8, 0) + 3500;
    const budget = Math.max(14000, Math.min(60000, num('inputChars', 5000, 1000000) - fixed));
    const shown = [], skipped = [], missing = new Map();   // record id -> message numbers not sent whole
    const miss = n => { for (const id of required.get(n) || []) { if (!missing.has(id)) missing.set(id, []); missing.get(id).push(n); } };
    let size = 0;
    const cover = {}, sent = {};   // message -> 'whole' | 'cut' | 'missing'; the text actually sent
    for (const n of order) {
        const m = chat()[n];
        if (!m) { miss(n); cover[n] = 'missing'; continue; }
        const cap = required.has(n) ? 6000 : tier1.has(n) || tier2.has(n) ? 2000 : 700;
        const text = cleanText(m.mes);
        const cut = text.length > cap;
        const line = `#${n} ${speaker(m)}: ${cut ? text.slice(0, cap) + ' [...cut]' : text}`;
        if (size + line.length > budget) { skipped.push(n); miss(n); cover[n] = 'missing'; continue; }
        if (cut) miss(n);
        cover[n] = cut ? 'cut' : 'whole'; sent[n] = cut ? text.slice(0, cap) : text;
        shown.push([n, line]); size += line.length;
    }
    shown.sort((x, y) => x[0] - y[0]);
    return { records: recs.map(r => `${r.id}: ${recordLine(mem, r, false)}`).join('\n'), journal: lines.join('\n'), terms: termLines.join('\n'),
        messages: shown.map(x => x[1]).join('\n\n'), notShown: skipped.sort((x, y) => x - y), missing, ids, cover, sent };
}
function queueCheck(st, before) {
    if (!settings().check || !settings().enabled) return;
    const scope = checkScope(before, st.mem);
    if (!scope.records.length && !scope.segs.length) return;
    setTimeout(() => { if (state() === st) runCheck(st, scope).catch(reportError); }, 300);
}
async function runCheck(st, scope) {
    if (ui.run) { st.check = { at: Date.now(), status: 'failed', reason: '다른 작업 중이라 건너뜀', scope, issues: [] }; persistSoon(); render(); return; }
    const input = checkInput(st, scope);
    if (!input.ids.size) return;
    const run = newRun(st, -1);
    const rev = st.rev;
    st.check = { at: Date.now(), status: 'running', scope, issues: [] }; render();
    try {
        ui.progress = '기록 확인'; render();
        const prompt = buildCheckPrompt({ names: names(), records: input.records, journal: input.journal, terms: input.terms, messages: input.messages, notShown: input.notShown });
        let result = null, errors = [], cKind = '';
        for (let attempt = 0; attempt < 2 && !result; attempt++) {
            const raw = await llm(attempt ? prompt + retryNote(errors, []) : prompt, run, { attempt, why: attempt ? cKind : '' });
            if (run.cancelled) throw new Cancelled('중지했어요.');
            let parsed = null;
            try { parsed = parseJson(raw); } catch { /* below */ }
            if (parsed) { const r = validateCheck(parsed, input.ids); errors = r.errors; if (!errors.length) result = r; }
            else errors = ['The reply was not valid JSON.'];
            cKind = replyKind(raw) || (!parsed ? 'JSON 해석 실패' : `형식 오류 ${errors.length}건`);
        }
        if (state() !== st) return;
        if (!result) { st.check = { at: Date.now(), status: 'failed', reason: `검사 응답: ${cKind}`, scope, issues: [] }; return; }
        if (st.rev !== rev) { st.check = { at: Date.now(), status: 'failed', reason: '검사 중 기억이 바뀜', scope, issues: [] }; return; }
        const stamp = Date.now().toString(36);
        const issues = result.issues.map((x, i) => ({ ...x, id: `c${stamp}${i}`, ignored: false,
            excerpt: x.msgs.map(n => chat()[n] ? `#${n} ${speaker(chat()[n])}: ${cleanText(chat()[n].mes).slice(0, 220)}` : '').filter(Boolean).slice(0, 2) }));
        // A finding is only as good as what the check could read. Look at the evidence of the
        // statement it names (and the other one, for "unclear"), not only the numbers it cites:
        // if any of it was cut or not sent, the finding is held back, unless a contradicting line
        // it quotes is really there in what was sent.
        for (const x of issues) {
            const need = [...new Set([...x.msgs, ...evidenceOf(st.mem, x.about), ...(x.also ? evidenceOf(st.mem, x.also) : [])])].sort((a, b) => a - b);
            const gaps = need.filter(n => input.cover[n] !== 'whole');
            if (!gaps.length) continue;
            const g = gaps.map(n => ({ n, how: input.cover[n] === 'cut' ? '일부만 보냄' : '못 보냄' }));
            if (x.kind === 'unclear') { x.gaps = g; continue; }   // already held back
            // Kept only when a sent line visibly says otherwise; "the messages don't say it" is not
            // provable while part of the evidence was not read.
            if (x.basis === 'contradicted' && seenInSent(x.conflict.slice(1), input.sent)) continue;
            x.was = x.kind; x.kind = 'partial'; x.gaps = g;
        }
        // Records whose evidence range could not be sent whole were not really checked.
        for (const [rid, nums] of input.missing) {
            const list = [...new Set(nums)].sort((a, b) => a - b);
            issues.push({ id: `c${stamp}p${rid}`, about: rid, kind: 'partial', ignored: false, msgs: list, conflict: [], excerpt: [],
                gaps: list.map(n => ({ n, how: input.cover[n] === 'cut' ? '일부만 보냄' : '못 보냄' })),
                problem: `근거 원문 ${list.map(n => '#' + n).join(', ')}을(를) 길이 한도 때문에 온전히 보내지 못해서 이 기록은 확인하지 못했어요. 입력 한도를 늘리거나 직접 확인해 주세요.` });
        }
        const sentNums = Object.keys(input.cover).map(Number);
        const coverage = { sent: sentNums.filter(n => input.cover[n] !== 'missing').length,
            cut: sentNums.filter(n => input.cover[n] === 'cut').sort((a, b) => a - b), missing: sentNums.filter(n => input.cover[n] === 'missing').sort((a, b) => a - b) };
        st.check = { at: Date.now(), status: issues.length ? 'issues' : 'ok', scope, issues, coverage };
    } catch (e) {
        if (state() === st) st.check = { at: Date.now(), status: 'failed', reason: e instanceof Cancelled ? '취소됨' : errorText(e), scope, issues: [] };
    } finally {
        endRun(run);
        if (state() === st) { persistSoon(); render(); }
    }
}
const gapText = gaps => gaps.map(g => `#${g.n} ${g.how}`).join(', ');
const CHECK_KIND = { misread: '원문과 다름', unclear: '충돌 · 판단 보류', partial: '근거 일부 누락 · 판단 보류', contradiction: '모순' };
const ABOUT_LABEL = (mem, about) => {
    if (/^r\d+$/.test(about)) {
        const r = mem.records.find(x => x.id === about);
        return r ? `${({ party: '파티', item: '인벤토리', quest: '퀘스트', world: '월드' })[r.type]} ${about}` : `${about} (지워짐)`;
    }
    return /\./.test(about) ? `포인트 ${about}` : `구간 ${about} 개요`;
};
// Everything shown in the status area, as plain text to paste instead of screenshots.
function statementText(mem, id) {
    if (/^r\d+$/.test(id)) { const r = mem.records.find(x => x.id === id); return r ? recordLine(mem, r, false) : '(지워짐)'; }
    const [gid, j] = String(id).split('.');
    for (const sc of mem.scenes) for (const g of sc.segs) if (g.id === gid) return j === undefined ? (g.outline || '') : (g.points[Number(j)]?.text || '(지워짐)');
    return '(지워짐)';
}
function reportText(st) {
    const out = [`SavePoint v${VERSION} · 요약 AI: ${profileLabel()}`];
    if (hasChat()) out.push(`방: ${names().char || ''} · 기록 ${st ? st.lastIndex + 1 : 0} / ${chat().length}`);
    if (ui.lastFix) out.push('', `[자동 보정] ${ui.lastFix.range} · ${ui.lastFix.text}`);
    if (ui.lastError) {
        out.push('', `[마지막 실패] ${ui.lastError.range} · ${new Date(ui.lastError.at).toLocaleString()}`);
        for (const d of groupErrors(ui.lastError.detail)) out.push(`- ${d}`);
    }
    const c = st?.check;
    if (c && c.status !== 'running') {
        const all = c.issues || [];
        const state = c.status === 'failed' ? `실패 (${c.reason || ''})` : all.filter(x => !x.ignored).length ? `확인 필요 ${all.filter(x => !x.ignored).length}건` : '문제 없음';
        out.push('', `[기록 확인] ${new Date(c.at).toLocaleString()} · ${state}`);
        if (c.coverage) out.push(`보낸 원문 ${c.coverage.sent}개 · 일부만 보냄: ${c.coverage.cut.map(n => '#' + n).join(', ') || '없음'} · 못 보냄: ${c.coverage.missing.map(n => '#' + n).join(', ') || '없음'}`);
        all.forEach((x, i) => {
            out.push('', `${i + 1}. [${CHECK_KIND[x.kind] || x.kind}]${x.ignored ? ' (무시함)' : ''} ${ABOUT_LABEL(st.mem, x.about)}${x.also ? ` ↔ ${ABOUT_LABEL(st.mem, x.also)}` : ''}`);
            out.push(`   대상: ${statementText(st.mem, x.about)}`);
            if (x.also) out.push(`   상대: ${statementText(st.mem, x.also)}`);
            out.push(`   이유: ${x.problem}`);
            if (x.basis && x.kind !== 'partial' || x.was) out.push(`   AI 판단: ${CHECK_KIND[x.was || x.kind] || x.was || x.kind}${x.basis ? ` · ${x.basis === 'contradicted' ? '원문이 다르게 말함' : '원문에 없음'}` : ''}`);
            if (x.gaps?.length) out.push(`   판단 보류 이유: ${gapText(x.gaps)}`);
            x.conflict.forEach(t => out.push(`   인용: "${t}"`));
            if (x.msgs.length) out.push(`   근거 번호: ${x.msgs.map(n => '#' + n).join(', ')}`);
        });
    }
    return out.join('\n');
}
async function copyReport() {
    const text = reportText(state());
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall back */ }
    if (!ok) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove();
        } catch { /* fall back */ }
    }
    if (ok) { ui.copyText = null; toastr.success('확인 결과를 복사했어요. 그대로 붙여 넣으면 돼요.', 'SavePoint'); }
    else { ui.copyText = text; toastr.info('자동 복사가 막혀서 아래 칸에 띄웠어요. 길게 눌러 전체 선택 후 복사해 주세요.', 'SavePoint'); }
    render();
}
function checkHtml(st) {
    const c = st?.check;
    if (!c || !settings().check) return '';
    const at = new Date(c.at).toLocaleTimeString();
    if (c.status === 'running') return '';
    if (c.status === 'failed') return `<div class="sp-hud-meta"><span class="sp-warn">기록 확인 실패 (${esc(c.reason || '')}) · ${at}</span>${btn('check-rerun', '', '다시 확인')}</div>`;
    const open = c.issues.filter(x => !x.ignored);
    if (!open.length) return `<div class="sp-hud-meta"><span class="sp-dim">기록 확인: 문제 없음 · ${at}</span></div>`;
    return `<details class="sp-checks" data-group="hud-checks" ${ui.savesOpen.get('hud-checks') ? 'open' : ''}><summary class="sp-warn">⚠ 확인 필요 ${open.length}건 · ${at}</summary><div class="sp-scroll">${open.map(x => `<div class="sp-check">
        <div><span class="sp-kind">${CHECK_KIND[x.kind] || '모순'}</span> <b>${esc(ABOUT_LABEL(st.mem, x.about))}</b>${x.also ? ` ↔ <b>${esc(ABOUT_LABEL(st.mem, x.also))}</b>` : ''} — ${esc(x.problem)}</div>
        ${x.gaps?.length ? `<div class="sp-gaps">판단 보류 이유: ${esc(gapText(x.gaps))}${x.was ? ` · AI 원래 판단: ${esc(CHECK_KIND[x.was] || x.was)}` : ''}</div>` : ''}
        ${x.conflict.map(t => `<div class="sp-quote">“${esc(t)}”</div>`).join('')}
        ${x.excerpt.map(t => `<div class="sp-excerpt">${esc(t)}</div>`).join('')}
        <div class="sp-row">${btn('check-edit', x.id, x.also ? `편집: ${ABOUT_LABEL(st.mem, x.about)}` : '편집')}${x.also ? btn('check-edit-also', x.id, `편집: ${ABOUT_LABEL(st.mem, x.also)}`) : ''}${btn('check-ignore', x.id, '무시')}</div></div>`).join('')}</div></details>`;
}
function editAbout(about) {
    const mem = state().mem;
    if (/^r\d+$/.test(about)) {
        const r = mem.records.find(x => x.id === about);
        if (!r) return toastr.info('그 항목은 이미 지워졌어요.');
        ui.tab = ({ party: 'party', item: 'items', quest: 'quests', world: 'world' })[r.type];
        return startEdit('record', about);
    }
    const [gid, j] = about.split('.');
    const sc = mem.scenes.find(x => x.segs.some(g => g.id === gid));
    if (!sc) return toastr.info('그 구간은 이미 지워졌어요.');
    ui.tab = 'journal';
    return j === undefined ? startEdit('segoutline', `${sc.id}|${gid}`) : startEdit('point', `${sc.id}|${gid}|${j}`);
}

// ───────── translation (view only) ─────────

function translationTargets(mem) {
    const items = [];
    for (const s of mem.scenes) {
        if (!s.koTitle) items.push({ id: `${s.id}|title`, text: s.title });
        if (s.legacyOutline && !s.koOutline) items.push({ id: `${s.id}|outline`, text: s.legacyOutline });
        for (const g of s.segs) {
            if (g.notes && !g.koNotes) items.push({ id: `${s.id}|${g.id}|notes`, text: g.notes });
            if (g.outline && !g.koOutline) items.push({ id: `${s.id}|${g.id}|outline`, text: g.outline });
            g.points.forEach((p, i) => { if (!p.ko) items.push({ id: `${s.id}|${g.id}|p${i}`, text: p.text }); });
        }
    }
    for (const r of mem.records) if (!r.ko) items.push({ id: `${r.id}|rec`, text: r.text });
    return items;
}
function applyTranslation(mem, id, ko) {
    const [a, b, c] = id.split('|');
    if (b === 'rec') { const r = mem.records.find(x => x.id === a); if (r) r.ko = ko; return; }
    const s = mem.scenes.find(x => x.id === a);
    if (!s) return;
    if (b === 'title') s.koTitle = ko;
    else if (b === 'outline') s.koOutline = ko;
    else {
        const g = s.segs.find(x => x.id === b);
        if (!g) return;
        if (c === 'notes') g.koNotes = ko;
        else if (c === 'outline') g.koOutline = ko;
        else if (/^p\d+$/.test(c) && g.points[Number(c.slice(1))]) g.points[Number(c.slice(1))].ko = ko;
    }
}
async function translate() {
    if (ui.run) return;
    const st = state();
    if (!st || !hasMemory(st.mem)) { toastr.info('번역할 기억이 없어요.'); return; }
    const items = translationTargets(st.mem);
    if (!items.length) { toastr.info('모든 항목에 한국어 보기가 있어요.'); return; }
    const batches = [];
    let cur = [], size = 0;
    for (const it of items) {
        if (cur.length && (cur.length >= 40 || size + it.text.length > 9000)) { batches.push(cur); cur = []; size = 0; }
        cur.push(it); size += it.text.length;
    }
    if (cur.length) batches.push(cur);
    const run = newRun(st, -1);
    let next = clone(st.mem), count = 0;
    const rev = st.rev;
    try {
        for (let i = 0; i < batches.length; i++) {
            ui.progress = `한국어 보기 만드는 중… ${i + 1}/${batches.length}`; render();
            const res = parseJson(await llm(TRANSLATE_PROMPT + JSON.stringify(batches[i]), run), '[', ']');
            if (run.cancelled || state() !== st || st.rev !== rev) throw new Cancelled('기억이 바뀌어서 번역을 적용하지 않았어요.');
            if (Array.isArray(res)) for (const x of res) if (x && typeof x.id === 'string' && typeof x.ko === 'string' && x.ko.trim()) { applyTranslation(next, x.id, x.ko.trim()); count++; }
        }
        await transact(() => {
            const before = st.mem;
            st.mem = next; pushHistory(st, before, next, { kind: 'edit' });
        });
        settings().showKo = true; saveSettings();
        toastr.success(`${count}개 항목의 한국어 보기를 만들었어요.`);
    } catch (e) {
        if (e instanceof Cancelled) toastr.info(e.message); else reportError(e);
    } finally { endRun(run); }
}

// ───────── re-choosing key points (no re-collection) ─────────

async function rekeyScenes(ids) {
    if (ui.run || !ids.length) { if (!ids.length) toastr.info('다시 고를 장면이 없어요.'); return; }
    const st = state();
    if (!st) return;
    const run = newRun(st, -1);
    const rev = st.rev;
    const results = [];
    let failed = 0;
    try {
        for (let i = 0; i < ids.length; i++) {
            const scene = st.mem.scenes.find(x => x.id === ids[i]);
            if (!scene) continue;
            const items = rekeyItems(scene);
            if (!items.length) continue;
            ui.progress = `주입 포인트 고르는 중… ${i + 1}/${ids.length} (${scene.title})`; render();
            const stateText = st.mem.records.map(r => recordLine(st.mem, r, false)).join('\n').slice(0, 8000);
            const prompt = buildRekeyPrompt({ names: names(), scene: { ...scene, outlineText: sceneOutlineText(scene) }, state: stateText, items });
            const allIds = items.map(x => x.id);
            let keys = null, errors = [];
            for (let attempt = 0; attempt < 2 && !keys; attempt++) {
                const raw = await llm(attempt ? prompt + retryNote(errors, []) : prompt, run, { attempt, why: attempt ? '형식 오류' : '' });
                if (run.cancelled) throw new Cancelled('중지했어요.');
                try { const d = parseJson(raw); errors = validateRekey(d, allIds); if (!errors.length) keys = d.keys; }
                catch (e) { errors = ['The reply was not valid JSON.']; }
            }
            if (keys) results.push([scene.id, keys]); else failed++;
        }
        if (state() !== st || st.rev !== rev) throw new Cancelled('기억이 바뀌어서 적용하지 않았어요.');
        if (results.length) {
            await transact(() => {
                const before = st.mem;
                let next = before;
                for (const [sid, keys] of results) next = applyRekey(next, sid, keys);
                st.mem = next; pushHistory(st, before, next, { kind: 'edit' });
            });
        }
        refreshInjection();
        toastr[failed ? 'warning' : 'success'](`주입 포인트를 다시 골랐어요 (장면 ${results.length}개${failed ? `, 실패 ${failed}개` : ''}). 직접 지정한 포인트는 그대로예요.`);
    } catch (e) {
        if (e instanceof Cancelled) toastr.info(e.message); else reportError(e);
    } finally { endRun(run); }
}

// ───────── edits & undo ─────────

async function commitEdit(mutate, { undoable = true } = {}) {
    if (!hasChat()) return false;
    return transact(() => {
        const st = ensureState();
        const before = st.mem, next = clone(st.mem);
        if (mutate(next) === false) return false;
        st.mem = next; pushHistory(st, before, next, { kind: 'edit' });
    }, { undoable });
}
async function undo() {
    const st = state();
    if (!st?.undo || ui.run) return;
    const restored = { ...clone(st.undo), undo: null };
    await transact(() => { ctx().chatMetadata[MODULE] = restored; }, { undoable: false });
    if (!reconcile()) { render(); return; }
    toastr.info('⏪ 리와인드: 마지막 작업 전으로 돌아갔어요.');
}
async function clearRoom() {
    const st = state();
    if (!st || !(await confirmBox('리셋: 이 방의 기억을 모두 지울까요? 세이브 슬롯은 남아요. (⏪ 리와인드로 되돌릴 수 있어요)'))) return;
    await transact(() => { ctx().chatMetadata[MODULE] = freshState({ autoMark: chat().length - 1 }); });
}

// ───────── save slots (server files via vault.js) ─────────
//
// Slots and autosaves live as files in the SillyTavern server's user files folder. The server's
// savepoint-index.json is the list; settings.slotCache is only a copy of it for quick display.
// When the server cannot be written, a slot is kept in settings.localSaves (with its memory) and
// moved to the server on a later start.

function serverHeaders() {
    const c = ctx();
    return typeof c.getRequestHeaders === 'function' ? c.getRequestHeaders() : { 'Content-Type': 'application/json' };
}
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
const serverIO = {
    async put(name, obj) {
        const r = await fetch('/api/files/upload', { method: 'POST', headers: serverHeaders(), body: JSON.stringify({ name, data: toBase64(JSON.stringify(obj)) }) });
        if (!r.ok) throw new Error(`서버에 ${name}을(를) 쓰지 못했어요 (${r.status})`);
    },
    async get(name) {
        const r = await fetch(`/user/files/${name}?t=${Date.now()}`, { cache: 'no-store', headers: serverHeaders() });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`서버에서 ${name}을(를) 읽지 못했어요 (${r.status})`);
        try { return JSON.parse(await r.text()); } catch { return null; }
    },
    async del(name) {
        const r = await fetch('/api/files/delete', { method: 'POST', headers: serverHeaders(), body: JSON.stringify({ path: `user/files/${name}` }) });
        if (!r.ok && r.status !== 404) throw new Error(`서버에서 ${name}을(를) 지우지 못했어요 (${r.status})`);
    },
    async exists(names) {
        const urls = names.map(n => `user/files/${n}`);
        const r = await fetch('/api/files/verify', { method: 'POST', headers: serverHeaders(), body: JSON.stringify({ urls }) });
        if (!r.ok) throw new Error(`서버 파일 확인 실패 (${r.status})`);
        const res = await r.json();
        return Object.fromEntries(names.map((n, i) => [n, !!res[urls[i]]]));
    },
};
const vault = new Vault(serverIO, { onChange: list => { settings().slotCache = list; saveSettings(); render(); } });

function localSaves() { return settings().localSaves; }
function listSaves() {
    const listed = vault.ready && vault.online ? vault.entries : settings().slotCache;
    return [...listed, ...Object.values(localSaves()).map(r => ({ ...r, local: true }))].sort((a, b) => b.updated - a.updated);
}
function findSave(id) { return listSaves().find(x => x.id === id) || null; }
async function readSave(entry) {
    if (entry.local) return localSaves()[entry.id];
    return vault.read(entry);
}
function saveRecord(st, name, id = newId(), auto = false) {
    const ci = charInfo();
    const prev = findSave(id);
    return {
        id, name, auto, room: st.roomKey, roomHash: roomHash(st.roomKey), char: ci?.name || '', created: prev?.created || Date.now(), updated: Date.now(),
        stats: memStats(st.mem), msgCount: st.lastIndex + 1,
        pos: { lastIndex: st.lastIndex, digest: digest(st.hashes) }, mem: clone(st.mem), version: VERSION,
    };
}
// Store on the server; if that fails, keep it in settings and say so.
async function storeSave(record) {
    try {
        if (!vault.ready || !vault.online) throw new Error(vault.error || '서버 저장소를 쓸 수 없어요');
        const meta = await vault.put(record, { keepRooms: num('autoKeep', 1, 500) });
        delete localSaves()[record.id];
        if (record.auto) for (const k of Object.keys(localSaves())) if (localSaves()[k].auto && localSaves()[k].roomHash === record.roomHash) delete localSaves()[k];
        saveSettings();
        return { meta, local: false };
    } catch (e) {
        console.warn('[SavePoint] server save failed', e);
        if (record.auto) for (const k of Object.keys(localSaves())) if (localSaves()[k].auto && localSaves()[k].roomHash === record.roomHash) delete localSaves()[k];
        localSaves()[record.id] = record;
        saveSettings(); render();
        return { meta: record, local: true, error: e };
    }
}
// Old settings slots and slots kept locally because the server failed: move them to the server.
async function migrateLocal() {
    if (!vault.online) return;
    const list = Object.values(localSaves());
    for (const rec of list) {
        const r = { ...rec };
        if (r.auto && !r.roomHash) r.roomHash = roomHash(r.room);
        try { await vault.put(r, { keepRooms: num('autoKeep', 1, 500) }); delete localSaves()[rec.id]; saveSettings(); }
        catch (e) { console.warn('[SavePoint] migrate failed', rec.id, e); break; }
    }
    render();
}
let autosaveTimer = null;
function autosave(st) {
    if (!st || !hasMemory(st.mem) || roomKey() !== st.roomKey) return;
    clearTimeout(autosaveTimer);
    const key = st.roomKey;
    // Bursts (several edits in a row) become one autosave.
    autosaveTimer = setTimeout(() => {
        const cur = state();
        if (!cur || cur.roomKey !== key || roomKey() !== key || !hasMemory(cur.mem)) return;
        const rh = roomHash(key);
        storeSave(saveRecord(cur, `오토세이브 · ${charInfo()?.name || ''}`, `auto_${rh}_${Date.now().toString(36)}`, true));
    }, 1200);
}
async function saveNew() {
    const st = state();
    if (!st || !hasMemory(st.mem)) { toastr.info('저장할 기억이 없어요.'); return; }
    const name = await askText('세이브 슬롯 이름', `${charInfo()?.name || 'Save'} · ${memStats(st.mem).lastTitle || ''}`.slice(0, 60));
    if (!name) return;
    const res = await storeSave(saveRecord(st, name));
    st.linkedSave = res.meta.id; persistSoon(); render();
    if (res.local) toastr.warning(`"${name}"을(를) 설정에만 저장했어요. 서버 백업 실패: ${res.error?.message || ''}`);
    else toastr.success(`"${name}"에 저장했어요.`);
}
async function overwriteSave(id) {
    const st = state(), old = findSave(id);
    if (!st || !old || old.auto || !hasMemory(st.mem)) return;
    if (!(await confirmBox(`"${old.name}" 슬롯을 지금 기억으로 덮어쓸까요?`))) return;
    const res = await storeSave(saveRecord(st, old.name, id));
    st.linkedSave = id; persistSoon(); render();
    if (res.local) toastr.warning(`설정에만 저장했어요. 서버 백업 실패: ${res.error?.message || ''}`);
    else toastr.success(`"${old.name}"에 저장했어요.`);
}
async function loadSave(id, mode) {
    if (ui.run) return;
    const save = findSave(id);
    if (!save || !hasChat()) return;
    let mem;
    try { mem = cleanMem((await readSave(save))?.mem); } catch (e) { reportError(e); return; }
    const cur = state();
    if (cur && hasMemory(cur.mem) && !(await confirmBox('이 방의 지금 기억을 이 세이브 슬롯으로 바꿀까요? (⏪ 리와인드로 되돌릴 수 있어요)'))) return;
    const st = freshState({ mem, linkedSave: mode === 'continue' && !save.auto ? id : null, autoMark: chat().length - 1 });
    const p = save.pos;
    let exact = false;
    if (p && Number.isInteger(p.lastIndex) && p.lastIndex >= 0 && p.lastIndex < chat().length) {
        const h = hashesTo(p.lastIndex);
        if (digest(h) === p.digest) { exact = true; st.lastIndex = p.lastIndex; st.hashes = h; st.floor = p.lastIndex; }
    }
    if (!exact) st.mem = detachMem(mem);
    try { await transact(() => { ctx().chatMetadata[MODULE] = st; }); }
    catch (e) { reportError(e); return; }
    toastr.success(exact ? `저장 당시 위치(#${st.lastIndex})로 돌아갔어요. 그 뒤 메시지는 미기록이에요.`
        : `불러왔어요. 원문이 저장 당시와 달라서 기억만 가져왔고, 이 방의 메시지 ${pendingCount()}개는 미기록이에요.`, 'SavePoint');
}
async function renameSave(id) {
    const save = findSave(id);
    if (!save) return;
    const name = await askText(save.auto ? '이름 (이름을 붙이면 세이브 슬롯으로 따로 보관돼요)' : '새 이름', save.auto ? '' : save.name);
    if (!name) return;
    try {
        if (save.local) { const r = localSaves()[id]; r.name = name; if (r.auto) { r.auto = false; } saveSettings(); render(); return; }
        await vault.rename(id, name, newId());
    } catch (e) { reportError(e); }
}
async function deleteSave(id) {
    const save = findSave(id);
    if (!save || !(await confirmBox(`"${save.name}"을(를) 삭제할까요? 서버 파일도 지워지고 되돌릴 수 없어요.`))) return;
    try {
        if (save.local) { delete localSaves()[id]; saveSettings(); }
        else await vault.remove(id);
    } catch (e) { reportError(e); return; }
    if (state()?.linkedSave === id) { state().linkedSave = null; persistSoon(); }
    render();
}

// ───────── 세이브 내보내기 / 가져오기 / 백업 찾기 / 복구 ─────────

function download(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const safe = t => String(t || 'save').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
async function exportSave(id) {
    const save = findSave(id);
    if (!save) return;
    try {
        const rec = await readSave(save);
        download({ format: 'savepoint', version: VERSION, saves: [rec] }, `savepoint_${safe(save.name)}_${stamp()}.json`);
    } catch (e) { reportError(e); }
}
function exportRoom() {
    const st = state();
    if (!st || !hasMemory(st.mem)) { toastr.info('내보낼 기억이 없어요.'); return; }
    const rec = saveRecord(st, `${charInfo()?.name || ''} ${new Date().toLocaleString()}`);
    download({ format: 'savepoint', version: VERSION, saves: [rec] }, `savepoint_${safe(charInfo()?.name)}_${stamp()}.json`);
}
async function importFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { toastr.error('JSON 파일을 읽지 못했어요.'); return; }
    if (data?.format !== 'savepoint' || !Array.isArray(data.saves)) { toastr.error('SavePoint 세이브 파일이 아니에요.'); return; }
    let n = 0, local = 0;
    for (const raw of data.saves) {
        try {
            const mem = cleanMem(raw.mem);
            const { roomHash: _r, k: _k, file: _f, ...rest } = raw;
            const res = await storeSave({ ...rest, id: newId(), auto: false, mem, name: String(raw.name || '가져온 세이브'), updated: Date.now(), created: raw.created || Date.now(), stats: memStats(mem), version: raw.version || VERSION });
            n++; if (res.local) local++;
        } catch (e) { console.warn('[SavePoint] import skipped', e); }
    }
    render();
    if (!n) toastr.error('가져올 수 있는 세이브가 없었어요.');
    else toastr[local ? 'warning' : 'success'](`세이브 슬롯 ${n}개를 가져왔어요.${local ? ` (${local}개는 서버 백업 실패로 설정에만 저장)` : ''}`);
}
const FOUND_SOURCE = { index: '목록', prev: '이전 목록', room: '이 방 오토세이브 이름' };
async function findBackups() {
    if (!vault.online) { toastr.warning('서버 저장소에 연결할 수 없어요.'); return; }
    ui.found = { loading: true, list: [] }; ui.tab = 'saves'; render(true);
    try {
        const list = await vault.find(hasChat() ? roomHash(roomKey()) : null);
        ui.found = { loading: false, list, at: Date.now() };
    } catch (e) { ui.found = null; reportError(e); }
    render(true);
}
async function restoreBackup(file) {
    const item = ui.found?.list.find(x => x.file === file);
    if (!item) return;
    const same = vault.entries.find(e => e.id === item.id || e.file === item.file);
    if (same && !(await confirmBox(`"${same.name}" 슬롯이 이미 있어요. 백업 내용으로 바꿀까요?`))) return;
    try {
        await vault.restore(item);
        item.listed = true;
        toastr.success(`"${item.name}"을(를) 복구했어요. 💾 목록에서 불러올 수 있어요.`);
    } catch (e) { reportError(e); }
    render(true);
}

// ───────── small helpers ─────────

function esc(t) { return String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function reportError(e) { console.error('[SavePoint]', e); toastr.error(errorText(e), 'SavePoint'); }
async function askText(title, value = '') {
    const c = ctx();
    const r = await c.callGenericPopup(esc(title), c.POPUP_TYPE.INPUT, value);
    return typeof r === 'string' ? r.trim() : '';
}
async function confirmBox(text) {
    const c = ctx();
    return !!(await c.callGenericPopup(esc(text), c.POPUP_TYPE.CONFIRM));
}
const fmtDate = ts => { try { return new Date(ts).toLocaleString(); } catch { return ''; } };
const showKo = () => !!settings().showKo;
const T = (en, ko) => (showKo() && ko ? ko : en);

// ───────── UI ─────────

function openWindow() {
    if (!$('#sp_overlay').length) $('body').append('<div id="sp_overlay" class="sp-overlay"><div class="sp-window"></div></div>');
    ui.open = true;
    $('#sp_overlay').css('display', 'flex');
    render(true);
}
function closeWindow() { ui.open = false; ui.edit = null; $('#sp_overlay').hide(); }

// Message numbers as compact ranges (#50–54), shown on their own line under the text.
function evidenceText(msgs) {
    const nums = [...new Set((msgs || []).filter(Number.isInteger))].sort((x, y) => x - y);
    const refs = (msgs || []).filter(m => !Number.isInteger(m));
    const out = [];
    for (let i = 0; i < nums.length; i++) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] <= nums[j] + 2) j++;
        out.push(j > i ? `#${nums[i]}–${nums[j]}` : `#${nums[i]}`);
        i = j;
    }
    return [...out, ...refs.map(String)];
}
function evidenceChips(msgs) {
    const list = evidenceText(msgs);
    if (!list.length) return '';
    const shown = list.slice(0, 3).map(x => `<span class="sp-ev">${esc(x)}</span>`).join('');
    return `<span class="sp-evs" title="근거 메시지: ${esc(list.join(', '))}">${shown}${list.length > 3 ? `<span class="sp-ev">+${list.length - 3}</span>` : ''}</span>`;
}
function whoChips(mem, ids) {
    return (ids || []).map(id => `<span class="sp-chip">${esc(entityName(mem, id))}</span>`).join('');
}
function tools(btns) { return `<span class="sp-tools">${btns.join('')}</span>`; }
function btn(act, id, label, title = '', extra = '') {
    return `<button class="sp-btn sp-mini ${extra}" data-act="${act}" data-id="${esc(id)}" title="${esc(title)}">${label}</button>`;
}
function rangeOf(s) {
    if (s.external) return '다른 방에서 가져옴';
    const a = s.segs[0]?.from, b = s.segs[s.segs.length - 1]?.to;
    return Number.isInteger(a) && Number.isInteger(b) ? `#${a}–#${b}` : '';
}
function editForm() {
    const e = ui.edit, v = e.values;
    const st = state();
    const field = (k, label, rows = 1) => rows > 1
        ? `<label class="sp-f"><span>${label}</span><textarea data-edit="${k}" rows="${rows}">${esc(v[k])}</textarea></label>`
        : `<label class="sp-f"><span>${label}</span><input data-edit="${k}" value="${esc(v[k])}"></label>`;
    const select = (k, label, opts) => `<label class="sp-f"><span>${label}</span><select data-edit="${k}">${opts.map(([val, txt]) => `<option value="${esc(val)}" ${String(v[k] ?? '') === String(val) ? 'selected' : ''}>${esc(txt)}</option>`).join('')}</select></label>`;
    const ents = type => [['', '(없음)'], ...st.mem.entities.filter(x => !type || x.type === type).map(x => [x.id, x.name])];
    let body = '';
    if (e.kind === 'scene') body = field('title', '제목') + field('where', '장소');
    else if (e.kind === 'segoutline') body = field('outline', '이 구간 개요 (영어)', 3);
    else if (e.kind === 'legacy') body = field('outline', '이전 버전 장면 개요 (영어)', 4);
    else if (e.kind === 'point') body = field('text', '포인트 (영어)', 3);
    else if (e.kind === 'notes') body = field('notes', '상세 노트 (영어)', 7);
    else if (e.kind === 'entity') body = field('name', '이름 (영어)') + field('aliases', '별칭 (쉼표로 구분, 원문 표기 그대로)') + select('type', '종류', ENTITY_TYPES.map(t => [t, KIND_KO[t]]));
    else if (e.kind === 'record') {
        const t = v.type;
        if (t === 'party') body = select('entity', '인물', ents('person')) + select('aspect', '항목', [['relation', '관계'], ['condition', '상태']]);
        if (t === 'item') body = select('entity', '물건', ents('item')) + select('holder', '가진 사람', ents('person'));
        if (t === 'quest') body = select('kind', '종류', QUEST_KINDS.map(k => [k, KIND_KO[k]])) + select('status', '상태', [['open', '진행 중'], ['done', '완료'], ['failed', '실패']]);
        if (t === 'world') body = select('kind', '종류', WORLD_KINDS.map(k => [k, KIND_KO[k]]));
        body += field('text', '내용 (영어)', 3);
    }
    return `<div class="sp-edit">${body}<div class="sp-row">${btn('edit-save', '', '저장', '', 'sp-primary')}${btn('edit-cancel', '', '취소')}</div></div>`;
}
const isEditing = (kind, id) => ui.edit && ui.edit.kind === kind && ui.edit.id === id;

function journalHtml(st) {
    const mem = st.mem;
    if (!mem.scenes.length) return `<div class="sp-empty">아직 기록된 장면이 없어요.<br>장면이 끝나면 <b>체크포인트</b>에서 자동으로 기록되고, <b>퀵세이브</b>로 바로 기록할 수도 있어요.</div>`;
    return [...mem.scenes].map((s, i) => ({ s, no: i + 1 })).reverse().map(({ s, no }) => {
        const pts = s.segs.flatMap(g => g.points.map((p, j) => ({ g, p, j })));
        const head = `<div class="sp-scene-head"><span class="sp-no">SCENE ${String(no).padStart(2, '0')}</span><span class="sp-range">${esc(rangeOf(s))}</span>
            ${s.status === 'open' ? '<span class="sp-badge sp-live">진행 중</span>' : ''}
            ${tools([btn('star', s.id, s.star ? '★' : '☆', '메인 사건 표시', s.star ? 'sp-on' : ''), btn('pin', s.id, '📌', '항상 핵심 한 줄 주입', s.pin ? 'sp-on' : ''),
                btn('edit-scene', s.id, '✎', '제목·장소 편집'), btn('del-scene', s.id, '🗑', '삭제')])}</div>`;
        if (isEditing('scene', s.id)) return `<div class="sp-card sp-scene">${head}${editForm()}</div>`;
        const pointHtml = ({ g, p, j }) => isEditing('point', `${s.id}|${g.id}|${j}`) ? editForm()
            : `<li class="sp-pt sp-${p.kind} ${pointInjected(p) ? 'sp-inj' : 'sp-stored'}">${btn('key-toggle', `${s.id}|${g.id}|${j}`, pointInjected(p) ? '●' : '○',
                (pointInjected(p) ? '주입 중' : '저장만') + (typeof p.keyUser === 'boolean' ? ' (직접 지정, 누르면 바꿈)' : typeof p.key === 'boolean' ? ' (AI 선택, 누르면 직접 지정)' : ' (예전 기록: 전부 주입)'),
                'sp-key' + (typeof p.keyUser === 'boolean' ? ' sp-key-user' : ''))}<span class="sp-pk" title="${p.kind === 'change' ? '상태 변화' : '기억할 순간'}">${p.kind === 'change' ? '◆' : '◇'}</span>
                <span class="sp-pt-t">${esc(T(p.text, p.ko))}${(() => { const d = pointInjected(p) ? dupState(s, p) : null; return d === 'exact' && p.keyUser !== true ? '<span class="sp-dup" title="개요에 같은 문장이 있어서 이번 주입에서는 빼요 (●를 직접 누르면 넣어요)">개요와 같음 · 주입 생략</span>' : d === 'near' ? '<span class="sp-dup" title="개요와 많이 겹쳐요. 필요 없으면 ○로 바꿔 주세요">중복 후보</span>' : ''; })()}${evidenceChips(p.msgs)}</span>
                ${tools([btn('edit-point', `${s.id}|${g.id}|${j}`, '✎'), btn('del-point', `${s.id}|${g.id}|${j}`, '🗑')])}</li>`;
        // One block per part: its own outline (never rewritten later), its points, its notes.
        const segHtml = s.segs.map(g => {
            const list = g.points.map((p, j) => pointHtml({ g, p, j })).join('');
            const outline = isEditing('segoutline', `${s.id}|${g.id}`) ? editForm()
                : g.outline ? `<div class="sp-seg-outline">${esc(T(g.outline, g.koOutline))} ${tools([btn('edit-segoutline', `${s.id}|${g.id}`, '✎', '이 구간 개요 편집')])}</div>` : '';
            const notes = !g.notes ? '' : isEditing('notes', `${s.id}|${g.id}`) ? editForm()
                : `<details class="sp-notes"><summary>상세 노트 ${tools([btn('edit-notes', `${s.id}|${g.id}`, '✎')])}</summary><p>${esc(T(g.notes, g.koNotes))}</p></details>`;
            return `<div class="sp-seg"><div class="sp-seg-h">${esc(g.id)} ${Number.isInteger(g.from) ? `#${g.from}–#${g.to}` : ''}</div>${outline}<ul class="sp-pts">${list}</ul>${notes}</div>`;
        }).join('');
        const legacy = !s.legacyOutline ? '' : isEditing('legacy', s.id) ? editForm()
            : `<div class="sp-legacy"><span class="sp-badge">이전 버전 개요</span> ${esc(T(s.legacyOutline, s.koOutline))} ${tools([btn('edit-legacy', s.id, '✎', '이전 버전 개요 편집')])}</div>`;
        const outlineText = sceneOutlineParts(s).length ? '' : '<p class="sp-dim">개요 없음</p>';
        return `<div class="sp-card sp-scene ${s.status === 'open' ? 'sp-open' : ''} ${s.star ? 'sp-star' : ''}">${head}
            <div class="sp-title">${esc(T(s.title, s.koTitle))}${s.where ? ` <small>@ ${esc(s.where)}</small>` : ''}</div>
            ${s.who.length ? `<div class="sp-who">${whoChips(mem, s.who)}</div>` : ''}
            <div class="sp-outline">${s.segs.filter(g => g.outline).map(g => `<p>${esc(T(g.outline, g.koOutline))}</p>`).join('')}</div>${legacy}${outlineText}
            <details class="sp-more" ${ui.edit && String(ui.edit.id).startsWith(s.id + '|') ? 'open' : ''}><summary>구간 ${s.segs.length} · 포인트 ${pts.length} (주입 ${pts.filter(x => pointInjected(x.p)).length})</summary>
                <div class="sp-dim sp-keyhelp">● 주입 / ○ 저장만. 눌러서 바꿀 수 있어요. ${btn('rekey-scene', s.id, '⟳ 주입 고르기', '개요와 상태 목록에 없는 중요한 포인트만 AI가 다시 골라요 (직접 지정한 건 유지)')}</div>
                ${segHtml}</details></div>`;
    }).join('');
}
function recordRow(st, r, extraTools = []) {
    if (isEditing('record', r.id)) return `<div class="sp-rec">${editForm()}</div>`;
    return `<div class="sp-rec ${r.pin ? 'sp-pinned' : ''}"><span class="sp-rec-t">${esc(T(r.text, r.ko))}</span>${evidenceChips(r.msgs)}
        ${tools([...extraTools, btn('pin-rec', r.id, '📌', '항상 주입', r.pin ? 'sp-on' : ''), btn('edit-rec', r.id, '✎'), btn('del-rec', r.id, '🗑')])}</div>`;
}
function questsHtml(st) {
    const qs = st.mem.records.filter(r => r.type === 'quest');
    const group = (status, label) => {
        const list = qs.filter(q => q.status === status);
        if (!list.length) return '';
        return `<div class="sp-group"><div class="sp-group-h">${label} <span>${list.length}</span></div>${list.map(q => {
            if (isEditing('record', q.id)) return `<div class="sp-quest">${editForm()}</div>`;
            const flow = status === 'open' ? [btn('quest-done', q.id, '완료'), btn('quest-fail', q.id, '실패')] : [btn('quest-open', q.id, '다시 진행')];
            return `<div class="sp-quest sp-q-${status}"><span class="sp-qi">${QUEST_ICON[q.kind] || '•'}</span><div class="sp-qb"><div><span class="sp-kind">${KIND_KO[q.kind]}</span> ${esc(T(q.text, q.ko))}</div>
                <div class="sp-sub">${whoChips(st.mem, q.who)}${evidenceChips(q.msgs)}</div>${q.terms ? `<details class="sp-terms"><summary>근거 원문 #${q.terms.msg}</summary><div class="sp-terms-q">“${esc(q.terms.quote)}”</div><div class="sp-excerpt">${esc(q.terms.context)}</div></details>` : ''}</div>${tools([...flow, btn('pin-rec', q.id, '📌', '항상 주입', q.pin ? 'sp-on' : ''), btn('edit-rec', q.id, '✎'), btn('del-rec', q.id, '🗑')])}</div>`;
        }).join('')}</div>`;
    };
    const body = group('open', '진행 중') + group('done', '완료') + group('failed', '실패');
    return addBar('quest') + (body || '<div class="sp-empty">약속·목표·빚·수수께끼가 생기면 여기에 나타나요.</div>');
}
function addBar(type) {
    return isEditing('record', 'new') && ui.edit.values.type === type ? `<div class="sp-card">${editForm()}</div>`
        : `<div class="sp-addbar">${btn('add-rec', type, '＋ 직접 추가')}</div>`;
}
function entityHead(st, e) {
    if (isEditing('entity', e.id)) return editForm();
    return `<div class="sp-ent-h"><span class="sp-ent-n">${esc(e.name)}</span>${e.aliases?.length ? `<span class="sp-alias">${esc(e.aliases.join(' · '))}</span>` : ''}${tools([btn('edit-ent', e.id, '✎', '이름·별칭 편집')])}</div>`;
}
function partyHtml(st) {
    const mem = st.mem;
    const people = mem.entities.filter(e => e.type === 'person');
    const cards = people.map(e => {
        const recs = mem.records.filter(r => r.type === 'party' && r.entity === e.id);
        const rows = a => recs.filter(r => r.aspect === a).map(r => recordRow(st, r)).join('');
        const rel = rows('relation'), cond = rows('condition');
        return `<div class="sp-card sp-person">${entityHead(st, e)}
            ${rel ? `<div class="sp-aspect">관계</div>${rel}` : ''}${cond ? `<div class="sp-aspect">상태</div>${cond}` : ''}
            ${!rel && !cond ? '<div class="sp-dim">기록된 변화 없음</div>' : ''}</div>`;
    }).join('');
    const orphan = mem.records.filter(r => r.type === 'party' && !people.some(p => p.id === r.entity)).map(r => recordRow(st, r)).join('');
    return addBar('party') + (cards || orphan ? cards + orphan : '<div class="sp-empty">인물의 관계 변화와 상태가 여기에 쌓여요.</div>');
}
function itemsHtml(st) {
    const mem = st.mem;
    const recs = mem.records.filter(r => r.type === 'item');
    const rows = recs.map(r => isEditing('record', r.id) ? `<div class="sp-card">${editForm()}</div>`
        : `<div class="sp-card sp-item"><div class="sp-item-h"><span class="sp-ent-n">🎒 ${esc(entityName(mem, r.entity) || '?')}</span>
            ${r.holder ? `<span class="sp-holder">소지: <b>${esc(entityName(mem, r.holder))}</b></span>` : '<span class="sp-holder sp-dim">소지자 없음</span>'}</div>
            ${recordRow(st, r)}</div>`).join('');
    const itemEnts = mem.entities.filter(e => e.type === 'item' || e.type === 'place');
    const names = itemEnts.length ? `<details class="sp-more"><summary>물건·장소 이름 ${itemEnts.length}개 (별칭 편집)</summary>${itemEnts.map(e => `<div class="sp-card">${entityHead(st, e)}</div>`).join('')}</details>` : '';
    return addBar('item') + (rows || '<div class="sp-empty">누가 무엇을 가지고 있는지, 물건이 어떤 상태인지 여기에 나타나요.</div>') + names;
}
function worldHtml(st) {
    const recs = st.mem.records.filter(r => r.type === 'world');
    const body = WORLD_KINDS.map(k => {
        const list = recs.filter(r => r.kind === k);
        if (!list.length) return '';
        return `<div class="sp-group"><div class="sp-group-h">${KIND_KO[k]} <span>${list.length}</span></div>${list.map(r => recordRow(st, r, r.knownBy?.length ? [`<span class="sp-known" title="아는 사람">👁 ${esc(r.knownBy.map(id => entityName(st.mem, id)).join(', '))}</span>`] : [])).join('')}</div>`;
    }).join('');
    return addBar('world') + (body || '<div class="sp-empty">장소, 규칙, 별명, 비밀이 여기에 모여요.</div>');
}
function vaultLine() {
    if (!vault.ready) return '<div class="sp-dim">서버 백업 확인 중…</div>';
    if (!vault.online) return `<div class="sp-warn">서버 백업을 쓸 수 없어요. 세이브는 설정에만 저장돼요. (${esc(vault.error || '')})</div>`;
    if (vault.error) return `<div class="sp-warn">마지막 서버 백업 실패: ${esc(vault.error)}</div>`;
    const local = Object.keys(localSaves()).length;
    return `<div class="sp-dim">서버 백업 ${vault.lastBackup ? `마지막 ${new Date(vault.lastBackup).toLocaleTimeString()}` : '사용 중'} · 슬롯 ${vault.entries.length}개${local ? ` · <span class="sp-warn">설정에만 있는 슬롯 ${local}개</span>` : ''}</div>`;
}
function foundHtml() {
    const f = ui.found;
    if (!f) return '';
    if (f.loading) return '<div class="sp-card"><span class="sp-spin">◐</span> 백업 찾는 중…</div>';
    const rows = f.list.map(x => `<div class="sp-rec"><span class="sp-rec-t"><span class="sp-slot ${x.auto ? 'sp-slot-auto' : ''}">${x.auto ? 'AUTO' : 'FILE'}</span> <b>${esc(x.name)}</b>
        <span class="sp-dim">${esc(x.char || '')} · ${fmtDate(x.updated)} · 장면 ${x.stats?.scenes ?? 0} · ${FOUND_SOURCE[x.source]}에서 찾음${x.exists ? '' : ' · 파일 없음'}</span></span>
        ${x.listed ? '<span class="sp-badge">목록에 있음</span>' : x.exists ? btn('restore', x.file, '↩ 복구', '이 백업을 세이브 목록에 되살려요', 'sp-primary') : ''}</div>`).join('');
    return `<div class="sp-card sp-found"><div class="sp-group-h">🔍 찾은 백업 <span>${f.list.length}</span> ${btn('found-close', '', '닫기')}</div>
        ${rows || '<div class="sp-dim">찾은 백업이 없어요.</div>'}
        <div class="sp-dim">목록 파일 두 개가 모두 없으면 직접 만든 슬롯은 자동으로 찾을 수 없어요. 서버 폴더(data/사용자/user/files)에서 savepoint-slot-….json을 내 기기로 옮긴 뒤 📥 세이브 가져오기로 불러와 주세요.</div></div>`;
}
// "Theo - 2026-10-12@20h10m27s159ms" -> "2026-10-12 20:10 채팅"
function roomLabel(room) {
    let chatName = '';
    try { chatName = String(JSON.parse(room)[1] || ''); } catch { chatName = String(room || ''); }
    const m = chatName.match(/(\d{4}-\d{2}-\d{2})@(\d{1,2})h(\d{2})m/);
    return m ? `${m[1]} ${m[2].padStart(2, '0')}:${m[3]} 채팅` : (chatName || '알 수 없는 방');
}
function roomChar(room) { try { return String(JSON.parse(room)[0] || ''); } catch { return ''; } }
function saveCard(sv, st, { showRoom = false, autoRank = 0 } = {}) {
    const s = sv.stats || {};
    const linked = st?.linkedSave === sv.id;
    const genLabel = sv.auto ? ['최신', '이전', '그 전'][autoRank] || '' : '';
    return `<div class="sp-card sp-save ${sv.auto ? 'sp-auto' : ''} ${linked ? 'sp-linked' : ''}">
        <div class="sp-save-h"><span class="sp-slot">${sv.auto ? 'AUTO' : 'FILE'}</span><span class="sp-save-n">${esc(sv.name)}</span>${genLabel ? `<span class="sp-badge">${genLabel}</span>` : ''}${linked ? '<span class="sp-badge sp-badge-on">연결됨</span>' : ''}${sv.local ? '<span class="sp-badge sp-badge-warn">설정에만 있음</span>' : ''}</div>
        <div class="sp-save-meta">${showRoom ? `📁 ${esc(roomLabel(sv.room))} · ` : ''}${esc(sv.char || '')} · ${fmtDate(sv.updated)}</div>
        <div class="sp-save-stats"><span>장면 ${s.scenes ?? 0}</span><span>메시지 ${sv.msgCount ?? 0}</span><span>❗ ${s.openQuests ?? 0}</span>${s.place ? `<span>📍 ${esc(s.place)}</span>` : ''}</div>
        <div class="sp-row">${btn('load-continue', sv.id, '이어하기', '이 방에서 이 세이브를 이어서 사용', 'sp-primary')}${btn('load-copy', sv.id, '루트 분기', '이 세이브에서 갈라져 다른 이야기로 (원래 슬롯은 덮어쓰지 않아요)')}
            ${sv.auto ? '' : btn('save-over', sv.id, '저장', '이 슬롯을 지금 기억으로 덮어써요')}${btn('save-rename', sv.id, '이름')}${btn('save-export', sv.id, '📤', '이 슬롯을 .json 파일로 내보내기')}${btn('save-del', sv.id, '삭제', '', 'sp-danger')}</div></div>`;
}
function cardsOf(list, st, opts) {
    const rank = {};
    return list.map(sv => saveCard(sv, st, { ...opts, autoRank: sv.auto ? (rank[sv.roomHash] = (rank[sv.roomHash] ?? -1) + 1) : 0 })).join('');
}
function groupBox(key, title, count, body, openByDefault) {
    const open = ui.savesOpen.has(key) ? ui.savesOpen.get(key) : openByDefault;
    return `<details class="sp-savegroup" data-group="${esc(key)}" ${open ? 'open' : ''}><summary><span class="sp-group-h">${title} <span>${count}</span></span></summary>${body}</details>`;
}
// Other characters: one folder per character card.
function otherCharsHtml(list, st, order) {
    const byChar = new Map();
    for (const sv of list) { const k = roomChar(sv.room) || sv.char || '?'; if (!byChar.has(k)) byChar.set(k, []); byChar.get(k).push(sv); }
    return [...byChar.entries()].map(([k, l]) => groupBox('char:' + k, `🃏 ${esc(l[0].char || k)}`, l.length, cardsOf(order(l), st, { showRoom: true }), false)).join('');
}
function savesHtml(st) {
    const saves = listSaves();
    const notice = vault.notice === 'index-missing' && !ui.found ? '<div class="sp-alert">서버의 세이브 목록 파일이 없어요. 🔍 백업 찾기로 이전 목록을 확인해 주세요.</div>' : '';
    const top = `<div class="sp-addbar">${btn('save-new', '', '＋ 새 세이브 슬롯')}${btn('export-room', '', '📤 세이브 내보내기', '이 방 기억을 .json 파일로 내려받아요')}
        ${btn('import', '', '📥 세이브 가져오기', '.json 파일에서 슬롯으로 불러와요')}${btn('find', '', '🔍 백업 찾기', '서버에 남은 백업을 찾아 보여 줘요 (아무것도 바꾸지 않아요)')}
        ${btn('clear-room', '', '리셋', '이 방의 기억을 모두 지워요 (세이브 슬롯은 남아요)', 'sp-danger')}</div>${vaultLine()}${notice}${foundHtml()}`;
    if (!saves.length) return top + '<div class="sp-empty">세이브 슬롯이 없어요. 기억이 기록되면 방마다 오토세이브가 생겨요(최근 3개).</div>';
    const here = roomKey(), charKey = charInfo()?.key || '';
    // Manual slots always on top, in the order they were made (renaming or saving does not move them);
    // autosaves below, newest first.
    const order = list => [...list.filter(x => !x.auto).sort((a, b) => (b.created || 0) - (a.created || 0)),
        ...list.filter(x => x.auto).sort((a, b) => b.updated - a.updated)];
    const thisRoom = order(saves.filter(x => x.room === here));
    const sameChar = saves.filter(x => x.room !== here && roomChar(x.room) === charKey);
    const others = saves.filter(x => x.room !== here && roomChar(x.room) !== charKey);
    const byRoom = new Map();
    for (const sv of sameChar) { if (!byRoom.has(sv.room)) byRoom.set(sv.room, []); byRoom.get(sv.room).push(sv); }
    const roomBoxes = [...byRoom.entries()].map(([room, list]) =>
        groupBox('room:' + room, `📁 ${esc(roomLabel(room))}`, list.length, cardsOf(order(list), st, {}), false)).join('');
    return top
        + groupBox('here', '이 방', thisRoom.length, thisRoom.length ? cardsOf(thisRoom, st, {}) : '<div class="sp-dim">이 방에서 만든 세이브가 아직 없어요.</div>', true)
        + (sameChar.length ? groupBox('char', `${esc(charInfo()?.name || '이 캐릭터')}의 다른 방`, sameChar.length, roomBoxes, false) : '')
        + (others.length ? groupBox('others', '다른 캐릭터', others.length, otherCharsHtml(others, st, order), false) : '');
}
function injectHtml(st) {
    const inj = ui.inj;
    if (!inj || !inj.text) return '<div class="sp-empty">지금 주입되는 기억이 없어요.</div>';
    const u = inj.used;
    const rec = inj.recalled.length ? inj.recalled.map(r => `<div class="sp-rec"><b>${esc(r.title)}</b> <span class="sp-dim">← ${esc(r.reasons.join(' / '))} · ${({ full: '주입에 빠진 포인트·노트', outline: '포인트·노트', oneliner: '개요 나머지·포인트·노트', none: '장면 전체' })[r.form] || ''}</span></div>`).join('')
        : '<div class="sp-dim">최근 대화와 연결된 예전 장면을 찾지 못해서 회상하지 않았어요.</div>';
    return `<div class="sp-card"><div class="sp-meters">
        <span>전체 <b>${inj.tokens.toLocaleString()}</b> / ${num('budget', 300, 100000).toLocaleString()}</span>
        <span>상태 ${Math.round(u.state)}</span><span>저널 ${Math.round(u.journal)}</span><span>회상 ${Math.round(u.recall)}</span><span>제목 목록 ${Math.round(u.titles)}</span></div>
        ${inj.omittedScenes ? `<div class="sp-warn">예산 때문에 제목도 넣지 못한 장면이 ${inj.omittedScenes}개 있어요.</div>` : ''}
        ${inj.pinOverflow ? `<div class="sp-warn">📌 고정 항목 ${inj.pinMissing}개가 주입 상한 안에 들어가지 못해 빠졌어요. 고정을 줄이거나 상한을 늘려 주세요.</div>` : ''}
        <div class="sp-aspect">회상한 장면과 이유</div>${rec}
        ${(() => { const n = st.mem.scenes.filter(needsRekey).length; return n ? `<div class="sp-row" style="margin-top:8px">${btn('rekey-old', '', `⟳ 예전 기록 주입 포인트 고르기 (${n}장면)`, '예전 버전에서 기록한 장면은 포인트가 전부 주입돼요. 다시 정리하지 않고 주입할 포인트만 골라요')}</div>` : ''; })()}</div>
        <pre class="sp-pre">${esc(inj.text)}</pre>
        <div class="sp-dim">마지막 메시지를 기준으로 계산했어요. 실제 생성 직전에 한 번 더 계산해요.</div>`;
}
function hudHtml(st) {
    const open = st ? openScene(st.mem) : null;
    const total = chat().length;
    const covered = st ? st.lastIndex + 1 : 0;
    const pending = pendingCount();
    const pct = total ? Math.round(covered / total * 100) : 0;
    const busy = !!ui.run;
    const review = st?.review ? `<div class="sp-alert">이미 기억에 반영된 예전 원문 #${st.review.at}이(가) 바뀌었어요. 저장 기록 이전이라 자동으로 되감을 수 없어요.
        <div class="sp-row">${btn('review-accept', '', '지금 원문 기준으로 인정')}${btn('clear-room', '', '리셋', '이 방의 기억을 모두 지워요 (세이브 슬롯은 남아요)', 'sp-danger')}</div></div>` : '';
    const every = num('autoEvery', 5, 500);
    const autoLine = !settings().auto ? '<span class="sp-dim">체크포인트 꺼짐</span>'
        : st?.autoHold ? `<span class="sp-warn">${esc(HOLD_TEXT)}</span>`
        : `<span>다음 체크포인트까지 <b>${Math.max(0, every - autoCount(st))}</b>개</span>`;
    const autoLast = st?.autoLast ? `<span class="sp-dim">마지막 체크포인트 ${new Date(st.autoLast.at).toLocaleTimeString()} · ${esc(st.autoLast.result)}</span>` : '';
    const err = ui.lastError ? `<details class="sp-err" data-group="hud-err" ${ui.savesOpen.get('hud-err') ? 'open' : ''}><summary>마지막 실패 ${esc(ui.lastError.range)} — 자세히</summary><ul class="sp-scroll">${groupErrors(ui.lastError.detail).map(d => `<li>${esc(d)}</li>`).join('')}</ul></details>` : '';
    return `<div class="sp-hud">
        <div class="sp-scene-now">${open ? `<span class="sp-cursor">▶</span> <b>${esc(T(open.title, open.koTitle))}</b>${open.where ? ` <span class="sp-dim">@ ${esc(open.where)}</span>` : ''}` : '<span class="sp-dim">▷ 진행 중인 장면 없음</span>'}</div>
        <div class="sp-bar" title="기록된 메시지 비율"><div class="sp-bar-fill" style="width:${pct}%"></div><span>기록 ${covered} / ${total}</span></div>
        <div class="sp-hud-meta"><span>미기록 <b>${pending}</b></span><span>주입 ${ui.inj ? ui.inj.tokens.toLocaleString() : 0} / ${num('budget', 300, 100000).toLocaleString()} 토큰</span><span>요약 AI: ${esc(profileLabel())}</span>${ui.inj?.pinOverflow ? `<span class="sp-warn">📌 ${ui.inj.pinMissing}개 주입 못 함</span>` : ''}</div>
        <div class="sp-hud-meta sp-auto-line">${autoLine}${autoLast}</div>
        ${checkHtml(st)}
        ${review}
        <div class="sp-row sp-actions">
            ${btn('run', '', '⏺ 퀵세이브', '마지막 메시지까지 바로 기록하고, 끝나지 않은 장면은 열어 둬요', 'sp-primary' + (busy ? ' sp-disabled' : ''))}
            ${btn('run-close', '', '■ 장면 클리어', '마지막 메시지까지 기록하고 진행 중인 장면을 닫아요', busy ? 'sp-disabled' : '')}
            ${btn('undo', '', '⏪ 리와인드', '마지막 작업(기록·편집·불러오기·비우기) 전으로', st?.undo && !busy ? '' : 'sp-disabled')}
            ${btn('translate', '', '🌐 번역', '한국어 보기가 없는 항목을 번역해요', busy ? 'sp-disabled' : '')}
            ${busy ? btn('stop', '', '중지', '', 'sp-danger') : ''}
        </div>
        ${ui.lastFix ? `<div class="sp-hud-meta"><span class="sp-dim">자동 보정 ${esc(ui.lastFix.range)}: ${esc(ui.lastFix.text)} · ${new Date(ui.lastFix.at).toLocaleTimeString()}</span></div>` : ''}
        ${(ui.lastError || (st?.check && st.check.status !== 'running')) && !busy ? `<div class="sp-row sp-copyrow">${btn('copy-report', '', '📋 결과 복사', '마지막 실패와 기록 확인 결과를 글로 복사해요 (캡처 대신)')}</div>` : ''}
        ${ui.copyText ? `<div class="sp-copybox"><textarea readonly rows="8">${esc(ui.copyText)}</textarea>${btn('copy-close', '', '닫기')}</div>` : ''}
        ${busy ? `<div class="sp-progress"><span class="sp-spin">◐</span> ${esc(ui.progress)}${ui.req ? ` · <span class="sp-req">${esc(reqText())}</span>` : ''}</div>` : ''}${err}
    </div>`;
}
function render(force = false) {
    if (!ui.open) return;
    const win = $('#sp_overlay .sp-window');
    if (!win.length) return;
    if (!force && ui.edit && win.find('.sp-edit').length) return; // keep half-typed edits
    const st = state();
    const s = settings();
    win.attr('data-theme', s.theme in THEMES ? s.theme : 'jrpg');
    const scroll = win.find('.sp-body').scrollTop() || 0;
    const tabScroll = win.find('.sp-tabs').scrollLeft() || 0;
    const counts = st ? {
        journal: st.mem.scenes.length, quests: st.mem.records.filter(r => r.type === 'quest' && r.status === 'open').length,
        party: st.mem.entities.filter(e => e.type === 'person').length, items: st.mem.records.filter(r => r.type === 'item').length,
        world: st.mem.records.filter(r => r.type === 'world').length, saves: listSaves().length,
    } : {};
    const tabs = TABS.map(([k, icon, label]) => `<button class="sp-tab ${ui.tab === k ? 'sp-active' : ''}" data-act="tab" data-id="${k}"><span class="sp-ti">${icon}</span><span>${label}</span>${counts[k] ? `<em>${counts[k]}</em>` : ''}</button>`).join('');
    let body;
    if (!hasChat()) body = '<div class="sp-empty">채팅방을 열면 그 방의 기억이 여기에 보여요.</div>';
    else {
        const view = st || { mem: emptyMem() };
        body = { journal: journalHtml, quests: questsHtml, party: partyHtml, items: itemsHtml, world: worldHtml, saves: savesHtml, inject: injectHtml }[ui.tab](view);
    }
    win.html(`<div class="sp-top">
            <div class="sp-logo"><span class="sp-logo-icon">◆</span> SAVE POINT <span class="sp-ver">v${VERSION}</span></div>
            <div class="sp-top-r"><span class="sp-room">${esc(charInfo()?.name || '')}</span>
                <button class="sp-btn sp-mini ${showKo() ? 'sp-on' : ''}" data-act="ko" title="한국어 보기">${showKo() ? '한' : 'EN'}</button>
                <button class="sp-btn sp-mini" data-act="close" title="닫기">✕</button></div></div>
        ${hasChat() ? hudHtml(st) : ''}
        <div class="sp-tabs">${tabs}</div>
        <div class="sp-body">${body}</div>`);
    win.find('.sp-body').scrollTop(scroll);
    // Keep the tab strip where it was, and make sure the selected tab is in view.
    const strip = win.find('.sp-tabs')[0], active = win.find('.sp-tab.sp-active')[0];
    if (strip) {
        strip.scrollLeft = tabScroll;
        if (active) {
            const left = active.offsetLeft - strip.offsetLeft, right = left + active.offsetWidth;
            if (left < strip.scrollLeft) strip.scrollLeft = left - 8;
            else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 8;
        }
    }
}

// ───────── UI actions ─────────

function findPoint(mem, id) {
    const [sid, gid, j] = id.split('|');
    const s = mem.scenes.find(x => x.id === sid), g = s?.segs.find(x => x.id === gid);
    return { s, g, p: g?.points[Number(j)], j: Number(j) };
}
function startEdit(kind, id) {
    const st = state(), mem = st.mem;
    let values = {};
    if (kind === 'scene') { const s = mem.scenes.find(x => x.id === id); values = { title: s.title, where: s.where }; }
    if (kind === 'segoutline') { const [sid, gid] = id.split('|'); values = { outline: mem.scenes.find(x => x.id === sid).segs.find(g => g.id === gid).outline || '' }; }
    if (kind === 'legacy') values = { outline: mem.scenes.find(x => x.id === id).legacyOutline || '' };
    if (kind === 'point') values = { text: findPoint(mem, id).p.text };
    if (kind === 'notes') { const [sid, gid] = id.split('|'); values = { notes: mem.scenes.find(x => x.id === sid).segs.find(g => g.id === gid).notes }; }
    if (kind === 'entity') { const e = mem.entities.find(x => x.id === id); values = { name: e.name, aliases: (e.aliases || []).join(', '), type: e.type }; }
    if (kind === 'record') {
        const r = mem.records.find(x => x.id === id);
        values = { type: r.type, text: r.text, entity: r.entity || '', holder: r.holder || '', aspect: r.aspect || 'relation', kind: r.kind || '', status: r.status || 'open' };
    }
    ui.edit = { kind, id, values };
    render(true);
}
async function saveEdit() {
    const e = ui.edit;
    if (!e) return;
    const v = e.values;
    const trim = x => String(x ?? '').trim();
    ui.edit = null;
    await commitEdit(mem => {
        if (e.kind === 'scene') {
            const s = mem.scenes.find(x => x.id === e.id);
            if (!s || !trim(v.title)) return false;
            if (s.title !== trim(v.title)) { s.title = trim(v.title); delete s.koTitle; }
            s.where = trim(v.where);
        } else if (e.kind === 'segoutline') {
            const [sid, gid] = e.id.split('|');
            const g = mem.scenes.find(x => x.id === sid)?.segs.find(x => x.id === gid);
            if (!g) return false;
            if ((g.outline || '') !== trim(v.outline)) { g.outline = trim(v.outline); delete g.koOutline; if (!g.outline) delete g.outline; }
        } else if (e.kind === 'legacy') {
            const sc = mem.scenes.find(x => x.id === e.id);
            if (!sc) return false;
            if (trim(v.outline)) { if (sc.legacyOutline !== trim(v.outline)) { sc.legacyOutline = trim(v.outline); delete sc.koOutline; } }
            else { delete sc.legacyOutline; delete sc.koOutline; }
        } else if (e.kind === 'point') {
            const { p } = findPoint(mem, e.id);
            if (!p || !trim(v.text)) return false;
            if (p.text !== trim(v.text)) { p.text = trim(v.text); delete p.ko; }
        } else if (e.kind === 'notes') {
            const [sid, gid] = e.id.split('|');
            const g = mem.scenes.find(x => x.id === sid)?.segs.find(x => x.id === gid);
            if (!g) return false;
            if (g.notes !== trim(v.notes)) { g.notes = trim(v.notes); delete g.koNotes; }
        } else if (e.kind === 'entity') {
            const en = mem.entities.find(x => x.id === e.id);
            if (!en || !trim(v.name)) return false;
            en.name = trim(v.name); en.type = ENTITY_TYPES.includes(v.type) ? v.type : en.type;
            en.aliases = [...new Set(String(v.aliases || '').split(/[,，、]/).map(trim).filter(Boolean))];
        } else if (e.kind === 'record') {
            if (!trim(v.text)) return false;
            let r = mem.records.find(x => x.id === e.id);
            if (!r) { r = { id: 'r' + (mem.next.r++), type: v.type, text: '', src: [], msgs: [], pin: false }; mem.records.push(r); }
            if (r.text !== trim(v.text)) { r.text = trim(v.text); delete r.ko; }
            if (r.type === 'party') { r.entity = v.entity || null; r.aspect = v.aspect === 'condition' ? 'condition' : 'relation'; }
            if (r.type === 'item') { r.entity = v.entity || null; r.holder = v.holder || null; }
            if (r.type === 'quest') { r.kind = QUEST_KINDS.includes(v.kind) ? v.kind : 'goal'; r.status = ['open', 'done', 'failed'].includes(v.status) ? v.status : 'open'; r.who ||= []; }
            if (r.type === 'world') { r.kind = WORLD_KINDS.includes(v.kind) ? v.kind : 'rule'; r.knownBy ||= []; }
        }
    });
}
async function handle(act, id) {
    const st = state();
    switch (act) {
        case 'close': return closeWindow();
        case 'tab': ui.tab = id; ui.edit = null; if (id === 'inject') refreshInjection(); return render(true);
        case 'ko': settings().showKo = !showKo(); saveSettings(); return render(true);
        case 'run': return summarize();
        case 'run-close': return summarize({ close: true });
        case 'stop': cancelRun(); return;
        case 'undo': return undo();
        case 'translate': return translate();
        case 'review-accept': return acceptCurrentSource();
        case 'edit-cancel': ui.edit = null; return render(true);
        case 'edit-save': return saveEdit();
        case 'edit-scene': return startEdit('scene', id);
        case 'edit-point': return startEdit('point', id);
        case 'edit-notes': return startEdit('notes', id);
        case 'edit-segoutline': return startEdit('segoutline', id);
        case 'edit-legacy': return startEdit('legacy', id);
        case 'edit-ent': return startEdit('entity', id);
        case 'edit-rec': return startEdit('record', id);
        case 'add-rec':
            ui.edit = { kind: 'record', id: 'new', values: { type: id, text: '', entity: '', holder: '', aspect: 'relation', kind: id === 'quest' ? 'promise' : id === 'world' ? 'rule' : '', status: 'open' } };
            return render(true);
        case 'star': return commitEdit(m => { const s = m.scenes.find(x => x.id === id); if (!s) return false; s.star = !s.star; }, { undoable: false });
        case 'pin': return commitEdit(m => { const s = m.scenes.find(x => x.id === id); if (!s) return false; s.pin = !s.pin; }, { undoable: false });
        case 'pin-rec': return commitEdit(m => { const r = m.records.find(x => x.id === id); if (!r) return false; r.pin = !r.pin; }, { undoable: false });
        case 'quest-done': case 'quest-fail': case 'quest-open':
            return commitEdit(m => { const r = m.records.find(x => x.id === id); if (!r) return false; r.status = act === 'quest-done' ? 'done' : act === 'quest-fail' ? 'failed' : 'open'; });
        case 'del-scene':
            if (!(await confirmBox('이 장면을 저널에서 지울까요? 상태 탭의 항목은 그대로 남아요. (되돌리기 가능)'))) return;
            return commitEdit(m => { m.scenes = m.scenes.filter(x => x.id !== id); });
        case 'check-ignore': { const x = st?.check?.issues.find(i => i.id === id); if (x) { x.ignored = true; persistSoon(); } return render(true); }
        case 'check-edit': { const x = st?.check?.issues.find(i => i.id === id); return x ? editAbout(x.about) : undefined; }
        case 'copy-report': return copyReport();
        case 'copy-close': ui.copyText = null; return render();
        case 'check-edit-also': { const x = st?.check?.issues.find(i => i.id === id); return x?.also ? editAbout(x.also) : undefined; }
        case 'check-rerun': return st?.check?.scope ? runCheck(st, st.check.scope) : undefined;
        case 'key-toggle': return commitEdit(m => {
            const { p } = findPoint(m, id);
            if (!p) return false;
            const want = !pointInjected(p);
            // Back to the AI's own choice clears the override; anything else is the user's choice.
            if (typeof p.key === 'boolean' && want === p.key) delete p.keyUser; else p.keyUser = want;
        }, { undoable: false });
        case 'rekey-scene': return rekeyScenes([id]);
        case 'rekey-old': return rekeyScenes(state()?.mem.scenes.filter(needsRekey).map(x => x.id) || []);
        case 'del-point': return commitEdit(m => { const { g, j } = findPoint(m, id); if (!g) return false; g.points.splice(j, 1); });
        case 'del-rec': return commitEdit(m => { m.records = m.records.filter(x => x.id !== id); });
        case 'save-new': return saveNew();
        case 'save-over': return overwriteSave(id);
        case 'load-continue': return loadSave(id, 'continue');
        case 'load-copy': return loadSave(id, 'copy');
        case 'save-rename': return renameSave(id);
        case 'save-export': return exportSave(id);
        case 'find': return findBackups();
        case 'restore': return restoreBackup(id);
        case 'found-close': ui.found = null; return render(true);
        case 'save-del': return deleteSave(id);
        case 'export-room': return exportRoom();
        case 'clear-room': return clearRoom();
        case 'import': return $('#sp_file').trigger('click');
    }
    void st;
}

// ───────── settings panel ─────────

function settingsHtml() {
    return `<div id="sp_settings" class="sp-settings"><div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>◆ SavePoint</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <div class="sp-set-row"><button class="menu_button" id="sp_open">SavePoint 열기</button></div>
            <label class="checkbox_label"><input type="checkbox" data-set="enabled"> 사용 (기억 주입·하이드)</label>
            <label>요약 AI <select data-set="profileId" id="sp_profiles"></select></label>
            <label class="checkbox_label"><input type="checkbox" data-set="check"> 기록 후 확인 (AI가 모순·원문과 다른 해석을 찾아 경고만, 호출 1회 추가)</label>
            <label class="checkbox_label"><input type="checkbox" data-set="auto"> 체크포인트 (끝난 장면을 자동 기록)</label>
            <label>체크포인트 간격 (새 메시지 수, 유저+캐릭터) <input type="number" data-set="autoEvery" min="5" max="500"></label>
            <label>응답 최대 토큰 <input type="number" data-set="responseLength" min="500" max="64000"></label>
            <label>한 번에 보낼 입력 한도 (글자) <input type="number" data-set="inputChars" min="5000" max="1000000"></label>
            <label title="이 시간 안에 응답이 오지 않으면 그 요청을 취소해요. 그 구간은 저장하지 않고 원문을 그대로 둬요. 늦게 도착한 응답은 버려요.">요청 제한 시간 (초) <input type="number" data-set="timeoutSec" min="5" max="3600"></label>
            <hr>
            <label>주입 상한 (토큰) <input type="number" data-set="budget" min="300" max="100000"></label>
            <label>오래된 장면 제목 목록 상한 (토큰) <input type="number" data-set="titleCap" min="0" max="20000"></label>
            <label>자세히 넣을 최근 장면 수 <input type="number" data-set="recentScenes" min="0" max="20"></label>
            <label class="checkbox_label"><input type="checkbox" data-set="recall"> 상세 기억 회상 (관련된 예전 장면의 영어 노트)</label>
            <label class="checkbox_label"><input type="checkbox" data-set="rawRecall"> 원문 회상 (예전 원문 일부를 그대로, 한국어 섞일 수 있음)</label>
            <label>주입 위치 <select data-set="position"><option value="2">메인 프롬프트 앞</option><option value="0">메인 프롬프트 뒤</option><option value="1">채팅 안 (깊이)</option></select></label>
            <label>깊이 <input type="number" data-set="depth" min="0" max="999"></label>
            <label>역할 <select data-set="role"><option value="0">시스템</option><option value="1">사용자</option><option value="2">어시스턴트</option></select></label>
            <hr>
            <label class="checkbox_label"><input type="checkbox" data-set="hide"> 정리한 메시지 하이드</label>
            <label>하이드하지 않을 최근 메시지 <input type="number" data-set="keepRecent" min="0" max="200"></label>
            <label>오토세이브를 보관할 방 수 (방마다 최근 3개) <input type="number" data-set="autoKeep" min="1" max="500"></label>
            <label>테마 <select data-set="theme">${Object.entries(THEMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
            <hr>
            <label>기록 지침 (영어 권장, {{char}} {{user}} 사용 가능)</label>
            <textarea data-set="guide" rows="10" class="text_pole"></textarea>
            <div class="sp-set-row"><button class="menu_button" id="sp_guide_reset">기본 지침으로 되돌리기</button></div>
            <div class="sp-set-note">데이터 목록과 응답 형식은 지침 뒤에 자동으로 붙어요.</div>
        </div></div></div>`;
}
function fillProfiles() {
    const sel = $('#sp_profiles');
    if (!sel.length) return;
    const cur = settings().profileId;
    sel.html(`<option value="">메인 API</option>${profiles().map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}`);
    sel.val(profiles().some(p => p.id === cur) ? cur : '');
}
function fillSettings() {
    const s = settings();
    $('#sp_settings [data-set]').each(function () {
        const k = this.dataset.set;
        if (this.type === 'checkbox') this.checked = !!s[k];
        else $(this).val(String(s[k] ?? ''));
    });
    fillProfiles();
}
function addSettingsUI() {
    if ($('#sp_settings').length) return;
    $('#extensions_settings2').append(settingsHtml());
    fillSettings();
    $('#sp_settings').on('input change', '[data-set]', function () {
        const k = this.dataset.set, s = settings();
        s[k] = this.type === 'checkbox' ? this.checked : this.type === 'number' || ['position', 'role'].includes(k) ? Number(this.value) : this.value;
        saveSettings();
        if (['hide', 'keepRecent', 'enabled'].includes(k)) syncHide();
        if (['auto', 'autoEvery', 'enabled'].includes(k)) scheduleAuto();
        refreshInjection(); render(true);
    });
    $('#sp_open').on('click', openWindow);
    $('#sp_guide_reset').on('click', () => { settings().guide = DEFAULT_GUIDE; saveSettings(); fillSettings(); });
}

// ───────── events ─────────

function onChatChanged() {
    roomEpoch++; cancelRun(); clearTimeout(autoTimer);
    clearTimeout(persistTimer); clearTimeout(chatSaveTimer); clearTimeout(sourceTimer);
    ui.edit = null; ui.lastError = null; ui.lastFix = null; mainGenerating = false;
    if (hasChat()) {
        const st = state();
        if (st && st.roomKey !== roomKey()) {
            // A branch copies chat metadata; the copy becomes this room's own memory.
            st.roomKey = roomKey(); st.linkedSave = null; persistSoon();
        }
        reconcile();
        syncHide();
    }
    refreshInjection(); render(true);
}
function onSourceChanged() {
    clearTimeout(sourceTimer);
    const epoch = roomEpoch;
    sourceTimer = setTimeout(() => {
        if (epoch !== roomEpoch || !hasChat()) return;
        reconcile(); syncHide(); refreshInjection(); render();
    }, 150);
}
function onGenerationStarted(type, options, dryRun) {
    if (dryRun) return;
    mainGenerating = true;
    if (ui.run?.viaMain) cancelRun();
    // Recall depends on the newest message, so rebuild right before the prompt is assembled.
    reconcile(); refreshInjection();
}
function onGenerationEnded() { mainGenerating = false; render(); scheduleAuto(); }

jQuery(() => {
    settings();
    addSettingsUI();
    if ($('#extensionsMenu').length && !$('#sp_wand').length) {
        $('#extensionsMenu').append('<div id="sp_wand" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-floppy-disk extensionsMenuExtensionButton"></div>SavePoint</div>');
        $('#sp_wand').on('click', openWindow);
    }
    if (!$('#sp_file').length) $('body').append('<input type="file" id="sp_file" accept=".json,application/json" hidden>');
    $('#sp_file').on('change', function () { const f = this.files?.[0]; this.value = ''; if (f) importFile(f).catch(reportError); });
    $(document).on('click', '#sp_overlay [data-act]', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (this.classList.contains('sp-disabled')) return;
        handle(this.dataset.act, this.dataset.id).catch(reportError);
    });
    $(document).on('input change', '#sp_overlay [data-edit]', function () { if (ui.edit) ui.edit.values[this.dataset.edit] = this.value; });
    document.addEventListener('toggle', e => { const d = e.target; if (d?.matches?.('#sp_overlay details[data-group]')) ui.savesOpen.set(d.dataset.group, d.open); }, true);
    $(document).on('click', '#sp_overlay', e => { if (e.target.id === 'sp_overlay') closeWindow(); });
    $(document).on('keydown.savePoint', e => { if (e.key === 'Escape' && ui.open && !document.querySelector('dialog[open]')) closeWindow(); });
    const { eventSource, event_types: ev } = ctx();
    const on = (t, f) => { if (ev[t]) eventSource.on(ev[t], f); };
    on('CHAT_CHANGED', onChatChanged);
    for (const t of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPE_DELETED']) on(t, onSourceChanged);
    on('GENERATION_STARTED', onGenerationStarted);
    for (const t of ['GENERATION_ENDED', 'GENERATION_STOPPED']) on(t, onGenerationEnded);
    for (const t of ['CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_CREATED']) on(t, fillProfiles);
    onChatChanged();
    // Server-side save slots: the server index is the list; then move any settings-only slots over.
    vault.init(settings().slotCache).then(migrateLocal).catch(e => console.warn('[SavePoint] vault', e)).finally(() => render(true));
});

// Exposed for regression checks only.
globalThis.__savePoint = { state, settings, summarize, listSaves, vault, migrateLocal, autoCollect, autoBlocked, autoCount, scheduleAuto, undo, loadSave, reconcile, syncHide, refreshInjection, handle, ui, render, estTokens, recordLine, reportText };
