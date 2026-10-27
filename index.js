import { dueStatus, formatDue, setManualDue, PERIODS, editStoryTime, dateAt, formatSegmentTime, sceneTimeRange, storyTimeContext } from './temporal.js';
// SavePoint: scene journal + current state memory for SillyTavern, kept per chat room,
// with game-style save files. Summaries run on demand and at periodic checkpoints.
import { foldLegacyOutline,
    emptyMem, cleanMem, detachMem, chunkMessages, promptContext, validateResult, resultLanguageIssues,
    applyResult, closeOpenScene, pushHistory, rollbackFrom, buildInjection, openScene, memStats,
    pointInjected, pointSymbol, rekeyItems, validateRekey, applyRekey, sceneOutlineText, sceneOutlineParts,
    refreshProvisionalOutlines, normalizeResult, validateCheck, checkScope, dupState, pointId,
    recordLine, entityName, estTokens, QUEST_KINDS, WORLD_KINDS, ENTITY_TYPES,
    groupErrors, findQuote, mostlyNonEnglish,
} from './core.js';
import { lootStatus, lootWarning, lootInChunk, lootBlock, attachLoot, settleLoot, lootTarget, applyLootSupplement, restoreLostLoot } from './loot.js';
import { Vault, roomHash } from './vault.js';
import { upgradeEvidence, segmentPrior, evidenceNumbers } from './provenance.js';
import { assertPromptFits, nextMessageChunk, planReviewBatches } from './request-batches.js';
import { DEFAULT_GUIDE, guideHash, OLD_GUIDE_HASHES, buildCheckPrompt, buildRekeyPrompt, buildExtractPrompt, retryNote, extractionRepairNote, TRANSLATE_PROMPT } from './prompts.js';

const MODULE = 'savePoint';
const PROMPT_KEY = 'savepoint';
const HIDE_KEY = 'savepointHidden';
const VISIBLE_KEY = 'savepointVisible';
const VERSION = '0.6.7';

const ctx = () => SillyTavern.getContext();
const clone = v => structuredClone(v);

const DEFAULTS = {
    enabled: true, check: true, auto: true, autoEvery: 20, autoReserve: 2, profileId: '', responseLength: 8000, inputChars: 60000, timeoutSec: 300,
    requestStream: true, reasoningEffort: '',
    budget: 6000, titleCap: 600, recentScenes: 3, recall: true, rawRecall: false,
    hide: true, keepRecent: 10, position: 1, depth: 4, role: 0,
    theme: 'jrpg', showKo: false, autoKeep: 30, guide: DEFAULT_GUIDE, slotCache: [], localSaves: {}, settingsOpen: {}, interrupted: {},
};
const SETTING_GROUPS = {
    connection: { title: '연결·AI 요청', keys: ['profileId', 'requestStream', 'reasoningEffort', 'responseLength', 'inputChars', 'timeoutSec'] },
    recording: { title: '체크포인트·기록 확인', keys: ['check', 'auto', 'autoEvery', 'autoReserve', 'guide'] },
    injection: { title: '기억 주입', keys: ['budget', 'titleCap', 'recentScenes', 'recall', 'rawRecall', 'position', 'depth', 'role'] },
    storage: { title: '하이드·보관', keys: ['hide', 'keepRecent', 'autoKeep'] },
    appearance: { title: '화면', keys: ['theme', 'showKo'] },
};
const THEMES = { jrpg: '클래식 JRPG', neon: '네온 아케이드', glass: '글래스 사이버', archive: '다크 아카이브', pastel: '파스텔 드림', terminal: '터미널', eggpet: '딸기우유', dualwhite: '듀얼 화이트', ink: '먹과 한지', cream: '크림 라테', vanilla: '바닐라 버터', consolenight: '스토리 콘솔', cranelemon: '레몬 인형뽑기', st: '실리 테마 따라가기' };
// Themes that were retired, and the closest one now.
const RETIRED_THEMES = { parchment: 'cream', colorpocket: 'eggpet', joycon: 'dualwhite' };
const TABS = [
    ['journal', '📜', '저널'], ['queue', '⏳', '대기열'], ['quests', '❗', '퀘스트'], ['party', '👥', '파티'],
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
    if (RETIRED_THEMES[s.theme]) s.theme = RETIRED_THEMES[s.theme];
    if (!s.settingsOpen || typeof s.settingsOpen !== 'object' || Array.isArray(s.settingsOpen)) s.settingsOpen = {};
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
    if (!st || st.v !== 1) return null;
    if (st.mem.evidenceVersion !== 1) { st.mem = upgradeEvidence(st.mem); persistSoon(); }
    if (foldLegacyOutline(st.mem)) persistSoon();
    return st;
}
function freshState(extra = {}) {
    return { v: 1, roomKey: roomKey(), mem: emptyMem(), lastIndex: -1, hashes: [], history: [], floor: -1, linkedSave: null, undo: null, review: null, rev: 0, lootQueue: [], ...extra };
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
async function transact(change, { undoable = true, autosave: doAutosave = true, rehide = false } = {}) {
    const meta = ctx().chatMetadata, key = roomKey(), epoch = roomEpoch;
    const prev = meta[MODULE] ? clone(meta[MODULE]) : undefined;
    // A save-time rescan may retire a previous manual visibility exception.
    // Keep those flags as well as visibility so a failed disk write restores
    // the exact pre-save state, including messages the user had opened.
    const visibility = rehide ? chat().map(m => ({ m, system: m.is_system,
        hadSystem: Object.hasOwn(m, 'is_system'), hadExtra: Object.hasOwn(m, 'extra'), extra: m.extra,
        hadHidden: !!m.extra && Object.hasOwn(m.extra, HIDE_KEY), hidden: m.extra?.[HIDE_KEY],
        hadVisible: !!m.extra && Object.hasOwn(m.extra, VISIBLE_KEY), visible: m.extra?.[VISIBLE_KEY] })) : null;
    if (change() === false) return false;
    const st = state();
    if (st) {
        if (undoable && prev) { const { undo: _u, ...rest } = prev; st.undo = clone(rest); }
        st.rev = (prev?.rev || 0) + 1;
    }
    syncHide({ rehide }); refreshInjection();
    try { await persist(); }
    catch (e) {
        if (prev === undefined) delete meta[MODULE]; else meta[MODULE] = prev;
        const here = roomKey() === key && roomEpoch === epoch;
        if (visibility) visibility.forEach((v, i) => {
            if (here) setHidden(v.m, i, !!v.system);
            if (v.hadSystem) v.m.is_system = v.system; else delete v.m.is_system;
            if (v.hadExtra) v.m.extra = v.extra; else delete v.m.extra;
            if (v.m.extra) {
                if (v.hadHidden) v.m.extra[HIDE_KEY] = v.hidden; else delete v.m.extra[HIDE_KEY];
                if (v.hadVisible) v.m.extra[VISIBLE_KEY] = v.visible; else delete v.m.extra[VISIBLE_KEY];
            }
        });
        if (here) {
            if (!visibility) syncHide(); else ctx().swipe?.refresh?.();
            refreshInjection(); render();
        }
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
// The translation a translator extension shows instead of the original (SillyTavern's display_text).
function viewText(m) { return typeof m?.extra?.display_text === 'string' ? cleanText(m.extra.display_text) : ''; }
function viewHash(m) { return hashString(viewText(m)); }
function hashesTo(end) { return chat().slice(0, end + 1).map(fingerprint); }
function digest(list) { return hashString(list.join('|')); }
function firstMismatch(hashes) {
    const list = chat();
    for (let i = 0; i < hashes.length; i++) if (i >= list.length || hashes[i] !== fingerprint(list[i])) return i;
    return -1;
}

// ───────── messages ─────────

// Text as a reader sees it: no reasoning blocks or tags, line breaks kept as breaks, entities decoded.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function cleanText(t) {
    return String(t || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
        .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, dec, hex, name) =>
            dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITIES[name.toLowerCase()] ?? all)
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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
function syncHide({ rehide = false } = {}) {
    const st = state(), s = settings(), list = chat();
    const can = s.enabled && s.hide && st && !st.review && hasMemory(st.mem);
    const cutoff = can ? Math.min(st.lastIndex, list.length - 1 - num('keepRecent', 0, 200)) : -1;
    let changed = false;
    list.forEach((m, i) => {
        const mark = m.extra?.[HIDE_KEY];
        if (rehide && i <= cutoff) {
            // Recheck from #0 on every saved batch. A manually opened message
            // stays open during ordinary redraws, but joins the next save's hide.
            if (m.extra && Object.hasOwn(m.extra, VISIBLE_KEY)) { delete m.extra[VISIBLE_KEY]; changed = true; }
            if (!m.is_system) {
                m.extra ||= {}; m.extra[HIDE_KEY] = 1; changed = true;
            }
            // Also repair a stale rendered hide attribute when the saved flag
            // already says hidden. Do not take ownership of user-hidden messages.
            setHidden(m, i, true);
            return;
        }
        if (mark && !m.is_system) {
            // The user unhid it on purpose; leave it visible until the next save.
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
    if (scene.external && scene.segs.every(g => !g.external && !g.source)) return '';
    for (const g of scene.segs.filter(g => !g.external && !g.source)) for (const p of g.points) for (const n of p.msgs) {
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
// A profile can stream cumulative answer text and reasoning separately. Keep only lengths
// in diagnostics; reasoning and partial JSON never enter memory or hiding decisions.
// A request that passes the time limit is abandoned: its signal is aborted and, if a reply still
// arrives later, nobody is waiting for it any more, so it can neither be saved nor touch the
// progress line of a newer task.
let reqSeq = 0, reqTicker = null;
const fmtSec = ms => { const t = Math.floor(ms / 1000); return t >= 60 ? `${Math.floor(t / 60)}분 ${String(t % 60).padStart(2, '0')}초` : `${t}초`; };
function reqText() {
    const r = ui.req;
    if (!r) return '';
    const step = (r.attempt ? `재요청${r.why ? ` (${r.why})` : ''}` : '첫 요청') + ` · 입력 ${r.chars.toLocaleString()}자`;
    if (r.phase === 'got') return `${step} · 응답 받음 (${fmtSec(r.ms)}) · 검사 중`;
    const elapsed = fmtSec(Date.now() - r.start);
    if (r.phase === 'stream') return `${step} · 수신 중 ${elapsed} · 사고 ${(r.reasoningChars || 0).toLocaleString()}자 / 본문 ${(r.textChars || 0).toLocaleString()}자`;
    return `${step} · 응답 대기 ${elapsed}`;
}
function tickReq() {
    clearInterval(reqTicker);
    reqTicker = setInterval(() => {
        if (!ui.req || !['wait', 'stream'].includes(ui.req.phase)) { clearInterval(reqTicker); reqTicker = null; return; }
        $('#sp_overlay .sp-req').text(reqText());
        if (ui.progress === '짧은 연결 시험') $('#sp_probe_result').text(reqText());
    }, 1000);
}
async function readModelReply(reply, progress, active) {
    if (typeof reply === 'function') reply = await reply();
    let text = '', reasoningChars = 0, finishReason = null;
    const take = value => {
        if (!active()) throw new Cancelled('중지했어요.');
        const msg = value?.choices?.[0]?.message;
        const body = typeof value === 'string' ? value : value?.text ?? value?.content ?? msg?.content;
        if (typeof body === 'string') text = body;
        const thought = value?.state?.reasoning ?? value?.reasoning ?? msg?.reasoning_content;
        reasoningChars = typeof thought === 'string' ? thought.length : reasoningChars;
        finishReason = value?.finish_reason ?? value?.choices?.[0]?.finish_reason ?? finishReason;
        progress({ textChars: text.length, reasoningChars, finishReason });
    };
    if (reply && typeof reply[Symbol.asyncIterator] === 'function') {
        for await (const chunk of reply) take(chunk);
    } else take(reply);
    return { text, reasoningChars, finishReason };
}
async function llm(prompt, run, { attempt = 0, why = '', responseLength, timeoutSeconds } = {}) {
    const s = settings(), c = ctx(), max = responseLength ?? num('responseLength', 500, 64000);
    assertPromptFits(prompt, num('inputChars', 5000, 1000000));
    const limit = (timeoutSeconds ?? num('timeoutSec', 5, 3600)) * 1000;
    const id = ++reqSeq;
    const profileId = s.profileId;
    const stream = !!profileId && !!s.requestStream;
    const effort = ['low', 'high', 'max'].includes(s.reasoningEffort) ? s.reasoningEffort : '';
    const start = Date.now();
    let accepting = true;
    const stats = { at: start, task: ui.progress || '요청', profile: profileLabel(), stream: false,
        effort: profileId ? effort || '프로필 설정' : '메인 API 설정', chars: prompt.length,
        maxTokens: max, textChars: 0, reasoningChars: 0, firstDataMs: null, finishReason: null };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const onRunAbort = () => ctrl?.abort();
    if (run?.ctrl?.signal?.aborted) ctrl?.abort(); else run?.ctrl?.signal?.addEventListener?.('abort', onRunAbort);
    const active = () => accepting && !run?.cancelled && !ctrl?.signal?.aborted;
    const progress = part => {
        if (!active() || (run && ui.req?.id !== id)) return;
        Object.assign(stats, part);
        if (stats.firstDataMs === null && (stats.textChars || stats.reasoningChars)) stats.firstDataMs = Date.now() - start;
        if (run && stats.stream) ui.req = { ...ui.req, ...part, phase: 'stream' };
    };
    const send = async () => {
        let res;
        if (profileId) {
            const svc = c.ConnectionManagerRequestService;
            if (!svc?.sendRequest) throw new Error('이 실리태번 버전에서는 연결 프로필로 요청할 수 없어요. 설정에서 요약 AI를 메인 API로 바꿔 주세요.');
            const p = profiles().find(x => x.id === profileId);
            if (!p) throw new Error('선택한 연결 프로필을 찾을 수 없어요. 설정에서 요약 AI를 다시 골라 주세요.');
            stats.model = p.model || '';
            const payload = p.mode === 'tc' ? prompt : [{ role: 'user', content: prompt }];
            if (p.mode === 'tc') stats.effort = '프로필 설정 (텍스트 완성)';
            const overrides = effort && p.mode !== 'tc' ? { reasoning_effort: effort } : {};
            res = await svc.sendRequest(p.id, payload, max,
                { stream, signal: ctrl?.signal ?? null, extractData: true, includePreset: true, includeInstruct: true }, overrides);
        } else res = await c.generateRaw({ prompt, responseLength: max });
        stats.stream = typeof res === 'function' || !!res?.[Symbol.asyncIterator];
        const result = await readModelReply(res, progress, active);
        return result.text;
    };
    if (run) { ui.req = { id, attempt, why, start, phase: 'wait', chars: prompt.length }; render(); tickReq(); }
    let timer, onCancel;
    const request = send();
    request.catch(() => {});   // a late failure after the time limit is ignored
    const limitP = new Promise((_, reject) => { timer = setTimeout(() => reject(new RequestTimeout(`응답이 ${fmtSec(limit)} 안에 오지 않았어요.`)), limit); });
    const cancelP = new Promise((_, reject) => { onCancel = () => reject(new Cancelled('중지했어요.')); if (run) (run.onCancel ||= []).push(onCancel); });
    try {
        const raw = await Promise.race([request, limitP, cancelP]);
        stats.status = 'received';
        if (run && ui.req?.id === id) { ui.req = { ...ui.req, phase: 'got', ms: Date.now() - start }; render(); }
        return raw;
    } catch (e) {
        stats.status = e instanceof RequestTimeout ? 'timeout' : run?.cancelled || e instanceof Cancelled ? 'cancelled' : 'error';
        if (e instanceof RequestTimeout) { try { ctrl?.abort(); } catch { /* ignore */ } }
        throw e;
    } finally {
        accepting = false;
        stats.ms = Date.now() - start;
        if (!run || ui.req?.id === id) ui.lastRequest = { ...stats };
        clearTimeout(timer);
        run?.ctrl?.signal?.removeEventListener?.('abort', onRunAbort);
        if (run?.onCancel) run.onCancel = run.onCancel.filter(f => f !== onCancel);
    }
}
async function testConnection() {
    if (ui.run) { toastr.info('진행 중인 요청이 끝난 뒤 시험해 주세요.'); return; }
    if (!settings().profileId && mainBusy()) { toastr.info('본편 생성이 끝난 뒤 시험해 주세요.'); return; }
    const run = newRun(state(), -1);
    ui.progress = '짧은 연결 시험';
    $('#sp_probe_result').text('짧은 연결 시험 · 응답 대기 중…');
    try {
        const raw = await llm('Reply with only this JSON object: {"ok":true}', run, { responseLength: 1024, timeoutSeconds: Math.min(60, num('timeoutSec', 5, 3600)) });
        if (run.cancelled) throw new Cancelled('중지했어요.');
        if (!raw.trim()) throw new Error(`응답은 왔지만 본문이 비어 있어요 (사고 ${ui.lastRequest?.reasoningChars || 0}자).`);
        ui.probeResult = `짧은 요청 응답: ${fmtSec(ui.lastRequest.ms)} · 본문 ${raw.length.toLocaleString()}자 / 사고 ${ui.lastRequest.reasoningChars.toLocaleString()}자. 긴 대화의 수집 성공 여부는 별도로 확인해야 해요.`;
        ui.lastError = null;
        toastr.success(ui.probeResult);
    } catch (e) {
        ui.probeResult = `짧은 연결 시험: ${errorText(e)}`;
        ui.lastError = { at: Date.now(), range: '짧은 연결 시험', detail: [ui.probeResult] };
        toastr.warning(ui.probeResult);
    } finally {
        endRun(run);
        $('#sp_probe_result').text(ui.probeResult || '');
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
function newRun(st, end, kind = '') {
    // kind: 'save' (quick save / scene clear), 'auto' (checkpoint), 'check', 'other' (memory edits by AI),
    // '' (no banner). The saving banner and the leaving-the-room notice depend on it.
    const run = { st, key: roomKey(), epoch: roomEpoch, cancelled: false, hashes: hashesTo(end),
        viaMain: !settings().profileId, ctrl: typeof AbortController === 'function' ? new AbortController() : null,
        kind, from: (st?.lastIndex ?? -1) + 1, roomName: `${charInfo()?.name ? charInfo().name + ' · ' : ''}${roomLabel(roomKey())}` };
    ui.run = run;
    updateSaveBanner();
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
    if ((run.notice || run.doneText) && run.key === roomKey()) {
        if (run.notice) flashSaveBanner(run.notice.text, { tone: run.notice.tone });
        else flashSaveBanner(run.doneText);
    }
    else updateSaveBanner();
}
function checkpoint(st) {
    const { undo, ...rest } = st;
    return clone(rest);
}

// One chunk: ask, check, retry once with the problems listed, then give up without saving.
function extractPrompt(mem, chunk, note = '') {
    const marked = lootForChunk(chunk);
    return buildExtractPrompt({ guide: settings().guide || DEFAULT_GUIDE, names: names(), card: cardText(), context: { ...promptContext(mem, chunk.text), time: storyTimeContext(mem) }, chunk, note: [note, lootBlock(marked)].filter(Boolean).join('\n\n') });
}
function lootForChunk(chunk) {
    const items = state()?.lootQueue || [];
    if (!items.length) return [];
    return lootInChunk(items.filter(x => !lootStatus(x, roomKey(), chat(), fingerprint, viewHash)), chunk.indices);
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
        const requestPrompt = attempt ? prompt + retryNote(groupErrors(errors), lang) + extractionRepairNote(chunk, data) : prompt;
        try {
            assertPromptFits(requestPrompt, num('inputChars', 5000, 1000000));
            run.lootAttempted = lootForChunk(chunk).map(x => x.id);
            raw = await llm(requestPrompt, run, { attempt, why });
        }
        catch (e) {
            if (run.cancelled || e instanceof Cancelled) throw new Cancelled('중지했어요.');
            if (e instanceof RequestTimeout) {
                const r = ui.lastRequest;
                tries.push(`${fmtSec(Date.now() - start)} · 제한 시간 초과로 취소${r ? ` · 수신 본문 ${r.textChars}자 / 사고 ${r.reasoningChars}자` : ''}`);
                throw fail(`${e.message} 이 구간(#${chunk.from}–#${chunk.to})은 취소했고 저장하지 않았어요.`, ['부분 응답과 늦게 도착하는 응답은 저장하지 않아요. 결과 복사의 마지막 요청에서 수신 여부를 확인할 수 있어요.']);
            }
            tries.push(`${fmtSec(Date.now() - start)} · 요청 오류: ${errorText(e)}`);
            throw fail(`요약 AI 요청이 실패했어요 (#${chunk.from}–#${chunk.to}): ${errorText(e)}`, []);
        }
        if (run.cancelled) throw new Cancelled('중지했어요.');
        const took = `${fmtSec(Date.now() - start)} · 입력 ${requestPrompt.length.toLocaleString()}자 (원문 ${chunk.text.length.toLocaleString()}자) · 응답 ${String(raw ?? '').length.toLocaleString()}자`;
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
            const moved = fixes.filter(f => f.startsWith('start:')).map(f => f.split(':')[2].split('>')[1]);
            const said = [merged ? `앞 장면에 이어지는 장면 ${merged}개를 앞 장면에 합쳤어요` : '', moved.length ? `장면 시작 번호가 맞지 않아 ${moved.map(n => '#' + n).join(', ')}부터로 고쳤어요` : ''].filter(Boolean);
            const titles = fixes.filter(f => f.startsWith('title:')).length, outlines = fixes.filter(f => f.startsWith('outline:')).length;
            if (titles) said.push(`제목 ${titles}개를 임시로 보완했어요`);
            if (outlines) said.push(`개요 ${outlines}개를 포인트로 임시 보완했어요`);
            if (said.length) ui.lastFix = { at: Date.now(), range: `#${chunk.from}–#${chunk.to}`, text: said.join(' · ') };
            attachLoot(data, lootForChunk(chunk));
            return data;
        }
    }
    const detail = [...errors, ...(lang.length ? [`Not English: ${lang.join(', ')}`] : [])];
    return Promise.reject(fail(`요약 AI 응답이 검사를 통과하지 못했어요 (#${chunk.from}–#${chunk.to}). 이 구간은 저장하지 않았어요.`, detail));
}

// A failed checkpoint is kept in the room (chat file), so it survives a reload or a room switch.
// It is cleared only when the failed range has actually been recorded and saved, by a later
// checkpoint or a quick save; a partial save keeps the part that is still unrecorded.
const FAIL_STAGE = { boundary: '장면 경계 확인', collect: '장면 기록', save: '채팅 파일 저장' };
const isTry = l => /^(첫 요청|재요청):/.test(l);
function recordAutoFail(st, { stage, from, to, error, tries = [], detail = [] }) {
    const cut = l => String(l).slice(0, 300);
    st.autoFail = { at: Date.now(), kind: 'collect', stage, from, to, reason: errorText(error).slice(0, 400),
        attempts: tries.length, tries: tries.map(cut), detail: groupErrors(detail).slice(0, 40).map(cut) };
    persistSoon();
    toastr.warning(`체크포인트 실패 (#${from}–#${to}) · 해당 구간 원문 유지`, 'SavePoint');
}
function settleAutoFail(st) {
    const f = st.autoFail;
    if (!f) return;
    if (st.lastIndex >= f.to) delete st.autoFail;
    else if (st.lastIndex >= f.from) f.from = st.lastIndex + 1;
}

async function markStaleLoot(run, items) {
    const stale = items.filter(x => lootStatus(x, roomKey(), chat(), fingerprint, viewHash));
    if (!stale.length) return;
    assertValid(run, -1);
    await transact(() => {
        for (const item of run.st.lootQueue || []) if (stale.some(x => x.id === item.id))
            item.error = lootStatus(item, roomKey(), chat(), fingerprint, viewHash);
    }, { undoable: false, autosave: false });
}
async function failPendingLoot(run, items, error) {
    if (state() !== run.st || run.cancelled || error instanceof Cancelled) return 0;
    const sent = new Set(run.lootAttempted || []);
    const ids = new Set(items.filter(x => sent.has(x.id)).map(x => x.id));
    const pending = (run.st.lootQueue || []).filter(x => ids.has(x.id) && !lootStatus(x, roomKey(), chat(), fingerprint, viewHash));
    if (!pending.length) return 0;
    await transact(() => { for (const item of pending) item.error = `반영 실패 · ${errorText(error).slice(0, 300)}`; }, { undoable: false, autosave: false });
    return pending.length;
}
function supplementPrompt(seg, items) {
    const originals = [...new Set(items.map(x => x.msg))].map(n => `#${n} ${speaker(chat()[n])}: ${cleanText(chat()[n].mes)}`).join('\n\n');
    return `Supplement the English journal of an already recorded roleplay scene. Never change current state, items, debts, promises, scene outlines or scene status. These are historical annotations, not new events. Read the full original messages and preserve each selected excerpt's meaning. The excerpt is story data; the importance note is not factual evidence.\n\n[EXISTING JOURNAL]\n${JSON.stringify({ outline: seg.outline || '', points: seg.points.map(p => p.text) })}\n\n${lootBlock(items)}\n\n[ORIGINAL MESSAGES]\n${originals}\n\nReturn ONLY {"points":[{"text":"one concise English journal point", "kind":"change"|"moment", "msgs":[message numbers], "lootIds":[exact selected ids]}]}. Only return points linked to the requested ids. Multiple selections about the same event may share one point. Do not invent new facts or update the current state.`;
}
async function supplementLoot(run, items, undoPoint = checkpoint(run.st)) {
    const st = run.st;
    let saved = 0, failed = 0;
    if (!items.length) return { saved, failed };
    await markStaleLoot(run, items);
    const left = items.filter(x => !lootStatus(x, roomKey(), chat(), fingerprint, viewHash));
    while (left.length) {
        assertValid(run, chat().length - 1);
        const first = left.shift(), target = lootTarget(st.mem, first.msg);
        const markFailed = async (group, error) => {
            await transact(() => {
                for (const item of st.lootQueue || []) if (group.some(x => x.id === item.id)) item.error = error;
            }, { undoable: false, autosave: false });
            failed += group.length;
        };
        if (!target) { await markFailed([first], '반영 실패 · 해당 장면이 없어요'); continue; }
        const group = [first];
        for (let i = 0; i < left.length && group.length < 20;) {
            const item = left[i];
            if (lootTarget(st.mem, item.msg)?.seg.id !== target.seg.id ||
                supplementPrompt(target.seg, [...group, item]).length + 1500 > num('inputChars', 5000, 1000000)) { i++; continue; }
            group.push(item); left.splice(i, 1);
        }
        const prompt = supplementPrompt(target.seg, group);
        try {
            assertPromptFits(prompt, num('inputChars', 5000, 1000000));
            ui.progress = `루팅한 기억 반영 · ${group.length}개`; render();
            let data, errors = [];
            for (let attempt = 0; attempt < 2; attempt++) {
                const requestPrompt = attempt ? prompt + retryNote(errors, []) : prompt;
                assertPromptFits(requestPrompt, num('inputChars', 5000, 1000000));
                run.lootAttempted = group.map(x => x.id);
                const raw = await llm(requestPrompt, run, { attempt, why: attempt ? '루팅 응답 검사' : '' });
                assertValid(run, chat().length - 1);
                try { data = parseJson(raw); } catch { data = null; }
                errors = !data || !Array.isArray(data.points) ? ['Return a JSON object with a points array.'] :
                    data.points.flatMap(p => !p || typeof p.text !== 'string' || !p.text.trim() || mostlyNonEnglish(p.text) ||
                        !['change', 'moment'].includes(p.kind) || !Array.isArray(p.lootIds) || !Array.isArray(p.msgs)
                        ? ['Each point needs English text, kind, msgs and lootIds.'] : []);
                if (!errors.length) break;
            }
            if (errors.length) throw new Error('응답이 검사를 통과하지 못했어요');
            const next = refreshProvisionalOutlines(applyLootSupplement(st.mem, target.seg.id, data, group));
            await transact(() => {
                const before = st.mem;
                st.mem = next; pushHistory(st, before, next, { kind: 'edit' });
                failed += settleLoot(st, group, next);
                st.undo = undoPoint;
                st.lastRecord = { at: Date.now(), from: Math.min(...group.map(x => x.msg)), to: Math.max(...group.map(x => x.msg)), kind: 'supplement' };
            }, { undoable: false, autosave: false, rehide: true });
            saved++;
        } catch (e) {
            if (e instanceof Cancelled || run.cancelled || state() !== st) throw e;
            await markFailed(group, `반영 실패 · ${errorText(e)}`);
            // An oversized source is deferred; an actual request failure stops this pass.
            if (e.name !== 'InputLimitError') break;
        }
    }
    return { saved, failed };
}

async function summarize({ close = false, auto = false } = {}) {
    if (ui.run) { toastr.info('이미 기록 중이에요.'); return; }
    if (!hasChat()) { toastr.warning('채팅방을 먼저 열어 주세요.'); return; }
    if (ui.edit) { toastr.warning('편집 중인 항목을 먼저 저장하거나 취소해 주세요.'); return; }
    if (!settings().profileId && mainBusy()) { toastr.info('본편 생성이 끝난 뒤 눌러 주세요. (연결 프로필을 고르면 생성 중에도 세이브할 수 있어요.)'); return; }
    const st = ensureState();
    if (!reconcile()) { render(); toastr.warning('예전 원문이 바뀌었어요. 창 위쪽 안내에서 먼저 처리해 주세요.'); return; }
    const latest = chat().length - 1;
    const start = st.lastIndex + 1;
    const pending = collect(start, latest);
    const reserve = auto ? Math.trunc(num('autoReserve', 0, 20)) : 0;
    const held = Math.min(reserve, pending.length);
    const msgs = auto ? pending.slice(0, pending.length - held) : pending;
    const end = auto ? (msgs.at(-1)?.index ?? st.lastIndex) : latest;
    // Retained tail messages and their loot never enter an automatic request.
    const queued = (st.lootQueue || []).filter(x => !auto || x.msg <= end);
    if (auto) {
        st.autoMark = latest; st.autoHold = null; st.autoAttemptAt = Date.now();
        persistSoon();
        if (!msgs.length && !queued.length) {
            const result = `체크포인트 · 기록할 메시지 없음 · 최근 ${held}개 여유분`;
            noteAuto(st, result, { end: latest, status: 'empty' });
            flashSaveBanner(result, { tone: 'info' });
            return;
        }
    }
    if (!msgs.length && !queued.length) {
        if (close && openScene(st.mem)) {
            try {
                await transact(() => {
                    const cur = state(), before = cur.mem;
                    cur.mem = closeOpenScene(before); pushHistory(cur, before, cur.mem, { kind: 'edit' });
                }, { rehide: true });
                toastr.success('진행 중이던 장면을 닫았어요.');
            } catch (e) { reportError(e); }
        } else if (settings().enabled && settings().hide && hasMemory(st.mem)) {
            try {
                await transact(() => {}, { undoable: false, autosave: false, rehide: true });
                toastr.info('기록할 새 메시지가 없어요. 하이드 상태를 다시 확인했어요.');
            } catch (e) { reportError(e); }
        } else toastr.info('기록할 새 메시지가 없어요.');
        return;
    }
    if (!auto) { st.autoMark = latest; st.autoHold = null; persistSoon(); }
    const run = newRun(st, end, auto ? 'auto' : 'save');
    run.auto = auto;
    const undoPoint = checkpoint(st);
    const memBefore = st.mem;
    let done = 0, cursor = 0;
    let stage = 'collect';
    const oldLoot = queued.filter(x => x.msg <= st.lastIndex);
    const attemptedLoot = new Set();
    let lootFailed = 0;
    try {
        while (cursor < msgs.length) {
            assertValid(run, end);
            stage = 'collect';
            const chunk = nextMessageChunk(msgs.slice(cursor), c => extractPrompt(st.mem, c), num('inputChars', 5000, 1000000));
            const last = cursor + chunk.indices.length === msgs.length;
            ui.progress = `${auto ? '체크포인트' : close ? '장면 클리어' : '퀵세이브'} ${done + 1}구간 #${chunk.from}–#${chunk.to} · ${cursor}/${msgs.length}메시지 완료`;
            render();
            const marked = lootForChunk(chunk);
            marked.forEach(x => attemptedLoot.add(x.id));
            const data = await extractChunk(st.mem, chunk, run);
            const coverTo = last ? end : chunk.to;
            assertValid(run, coverTo);
            const { mem: next } = applyResult(st.mem, data, chunk, { room: run.key, close: close && last });
            // Memory, position and hiding change together; a failed save puts all of it back.
            stage = 'save';
            await transact(() => {
                const before = st.mem;
                st.mem = next;
                pushHistory(st, before, next, { kind: 'summary', from: st.lastIndex + 1, to: coverTo });
                st.lastIndex = coverTo; st.hashes = run.hashes.slice(0, coverTo + 1);
                st.lastRecord = { at: Date.now(), from: start, to: coverTo, kind: auto ? 'checkpoint' : 'quicksave' };
                st.undo = undoPoint;
                settleAutoFail(st);
                lootFailed += settleLoot(st, marked, next);
            }, { undoable: false, autosave: false, rehide: true });
            done++; cursor += chunk.indices.length;
        }
        const supplement = await supplementLoot(run, oldLoot, undoPoint);
        done += supplement.saved; lootFailed += supplement.failed;
        if (!msgs.length && !supplement.saved && !close && settings().enabled && settings().hide && hasMemory(st.mem))
            await transact(() => {}, { undoable: false, autosave: false, rehide: true });
        if (close && !msgs.length && openScene(st.mem)) {
            assertValid(run, end);
            await transact(() => { const before = st.mem; st.mem = closeOpenScene(before); pushHistory(st, before, st.mem, { kind: 'edit' }); st.undo = undoPoint; }, { undoable: false, autosave: false, rehide: true });
            done++;
        }
        await markStaleLoot(run, queued.filter(x => !attemptedLoot.has(x.id) && !oldLoot.includes(x)));
        ui.lastError = null;
        if (!auto && (msgs.length || close)) toastr.success(close ? '장면 클리어! 진행 중이던 장면까지 기록하고 닫았어요.' : '퀵세이브 완료. 마지막 메시지까지 기록했어요.', 'SavePoint');
        if (done) run.doneText = `${close ? '장면 클리어 완료' : '저장 완료'}${st.lastIndex >= run.from ? ` · #${run.from}–#${st.lastIndex}` : ''}`;
        if (auto) {
            const extra = lootFailed ? ` · 루팅 ${lootFailed}개 반영 실패` : '';
            const result = msgs.length ? `체크포인트 완료 · #${start}–#${st.lastIndex} 기록 · 최근 ${held}개 여유분${extra}`
                : `체크포인트 · 루팅 ${supplement.saved}구간 보충 · 최근 ${held}개 여유분${extra}`;
            noteAuto(st, result, { end: latest, status: lootFailed ? 'partial' : done ? 'saved' : 'empty' });
            run.notice = { text: result, tone: lootFailed ? 'warning' : done ? 'success' : 'info' };
        }
        clearInterrupted(run.key);
    } catch (e) {
        if (queued.length && !(e instanceof Cancelled) && state() === st) {
            try { lootFailed += await failPendingLoot(run, queued, e); } catch { /* a failed disk write leaves the queue intact */ }
        }
        if (!(e instanceof Cancelled) && !e.detail) ui.lastError = { at: Date.now(), range: `#${msgs[cursor]?.index ?? start}–#${end}`, detail: [errorText(e)] };
        const where = done ? ` ${done}개 구간(${cursor}개 메시지)은 저장했고, 남은 ${msgs.length - cursor}개 메시지의 원문은 그대로 남겨 뒀어요.` : ' 기억과 원문은 바뀌지 않았어요.';
        // Leaving the room has its own notice (onChatChanged); don't repeat it in the new room.
        if (e instanceof Cancelled) { if (run.key === roomKey()) toastr.info(e.message + where, 'SavePoint'); }
        else { console.error('[SavePoint]', e, e.detail || ''); if (!auto) toastr.error(e.message + where, 'SavePoint', { timeOut: 12000 }); }
        if (auto && run.key === roomKey() && run.epoch === roomEpoch) {
            const cur = state();
            if (cur) {
                const cancelled = e instanceof Cancelled;
                const detail = Array.isArray(e.detail) ? e.detail : [];
                if (!cancelled) recordAutoFail(cur, { stage, from: msgs[cursor]?.index ?? start, to: end, error: e,
                    tries: detail.filter(isTry), detail: detail.filter(x => !isTry(x)) });
                const result = cursor ? `체크포인트 일부 저장 · #${start}–#${cur.lastIndex} 완료 · #${cur.lastIndex + 1}부터 다음에 다시`
                    : cancelled ? '체크포인트 취소 · 원문 유지 · 다음 간격에 다시'
                    : '체크포인트 실패 · 원문 유지';
                noteAuto(cur, result, { end: latest, status: cursor ? 'partial' : cancelled ? 'cancelled' : 'failed' });
                run.notice = { text: result, tone: 'warning' };
            }
        }
    } finally {
        if (lootFailed && state() === st) toastr.warning(`⚠ 루팅한 내용 ${lootFailed}개가 반영되지 않았어요`, 'SavePoint');
        endRun(run);
        if (done && run.key === roomKey()) { autosave(state()); if (state() === st) queueCheck(st, memBefore, { auto }); }
    }
}

// ───────── automatic collection (periodic quicksave) ─────────
//
// Count new eligible messages since the last attempt, not the pending backlog.
// Failures and partial saves wait for the next interval; manual quicksave is immediate.
let autoTimer = null;
function autoCount(st) {
    const mark = Math.max(st?.autoMark ?? -1, st?.lastIndex ?? -1);
    return collect(mark + 1, chat().length - 1).length;
}
function autoBlocked() {
    const s = settings(), st = state();
    if (!s.enabled || !s.auto || !hasChat()) return 'off';
    if (ui.run || ui.edit || mainBusy()) return 'busy';
    if (st?.review) return 'hold';
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
function noteAuto(st, result, { moveMark = true, end = chat().length - 1, status = '' } = {}) {
    st.autoLast = { at: Date.now(), result, status };
    if (moveMark) st.autoMark = end;
    persistSoon(); render();
}
async function autoCollect() {
    if (autoBlocked()) return;
    return summarize({ auto: true });
}

// ───────── record check (AI, warnings only) ─────────
//
// After a batch is saved, one extra call looks for contradictions between the changed state
// records and the journal, and for misreadings of the original messages. Nothing is changed:
// each finding shows the two conflicting sentences and the evidence, with "편집" or "무시".

// A target and every original message needed to judge it travel together.
// Missing/oversized evidence is deferred explicitly, never shortened.
function checkStatements(st, scope) {
    const mem = upgradeEvidence(st.mem);
    const recs = mem.records.filter(r => scope.records.includes(r.id));
    const segIds = new Set(scope.segs);
    for (const r of recs) for (const id of r.src || []) segIds.add(id);
    const segments = new Map(mem.scenes.flatMap(sc => sc.segs.map(g => [g.id, g])));
    const range = (from, to) => {
        const out = [];
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return out;
        if (to >= chat().length) return [from, to];
        for (let n = from; n <= to; n++) if (!chat()[n] || eligible(chat()[n])) out.push(n);
        return out;
    };
    const segmentNumbers = g => g.external || g.source ? [] : range(g.from, g.to);
    const numbers = refs => {
        const result = evidenceNumbers(mem, refs);
        for (const ref of refs || []) {
            const g = segments.get(ref);
            if (g && !g.external && !g.source) result.messages.push(...segmentNumbers(g));
        }
        result.messages = [...new Set(result.messages)].sort((a, b) => a - b);
        return result;
    };
    const localSegments = [...segments.values()].filter(g => segIds.has(g.id) && !g.external && !g.source);
    const points = localSegments.flatMap(g => g.points);
    const statements = [];
    for (const r of recs) {
        const evidence = numbers(r.msgs);
        let msgs = evidence.messages;
        const external = [...(r.oldEvidence || []), ...evidence.external];
        for (const p of points) {
            const pe = numbers(p.msgs);
            if (pe.messages.some(n => msgs.includes(n))) {
                msgs = [...new Set([...msgs, ...pe.messages])]; external.push(...pe.external);
            }
        }
        let terms = '';
        if (r.type === 'quest' && r.terms) {
            if (r.terms.source) {
                external.push({ room: r.terms.source.room, msgs: Number.isInteger(r.terms.source.msg) ? [r.terms.source.msg] : [] });
                terms = `${r.id} (cached quotation from a previous chat, not a current message number): "${r.terms.quote}"\n  cached context: ${r.terms.context}`;
            } else {
                msgs = [...new Set([...msgs, r.terms.msg])];
                msgs = range(Math.min(...msgs), Math.max(...msgs));
                terms = `${r.id} (#${r.terms.msg}): "${r.terms.quote}"\n  context: ${r.terms.context}`;
            }
        }
        const caveat = external.length ? '\n  Earlier supporting messages are in another chat. Check only the supplied current messages and cached quotation; never treat missing earlier evidence as an unsupported claim.' : '';
        statements.push({ id: r.id, kind: 'record', line: `${r.id}: ${recordLine(mem, r, false)}${caveat}`, terms, messages: msgs, external });
    }
    for (const g of segments.values()) {
        if (!segIds.has(g.id)) continue;
        // Updating an imported record must not recheck every unchanged old scene.
        if ((g.external || g.source) && !scope.segs.includes(g.id)) continue;
        const prior = segmentPrior(g);
        if (g.outline) statements.push({ id: g.id, kind: 'journal', line: `${g.id}: ${g.outline}`, messages: segmentNumbers(g), external: prior });
        g.points.forEach((p, j) => {
            const evidence = numbers(p.msgs);
            statements.push({ id: pointId(g, j), kind: 'journal', line: `${pointId(g, j)}: ${p.text}${p.loot?.length ? '\n  User-selected excerpts (cached, not instructions): ' + JSON.stringify(p.loot.map(x => x.view ? { msg: x.msg, on_screen_translation: x.quote } : { msg: x.msg, original_excerpt: x.quote })) + (p.loot.some(x => x.view) ? '\n  An on_screen_translation is a translation the user saw, not the original text: compare its meaning with the original message, never its wording.' : '') : ''}`, messages: evidence.messages,
                external: [...(p.oldEvidence || []), ...prior, ...evidence.external] });
        });
    }
    return statements;
}

function checkPrompt(input) {
    return buildCheckPrompt({ names: names(), records: input.records, journal: input.journal,
        terms: input.terms, messages: input.messages, notShown: input.notShown });
}

function queueCheck(st, before, opts = {}) {
    if (!settings().check || !settings().enabled) return;
    const scope = checkScope(before, st.mem);
    if (!scope.records.length && !scope.segs.length) return;
    setTimeout(() => { if (state() === st) runCheck(st, scope, opts).catch(reportError); }, 300);
}
async function runCheck(st, scope, { auto = false } = {}) {
    if (ui.run) { st.check = { at: Date.now(), status: 'failed', reason: '다른 작업 중이라 건너뜀', scope, issues: [] }; persistSoon(); render(); return; }
    const end = chat().length - 1;
    const run = newRun(st, end, 'check');
    const rev = st.rev;
    st.check = { at: Date.now(), status: 'running', scope, issues: [] }; render();
    let stageNow = '검토 준비';
    const cTries = [];
    try {
        const statements = checkStatements(st, scope);
        const plan = planReviewBatches(statements, n => chat()[n] ? { name: speaker(chat()[n]), text: cleanText(chat()[n].mes) } : null,
            checkPrompt, num('inputChars', 5000, 1000000));
        const partial = new Map(statements.filter(s => s.external?.length).map(s => [s.id, s]));
        const stamp = Date.now().toString(36);
        const issues = [], keys = new Set(), sent = new Set();
        const coverage = { sent: 0, cut: [], missing: [], batches: plan.batches.length, checked: 0, deferred: plan.deferred.length };
        for (let i = 0; i < plan.batches.length; i++) {
            stageNow = `검토 ${i + 1}/${plan.batches.length}구간`;
            assertValid(run, end);
            if (st.rev !== rev) throw new Cancelled('검사 중 기억이 바뀌어서 검토를 멈췄어요.');
            const input = plan.batches[i], prompt = checkPrompt(input);
            ui.progress = `기록 확인 ${i + 1}/${plan.batches.length}구간 · 원문 전체 확인`; render();
            let result = null, errors = [], cKind = '';
            for (let attempt = 0; attempt < 2 && !result; attempt++) {
                const t0 = Date.now(), label = `${stageNow} ${attempt ? '재요청' : '첫 요청'}`;
                let raw;
                try { raw = await llm(attempt ? prompt + retryNote(errors, []) : prompt, run, { attempt, why: attempt ? cKind : '' }); }
                catch (e) {
                    if (!(e instanceof Cancelled)) cTries.push(`${label}: ${fmtSec(Date.now() - t0)} · ${e instanceof RequestTimeout ? '응답 없음 → 제한 시간 초과로 취소' : `요청 오류: ${errorText(e)}`}`);
                    throw e;
                }
                assertValid(run, end);
                let parsed = null;
                try { parsed = parseJson(raw); } catch { /* below */ }
                if (parsed) { const r = validateCheck(parsed, input.ids); errors = r.errors; if (!errors.length) result = r; }
                else errors = ['The reply was not valid JSON.'];
                cKind = replyKind(raw) || (!parsed ? 'JSON 해석 실패' : `형식 오류 ${errors.length}건`);
                cTries.push(`${label}: ${fmtSec(Date.now() - t0)} · 응답 ${String(raw ?? '').length.toLocaleString()}자 · ${result ? '통과' : cKind}`);
            }
            if (!result) throw new Error(`검사 ${i + 1}/${plan.batches.length}구간 응답: ${cKind}`);
            if (st.rev !== rev) throw new Cancelled('검사 중 기억이 바뀌어서 검토를 멈췄어요.');
            for (const n of Object.keys(input.sent)) sent.add(Number(n));
            coverage.checked += input.ids.size;
            for (const x of result.issues) {
                if (partial.has(x.about) || (x.also && partial.has(x.also))) {
                    // Old numbers are never fetched. An absent old source is not
                    // proof of an error. Keep only contradictions quoting a line
                    // actually present in this request's current-room originals.
                    if (x.kind !== 'misread' || x.basis !== 'contradicted' || !quoteWasSent(x.conflict[1], input.sent)) continue;
                }
                // A "the original says otherwise" warning must quote a line that was actually sent.
                if (x.basis === 'contradicted' && x.kind !== 'partial') {
                    if (!quoteWasSent(x.conflict?.[1], input.sent)) {
                        x.was = x.kind; x.kind = 'partial';
                        x.gaps = [{ label: '인용 확인 실패', how: 'AI가 든 원문 인용을 보낸 원문에서 찾지 못함' }];
                    }
                }
                // A model cannot supply evidence from outside this request.
                const outside = x.msgs.filter(n => input.cover[n] !== 'whole');
                if (outside.length) { x.kind = 'partial'; x.gaps = outside.map(n => ({ n, how: '이 검토 요청에 없는 근거 번호' })); }
                const key = JSON.stringify([x.about, x.also || '', x.kind, [...x.msgs].sort((a, b) => a - b)]);
                if (keys.has(key)) continue;
                keys.add(key);
                issues.push({ ...x, id: `c${stamp}${issues.length}`, ignored: false,
                    excerpt: x.msgs.filter(n => input.cover[n] === 'whole').map(n => `#${n} ${speaker(chat()[n])}: ${input.sent[n].slice(0, 220)}`).slice(0, 2) });
            }
        }
        assertValid(run, end);
        if (st.rev !== rev) throw new Cancelled('검사 중 기억이 바뀌어서 검토를 멈췄어요.');
        const allNeeded = new Set(statements.flatMap(s => s.messages));
        coverage.sent = sent.size;
        coverage.missing = [...allNeeded].filter(n => !sent.has(n)).sort((a, b) => a - b);
        const deferredIds = new Set(plan.deferred.map(d => d.id));
        for (const entry of partial.values()) if (!deferredIds.has(entry.id)) plan.deferred.push({ ...entry, reason: 'foreign', missing: [] });
        coverage.deferred = plan.deferred.length;
        for (const d of plan.deferred) {
            const problem = d.reason === 'foreign'
                ? '근거가 이전 방에 있음 · 이전 원문 전체 확인은 보류했어요. 현재 방 근거와 저장된 조건 인용·문맥이 있으면 그 범위만 비교했어요. 기록 저장·업데이트는 유지돼요.'
                : d.reason === 'size'
                ? `근거 원문 전체를 함께 보내려면 ${d.chars.toLocaleString()}자가 필요해요 (입력 한도 ${num('inputChars', 5000, 1000000).toLocaleString()}자). 원문을 자르지 않고 이 항목의 검토를 보류했어요. 입력 한도를 늘린 뒤 다시 확인해 주세요.`
                : d.reason === 'missing' ? '근거 원문을 찾을 수 없어 이 항목의 검토를 보류했어요.' : '근거 메시지 번호가 없어 이 항목의 검토를 보류했어요.';
            issues.push({ id: `c${stamp}${issues.length}`, about: d.id, kind: 'partial', ignored: false,
                msgs: d.messages, conflict: [], excerpt: [], problem,
                gaps: d.reason === 'foreign' ? [{ label: '이전 방 근거', how: '현재 방 번호로 조회하지 않음' }] : (d.missing.length ? d.missing : d.messages).map(n => ({ n, how: d.reason === 'missing' ? '원문 없음' : '이 항목의 검토 보류' })) });
        }
        st.check = { at: Date.now(), status: issues.length ? 'issues' : 'ok', scope, issues, coverage };
    } catch (e) {
        if (state() === st) {
            st.check = { at: Date.now(), status: 'failed', kind: 'review', auto, stage: stageNow, attempts: cTries.length, tries: cTries.map(l => l.slice(0, 300)),
                reason: e instanceof Cancelled ? '취소됨 · 전체 검토 미완료' : errorText(e).slice(0, 400), scope, issues: [] };
            if (auto && !(e instanceof Cancelled)) toastr.warning('체크포인트 저장 후 기록 확인 실패 · 기록은 저장됨', 'SavePoint');
        }
    } finally {
        endRun(run);
        if (state() === st) { persistSoon(); render(); }
    }
}

// A quoted message line counts only if it appears in the originals actually sent. Models often copy
// the "Name: " that precedes each message in the request, so that prefix is ignored.
function quoteWasSent(raw, sent) {
    const quote = String(raw || '').trim();
    if (!quote) return false;
    const bare = quote.replace(/^[^:\n"“]{1,40}:\s*/, '');
    return Object.values(sent).some(t => [quote, bare].some(q => q && (t.includes(q) || findQuote(t, q))));
}
const gapText = gaps => gaps.map(g => `${g.label || '#' + g.n} ${g.how}`).join(', ');
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
    const r = ui.lastRequest;
    if (r) out.push('', `[마지막 요청] ${r.task} · ${r.profile}${r.model ? ' · ' + r.model : ''} · ${r.status} · ${fmtSec(r.ms)}`,
        `입력 ${r.chars}자 · 응답 상한 ${r.maxTokens}토큰 · ${r.stream ? '실시간 수신' : '일괄 응답'} · 추론 요청: ${r.effort}`,
        `수신 본문 ${r.textChars}자 / 사고 ${r.reasoningChars}자 · 첫 내용 수신 ${r.firstDataMs === null ? '없음' : fmtSec(r.firstDataMs)} · 종료 사유 ${r.finishReason || 'API에서 제공하지 않음'}`);
    if (hasChat()) out.push(`방: ${names().char || ''} · 기록 ${st ? st.lastIndex + 1 : 0} / ${chat().length}`);
    if (ui.lastFix) out.push('', `[자동 보정] ${ui.lastFix.range} · ${ui.lastFix.text}`);
    if (st?.autoFail) out.push('', '[체크포인트 실패 · 수집]', ...autoFailLines(st.autoFail).map(l => `- ${l}`));
    if (ui.lastError) {
        out.push('', `[마지막 실패] ${ui.lastError.range} · ${new Date(ui.lastError.at).toLocaleString()}`);
        for (const d of groupErrors(ui.lastError.detail)) out.push(`- ${d}`);
    }
    const c = st?.check;
    if (c && c.status !== 'running') {
        const all = c.issues || [];
        const state = c.status === 'failed' ? `저장 후 검토 실패 (${c.reason || ''}) · 기록은 저장됨${c.stage ? ` · 단계: ${c.stage}` : ''}${c.attempts !== undefined ? ` · 요청 ${c.attempts}회` : ''}` : all.filter(x => !x.ignored).length ? `확인 필요 ${all.filter(x => !x.ignored).length}건` : '문제 없음';
        out.push('', `[기록 확인] ${new Date(c.at).toLocaleString()} · ${state}`);
        if (c.coverage?.batches !== undefined) out.push(`검토 요청 ${c.coverage.batches}회 · 검토 보류 ${c.coverage.deferred || 0}개 항목`);
        if (c.status === 'failed') for (const t of c.tries || []) out.push(`- ${t}`);
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
function autoFailLines(f) {
    return [`시각: ${new Date(f.at).toLocaleString()}`, `단계: ${FAIL_STAGE[f.stage] || f.stage}`, `메시지 범위: #${f.from}–#${f.to}`, `이유: ${f.reason}`,
        `요청 횟수: ${f.attempts}`, ...(f.tries || []), ...(f.detail || [])];
}
function autoFailHtml(st) {
    const f = st?.autoFail;
    if (!f) return '';
    return `<details class="sp-err" data-group="hud-autofail" ${ui.savesOpen.get('hud-autofail') ? 'open' : ''}><summary>⚠ 체크포인트 실패 #${f.from}–#${f.to} · ${new Date(f.at).toLocaleTimeString()} — 자세히</summary><ul class="sp-scroll">${autoFailLines(f).map(l => `<li>${esc(l)}</li>`).join('')}<li class="sp-dim">해당 구간 원문은 그대로예요. 다음 체크포인트나 퀵세이브로 이 구간이 저장되면 이 기록이 사라져요.</li></ul></details>`;
}
function checkHtml(st) {
    const c = st?.check;
    if (!c || !settings().check) return '';
    const at = new Date(c.at).toLocaleTimeString();
    if (c.status === 'running') return '';
    if (c.status === 'failed') return `<div class="sp-hud-meta"><span class="sp-warn">저장 후 기록 확인 실패 (${esc(c.reason || '')}) · 기록은 저장됨 · ${at}</span>${btn('check-rerun', '', '다시 확인')}</div>`;
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
    const run = newRun(st, -1, 'other');
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
    const run = newRun(st, -1, 'other');
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
        refreshProvisionalOutlines(next);
        st.mem = next; pushHistory(st, before, next, { kind: 'edit' });
    }, { undoable });
}
async function undo() {
    const st = state();
    if (!st?.undo || ui.run) return;
    const restored = { ...clone(st.undo), undo: null };
    restored.lootQueue = restoreLostLoot(st.lootQueue, st.mem, restored.mem, { room: roomKey(), hashes: st.hashes, fallback: st.undo.lootQueue });
    await transact(() => { ctx().chatMetadata[MODULE] = restored; }, { undoable: false });
    if (!reconcile()) { render(); return; }
    toastr.info('⏪ 리와인드: 마지막 작업 전으로 돌아갔어요.');
}
async function clearRoom() {
    const st = state();
    if (!st || !(await confirmBox('리셋: 이 방의 기억을 모두 지울까요? 세이브 슬롯은 남아요. (⏪ 리와인드로 되돌릴 수 있어요)'))) return;
    await transact(() => { ctx().chatMetadata[MODULE] = freshState({ autoMark: chat().length - 1, lootQueue: clone(st.lootQueue || []) }); });
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
async function loadSave(id) {
    if (ui.run) return;
    const save = findSave(id);
    if (!save || !hasChat()) return;
    let mem, sourceRoom;
    try {
        const body = await readSave(save);
        mem = cleanMem(body?.mem);
        sourceRoom = typeof body?.room === 'string' ? body.room : typeof save.room === 'string' ? save.room : null;
    } catch (e) { reportError(e); return; }
    const cur = state();
    if (cur && hasMemory(cur.mem) && !(await confirmBox('이 방의 지금 기억을 이 세이브 슬롯으로 바꿀까요? (⏪ 리와인드로 되돌릴 수 있어요)'))) return;
    const st = freshState({ mem, lootQueue: clone(cur?.lootQueue || []), linkedSave: save.auto ? null : id, autoMark: chat().length - 1 });
    const p = save.pos;
    let exact = false;
    if (p && Number.isInteger(p.lastIndex) && p.lastIndex >= 0 && p.lastIndex < chat().length) {
        const h = hashesTo(p.lastIndex);
        if (digest(h) === p.digest) { exact = true; st.lastIndex = p.lastIndex; st.hashes = h; st.floor = p.lastIndex; }
    }
    if (!exact) st.mem = detachMem(mem, sourceRoom);
    if (cur) st.lootQueue = restoreLostLoot(cur.lootQueue, cur.mem, st.mem, { room: roomKey(), hashes: cur.hashes, fallback: cur.undo?.lootQueue });
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
function closeWindow() { tabResizeObserver?.disconnect(); ui.open = false; ui.edit = null; $('#sp_overlay').hide(); updateSaveBanner(); }

// Checks one excerpt against its message and builds the queue item. The excerpt may come from the
// original or, when a translator shows a translation instead, from that on-screen translation.
function prepareLoot(index, excerpt, note = '', source = {}) {
    const message = chat()[index];
    if (source.room && source.room !== roomKey() || source.hash && source.hash !== fingerprint(message))
        throw new Error(`#${index}: 창을 연 뒤 원문이나 방이 바뀌었어요. 창을 닫고 다시 루팅해 주세요.`);
    if (!eligible(message) || message.is_user) throw new Error(`#${index}은(는) 담을 수 있는 AI 답변이 아니에요.`);
    const pick = (full, raw) => {
        let quote = String(raw || '').trim();
        if (!quote || !full) return '';
        if (full.includes(quote)) return quote;
        const match = findQuote(full, quote);
        return match ? full.slice(match.start, match.end) : '';
    };
    const full = cleanText(message.mes), shown = viewText(message);
    let quote = pick(full, excerpt), view = false;
    if (!quote && shown) { quote = pick(shown, excerpt); view = !!quote; }
    if (!quote) throw new Error(`#${index}: 원문이나 화면의 번역문에서 이 구절을 찾지 못했어요. 이어진 구절인지 확인하고, 아주 짧다면 주변 문장까지 조금 더 넓게 선택해 주세요.`);
    return { id: newId(), room: roomKey(), msg: index, text: quote, note: String(note || '').trim(),
        hash: fingerprint(message), at: Date.now(), ...(view ? { view: true, viewHash: viewHash(message) } : {}) };
}
async function addLootItems(items) {
    if (!hasChat() || ui.run) throw new Error('기록이 끝난 뒤 루팅해 주세요.');
    const st = ensureState();
    let added = 0;
    await transact(() => {
        st.lootQueue ||= [];
        for (const item of items) {
            if (st.lootQueue.some(x => x.room === item.room && x.msg === item.msg && x.text === item.text && x.hash === item.hash && x.note === item.note)) continue;
            st.lootQueue.push(item); added++;
        }
        if (!added) return false;
    }, { undoable: false, autosave: false });
    return added;
}
async function addLoot(index, excerpt, note = '', source = {}) {
    if (!hasChat() || ui.run) throw new Error('기록이 끝난 뒤 루팅해 주세요.');
    return addLootItems([prepareLoot(index, excerpt, note, source)]);
}
const lootable = m => eligible(m) && !m.is_user;
function nearLootable(from, step) {
    for (let i = from; i >= 0 && i < chat().length; i += step) if (lootable(chat()[i])) return i;
    return -1;
}
// parts: [{ index, text }] from a selection. With a selection the dialog has two tabs: the selected
// passages (one item per message) and the whole reply, starting at the selected message. Without one
// it opens on the whole latest AI reply. ◀ ▶ step through AI replies. The dialog wears the status
// window's theme. Submitting takes what the open tab shows.
function openLootDialog(parts = null) {
    if (ui.run || mainBusy()) { toastr.info('진행 중인 생성이나 기록이 끝난 뒤 루팅해 주세요.'); return; }
    if (!hasChat()) { toastr.warning('채팅방을 먼저 열어 주세요.'); return; }
    if (typeof parts === 'number') parts = [{ index: parts, text: '' }];
    const picked = (Array.isArray(parts) ? parts : []).filter(p => lootable(chat()[p.index]) && String(p.text || '').trim());
    if (Array.isArray(parts) && parts.length && !picked.length) { toastr.info('선택한 구절이 AI 답변에 없어요. AI 답변에서 골라 주세요.'); return; }
    const start = picked.length ? picked[0].index : nearLootable(chat().length - 1, -1);
    if (start < 0) { toastr.info('담을 AI 답변이 없어요.'); return; }
    document.querySelector('#sp_loot_dialog')?.remove();
    const source = i => ({ room: roomKey(), hash: fingerprint(chat()[i]) });
    const full = i => cleanText(chat()[i].mes);
    const rows = t => Math.min(9, Math.max(2, Math.ceil(t.length / 32) + 1));
    const sel = picked.map(p => ({ index: p.index, text: p.text.trim(), source: source(p.index) }));
    const whole = { index: start, text: full(start), source: source(start) };
    let tab = sel.length ? 'sel' : 'full';
    const theme = settings().theme in THEMES ? settings().theme : 'jrpg';
    const dialog = document.createElement('dialog');
    dialog.id = 'sp_loot_dialog'; dialog.className = 'sp-loot-dialog sp-window';
    dialog.setAttribute('data-theme', theme);
    const selHtml = () => `<p class="sp-dim">${sel.length > 1 ? `선택이 메시지 ${sel.length}개에 걸쳐 있어서 메시지별로 나눠 담아요.` : '선택한 구절을 담아요. 고쳐서 담을 수도 있어요.'}</p>` +
        sel.map((b, k) => `<div class="sp-loot-part"><div class="sp-loot-head"><b>#${b.index}</b></div>
            <textarea name="excerpt" data-k="${k}" rows="${rows(b.text)}" required>${esc(b.text)}</textarea></div>`).join('');
    const fullHtml = () => `<p class="sp-dim">${sel.length ? '선택한 메시지의 원문 전체예요.' : '가장 최근 AI 답변이에요.'} ◀ ▶로 다른 답변을 고르거나, 필요한 부분만 남겨 주세요.</p>
        <div class="sp-loot-part"><div class="sp-loot-head"><b>#${whole.index}</b><span class="sp-loot-nav">
        <button type="button" class="sp-btn sp-mini sp-loot-prev" title="이전 AI 답변">◀</button><button type="button" class="sp-btn sp-mini sp-loot-next" title="다음 AI 답변">▶</button></span></div>
        <textarea name="excerpt" data-k="full" rows="9" required>${esc(whole.text)}</textarea></div>`;
    dialog.innerHTML = `<form><div class="sp-loot-title">💎 루팅</div>
        ${sel.length ? `<div class="sp-tabs sp-loot-tabs"><button type="button" class="sp-tab" data-tab="sel">선택한 구절 <em>${sel.length}</em></button><button type="button" class="sp-tab" data-tab="full">원문 전체</button></div>` : ''}
        <div class="sp-loot-body"></div>
        <label class="sp-loot-note">메모 (선택)<input name="note" type="text" placeholder="왜 중요한지 적어 주세요"></label>
        <p class="sp-dim sp-loot-hint">다음 세이브 때 반영해요.</p>
        <p class="sp-loot-error" role="alert"></p><div class="sp-loot-actions"><button type="button" class="sp-btn sp-loot-cancel">취소</button><button type="submit" class="sp-btn sp-primary">⏳ 대기열에 담기</button></div></form>`;
    const body = dialog.querySelector('.sp-loot-body');
    const draw = () => {
        body.innerHTML = tab === 'sel' ? selHtml() : fullHtml();
        dialog.querySelectorAll('.sp-loot-tabs .sp-tab').forEach(t => t.classList.toggle('sp-active', t.getAttribute('data-tab') === tab));
        body.querySelectorAll('textarea').forEach(t => {
            t.oninput = () => { const k = t.getAttribute('data-k'); (k === 'full' ? whole : sel[Number(k)]).text = t.value; };
        });
        const go = step => () => {
            const i = nearLootable(whole.index + step, step);
            if (i < 0) return;
            Object.assign(whole, { index: i, text: full(i), source: source(i) }); draw();
        };
        const prev = body.querySelector('.sp-loot-prev'), next = body.querySelector('.sp-loot-next');
        if (prev) { prev.onclick = go(-1); next.onclick = go(1); }
    };
    dialog.querySelectorAll('.sp-loot-tabs .sp-tab').forEach(t => { t.onclick = () => { tab = t.getAttribute('data-tab'); draw(); }; });
    draw();
    dialog.querySelector('.sp-loot-cancel').onclick = () => dialog.close();
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const submit = dialog.querySelector('[type=submit]'); submit.disabled = true;
        try {
            const note = dialog.querySelector('[name=note]').value;
            const items = (tab === 'sel' ? sel : [whole]).map(b => prepareLoot(b.index, b.text, note, b.source));
            const added = await addLootItems(items);
            dialog.close();
            const n = state().lootQueue?.length || 0;
            toastr.success(added ? `⏳ 대기열에 담았어요 (${n}개)` : '이미 대기열에 있는 구절이에요.', 'SavePoint', { timeOut: 2000 });
        } catch (err) { dialog.querySelector('.sp-loot-error').textContent = errorText(err); submit.disabled = false; }
    };
    document.body.append(dialog); dialog.showModal();
}
// ───────── 💎 in the chat bar ─────────
// One button next to the extensions wand. With text selected in AI replies it opens the looting
// form with that selection (split per message); without a selection, with the latest reply.
// Selections are remembered, because on phones tapping a button can clear the selection first.
let lootSelection = null;   // { parts, clearedAt }
function selectionParts() {
    const sel = globalThis.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const box = document.getElementById('chat');
    if (!box || !(box.contains(sel.anchorNode) || box.contains(sel.focusNode))) return null;
    const parts = [];
    for (let r = 0; r < sel.rangeCount; r++) {
        const range = sel.getRangeAt(r);
        for (const el of box.querySelectorAll('.mes[mesid] .mes_text')) {
            if (!range.intersectsNode(el)) continue;
            const sub = document.createRange();
            sub.selectNodeContents(el);
            if (range.compareBoundaryPoints(Range.START_TO_START, sub) > 0) sub.setStart(range.startContainer, range.startOffset);
            if (range.compareBoundaryPoints(Range.END_TO_END, sub) < 0) sub.setEnd(range.endContainer, range.endOffset);
            const text = sub.toString().trim();
            if (text) parts.push({ index: Number(el.closest('.mes').getAttribute('mesid')), text });
        }
    }
    return parts.length ? parts.sort((x, y) => x.index - y.index) : null;
}
function trackSelection() {
    const parts = selectionParts();
    if (parts) lootSelection = { parts, clearedAt: 0 };
    else if (lootSelection && !lootSelection.clearedAt) lootSelection.clearedAt = Date.now();
}
function lootFromBar() {
    const now = selectionParts();
    const recent = lootSelection && (!lootSelection.clearedAt || Date.now() - lootSelection.clearedAt < 1500) ? lootSelection.parts : null;
    const parts = now || recent;
    lootSelection = null;
    openLootDialog(parts);
    if (parts) globalThis.getSelection?.()?.removeAllRanges?.();
}
function installLootBar() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    let button = document.getElementById('sp_loot_bar');
    if (!settings().enabled) { button?.remove(); return; }
    const host = document.getElementById('leftSendForm') || document.getElementById('send_form');
    if (!host) return;
    if (!button) {
        button = document.createElement('div');
        button.id = 'sp_loot_bar'; button.className = 'sp-loot-bar interactable';
        button.textContent = '💎';
        button.title = '💎 루팅 · 드래그한 구절이 있으면 그 구절, 없으면 최근 AI 답변'; button.setAttribute('aria-label', '💎 루팅');
        button.setAttribute('role', 'button'); button.tabIndex = 0;
        // Keep the text selection when the button is pressed.
        button.addEventListener('pointerdown', e => e.preventDefault());
        button.addEventListener('mousedown', e => e.preventDefault());
        button.onclick = e => { e.preventDefault(); e.stopPropagation(); lootFromBar(); };
        button.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lootFromBar(); } };
    }
    const wand = document.getElementById('extensionsMenuButton');
    if (wand && host.contains(wand)) {
        // SillyTavern orders the wand with flex order; DOM placement alone puts 💎 first.
        button.style.order = globalThis.getComputedStyle(wand).order;
        if (wand.nextElementSibling !== button) wand.insertAdjacentElement('afterend', button);
    } else if (button.parentElement !== host) host.append(button);
}
function queueHtml(st) {
    const items = st.lootQueue || [];
    if (!items.length) return '<div class="sp-empty">⏳ 대기열이 비었어요.<br>채팅창의 💎로 담아 주세요. 구절을 드래그한 뒤 누르면 그 구절만 담겨요.</div>';
    return `<p class="sp-dim">다음 퀵세이브·체크포인트 때 반영해요. 선택한 내용은 기억 주입에 우선 반영해요.</p>` + items.map(item => {
        const changed = lootStatus(item, roomKey(), chat(), fingerprint, viewHash) || lootWarning(item, chat(), viewHash);
        return `<div class="sp-card sp-queued"><div class="sp-row"><b>${item.room === roomKey() ? '' : '이전 방 '}#${item.msg}</b>${tools([btn('loot-delete', item.id, '🗑', '대기열에서 삭제', ui.run ? 'sp-disabled' : '')])}</div>
            ${changed ? `<div class="sp-warn">${esc(changed)}</div>` : ''}${item.error && item.error !== changed ? `<div class="sp-warn">⚠ ${esc(item.error)}</div>` : ''}
            <blockquote>${esc(item.text)}</blockquote>${item.note ? `<p class="sp-dim">메모: ${esc(item.note)}</p>` : ''}</div>`;
    }).join('');
}

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
function priorRoomLabel(room) {
    if (!room) return '이전 방·출처 미상';
    const mem = state()?.mem;
    const rooms = [...new Set((mem?.scenes || []).flatMap(s => s.segs.flatMap(g => [g.source?.room, ...g.points.flatMap(p => (p.oldEvidence || []).map(e => e.room))]))
        .concat((mem?.records || []).flatMap(r => [r.terms?.source?.room, ...(r.oldEvidence || []).map(e => e.room)])).filter(Boolean))];
    if (!rooms.includes(room)) rooms.push(room);
    return rooms.length > 1 ? `이전 방 ${rooms.indexOf(room) + 1}` : '이전 방';
}
function priorTermsLabel(terms) {
    return terms.source ? `${priorRoomLabel(terms.source.room)}${Number.isInteger(terms.source.msg) ? ' #' + terms.source.msg : ''}` : `#${terms.msg}`;
}
function evidenceChips(msgs, oldEvidence = []) {
    const list = [...evidenceText(msgs), ...oldEvidence.flatMap(e => evidenceText(e.msgs).map(t => `${priorRoomLabel(e.room)} ${t}`))];
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
    const local = s.segs.filter(g => !g.external && !g.source);
    if (!local.length) return '다른 방에서 가져옴';
    const a = local[0]?.from, b = local[local.length - 1]?.to;
    return Number.isInteger(a) && Number.isInteger(b) ? `${local.length < s.segs.length ? '이전 방 구간 포함 · ' : ''}#${a}–#${b}` : '';
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
    else if (e.kind === 'segtime') body = `<p class="sp-dim">${v.edge === 'start' ? '구간 시작' : '구간 끝'} 시간을 직접 지정해요.</p>` + field('date', '이야기 속 날짜 (작품 표현 그대로)') + field('day', '해당 기준 일 수 (1 이상, 미상은 빈칸)') + select('period', '시간대', [['', '미상'], ...PERIODS.map((p, i) => [p, ['새벽', '아침', '낮', '오후', '저녁', '밤'][i]])]) + field('clock', '정확한 시각 (HH:mm, 선택)') + select('mode', '구간 종류', [['present', '현재 진행'], ['flashback', '회상 장면']]) + '<p class="sp-dim">직접 지정한 값은 보존하고, 이후 연결된 시간만 다시 계산해요. 비어 있던 일 수는 1일째로 채우지 않아요. 과거 구간의 원문은 이 방 번호로 다시 조회하지 않아요.</p>';
    else if (e.kind === 'segoutline') body = field('outline', '이 구간 개요 (영어)', 3);
    else if (e.kind === 'point') body = field('text', '포인트 (영어)', 3);
    else if (e.kind === 'notes') body = field('notes', '상세 노트 (영어)', 7);
    else if (e.kind === 'entity') body = field('name', '이름 (영어)') + field('aliases', '별칭 (쉼표로 구분, 원문 표기 그대로)') + select('type', '종류', ENTITY_TYPES.map(t => [t, KIND_KO[t]]));
    else if (e.kind === 'record') {
        const t = v.type;
        if (t === 'party') body = select('entity', '인물', ents('person')) + select('aspect', '항목', [['relation', '관계'], ['condition', '상태']]);
        if (t === 'item') body = select('entity', '물건', ents('item')) + select('holder', '가진 사람', ents('person'));
        if (t === 'quest') body = select('kind', '종류', QUEST_KINDS.map(k => [k, KIND_KO[k]])) + select('status', '상태', [['open', '진행 중'], ['done', '완료'], ['failed', '실패']]);
        if (t === 'quest' && ['promise', 'debt'].includes(v.kind)) {
            const nowLabel = storyTimeContext(state()?.mem || {}, 'ko');
            body += field('dueExpr', '기한 (원문 표현, 예: 내일·사흘 안에)') +
                field('dueDay', nowLabel ? `기한 직접 지정 (지금: ${nowLabel} · 실제 날짜면 YYYY-MM-DD, 아니면 같은 기준의 N일째 · 비우면 원문으로 계산)` : '기한 직접 지정 (지금 이야기 시간이 확인되지 않아 지정할 수 없어요)');
        }
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
            : `<li class="sp-pt sp-${p.kind} ${pointInjected(p) ? 'sp-inj' : 'sp-stored'} ${p.pin ? 'sp-point-pinned' : ''}">${btn('key-toggle', `${s.id}|${g.id}|${j}`, pointSymbol(p),
                p.pin ? '우선 주입 고정 · 누르면 고정 전 선택으로 돌아가요' : (pointInjected(p) ? '선택됨 · 누르면 선택 해제' : '선택 안 함 · 누르면 선택'), 'sp-key')}<span class="sp-pk" title="${p.kind === 'change' ? '상태 변화' : '기억할 순간'}">${p.kind === 'change' ? '◆' : '◇'}</span>
                <div class="sp-pt-t">${p.loot?.length ? `<details class="sp-point-detail" data-group="point:${g.id}:${j}" ${ui.savesOpen.get('point:' + g.id + ':' + j) ? 'open' : ''}><summary>${esc(T(p.text, p.ko))}</summary><div class="sp-dim">출처: 루팅</div></details>` : esc(T(p.text, p.ko))}${(() => { const d = pointInjected(p) && !p.pin ? dupState(s, p) : null; return d === 'exact' && p.keyUser !== true ? '<span class="sp-dup" title="개요에 같은 문장이 있어서 이번 주입에서는 빼요 (직접 선택하면 넣어요)">개요와 같음 · 주입 생략</span>' : d === 'near' ? '<span class="sp-dup" title="개요와 많이 겹쳐요. 필요 없으면 ○로 바꿔 주세요">중복 후보</span>' : ''; })()}${evidenceChips(p.msgs, p.oldEvidence)}</div>
                ${tools([...(p.pin ? [] : [btn('pin-point', `${s.id}|${g.id}|${j}`, '📌', '이 포인트를 고정 주입 (전체 토큰 상한 내에서 우선 유지)')]), btn('edit-point', `${s.id}|${g.id}|${j}`, '✎'), btn('del-point', `${s.id}|${g.id}|${j}`, '🗑')])}</li>`;
        // One block per part: its own outline (never rewritten later), its points, its notes.
        const segHtml = s.segs.map(g => {
            const list = g.points.map((p, j) => pointHtml({ g, p, j })).join('');
            const outline = isEditing('segoutline', `${s.id}|${g.id}`) ? editForm()
                : g.outline ? `<div class="sp-seg-outline">${esc(T(g.outline, g.koOutline))}${g.outlinePending ? ' <small class="sp-dim">임시 개요</small>' : ''} ${tools([btn('edit-segoutline', `${s.id}|${g.id}`, '✎', '이 구간 개요 편집')])}</div>` : '';
            const notes = !g.notes ? '' : isEditing('notes', `${s.id}|${g.id}`) ? editForm()
                : `<details class="sp-notes" data-group="notes:${esc(g.id)}" ${ui.savesOpen.get('notes:' + g.id) ? 'open' : ''}><summary>상세 노트 ${tools([btn('edit-notes', `${s.id}|${g.id}`, '✎')])}</summary><p>${esc(T(g.notes, g.koNotes))}</p></details>`;
            const time = g.time ? formatSegmentTime(g.time, mem.timeAnchors, 'ko') : '시간 미상';
            const levels = { explicit: '원문에 명시됨', linked: '기준에서 연결됨', manual: '직접 지정', unconfirmed: '미확인' };
            const proof = g.time?.end?.evidence;
            const startProof = g.time?.start?.evidence;
            const timeHtml = (ui.edit?.kind === 'segtime' && ui.edit.id.split('|')[0] === s.id && ui.edit.id.split('|')[1] === g.id) ? editForm() : `<div class="sp-seg-time"><span>📅 ${esc(time)}</span> ${tools([btn('edit-segtime-start', `${s.id}|${g.id}`, '시작 ✎', '구간 시작 날짜·시간 편집', ui.run ? 'sp-disabled' : ''), btn('edit-segtime', `${s.id}|${g.id}`, '끝 ✎', '구간 끝 날짜·시간 편집', ui.run ? 'sp-disabled' : '')])}<details><summary>시작: ${levels[g.time?.start?.certainty] || '시간 미상'} · 끝: ${levels[g.time?.end?.certainty] || '시간 미상'}</summary>${startProof ? `<div class="sp-dim">시작 근거 · ${startProof.room === roomKey() ? '현재 방' : '이전 방'} #${startProof.msg} · ${esc(startProof.quote)}</div>` : ''}${proof ? `<div class="sp-dim">${proof.room === roomKey() ? '현재 방' : '이전 방'} #${proof.msg} · ${esc(proof.quote)}</div>` : '<div class="sp-dim">시간 근거 인용 없음</div>'}</details></div>`;
            return `<div class="sp-seg"><div class="sp-seg-h">${esc(g.id)} ${g.source ? esc(priorRoomLabel(g.source.room)) + (Number.isInteger(g.source.from) ? ` #${g.source.from}–#${g.source.to}` : '') : Number.isInteger(g.from) ? `#${g.from}–#${g.to}` : ''}</div>${timeHtml}${outline}<ul class="sp-pts">${list}</ul>${notes}</div>`;
        }).join('');
        const outlineText = sceneOutlineParts(s).length ? '' : '<p class="sp-dim">개요 없음</p>';
        return `<div class="sp-card sp-scene ${s.status === 'open' ? 'sp-open' : ''} ${s.star ? 'sp-star' : ''}">${head}
            <div class="sp-title">${esc(T(s.title, s.koTitle))}${s.titlePending ? ' <small class="sp-dim">임시 제목</small>' : ''}${s.where ? ` <small>@ ${esc(s.where)}</small>` : ''}</div>
            ${sceneTimeRange(s, mem.timeAnchors, 'ko') ? `<div class="sp-scene-time">📅 ${esc(sceneTimeRange(s, mem.timeAnchors, 'ko'))}</div>` : ''}
            ${s.who.length ? `<div class="sp-who">${whoChips(mem, s.who)}</div>` : ''}
            <div class="sp-outline">${s.segs.filter(g => g.outline).map(g => `<p>${esc(T(g.outline, g.koOutline))}</p>`).join('')}</div>${outlineText}
            <details class="sp-more" data-group="scene:${esc(s.id)}" ${(ui.edit && String(ui.edit.id).startsWith(s.id + '|')) || ui.savesOpen.get('scene:' + s.id) ? 'open' : ''}><summary>구간 ${s.segs.length} · 포인트 ${pts.length} (주입 ${pts.filter(x => pointInjected(x.p)).length})</summary>
                <div class="sp-dim sp-keyhelp">● 선택됨 / ○ 선택 안 함 / 📌 우선 주입 고정. 선택한 내용은 기억 주입에 우선 반영해요. ${btn('rekey-scene', s.id, '⟳ 주입 고르기', '개요와 상태 목록에 없는 중요한 포인트만 AI가 다시 골라요 (직접 지정·고정은 유지)')}</div>
                ${segHtml}</details></div>`;
    }).join('');
}
function recordRow(st, r, extraTools = []) {
    if (isEditing('record', r.id)) return `<div class="sp-rec">${editForm()}</div>`;
    return `<div class="sp-rec ${r.pin ? 'sp-pinned' : ''}"><span class="sp-rec-t">${esc(T(r.text, r.ko))}</span>${evidenceChips(r.msgs, r.oldEvidence)}
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
                <div class="sp-sub">${whoChips(st.mem, q.who)}${evidenceChips(q.msgs, q.oldEvidence)}</div>${(() => { if (!q.due) return ''; const d = dueStatus(st.mem, q); return `<div class="sp-due sp-due-${d?.kind || 'closed'}">⏰ ${esc(formatDue(st.mem, q, 'ko'))}${q.due.manual ? ' <small class="sp-dim">직접 지정</small>' : ''}</div>`; })()}${q.terms ? `<details class="sp-terms" data-group="terms:${esc(q.id)}" ${ui.savesOpen.get('terms:' + q.id) ? 'open' : ''}><summary>근거 원문 ${esc(priorTermsLabel(q.terms))}</summary><div class="sp-terms-q">“${esc(q.terms.quote)}”</div><div class="sp-excerpt">${esc(q.terms.context)}</div></details>` : ''}</div>${tools([...flow, btn('pin-rec', q.id, '📌', '항상 주입', q.pin ? 'sp-on' : ''), btn('edit-rec', q.id, '✎'), btn('del-rec', q.id, '🗑')])}</div>`;
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
    const names = itemEnts.length ? `<details class="sp-more" data-group="itemnames" ${ui.savesOpen.get('itemnames') ? 'open' : ''}><summary>물건·장소 이름 ${itemEnts.length}개 (별칭 편집)</summary>${itemEnts.map(e => `<div class="sp-card">${entityHead(st, e)}</div>`).join('')}</details>` : '';
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
        <div class="sp-save-h"><span class="sp-slot">${sv.auto ? 'AUTO' : 'FILE'}</span><span class="sp-save-n">${esc(sv.name)}</span>${genLabel ? `<span class="sp-badge">${genLabel}</span>` : ''}${linked ? '<span class="sp-badge sp-badge-on" title="이 방에서 마지막으로 저장하거나 불러온 슬롯이에요">▶ 플레이 중</span>' : ''}${sv.local ? '<span class="sp-badge sp-badge-warn">설정에만 있음</span>' : ''}</div>
        <div class="sp-save-meta">${showRoom ? `📁 ${esc(roomLabel(sv.room))} · ` : ''}${esc(sv.char || '')} · ${fmtDate(sv.updated)}</div>
        <div class="sp-save-stats"><span>장면 ${s.scenes ?? 0}</span><span>메시지 ${sv.msgCount ?? 0}</span><span>❗ ${s.openQuests ?? 0}</span>${s.place ? `<span>📍 ${esc(s.place)}</span>` : ''}</div>
        <div class="sp-row">${btn('load', sv.id, '불러오기', '이 방의 기억을 이 슬롯으로 바꿔요. 슬롯은 저장을 누를 때만 덮어써요', 'sp-primary')}
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
        </div>
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
        : `<span>다음 체크포인트까지 <b>${Math.max(0, every - autoCount(st))}</b>개</span>`;
    const attemptAt = st?.autoAttemptAt || st?.autoLast?.at;
    const autoLast = attemptAt ? `<span class="${st.autoFail ? 'sp-warn' : 'sp-dim'}">마지막 자동 저장 시도 ${new Date(attemptAt).toLocaleTimeString()} · ${esc(ui.run?.auto ? '체크포인트 저장 중…' : st.autoAttemptAt && (!st.autoLast || st.autoLast.at < st.autoAttemptAt) ? '이번 시도 결과 없음 또는 중단됨 · 다음 간격에 다시' : st.autoLast?.result || '결과 대기')}</span>` : '';
    const lastRecord = st?.lastRecord ? `<span class="sp-dim">마지막 실제 기록 ${new Date(st.lastRecord.at).toLocaleTimeString()} · #${st.lastRecord.from}–#${st.lastRecord.to}</span>` : st?.lastIndex >= 0 ? `<span class="sp-dim">마지막 실제 기록 · 시각 정보 없음 · #0–#${st.lastIndex}</span>` : '<span class="sp-dim">마지막 실제 기록 없음</span>';
    const err = ui.lastError ? `<details class="sp-err" data-group="hud-err" ${ui.savesOpen.get('hud-err') ? 'open' : ''}><summary>마지막 실패 ${esc(ui.lastError.range)} — 자세히</summary><ul class="sp-scroll">${groupErrors(ui.lastError.detail).map(d => `<li>${esc(d)}</li>`).join('')}</ul></details>` : '';
    return `<div class="sp-hud">
        <div class="sp-scene-now">${open ? `<span class="sp-cursor">▶</span> <b>${esc(T(open.title, open.koTitle))}</b>${open.where ? ` <span class="sp-dim">@ ${esc(open.where)}</span>` : ''}` : '<span class="sp-dim">▷ 진행 중인 장면 없음</span>'}</div>
        ${storyTimeContext(st?.mem || {}, 'ko') ? `<div class="sp-hud-time">마지막 기록 기준 · ${esc(storyTimeContext(st.mem, 'ko'))}</div>` : ''}
        <div class="sp-bar" title="기록된 메시지 비율"><div class="sp-bar-fill" style="width:${pct}%"></div><span>기록 ${covered} / ${total}</span></div>
        <div class="sp-hud-meta"><span>미기록 <b>${pending}</b></span>${btn('tab', 'queue', `⏳ 대기열 ${st?.lootQueue?.length || 0}개`)}<span>주입 ${ui.inj ? ui.inj.tokens.toLocaleString() : 0} / ${num('budget', 300, 100000).toLocaleString()} 토큰</span><span>요약 AI: ${esc(profileLabel())}</span>${ui.inj?.pinOverflow ? `<span class="sp-warn">📌 ${ui.inj.pinMissing}개 주입 못 함</span>` : ''}</div>
        <div class="sp-hud-meta sp-auto-line">${autoLine}${autoLast}${lastRecord}</div>
        ${(() => { const it = interruptedNote(st); return it && !busy ? `<div class="sp-hud-meta"><span class="sp-warn">⚠ 지난 저장이 방을 옮기면서 중간에 멈췄어요 (#${it.from}부터 미기록)</span>${btn('run', '', '퀵세이브로 이어서')}</div>` : ''; })()}
        ${autoFailHtml(st)}
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
        ${(ui.lastError || st?.autoFail || (st?.check && st.check.status !== 'running')) && !busy ? `<div class="sp-row sp-copyrow">${btn('copy-report', '', '📋 결과 복사', '마지막 실패와 기록 확인 결과를 글로 복사해요 (캡처 대신)')}</div>` : ''}
        ${ui.copyText ? `<div class="sp-copybox"><textarea readonly rows="8">${esc(ui.copyText)}</textarea>${btn('copy-close', '', '닫기')}</div>` : ''}
        ${busy ? `<div class="sp-progress"><span class="sp-spin">◐</span> ${esc(ui.progress)}${ui.req ? ` · <span class="sp-req">${esc(reqText())}</span>` : ''}</div>` : ''}${err}
    </div>`;
}
let tabResizeObserver = null;
function installTabNavigation(strip, previousScroll) {
    tabResizeObserver?.disconnect();
    if (!strip) return;
    const nav = strip.parentElement;
    const prev = nav.querySelector('[data-tab-scroll=prev]'), next = nav.querySelector('[data-tab-scroll=next]');
    const update = () => {
        nav.classList.toggle('sp-overflow', strip.scrollWidth > nav.clientWidth + 1);
        const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
        const left = strip.scrollLeft > 1, right = strip.scrollLeft < max - 1;
        nav.classList.toggle('sp-more-left', left); nav.classList.toggle('sp-more-right', right);
        prev.disabled = !left; next.disabled = !right;
    };
    strip.scrollLeft = previousScroll;
    const active = strip.querySelector('.sp-active');
    const reveal = () => {
        if (active) {
            const a = active.getBoundingClientRect(), b = strip.getBoundingClientRect();
            if (a.left < b.left) strip.scrollLeft -= b.left - a.left + 8;
            else if (a.right > b.right) strip.scrollLeft += a.right - b.right + 8;
        }
        update();
    };
    update(); reveal();
    prev.onclick = () => strip.scrollBy({ left: -Math.max(120, strip.clientWidth * .7), behavior: 'smooth' });
    next.onclick = () => strip.scrollBy({ left: Math.max(120, strip.clientWidth * .7), behavior: 'smooth' });
    strip.addEventListener('scroll', update, { passive: true });
    strip.addEventListener('wheel', e => {
        if (e.ctrlKey) return;
        const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const delta = raw * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? strip.clientWidth : 1);
        const before = strip.scrollLeft;
        strip.scrollLeft += delta;
        if (strip.scrollLeft !== before) e.preventDefault();
    }, { passive: false });
    if (typeof ResizeObserver === 'function') {
        tabResizeObserver = new ResizeObserver(reveal);
        tabResizeObserver.observe(strip);
    }
}
function render(force = false) {
    updateSaveBanner();
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
        queue: st.lootQueue?.length || 0, journal: st.mem.scenes.length, quests: st.mem.records.filter(r => r.type === 'quest' && r.status === 'open').length,
        party: st.mem.entities.filter(e => e.type === 'person').length, items: st.mem.records.filter(r => r.type === 'item').length,
        world: st.mem.records.filter(r => r.type === 'world').length, saves: listSaves().length,
    } : {};
    const tabs = TABS.map(([k, icon, label]) => `<button class="sp-tab ${ui.tab === k ? 'sp-active' : ''}" data-act="tab" data-id="${k}"><span class="sp-ti">${icon}</span><span>${label}</span>${counts[k] ? `<em>${counts[k]}</em>` : ''}</button>`).join('');
    let body;
    if (!hasChat()) body = '<div class="sp-empty">채팅방을 열면 그 방의 기억이 여기에 보여요.</div>';
    else {
        const view = st || { mem: emptyMem() };
        body = { queue: queueHtml, journal: journalHtml, quests: questsHtml, party: partyHtml, items: itemsHtml, world: worldHtml, saves: savesHtml, inject: injectHtml }[ui.tab](view);
    }
    win.html(`<div class="sp-top">
            <div class="sp-logo"><span class="sp-logo-icon">◆</span> SAVE POINT <span class="sp-ver">v${VERSION}</span></div>
            <div class="sp-top-r"><span class="sp-room">${esc(charInfo()?.name || '')}</span>
                <button class="sp-btn sp-mini ${showKo() ? 'sp-on' : ''}" data-act="ko" title="한국어 보기">${showKo() ? '한' : 'EN'}</button>
                <button class="sp-btn sp-mini" data-act="close" title="닫기">✕</button></div></div>
        ${hasChat() ? hudHtml(st) : ''}
        <div class="sp-tab-nav"><button type="button" class="sp-tab-arrow" data-tab-scroll="prev" aria-label="이전 탭 보기" title="이전 탭 보기">‹</button><div class="sp-tabs">${tabs}</div><button type="button" class="sp-tab-arrow" data-tab-scroll="next" aria-label="다음 탭 보기" title="다음 탭 보기">›</button></div>
        <div class="sp-body">${body}</div>`);
    win.find('.sp-body').scrollTop(scroll);
    installTabNavigation(win.find('.sp-tab-nav .sp-tabs')[0], tabScroll);
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
    if (kind === 'segtime') {
        const [sid, gid, requested] = id.split('|'), edge = requested === 'start' ? 'start' : 'end', g = mem.scenes.find(x => x.id === sid)?.segs.find(g => g.id === gid), t = g?.time?.[edge];
        values = { edge, date: dateAt(t, mem.timeAnchors), day: t?.day === null || t?.day === undefined ? '' : String(t.day + 1), period: t?.period || '', clock: t?.clock || '', mode: g?.time?.mode || 'present' };
    }
    if (kind === 'segoutline') { const [sid, gid] = id.split('|'); values = { outline: mem.scenes.find(x => x.id === sid).segs.find(g => g.id === gid).outline || '' }; }
    if (kind === 'point') values = { text: findPoint(mem, id).p.text };
    if (kind === 'notes') { const [sid, gid] = id.split('|'); values = { notes: mem.scenes.find(x => x.id === sid).segs.find(g => g.id === gid).notes }; }
    if (kind === 'entity') { const e = mem.entities.find(x => x.id === id); values = { name: e.name, aliases: (e.aliases || []).join(', '), type: e.type }; }
    if (kind === 'record') {
        const r = mem.records.find(x => x.id === id);
        values = { type: r.type, text: r.text, entity: r.entity || '', holder: r.holder || '', aspect: r.aspect || 'relation', kind: r.kind || '', status: r.status || 'open',
            dueExpr: r.due?.expr || '', dueDay: r.due?.manual ? (dateAt({ anchor: r.due.manual.anchor, day: r.due.manual.day, certainty: 'manual' }, mem.timeAnchors) || String(r.due.manual.day + 1)) : '' };
    }
    ui.edit = { kind, id, values, orig: { ...values } };
    render(true);
}
async function saveEdit() {
    const e = ui.edit;
    if (!e) return;
    const v = e.values;
    if (e.kind === 'segtime') {
        if (ui.run) { toastr.info('저장 작업이 끝난 뒤 시간을 수정해 주세요.'); return; }
        // Validate on a copy so a bad field keeps the edit form and never touches the live memory.
        editStoryTime(clone(state().mem), e.id.split('|')[1], v, roomKey());
    }
    const trim = x => String(x ?? '').trim();
    // A new record starts from empty deadline fields, so anything typed there is a change too.
    const orig = e.orig || { dueExpr: '', dueDay: '' };
    const dueChanged = e.kind === 'record' && v.type === 'quest' && ['promise', 'debt'].includes(v.kind)
        && (trim(v.dueExpr) !== trim(orig.dueExpr) || trim(v.dueDay) !== trim(orig.dueDay));
    if (dueChanged) {
        // Same check on a copy first: a bad deadline keeps the form open and changes nothing.
        // A new record is checked on a blank stand-in, since it does not exist yet.
        const copy = clone(state().mem), r = copy.records.find(x => x.id === e.id) || { type: 'quest' };
        setManualDue(copy, r, { day: trim(v.dueDay), expr: trim(v.dueExpr) });
    }
    ui.edit = null;
    await commitEdit(mem => {
        if (e.kind === 'scene') {
            const s = mem.scenes.find(x => x.id === e.id);
            if (!s || !trim(v.title)) return false;
            if (s.title !== trim(v.title)) { s.title = trim(v.title); delete s.koTitle; s.titleUser = true; delete s.titlePending; }
            s.where = trim(v.where);
        } else if (e.kind === 'segtime') {
            const [, gid] = e.id.split('|');
            return editStoryTime(mem, gid, v, roomKey());
        } else if (e.kind === 'segoutline') {
            const [sid, gid] = e.id.split('|');
            const g = mem.scenes.find(x => x.id === sid)?.segs.find(x => x.id === gid);
            if (!g) return false;
            delete g.outlinePending;
            if ((g.outline || '') !== trim(v.outline)) { g.outline = trim(v.outline); delete g.koOutline; if (!g.outline) delete g.outline; }
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
            if (r.type === 'quest' && dueChanged) setManualDue(mem, r, { day: trim(v.dueDay), expr: trim(v.dueExpr) });
            if (r.type === 'world') { r.kind = WORLD_KINDS.includes(v.kind) ? v.kind : 'rule'; r.knownBy ||= []; }
        }
    });
}
async function handle(act, id) {
    const st = state();
    switch (act) {
        case 'close': return closeWindow();
        case 'tab': ui.tab = id; ui.edit = null; if (id === 'inject') refreshInjection(); return render(true);
        case 'loot-delete':
            if (ui.run) return;
            return transact(() => { const st = state(); if (st) st.lootQueue = (st.lootQueue || []).filter(x => x.id !== id); }, { undoable: false, autosave: false });
        case 'ko': settings().showKo = !showKo(); saveSettings(); fillSettings(); return render(true);
        case 'run': return summarize();
        case 'run-close': return summarize({ close: true });
        case 'stop': cancelRun(); return;
        case 'undo': return undo();
        case 'translate': return translate();
        case 'test-connection': return testConnection();
        case 'review-accept': return acceptCurrentSource();
        case 'edit-cancel': ui.edit = null; return render(true);
        case 'edit-save': return saveEdit();
        case 'edit-scene': return startEdit('scene', id);
        case 'edit-point': return startEdit('point', id);
        case 'edit-notes': return startEdit('notes', id);
        case 'edit-segtime-start': if (ui.run) return; return startEdit('segtime', id + '|start');
        case 'edit-segtime': if (ui.run) return; return startEdit('segtime', id);
        case 'edit-segoutline': return startEdit('segoutline', id);
        case 'edit-ent': return startEdit('entity', id);
        case 'edit-rec': return startEdit('record', id);
        case 'add-rec':
            ui.edit = { kind: 'record', id: 'new', values: { type: id, text: '', entity: '', holder: '', aspect: 'relation', kind: id === 'quest' ? 'promise' : id === 'world' ? 'rule' : '', status: 'open', dueExpr: '', dueDay: '' } };
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
            if (p.pin) p.pin = false;
            else p.keyUser = !pointInjected(p);
        }, { undoable: false });
        case 'pin-point': return commitEdit(m => {
            const { p } = findPoint(m, id);
            if (!p) return false;
            p.pin = !p.pin;
        }, { undoable: false });
        case 'rekey-scene': return rekeyScenes([id]);
        case 'del-point': return commitEdit(m => { const { g, j } = findPoint(m, id); if (!g) return false; g.points.splice(j, 1); });
        case 'del-rec': return commitEdit(m => { m.records = m.records.filter(x => x.id !== id); });
        case 'save-new': return saveNew();
        case 'save-over': return overwriteSave(id);
        // 'load-continue' and 'load-copy' were two names for the same load; kept for old callers.
        case 'load': case 'load-continue': case 'load-copy': return loadSave(id);
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

function settingSection(key, content) {
    const group = SETTING_GROUPS[key], saved = settings().settingsOpen[key];
    const open = typeof saved === 'boolean' ? saved : key === 'connection';
    return `<details class="sp-setting-group" data-settings-group="${key}" ${open ? 'open' : ''}>
        <summary><b>${group.title}</b><span class="sp-changed" data-changed-group="${key}"></span><span class="sp-setting-summary" data-settings-summary="${key}"></span></summary>
        <div class="sp-setting-fields">${content}<div class="sp-set-row sp-group-reset"><button type="button" class="menu_button" data-reset-group="${key}">↺ 이 묶음 되돌리기</button></div></div>
    </details>`;
}
function settingsHtml() {
    return `<div id="sp_settings" class="sp-settings"><div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>◆ SavePoint</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <div class="sp-set-row"><button class="menu_button" id="sp_open">SavePoint 열기</button></div>
            <label class="checkbox_label"><input type="checkbox" data-set="enabled"> 사용 (기억 주입·하이드)</label>
            ${settingSection('connection', `
                <label>요약 AI <select data-set="profileId" id="sp_profiles"></select></label>
                <label class="checkbox_label"><input type="checkbox" data-set="requestStream"> 연결 프로필 응답을 실시간으로 받기</label>
                <label>추론 강도 (채팅 완성 연결 프로필) <select data-set="reasoningEffort"><option value="">프로필 설정 따르기</option><option value="low">낮음 (low)</option><option value="high">높음 (high)</option><option value="max">최대 (max)</option></select></label>
                <div class="sp-set-note">실시간 수신은 사고·본문의 수신량만 표시해요. 기억은 응답과 검사가 끝난 뒤 저장해요. 추론 강도는 API가 지원할 때 적용되며, 메인 API 설정은 바꾸지 않아요.</div>
                <div class="sp-set-row"><button class="menu_button" id="sp_test_connection">짧은 연결 시험</button></div><div class="sp-set-note" id="sp_probe_result">대화 원문을 보내거나 기억을 바꾸지 않고 짧은 요청으로 연결을 시험해요 (API 호출 1회, 최대 60초).</div>
                <label>응답 최대 토큰 <input type="number" data-set="responseLength" min="500" max="64000"></label>
                <label>한 번에 보낼 입력 한도 (글자) <input type="number" data-set="inputChars" min="5000" max="1000000"></label>
                <label title="이 시간 안에 응답이 오지 않으면 그 요청을 취소해요. 그 구간은 저장하지 않고 원문을 그대로 둬요. 늦게 도착한 응답은 버려요.">요청 제한 시간 (초) <input type="number" data-set="timeoutSec" min="5" max="3600"></label>
            `)}
            ${settingSection('recording', `
                <label class="checkbox_label"><input type="checkbox" data-set="check"> 기록 후 확인 (모순·원문과 다른 해석을 찾아 경고 · 분량에 따라 추가 요청)</label>
                <label class="checkbox_label"><input type="checkbox" data-set="auto"> 체크포인트 (새 메시지 N개마다 자동 퀵세이브)</label>
                <label>체크포인트 간격 (새 메시지 수, 유저+캐릭터) <input type="number" data-set="autoEvery" min="5" max="500"></label>
                <div class="sp-set-note">마지막 시도 뒤 새 메시지가 간격만큼 쌓이면 실행해요. 일부 실패도 다음 간격에 이어서 처리하며, 퀵세이브로 바로 저장할 수 있어요.</div>
                <label>체크포인트 여유분 <input type="number" data-set="autoReserve" min="0" max="20"></label>
                <div class="sp-set-note">체크포인트가 기록하지 않고 남겨 둘 최근 메시지 수예요. 스와이프·수정에 대비해요. 퀵세이브는 마지막 메시지까지 기록해요.</div>
                <label data-reset-host="guide">기록 지침 (영어 권장, {{char}} {{user}} 사용 가능)</label>
                <textarea data-set="guide" rows="10" class="text_pole"></textarea>
                <div class="sp-set-note">데이터 목록과 응답 형식은 지침 뒤에 자동으로 붙어요.</div>
            `)}
            ${settingSection('injection', `
                <label>주입 상한 (토큰) <input type="number" data-set="budget" min="300" max="100000"></label>
                <label>오래된 장면 제목 목록 상한 (토큰) <input type="number" data-set="titleCap" min="0" max="20000"></label>
                <label>자세히 넣을 최근 장면 수 <input type="number" data-set="recentScenes" min="0" max="20"></label>
                <label class="checkbox_label"><input type="checkbox" data-set="recall"> 상세 기억 회상 (관련된 예전 장면의 영어 노트)</label>
                <label class="checkbox_label"><input type="checkbox" data-set="rawRecall"> 원문 회상 (예전 원문 일부를 그대로, 한국어 섞일 수 있음)</label>
                <label>주입 위치 <select data-set="position"><option value="2">메인 프롬프트 앞</option><option value="0">메인 프롬프트 뒤</option><option value="1">채팅 안 (깊이)</option></select></label>
                <label>깊이 <input type="number" data-set="depth" min="0" max="999"></label>
                <label>역할 <select data-set="role"><option value="0">시스템</option><option value="1">사용자</option><option value="2">어시스턴트</option></select></label>
            `)}
            ${settingSection('storage', `
                <label class="checkbox_label"><input type="checkbox" data-set="hide"> 세이브한 메시지 하이드</label>
                <label>하이드하지 않을 최근 메시지 <input type="number" data-set="keepRecent" min="0" max="200"></label>
                <div class="sp-set-note">전체 대화에서 숨기지 않을 최근 메시지 수예요. 미기록 메시지는 이 설정과 관계없이 숨기지 않아요.</div>
                <label>오토세이브를 보관할 방 수 (방마다 최근 3개) <input type="number" data-set="autoKeep" min="1" max="500"></label>
            `)}
            ${settingSection('appearance', `
                <label>테마 <select data-set="theme">${Object.entries(THEMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
                <label class="checkbox_label"><input type="checkbox" data-set="showKo"> 한국어 보기</label>
            `)}
        </div></div></div>`;
}
function updateSettingsSummaries() {
    const s = settings();
    const summaries = {
        connection: `${profileLabel()} · 제한 ${s.timeoutSec}초`,
        recording: `${s.auto ? s.autoEvery + '개마다 · 여유분 ' + s.autoReserve + '개' : '체크포인트 꺼짐'} · 확인 ${s.check ? '켜짐' : '꺼짐'}`,
        injection: `${Number(s.budget).toLocaleString()}토큰 · 최근 ${s.recentScenes}장면`,
        storage: `${s.hide ? '최근 ' + s.keepRecent + '개 남김' : '하이드 꺼짐'} · 보관 ${s.autoKeep}개 방`,
        appearance: `${THEMES[s.theme] || THEMES.jrpg} · ${s.showKo ? '한국어' : 'EN'}`,
    };
    $('#sp_settings [data-settings-summary]').each(function () { this.textContent = summaries[this.dataset.settingsSummary]; });
    updateChangeMarks();
}
// Defaults stay out of sight: a field shows ↺ only after it was changed (the default is in its
// tooltip), and a group shows how many of its settings differ, with one button to undo them.
const isChanged = k => JSON.stringify(settings()[k]) !== JSON.stringify(DEFAULTS[k]);
function defaultLabel(k) {
    const v = DEFAULTS[k], field = document.querySelector(`#sp_settings [data-set="${k}"]`);
    if (typeof v === 'boolean') return v ? '켜짐' : '꺼짐';
    if (k === 'guide') return '기본 지침';
    if (field?.tagName === 'SELECT') return field.querySelector(`option[value="${CSS.escape(String(v))}"]`)?.textContent || String(v);
    return typeof v === 'number' ? v.toLocaleString() : String(v);
}
function updateChangeMarks() {
    $('#sp_settings [data-reset-key]').each(function () {
        const k = this.dataset.resetKey;
        this.hidden = !isChanged(k);
        this.title = `기본값(${defaultLabel(k)})으로 되돌리기`;
    });
    for (const [key, group] of Object.entries(SETTING_GROUPS)) {
        const n = group.keys.filter(isChanged).length;
        $(`#sp_settings [data-changed-group="${key}"]`).text(n ? `변경 ${n}` : '').toggle(!!n);
        $(`#sp_settings [data-settings-group="${key}"] .sp-group-reset`).toggle(!!n);
    }
}
function settingsChanged(keys) {
    saveSettings();
    if (keys.some(k => ['hide', 'keepRecent', 'enabled'].includes(k))) syncHide();
    if (keys.some(k => ['auto', 'autoEvery', 'autoReserve', 'enabled'].includes(k))) scheduleAuto();
    if (keys.includes('enabled')) installLootBar();
    updateSettingsSummaries(); refreshInjection(); render(true);
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
    updateSettingsSummaries();
}
function addSettingsUI() {
    if ($('#sp_settings').length) return;
    $('#extensions_settings2').append(settingsHtml());
    $('#sp_settings [data-set]').each(function () {
        const k = this.dataset.set;
        if (k === 'enabled' || !(k in DEFAULTS)) return;
        const host = k === 'guide' ? $('#sp_settings [data-reset-host="guide"]') : $(this).closest('label');
        host.addClass('sp-has-reset').append($('<button type="button" class="sp-field-reset" hidden>↺</button>').attr('data-reset-key', k).attr('aria-label', '기본값으로 되돌리기'));
    });
    fillSettings();
    document.getElementById('sp_settings').addEventListener('toggle', e => {
        const d = e.target;
        if (!d.matches?.('details[data-settings-group]')) return;
        const key = d.dataset.settingsGroup;
        if (settings().settingsOpen[key] === d.open) return;
        settings().settingsOpen[key] = d.open; saveSettings();
    }, true);
    $('#sp_settings').on('click', '[data-reset-group]', function () {
        const group = SETTING_GROUPS[this.dataset.resetGroup];
        if (!group) return;
        const s = settings();
        for (const key of group.keys) s[key] = clone(DEFAULTS[key]);
        fillSettings(); settingsChanged(group.keys);
        toastr.info(group.title + ' 설정을 기본값으로 되돌렸어요.');
    });
    $('#sp_settings').on('click', '[data-reset-key]', function (e) {
        e.preventDefault(); e.stopPropagation();
        const k = this.dataset.resetKey;
        settings()[k] = clone(DEFAULTS[k]);
        fillSettings(); settingsChanged([k]);
    });
    $('#sp_settings').on('input change', '[data-set]', function () {
        const k = this.dataset.set, s = settings();
        s[k] = this.type === 'checkbox' ? this.checked : this.type === 'number' || ['position', 'role'].includes(k) ? Number(this.value) : this.value;
        settingsChanged([k]);
    });
    $('#sp_open').on('click', openWindow);
    $('#sp_test_connection').on('click', () => testConnection().catch(reportError));
}

// ───────── saving banner (game-style "저장 중입니다…") ─────────
// Shown above the chat while a save or another AI task runs, so leaving the room (which cancels it)
// is a choice the reader can see. It wears the status window's theme, never blocks the chat, opens
// SavePoint when pressed, and is hidden while the SavePoint window itself is open.
const BANNER = {
    save: ['저장 중입니다…', '다른 채팅방으로 이동하면 저장이 취소돼요'],
    auto: ['체크포인트 저장 중…', '다른 채팅방으로 이동하면 저장이 취소돼요'],
    check: ['기록 확인 중입니다…', '다른 채팅방으로 이동하면 확인이 취소돼요 (기억은 이미 저장됐어요)'],
    other: ['기억 정리 중입니다…', '다른 채팅방으로 이동하면 이 작업이 취소돼요'],
};
let bannerTimer = null;
function saveBanner() {
    if (typeof document === 'undefined' || !document.body) return null;
    let el = document.getElementById('sp_save_banner');
    if (!el) {
        el = document.createElement('div');
        el.id = 'sp_save_banner'; el.className = 'sp-window sp-save-banner'; el.hidden = true;
        el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
        el.innerHTML = '<span class="sp-sb-icon"></span><div class="sp-sb-text"><div class="sp-sb-title"></div><div class="sp-sb-sub"></div></div>';
        el.onclick = () => openWindow();
        document.body.append(el);
    }
    el.setAttribute('data-theme', settings().theme in THEMES ? settings().theme : 'jrpg');
    return el;
}
function setBanner(el, { icon, title, count = '', sub }) {
    el.querySelector('.sp-sb-icon').className = `sp-sb-icon ${icon}`;
    el.querySelector('.sp-sb-title').innerHTML = `${esc(title)}${count ? ` <b>${esc(count)}</b>` : ''}`;
    el.querySelector('.sp-sb-sub').textContent = sub;
    el.hidden = false;
}
function updateSaveBanner() {
    const el = saveBanner();
    if (!el) return;
    if (el.dataset.flash) {
        // A finished-notice gives way at once to a new task or to another room.
        if ((ui.run && BANNER[ui.run.kind]) || el.dataset.flashRoom !== String(roomKey())) { clearTimeout(bannerTimer); delete el.dataset.flash; delete el.dataset.flashRoom; }
        else return;
    }
    const run = ui.run, text = run && BANNER[run.kind];
    if (!text || ui.open || !settings().enabled || run.key !== roomKey()) { el.hidden = true; return; }
    const m = String(ui.progress || '').match(/(\d+)\/(\d+)메시지/);
    el.dataset.tone = 'running';
    setBanner(el, { icon: 'sp-sb-spin', title: text[0], count: m && Number(m[1]) > 0 ? `${m[1]}/${m[2]}` : '', sub: text[1] });
}
function flashSaveBanner(text, { tone = 'success' } = {}) {
    const el = saveBanner();
    if (!el) return;
    clearTimeout(bannerTimer);
    if (ui.open || !settings().enabled) { delete el.dataset.flash; el.hidden = true; return; }
    const [title, ...rest] = text.split(' · ');
    el.dataset.flash = '1'; el.dataset.flashRoom = String(roomKey());
    el.dataset.tone = tone;
    setBanner(el, { icon: tone === 'warning' ? 'sp-sb-warn' : tone === 'info' ? 'sp-sb-info' : 'sp-sb-done', title, sub: rest.join(' · ') });
    bannerTimer = setTimeout(() => { delete el.dataset.flash; delete el.dataset.flashRoom; updateSaveBanner(); }, tone === 'warning' ? 8000 : 3500);
}
// A save cut off by leaving the room is remembered per room until that room saves again.
function clearInterrupted(room) {
    const map = settings().interrupted;
    if (map && room && map[room]) { delete map[room]; saveSettings(); }
}
function noteLeftDuringRun(run) {
    if (!run || !BANNER[run.kind] || run.key === roomKey()) return;
    const name = `‘${run.roomName}’ 방을 나가서`;
    if (run.kind === 'save') {
        const saved = run.st.lastIndex >= run.from ? `끝난 부분(#${run.from}–#${run.st.lastIndex})은 저장됐고, ` : '저장된 부분은 없어요. ';
        settings().interrupted[run.key] = { at: Date.now(), from: run.st.lastIndex + 1 }; saveSettings();
        toastr.warning(`${name} 저장을 멈췄어요. ${saved}나머지는 그 방에서 다시 세이브해 주세요.`, 'SavePoint · 저장이 취소됐어요', { timeOut: 12000 });
    } else if (run.kind === 'auto') {
        toastr.warning(`${name} 체크포인트를 멈췄어요. 저장된 구간은 유지하고, 다음 간격에 이어서 처리해요. 퀵세이브로 바로 저장할 수 있어요.`, 'SavePoint · 자동 저장 취소', { timeOut: 10000 });
    } else if (run.kind === 'check') {
        toastr.info(`${name} 기록 확인을 멈췄어요. 기억은 이미 저장돼 있어요.`, 'SavePoint', { timeOut: 8000 });
    } else {
        toastr.info(`${name} 진행 중이던 기억 정리를 멈췄어요. 바뀐 내용은 없어요.`, 'SavePoint', { timeOut: 8000 });
    }
}
function interruptedNote(st) {
    const it = settings().interrupted?.[roomKey()];
    if (!it || !st) return null;
    if (st.lastIndex >= chat().length - 1) { clearInterrupted(roomKey()); return null; }
    return it;
}

// ───────── events ─────────

function onChatChanged() {
    const leaving = ui.run;
    roomEpoch++; cancelRun(); clearTimeout(autoTimer);
    noteLeftDuringRun(leaving);
    clearTimeout(persistTimer); clearTimeout(chatSaveTimer); clearTimeout(sourceTimer);
    ui.edit = null; ui.lastError = null; ui.lastFix = null; mainGenerating = false;
    document.querySelector?.('#sp_loot_dialog')?.close();
    if (hasChat()) {
        const st = state();
        if (st && st.roomKey !== roomKey()) {
            // A branch copies chat metadata; the copy becomes this room's own memory.
            st.roomKey = roomKey(); st.linkedSave = null; persistSoon();
        }
        reconcile();
        syncHide();
        const it = interruptedNote(state());
        if (it) toastr.info(`이 방의 지난 저장이 방을 옮기면서 중간에 멈췄어요 (#${it.from}부터 미기록). SavePoint에서 퀵세이브로 이어서 기록할 수 있어요.`, 'SavePoint', { timeOut: 10000 });
    }
    refreshInjection(); render(true); installLootBar(); updateSaveBanner();
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
    globalThis.document?.addEventListener?.('selectionchange', trackSelection);
    installLootBar();
    on('GENERATION_STARTED', onGenerationStarted);
    for (const t of ['GENERATION_ENDED', 'GENERATION_STOPPED']) on(t, onGenerationEnded);
    for (const t of ['CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_CREATED']) on(t, () => { fillProfiles(); updateSettingsSummaries(); });
    onChatChanged();
    // Server-side save slots: the server index is the list; then move any settings-only slots over.
    vault.init(settings().slotCache).then(migrateLocal).catch(e => console.warn('[SavePoint] vault', e)).finally(() => render(true));
});

// Exposed for regression checks only.
globalThis.__savePoint = { state, settings, summarize, listSaves, vault, migrateLocal, autoCollect, autoBlocked, autoCount, scheduleAuto, undo, loadSave, reconcile, syncHide, refreshInjection, handle, ui, render, estTokens, recordLine, reportText, addLoot, queueHtml, installLootBar, openLootDialog };
