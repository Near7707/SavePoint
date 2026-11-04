import { questEventTimes, dueStatus, formatDue, setManualDue, upgradeStoryTimes, timelineRows, linkReference, linkConflicts, PERIODS, editStoryTime, dateAt, formatSegmentTime, sceneTimeRange, storyTimeContext } from './temporal.js';
// SavePoint: scene journal + current state memory for SillyTavern, kept per chat room,
// with game-style save files. Summaries run on demand and at periodic checkpoints.
import { foldLegacyOutline,
    emptyMem, cleanMem, detachMem, chunkMessages, promptContext, validateResult, resultLanguageIssues,
    applyResult, closeOpenScene, pushHistory, rollbackFrom, buildInjection, neededBudget, openScene, memStats,
    pointInjected, pointSymbol, rekeyItems, validateRekey, applyRekey, sceneOutlineText, sceneOutlineParts,
    refreshProvisionalOutlines, normalizeResult, validateCheck, checkScope, dupState, pointId,
    recordLine, normalizeRecordNames, entityName, estTokens, QUEST_KINDS, WORLD_KINDS, ENTITY_TYPES,
    groupErrors, findQuote, mostlyNonEnglish, setQuestStatus, newestParty,
} from './core.js';
import { lootStatus, lootWarning, lootInChunk, lootBlock, attachLoot, settleLoot, failLoot, lootTarget, applyLootSupplement, restoreLostLoot } from './loot.js';
import { Vault, roomHash, quickId } from './vault.js';
import { upgradeEvidence, segmentPrior, evidenceNumbers } from './provenance.js';
import { assertPromptFits, nextMessageChunk, planReviewBatches } from './request-batches.js';
import { DEFAULT_GUIDE, guideHash, OLD_GUIDE_HASHES, buildCheckPrompt, buildRekeyPrompt, buildExtractPrompt, buildExtractPromptParts, PROMPT_PART_LABELS, retryNote, extractionRepairNote, TRANSLATE_PROMPT } from './prompts.js';

const MODULE = 'savePoint';
const PROMPT_KEY = 'savepoint';
const HIDE_KEY = 'savepointHidden';
const VISIBLE_KEY = 'savepointVisible';
// v0.6.51: in the manual range but shown for now only because of "keep the latest N" (or a shorter chat).
const HELD_KEY = 'savepointHeld';
// v0.6.52: 🔖 원문 유지 — this message is never hidden by SavePoint (kept on the message, so it
// follows the message, its swipes and a branch of the chat).
const KEEP_KEY = 'savepointKeep';
const VERSION = '0.6.55';

const ctx = () => SillyTavern.getContext();
const clone = v => structuredClone(v);

const DEFAULTS = {
    enabled: true, check: true, auto: true, autoEvery: 20, autoReserve: 2, profileId: '', responseLength: 8000, inputChars: 60000, timeoutSec: 300, timeoutTotalMin: 20, sourceChars: 12000, excludeMarks: '', askResume: true, resumeDismissed: {}, boxMode: 'notify', questMode: 'confirm', firstTab: 'main',
    requestStream: true, reasoningEffort: '',
    budget: 6000, titleCap: 600, recentScenes: 3, recall: true, rawRecall: false,
    hideMode: 'auto', keepRecent: 10, position: 1, depth: 4, role: 0,
    theme: 'jrpg', showKo: false, autoKeep: 30, guide: DEFAULT_GUIDE, slotCache: [], localSaves: {}, settingsOpen: {}, interrupted: {},
};
const SETTING_GROUPS = {
    connection: { title: '연결·AI 요청', keys: ['profileId', 'requestStream', 'reasoningEffort', 'responseLength', 'inputChars', 'sourceChars', 'timeoutSec', 'timeoutTotalMin'] },
    recording: { title: '체크포인트·기록 확인', keys: ['check', 'auto', 'autoEvery', 'autoReserve', 'excludeMarks', 'questMode'] },
    injection: { title: '기억 주입', keys: ['budget', 'titleCap', 'recentScenes', 'recall', 'rawRecall', 'position', 'depth', 'role'] },
    storage: { title: '하이드·보관', keys: ['hideMode', 'keepRecent', 'autoKeep', 'boxMode', 'askResume'] },
    appearance: { title: '화면', keys: ['theme', 'firstTab', 'showKo'] },
    // v0.6.39: the recording instructions live under 고급, folded, with what editing them means.
    advanced: { title: '🛠 고급', keys: ['guide'] },
};
const HIDE_MODES = [['auto', '자동 · 세이브할 때마다 기록된 원문 숨기기'], ['manual', '수동 · 👻 하이드 버튼을 누를 때만'], ['off', '끔 · 숨긴 원문 다시 표시']];
const QUEST_MODES = [['auto', '자동 등록 · 바로 진행 중 목록에'], ['confirm', '확인 후 등록 · 후보로 모아 수락·거절']];
const THEMES = { jrpg: '클래식 JRPG', neon: '네온 아케이드', glass: '글래스 사이버', archive: '다크 아카이브', pastel: '파스텔 드림', terminal: '터미널', eggpet: '딸기우유', dualwhite: '듀얼 화이트', ink: '먹과 한지', cream: '크림 라테', consolenight: '스토리 콘솔', cranelemon: '레몬 인형뽑기', gingerbread: '진저브레드 하우스', xmasknit: '크리스마스 니트', lilac: '라일락 미드나잇', st: '실리태번 테마 따라가기' };
// Themes that were retired, and the closest one now.
const RETIRED_THEMES = { parchment: 'cream', colorpocket: 'eggpet', joycon: 'dualwhite', vanilla: 'cream' };
// v0.6.37: 💠 메인 (STATUS) first; the loot queue lives in its alert area instead of its own tab.
const TABS = [
    ['main', '💠', '메인'], ['journal', '📜', '저널'], ['timeline', '📅', '타임라인'], ['quests', '❗', '퀘스트'], ['party', '👥', '파티'],
    ['items', '🎒', '인벤토리'], ['world', '🗺', '월드'], ['saves', '💾', '세이브'], ['inject', '🧿', '주입'],
];
const FIRST_TABS = { main: '💠 메인', journal: '📜 저널', timeline: '📅 타임라인', quests: '❗ 퀘스트' };
const KIND_KO = {
    promise: '약속', goal: '목표', debt: '빚', mystery: '수수께끼',
    place: '장소', rule: '규칙', name: '별명·이름', secret: '비밀',
    relation: '관계', condition: '상태', person: '인물', item: '물건',
};
const QUEST_ICON = { promise: '🤝', goal: '🎯', debt: '💰', mystery: '❓' };

const ui = { open: false, tab: 'journal', run: null, progress: '', edit: null, inj: null, lastError: null, found: null, savesOpen: new Map(), scrollPositions: new Map() };
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
    // v0.6.36: someone already using SavePoint keeps the box working as before (manual); the
    // "notify" default is for a new install.
    // v0.6.55: "직접 관리" is gone; it becomes "알림 받고 결정" (the default).
    if (!('boxMode' in s) || !['notify', 'auto'].includes(s.boxMode)) s.boxMode = 'notify';
    // v0.6.39: likewise, quests keep being listed automatically for someone already using SavePoint.
    if (!('questMode' in s) && 'theme' in s) s.questMode = 'auto';
    // v0.6.49: the old on/off hide setting becomes a mode (off / auto / manual).
    if (!('hideMode' in s)) s.hideMode = s.hide === false ? 'off' : 'auto';
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
    if (normalizeRecordNames(st.mem)) persistSoon();
    // Re-read saved time claims once per memory object with the current rules (weekday dates,
    // quoted "same"). Not during a run: the run's own results already use these rules.
    if (!storyTimesChecked.has(st.mem) && !ui.run) {
        storyTimesChecked.add(st.mem);
        if (upgradeStoryTimes(st.mem)) persistSoon();
    }
    return st;
}
const storyTimesChecked = new WeakSet();
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
// v0.6.55: a change is a ⏪ rewind point only when it says so (`undoable` + `undoKind`): saves, a reset
// and a load. Edits made with buttons no longer take the one rewind step.
async function transact(change, { undoable = false, undoKind = '', autosave: doAutosave = true, rehide = false, replay = false, snapshot = false } = {}) {
    const entry = { change, undoable, undoKind, autosave: doAutosave, rehide, replay, snapshot, key: roomKey(), epoch: roomEpoch };
    if (applyEntry(entry) === false) return false;
    const queue = saveQueue(entry.key, entry.epoch);
    queue.pending.push(entry);
    const done = queue.chain.then(() => writeEntry(queue, entry));
    queue.chain = done.catch(() => {});
    return done;
}
// v0.6.44: changes show at once and are written in order, one room queue at a time. When a write
// fails, that change and everything after it are taken back to the state before it, then the later
// changes that can safely run again (edits made with buttons, `replay`) are applied again on top and
// written by their own turn in the queue; the rest are cancelled with the same error. So a failed
// earlier write never undoes a later choice that is still shown, and the file and the screen agree.
const saveQueues = new Map();
function saveQueue(key, epoch) {
    const id = `${key}|${epoch}`;
    if (!saveQueues.has(id)) saveQueues.set(id, { chain: Promise.resolve(), pending: [] });
    return saveQueues.get(id);
}
// Applies one change to the page (memory, hide flags, injection, screen). false = nothing changed.
function applyEntry(entry) {
    const meta = entry.meta = ctx().chatMetadata;   // this room's metadata, even if the room changes later
    entry.prev = meta[MODULE] ? clone(meta[MODULE]) : undefined;
    // A save-time rescan may retire a previous manual visibility exception.
    // Keep those flags as well as visibility so a failed disk write restores
    // the exact pre-save state, including messages the user had opened.
    // v0.6.51: in manual mode an ordinary sync no longer hides anything new, so a failed write cannot
    // rebuild the old visibility from the memory alone: every change keeps the snapshot there.
    entry.visibility = entry.rehide || entry.snapshot || hideModeOf(settings()) === 'manual' ? chat().map(m => ({ m, system: m.is_system,
        hadSystem: Object.hasOwn(m, 'is_system'), hadExtra: Object.hasOwn(m, 'extra'), extra: m.extra,
        hadHidden: !!m.extra && Object.hasOwn(m.extra, HIDE_KEY), hidden: m.extra?.[HIDE_KEY],
        hadVisible: !!m.extra && Object.hasOwn(m.extra, VISIBLE_KEY), visible: m.extra?.[VISIBLE_KEY],
        hadHeld: !!m.extra && Object.hasOwn(m.extra, HELD_KEY), held: m.extra?.[HELD_KEY],
        hadKeep: !!m.extra && Object.hasOwn(m.extra, KEEP_KEY), keep: m.extra?.[KEEP_KEY] })) : null;
    if (entry.change() === false) return false;
    const st = state();
    // v0.6.45: a button edit remembers what it changed (paths and their final values), so a replay
    // sets "● off" again instead of flipping whatever is there, and never brings back the failed
    // change it was first made on top of.
    if (entry.replay && !entry.patch) entry.patch = diffPaths(entry.prev?.mem, st?.mem);
    if (st) {
        if (entry.undoable && entry.prev) { const { undo: _u, undoInfo: _i, ...rest } = entry.prev; st.undo = clone(rest); st.undoInfo = { kind: entry.undoKind || 'edit', at: Date.now(), edits: 0 }; }
        // v0.6.55: memory changes made after the rewind point (they go back with it; the question says so).
        else if (st.undo && st.undoInfo && JSON.stringify(entry.prev?.undoInfo ?? null) === JSON.stringify(st.undoInfo) && JSON.stringify(entry.prev?.mem ?? null) !== JSON.stringify(st.mem)) st.undoInfo.edits = (st.undoInfo.edits || 0) + 1;
        st.rev = (entry.prev?.rev || 0) + 1;
    }
    syncHide({ rehide: entry.rehide }); refreshInjection();
    // v0.6.43: show the change at once; the chat file is written after.
    if (roomKey() === entry.key && roomEpoch === entry.epoch) render();
    return true;
}
// Puts the page back to the state before `entry` (memory and, for a rescan, the hide flags).
function restoreEntry(entry) {
    const meta = entry.meta;
    if (entry.prev === undefined) delete meta[MODULE]; else meta[MODULE] = entry.prev;
    const here = roomKey() === entry.key && roomEpoch === entry.epoch;
    if (entry.visibility) entry.visibility.forEach((v, i) => {
        if (here) setHidden(v.m, i, !!v.system);
        if (v.hadSystem) v.m.is_system = v.system; else delete v.m.is_system;
        if (v.hadExtra) v.m.extra = v.extra; else delete v.m.extra;
        if (v.m.extra) {
            if (v.hadHidden) v.m.extra[HIDE_KEY] = v.hidden; else delete v.m.extra[HIDE_KEY];
            if (v.hadVisible) v.m.extra[VISIBLE_KEY] = v.visible; else delete v.m.extra[VISIBLE_KEY];
            if (v.hadHeld) v.m.extra[HELD_KEY] = v.held; else delete v.m.extra[HELD_KEY];
            if (v.hadKeep) v.m.extra[KEEP_KEY] = v.keep; else delete v.m.extra[KEEP_KEY];
        }
    });
    return here;
}
async function writeEntry(queue, entry) {
    if (entry.done) return true;                 // written by an earlier write that already held it
    if (entry.cancelled) throw entry.cancelled;
    // v0.6.45: a write saves the room that is open; after a move it would save the other room.
    if (roomKey() !== entry.key || roomEpoch !== entry.epoch) {
        const left = queue.pending.slice(Math.max(0, queue.pending.indexOf(entry)));
        queue.pending.length = 0;
        const error = new Error(`채팅방을 옮겨서 이전 방의 마지막 변경 ${left.length}개는 저장하지 못했을 수 있어요. 그 방을 다시 열어 확인해 주세요.`);
        for (const x of left) x.cancelled = error;
        throw error;
    }
    // A write saves everything on the page at that moment: every change applied so far is in it.
    const covered = queue.pending.slice(queue.pending.indexOf(entry));
    try { await persist(); }
    catch (e) {
        const error = new Error(`채팅 파일에 저장하지 못해서 이번 변경을 취소했어요. (${e?.message || e})`);
        const at = queue.pending.indexOf(entry), later = queue.pending.slice(at + 1);
        queue.pending.splice(at);
        // Back to before this change: later changes go too (in reverse, each to its own "before").
        let here = false;
        for (const x of [...later].reverse()) here = restoreEntry(x) || here;
        here = restoreEntry(entry) || here;
        // Edits made with buttons are applied again on top with their final values; they keep their
        // place in the queue and are written by their own turn.
        let replayed = 0;
        for (const x of later) {
            let ok = false;
            if (x.replay && x.patch && roomKey() === x.key && roomEpoch === x.epoch) {
                const patch = x.patch;
                x.change = () => {
                    const st = ensureState(), before = st.mem, next = clone(before);
                    const res = applyPaths(next, patch);
                    if (res === 'stop') throw new Error('replay stopped');
                    if (res === 'same') return false;
                    cleanMem(clone(next));   // the result must still be a valid memory, or nothing is kept
                    st.mem = next; pushHistory(st, before, next, { kind: 'edit' });
                };
                try { ok = applyEntry(x) !== false ? true : 'same'; } catch { ok = false; }
            }
            if (ok === 'same') x.done = true;   // already so: nothing to write, not an error
            else if (ok) { queue.pending.push(x); replayed++; }
            else x.cancelled = new Error(`앞선 변경을 채팅 파일에 저장하지 못해서 이 변경도 취소했어요. (${e?.message || e})`);
        }
        if (here) {
            if (!entry.visibility && !later.some(x => x.visibility)) syncHide(); else ctx().swipe?.refresh?.();
            refreshInjection(); render();
        }
        if (replayed) error.message += ` 그 뒤에 한 변경 ${replayed}개는 다시 적용해 저장해요.`;
        throw error;
    }
    // Everything that was on the page when the write began is in the file now.
    for (const x of covered) { x.done = true; const i = queue.pending.indexOf(x); if (i >= 0) queue.pending.splice(i, 1); }
    if (roomKey() === entry.key && roomEpoch === entry.epoch) { if (entry.autosave) autosave(state()); render(); }
    return true;
}
// v0.6.46: what a button edit changed, as steps a replay can repeat safely. Items in lists that have
// ids (scenes, parts, entities, records) are addressed by id, never by position: { id } in a path,
// { add, after } to insert, { remove } to delete. Lists without ids (points) are addressed by
// position only while their length and the item there are the ones the edit saw ({ i, len, sig }); a list that changed
// length there cannot be replayed. Anything that cannot be found makes the replay stop.
// v0.6.47: what an item without an id is (a point: its text and evidence), so a same-length list with
// other items in it is never taken for the one the edit saw.
const itemSig = x => JSON.stringify(x && typeof x === 'object' && 'text' in x ? [x.text, x.msgs ?? null, x.kind ?? null] : x);
const hasIds = l => Array.isArray(l) && l.length > 0 && l.every(x => x && typeof x === 'object' && typeof x.id === 'string');
function diffPaths(a, b, path = [], out = []) {
    if (JSON.stringify(a) === JSON.stringify(b)) return out;
    const obj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (obj(a) && obj(b)) {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (!(k in b)) out.push({ path: [...path, k], del: true });
            else diffPaths(a[k], b[k], [...path, k], out);
        }
    } else if (Array.isArray(a) && Array.isArray(b) && (hasIds(a) || hasIds(b)) && [...a, ...b].every(x => x && typeof x.id === 'string')) {
        const ida = new Map(a.map(x => [x.id, x])), idb = new Set(b.map(x => x.id));
        for (const x of a) if (!idb.has(x.id)) out.push({ path, remove: x.id });
        b.forEach((x, i) => {
            if (ida.has(x.id)) diffPaths(ida.get(x.id), x, [...path, { id: x.id }], out);
            else out.push({ path, add: clone(x), after: i ? b[i - 1].id : null });
        });
    } else if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
        a.forEach((x, i) => diffPaths(x, b[i], [...path, { i, len: a.length, sig: itemSig(x) }], out));
    } else if (Array.isArray(a) || Array.isArray(b)) out.push({ path, unsafe: true });
    else if (path.length && typeof path.at(-1) === 'string') out.push({ path, value: clone(b) });
    else out.push({ path, unsafe: true });
    return out;
}
// Repeats those steps on `target`. Returns 'changed', 'same' (already so) or 'stop' (a target is
// gone, a list changed under it, or a step is not repeatable) — then nothing should be kept.
function applyPaths(target, patch) {
    let changed = false;
    const walk = path => {
        let o = target;
        for (const seg of path) {
            if (o === null || typeof o !== 'object') return null;
            if (typeof seg === 'string') o = o[seg];
            else if ('id' in seg) o = Array.isArray(o) ? o.find(x => x?.id === seg.id) : undefined;
            else o = Array.isArray(o) && o.length === seg.len && itemSig(o[seg.i]) === seg.sig ? o[seg.i] : undefined;
            if (o === undefined) return null;
        }
        return o;
    };
    for (const step of patch) {
        if (step.unsafe) return 'stop';
        if ('remove' in step || 'add' in step) {
            const list = walk(step.path);
            if (!Array.isArray(list)) return 'stop';
            if ('remove' in step) { const i = list.findIndex(x => x?.id === step.remove); if (i >= 0) { list.splice(i, 1); changed = true; } continue; }
            if (list.some(x => x?.id === step.add.id)) return 'stop';
            const at = step.after === null ? 0 : list.findIndex(x => x?.id === step.after) + 1;
            if (step.after !== null && at === 0) return 'stop';
            list.splice(at, 0, clone(step.add)); changed = true; continue;
        }
        const parent = walk(step.path.slice(0, -1)), k = step.path.at(-1);
        if (parent === null || typeof parent !== 'object' || typeof k !== 'string') return 'stop';
        if (step.del) { if (k in parent) { delete parent[k]; changed = true; } }
        else if (JSON.stringify(parent[k]) !== JSON.stringify(step.value)) { parent[k] = clone(step.value); changed = true; }
    }
    return changed ? 'changed' : 'same';
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
function viewText(m) { return typeof m?.extra?.display_text === 'string' ? cleanText(excludeMarked(m.extra.display_text)) : ''; }
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
// v0.6.28: parts the user marks as not-for-the-record (for example an inner-thoughts info box) are
// removed from every text sent to the summarizer. The chat itself is never changed. One rule per
// line: a tag name ("thoughts" removes <thoughts>…</thoughts>), or "start ~ end" for any
// other pair of markers. A start without its end is left as it is rather than cutting the rest.
function exclusionRules() {
    return String(settings().excludeMarks || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
        const pair = line.split(' ~ ');
        if (pair.length === 2 && pair[0].trim() && pair[1].trim()) return { start: pair[0].trim(), end: pair[1].trim() };
        const tag = line.replace(/^<\/?|>$/g, '').trim();
        return /^[\w:.-]+$/.test(tag) ? { tag } : null;
    }).filter(Boolean);
}
const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function excludeMarked(raw) {
    let t = String(raw || '');
    for (const r of exclusionRules()) {
        t = r.tag ? t.replace(new RegExp(`<${reEsc(r.tag)}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${reEsc(r.tag)}\\s*>`, 'gi'), '\n')
            : t.replace(new RegExp(`${reEsc(r.start)}[\\s\\S]*?${reEsc(r.end)}`, 'g'), '\n');
    }
    return t;
}
// What the summarizer reads of a message.
const EXCLUDED_ONLY = '(only excluded content)';
function msgText(m) { return cleanText(excludeMarked(m?.mes)); }
function speaker(m) { return m.name || (m.is_user ? ctx().name1 : ctx().name2) || 'Someone'; }
// Our own hidden messages still count; messages the user hid themselves are left out.
function eligible(m) { return m && (!m.is_system || m.extra?.[HIDE_KEY]) && cleanText(m.mes); }
function collect(start, end) {
    const out = [];
    for (let i = Math.max(0, start); i <= end; i++) {
        const m = chat()[i];
        if (eligible(m)) out.push({ index: i, name: speaker(m), text: msgText(m) || EXCLUDED_ONLY });
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
// v0.6.49: 'off' / 'auto' (every save hides what it recorded) / 'manual' (only the 👻 button does).
// Settings from before v0.6.49 only have `hide`.
function hideModeOf(s) {
    if (['off', 'auto', 'manual'].includes(s.hideMode)) return s.hideMode;
    return s.hide === false ? 'off' : 'auto';
}
// The newest message the hide may reach now: recorded, and outside the latest N kept as they are.
function hideLimit(st, list = chat()) { return Math.min(st.lastIndex, list.length - 1 - num('keepRecent', 0, 200)); }
// In manual mode the hidden range of a room is `st.hideManual` ({ to, at }), set by the 👻 button.
// A range from before the latest switch to manual (or none) does not count: the first time the room
// is seen in manual mode, the range is fixed once from the messages SavePoint actually hides at that
// moment (v0.6.50: hidden ones only, never "opened by the user" marks) and kept in the room.
const freshManual = (h, s = settings()) => !!h && Number.isInteger(h.to) && (Number(h.at) || 0) >= (Number(s.hideManualAt) || 0);
const kept = m => !!m?.extra?.[KEEP_KEY];
function hiddenNow(list = chat()) {
    let to = -1;
    list.forEach((m, i) => { if (m.is_system && m.extra?.[HIDE_KEY]) to = i; });
    return to;
}
// What the 👻 button would hide now: the last index it reaches and how many messages are still shown there.
function manualHidePlan(st, list = chat()) {
    const to = hideLimit(st, list);
    let count = 0;
    for (let i = 0; i <= to; i++) if (list[i] && !list[i].is_system && !kept(list[i])) count++;
    return { to, count };
}
// `rehide`: true for a save (in manual mode it no longer rescans: the range is the button's), 'button'
// for the 👻 button (rescans the range, like a save in auto mode).
function syncHide({ rehide = false } = {}) {
    const st = state(), s = settings(), list = chat();
    const mode = hideModeOf(s);
    const can = s.enabled && mode !== 'off' && st && !st.review && hasMemory(st.mem);
    let cutoff = can ? hideLimit(st, list) : -1;
    let changed = false, reach = -1;
    if (st && mode === 'manual') {
        // Messages that went back to unrecorded (rewind, a rolled-back record, even all of them) leave
        // the range for good: recorded again, they stay shown until the button is pressed again.
        const h = st.hideManual, floor = hasMemory(st.mem) ? st.lastIndex : -1;
        if (freshManual(h, s) && h.to > floor) { h.to = floor; changed = true; }
        if (can) {
            if (!freshManual(st.hideManual, s)) { st.hideManual = { to: Math.min(hiddenNow(list), st.lastIndex), at: Date.now() }; changed = true; }
            reach = Math.min(st.hideManual.to, st.lastIndex);
            cutoff = Math.min(cutoff, reach);
        }
    }
    // Off: "opened by the user" marks mean nothing any more; dropped so no later mode reads them.
    if (mode === 'off' && s.enabled) list.forEach(m => { for (const k of [VISIBLE_KEY, HELD_KEY]) if (m.extra && Object.hasOwn(m.extra, k)) { delete m.extra[k]; changed = true; } });
    const rescan = rehide && (mode !== 'manual' || rehide === 'button');
    const dropHeld = m => { if (m.extra && Object.hasOwn(m.extra, HELD_KEY)) { delete m.extra[HELD_KEY]; changed = true; } };
    list.forEach((m, i) => {
        const mark = m.extra?.[HIDE_KEY];
        // v0.6.52: 🔖 원문 유지 — what SavePoint hid there is shown again; a hide of the user's own
        // (no SavePoint mark) is left as it is. No other mark is kept on it.
        if (kept(m)) {
            if (mark) { if (m.is_system) setHidden(m, i, false); delete m.extra[HIDE_KEY]; changed = true; }
            for (const k of [VISIBLE_KEY, HELD_KEY]) if (Object.hasOwn(m.extra, k)) { delete m.extra[k]; changed = true; }
            return;
        }
        if (rescan && i <= cutoff) {
            // Recheck from #0 on every saved batch. A manually opened message
            // stays open during ordinary redraws, but joins the next save's hide.
            if (m.extra && Object.hasOwn(m.extra, VISIBLE_KEY)) { delete m.extra[VISIBLE_KEY]; changed = true; }
            dropHeld(m);
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
            delete m.extra[HIDE_KEY]; m.extra[VISIBLE_KEY] = true; dropHeld(m); changed = true; return;
        }
        if (can && mode === 'manual') {
            // v0.6.51: manual mode only keeps what the button hid. Nothing new is hidden here, so a
            // message the user hid and opened again (it carries no SavePoint mark) stays shown. A
            // message shown only because of "keep the latest N" is held and hidden again when it
            // falls outside the latest N.
            if (mark && i > cutoff) { setHidden(m, i, false); delete m.extra[HIDE_KEY]; if (i <= reach) m.extra[HELD_KEY] = 1; changed = true; }
            else if (m.extra?.[HELD_KEY] && (m.is_system || i > reach)) dropHeld(m);
            else if (m.extra?.[HELD_KEY] && i <= cutoff) { m.extra[HIDE_KEY] = 1; dropHeld(m); setHidden(m, i, true); changed = true; }
            return;
        }
        dropHeld(m);
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
        st.undo = null; st.undoInfo = null; st.rev++;
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
        st.floor = st.lastIndex; st.history = []; st.review = null; st.undo = null; st.undoInfo = null;
    }, { undoable: false });
}

// ───────── injection ─────────

function recentQuery() {
    const list = chat();
    const out = [];
    for (let i = list.length - 1; i >= 0 && out.length < 6; i--) {
        const m = list[i];
        if (m && !m.is_system && msgText(m)) out.unshift(msgText(m));
    }
    return out.join('\n').slice(-5000);
}
function rawExcerpt(scene) {
    if (scene.external && scene.segs.every(g => !g.external && !g.source)) return '';
    for (const g of scene.segs.filter(g => !g.external && !g.source)) for (const p of g.points) for (const n of p.msgs) {
        if (Number.isInteger(n) && chat()[n]) return msgText(chat()[n]).slice(0, 600);
    }
    return '';
}
function refreshInjection() {
    const st = state(), s = settings();
    let text = '';
    ui.inj = null;
    if (s.enabled && st && hasChat() && !st.review && hasMemory(st.mem)) {
        const opts = {
            budget: num('budget', 300, 100000), titleCap: num('titleCap', 0, 20000), recentScenes: num('recentScenes', 0, 20),
            query: recentQuery(), recall: !!s.recall, rawRecall: s.rawRecall ? rawExcerpt : null,
            ignoreNames: [names().char, names().user, charInfo()?.name].filter(Boolean),
        };
        ui.inj = buildInjection(st.mem, opts);
        ui.injOpts = opts; ui.injNeed = undefined; ui.injNeedPoints = undefined;   // the needed limit is computed when the tab shows it
        text = ui.inj.text;
    }
    ctx().setExtensionPrompt(PROMPT_KEY, text, Number(s.position), num('depth', 0, 999), false, Number(s.role));
}

// ───────── AI calls ─────────

class Cancelled extends Error {}
class RequestTimeout extends Error {
    // kind: 'idle' = no new output for the wait limit, 'total' = the overall maximum was reached,
    // 'limit' = a request whose progress cannot be seen ran past its single time limit.
    constructor(message, kind = 'limit') { super(message); this.kind = kind; }
}
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
// A configured limit reads better as "5분" than "5분 00초".
const fmtLimit = ms => { const t = Math.round(ms / 1000); return t >= 60 && t % 60 === 0 ? `${t / 60}분` : fmtSec(ms); };
function limitText(r) {
    if (!r?.limitMode) return '';
    if (r.limitMode === 'idle') return `대기 ${fmtLimit(r.idleMs)} · 출력 중 연장 · 최대 ${fmtLimit(r.totalMs)}`;
    return `전체 제한 ${fmtLimit(r.totalMs)}`;
}
function reqText() {
    const r = ui.req;
    if (!r) return '';
    const step = (r.attempt ? `재요청${r.why ? ` (${r.why})` : ''}` : '첫 요청') + ` · 입력 ${r.chars.toLocaleString()}자`;
    if (r.phase === 'got') return `${step} · 응답 받음 (${fmtSec(r.ms)}) · 검사 중`;
    const elapsed = fmtSec(Date.now() - r.start);
    const lim = limitText(r);
    const quiet = r.limitMode === 'idle' && r.lastOutputAt && Date.now() - r.lastOutputAt >= 30000 ? ` · 새 출력 없음 ${fmtSec(Date.now() - r.lastOutputAt)}` : '';
    if (r.phase === 'stream') return `${step} · 수신 중 ${elapsed} · 사고 ${(r.reasoningChars || 0).toLocaleString()}자 / 본문 ${(r.textChars || 0).toLocaleString()}자${quiet}${lim ? ` · ${lim}` : ''}`;
    return `${step} · 응답 대기 ${elapsed}${lim ? ` · ${lim}` : ''}`;
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
async function llm(prompt, run, { attempt = 0, why = '', responseLength, timeoutSeconds, parts = null } = {}) {
    if (run) run.requestRecord = null;
    const s = settings(), c = ctx(), max = responseLength ?? num('responseLength', 500, 64000);
    assertPromptFits(prompt, num('inputChars', 5000, 1000000));
    const limit = (timeoutSeconds ?? num('timeoutSec', 5, 3600)) * 1000;
    const id = ++reqSeq;
    const profileId = s.profileId;
    const stream = !!profileId && !!s.requestStream;
    // v0.6.24: when the reply streams, the wait limit only counts time without new output, so a
    // model that is still thinking or writing is not cut off; the overall maximum still applies.
    // A request whose progress cannot be seen keeps one time limit for the whole request.
    const idleMode = stream && timeoutSeconds === undefined;
    const totalLimit = idleMode ? Math.max(limit, num('timeoutTotalMin', 1, 120) * 60000) : limit;
    const effort = ['low', 'high', 'max'].includes(s.reasoningEffort) ? s.reasoningEffort : '';
    const start = Date.now();
    let accepting = true;
    const stats = { at: start, task: ui.progress || '요청', profile: profileLabel(), stream: false,
        effort: profileId ? effort || '프로필 설정' : '메인 API 설정', chars: prompt.length,
        maxTokens: max, textChars: 0, reasoningChars: 0, firstDataMs: null, firstReasoningMs: null, firstTextMs: null, finishReason: null,
        limitMode: idleMode ? 'idle' : 'limit', idleMs: idleMode ? limit : null, totalMs: totalLimit, lastOutputMs: null,
        ...(parts ? { parts: { ...parts } } : {}) };
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const onRunAbort = () => ctrl?.abort();
    if (run?.ctrl?.signal?.aborted) ctrl?.abort(); else run?.ctrl?.signal?.addEventListener?.('abort', onRunAbort);
    const active = () => accepting && !run?.cancelled && !ctrl?.signal?.aborted;
    let seen = 0, idleTimer = null, onIdle = null;
    const armIdle = () => { if (!idleMode || !onIdle) return; clearTimeout(idleTimer); idleTimer = setTimeout(onIdle, limit); };
    const progress = part => {
        if (!active()) return;
        // Only output that actually grew counts as activity; a repeated cumulative chunk or an
        // empty keep-alive does not restart the wait.
        const total = (part.textChars || 0) + (part.reasoningChars || 0);
        if (total > seen) { seen = total; stats.lastOutputMs = Date.now() - start; armIdle(); if (run && ui.req?.id === id) ui.req.lastOutputAt = Date.now(); }
        if (run && ui.req?.id !== id) return;
        Object.assign(stats, part);
        if (stats.firstDataMs === null && (stats.textChars || stats.reasoningChars)) stats.firstDataMs = Date.now() - start;
        // A thinking model may stream only reasoning for minutes: the first body text is timed separately.
        if (stats.firstReasoningMs === null && stats.reasoningChars) stats.firstReasoningMs = Date.now() - start;
        if (stats.firstTextMs === null && stats.textChars) stats.firstTextMs = Date.now() - start;
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
    if (run) { ui.req = { id, attempt, why, start, phase: 'wait', chars: prompt.length, limitMode: stats.limitMode, idleMs: stats.idleMs, totalMs: totalLimit, lastOutputAt: null }; render(); tickReq(); }
    let timer, onCancel;
    const limitP = new Promise((_, reject) => {
        if (idleMode) {
            onIdle = () => reject(new RequestTimeout(stats.lastOutputMs === null
                ? `${fmtLimit(limit)} 동안 응답이 하나도 오지 않았어요.`
                : `마지막 출력 뒤 ${fmtLimit(limit)} 동안 새 출력이 없었어요.`, 'idle'));
            timer = setTimeout(() => reject(new RequestTimeout(`전체 최대 시간 ${fmtLimit(totalLimit)}에 도달해서 중단했어요. 응답은 아직 이어지는 중이었어요.`, 'total')), totalLimit);
        } else timer = setTimeout(() => reject(new RequestTimeout(`응답이 ${fmtLimit(limit)} 안에 오지 않았어요.`, 'limit')), limit);
    });
    armIdle();
    const request = send();
    request.catch(() => {});   // a late failure after the time limit is ignored
    const cancelP = new Promise((_, reject) => { onCancel = () => reject(new Cancelled('중지했어요.')); if (run) (run.onCancel ||= []).push(onCancel); });
    try {
        const raw = await Promise.race([request, limitP, cancelP]);
        stats.status = 'received';
        if (run && ui.req?.id === id) { ui.req = { ...ui.req, phase: 'got', ms: Date.now() - start }; render(); }
        return raw;
    } catch (e) {
        stats.status = e instanceof RequestTimeout ? 'timeout' : run?.cancelled || e instanceof Cancelled ? 'cancelled' : 'error';
        if (e instanceof RequestTimeout) stats.timeoutKind = e.kind;
        if (e instanceof RequestTimeout) { try { ctrl?.abort(); } catch { /* ignore */ } }
        throw e;
    } finally {
        accepting = false;
        stats.ms = Date.now() - start;
        if (run) run.requestRecord = { ...stats };
        if (!run || ui.req?.id === id) ui.lastRequest = { ...stats };
        clearTimeout(timer); clearTimeout(idleTimer);
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
    const run = { id: newId(), st, key: roomKey(), epoch: roomEpoch, cancelled: false, hashes: hashesTo(end), lootCounted: new Set(),
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
    if (ui.run === run) { ui.run = null; ui.progress = ''; ui.req = null; applyPendingSettings(); }
    render();
    if ((run.notice || run.doneText) && run.key === roomKey()) {
        if (run.notice) flashSaveBanner(run.notice.text, { tone: run.notice.tone, goto: run.goto, news: run.news });
        else flashSaveBanner(run.doneText, { goto: run.goto, news: run.news });
    }
    else updateSaveBanner();
}
function checkpoint(st) {
    const { undo, ...rest } = st;
    return clone(rest);
}

// One chunk: ask, check, retry once with the problems listed, then give up without saving.
function extractPrompt(mem, chunk, note = '') { return extractPromptParts(mem, chunk, note).text; }
function extractPromptParts(mem, chunk, note = '') {
    const marked = lootForChunk(chunk);
    return buildExtractPromptParts({ guide: settings().guide || DEFAULT_GUIDE, names: names(), card: cardText(), context: { ...promptContext(mem, chunk.text), time: storyTimeContext(mem) }, chunk, note: [note, lootBlock(marked)].filter(Boolean).join('\n\n') });
}
function lootForChunk(chunk) {
    const items = state()?.lootQueue || [];
    if (!items.length) return [];
    return lootInChunk(items.filter(x => !lootStatus(x, roomKey(), chat(), fingerprint, viewHash)), chunk.indices);
}
async function extractChunk(mem, chunk, run, { note = '', expectContinue } = {}) {
    const built = extractPromptParts(mem, chunk, note), prompt = built.text;
    let data = null, errors = [], lang = [];
    const tries = [];   // what each request did, for the failure details
    let lastKind = '';
    const fail = (head, detail) => {
        ui.lastError = { at: Date.now(), range: `#${chunk.from}–#${chunk.to}`, detail: [...tries.map((t, k) => `${k ? '재요청' : '첫 요청'}: ${t}`), ...detail] };
        const err = new Error(head);
        err.detail = ui.lastError.detail; err.chunk = { from: chunk.from, to: chunk.to };
        ui.lastError.request = requestLines(run.requestRecord);
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
            raw = await llm(requestPrompt, run, { attempt, why, parts: attempt ? { ...built.parts, retry: requestPrompt.length - prompt.length } : built.parts });
        }
        catch (e) {
            if (run.cancelled || e instanceof Cancelled) throw new Cancelled('중지했어요.');
            if (e instanceof RequestTimeout) {
                const r = ui.lastRequest;
                tries.push(`${fmtSec(Date.now() - start)} · ${timeoutLabel(e)}${r ? ` · 수신 본문 ${r.textChars}자 / 사고 ${r.reasoningChars}자` : ''}`);
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
            Object.defineProperty(data, 'lootWhy', { value: attachLoot(data, lootForChunk(chunk)).why, enumerable: false });
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
function recordAutoFail(st, { stage, from, to, error, tries = [], detail = [], failureId, requestRecord = null }) {
    const cut = l => String(l).slice(0, 300);
    // The record keeps what happened then (the failed request and the range left unsaved);
    // what still needs saving is worked out when it is shown, never by rewriting these numbers.
    st.autoFail = { at: Date.now(), kind: 'collect', stage, from, to, reason: errorText(error).slice(0, 400),
        ...(error?.chunk ? { request: { from: error.chunk.from, to: error.chunk.to } } : {}),
        failureId, requestNotSent: !requestRecord && error?.name === 'InputLimitError',
        requestLines: requestLines(requestRecord).map(cut), requestOk: requestRecord?.status === 'received',
        attempts: tries.length, tries: tries.map(cut), detail: groupErrors(detail).slice(0, 40).map(cut) };
    persistSoon();
    toastr.warning(`체크포인트 실패 (#${from}–#${to}) · 해당 구간 원문 유지`, 'SavePoint');
}
function settleAutoFail(st) {
    const f = st.autoFail;
    if (!f) return;
    if (st.lastIndex >= f.to) delete st.autoFail;
}
// The part of a failure's range that is still unsaved now.
function autoFailRemaining(st, f) { return { from: Math.max(f.from, (st?.lastIndex ?? -1) + 1), to: f.to }; }

async function markStaleLoot(run, items) {
    const stale = items.filter(x => lootStatus(x, roomKey(), chat(), fingerprint, viewHash));
    if (!stale.length) return;
    assertValid(run, -1);
    await transact(() => {
        for (const item of run.st.lootQueue || []) if (stale.some(x => x.id === item.id))
            item.error = lootStatus(item, roomKey(), chat(), fingerprint, viewHash);
    }, { undoable: false, autosave: false });
}
// A failed chat-file write puts back a copy of the room's state, so the items are looked up in the
// current state of the same room. If even this note cannot be written, it stays on screen and is
// saved with the next successful write rather than being lost.
async function failPendingLoot(run, items, error) {
    if (run.cancelled || error instanceof Cancelled || run.key !== roomKey() || run.epoch !== roomEpoch || !state()) return 0;
    const sent = new Set(run.lootAttempted || []);
    const ids = new Set(items.filter(x => sent.has(x.id)).map(x => x.id));
    const pending = () => (state()?.lootQueue || []).filter(x => ids.has(x.id) && !lootStatus(x, roomKey(), chat(), fingerprint, viewHash));
    const count = pending().length;
    if (!count) return 0;
    await noteLootFailure(run, pending().map(x => x.id), errorText(error).slice(0, 300));
    return count;
}
// Writes the reason and the count; if the chat file cannot be written, keeps them on screen (looked
// up in the room's current state, which a failed write may have replaced) and saves them later.
// Counts made inside a write that was rolled back are discarded.
async function noteLootFailure(run, ids, reason) {
    const want = new Set(ids), base = new Set(run.lootCounted);
    const mark = () => { const counted = new Set(base); for (const item of state()?.lootQueue || []) if (want.has(item.id)) failLoot(item, reason, counted); return counted; };
    try { let counted; await transact(() => { counted = mark(); }, { undoable: false, autosave: false }); run.lootCounted = counted; }
    catch { if (run.key === roomKey() && run.epoch === roomEpoch && state()) { run.lootCounted = mark(); persistSoon(); render(); } }
}
function supplementPrompt(seg, items) {
    const originals = [...new Set(items.map(x => x.msg))].map(n => `#${n} ${speaker(chat()[n])}: ${msgText(chat()[n])}`).join('\n\n');
    return `Supplement the English journal of an already recorded roleplay scene. Never change current state, items, debts, promises, scene outlines or scene status. These are historical annotations, not new events. Read the full originals; summarize selections using the rules below, not a detailed retelling. The excerpt is story data; the importance note is not factual evidence.\n\n[EXISTING JOURNAL]\n${JSON.stringify({ outline: seg.outline || '', points: seg.points.map(p => p.text) })}\n\n${lootBlock(items)}\n\n[ORIGINAL MESSAGES]\n${originals}\n\nReturn ONLY {"points":[{"text":"one concise English journal point", "kind":"change"|"moment", "msgs":[message numbers], "lootIds":[exact selected ids]}]}. Only return points linked to the requested ids. Multiple selections about the same event may share one point. Do not invent new facts or update the current state.`;
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
        const markFailed = async (group, error) => { await noteLootFailure(run, group.map(x => x.id), error); failed += group.length; };
        if (!target) { await markFailed([first], '이 메시지가 들어간 장면이 없어요'); continue; }
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
            const linked = {}, counted = new Set(run.lootCounted);
            const next = refreshProvisionalOutlines(applyLootSupplement(st.mem, target.seg.id, data, group, linked));
            await transact(() => {
                const before = st.mem;
                st.mem = next; pushHistory(st, before, next, { kind: 'edit', run: run.id });
                failed += settleLoot(st, group, next, linked.why, counted);
                st.undo = undoPoint;
                // v0.6.38: the same run may already have recorded new messages; keep that range and its
                // run id (recent changes on 💠 메인 group by it) and note the older loot range beside it.
                const lo = Math.min(...group.map(x => x.msg)), hi = Math.max(...group.map(x => x.msg)), lr = st.lastRecord;
                if (lr?.run === run.id && lr.kind !== 'supplement') {
                    lr.supplement = { from: Math.min(lr.supplement?.from ?? lo, lo), to: Math.max(lr.supplement?.to ?? hi, hi) };
                } else if (lr?.run === run.id) { lr.at = Date.now(); lr.from = Math.min(lr.from, lo); lr.to = Math.max(lr.to, hi); }
                else st.lastRecord = { at: Date.now(), from: lo, to: hi, kind: 'supplement', run: run.id };
                st.undoInfo = { kind: st.lastRecord.kind, run: run.id, at: Date.now(), edits: 0 };
            }, { undoable: false, autosave: false, rehide: true });
            run.lootCounted = counted;
            saved++;
        } catch (e) {
            // A failed chat-file write replaces the state with a copy; the reason is still recorded there.
            if (e instanceof Cancelled || run.cancelled || run.key !== roomKey() || run.epoch !== roomEpoch) throw e;
            await markFailed(group, errorText(e));
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
                }, { rehide: true, undoable: true, undoKind: 'sceneclose' });
                toastr.success('진행 중이던 장면을 닫았어요.');
            } catch (e) { reportError(e); }
        } else if (settings().enabled && hideModeOf(settings()) !== 'off' && hasMemory(st.mem)) {
            try {
                await transact(() => {}, { undoable: false, autosave: false, rehide: true });
                toastr.info('기록할 새 메시지가 없어요. 하이드 상태를 다시 확인했어요.');
            } catch (e) { reportError(e); }
        } else toastr.info('기록할 새 메시지가 없어요.');
        // Nothing new to collect, but the memory may have been edited by hand: keep it as QUICK.
        if (!auto && state() === st) await quickSave(st).catch(reportError);
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
    let lootFailed = 0, complete = false;
    try {
        while (cursor < msgs.length) {
            assertValid(run, end);
            stage = 'collect';
            // Planning can fail before llm runs. Never borrow an earlier chunk's request.
            run.requestRecord = null;
            const chunk = nextMessageChunk(msgs.slice(cursor), c => extractPrompt(st.mem, c), num('inputChars', 5000, 1000000), { sourceLimit: num('sourceChars', 2000, 200000) });
            const last = cursor + chunk.indices.length === msgs.length;
            ui.progress = `${auto ? '체크포인트' : close ? '장면 닫기' : '퀵세이브'} ${done + 1}구간 #${chunk.from}–#${chunk.to} · ${cursor}/${msgs.length}메시지 완료`;
            render();
            const marked = lootForChunk(chunk);
            marked.forEach(x => attemptedLoot.add(x.id));
            const data = await extractChunk(st.mem, chunk, run);
            const coverTo = last ? end : chunk.to;
            assertValid(run, coverTo);
            const { mem: next } = applyResult(st.mem, data, chunk, { room: run.key, close: close && last, boxMode: settings().boxMode, questMode: settings().questMode });
            // Memory, position and hiding change together; a failed save puts all of it back.
            stage = 'save';
            // Failure counts made inside a write that is rolled back must not stick.
            const counted = new Set(run.lootCounted);
            await transact(() => {
                const before = st.mem;
                st.mem = next;
                pushHistory(st, before, next, { kind: 'summary', from: st.lastIndex + 1, to: coverTo, run: run.id });
                st.lastIndex = coverTo; st.hashes = run.hashes.slice(0, coverTo + 1);
                st.lastRecord = { at: Date.now(), from: start, to: coverTo, kind: auto ? 'checkpoint' : close ? 'sceneclear' : 'quicksave', run: run.id, partial: !last };
                st.undo = undoPoint; st.undoInfo = { kind: st.lastRecord.kind, run: run.id, at: Date.now(), edits: 0 };
                settleAutoFail(st);
                lootFailed += settleLoot(st, marked, next, data.lootWhy, counted);
            }, { undoable: false, autosave: false, rehide: true });
            run.lootCounted = counted;
            done++; cursor += chunk.indices.length;
        }
        const supplement = await supplementLoot(run, oldLoot, undoPoint);
        done += supplement.saved; lootFailed += supplement.failed;
        if (!msgs.length && !supplement.saved && !close && settings().enabled && hideModeOf(settings()) !== 'off' && hasMemory(st.mem))
            await transact(() => {}, { undoable: false, autosave: false, rehide: true });
        if (close && !msgs.length && openScene(st.mem)) {
            assertValid(run, end);
            await transact(() => { const before = st.mem; st.mem = closeOpenScene(before); pushHistory(st, before, st.mem, { kind: 'edit' }); st.undo = undoPoint; st.undoInfo = { kind: 'sceneclear', run: run.id, at: Date.now(), edits: 0 }; }, { undoable: false, autosave: false, rehide: true });
            done++;
        }
        await markStaleLoot(run, queued.filter(x => !attemptedLoot.has(x.id) && !oldLoot.includes(x)));
        ui.lastError = null;
        if (!auto && (msgs.length || close)) toastr.success(close ? '진행 중이던 장면까지 기록하고 닫았어요.' : '퀵세이브 완료. 마지막 메시지까지 기록했어요.', 'SavePoint');
        // v0.6.39: what the save did to quests, shown in the same result banner (no extra pop-up).
        // v0.6.53: quests, items and people go on the result's second line (NEW …).
        const qn = done ? questNews(memBefore, st.mem) : null;
        run.news = done ? saveNews(st, run.id, qn) : '';
        run.goto = qn?.found ? 'main-quests' : run.news ? 'main-changes' : '';
        if (done) run.doneText = `${close ? '저장 완료 · 장면 닫음' : '저장 완료'}${st.lastIndex >= run.from ? ` · #${run.from}–#${st.lastIndex}` : ''}`;
        if (auto) {
            const extra = lootFailed ? ` · 루팅 ${lootFailed}개 반영 실패` : '';
            const result = msgs.length ? `체크포인트 완료 · #${start}–#${st.lastIndex} 기록 · 최근 ${held}개 여유분${extra}`
                : `체크포인트 · 루팅 ${supplement.saved}구간 보충 · 최근 ${held}개 여유분${extra}`;
            noteAuto(st, result, { end: latest, status: lootFailed ? 'partial' : done ? 'saved' : 'empty' });
            run.notice = { text: result, tone: lootFailed ? 'warning' : done ? 'success' : 'info' };
        }
        clearInterrupted(run.key);
        complete = true;
    } catch (e) {
        if (queued.length && !(e instanceof Cancelled) && run.key === roomKey()) {
            try { lootFailed += await failPendingLoot(run, queued, e); } catch { /* a failed disk write leaves the queue intact */ }
        }
        const failureId = !(e instanceof Cancelled) ? newId() : null;
        if (!(e instanceof Cancelled)) {
            if (!e.detail || !ui.lastError) ui.lastError = { at: Date.now(), range: `#${msgs[cursor]?.index ?? start}–#${end}`, detail: [errorText(e)] };
            ui.lastError.failureId = failureId;
            ui.lastError.request = requestLines(run.requestRecord);
            ui.lastError.requestOk = run.requestRecord?.status === 'received';
            if (!run.requestRecord && e?.name === 'InputLimitError') ui.lastError.requestNote = '요청 전 입력 검사에서 중단 · AI 호출 없음';
        }
        const where = done ? ` ${done}개 구간(${cursor}개 메시지)은 저장했고, 남은 ${msgs.length - cursor}개 메시지의 원문은 그대로 남겨 뒀어요.` : ' 기억과 원문은 바뀌지 않았어요.';
        // Leaving the room has its own notice (onChatChanged); don't repeat it in the new room.
        if (e instanceof Cancelled) { if (run.key === roomKey()) toastr.info(e.message + where, 'SavePoint'); }
        else { console.error('[SavePoint]', e, e.detail || ''); if (!auto) toastr.error(e.message + where, 'SavePoint', { timeOut: 12000 }); }
        if (auto && run.key === roomKey() && run.epoch === roomEpoch) {
            const cur = state();
            if (cur) {
                const cancelled = e instanceof Cancelled;
                const detail = Array.isArray(e.detail) ? e.detail : [];
                if (!cancelled) recordAutoFail(cur, { stage, from: msgs[cursor]?.index ?? start, to: end, error: e, failureId, requestRecord: run.requestRecord,
                    tries: detail.filter(isTry), detail: detail.filter(x => !isTry(x)) });
                const result = cursor ? `체크포인트 일부 저장 · #${start}–#${cur.lastIndex} 완료 · #${cur.lastIndex + 1}부터 다음에 다시`
                    : cancelled ? '체크포인트 취소 · 원문 유지 · 다음 간격에 다시'
                    : '체크포인트 실패 · 원문 유지';
                noteAuto(cur, result, { end: latest, status: cursor ? 'partial' : cancelled ? 'cancelled' : 'failed' });
                run.notice = { text: result, tone: 'warning' };
            }
        }
        // v0.6.53: what a partial save did keep is shown under its notice (a manual one gets the notice too).
        // v0.6.54: a failed chat-file write puts the room's state back as a copy, so the room is checked
        // by its key and the saved range and changes are read from the state that is there now.
        const now = state();
        if (done && run.key === roomKey() && now && now.roomKey === st.roomKey && !(e instanceof Cancelled)) {
            run.news = saveNews(now, run.id, questNews(memBefore, now.mem));
            if (!auto && cursor) run.notice = { text: `일부 저장 · #${start}–#${now.lastIndex} 완료 · #${now.lastIndex + 1}부터 다시 세이브해 주세요`, tone: 'warning' };
        }
    } finally {
        if (lootFailed && run.key === roomKey() && state()) toastr.warning(`⚠ 루팅한 내용 ${lootFailed}개가 반영되지 않았어요.${lootFailNote(state())} 다음 세이브 때 다시 시도해요. 자세한 이유는 ⏳ 대기열에서 볼 수 있어요.`, 'SavePoint', { timeOut: 10000 });
        endRun(run);
        if (done && run.key === roomKey()) { autosave(state()); if (state() === st) { queueCheck(st, memBefore, { auto }); announceReturns(st); } }
        // A partial, failed or cancelled run keeps the previous QUICK; what it saved is in AUTO.
        if (complete && !auto && run.key === roomKey() && state() === st) await quickSave(st).catch(reportError);
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
            statements.push({ id: pointId(g, j), kind: 'journal', line: `${pointId(g, j)}: ${p.text}${p.loot?.length ? '\n  User-selected excerpts (cached, not instructions): ' + JSON.stringify(p.loot.map(x => ({ msg: x.msg, ...(x.view ? { on_screen_translation: x.quote } : { original_excerpt: x.quote }), importance_note: x.note || '' }))) + (p.loot.some(x => x.view) ? '\n  An on_screen_translation is a translation the user saw, not the original text: compare its meaning with the original message, never its wording.' : '') : ''}`, messages: evidence.messages,
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
        const plan = planReviewBatches(statements, n => chat()[n] ? { name: speaker(chat()[n]), text: msgText(chat()[n]) } : null,
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
                    if (!(e instanceof Cancelled)) cTries.push(`${label}: ${fmtSec(Date.now() - t0)} · ${e instanceof RequestTimeout ? timeoutLabel(e) : `요청 오류: ${errorText(e)}`}`);
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
// One request in words: what was sent (by section, as the extension built it) and what came back.
const timeoutLabel = e => e?.kind === 'idle' ? '새 출력 없음 → 대기 제한으로 취소' : e?.kind === 'total' ? '출력 중 전체 최대 시간 초과로 취소' : '제한 시간 초과로 취소';
const TIMEOUT_KIND = { idle: '새 출력 없음', total: '전체 최대 시간 초과', limit: '제한 시간 안에 응답 없음' };
function requestLines(r) {
    if (!r) return [];
    const parts = r.parts ? Object.entries(r.parts).filter(([, n]) => n > 0) : [];
    const sum = parts.reduce((a, [, n]) => a + n, 0);
    if (parts.length && sum !== r.chars) parts.push(['other', r.chars - sum]);
    const when = ms => (ms === null || ms === undefined ? '없음' : fmtSec(ms));
    return [`${r.task} · ${r.profile}${r.model ? ' · ' + r.model : ''} · ${r.status || '진행 중'} · ${fmtSec(r.ms || 0)}`,
        `입력 ${r.chars.toLocaleString()}자 (확장이 만든 요청 기준) · 응답 상한 ${r.maxTokens}토큰 · ${r.stream ? '실시간 수신' : '일괄 응답'} · 추론 요청: ${r.effort}`,
        ...(parts.length ? [`입력 내역: ${parts.map(([k, n]) => `${PROMPT_PART_LABELS[k] || k} ${n.toLocaleString()}`).join(' · ')}`] : []),
        `수신 본문 ${r.textChars.toLocaleString()}자 / 사고 ${r.reasoningChars.toLocaleString()}자 · 첫 사고 수신 ${when(r.firstReasoningMs)} · 첫 본문 수신 ${when(r.firstTextMs)} · 종료 사유 ${r.finishReason || 'API에서 제공하지 않음'}`,
        ...(r.limitMode ? [`시간 제한: ${r.limitMode === 'idle' ? `새 출력 대기 ${fmtLimit(r.idleMs)} · 전체 최대 ${fmtLimit(r.totalMs)} · 마지막 출력 ${when(r.lastOutputMs)}` : `전체 제한 ${fmtLimit(r.totalMs)} (실시간 수신 확인 불가)`}${r.timeoutKind ? ` · 중단 이유: ${TIMEOUT_KIND[r.timeoutKind] || r.timeoutKind}` : ''}`] : [])];
}
function reportText(st) {
    const out = [`SavePoint v${VERSION} · 요약 AI: ${profileLabel()}`];
    const r = ui.lastRequest;
    if (r) { const [head, ...rest] = requestLines(r); out.push('', `[마지막 요청] ${head}`, ...rest); }
    if (hasChat()) out.push(`방: ${names().char || ''} · 기록 ${st ? st.lastIndex + 1 : 0} / ${chat().length}`);
    if (ui.lastFix) out.push('', `[자동 보정] ${ui.lastFix.range} · ${ui.lastFix.text}`);
    if (st?.autoFail) out.push('', '[체크포인트 실패 · 수집]', ...autoFailLines(st.autoFail).map(l => `- ${l}`));
    if (ui.lastError) {
        out.push('', `[마지막 실패] ${ui.lastError.range} · ${new Date(ui.lastError.at).toLocaleString()}`);
        for (const d of groupErrors(ui.lastError.detail)) out.push(`- ${d}`);
        if (ui.lastError.requestNote) out.push(ui.lastError.requestNote);
        if (ui.lastError.request?.length) out.push(requestHeading(ui.lastError.requestOk), ...ui.lastError.request.map(l => `  ${l}`));
    }
    const missed = (st?.lootQueue || []).filter(x => x.error);
    if (missed.length) {
        out.push('', `[루팅 반영 실패 ${missed.length}개]`);
        for (const x of missed) out.push(`- #${x.msg}${x.fails > 1 ? ` (${x.fails}번째)` : ''}: ${x.error} · "${String(x.text).slice(0, 80)}${String(x.text).length > 80 ? '…' : ''}"`);
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
// A request that came back fine but whose result failed later (checks, saving) is not a failed request.
const requestHeading = ok => ok ? '이 구간의 요청 기록 (요청은 성공 · 이후 단계에서 실패):' : '실패한 요청의 기록:';
function autoFailLines(f, st = state()) {
    const left = autoFailRemaining(st, f);
    return [`시각: ${new Date(f.at).toLocaleString()}`, `단계: ${FAIL_STAGE[f.stage] || f.stage}`,
        ...(f.request ? [`실패한 요청: #${f.request.from}–#${f.request.to}`] : []),
        `그때 저장하지 못한 범위: #${f.from}–#${f.to}`, `현재 재시도가 필요한 범위: #${left.from}–#${left.to}`,
        `이유: ${f.reason}`, `요청 횟수: ${f.attempts}`, ...(f.tries || []),
        ...(f.requestNotSent ? ['요청 전 입력 검사에서 중단 · AI 호출 없음'] : []),
        ...(f.requestLines?.length ? [requestHeading(f.requestOk), ...f.requestLines.map(l => '  ' + l)] : []), ...(f.detail || [])];
}
function autoFailHtml(st) {
    const f = st?.autoFail;
    if (!f) return '';
    return `<details class="sp-err" data-group="hud-autofail" ${ui.savesOpen.get('hud-autofail') ? 'open' : ''}><summary>⚠ 체크포인트 실패 · 남은 범위 #${autoFailRemaining(st, f).from}–#${f.to} · ${new Date(f.at).toLocaleTimeString()} — 자세히</summary><ul class="sp-scroll">${autoFailLines(f, st).map(l => `<li>${esc(l)}</li>`).join('')}<li class="sp-dim">해당 구간 원문은 그대로예요. 다음 체크포인트나 퀵세이브로 이 구간이 저장되면 이 기록이 사라져요.</li></ul></details>`;
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
    if (b === 'rec') { const r = mem.records.find(x => x.id === a); if (r) { r.ko = ko; normalizeRecordNames(mem); } return; }
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
        // v0.6.39: the view language stays whatever the user chose last (🌐 원문 during the request wins).
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

async function commitEdit(mutate, { undoable = false } = {}) {
    if (!hasChat()) return false;
    return transact(() => {
        const st = ensureState();
        const before = st.mem, next = clone(st.mem);
        if (mutate(next) === false) return false;
        normalizeRecordNames(next);
        refreshProvisionalOutlines(next);
        st.mem = next; pushHistory(st, before, next, { kind: 'edit' });
    }, { undoable, replay: true });
}
// v0.6.55: what ⏪ would take back, in words.
const UNDO_KIND = { checkpoint: '체크포인트 저장', quicksave: '퀵세이브', sceneclear: '기록하고 장면 닫기', sceneclose: '장면 닫기', supplement: '루팅 보충 저장', reset: '리셋', load: '세이브 불러오기' };
function undoLabel(st) {
    const info = st?.undoInfo;
    if (!info || !UNDO_KIND[info.kind]) return '마지막 작업';
    const runs = info.run ? (st.history || []).filter(h => h.run === info.run && h.kind === 'summary') : [];
    const range = runs.length ? ` #${Math.min(...runs.map(h => h.from))}–#${Math.max(...runs.map(h => h.to))}` : st.lastRecord?.run && st.lastRecord.run === info.run ? ` #${st.lastRecord.from}–#${st.lastRecord.to}` : '';
    return UNDO_KIND[info.kind] + range;
}
async function undo() {
    const st = state();
    if (ui.run) { toastr.info('저장이 끝난 뒤 눌러 주세요.', 'SavePoint'); return; }
    if (!st?.undo) { toastr.info('되돌릴 작업이 없어요. ⏪ 리와인드는 마지막 저장·리셋·세이브 불러오기를 되돌려요.', 'SavePoint'); return; }
    const what = undoLabel(st), edits = st.undoInfo?.edits || 0;
    if (!(await confirmBox(`⏪ 리와인드: ${what} 전으로 되돌릴까요?${edits ? ` 그 뒤에 한 편집 ${edits}개도 함께 되돌아가요.` : ''}`))) return;
    if (state() !== st || ui.run || !st.undo) return;
    const restored = { ...clone(st.undo), undo: null, undoInfo: null };
    restored.lootQueue = restoreLostLoot(st.lootQueue, st.mem, restored.mem, { room: roomKey(), hashes: st.hashes, fallback: st.undo.lootQueue });
    await transact(() => { ctx().chatMetadata[MODULE] = restored; }, { undoable: false });
    if (!reconcile()) { render(); return; }
    toastr.info(`⏪ 리와인드: ${what} 전으로 돌아갔어요.`);
}
async function clearRoom() {
    const st = state();
    if (!st || !(await confirmBox('리셋: 이 방의 기억을 모두 지울까요? 세이브 슬롯은 남아요. (⏪ 리와인드로 되돌릴 수 있어요)'))) return;
    await transact(() => { ctx().chatMetadata[MODULE] = freshState({ autoMark: chat().length - 1, lootQueue: clone(st.lootQueue || []) }); }, { undoable: true, undoKind: 'reset' });
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
    // A slot kept in settings after a failed server write is the newer copy of the same id
    // (a QUICK, or an overwritten FILE): show only that one, so every card acts on what it shows.
    const local = Object.values(localSaves()).map(r => ({ ...r, local: true }));
    const mine = new Set(local.map(r => r.id));
    return [...listed.filter(e => !mine.has(e.id)), ...local].sort((a, b) => b.updated - a.updated);
}
function findSave(id) { return listSaves().find(x => x.id === id) || null; }
async function readSave(entry) {
    if (entry.local) return localSaves()[entry.id];
    return vault.read(entry);
}
// v0.6.31: the last character message travels with a save, so a new room can start from it.
// "recorded" says whether that exact message was already in memory when the save was made; only
// then may a new room skip collecting it again.
function lastReplyOf(st) {
    if (!st || roomKey() !== st.roomKey) return null;
    const list = chat();
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (!eligible(m) || m.is_user) continue;   // eligible keeps our own hidden messages
        return { index: i, name: speaker(m), text: String(m.mes || ''),
            recorded: i <= st.lastIndex && st.hashes?.[i] === fingerprint(m),
            after: list.length - 1 - i, pending: Math.max(0, list.length - 1 - st.lastIndex) };
    }
    return null;
}
function saveRecord(st, name, id = newId(), auto = false, { quick = false } = {}) {
    const ci = charInfo();
    const prev = findSave(id);
    const reply = lastReplyOf(st);
    return {
        id, name, auto, ...(quick ? { quick: true } : {}), ...(reply ? { lastReply: reply } : {}), room: st.roomKey, roomHash: roomHash(st.roomKey), char: ci?.name || '', created: prev?.created || Date.now(), updated: Date.now(),
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
// 📦 Items the user boxed that the story used again (box mode "notify"). Each return is announced
// once, after the save that recorded it; the notice stays on the card and in the status line.
const returnNotices = st => (st?.mem?.records || []).filter(r => r.type === 'item' && r.stored?.by === 'user' && r.returnNotice);
// Quests a save found, finished or failed (compared with the memory before it).
function questNews(before, after) {
    const prev = new Map((before?.records || []).filter(r => r.type === 'quest').map(r => [r.id, r]));
    let found = 0, added = 0, done = 0, failed = 0;
    for (const q of after.records) {
        if (q.type !== 'quest' || q.track === 'declined') continue;
        const p = prev.get(q.id);
        if (!p) { if (q.track === 'pending') found++; else added++; continue; }
        // v0.6.40: an untracked one whose terms or deadline really changed is found again.
        if (q.track === 'pending' && p.track !== 'pending') found++;
        if (p.status === 'open' && q.status === 'done') done++;
        if (p.status === 'open' && q.status === 'failed') failed++;
    }
    const parts = [found ? `❗ 발견한 퀘스트 ${found}` : '', added ? `❗ 새 퀘스트 ${added}` : '', done ? `✔ 완료 ${done}` : '', failed ? `✖ 실패 ${failed}` : ''].filter(Boolean);
    return { found, added, done, failed, text: parts.join(' · ') };
}
function announceReturns(st) {
    if (!st || roomKey() !== st.roomKey) return;
    const told = new Set(st.returnTold || []);
    const fresh = returnNotices(st).filter(r => !told.has(`${r.id}:${r.returnNotice.at}`));
    if (!fresh.length) return;
    toastr.info(`📦 보관함 물건 ${fresh.length}개가 이야기에서 다시 쓰였어요: ${fresh.map(r => entityName(st.mem, r.entity) || '?').join(', ')}. 인벤토리 보관함에서 꺼낼지 정해 주세요.`, 'SavePoint', { timeOut: 9000 });
    st.returnTold = [...told, ...fresh.map(r => `${r.id}:${r.returnNotice.at}`)].slice(-200);
    persistSoon();
}
// QUICK: one per room, replaced only after a manual quicksave or scene clear finished completely.
async function quickSave(st) {
    if (!st || !hasMemory(st.mem) || roomKey() !== st.roomKey) return null;
    const res = await storeSave(saveRecord(st, `퀵세이브 · ${charInfo()?.name || ''}`, quickId(roomHash(st.roomKey)), false, { quick: true }));
    if (res.local) toastr.warning(`기록 완료 · QUICK 백업 실패 (설정에만 보관): ${res.error?.message || ''}`, 'SavePoint');
    render();
    return res;
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
    if (!st || !old || old.auto || old.quick || !hasMemory(st.mem)) return;
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
    // Everything below belongs to the room the load was started in. Each wait (file read, questions)
    // can outlast a room change; then nothing is changed anywhere.
    const key = roomKey(), epoch = roomEpoch;
    const here = () => roomKey() === key && roomEpoch === epoch;
    const moved = () => { toastr.info('불러오는 동안 채팅방이 바뀌어서 아무것도 바꾸지 않았어요.', 'SavePoint'); };
    let mem, sourceRoom, reply = null;
    try {
        const body = await readSave(save);
        mem = cleanMem(body?.mem);
        sourceRoom = typeof body?.room === 'string' ? body.room : typeof save.room === 'string' ? save.room : null;
        reply = validReply(body?.lastReply);
    } catch (e) { reportError(e); return; }
    if (!here()) return moved();
    const cur = state();
    // A new room can start from the save's last character message (see carryPlan).
    const plan = sourceRoom !== key ? carryPlan(reply) : null;
    const replaces = cur && hasMemory(cur.mem) ? ' 이 방의 지금 기억은 이 세이브로 바뀌어요(⏪ 리와인드 가능).' : '';
    if (plan?.kind === 'insert') {
        const warn = reply.recorded && !reply.after ? '' : `\n\n⚠ ${carryGap(reply)} 이전 방에서 퀵세이브한 뒤 QUICK으로 불러오면 빠지는 내용이 없어요. 그대로 진행하면 이 메시지는 새로 기록해요.`;
        plan.use = await confirmBox(`저장 당시 마지막 캐릭터 메시지(이전 방 #${reply.index})로 이 방을 시작할까요?\n${chat().length ? '첫 인사말을 그 메시지로 바꿔요.' : '그 메시지를 첫 메시지로 넣어요.'}${replaces}${warn}`);
        if (!here()) return moved();
        // "No" is not yet "memory only": ask once more so the whole load can still be cancelled.
        if (!plan.use && !(await confirmBox(`메시지는 그대로 두고 기억만 불러올까요?${replaces}\n아니요를 누르면 아무것도 바꾸지 않아요.`))) return;
    } else if (cur && hasMemory(cur.mem) && !(await confirmBox('이 방의 지금 기억을 이 세이브 슬롯으로 바꿀까요? (⏪ 리와인드로 되돌릴 수 있어요)'))) return;
    if (!here()) return moved();
    const insert = plan?.kind === 'insert' && plan.use;
    let undoMessage = null, st = null, exact = false, carried = false;
    // The edited-chat mark is put back too if the load is undone (it must not outlive a cancelled load).
    const meta0 = ctx().chatMetadata, hadTainted = Object.hasOwn(meta0, 'tainted'), oldTainted = meta0.tainted;
    const prevModule = meta0[MODULE] === undefined ? undefined : clone(meta0[MODULE]);
    const undoTainted = () => { const m = ctx().chatMetadata; if (hadTainted) m.tainted = oldTainted; else delete m.tainted; };
    // The new #0, the room's memory and the chat's "edited" mark are written by the same chat-file save,
    // so they are kept together or dropped together.
    try {
        const ok = await transact(() => {
            if (!here()) return false;
            if (insert) { undoMessage = putCarried(reply); ctx().chatMetadata.tainted = true; }
            st = freshState({ mem, lootQueue: clone(cur?.lootQueue || []), linkedSave: save.auto || save.quick ? null : id, autoMark: chat().length - 1 });
            const p = save.pos;
            if (p && Number.isInteger(p.lastIndex) && p.lastIndex >= 0 && p.lastIndex < chat().length) {
                const h = hashesTo(p.lastIndex);
                if (digest(h) === p.digest) { exact = true; st.lastIndex = p.lastIndex; st.hashes = h; st.floor = p.lastIndex; }
            }
            if (!exact) st.mem = detachMem(mem, sourceRoom);
            // #0 is the carried reply: when it was already in memory, the new room starts collecting at #1.
            carried = !exact && (plan?.kind === 'match' || insert) && carryMatches(reply);
            if (carried) {
                st.carry = { room: sourceRoom, index: reply.index, recorded: reply.recorded, at: Date.now() };
                if (reply.recorded) { st.lastIndex = 0; st.hashes = hashesTo(0); st.floor = 0; }
            }
            if (cur) st.lootQueue = restoreLostLoot(cur.lootQueue, cur.mem, st.mem, { room: key, hashes: cur.hashes, fallback: cur.undo?.lootQueue });
            ctx().chatMetadata[MODULE] = st;
        }, { undoable: true, undoKind: 'load' });
        if (ok === false) return moved();
    } catch (e) {
        if (undoMessage) { undoMessage(); undoTainted(); if (here()) await showCarried(); }
        reportError(e); return;
    }
    // SillyTavern's save handles most server errors itself and returns normally, so a finished call
    // does not prove the file changed. The new #0 is the one change that must not exist only in the
    // page: read the saved chat back and undo everything when the file does not have it.
    let verified = null;
    if (insert && here()) {
        verified = await savedChatHas(reply.text, st.rev);
        if (verified === false && here()) {
            clearTimeout(autosaveTimer); undoMessage(); undoTainted();
            if (prevModule === undefined) delete ctx().chatMetadata[MODULE]; else ctx().chatMetadata[MODULE] = prevModule;
            syncHide(); refreshInjection(); await showCarried(); render();
            toastr.error('채팅 파일에 저장되지 않아서 이어하기를 되돌렸어요. 첫 메시지와 기억은 불러오기 전 그대로예요. 잠시 뒤 다시 시도해 주세요.', 'SavePoint', { timeOut: 12000 });
            return;
        }
    }
    if (insert && here()) await showCarried();
    if (insert && verified === null) toastr.info('채팅 파일에 저장됐는지 확인하지 못했어요. 새로고침한 뒤 첫 메시지가 그대로인지 봐 주세요.', 'SavePoint');
    toastr.success(exact ? `저장 당시 위치(#${st.lastIndex})로 돌아갔어요. 그 뒤 메시지는 미저장이에요.`
        : carried && reply.recorded ? `이전 방 #${reply.index}에서 이어서 시작해요. #0은 이미 기록된 메시지라 새 기록은 #1부터예요.`
        : carried ? `이전 방 #${reply.index} 메시지로 시작했어요. 이 메시지는 아직 기록 전이라 다음 세이브 때 기록해요.`
        : `불러왔어요. 원문이 저장 당시와 달라서 기억만 가져왔고, 이 방의 메시지 ${pendingCount()}개는 미저장이에요.`, 'SavePoint');
}
const validReply = r => (r && typeof r === 'object' && !Array.isArray(r) && Number.isInteger(r.index) && typeof r.text === 'string' && r.text.trim()
    ? { index: r.index, name: String(r.name || ''), text: r.text, recorded: r.recorded === true, after: Number(r.after) || 0, pending: Number(r.pending) || 0 } : null);
const sameText = (a, b) => String(a || '').replace(/\r\n?/g, '\n').trim() === String(b || '').replace(/\r\n?/g, '\n').trim();
// What a load into another room can do with the carried reply:
// 'match'  — #0 here is a character message with exactly that text (the user pasted it);
// 'insert' — the room is empty or holds only the greeting, so the reply can become #0;
// null     — the room already has its own story; only the memory is loaded.
function carryPlan(reply) {
    if (!reply) return null;
    const list = chat(), first = list[0];
    if (first && !first.is_user && !first.is_system && sameText(first.mes, reply.text)) return { kind: 'match' };
    if (!list.length || (list.length === 1 && first && !first.is_user)) return { kind: 'insert' };
    return null;
}
function carryMatches(reply) { const m = chat()[0]; return !!m && !m.is_user && !m.is_system && sameText(m.mes, reply.text); }
function carryGap(reply) {
    if (!reply.recorded) return `이 세이브는 마지막 메시지 ${reply.pending}개가 아직 기록되지 않은 상태예요.`;
    return `이 세이브의 마지막 캐릭터 메시지 뒤에 메시지 ${reply.after}개가 더 있었는데, 그건 가져가지 않아요.`;
}
// Put the reply in as #0 (in the page only; the caller's chat-file save writes it): an empty room
// gets a new message; a greeting-only room has its greeting replaced, including everything that
// belonged to the greeting's text (alternative greetings, their swipe info, images, translations).
// Returns a function that puts the room back exactly as it was if that save fails.
function putCarried(reply) {
    const list = chat();
    const fresh = () => ({ send_date: Date.now(), extra: {} });
    if (!list.length) {
        list.push({ name: reply.name || charInfo()?.name || '', is_user: false, is_system: false, send_date: Date.now(), mes: reply.text, extra: {}, swipe_id: 0, swipes: [reply.text], swipe_info: [fresh()] });
        return () => { list.splice(0, 1); };
    }
    const m = list[0], before = clone(m);
    m.mes = reply.text; m.swipes = [reply.text]; m.swipe_id = 0; m.swipe_info = [fresh()];
    // Only our own visibility marks are kept; any content-bound data of the old greeting goes.
    const keep = Object.fromEntries([HIDE_KEY, VISIBLE_KEY, HELD_KEY, KEEP_KEY].filter(k => m.extra && Object.hasOwn(m.extra, k)).map(k => [k, m.extra[k]]));
    m.extra = keep;
    return () => { for (const k of Object.keys(m)) delete m[k]; Object.assign(m, before); };
}
// Read the room's chat file back from the server. true/false: whether the file has this #0 text and
// this memory revision; null: it could not be checked (group chat, no server route, network error).
async function savedChatHas(text, rev) {
    try {
        const c = ctx(), file = c.getCurrentChatId?.(), ch = c.characters?.[c.characterId];
        if (!file || c.groupId || !ch) return null;
        const r = await fetch('/api/chats/get', { method: 'POST', headers: serverHeaders(), body: JSON.stringify({ ch_name: ch.name, file_name: file, avatar_url: ch.avatar }) });
        if (!r.ok) return null;
        const data = await r.json();
        if (!Array.isArray(data) || !data.length) return null;
        const head = data[0]?.chat_metadata ? data[0] : null;
        const first = (head ? data.slice(1) : data)[0];
        return !!first && sameText(first.mes, text) && (!head || head.chat_metadata?.[MODULE]?.rev === rev);
    } catch { return null; }
}
// Show the new #0 after the memory is in place: redraw that message when SillyTavern offers it,
// otherwise reload the chat view (which reads the saved chat and metadata back).
async function showCarried() {
    const c = ctx();
    if (typeof c.updateMessageBlock === 'function' && typeof document !== 'undefined' && document.querySelector('#chat .mes[mesid="0"]')) c.updateMessageBlock(0, chat()[0]);
    else await Promise.resolve(c.reloadCurrentChat?.()).catch(() => {});
}
async function renameSave(id) {
    const save = findSave(id);
    if (!save) return;
    // AUTO and QUICK cards: "사본 저장" keeps the original and makes a named FILE slot from it.
    const copy = save.auto || save.quick;
    const name = await askText(copy ? '다른 이름으로 저장' : '새 이름', copy ? `${save.char || 'Save'} · ${save.stats?.lastTitle || ''}`.slice(0, 60) : save.name);
    if (!name) return;
    try {
        if (save.local) {
            const r = localSaves()[id];
            if (copy) { const nid = newId(); localSaves()[nid] = { ...clone(r), id: nid, name, auto: false, quick: false, created: Date.now(), updated: Date.now() }; delete localSaves()[nid].roomHash; }
            else r.name = name;
            saveSettings(); render();
        } else await vault.rename(id, name, newId());
        if (copy) toastr.success(`"${name}" FILE 슬롯으로 저장했어요. 원래 카드는 그대로예요.`);
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
            const res = await storeSave({ ...rest, id: newId(), auto: false, quick: false, mem, name: String(raw.name || '가져온 세이브'), updated: Date.now(), created: raw.created || Date.now(), stats: memStats(mem), version: raw.version || VERSION });
            n++; if (res.local) local++;
        } catch (e) { console.warn('[SavePoint] import skipped', e); }
    }
    render();
    if (!n) toastr.error('가져올 수 있는 세이브가 없었어요.');
    else toastr[local ? 'warning' : 'success'](`세이브 슬롯 ${n}개를 가져왔어요.${local ? ` (${local}개는 서버 백업 실패로 설정에만 저장)` : ''}`);
}
const FOUND_SOURCE = { index: '목록', prev: '이전 목록', room: '이 방 오토세이브·QUICK 이름' };
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

// ───────── 🔖 원문 유지 (v0.6.52) ─────────
// A message the user marks in its "…" menu is never hidden by SavePoint, in either hide mode; it is
// still recorded as usual. The mark sits on the message (and on every swipe of it, so a swipe keeps
// it), and is written with the chat file; if that write fails, the mark and the hide state go back.

function setKeep(m, on) {
    m.extra ||= {};
    if (on) m.extra[KEEP_KEY] = 1; else delete m.extra[KEEP_KEY];
    for (const x of Array.isArray(m.swipe_info) ? m.swipe_info : []) {
        if (!x || typeof x !== 'object') continue;
        if (on) { x.extra ||= {}; x.extra[KEEP_KEY] = 1; } else if (x.extra) delete x.extra[KEEP_KEY];
    }
}
const keptCount = () => chat().filter(kept).length;
async function toggleKeep(index) {
    if (!hasChat() || !settings().enabled) return;
    const m = chat()[index];
    if (!m) return;
    const on = !kept(m);
    const swipes = (Array.isArray(m.swipe_info) ? m.swipe_info : []).map(x => x && typeof x === 'object'
        ? { x, hadExtra: Object.hasOwn(x, 'extra'), had: !!x.extra && Object.hasOwn(x.extra, KEEP_KEY), v: x.extra?.[KEEP_KEY] } : null);
    try {
        await transact(() => { setKeep(m, on); }, { undoable: false, autosave: false, snapshot: true });
    } catch (e) {
        // The message's own flags came back with the save's snapshot; its swipes are put back here.
        for (const w of swipes) {
            if (!w) continue;
            if (!w.hadExtra) delete w.x.extra;
            else if (w.had) w.x.extra[KEEP_KEY] = w.v; else delete w.x.extra?.[KEEP_KEY];
        }
        paintKeep(); throw e;
    }
    paintKeep();
    toastr.info(on ? '🔖 원문 유지: 이 메시지는 하이드하지 않아요. 기록은 평소처럼 해요.'
        : hideModeOf(settings()) === 'manual' ? '🔖 원문 유지를 껐어요. 다음에 👻 하이드를 누를 때 함께 숨겨요.' : '🔖 원문 유지를 껐어요.', 'SavePoint');
}
// A swipe (or a new reply in place) brings that swipe's own extra; a kept message gets its mark back.
function repairKeep(index) {
    const m = chat()[Number(index)];
    if (!m || kept(m) || !(Array.isArray(m.swipe_info) && m.swipe_info.some(x => x?.extra?.[KEEP_KEY]))) return false;
    setKeep(m, true); saveChatSoon(); return true;
}
const KEEP_BUTTON = '<div class="mes_button sp-keep-btn interactable" role="button" tabindex="0" title="🔖 원문 유지 (하이드하지 않기)">🔖</div>';
// The "…" menu button (on the message template for new messages, and on those already shown) and
// the small 🔖 beside the name of each kept message.
function paintKeep() {
    if (typeof document === 'undefined' || !globalThis.$) return;
    const on = settings().enabled;
    for (const host of [...document.querySelectorAll('#message_template .extraMesButtons, #chat .mes .extraMesButtons')]) {
        const b = host.querySelector('.sp-keep-btn');
        if (!on) { b?.remove(); continue; }
        if (!b) host.insertAdjacentHTML('afterbegin', KEEP_BUTTON);
    }
    const list = chat();
    for (const el of [...document.querySelectorAll('#chat .mes[mesid]')]) {
        const m = list[Number(el.getAttribute('mesid'))], k = on && kept(m);
        const b = el.querySelector('.sp-keep-btn');
        if (b) { b.classList.toggle('sp-on', k); b.title = k ? '🔖 원문 유지 끄기' : '🔖 원문 유지 (하이드하지 않기)'; }
        let mark = el.querySelector('.sp-keep-mark');
        if (k && !mark) {
            const name = el.querySelector('.name_text') || el.querySelector('.ch_name');
            mark = document.createElement('span'); mark.className = 'sp-keep-mark'; mark.title = '원문 유지 · SavePoint가 하이드하지 않아요'; mark.textContent = '🔖';
            if (name) name.insertAdjacentElement('afterend', mark); else el.prepend(mark);
        } else if (!k && mark) mark.remove();
    }
}
let keepPaintTimer = null;
function paintKeepSoon() { clearTimeout(keepPaintTimer); keepPaintTimer = setTimeout(paintKeep, 30); }

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
    // Without SillyTavern's popup (an old version or a bare page) the browser's own question is used.
    if (typeof c.callGenericPopup !== 'function' || !c.POPUP_TYPE) return typeof globalThis.confirm === 'function' ? !!globalThis.confirm(text) : true;
    return !!(await c.callGenericPopup(esc(text), c.POPUP_TYPE.CONFIRM));
}
const fmtDate = ts => { try { return new Date(ts).toLocaleString(); } catch { return ''; } };
const showKo = () => !!settings().showKo;
function langButton(st, busy) {
    // v0.6.38: in Korean view the main button always goes back to the original; filling missing
    // translations is a small separate button next to it (a failed or partial translation used to
    // leave only "번역 N", with no way back to the original inside the window).
    // v0.6.55: no "+N"; the button is lit while the Korean view is on. Missing translations are filled
    // when the Korean view is turned on (and from the 🧿 / settings as before).
    const missing = showKo() && st && hasMemory(st.mem) ? translationTargets(st.mem).length : 0;
    const main = showKo()
        ? btn('lang', '', '🌐 원문', `영어 원문 보기로 바꿔요${missing ? ` · 한국어 보기가 없는 항목 ${missing}개는 원문으로 보여요` : ''}`, 'sp-langbtn sp-on')
        : btn('lang', '', '🌐 번역', '한국어 보기로 바꿔요 (번역이 없는 항목은 번역해요)', 'sp-langbtn' + (busy ? ' sp-disabled' : ''));
    return `<span class="sp-langwrap">${main}</span>`;
}
const T = (en, ko) => (showKo() && ko ? ko : en);

// ───────── UI ─────────

// v0.6.38: each room keeps the tab it was left on (in this page session). The "first tab" setting
// applies only to a room seen for the first time; render() records the tab of the room on screen.
function restoreRoomTab() {
    if (!hasChat()) return;
    ui.roomTabs ||= new Map();
    ui.tab = ui.roomTabs.get(roomKey()) || (settings().firstTab in FIRST_TABS ? settings().firstTab : 'main');
    ui.roomTabs.set(roomKey(), ui.tab); ui.tabRoom = roomKey();
}
function openWindow() {
    if (!$('#sp_overlay').length) $('body').append('<div id="sp_overlay" class="sp-overlay"><div class="sp-window"></div></div>');
    restoreRoomTab();
    ui.open = true;
    $('#sp_overlay').css('display', 'flex');
    render(true);
}
function closeWindow() { tabResizeObserver?.disconnect(); ui.open = false; ui.edit = null; ui.revealFailure = false; $('#sp_overlay').hide(); updateSaveBanner(); }

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
    const full = msgText(message), shown = viewText(message);
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
    const full = i => msgText(chat()[i]);
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
// What happens to a queued item next, by its state. Automatic retry is promised only where it happens.
function lootNextStep(st, item, changed) {
    if (!item.error && !changed) return '';
    if (item.room !== roomKey()) return '<div class="sp-dim">다른 방에서 담은 항목이라 이 방에서는 반영하지 않아요. 필요 없으면 삭제해 주세요.</div>';
    if (changed) return '<div class="sp-dim">원문이 담을 때와 달라져서 자동으로 반영하지 않아요. 바뀐 원문을 확인하고 💎로 다시 담은 뒤 이 항목을 삭제해 주세요.</div>';
    if (item.msg > st.lastIndex) return `<div class="sp-dim">아직 기록되지 않은 메시지예요. 다음 퀵세이브·체크포인트 때 함께 보내요. ${btn('run', '', '⏺ 퀵세이브로 반영', '', ui.run ? 'sp-disabled' : '')}</div>`;
    if (!lootTarget(st.mem, item.msg)) return '<div class="sp-dim">이 메시지가 들어간 장면이 없어서 반영할 수 없어요. 삭제해 주세요.</div>';
    return `<div class="sp-dim">다음 세이브 때 저널 보충으로 다시 시도해요. 지금 바로 하려면 ${btn('loot-retry', item.id, '↻ 다시 반영', '이 항목만 해당 장면 저널에 보충해요 (현재 상태는 바꾸지 않아요)', ui.run ? 'sp-disabled' : '')}</div>`;
}
// One failed item, on demand: journal supplement only, never the current state. Removed from the
// queue only after the memory is saved; the run blocks a second click.
async function retryLoot(id) {
    if (ui.run) { toastr.info('이미 기록 중이에요.'); return; }
    const st = state(); if (!st) return;
    const item = (st.lootQueue || []).find(x => x.id === id); if (!item) return;
    if (!reconcile()) { render(); toastr.warning('예전 원문이 바뀌었어요. 창 위쪽 안내에서 먼저 처리해 주세요.'); return; }
    if (lootStatus(item, roomKey(), chat(), fingerprint, viewHash) || item.msg > st.lastIndex || !lootTarget(st.mem, item.msg)) { render(true); return; }
    if (!settings().profileId && mainBusy()) { toastr.info('본편 생성이 끝난 뒤 눌러 주세요.'); return; }
    const run = newRun(st, chat().length - 1, 'other');
    let result = { saved: 0, failed: 0 };
    try {
        ui.progress = '루팅한 기억 다시 반영'; render();
        result = await supplementLoot(run, [item], checkpoint(st));
        if (result.saved && !result.failed) toastr.success('루팅한 구절을 저널에 반영했어요.', 'SavePoint');
        else toastr.warning(`⚠ 다시 반영하지 못했어요.${lootFailNote(state() || st)}`, 'SavePoint', { timeOut: 10000 });
    } catch (e) {
        if (!(e instanceof Cancelled)) { console.error('[SavePoint]', e); toastr.error(errorText(e), 'SavePoint'); }
    } finally {
        endRun(run);
        if (result.saved && run.key === roomKey()) autosave(state());
    }
}
function lootFailNote(st) {
    const first = (st.lootQueue || []).find(x => x.error?.startsWith('반영 실패'));
    return first ? ` (${first.error.replace(/^반영 실패 · /, '')})` : '';
}
function sceneTimeGaps(s) {
    return s.segs.filter(g => g.time).flatMap(g => [...(g.time.start?.certainty === 'unconfirmed' ? [{ g, edge: 'start' }] : []),
        ...(g.time.end?.certainty === 'unconfirmed' && g.time.start?.certainty !== 'unconfirmed' ? [{ g, edge: 'end' }] : [])]);
}
// ───────── 💠 메인 (STATUS) ─────────
// A screen-only summary of what is already saved: nothing is injected or collected from here.
// Everything is "as of the last record", which the first line says.
const firstSentenceKo = t => (String(t || '').match(/^.*?[.!?。](\s|$)/)?.[0] || String(t || '')).trim();
// v0.6.53: what one save run changed, for the result banner and the NEW badges of 💠 메인 (the same
// numbers in both). From the run's history, first "before" and last "after" per record, so a record
// changed in several parts of one run counts once, and one changed and changed back not at all.
// 🎒 = items changed (added, updated, gone, deleted), one per item; 👥 = people whose relation or
// condition changed, plus new people, one per person; quests = added, or whose status or tracking
// changed. NEW stays until the next save that records something.
// v0.6.54: what a record says, without bookkeeping (evidence, order, translation, when it was boxed),
// so an update that repeats the same thing, or a change undone in the same run, is not NEW.
const BOOKKEEPING = new Set(['src', 'msgs', 'seq', 'ko', 'koText', 'koOutline', 'oldEvidence', 'storedUpdated', 'questEvents', 'returnNotice']);
function contentOf(r) {
    if (!r || typeof r !== 'object') return r ?? null;
    const out = {};
    for (const k of Object.keys(r).sort()) {
        if (BOOKKEEPING.has(k)) continue;
        out[k] = k === 'stored' && r.stored ? { by: r.stored.by, reason: r.stored.reason ?? null, lock: !!r.stored.lock } : r[k];
    }
    return out;
}
function runChanges(st, runId = st?.lastRecord?.run) {
    if (!st || !runId) return null;
    const runs = (st.history || []).filter(h => h.run === runId);
    if (!runs.length) return null;
    const first = new Map(), last = new Map();
    for (const h of runs) for (const c of h.diff.changes) { const k = `${c.kind}:${c.id}`; if (!first.has(k)) first.set(k, c.before); last.set(k, c.after); }
    const items = new Set(), people = new Set(), records = new Set(), quests = new Set();
    for (const [k, after] of last) {
        const before = first.get(k), kind = k.split(':')[0];
        if (JSON.stringify(contentOf(before)) === JSON.stringify(contentOf(after))) continue;
        if (kind === 'entities') { if (!before && after?.type === 'person') people.add(after.id); continue; }
        if (kind !== 'records') continue;
        const r = after || before;
        if (r.type === 'item') { items.add(r.entity || r.id); if (after) records.add(after.id); }
        else if (r.type === 'party') { people.add(r.entity || r.id); if (after) records.add(after.id); }
        else if (r.type === 'quest' && after && (!before || before.status !== after.status || before.track !== after.track)) quests.add(after.id);
    }
    return { items, people, records, quests };
}
// The second line of a save's result: `NEW 🎒 2 · 👥 1 · ❗ 수락 대기 1 · 완료 1`; '' when nothing changed.
function saveNews(st, runId, qn) {
    const c = st?.lastRecord?.run === runId ? runChanges(st, runId) : null;
    const parts = [];
    if (c?.items.size) parts.push(`🎒 ${c.items.size}`);
    if (c?.people.size) parts.push(`👥 ${c.people.size}`);
    const q = qn ? [qn.found && `수락 대기 ${qn.found}`, qn.added && `자동 수락 ${qn.added}`, qn.done && `완료 ${qn.done}`, qn.failed && `실패 ${qn.failed}`].filter(Boolean) : [];
    if (q.length) parts.push(`❗ ${q.join(' · ')}`);
    return parts.length ? `NEW ${parts.join(' · ')}` : '';
}
const newBadge = '<span class="sp-new" title="마지막 저장에서 새로 생기거나 바뀜">NEW</span>';
function recentChanges(st) {
    const lr = st.lastRecord;
    if (!lr?.run) return null;
    const runs = (st.history || []).filter(h => h.run === lr.run);
    if (!runs.length) return null;
    const first = new Map(), last = new Map();
    for (const h of runs) for (const c of h.diff.changes) { const k = `${c.kind}:${c.id}`; if (!first.has(k)) first.set(k, c.before); last.set(k, c.after); }
    const mem = st.mem, lines = [];
    const rec = r => `${r.type === 'quest' ? (KIND_KO[r.kind] || '퀘스트') + ' ' : r.type === 'item' ? (entityName(mem, r.entity) || '아이템') + ': ' : r.type === 'party' ? (entityName(mem, r.entity) || '') + ' ' + (r.aspect === 'condition' ? '상태' : '관계') + ': ' : ''}${T(r.text, r.ko)}`;
    for (const [k, after] of last) {
        const before = first.get(k), kind = k.split(':')[0];
        if (kind === 'scenes') {
            if (!before && after) lines.push(['add', `새 장면 ${T(after.title, after.koTitle)}`]);
            else if (after) lines.push(['mod', `장면 이어 기록 ${T(after.title, after.koTitle)}`]);
        } else if (kind === 'entities') {
            if (!before && after?.type === 'person') lines.push(['add', `새 인물 ${after.name}`]);
        } else if (kind === 'records') {
            if (!before && after) lines.push(['add', rec(after)]);
            else if (before && !after) lines.push(['del', rec(before)]);
            else if (after?.type === 'item' && after.gone && !before.gone) lines.push(['del', `${entityName(mem, after.entity) || '아이템'} (${T(after.text, after.ko)} → 📦)`]);
            else if (after?.type === 'quest' && after.status !== before.status) lines.push([after.status === 'open' ? 'mod' : 'done', `${KIND_KO[after.kind] || '퀘스트'} ${after.status === 'done' ? '완료' : after.status === 'failed' ? '실패' : '다시 진행'}: ${T(after.text, after.ko)}`]);
            else if (after) lines.push(['mod', rec(after)]);
        }
    }
    return { lr, lines };
}
function mainHtml(st) {
    const mem = st.mem;
    // v0.6.53: NEW on what the last save added or changed (the same set as the result banner).
    const fresh = runChanges(st) || { items: new Set(), people: new Set(), records: new Set(), quests: new Set() };
    const pending = pendingCount();
    const time = storyTimeContext(mem, 'ko');
    const go = (tab, label) => `<button class="sp-st-more" data-act="tab" data-id="${tab}">${label} ›</button>`;
    const head = (title, tab, label, extra = '') => `<div class="sp-st-h"><span>${title}</span>${extra}${tab ? go(tab, label) : ''}</div>`;
    const basis = `<div class="sp-st-title">STATUS</div><div class="sp-st-basis">마지막 저장 기준 <b>#${st.lastIndex}</b>${time ? ` · 이야기 시간 ${esc(time)}` : ''}${pending ? ` · 미저장 <b>${pending}</b>개 — 그 뒤 대화는 아직 반영 전이에요` : ' · 미저장 없음'}</div>`;
    // Alerts: only what needs a decision.
    const queue = st.lootQueue || [];
    const returns = returnNotices(st);
    const found = foundQuests(mem);
    const alerts = [
        queue.length ? `<details class="sp-st-alert ${queue.some(x => x.error) ? 'warn' : ''}" data-group="main-queue" ${ui.savesOpen.get('main-queue') || ui.focus === 'main-queue' ? 'open' : ''}><summary>${queue.some(x => x.error) ? '<span class="sp-st-dot"></span>' : ''}<span class="grow"><b>⏳ 대기열 ${queue.length}</b> · 다음 세이브에 반영</span><span class="sp-dim">▾</span></summary>${queueHtml(st)}</details>` : '',
        found.length ? `<details class="sp-st-alert" data-group="main-quests" ${ui.savesOpen.get('main-quests') ? 'open' : ''}><summary><span class="grow"><b>❗ 발견한 퀘스트 ${found.length}</b> · 근거를 보고 수락·거절</span><span class="sp-dim">▾</span></summary><div class="sp-qcands">${found.map(q => questCandidate(st, q)).join('')}</div></details>` : '',
        ...returns.map(r => `<div class="sp-st-alert"><span>📦</span><span class="grow"><b>${esc(entityName(mem, r.entity) || '?')}</b> — ${esc(T(r.text, r.ko))}</span>${btn('item-unstore', r.id, '꺼내기')}${btn('item-keep', r.id, '그대로 두기')}</div>`),
    ].filter(Boolean);
    // Scene: the last recorded one.
    const sc = openScene(mem) || mem.scenes.at(-1);
    let scene = '';
    if (sc) {
        const no = mem.scenes.indexOf(sc) + 1, segs = sc.segs.filter(g => g.outline);
        const firstS = segs[0] ? firstSentenceKo(T(segs[0].outline, segs[0].koOutline)) : '';
        const lastS = segs.length > 1 ? firstSentenceKo(T(segs.at(-1).outline, segs.at(-1).koOutline)) : '';
        const short = [firstS, lastS && lastS !== firstS ? lastS : ''].filter(Boolean).join(' … ');
        const range = sceneTimeRange(sc, mem.timeAnchors, 'ko');
        scene = `<div class="sp-st-hero" data-act="tl-goto" data-id="${esc(`${sc.id}|${sc.segs.at(-1)?.id || ''}`)}" title="저널에서 보기"><div class="k">SCENE ${String(no).padStart(2, '0')} · ${sc.status === 'open' ? '진행 중' : '끝남'}</div>
            <div class="t">${esc(T(sc.title, sc.koTitle))}</div>
            <div class="m">${sc.where ? `<span>📍 ${esc(sc.where)}</span>` : ''}${range ? `<span>📅 ${esc(range)}</span>` : ''}</div>
            ${short ? `<div class="sp-st-out">${esc(short)}</div>` : ''}</div>`;
    }
    // Open threads, the most pressing first.
    const rank = q => { const d = dueStatus(mem, q); return d?.kind === 'past' ? 0 : d?.kind === 'today' ? 1 : d?.kind === 'left' ? 2 + (d.left || 0) / 1000 : 3; };
    const open = mem.records.filter(r => r.type === 'quest' && r.status === 'open' && !r.track).sort((a, b) => rank(a) - rank(b));
    const quests = open.length ? head(`❗ 진행 중 ${open.length}`, 'quests', '퀘스트') + open.slice(0, 5).map(q => {
        const d = dueStatus(mem, q), hot = d && ['past', 'today'].includes(d.kind);
        return `<div class="sp-st-q ${hot ? 'urgent' : ''}" data-act="tl-quest" data-id="${esc(q.id)}"><span class="kind">${KIND_KO[q.kind] || q.kind}</span>${fresh.quests.has(q.id) ? newBadge : ''}<span class="txt">${roleText(mem, q) ? `<b class="sp-role">${esc(roleText(mem, q))}</b> ` : ''}${esc(T(q.text, q.ko))}</span>${q.due ? `<span class="due ${hot ? 'hot' : ''}">${esc(formatDue(mem, q, 'ko'))}</span>` : ''}</div>`;
    }).join('') + (open.length > 5 ? `<div class="sp-st-sub">${open.length - 5}개 더</div>` : '') : '';
    // People in the last recorded scene (and the open one), excluding nobody: standby is about injection.
    const present = [...new Set([...(openScene(mem)?.who || []), ...(sc?.who || [])])].map(id => mem.entities.find(e => e.id === id)).filter(e => e?.type === 'person');
    const newest = (id, aspect) => newestParty(mem, id, aspect);
    const people = present.length ? head('👥 현재 파티', 'party', '파티') + `<div class="sp-st-grid">${present.map(e => {
        const c = newest(e.id, 'condition'), r = newest(e.id, 'relation');
        const more = mem.records.filter(x => x.type === 'party' && x.entity === e.id).length - (c ? 1 : 0) - (r ? 1 : 0);
        // v0.6.39: state and relation are clamped; tapping the card shows them in full.
        const full = ui.savesOpen.get('stp:' + e.id);
        return `<div class="sp-st-p ${full ? 'full' : ''}" data-act="st-p" data-id="${esc(e.id)}" title="${full ? '접기' : '눌러서 전부 보기'}"><div class="n"><span class="av">${esc((e.name || '?').slice(0, 1))}</span>${esc(e.name)}${fresh.people.has(e.id) ? newBadge : ''}${e.standby ? ` <span class="sp-badge">${e.standby === 'standby' ? '대기' : '주입 제외'}</span>` : ''}</div>
            ${c ? `<div class="c">${esc(T(c.text, c.ko))}</div>` : ''}${r ? `<div class="r">${esc(T(r.text, r.ko))}</div>` : ''}${more > 0 ? `<div class="sp-st-sub">+${more}</div>` : ''}${!c && !r ? '<div class="r">기록된 변화 없음</div>' : ''}</div>`;
    }).join('')}</div>` + (() => { const b = mem.entities.filter(e => e.type === 'person' && e.standby); return b.length ? `<div class="sp-st-sub">대기 ${b.filter(e => e.standby === 'standby').length}명 · 주입 제외 ${b.filter(e => e.standby === 'exclude').length}명</div>` : ''; })() : '';
    // Items held by the people above, and items left at the scene's place.
    const live = mem.records.filter(r => r.type === 'item' && !r.stored);
    const rows = present.map(e => [e.name, live.filter(r => r.holder === e.id)]).filter(([, l]) => l.length);
    const where = String(sc?.where || '').toLowerCase();
    const places = mem.entities.filter(e => e.type === 'place' && where && [e.name, ...(e.aliases || [])].some(n => n && where.includes(String(n).toLowerCase())));
    rows.push(...places.map(p => [`📍 ${p.name}`, live.filter(r => r.holder === p.id)]).filter(([, l]) => l.length));
    // v0.6.39: one block per holder (name on top, one item per line with its state) so a long list
    // never runs into the next person's row.
    const items = rows.length ? head('🎒 아이템', 'items', '인벤토리') + `<div class="sp-st-items">${rows.map(([who, l]) => `<div class="grp"><div class="who">${esc(who)}<span class="cnt">${l.length}</span></div>${l.map(r => `<div class="it"><b>${esc(entityName(mem, r.entity) || '?')}</b>${fresh.records.has(r.id) ? newBadge : ''}${r.gone ? '<span class="sp-badge">사라짐</span>' : ''}<span class="st">${esc(T(r.text, r.ko))}</span></div>`).join('')}</div>`).join('')}</div>` : '';
    // What the last save changed, folded by default.
    const ch = recentChanges(st);
    const kindKo = { checkpoint: '체크포인트', quicksave: '퀵세이브', sceneclear: '기록하고 장면 닫기', supplement: '루팅 보충' };
    const changes = ch?.lines.length ? `<details class="sp-st-changes" data-group="main-changes" ${ui.savesOpen.get('main-changes') ? 'open' : ''}><summary class="sp-st-h"><span>🆕 최근 변화 · ${kindKo[ch.lr.kind] || '저장'} #${ch.lr.from}–#${ch.lr.to}${ch.lr.partial ? ' (일부 저장)' : ''} · ${ch.lines.length}개</span><span class="sp-dim">▾</span></summary>
        <div class="sp-st-log">${ch.lines.slice(0, 14).map(([k, t]) => `<div><i class="${k === 'add' ? 'a' : k === 'del' ? 'd' : 'm'}">${k === 'add' ? '+' : k === 'del' ? '−' : k === 'done' ? '✓' : '~'}</i>${esc(t)}</div>`).join('')}${ch.lines.length > 14 ? `<div class="sp-dim">${ch.lines.length - 14}개 더</div>` : ''}</div></details>` : '';
    const parts = [alerts.length ? `<div class="sp-st-alerts">${alerts.join('')}</div>` : '', scene, quests && `<div>${quests}</div>`, people && `<div>${people}</div>`, items && `<div>${items}</div>`, changes].filter(Boolean);
    return basis + (parts.length > 0 ? `<div class="sp-st">${parts.join('')}</div>` : '<div class="sp-empty">세이브하면 지금 장면, 진행 중인 일, 현재 파티와 아이템이 여기에 모여요.</div>');
}
function queueHtml(st) {
    const items = st.lootQueue || [];
    if (!items.length) return '<div class="sp-empty">⏳ 대기열이 비었어요.<br>채팅창의 💎로 담아 주세요. 구절을 드래그한 뒤 누르면 그 구절만 담겨요.</div>';
    return `<p class="sp-dim">다음 퀵세이브·체크포인트 때 반영해요. 선택한 내용은 기억 주입에 우선 반영해요.</p>` + items.map(item => {
        // A changed original blocks reflection; a re-translated on-screen text is only a warning.
        const blocked = lootStatus(item, roomKey(), chat(), fingerprint, viewHash), warned = lootWarning(item, chat(), viewHash), changed = blocked || warned;
        return `<div class="sp-card sp-queued"><div class="sp-row"><b>${item.room === roomKey() ? '' : '이전 방 '}#${item.msg}</b>${tools([btn('loot-delete', item.id, '🗑', '대기열에서 삭제', ui.run ? 'sp-disabled' : '')])}</div>
            ${changed ? `<div class="sp-warn">${esc(changed)}</div>` : ''}${item.error && item.error !== changed ? `<div class="sp-warn">⚠ ${esc(item.error)}${item.fails > 1 ? ` · ${item.fails}번째 실패` : ''}</div>` : ''}${lootNextStep(st, item, blocked)}
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
    if (!local.length) return '이전 방 기록';
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
            const people = ents('person').slice(1), multi = k => (v[k] || '').includes(',');
            body += select('by', '지킬 사람', [['', '(모름)'], ...(multi('by') ? [[v.by, '그대로 (여러 명)']] : []), ...people])
                + select('to', '받는 사람', [['', '(없음·서로·모름)'], ...(multi('to') ? [[v.to, '그대로 (여러 명)']] : []), ...people]);
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
            ${tools([btn('star', s.id, s.star ? '★' : '☆', '메인 사건 표시', s.star ? 'sp-on' : ''), btn('pin', s.id, '⚓', '항상 핵심 한 줄 주입', s.pin ? 'sp-on' : ''),
                btn('edit-scene', s.id, '✎', '제목·장소 편집'), btn('del-scene', s.id, '🗑', '삭제')])}</div>`;
        if (isEditing('scene', s.id)) return `<div class="sp-card sp-scene">${head}${editForm()}</div>`;
        const pointHtml = ({ g, p, j }) => isEditing('point', `${s.id}|${g.id}|${j}`) ? editForm()
            : `<li class="sp-pt sp-${p.kind} ${pointInjected(p) ? 'sp-inj' : 'sp-stored'} ${p.pin ? 'sp-point-pinned' : ''}">${btn('key-toggle', `${s.id}|${g.id}|${j}`, pointSymbol(p),
                p.pin ? '우선 주입 고정 · 누르면 고정 전 선택으로 돌아가요' : (pointInjected(p) ? '선택됨 · 누르면 선택 해제' : '선택 안 함 · 누르면 선택'), 'sp-key')}<span class="sp-pk" title="${p.kind === 'change' ? '상태 변화' : '기억할 순간'}">${p.kind === 'change' ? '◆' : '◇'}</span>
                <div class="sp-pt-t">${p.loot?.length ? `<details class="sp-point-detail" data-group="point:${g.id}:${j}" ${ui.savesOpen.get('point:' + g.id + ':' + j) ? 'open' : ''}><summary>${esc(T(p.text, p.ko))}</summary><div class="sp-dim">출처: 루팅</div></details>` : esc(T(p.text, p.ko))}${(() => { const d = pointInjected(p) && !p.pin ? dupState(s, p) : null; return d === 'exact' && p.keyUser !== true ? '<span class="sp-dup" title="개요에 같은 문장이 있어서 이번 주입에서는 빼요 (직접 선택하면 넣어요)">개요와 같음 · 주입 생략</span>' : d === 'near' ? '<span class="sp-dup" title="개요와 많이 겹쳐요. 필요 없으면 ○로 바꿔 주세요">중복 후보</span>' : ''; })()}${evidenceChips(p.msgs, p.oldEvidence)}</div>
                ${tools([...(p.pin ? [] : [btn('pin-point', `${s.id}|${g.id}|${j}`, '⚓', '이 포인트를 고정 주입 (전체 토큰 상한 내에서 우선 유지)')]), btn('edit-point', `${s.id}|${g.id}|${j}`, '✎'), btn('del-point', `${s.id}|${g.id}|${j}`, '🗑')])}</li>`;
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
            return `<div class="sp-seg" id="sp-seg-${esc(g.id)}"><div class="sp-seg-h">${esc(g.id)} ${g.source ? esc(priorRoomLabel(g.source.room)) + (Number.isInteger(g.source.from) ? ` #${g.source.from}–#${g.source.to}` : '') : Number.isInteger(g.from) ? `#${g.from}–#${g.to}` : ''}</div>${timeHtml}${outline}<ul class="sp-pts">${list}</ul>${notes}</div>`;
        }).join('');
        const outlineText = sceneOutlineParts(s).length ? '' : '<p class="sp-dim">개요 없음</p>';
        return `<div class="sp-card sp-scene ${s.status === 'open' ? 'sp-open' : ''} ${s.star ? 'sp-star' : ''}">${head}
            <div class="sp-title">${esc(T(s.title, s.koTitle))}${s.titlePending ? ' <small class="sp-dim">임시 제목</small>' : ''}${s.where ? ` <small>@ ${esc(s.where)}</small>` : ''}</div>
            ${sceneTimeRange(s, mem.timeAnchors, 'ko') ? `<div class="sp-scene-time">📅 ${esc(sceneTimeRange(s, mem.timeAnchors, 'ko'))} ${tools([btn('edit-scenetime', s.id, '✎', '시간 편집 (미확인 구간부터 열어요)', ui.run ? 'sp-disabled' : '')])}</div>` : ''}
            ${ui.timeGaps === s.id && !ui.edit ? `<div class="sp-gap-pick"><span class="sp-dim">시간 미확인 구간 ${sceneTimeGaps(s).length}곳 · 고칠 곳을 골라 주세요</span> ${sceneTimeGaps(s).map(x => btn(x.edge === 'start' ? 'edit-segtime-start' : 'edit-segtime', `${s.id}|${x.g.id}`, `${esc(x.g.id)} ${x.edge === 'start' ? '시작' : '끝'} ✎`)).join('')}</div>` : ''}
            ${s.who.length ? `<div class="sp-who">${whoChips(mem, s.who)}</div>` : ''}
            <div class="sp-outline">${s.segs.filter(g => g.outline).map(g => `<p>${esc(T(g.outline, g.koOutline))}</p>`).join('')}</div>${outlineText}
            ${s.status === 'open' ? `<div class="sp-row sp-scene-close">${btn('run-close', '', '■ 기록하고 장면 닫기', '마지막 메시지까지 기록하고 이 장면을 닫아요. 다음 기록은 새 장면으로 시작해요', ui.run ? 'sp-disabled' : '')}</div>` : ''}
            <details class="sp-more" data-group="scene:${esc(s.id)}" ${(ui.edit && String(ui.edit.id).startsWith(s.id + '|')) || ui.savesOpen.get('scene:' + s.id) ? 'open' : ''}><summary>구간 ${s.segs.length} · 포인트 ${pts.length} (주입 ${pts.filter(x => pointInjected(x.p)).length})</summary>
                <div class="sp-dim sp-keyhelp">● 주입 후보 / ○ 저장만 / ⚓ 우선 주입 고정. ●는 남는 주입 상한 안에서 최신 장면부터 들어가고, ○와 상세 노트는 최근 대화와 관련될 때 회상으로 들어와요. ${btn('rekey-scene', s.id, '⟳ 주입 고르기', '개요와 상태 목록에 없는 중요한 포인트만 AI가 다시 골라요 (직접 지정·고정은 유지)')}</div>
                ${segHtml}</details></div>`;
    }).join('');
}
function recordRow(st, r, extraTools = []) {
    if (isEditing('record', r.id)) return `<div class="sp-rec">${editForm()}</div>`;
    return `<div class="sp-rec sp-record-row ${r.pin ? 'sp-pinned' : ''}"><span class="sp-rec-t">${esc(T(r.text, r.ko))}</span>${evidenceChips(r.msgs, r.oldEvidence)}
        ${tools([...extraTools, btn('pin-rec', r.id, '⚓', '항상 주입', r.pin ? 'sp-on' : ''), btn('edit-rec', r.id, '✎'), btn('del-rec', r.id, '🗑')])}</div>`;
}
// 📅 Timeline: newest recorded parts first, grouped by time reference, with days, flashbacks,
// unknown times and the promises made in each part. Screen only: nothing extra is injected.
// A reference without a date can be given one: "its first recorded day = YYYY-MM-DD". Only the
// chosen reference; a later vague jump starts its own reference and is never linked automatically.
function refHeaderHtml(mem, rows, row) {
    const r = row.ref, inRef = rows.filter(x => !x.flashback && x.ref?.key === r.key && Number.isInteger(x.day?.index));
    const first = inRef.reduce((m, x) => (m === null || x.day.index < m.day.index ? x : m), null);
    if (!r.linkable || !first) return `<div class="sp-tl-ref">${esc(r.label)}</div>`;
    if (ui.edit?.kind === 'reflink' && ui.edit.id === r.anchor)
        return `<div class="sp-tl-ref">${esc(r.label)}<div class="sp-edit"><label class="sp-f"><span>이 기준의 첫 날(${esc(ui.edit.values.label)})의 날짜 · YYYY-MM-DD, 비우면 연결 해제</span><input data-edit="date" value="${esc(ui.edit.values.date)}"></label>
            <div class="sp-dim">저장된 일 수와 메시지 번호는 그대로예요. 표시와 기한 계산에만 쓰고, 원문에 적힌 날짜는 바꾸지 않아요. 뒤에 ‘몇 주 뒤’처럼 새로 시작된 기준은 따로 연결해야 해요.</div>
            <div class="sp-row">${btn('edit-save', '', '저장')}${btn('edit-cancel', '', '취소')}</div></div></div>`;
    const linked = r.link ? ` <span class="sp-dim">· 날짜 연결됨</span>` : '';
    return `<div class="sp-tl-ref">${esc(r.label)}${linked} ${tools([btn('ref-link', `${r.anchor}|${first.day.index}`, r.link ? '📅 연결 수정' : '📅 날짜 연결', '이 기준의 첫 날에 실제 날짜를 연결해요', ui.run ? 'sp-disabled' : '')])}</div>`;
}
function timelineHtml(st) {
    const mem = st.mem, sourceRows = timelineRows(mem);
    if (!sourceRows.length) return '<div class="sp-empty">기록된 구간이 생기면 여기에 최근 기록부터 보여요.</div>';
    // Resolve grouping in recording order before reversing the display. Unknown times and
    // flashbacks keep their original context, never that of a later time jump above them.
    let groupRef = null, groupDay = null;
    const rows = sourceRows.map(row => {
        if (!row.flashback && row.ref) groupRef = row;
        if (!row.flashback && row.day) groupDay = row.day;
        return { ...row, groupRef, groupDay };
    }).reverse();
    const quests = mem.records.filter(r => r.type === 'quest' && r.due && ['promise', 'debt'].includes(r.kind));
    const open = quests.filter(r => r.status === 'open');
    const dueLine = r => `<div class="sp-tl-due sp-due-${dueStatus(mem, r)?.kind || 'closed'}">⏰ <span class="sp-kind">${KIND_KO[r.kind]}</span> ${esc(T(r.text, r.ko))} · ${esc(formatDue(mem, r, 'ko'))} ${btn('tl-quest', r.id, '퀘스트 보기')}</div>`;
    let html = `<p class="sp-dim">기록된 구간을 최근 기록부터 보여 줘요. 서로 다른 시간 기준은 합치지 않아요. 타임라인은 화면용이라 AI에게 따로 주입하지 않아요.</p>`;
    if (open.length) html += `<div class="sp-card"><div class="sp-aspect">진행 중인 약속·빚의 기한</div>${open.map(dueLine).join('')}</div>`;
    const conflicts = linkConflicts(mem);
    if (conflicts.length) html += `<div class="sp-warn">연결한 날짜와 원문 날짜가 어긋나는 곳이 있어요. 기록은 바꾸지 않았어요.<ul>${conflicts.map(c => `<li>${esc(c.segId)} ${esc(c.date)} — 앞 구간 ${esc(c.beforeSeg)} ${esc(c.before)}보다 이른 날짜예요</li>`).join('')}</ul></div>`;
    let ref = null, day = null, scene = null;
    for (const row of rows) {
        const sc = mem.scenes.find(x => x.id === row.sceneId), g = sc.segs.find(x => x.id === row.segId);
        if ((row.groupRef?.ref.key || null) !== ref) {
            if (row.groupRef) html += refHeaderHtml(mem, sourceRows, row.groupRef);
            ref = row.groupRef?.ref.key || null; day = null; scene = null;
        }
        if (row.groupDay && row.groupDay.key !== day) { html += `<div class="sp-tl-day">${esc(row.groupDay.label)}</div>`; day = row.groupDay.key; scene = null; }
        if (row.sceneId !== scene) { html += `<div class="sp-tl-scene">${esc(T(sc.title, sc.koTitle))}${sc.status === 'open' ? ' <small class="sp-dim">진행 중</small>' : ''}</div>`; scene = row.sceneId; }
        const made = quests.filter(r => r.due?.seg === row.segId);
        html += `<div class="sp-tl-row ${row.flashback ? 'sp-tl-flash' : ''} ${row.unknown ? 'sp-tl-unknown' : ''}">
            <div class="sp-row"><span class="sp-tl-time">${row.flashback ? '↩ ' : ''}${esc(row.time || '시간 표시 없음')}</span>
            <span class="sp-dim">${esc(row.segId)}${Number.isInteger(row.from) ? ` #${row.from}–#${row.to}` : ''}</span>
            ${tools([btn('tl-goto', `${row.sceneId}|${row.segId}`, '저널에서 보기'), ...(row.timed ? [btn('tl-edit', `${row.sceneId}|${row.segId}`, '✎ 시간', '이 구간의 시간을 편집해요', ui.run ? 'sp-disabled' : '')] : [])])}</div>
            ${g.outline ? `<div class="sp-tl-text">${esc(T(g.outline, g.koOutline))}</div>` : ''}${made.map(dueLine).join('')}</div>`;
    }
    return html;
}
// ───────── found quests (v0.6.39) ─────────
// v0.6.39: "Ari → 나" for a promise or debt whose direction the messages showed. The user persona
// reads as 나; "A · B 서로" only for a promise the messages call mutual (v0.6.40).
function roleText(mem, q) {
    if (!q.by?.length) return '';
    const me = String(ctx().name1 || '').trim().toLowerCase();
    const nm = id => { const n = entityName(mem, id) || '?'; return me && n.trim().toLowerCase() === me ? '나' : n; };
    return q.to?.length ? `${q.by.map(nm).join(' · ')} → ${q.to.map(nm).join(' · ')}` : q.mutual ? `${q.by.map(nm).join(' · ')} 서로` : q.by.map(nm).join(' · ');
}
function foundQuests(mem) { return mem.records.filter(r => r.type === 'quest' && r.track === 'pending'); }
const STATUS_KO = { open: '진행 중', done: '완료', failed: '실패' };
// Why the quest was picked up: the checked quote of a promise/debt, else the sentence of its first
// message that shares the most words with it (or the start of that message).
function questWhy(st, q) {
    if (q.terms?.quote) return { msg: q.terms.msg, text: q.terms.quote, quote: true };
    const n = (q.msgs || []).filter(Number.isInteger).sort((a, b) => a - b)[0];
    const m = Number.isInteger(n) ? chat()[n] : null;
    if (!m) return Number.isInteger(n) ? { msg: n, text: '' } : null;
    const body = String(msgText(m) || '').replace(/\s+/g, ' ').trim();
    const words = new Set(String(q.text).toLowerCase().split(/[^a-z0-9\u00c0-\uffff]+/).filter(w => w.length > 3));
    const sentences = body.split(/(?<=[.!?。…])\s+|\n/).filter(Boolean);
    let best = '', score = 0;
    for (const x of sentences) { const k = x.toLowerCase().split(/[^a-z0-9\u00c0-\uffff]+/).filter(w => words.has(w)).length; if (k > score) { score = k; best = x; } }
    const text = best || body;
    return { msg: n, text: text.length > 180 ? text.slice(0, 180) + '…' : text };
}
function questCandidate(st, q) {
    const mem = st.mem, why = questWhy(st, q);
    const meta = [`<span class="sp-kind">${KIND_KO[q.kind] || q.kind}</span>`, roleText(mem, q) ? `<b class="sp-role">${esc(roleText(mem, q))}</b>` : '', q.due ? `⏰ ${esc(formatDue(mem, q, 'ko'))}` : '',
        q.status !== 'open' ? `<span class="sp-badge ${q.status === 'failed' ? 'sp-badge-warn' : 'sp-badge-on'}">이미 ${STATUS_KO[q.status]}</span>` : ''].filter(Boolean).join(' · ');
    return `<div class="sp-qcand" id="sp-quest-${esc(q.id)}"><div class="h"><span class="sp-qi">${QUEST_ICON[q.kind] || '•'}</span><b>${esc(T(q.text, q.ko))}</b></div>
        <div class="meta">${meta}${q.who?.length && !roleText(mem, q) ? ' ' + whoChips(mem, q.who) : ''}</div>
        ${why ? `<div class="why"><span class="sp-dim">근거${Number.isInteger(why.msg) ? ` #${why.msg}` : ''}</span> ${why.text ? (why.quote ? `“${esc(why.text)}”` : esc(why.text)) : '<span class="sp-dim">원문을 찾을 수 없어요</span>'}</div>` : ''}
        <div class="sp-row">${btn('quest-accept', q.id, '수락', '퀘스트 목록에 올려 추적해요', 'sp-primary')}${btn('quest-decline', q.id, '거절', '퀘스트로 관리하지 않아요. 원문과 기존 저널은 유지돼요')}</div></div>`;
}
function questsHtml(st) {
    const all = st.mem.records.filter(r => r.type === 'quest');
    const qs = all.filter(q => !q.track);
    const group = (status, label) => {
        const list = qs.filter(q => q.status === status);
        if (!list.length) return '';
        return `<div class="sp-group"><div class="sp-group-h">${label} <span>${list.length}</span></div>${list.map(q => {
            if (isEditing('record', q.id)) return `<div class="sp-quest">${editForm()}</div>`;
            const flow = [...(status === 'open' ? [btn('quest-done', q.id, '완료'), btn('quest-fail', q.id, '실패')] : [btn('quest-open', q.id, '다시 진행')]),
                btn('quest-decline', q.id, '추적 안 함', '퀘스트 목록에서 빼요(주입도 빠져요). 원문과 기존 저널은 유지돼요')];
            return `<div class="sp-quest sp-q-${status}" id="sp-quest-${esc(q.id)}"><span class="sp-qi">${QUEST_ICON[q.kind] || '•'}</span><div class="sp-qb"><div><span class="sp-kind">${KIND_KO[q.kind]}</span>${roleText(st.mem, q) ? ` <b class="sp-role">${esc(roleText(st.mem, q))}</b>` : ''} ${esc(T(q.text, q.ko))}</div>
                ${questEventTimes(st.mem, q).map(at => `<div class="sp-sub sp-quest-time">📅 ${esc(at.label)}: ${esc(at.text)}</div>`).join('')}
                <div class="sp-sub">${whoChips(st.mem, q.who)}${evidenceChips(q.msgs, q.oldEvidence)}</div>${(() => { if (!q.due) return ''; const d = dueStatus(st.mem, q); return `<div class="sp-due sp-due-${d?.kind || 'closed'}">⏰ ${esc(formatDue(st.mem, q, 'ko'))}${q.due.manual ? ' <small class="sp-dim">직접 지정</small>' : ''}</div>`; })()}${q.terms ? `<details class="sp-terms" data-group="terms:${esc(q.id)}" ${ui.savesOpen.get('terms:' + q.id) ? 'open' : ''}><summary>근거 원문 ${esc(priorTermsLabel(q.terms))}</summary><div class="sp-terms-q">“${esc(q.terms.quote)}”</div><div class="sp-excerpt">${esc(q.terms.context)}</div></details>` : ''}</div>${tools([...flow, btn('pin-rec', q.id, '⚓', '항상 주입', q.pin ? 'sp-on' : ''), btn('edit-rec', q.id, '✎'), btn('del-rec', q.id, '🗑')])}</div>`;
        }).join('')}</div>`;
    };
    const found = foundQuests(st.mem), declined = all.filter(q => q.track === 'declined');
    const foundBox = found.length ? `<div class="sp-group sp-found"><div class="sp-group-h">❗ 발견한 퀘스트 <span>${found.length}</span></div><div class="sp-qcands">${found.map(q => questCandidate(st, q)).join('')}</div></div>` : '';
    const declinedBox = declined.length ? `<details class="sp-more" data-group="quests-declined" ${ui.savesOpen.get('quests-declined') ? 'open' : ''}><summary>추적하지 않는 퀘스트 ${declined.length}</summary>
        <div class="sp-dim">퀘스트 목록과 주입에서만 빠져 있어요. 원문과 기존 저널은 유지돼요. 이야기 속 진행은 계속 기록해요.</div>
        ${declined.map(q => `<div class="sp-quest sp-q-declined"><span class="sp-qi">${QUEST_ICON[q.kind] || '•'}</span><div class="sp-qb"><div><span class="sp-kind">${KIND_KO[q.kind]}</span> ${esc(T(q.text, q.ko))} <span class="sp-dim">· ${STATUS_KO[q.status]}</span></div>${q.autoDeclined ? '<div class="sp-sub sp-dim">거절한 퀘스트와 비슷해서 자동으로 넘겼어요</div>' : ''}</div>${tools([btn('quest-accept', q.id, '다시 추적'), btn('del-rec', q.id, '🗑')])}</div>`).join('')}</details>` : '';
    const body = group('open', '진행 중') + group('done', '완료') + group('failed', '실패');
    return addBar('quest') + foundBox + (body || (found.length ? '' : '<div class="sp-empty">약속·목표·빚·수수께끼가 생기면 여기에 나타나요.</div>')) + declinedBox;
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
    // v0.6.36: 활성 / 대기 / 관계·상태 주입 제외 per person. Recording goes on in every mode.
    const modeBtns = e => `<div class="sp-row sp-party-mode">${[['', '활성', '관계·상태를 일반 주입 후보로'], ['standby', '대기', '평소엔 빼고, 다시 등장하면 전부 · 최근 대화에 이름만 나오면 최신 기록 한 줄만'], ['exclude', '주입 제외', '관련돼도 이 인물의 관계·상태 기록은 주입하지 않아요 (저널·퀘스트·캐릭터 시트는 그대로)']]
        .map(([m, label, tip]) => btn('person-mode', `${e.id}|${m}`, label, tip, (e.standby || '') === m ? 'sp-on' : '')).join('')}</div>`;
    const card = e => {
        const recs = mem.records.filter(r => r.type === 'party' && r.entity === e.id);
        const rows = a => recs.filter(r => r.aspect === a).map(r => recordRow(st, r)).join('');
        const rel = rows('relation'), cond = rows('condition');
        return `<div class="sp-card sp-person ${e.standby ? 'sp-person-' + e.standby : ''}">${entityHead(st, e)}${modeBtns(e)}
            ${rel ? `<div class="sp-aspect">관계</div>${rel}` : ''}${cond ? `<div class="sp-aspect">상태</div>${cond}` : ''}
            ${!rel && !cond ? '<div class="sp-dim">기록된 변화 없음</div>' : ''}</div>`;
    };
    const resting = people.filter(e => e.standby);
    const cards = people.filter(e => !e.standby).map(card).join('') + (resting.length
        ? `<details class="sp-more sp-bench" data-group="bench" ${ui.savesOpen.get('bench') ? 'open' : ''}><summary>🪑 대기 ${resting.filter(e => e.standby === 'standby').length} · 주입 제외 ${resting.filter(e => e.standby === 'exclude').length}</summary>
            <div class="sp-dim">대기·제외여도 대화에서 생긴 변화는 계속 기록해요. 바뀌는 건 본편 주입뿐이에요.</div>${resting.map(card).join('')}</details>` : '');
    const orphan = mem.records.filter(r => r.type === 'party' && !people.some(p => p.id === r.entity)).map(r => recordRow(st, r)).join('');
    return addBar('party') + (cards || orphan ? cards + orphan : '<div class="sp-empty">인물의 관계 변화와 상태가 여기에 쌓여요.</div>');
}
// The scene a message belongs to (for "마지막 기록" on stored items).
function sceneOfMsg(mem, n) {
    if (!Number.isInteger(n)) return null;
    const k = mem.scenes.findIndex(sc => sc.segs.some(g => !g.external && !g.source && n >= g.from && n <= g.to));
    return k < 0 ? null : { no: k + 1, title: mem.scenes[k].title };
}
function itemsHtml(st) {
    const mem = st.mem;
    const recs = mem.records.filter(r => r.type === 'item');
    const card = r => {
        if (isEditing('record', r.id)) return `<div class="sp-card">${editForm()}</div>`;
        const last = r.msgs?.length ? Math.max(...r.msgs.filter(Number.isInteger)) : null, sc = sceneOfMsg(mem, last);
        // v0.6.40: what the story put away is one "자동 보관" with its reason: 사라짐 (used up, broken,
        // lost) or 정리됨 (a scene prop that needs no more following).
        const auto = r.stored?.by === 'story' ? (r.gone ? '사라짐' : r.stored.reason === 'retired' ? '정리됨' : '사라짐') : '';
        const badges = [r.stored ? (r.stored.by === 'user' ? '<span class="sp-badge">보관</span>'
                : `<span class="sp-badge" title="${auto === '정리됨' ? '그 장면에서 쓰고 끝난 물건이라 추적을 끝냈어요. 마지막 상태는 남아 있어요. 새로 챙기거나 쓸 이유가 생기면 돌아와요' : '다 쓰거나 깨지거나 잃어버린 물건이에요. 되찾거나 고치면 돌아와요'}">자동 보관 · ${auto}</span>`) : '',
            r.gone && !r.stored ? '<span class="sp-badge">사라짐</span>' : '',
            r.storedUpdated ? '<span class="sp-badge sp-badge-on" title="보관함에 있는 동안 이야기에서 다시 언급돼 기록이 갱신됐어요">보관 중 갱신됨</span>' : '',
            r.returnNotice ? '<span class="sp-badge sp-badge-warn" title="이야기에서 다시 쓰이거나 지니게 됐어요. 꺼낼지 정해 주세요">복귀 확인</span>' : '',
            r.stored?.lock ? '<span class="sp-badge" title="직접 보관 유지: 보관함 방식과 상관없이 보관함에 두고 알림도 띄우지 않아요">🔒</span>' : ''].join('');
        const move = r.stored ? btn('item-unstore', r.id, '꺼내기', '현재 상태 주입 대상으로 돌려요. 이야기 속 소지자·위치는 바뀌지 않아요')
            + (r.returnNotice ? btn('item-keep', r.id, '그대로 두기', '복귀 확인을 닫고 보관함에 둬요') : '')
            + (r.stored.by === 'user' ? btn('item-lock', r.id, r.stored.lock ? '🔓' : '🔒', r.stored.lock ? '직접 보관 유지 풀기' : '직접 보관 유지 · 보관함 방식과 상관없이 보관함에 두고 알림도 띄우지 않아요') : '')
            : btn('item-store', r.id, '📦', '보관함에 넣기 · 이 물건의 상태 기록을 주입에서 빼요(과거 사건 기록은 유지). 이야기 속 소지자·위치는 바뀌지 않아요');
        return `<div class="sp-card sp-item ${r.stored ? 'sp-stored-item' : ''}"><div class="sp-item-h"><span class="sp-ent-n">${r.stored ? '📦' : '🎒'} ${esc(entityName(mem, r.entity) || '?')}</span>${badges}
            ${r.holder ? `<span class="sp-holder">소지: <b>${esc(entityName(mem, r.holder))}</b></span>` : '<span class="sp-holder sp-dim">소지자 없음</span>'}</div>
            ${r.stored && sc ? `<div class="sp-dim sp-item-last">마지막 기록: SCENE ${String(sc.no).padStart(2, '0')} · ${esc(sc.title)}</div>` : ''}
            ${recordRow(st, r, [move])}</div>`;
    };
    const live = recs.filter(r => !r.stored), boxed = recs.filter(r => r.stored);
    const box = boxed.length ? `<details class="sp-more sp-box" data-group="itembox" ${ui.savesOpen.get('itembox') ? 'open' : ''}><summary>📦 보관함 ${boxed.length}</summary>
        <div class="sp-dim">보관한 물건의 상태 기록은 주입에서 제외해요. 그 물건이 나온 과거 사건(저널·포인트)은 그대로 유지돼요. 기록하는 AI는 같은 물건을 알아보도록 이름과 마지막 상태만 봐요. 꺼내면 현재 상태 주입 대상으로 돌아오고, 이야기 속 소지자·위치는 바뀌지 않아요. '자동 보관'은 이야기가 넣은 것이에요: <b>사라짐</b>(다 쓰거나 깨지거나 잃어버림 · 되찾거나 고치면 돌아옴), <b>정리됨</b>(그 장면에서 쓰고 끝난 소품 · 다시 언급되거나 조금 쓰인 정도로는 돌아오지 않고, 새로 챙기거나 쓸 이유가 생기면 돌아옴).</div>
        ${boxed.map(card).join('')}</details>` : '';
    const rows = live.map(card).join('');
    const itemEnts = mem.entities.filter(e => e.type === 'item' || e.type === 'place');
    const names = itemEnts.length ? `<details class="sp-more" data-group="itemnames" ${ui.savesOpen.get('itemnames') ? 'open' : ''}><summary>물건·장소 이름 ${itemEnts.length}개 (별칭 편집)</summary>${itemEnts.map(e => `<div class="sp-card">${entityHead(st, e)}</div>`).join('')}</details>` : '';
    return addBar('item') + (rows || '<div class="sp-empty">누가 무엇을 가지고 있는지, 물건이 어떤 상태인지 여기에 나타나요.</div>') + box + names;
}
const WORLD_ICON = { place: '📍', rule: '📜', name: '🏷', secret: '🔒' };
function worldHtml(st) {
    const recs = st.mem.records.filter(r => r.type === 'world');
    // v0.6.43: one group per kind with its icon; cards carry the kind for a coloured edge.
    const body = WORLD_KINDS.map(k => {
        const list = recs.filter(r => r.kind === k);
        if (!list.length) return '';
        return `<div class="sp-group sp-wgroup" data-kind="${k}"><div class="sp-group-h"><span class="sp-wicon">${WORLD_ICON[k] || '•'}</span>${KIND_KO[k]} <span>${list.length}</span></div>${list.map(r => recordRow(st, r, r.knownBy?.length ? [`<span class="sp-known" title="아는 사람">👁 ${esc(r.knownBy.map(id => entityName(st.mem, id)).join(', '))}</span>`] : [])).join('')}</div>`;
    }).join('');
    return addBar('world') + (body ? `<div class="sp-world">${body}</div>` : '<div class="sp-empty">장소, 규칙, 별명, 비밀이 여기에 모여요.</div>');
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
const slotKind = sv => (sv.quick ? 'QUICK' : sv.auto ? 'AUTO' : 'FILE');
// The scene title at the time the save was made (old saves may not have one).
const saveTitle = sv => String(sv?.stats?.lastTitle || '').trim();
function saveCard(sv, st, { showRoom = false, autoRank = 0 } = {}) {
    const s = sv.stats || {};
    const linked = st?.linkedSave === sv.id;
    const kind = slotKind(sv);
    const genLabel = sv.auto ? ['최신', '이전', '그 전'][autoRank] || '' : '';
    const title = saveTitle(sv);
    const copy = kind !== 'FILE';
    return `<div class="sp-card sp-save sp-save-${kind.toLowerCase()} ${sv.auto ? 'sp-auto' : ''} ${linked ? 'sp-linked' : ''}">
        <div class="sp-save-h"><span class="sp-slot">${kind}</span><span class="sp-save-n">${esc(sv.name)}</span>${genLabel ? `<span class="sp-badge">${genLabel}</span>` : ''}${linked ? '<span class="sp-badge sp-badge-on" title="이 방에서 마지막으로 저장하거나 불러온 슬롯이에요">▶ 플레이 중</span>' : ''}${sv.local ? '<span class="sp-badge sp-badge-warn" title="서버에 쓰지 못해 설정에만 있어요">설정에만</span>' : ''}</div>
        ${title ? `<div class="sp-save-title" title="저장 당시 장면">🎬 ${esc(title)}</div>` : ''}
        <div class="sp-save-meta">${showRoom ? `🗝️ ${esc(roomLabel(sv.room))} · ` : ''}${esc(sv.char || '')} · ${fmtDate(sv.updated)}</div>
        <div class="sp-save-stats"><span>장면 ${s.scenes ?? 0}</span><span>메시지 ${sv.msgCount ?? 0}</span><span>❗ ${s.openQuests ?? 0}</span>${s.place ? `<span>📍 ${esc(s.place)}</span>` : ''}</div>
        <div class="sp-row">${btn('load', sv.id, '불러오기', '이 방의 기억을 이 슬롯으로 바꿔요. 슬롯은 저장을 누를 때만 덮어써요', 'sp-primary')}
            ${copy ? btn('save-rename', sv.id, '사본 저장', '이 시점을 이름 붙인 FILE 슬롯으로 따로 저장해요. 이 카드는 그대로예요')
                : btn('save-over', sv.id, '저장', '이 슬롯을 지금 기억으로 덮어써요') + btn('save-rename', sv.id, '이름', '이 슬롯의 이름을 바꿔요')}${btn('save-export', sv.id, '📤', '이 슬롯을 .json 파일로 내보내기')}${btn('save-del', sv.id, '삭제', '', 'sp-danger')}</div></div>`;
}
function cardsOf(list, st, opts) {
    const rank = {};
    return list.map(sv => saveCard(sv, st, { ...opts, autoRank: sv.auto ? (rank[sv.roomHash] = (rank[sv.roomHash] ?? -1) + 1) : 0 })).join('');
}
// A room folder: its name plus the scene title of the newest save made in it.
function roomTitle(room, list) {
    const newest = [...list].sort((a, b) => b.updated - a.updated).find(x => saveTitle(x));
    return `🗝️ ${esc(roomLabel(room))}${newest ? ` · ${esc(saveTitle(newest))}` : ''}`;
}
function byRoom(list) {
    const rooms = new Map();
    for (const sv of list) { if (!rooms.has(sv.room)) rooms.set(sv.room, []); rooms.get(sv.room).push(sv); }
    // Rooms with the newest save first.
    return [...rooms.entries()].sort((a, b) => Math.max(...b[1].map(x => x.updated)) - Math.max(...a[1].map(x => x.updated)));
}
function groupBox(key, title, count, body, openByDefault) {
    const open = ui.savesOpen.has(key) ? ui.savesOpen.get(key) : openByDefault;
    return `<details class="sp-savegroup" data-group="${esc(key)}" ${open ? 'open' : ''}><summary><span class="sp-group-h">${title} <span>${count}</span></span></summary>${body}</details>`;
}
// Other characters: one folder per character card.
// Other characters: one folder per character; inside it one folder per room when there are several.
function otherCharsHtml(list, st, order) {
    const byChar = new Map();
    for (const sv of list) { const k = roomChar(sv.room) || sv.char || '?'; if (!byChar.has(k)) byChar.set(k, []); byChar.get(k).push(sv); }
    return [...byChar.entries()].map(([k, l]) => {
        const rooms = byRoom(l);
        const body = rooms.length > 1
            ? rooms.map(([room, rl]) => groupBox(`room:${room}`, roomTitle(room, rl), rl.length, cardsOf(order(rl), st, {}), false)).join('')
            : cardsOf(order(l), st, { showRoom: true });
        return groupBox('char:' + k, `👾 ${esc(l[0].char || k)}`, l.length, body, false);
    }).join('');
}
function savesHtml(st) {
    const saves = listSaves();
    const notice = vault.notice === 'index-missing' && !ui.found ? '<div class="sp-alert">서버의 세이브 목록 파일이 없어요. 🔍 백업 찾기로 이전 목록을 확인해 주세요.</div>' : '';
    const top = `<div class="sp-addbar">${btn('save-new', '', '＋ 새 세이브 슬롯')}${btn('export-room', '', '📤 세이브 내보내기', '이 방 기억을 .json 파일로 내려받아요')}
        ${btn('import', '', '📥 세이브 가져오기', '.json 파일에서 슬롯으로 불러와요')}${btn('find', '', '🔍 백업 찾기', '서버에 남은 백업을 찾아 보여 줘요 (아무것도 바꾸지 않아요)')}
        ${btn('clear-room', '', '리셋', '이 방의 기억을 모두 지워요 (세이브 슬롯은 남아요)', 'sp-danger')}</div>${vaultLine()}${notice}${foundHtml()}`;
    if (!saves.length) return top + '<div class="sp-empty">세이브 슬롯이 없어요. 퀵세이브하면 방마다 QUICK이, 기억이 바뀔 때마다 오토세이브가 생겨요(최근 3개).</div>';
    const here = roomKey(), charKey = charInfo()?.key || '';
    // QUICK first, then manual slots in the order they were made (renaming or saving does not move
    // them), then autosaves, newest first.
    const order = list => [...list.filter(x => x.quick),
        ...list.filter(x => !x.auto && !x.quick).sort((a, b) => (b.created || 0) - (a.created || 0)),
        ...list.filter(x => x.auto).sort((a, b) => b.updated - a.updated)];
    const thisRoom = order(saves.filter(x => x.room === here));
    const sameChar = saves.filter(x => x.room !== here && roomChar(x.room) === charKey);
    const others = saves.filter(x => x.room !== here && roomChar(x.room) !== charKey);
    const roomBoxes = byRoom(sameChar).map(([room, list]) =>
        groupBox('room:' + room, roomTitle(room, list), list.length, cardsOf(order(list), st, {}), false)).join('');
    // A room without memory yet (a new chat): offer the newest QUICK of this character's other rooms first.
    const resume = !hasMemory(st?.mem) ? sameChar.filter(x => x.quick).sort((a, b) => b.updated - a.updated).slice(0, 3) : [];
    const resumeBox = resume.length ? `<div class="sp-resume"><div class="sp-aspect">이어하기 · 다른 방의 최근 QUICK</div>
        <div class="sp-dim">불러오면 저장 당시 마지막 캐릭터 메시지로 이 방을 시작할 수 있어요.</div>${cardsOf(resume, st, { showRoom: true })}</div>` : '';
    return top + resumeBox
        + groupBox('here', '이 방', thisRoom.length, thisRoom.length ? cardsOf(thisRoom, st, {}) : '<div class="sp-dim">이 방에서 만든 세이브가 아직 없어요.</div>', true)
        + (sameChar.length ? groupBox('char', `${esc(charInfo()?.name || '이 캐릭터')}의 다른 방`, sameChar.length, roomBoxes, false) : '')
        + (others.length ? groupBox('others', '다른 캐릭터', others.length, otherCharsHtml(others, st, order), false) : '');
}
const LEVEL_KO = { full: '자세히', points: '개요+포인트 일부', outline: '개요', short: '짧은 개요', title: '제목만', omitted: '빠짐', recalled: '회상만' };
function injectLevelsHtml(st, inj) {
    const levels = Object.values(inj.levels || {});
    if (!levels.length) return '';
    const count = k => levels.filter(l => l === k).length;
    const line = Object.keys(LEVEL_KO).filter(k => count(k)).map(k => `${LEVEL_KO[k]} ${count(k)}`).join(' · ');
    const reduced = levels.some(l => l !== 'full' && l !== 'outline' && l !== 'points');
    if (reduced && ui.injNeed === undefined && ui.injOpts) ui.injNeed = neededBudget(st.mem, ui.injOpts);
    // Second figure: what it takes for every scene to carry all its ● points too.
    if (inj.pointsLeft && ui.injNeedPoints === undefined && ui.injOpts) ui.injNeedPoints = neededBudget(st.mem, ui.injOpts, 100000, { points: true });
    const budget = num('budget', 300, 100000), titleCap = num('titleCap', 0, 20000);
    const why = !inj.omittedScenes ? '' : inj.omittedBy === 'titleCap'
        ? `<div class="sp-warn">‘오래된 장면 제목 목록 상한’(${titleCap.toLocaleString()}토큰) 때문에 제목도 넣지 못한 장면이 ${inj.omittedScenes}개 있어요. 그 상한을 늘리면 제목이 들어가요.</div>`
        : `<div class="sp-warn">주입 상한(${budget.toLocaleString()}토큰)이 차서 제목도 넣지 못한 장면이 ${inj.omittedScenes}개 있어요.</div>`;
    const need = (!reduced ? '' : ui.injNeed
        ? `<div class="sp-dim">모든 장면의 개요까지 넣으려면 주입 상한 약 <b>${ui.injNeed.toLocaleString()}</b>토큰이 필요해요.</div>`
        : '<div class="sp-dim">주입 상한을 최대로 늘려도 모든 장면의 개요를 넣을 수는 없어요.</div>')
        + (!inj.pointsLeft ? '' : ui.injNeedPoints
            ? `<div class="sp-dim">● 포인트까지 모두 넣으려면 약 <b>${ui.injNeedPoints.toLocaleString()}</b>토큰이 필요해요 (지금 ${inj.pointsLeft}개 장면의 포인트가 일부 빠져 있어요). 상세 노트와 ○ 포인트는 회상으로만 들어가요.</div>`
            : `<div class="sp-dim">● 포인트가 일부 빠진 장면이 ${inj.pointsLeft}개 있어요. 상한을 최대로 늘려도 모두 넣을 수는 없어요.</div>`);
    return `<div class="sp-dim">장면 ${levels.length}개 · ${line}</div>${why}${need}${reduced ? '<div class="sp-dim">줄어든 장면도 저장된 기록·포인트는 그대로예요. 자세한 내용은 최근 대화와 관련될 때 회상 후보가 되지만, 회상은 검색 결과와 회상 몫 안에서 골라요.</div>' : ''}`;
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
        ${injectLevelsHtml(st, inj)}
        ${inj.pinOverflow ? `<div class="sp-warn">⚓ 고정 항목 ${inj.pinMissing}개가 주입 상한 안에 들어가지 못해 빠졌어요. 고정을 줄이거나 상한을 늘려 주세요.</div>` : ''}
        <div class="sp-aspect">회상한 장면과 이유</div>${rec}
        </div>
        <pre class="sp-pre">${esc(inj.text)}</pre>
        <div class="sp-dim">마지막 메시지를 기준으로 계산했어요. 실제 생성 직전에 한 번 더 계산해요.</div>`;
}
// v0.6.49: the manual hide button, beside the record bar. Shown only in manual mode with something to hide;
// it waits while a save runs or a change is still being written, so it never hides what the file lacks.
function writesPending() { return !!saveQueues.get(`${roomKey()}|${roomEpoch}`)?.pending.length; }
// v0.6.55: in the button row, always there in manual mode; the count has a fixed width so the row
// never moves, and pressing it with nothing to hide says so.
function hideButton(st, busy) {
    const s = settings();
    if (!s.enabled || hideModeOf(s) !== 'manual') return '';
    const count = st && !st.review && hasMemory(st.mem) ? manualHidePlan(st).count : 0;
    const wait = busy || writesPending();
    const n = count > 999 ? '999+' : String(count);
    return `<button class="sp-btn sp-mini sp-hide-btn${wait ? ' sp-disabled' : ''}" data-act="hide-now" data-id="" title="${esc(wait ? '저장이 끝나면 누를 수 있어요' : count ? `저장된 원문 ${count}개를 숨겨요. 미저장 메시지와 최근 ${num('keepRecent', 0, 200)}개는 남겨요.` : '지금 숨길 저장된 원문이 없어요')}">👻 하이드 <span class="sp-hide-n">${n}</span></button>`;
}
async function hideRecorded() {
    const st = state();
    if (hideModeOf(settings()) !== 'manual') return;
    if (ui.run || writesPending()) { toastr.info('저장이 끝난 뒤 눌러 주세요.', 'SavePoint'); return; }
    if (!st || st.review || !hasMemory(st.mem) || !manualHidePlan(st).count) { toastr.info('지금 숨길 저장된 원문이 없어요. 다음 세이브 뒤에 숨길 수 있어요.', 'SavePoint'); return; }
    // v0.6.50: what the question names is what gets hidden. If the room, the records or the chat
    // changed while it was open (a checkpoint finished, a message came in), nothing is hidden.
    const asked = { key: roomKey(), epoch: roomEpoch, last: st.lastIndex, len: chat().length, ...manualHidePlan(st) };
    if (!asked.count) return;
    if (!(await confirmBox(`저장된 원문 ${asked.count}개를 하이드할까요? 미저장 메시지와 최근 ${num('keepRecent', 0, 200)}개는 남겨요. 기억은 그대로 주입돼요.`))) return;
    const now = state(), plan = now ? manualHidePlan(now) : null;
    if (roomKey() !== asked.key || roomEpoch !== asked.epoch) return;
    if (!now || ui.run || writesPending() || hideModeOf(settings()) !== 'manual' || now.lastIndex !== asked.last || chat().length !== asked.len || plan.to !== asked.to || plan.count !== asked.count) {
        toastr.info('확인하는 사이 기록이나 대화가 바뀌어서 하이드하지 않았어요. 👻 버튼을 다시 눌러 주세요.', 'SavePoint');
        return render();
    }
    await transact(() => { const cur = state(); if (!cur) return false; cur.hideManual = { to: asked.to, at: Date.now() }; }, { undoable: false, autosave: false, rehide: 'button' });
}
function hudHtml(st) {
    const open = st ? openScene(st.mem) : null;
    const total = chat().length;
    const covered = st ? st.lastIndex + 1 : 0;
    const pending = pendingCount();
    const injectionStatus = `주입 ${ui.inj ? ui.inj.tokens.toLocaleString() : 0} / ${num('budget', 300, 100000).toLocaleString()} 토큰`;
    const pct = total ? Math.round(covered / total * 100) : 0;
    const busy = !!ui.run;
    const review = st?.review ? `<div class="sp-alert">이미 기억에 반영된 예전 원문 #${st.review.at}이(가) 바뀌었어요. 저장 기록 이전이라 자동으로 되감을 수 없어요.
        <div class="sp-row">${btn('review-accept', '', '지금 원문 기준으로 인정')}${btn('clear-room', '', '리셋', '이 방의 기억을 모두 지워요 (세이브 슬롯은 남아요)', 'sp-danger')}</div></div>` : '';
    const every = num('autoEvery', 5, 500);
    const autoLine = !settings().auto ? '<span class="sp-dim">체크포인트 꺼짐</span>'
        : `<span>다음 체크포인트까지 <b>${Math.max(0, every - autoCount(st))}</b>개</span>`;
    const attemptAt = st?.autoAttemptAt || st?.autoLast?.at;
    const autoLast = attemptAt ? `<span class="${st.autoFail ? 'sp-warn' : 'sp-dim'}">마지막 자동 저장 시도 ${new Date(attemptAt).toLocaleTimeString()} · ${esc(ui.run?.auto ? '체크포인트 저장 중…' : st.autoAttemptAt && (!st.autoLast || st.autoLast.at < st.autoAttemptAt) ? '이번 시도 결과 없음 또는 중단됨 · 다음 간격에 다시' : st.autoLast?.result || '결과 대기')}</span>` : '';
    const lastRecord = st?.lastRecord ? `<span class="sp-dim">마지막 저장 ${new Date(st.lastRecord.at).toLocaleTimeString()} · ${st.lastRecord.kind === 'supplement' ? '루팅 보충 ' : ''}#${st.lastRecord.from}–#${st.lastRecord.to}${st.lastRecord.supplement ? ` · 루팅 보충 #${st.lastRecord.supplement.from}–#${st.lastRecord.supplement.to}` : ''}</span>` : st?.lastIndex >= 0 ? `<span class="sp-dim">마지막 저장 · 시각 정보 없음 · #0–#${st.lastIndex}</span>` : '<span class="sp-dim">마지막 저장 없음</span>';
    const err = ui.lastError ? `<details class="sp-err" data-group="hud-err" ${ui.savesOpen.get('hud-err') ? 'open' : ''}><summary>마지막 실패 ${esc(ui.lastError.range)} — 자세히</summary><ul class="sp-scroll">${groupErrors(ui.lastError.detail).map(d => `<li>${esc(d)}</li>`).join('')}</ul></details>` : '';
    // Folded by default on narrow screens: one status line stands for the rest, and turns to a warning
    // colour when something failed or needs checking, so a folded panel never hides a problem.
    const openHud = hudOpen();
    // A checkpoint failure is also the last failure; the same one is counted once.
    const sameFailure = st?.autoFail?.failureId && st.autoFail.failureId === ui.lastError?.failureId;
    const fails = (st?.autoFail ? 1 : 0) + (ui.lastError && !sameFailure ? 1 : 0), lootFails = (st?.lootQueue || []).filter(x => x.error?.startsWith('반영 실패')).length;
    const issues = st?.check && st.check.status !== 'running' && settings().check ? st.check.status === 'failed' ? 1 : st.check.issues.filter(x => !x.ignored).length : 0;
    const interrupted = interruptedNote(st);
    const alerting = fails || lootFails || issues || ui.inj?.pinOverflow || interrupted;
    const chip = [`미저장 ${pending}`, injectionStatus, ...(st?.lootQueue?.length ? [`⏳ ${st.lootQueue.length}`] : []), ...(fails ? [`⚠ 실패 ${fails}`] : []),
        ...(lootFails ? [`💎 반영 실패 ${lootFails}`] : []), ...(issues ? [`확인 필요 ${issues}`] : []), ...(interrupted ? ['저장 중단됨'] : []),
        ...(ui.inj?.pinOverflow ? ['⚓ 주입 못 함'] : [])].join(' · ');
    return `<div class="sp-hud ${openHud ? 'sp-hud-open' : 'sp-hud-folded'}">${hudResultHtml()}
        <div class="sp-scene-now">${open ? `<span class="sp-cursor">▶</span> <b>${esc(T(open.title, open.koTitle))}</b>${open.where ? ` <span class="sp-dim">@ ${esc(open.where)}</span>` : ''}` : '<span class="sp-dim">▷ 진행 중인 장면 없음</span>'}</div>
        <div class="sp-barline"><div class="sp-bar" title="저장된 메시지 비율"><div class="sp-bar-fill" style="width:${pct}%"></div><span>저장 ${covered} / ${total}</span></div></div>
        <button type="button" class="sp-hud-chip ${alerting ? 'sp-alerting' : ''}" data-act="hud-toggle" aria-expanded="${openHud}" title="${openHud ? '자세한 상태 접기' : '자세한 상태 펼치기'}"><span>${esc(chip)}</span><span class="sp-hud-caret">${openHud ? '▴' : '▾'}</span></button>
        ${review}
        <div class="sp-hud-more">
        ${storyTimeContext(st?.mem || {}, 'ko') ? `<div class="sp-hud-time">마지막 저장 기준 · ${esc(storyTimeContext(st.mem, 'ko'))}</div>` : ''}
        <div class="sp-hud-meta"><span>미저장 <b>${pending}</b></span>${btn('tab', 'queue', `⏳ 대기열 ${st?.lootQueue?.length || 0}개`)}${returnNotices(st).length ? btn('tab', 'main', `📦 복귀 확인 ${returnNotices(st).length}`, '보관함 물건이 이야기에서 다시 쓰였어요', 'sp-on') : ''}<span>${esc(injectionStatus)}</span><span>요약 AI: ${esc(profileLabel())}</span>${keptCount() ? `<span title="SavePoint가 하이드하지 않는 메시지 (메시지 … 메뉴의 🔖)">🔖 원문 유지 ${keptCount()}개</span>` : ''}${ui.inj?.pinOverflow ? `<span class="sp-warn">⚓ ${ui.inj.pinMissing}개 주입 못 함</span>` : ''}</div>
        <div class="sp-hud-meta sp-auto-line">${autoLine}${autoLast}${lastRecord}</div>
        ${interrupted && !busy ? `<div class="sp-hud-meta"><span class="sp-warn">⚠ 지난 저장이 방을 옮기면서 중간에 멈췄어요 (#${interrupted.from}부터 미저장)</span>${btn('run', '', '퀵세이브로 이어서')}</div>` : ''}
        ${autoFailHtml(st)}
        ${checkHtml(st)}
        ${ui.lastFix ? `<div class="sp-hud-meta"><span class="sp-dim">자동 보정 ${esc(ui.lastFix.range)}: ${esc(ui.lastFix.text)} · ${new Date(ui.lastFix.at).toLocaleTimeString()}</span></div>` : ''}
        ${(ui.lastError || st?.autoFail || st?.lootQueue?.some(x => x.error) || (st?.check && st.check.status !== 'running')) && !busy ? `<div class="sp-row sp-copyrow">${btn('copy-report', '', '📋 결과 복사', '마지막 실패와 기록 확인 결과를 글로 복사해요 (캡처 대신)')}</div>` : ''}
        ${err}
        </div>
        <div class="sp-row sp-actions">
            ${busy ? btn('stop', '', '■ 중지', '저장을 멈춰요 (끝난 구간은 남아요)', 'sp-danger')
                : btn('run', '', '⏺ 퀵세이브', '마지막 메시지까지 바로 기록하고, 끝나지 않은 장면은 열어 둬요', 'sp-primary')}
            ${btn('undo', '', '⏪ 리와인드', st?.undo ? `${undoLabel(st)} 전으로 되돌려요` : '되돌릴 작업이 없어요 (마지막 저장·리셋·세이브 불러오기를 되돌려요)', st?.undo && !busy ? '' : 'sp-disabled')}
            ${hideButton(st, busy)}
            ${langButton(st, busy)}
        </div>
        ${ui.copyText ? `<div class="sp-copybox"><textarea readonly rows="8">${esc(ui.copyText)}</textarea>${btn('copy-close', '', '닫기')}</div>` : ''}
        ${busy ? `<div class="sp-progress"><span class="sp-spin">◐</span> ${esc(ui.progress)}${ui.req ? ` · <span class="sp-req">${esc(reqText())}</span>` : ''}</div>` : ''}
    </div>`;
}
// Whether the details under the status line are shown: the user's last choice, else open on wide
// screens and folded on phones.
function hudOpen() {
    if (ui.revealFailure) return true;
    const v = settings().hudOpen;
    return typeof v === 'boolean' ? v : !(typeof window !== 'undefined' && window.innerWidth <= 700);
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
    // The new-chat question goes away once the room has memory (loaded, saved) or is no longer new.
    if (document.getElementById('sp_resume')?.hidden === false && !resumeChoices().length) hideResume();
    if (!ui.open) return;
    // ui.tab belongs to ui.tabRoom; a render right after a room switch restores the new room's tab first.
    if (hasChat()) { if (ui.tabRoom !== roomKey()) restoreRoomTab(); else ui.roomTabs.set(roomKey(), ui.tab); }
    const win = $('#sp_overlay .sp-window');
    if (!win.length) return;
    if (!force && ui.edit && win.find('.sp-edit').length) return; // keep half-typed edits
    const st = state();
    const s = settings();
    win.attr('data-theme', s.theme in THEMES ? s.theme : 'jrpg');
    // ui.tab and the current room may already have changed. Save the old body under the
    // room/tab it actually displays, then restore the target's own position (initially top).
    const oldBody = win.find('.sp-body')[0];
    if (oldBody?.dataset.scrollKey) ui.scrollPositions.set(oldBody.dataset.scrollKey, oldBody.scrollTop);
    const scrollKey = JSON.stringify([roomKey(), ui.tab]);
    const scroll = ui.scrollPositions.get(scrollKey) ?? 0;
    const tabScroll = win.find('.sp-tabs').scrollLeft() || 0;
    const counts = st ? {
        queue: st.lootQueue?.length || 0, journal: st.mem.scenes.length, quests: st.mem.records.filter(r => r.type === 'quest' && r.status === 'open' && !r.track).length,
        party: st.mem.entities.filter(e => e.type === 'person').length, items: st.mem.records.filter(r => r.type === 'item' && !r.stored).length,
        world: st.mem.records.filter(r => r.type === 'world').length,
    } : {};
    // The save tab counts this room's QUICK + AUTO + FILE, like every other tab counts this room.
    if (hasChat()) counts.saves = listSaves().filter(x => x.room === roomKey()).length;
    // 💠 메인 shows how many things wait for a decision (queued loot, boxed items back in use).
    if (st) counts.main = (st.lootQueue?.length || 0) + returnNotices(st).length + foundQuests(st.mem).length;
    const tabs = TABS.map(([k, icon, label]) => `<button class="sp-tab ${ui.tab === k ? 'sp-active' : ''}" data-act="tab" data-id="${k}"><span class="sp-ti">${icon}</span><span>${label}</span>${counts[k] ? `<em${k === 'main' ? ' class="sp-em-alert"' : ''}>${counts[k]}</em>` : ''}</button>`).join('');
    let body;
    if (!hasChat()) body = '<div class="sp-empty">채팅방을 열면 그 방의 기억이 여기에 보여요.</div>';
    else {
        const view = st || { mem: emptyMem() };
        body = { main: mainHtml, queue: queueHtml, journal: journalHtml, timeline: timelineHtml, quests: questsHtml, party: partyHtml, items: itemsHtml, world: worldHtml, saves: savesHtml, inject: injectHtml }[ui.tab](view);
    }
    win.html(`<div class="sp-top">
            <div class="sp-logo"><span class="sp-logo-icon">◆</span> SAVE POINT <span class="sp-ver">v${VERSION}</span></div>
            <div class="sp-top-r"><span class="sp-room">${esc(charInfo()?.name || '')}</span>
                <button class="sp-btn sp-mini ${ui.qs ? 'sp-on' : ''}" data-act="qs" title="빠른 설정">⚙</button>
                <button class="sp-btn sp-mini" data-act="close" title="닫기">✕</button></div></div>
        ${ui.qs ? quickSettingsHtml() : ''}
        ${hasChat() ? hudHtml(st) : ''}
        <div class="sp-tab-nav"><button type="button" class="sp-tab-arrow" data-tab-scroll="prev" aria-label="이전 탭 보기" title="이전 탭 보기">‹</button><div class="sp-tabs">${tabs}</div><button type="button" class="sp-tab-arrow" data-tab-scroll="next" aria-label="다음 탭 보기" title="다음 탭 보기">›</button></div>
        <div class="sp-body" data-scroll-key="${esc(scrollKey)}">${body}</div>`);
    win.find('.sp-body').scrollTop(scroll);
    installTabNavigation(win.find('.sp-tab-nav .sp-tabs')[0], tabScroll);
    // A jump from the timeline: bring that part or quest into view and mark it briefly.
    if (ui.focus) {
        const el = document.getElementById(ui.focus);
        ui.focus = null;
        if (el) { el.scrollIntoView?.({ block: 'center' }); el.classList.add('sp-focus'); setTimeout(() => el.classList.remove('sp-focus'), 1800); }
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
        values = { type: r.type, text: r.text, entity: r.entity || '', holder: r.holder || '', aspect: r.aspect || 'relation', kind: r.kind || '', status: r.status || 'open', by: (r.by || []).join(','), to: (r.to || []).join(','),
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
    if (e.kind === 'reflink') {
        // Same check on a copy first: a bad date keeps the form open and changes nothing.
        const copy = clone(state().mem); linkReference(copy, e.id, v.date, v.day);
        ui.edit = null;
        return commitEdit(mem => linkReference(mem, e.id, v.date, v.day));
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
            if (!r) { r = { id: 'r' + (mem.next.r++), type: v.type, text: '', src: [], msgs: [], pin: false, manual: true, ...(v.type === 'quest' ? { questEvents: { created: null } } : {}) }; mem.records.push(r); }
            if (r.text !== trim(v.text)) { r.text = trim(v.text); delete r.ko; }
            if (r.type === 'party') { r.entity = v.entity || null; r.aspect = v.aspect === 'condition' ? 'condition' : 'relation'; }
            if (r.type === 'item') { r.entity = v.entity || null; r.holder = v.holder || null; }
            if (r.type === 'quest') { r.kind = QUEST_KINDS.includes(v.kind) ? v.kind : 'goal'; setQuestStatus(r, ['open', 'done', 'failed'].includes(v.status) ? v.status : 'open'); r.who ||= []; }
            if (r.type === 'quest') for (const k of ['by', 'to']) {
                const list = ['promise', 'debt'].includes(r.kind) ? String(v[k] || '').split(',').filter(id => mem.entities.some(x => x.id === id)) : [];
                if (list.length) r[k] = list; else delete r[k];
            }
            if (r.type === 'quest' && dueChanged) setManualDue(mem, r, { day: trim(v.dueDay), expr: trim(v.dueExpr) });
            if (r.type === 'world') { r.kind = WORLD_KINDS.includes(v.kind) ? v.kind : 'rule'; r.knownBy ||= []; }
        }
    });
}
async function handle(act, id) {
    const st = state();
    switch (act) {
        case 'close': return closeWindow();
        case 'hud-toggle': settings().hudOpen = !hudOpen(); ui.revealFailure = false; saveSettings(); return render(true);
        case 'tab':
            // The loot queue moved into 💠 메인; old shortcuts open it there.
            if (id === 'queue') { ui.tab = 'main'; ui.savesOpen.set('main-queue', true); ui.edit = null; return render(true); }
            // A tab chosen before the window first opens in this room wins over the "first tab" setting.
            ui.roomTabs ||= new Map(); if (hasChat()) { ui.roomTabs.set(roomKey(), id); ui.tabRoom = roomKey(); }
            ui.tab = id; ui.edit = null; if (id === 'inject') refreshInjection(); return render(true);
        case 'loot-retry': return retryLoot(id);
        case 'loot-delete':
            if (ui.run) return;
            return transact(() => { const st = state(); if (st) st.lootQueue = (st.lootQueue || []).filter(x => x.id !== id); }, { undoable: false, autosave: false });
        case 'ko': settings().showKo = !showKo(); saveSettings(); fillSettings(); return render(true);
        case 'run': return summarize();
        case 'run-close': return summarize({ close: true });
        case 'stop': cancelRun(); return;
        case 'undo': return undo();
        case 'hide-now': return hideRecorded();
        case 'hud-result': {
            const r = ui.hudResult; ui.hudResult = null; clearTimeout(hudResultTimer);
            if (r?.tone === 'warning') { ui.revealFailure = true; ui.savesOpen.set('hud-autofail', true); ui.savesOpen.set('hud-err', true); return render(true); }
            if (r?.goto && hasChat()) { openResult(r.goto); ui.tab = 'main'; ui.edit = null; }
            return render(true);
        }
        case 'hud-result-close': ui.hudResult = null; clearTimeout(hudResultTimer); return render();
        case 'translate': return translate();
        // One button for the language: 원문 ↔ 번역; in Korean view, untranslated items get a small "+N" button.
        case 'lang': {
            if (!showKo()) { settings().showKo = true; saveSettings(); fillSettings(); if (st && translationTargets(st.mem).length) return translate(); return render(true); }
            settings().showKo = false; saveSettings(); fillSettings(); return render(true);
        }
        case 'st-p': ui.savesOpen.set('stp:' + id, !ui.savesOpen.get('stp:' + id)); return render(true);
        case 'qs': ui.qs = !ui.qs; return render(true);
        case 'qs-full': { ui.qs = false; closeWindow(); openFullSettings(); return; }
        case 'test-connection': return testConnection();
        case 'review-accept': return acceptCurrentSource();
        case 'edit-cancel': ui.edit = null; return render(true);
        case 'edit-save': return saveEdit();
        case 'edit-scene': return startEdit('scene', id);
        case 'edit-point': return startEdit('point', id);
        case 'edit-notes': return startEdit('notes', id);
        case 'edit-segtime-start': if (ui.run) return; ui.timeGaps = null; return startEdit('segtime', id + '|start');
        case 'edit-segtime': if (ui.run) return; ui.timeGaps = null; return startEdit('segtime', id);
        case 'edit-scenetime': {
            // The scene line has no edge of its own. One unconfirmed edge opens directly; several are
            // listed on the card to choose from; none opens the last part's end.
            if (ui.run) return;
            const s = st?.mem.scenes.find(x => x.id === id); if (!s) return;
            const gaps = sceneTimeGaps(s);
            ui.savesOpen.set('scene:' + s.id, true);
            if (gaps.length > 1) { ui.timeGaps = s.id; return render(true); }
            const timed = s.segs.filter(g => g.time), g = gaps[0]?.g || timed[timed.length - 1]; if (!g) return;
            return startEdit('segtime', `${s.id}|${g.id}${gaps[0]?.edge === 'start' ? '|start' : ''}`);
        }
        case 'tl-goto': case 'tl-edit': {
            const [sid, gid] = id.split('|');
            const g = st?.mem.scenes.find(x => x.id === sid)?.segs.find(x => x.id === gid);
            if (!g) return;
            ui.tab = 'journal'; ui.savesOpen.set('scene:' + sid, true); ui.focus = 'sp-seg-' + gid;
            if (act === 'tl-goto' || ui.run || !g.time) return render(true);
            return startEdit('segtime', `${sid}|${gid}${g.time.start?.certainty === 'unconfirmed' ? '|start' : ''}`);
        }
        case 'ref-link': {
            if (ui.run) return;
            const sep = id.lastIndexOf('|'), anchor = id.slice(0, sep), dayIndex = Number(id.slice(sep + 1));
            const a = st?.mem.timeAnchors?.[anchor]; if (!a) return;
            const row = timelineRows(st.mem).find(x => x.ref?.anchor === anchor && x.day?.index === dayIndex);
            const label = a.link ? `이 기준 ${dayIndex - (a.baseDay || 0) + 1}일째` : row?.day?.label || '';
            const date = a.link ? (() => { const d = new Date(Date.parse(a.link.date + 'T00:00:00Z') + (dayIndex - a.link.day) * 86400000); return d.toISOString().slice(0, 10); })() : '';
            ui.edit = { kind: 'reflink', id: anchor, values: { date, day: dayIndex, label } };
            return render(true);
        }
        case 'tl-quest': ui.tab = 'quests'; ui.edit = null; ui.focus = 'sp-quest-' + id; return render(true);
        case 'edit-segoutline': return startEdit('segoutline', id);
        case 'edit-ent': return startEdit('entity', id);
        case 'edit-rec': return startEdit('record', id);
        case 'add-rec':
            ui.edit = { kind: 'record', id: 'new', values: { type: id, text: '', entity: '', holder: '', aspect: 'relation', kind: id === 'quest' ? 'promise' : id === 'world' ? 'rule' : '', status: 'open', dueExpr: '', dueDay: '' } };
            return render(true);
        case 'star': return commitEdit(m => { const s = m.scenes.find(x => x.id === id); if (!s) return false; s.star = !s.star; }, { undoable: false });
        case 'pin': return commitEdit(m => { const s = m.scenes.find(x => x.id === id); if (!s) return false; s.pin = !s.pin; }, { undoable: false });
        // 📦 Storing only changes what the roleplay model is given; the story's holder and place stay.
        case 'item-store': return commitEdit(m => { const r = m.records.find(x => x.id === id); if (!r || r.stored) return false; r.stored = { by: 'user', at: Date.now() }; delete r.storedUpdated; });
        case 'item-unstore': return commitEdit(m => { const r = m.records.find(x => x.id === id); if (!r?.stored) return false; delete r.stored; delete r.storedUpdated; delete r.returnNotice; });
        // 🔒 keeps a boxed item in the box whatever the box mode; "그대로 두기" answers a return notice.
        case 'item-lock': return commitEdit(m => { const r = m.records.find(x => x.id === id); if (r?.stored?.by !== 'user') return false; r.stored.lock = !r.stored.lock; if (r.stored.lock) delete r.returnNotice; else delete r.stored.lock; });
        case 'person-mode': {
            const [eid, mode] = id.split('|');
            return commitEdit(m => { const e = m.entities.find(x => x.id === eid); if (!e || (e.standby || '') === mode) return false; if (mode) e.standby = mode; else delete e.standby; });
        }
        case 'item-keep': return commitEdit(m => { const r = m.records.find(x => x.id === id); if (!r?.returnNotice) return false; delete r.returnNotice; });
        case 'pin-rec': return commitEdit(m => { const r = m.records.find(x => x.id === id); if (!r) return false; r.pin = !r.pin; }, { undoable: false });
        case 'quest-accept': case 'quest-decline':
            return commitEdit(m => { const r = m.records.find(x => x.id === id); if (!r || r.type !== 'quest') return false; delete r.autoDeclined; if (act === 'quest-accept') delete r.track; else r.track = 'declined'; });
        case 'quest-done': case 'quest-fail': case 'quest-open':
            return commitEdit(m => { const r = m.records.find(x => x.id === id); if (!r) return false; setQuestStatus(r, act === 'quest-done' ? 'done' : act === 'quest-fail' ? 'failed' : 'open'); });
        case 'del-scene':
            if (!(await confirmBox('이 장면을 저널에서 지울까요? 상태 탭의 항목은 그대로 남아요. (리와인드로 되돌릴 수 없어요)'))) return;
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
        case 'del-point':
            if (!(await confirmBox('이 포인트를 지울까요? (리와인드로 되돌릴 수 없어요)'))) return;
            return commitEdit(m => { const { g, j } = findPoint(m, id); if (!g) return false; g.points.splice(j, 1); });
        case 'del-rec':
            if (!(await confirmBox('이 항목을 지울까요? (리와인드로 되돌릴 수 없어요)'))) return;
            return commitEdit(m => { m.records = m.records.filter(x => x.id !== id); });
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
// ───────── ⚙ quick settings ─────────
// A short panel in the window for the settings changed most often; they are the same values as the
// extension settings panel. Settings that a running save reads (summarizer, box mode) wait for the
// next save so one save never mixes two models or rules.
const QS_DEFERRED = ['profileId', 'boxMode', 'questMode'];
function applyPendingSettings() {
    const p = ui.pendingSettings;
    if (!p) return;
    ui.pendingSettings = null;
    Object.assign(settings(), p); saveSettings(); fillSettings(); refreshInjection();
}
function quickSettingsHtml() {
    const s = { ...settings(), ...(ui.pendingSettings || {}) };
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const marks = exclusionRules().length;
    return `<div class="sp-qs"><div class="sp-qs-h"><b>⚙ 빠른 설정</b>${btn('qs', '', '✕', '닫기')}</div>
        <label class="sp-f"><span>스킨</span><select data-qs="theme">${opt(Object.entries(THEMES), s.theme)}</select></label>
        <label class="sp-f"><span>주입 상한 (토큰)</span><input type="number" data-qs="budget" min="300" max="100000" value="${esc(s.budget)}"></label>
        <label class="sp-qs-check"><input type="checkbox" data-qs="auto" ${s.auto ? 'checked' : ''}> 체크포인트 (자동 퀵세이브)</label>
        ${s.auto ? `<label class="sp-f"><span>체크포인트 간격 (새 메시지 수)</span><input type="number" data-qs="autoEvery" min="5" max="500" value="${esc(s.autoEvery)}"></label>` : ''}
        <label class="sp-f"><span>하이드</span><select data-qs="hideMode">${opt([['auto', '자동 · 세이브할 때마다'], ['manual', '수동 · 👻 버튼으로'], ['off', '끔 · 숨긴 원문 다시 표시']], hideModeOf(s))}</select></label>
        ${hideModeOf(s) !== 'off' ? `<label class="sp-f"><span>하이드하지 않을 최근 메시지</span><input type="number" data-qs="keepRecent" min="0" max="200" value="${esc(s.keepRecent)}"></label>` : ''}
        <label class="sp-f"><span>요약 AI</span><select data-qs="profileId">${opt([['', '메인 API'], ...profiles().map(p => [p.id, p.name])], s.profileId)}</select></label>
        <details class="sp-more" data-group="qs-more" ${ui.savesOpen.get('qs-more') ? 'open' : ''}><summary>더 보기</summary>
            <label class="sp-f"><span>최근 장면 수</span><input type="number" data-qs="recentScenes" min="0" max="20" value="${esc(s.recentScenes)}"></label>
            <label class="sp-f"><span>보관함 방식</span><select data-qs="boxMode">${opt([['notify', '알림 받고 결정'], ['auto', '자동 관리']], s.boxMode)}</select></label>
            <label class="sp-f"><span>퀘스트 등록</span><select data-qs="questMode">${opt(QUEST_MODES, s.questMode)}</select></label>
            <div class="sp-f"><span>기록에서 뺄 부분</span><div class="sp-row">${marks ? `<span>${marks}개 적용 중</span>` : '<span class="sp-dim">없음</span>'}${btn('qs-full', '', '편집 ↗', '전체 설정에서 편집해요')}</div></div>
        </details>
        ${ui.run ? '<div class="sp-set-note">저장 중이에요. 요약 AI·보관함 방식·퀘스트 등록은 다음 저장부터 적용돼요.</div>' : ''}
        <div class="sp-row sp-qs-foot">${btn('qs-full', '', '전체 설정 열기 ↗', '실리태번 확장 설정의 SavePoint를 열어요')}</div></div>`;
}
function setQuick(key, raw, el) {
    const s = settings();
    const value = el?.type === 'checkbox' ? el.checked : el?.type === 'number' ? Number(raw) : raw;
    if (el?.type === 'number' && !Number.isFinite(value)) return;
    if (ui.run && QS_DEFERRED.includes(key)) { (ui.pendingSettings ||= {})[key] = value; toastr.info('저장이 끝난 뒤 적용할게요.', 'SavePoint'); render(); return; }
    s[key] = value; fillSettings();
    // v0.6.54: hide and checkpoint settings take effect the same way as in the full settings.
    if (['hideMode', 'keepRecent', 'auto', 'autoEvery'].includes(key)) return settingsChanged([key]);
    saveSettings();
    if (['budget', 'recentScenes'].includes(key)) refreshInjection();
    render(true);
}
// Opens SillyTavern's extension settings and scrolls to SavePoint (best effort: the panel's markup
// belongs to SillyTavern).
function openFullSettings() {
    const drawer = document.querySelector('#extensions-settings-button .drawer-toggle');
    const content = document.querySelector('#rm_extensions_block');
    if (drawer && content && !content.classList.contains('openDrawer')) drawer.click();
    setTimeout(() => {
        const box = document.getElementById('sp_settings');
        const inner = box?.querySelector('.inline-drawer-content');
        if (inner && getComputedStyle(inner).display === 'none') box.querySelector('.inline-drawer-toggle')?.click();
        box?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        if (!box) toastr.info('실리태번 확장 설정(블록 아이콘)에서 ◆ SavePoint를 열어 주세요.', 'SavePoint');
    }, 250);
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
                <label title="요청 한 번에 담을 대화 원문의 양이에요(최대 20개 메시지). 늘리면 요청 횟수와 반복되는 지침·장면 분량이 줄고, 대신 한 요청이 길어져요. 입력 한도는 그대로 지켜요.">한 번에 기록할 원문 분량 (글자) <input type="number" data-set="sourceChars" min="2000" max="200000"></label>
                <label title="실시간 수신 중에는 새 사고·본문이 들어올 때마다 이 시간을 다시 세요. 실시간 수신을 확인할 수 없는 요청(메인 API, 실시간 받기 끔)에는 요청 전체의 제한 시간이 돼요.">요청 대기 제한 (초) <input type="number" data-set="timeoutSec" min="5" max="3600"></label>
                <label title="실시간 수신 중 출력이 계속 들어와도 이 시간이 지나면 중단해요.">전체 최대 시간 (분) <input type="number" data-set="timeoutTotalMin" min="1" max="120"></label>
                <div class="sp-set-note">새 출력이 들어오는 동안 대기 제한을 연장해요. 전체 최대 시간에 도달하면 중단해요. 중단된 구간은 저장하지 않고 원문을 그대로 두며, 늦게 도착한 응답은 버려요.</div>
            `)}
            ${settingSection('recording', `
                <label class="checkbox_label"><input type="checkbox" data-set="check"> 기록 후 확인 (모순·원문과 다른 해석을 찾아 경고 · 분량에 따라 추가 요청)</label>
                <label class="checkbox_label"><input type="checkbox" data-set="auto"> 체크포인트 (새 메시지 N개마다 자동 퀵세이브)</label>
                <label>체크포인트 간격 (새 메시지 수, 유저+캐릭터) <input type="number" data-set="autoEvery" min="5" max="500"></label>
                <div class="sp-set-note">마지막 시도 뒤 새 메시지가 간격만큼 쌓이면 실행해요. 저장할 내용은 요청마다 최대 20개·원문 분량 설정(기본 12,000자) 안에서 고르게 나눠 처리해요. 일부 실패도 다음 간격에 이어서 처리하며, 퀵세이브로 바로 저장할 수 있어요.</div>
                <label>체크포인트 여유분 <input type="number" data-set="autoReserve" min="0" max="20"></label>
                <div class="sp-set-note">체크포인트가 기록하지 않고 남겨 둘 최근 메시지 수예요. 스와이프·수정에 대비해요. 퀵세이브는 마지막 메시지까지 기록해요.</div>
                <label>퀘스트 등록 <select data-set="questMode">${QUEST_MODES.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
                <div class="sp-set-note">확인 후 등록이면 새로 발견한 퀘스트가 💠 메인의 <b>❗ 발견한 퀘스트</b>에 모이고, 근거를 보고 수락·거절해요. 거절은 퀘스트로 관리하지 않는다는 뜻이에요. 원문과 기존 저널은 유지돼요.</div>
                <label data-reset-host="excludeMarks">기록에서 뺄 부분 (한 줄에 하나)</label>
                <textarea data-set="excludeMarks" rows="3" class="text_pole" placeholder="thoughts&#10;[생각] ~ [/생각]"></textarea>
                <div class="sp-set-note">태그 이름을 적으면 그 태그 블록을 통째로, <code>시작 ~ 끝</code>으로 적으면 그 사이를 요약 AI에게 보내지 않아요. 채팅 원문은 그대로이고, 적은 뒤 새로 기록하는 것부터 적용돼요.</div>
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
                <label>하이드 방식 <select data-set="hideMode">${HIDE_MODES.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
                <div class="sp-set-note">수동이면 기록은 그대로 하고, 기록된 원문은 위쪽 상태 칸의 <b>👻 하이드</b>를 누를 때만 숨겨요. 누른 뒤 새로 기록한 메시지는 다음에 누를 때까지 보여요. 끄면 SavePoint가 숨긴 메시지만 다시 보여요(직접 숨긴 메시지는 그대로).</div>
                <label>하이드하지 않을 최근 메시지 <input type="number" data-set="keepRecent" min="0" max="200"></label>
                <div class="sp-set-note">전체 대화에서 숨기지 않을 최근 메시지 수예요. 자동·수동 모두 지켜요. 미저장 메시지는 이 설정과 관계없이 숨기지 않아요.</div>
                <label>오토세이브를 보관할 방 수 (방마다 최근 3개) <input type="number" data-set="autoKeep" min="1" max="500"></label>
                <label>보관함 방식 (직접 보관한 물건이 다시 쓰일 때) <select data-set="boxMode"><option value="notify">알림 받고 결정 · 보관함에 두고 꺼내기 안내</option><option value="auto">자동 관리 · 인벤토리로 꺼냄</option></select></label>
                <div class="sp-set-note">이야기가 넣은 물건(다 쓰거나 잃어버린 것)은 되찾으면 방식과 상관없이 돌아와요. 🔒를 건 물건은 항상 보관함에 두고 알림도 띄우지 않아요. 방식을 바꿔도 이미 보관함에 있는 물건을 한꺼번에 꺼내지 않아요.</div>
                <label class="checkbox_label"><input type="checkbox" data-set="askResume"> 새 채팅에서 이어하기 물어보기 (같은 캐릭터의 다른 방에 세이브가 있을 때)</label>
            `)}
            ${settingSection('appearance', `
                <label>스킨 <select data-set="theme">${Object.entries(THEMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
                <label>처음 여는 탭 <select data-set="firstTab">${Object.entries(FIRST_TABS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
                <label class="checkbox_label"><input type="checkbox" data-set="showKo"> 한국어 보기</label>
            `)}
            ${settingSection('advanced', `
                <div class="sp-set-note">요약 AI에게 주는 기록 지침이에요. 데이터 목록과 응답 형식은 지침 뒤에 자동으로 붙어서, 고쳐도 저장 형식은 깨지지 않아요. 다만 <b>한 번 고치면 그 뒤 버전에서 좋아진 기본 지침이 자동으로 적용되지 않아요.</b> 지운 규칙만큼 기록 품질이 달라질 수 있어요.</div>
                <label data-reset-host="guide">기록 지침 (영어 권장, {{char}} {{user}} 사용 가능)</label>
                <textarea data-set="guide" rows="10" class="text_pole"></textarea>
                <div class="sp-set-note" id="sp_guide_note"></div>
            `)}
        </div></div></div>`;
}
// 'default' (follows new versions), 'edited' (edited from the current default), 'stale' (edited from
// an older default, or before v0.6.39 when the base was not noted).
function guideState() {
    const s = settings();
    if (!s.guide || s.guide === DEFAULT_GUIDE) return 'default';
    return s.guideBase === guideHash(DEFAULT_GUIDE) ? 'edited' : 'stale';
}
function updateSettingsSummaries() {
    const gs = guideState();
    $('#sp_guide_note').html(gs === 'default' ? '기본 지침을 쓰는 중이에요. 새 버전에서 기본 지침이 바뀌면 자동으로 따라가요.'
        : gs === 'edited' ? '직접 고친 지침을 쓰는 중이에요. ↺로 기본 지침으로 돌아갈 수 있어요.'
        : '<span class="sp-warn">⚠ 직접 고친 지침을 쓰는 동안 기본 지침이 새로 바뀌었어요(또는 고친 시점을 알 수 없어요).</span> ↺를 누르면 새 기본 지침으로 바뀌어요. 고친 내용은 사라지니 필요하면 먼저 복사해 두세요.');
    const s = settings();
    const summaries = {
        connection: `${profileLabel()} · 대기 ${s.timeoutSec}초 · 최대 ${s.timeoutTotalMin}분`,
        recording: `${s.auto ? s.autoEvery + '개마다 · 여유분 ' + s.autoReserve + '개' : '체크포인트 꺼짐'} · 확인 ${s.check ? '켜짐' : '꺼짐'}${exclusionRules().length ? ` · 뺄 부분 ${exclusionRules().length}개` : ''} · 퀘스트 ${s.questMode === 'confirm' ? '확인 후' : '자동'}`,
        injection: `${Number(s.budget).toLocaleString()}토큰 · 최근 ${s.recentScenes}장면`,
        storage: `${hideModeOf(s) === 'off' ? '하이드 꺼짐' : `하이드 ${hideModeOf(s) === 'manual' ? '수동' : '자동'} · 최근 ${s.keepRecent}개 남김`} · 보관 ${s.autoKeep}개 방`,
        appearance: `${THEMES[s.theme] || THEMES.jrpg} · ${s.showKo ? '한국어' : 'EN'}`,
        advanced: guideState() === 'default' ? '기본 지침' : guideState() === 'stale' ? '⚠ 새 기본 지침 있음' : '직접 고친 지침',
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
    // v0.6.49: a switch to manual starts from what is hidden now (older manual ranges no longer count).
    if (keys.includes('hideMode') && settings().hideMode === 'manual') settings().hideManualAt = Date.now();
    saveSettings();
    if (keys.some(k => ['hideMode', 'keepRecent', 'enabled'].includes(k))) syncHide();
    if (keys.some(k => ['auto', 'autoEvery', 'autoReserve', 'enabled'].includes(k))) scheduleAuto();
    if (keys.includes('enabled')) { installLootBar(); paintKeep(); }
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
        const named = $(`#sp_settings [data-reset-host="${k}"]`);
        const host = named.length ? named : $(this).closest('label');
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
        if (k === 'guide') s.guideBase = guideHash(DEFAULT_GUIDE);   // which default this edit started from
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
        el.innerHTML = '<span class="sp-sb-icon"></span><div class="sp-sb-text"><div class="sp-sb-title"></div><div class="sp-sb-sub"></div><div class="sp-sb-news" hidden></div></div><button type="button" class="sp-sb-close" aria-label="배너 닫기" title="닫기" hidden>✕</button>';
        // v0.6.53: ✕ closes a result (not a running save, whose banner is a warning about leaving the room).
        el.querySelector('.sp-sb-close').onclick = e => { e.stopPropagation(); clearTimeout(bannerTimer); delete el.dataset.flash; delete el.dataset.flashRoom; el.hidden = true; };
        el.onclick = () => {
            // A failure notice opens the window with the failure details unfolded, and is then done.
            if (el.dataset.tone === 'warning') { ui.revealFailure = true; ui.savesOpen.set('hud-autofail', true); ui.savesOpen.set('hud-err', true); }
            // New found quests: open 💠 메인 with the list unfolded.
            if (el.dataset.flash && el.dataset.goto && hasChat()) openResult(el.dataset.goto);
            if (el.dataset.flash) { clearTimeout(bannerTimer); delete el.dataset.flash; delete el.dataset.flashRoom; el.hidden = true; }
            openWindow();
        };
        document.body.append(el);
        // On phones the on-screen keyboard scrolls the page under a fixed banner; keep it inside the
        // part of the page that is actually visible.
        window.visualViewport?.addEventListener?.('resize', () => placeSaveBanner(el));
        window.visualViewport?.addEventListener?.('scroll', () => placeSaveBanner(el));
        document.addEventListener?.('visibilitychange', showPendingBanner);
    }
    el.setAttribute('data-theme', settings().theme in THEMES ? settings().theme : 'jrpg');
    return el;
}
function placeSaveBanner(el) {
    if (!el || el.hidden) return;
    const top = window.visualViewport?.offsetTop || 0;
    el.style.top = top > 1 ? `${Math.round(top + 8)}px` : '';
}
// A result that arrives while the page is not visible (phone locked, another app) waits until it is.
let pendingBanner = null;
function showPendingBanner() {
    if (document.hidden || !pendingBanner) return;
    const p = pendingBanner; pendingBanner = null;
    if (p.room === String(roomKey())) flashSaveBanner(p.text, { tone: p.tone, goto: p.goto, news: p.news });
}
function setBanner(el, { icon, title, count = '', sub, news = '', closable = false }) {
    el.querySelector('.sp-sb-icon').className = `sp-sb-icon ${icon}`;
    el.querySelector('.sp-sb-title').innerHTML = `${esc(title)}${count ? ` <b>${esc(count)}</b>` : ''}`;
    el.querySelector('.sp-sb-sub').textContent = sub;
    el.querySelector('.sp-sb-sub').hidden = !sub;
    const n = el.querySelector('.sp-sb-news'); n.innerHTML = newsHtml(news); n.hidden = !news;
    el.querySelector('.sp-sb-close').hidden = !closable;
    el.hidden = false;
    placeSaveBanner(el);
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
    setBanner(el, { icon: 'sp-sb-spin', title: text[0], count: m ? `${m[1]}/${m[2]}` : '', sub: text[1] });
}
// `NEW 🎒 2 · 👥 1 · ❗ …` with the NEW part styled like the badge on 💠 메인.
function newsHtml(news) {
    if (!news) return '';
    const rest = String(news).replace(/^NEW\s*/, '');
    return `${newBadge}${rest.split(' · ').map(p => `<span class="sp-news-p">${esc(p)}</span>`).join('<span class="sp-dim"> · </span>')}`;
}
// A tap on a result: 💠 메인 with the last save's changes unfolded (and found quests, when there are).
function openResult(goto) {
    (ui.roomTabs ||= new Map()).set(roomKey(), 'main');
    ui.savesOpen.set('main-changes', true);
    if (goto === 'main-quests') ui.savesOpen.set('main-quests', true);
}
const RESULT_MS = 6000;
function flashSaveBanner(text, { tone = 'success', goto = '', news = '' } = {}) {
    const el = saveBanner();
    if (!el) return;
    clearTimeout(bannerTimer);
    if (!settings().enabled) { delete el.dataset.flash; el.hidden = true; return; }
    // A result that arrives while the page is not seen waits, and its time starts when it is seen.
    if (typeof document !== 'undefined' && document.hidden) { pendingBanner = { text, tone, goto, news, room: String(roomKey()) }; return; }
    // v0.6.53: with the window open, the same result is one line at the top of its status panel.
    if (ui.open) { delete el.dataset.flash; el.hidden = true; showHudResult(text, { tone, goto, news }); return; }
    const [title, ...rest] = text.split(' · ');
    el.dataset.flash = '1'; el.dataset.flashRoom = String(roomKey());
    el.dataset.tone = tone; el.dataset.goto = goto || '';
    setBanner(el, { icon: tone === 'warning' ? 'sp-sb-warn' : tone === 'info' ? 'sp-sb-info' : 'sp-sb-done', title, news, closable: true,
        sub: [...rest, ...(tone === 'warning' ? ['눌러서 자세히 보기'] : news ? ['눌러서 최근 변화 보기'] : [])].join(' · ') });
    // A failure stays until it is tapped or closed, a new save starts, or the room changes; other results fade.
    if (tone !== 'warning') bannerTimer = setTimeout(() => { delete el.dataset.flash; delete el.dataset.flashRoom; updateSaveBanner(); }, news ? RESULT_MS : 3500);
}
let hudResultTimer = null;
function showHudResult(text, { tone, goto, news }) {
    clearTimeout(hudResultTimer);
    ui.hudResult = { text, tone, goto, news, room: String(roomKey()) };
    if (tone !== 'warning') hudResultTimer = setTimeout(() => { ui.hudResult = null; if (ui.open) render(); }, news ? RESULT_MS : 3500);
    render();
}
function hudResultHtml() {
    const r = ui.hudResult;
    if (!r || r.room !== String(roomKey())) return '';
    const [title] = r.text.split(' · ');
    return `<div class="sp-hud-result sp-hud-result-${r.tone === 'warning' ? 'warn' : 'ok'}"><button type="button" class="grow" data-act="hud-result">${r.tone === 'warning' ? '⚠' : '✔'} ${esc(title)}${r.news ? ` <span class="sp-dim">·</span> ${newsHtml(r.news)}` : ''}</button><button type="button" class="x" data-act="hud-result-close" aria-label="닫기" title="닫기">✕</button></div>`;
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
        if (it) toastr.info(`이 방의 지난 저장이 방을 옮기면서 중간에 멈췄어요 (#${it.from}부터 미저장). SavePoint에서 퀵세이브로 이어서 기록할 수 있어요.`, 'SavePoint', { timeOut: 10000 });
    }
    refreshInjection(); render(true); installLootBar(); updateSaveBanner();
    hideResume(); clearTimeout(resumeTimer);
    const epoch = roomEpoch;
    resumeTimer = setTimeout(() => { if (epoch === roomEpoch) offerResume(); }, 700);
}
// ───────── new chat: continue or start fresh ─────────
// A new chat of a character that has saves in other rooms gets a small choice near the top:
// 이어하기 (pick one of those saves) or 새로 하기 (nothing changes; not asked again in this room).
let resumeTimer = null;
function resumeChoices() {
    const s = settings();
    if (!s.enabled || !s.askResume || !hasChat() || ui.run) return [];
    const room = roomKey();
    if (s.resumeDismissed?.[room] || hasMemory(state()?.mem)) return [];
    const list = chat();
    if (list.length > 1 || (list.length === 1 && list[0].is_user)) return [];
    const all = listSaves();
    // v0.6.48: a room that has its own saves (QUICK, AUTO or FILE) is not a new chat, even when its
    // messages or memory are not on the page yet (seen while a long chat was still opening).
    if (all.some(x => x.room === room)) return [];
    const charKey = charInfo()?.key || '';
    const saves = all.filter(x => x.room !== room && roomChar(x.room) === charKey);
    // QUICK first (newest), then FILE slots, then the newest AUTO of each room.
    const seen = new Set();
    const autos = saves.filter(x => x.auto).sort((a, b) => b.updated - a.updated).filter(x => !seen.has(x.room) && seen.add(x.room));
    return [...saves.filter(x => x.quick).sort((a, b) => b.updated - a.updated),
        ...saves.filter(x => !x.auto && !x.quick).sort((a, b) => b.updated - a.updated), ...autos].slice(0, 8);
}
function hideResume() { const el = document.getElementById('sp_resume'); if (el) el.hidden = true; }
function offerResume(open = false) {
    const choices = resumeChoices();
    let el = document.getElementById('sp_resume');
    if (!choices.length) { if (el) el.hidden = true; return; }
    if (!el) { el = document.createElement('div'); el.id = 'sp_resume'; el.className = 'sp-window sp-resume-prompt'; document.body.appendChild(el); }
    el.setAttribute('data-theme', settings().theme in THEMES ? settings().theme : 'jrpg');
    const row = sv => `<button class="sp-resume-pick interactable" data-resume="${esc(sv.id)}"><span class="sp-slot">${slotKind(sv)}</span>
        <span class="sp-resume-t">${saveTitle(sv) ? `🎬 ${esc(saveTitle(sv))}` : esc(sv.name)}</span><span class="sp-resume-m">🗝️ ${esc(roomLabel(sv.room))} · ${fmtDate(sv.updated)}</span></button>`;
    el.innerHTML = `<div class="sp-resume-h"><b>이어서 할까요?</b><span class="sp-dim">${esc(charInfo()?.name || '이 캐릭터')}의 다른 방에 세이브가 있어요.</span></div>
        ${open ? `<div class="sp-resume-list">${choices.map(row).join('')}</div>` : ''}
        <div class="sp-resume-btns">${open ? '' : '<button class="sp-btn sp-primary interactable" data-resume-act="open">▶ 불러오기</button>'}<button class="sp-btn interactable" data-resume-act="fresh">✦ 새로 하기</button><button class="sp-btn interactable" data-resume-act="later" title="닫기 (다음에 이 방을 열면 다시 물어요)">✕</button></div>`;
    el.hidden = false;
    el.onclick = async e => {
        // The room may have finished opening since the question appeared: ask again before acting.
        if (!resumeChoices().length) { hideResume(); return; }
        const pick = e.target.closest('[data-resume]'), act = e.target.closest('[data-resume-act]')?.dataset.resumeAct;
        if (pick) { hideResume(); await loadSave(pick.dataset.resume); return; }
        if (act === 'open') return offerResume(true);
        if (act === 'fresh') {
            const d = settings().resumeDismissed ||= {};
            d[roomKey()] = Date.now();
            // Keep the list short: only the most recent rooms are remembered.
            const keys = Object.keys(d).sort((a, b) => d[b] - d[a]);
            for (const k of keys.slice(300)) delete d[k];
            saveSettings();
        }
        hideResume();
    };
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
        // v0.6.55: ⏪ and 👻 explain why they can't run instead of doing nothing.
        if (this.classList.contains('sp-disabled') && !['undo', 'hide-now'].includes(this.dataset.act)) return;
        handle(this.dataset.act, this.dataset.id).catch(reportError);
    });
    $(document).on('input change', '#sp_overlay [data-edit]', function () { if (ui.edit) ui.edit.values[this.dataset.edit] = this.value; });
    $(document).on('change', '#sp_overlay [data-qs]', function () { setQuick(this.dataset.qs, this.value, this); });
    document.addEventListener('toggle', e => { const d = e.target; if (d?.matches?.('#sp_overlay details[data-group]')) ui.savesOpen.set(d.dataset.group, d.open); }, true);
    $(document).on('click', '#sp_overlay', e => { if (e.target.id === 'sp_overlay') closeWindow(); });
    $(document).on('keydown.savePoint', e => { if (e.key === 'Escape' && ui.open && !document.querySelector('dialog[open]')) closeWindow(); });
    const { eventSource, event_types: ev } = ctx();
    const on = (t, f) => { if (ev[t]) eventSource.on(ev[t], f); };
    on('CHAT_CHANGED', onChatChanged);
    // 🔖: before the source checks, so a swipe of a kept message is still kept when they run.
    for (const t of ['MESSAGE_SWIPED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED']) on(t, id => { if (repairKeep(id)) syncHide(); paintKeepSoon(); });
    for (const t of ['CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED']) on(t, paintKeepSoon);
    $(document).on('click', '#chat .sp-keep-btn', function (e) {
        e.preventDefault(); e.stopPropagation();
        const i = Number($(this).closest('.mes').attr('mesid'));
        if (Number.isInteger(i)) toggleKeep(i).catch(reportError);
    });
    $(document).on('keydown', '#chat .sp-keep-btn', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(this).trigger('click'); } });
    for (const t of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPE_DELETED']) on(t, onSourceChanged);
    globalThis.document?.addEventListener?.('selectionchange', trackSelection);
    installLootBar();
    on('GENERATION_STARTED', onGenerationStarted);
    for (const t of ['GENERATION_ENDED', 'GENERATION_STOPPED']) on(t, onGenerationEnded);
    for (const t of ['CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_CREATED']) on(t, () => { fillProfiles(); updateSettingsSummaries(); });
    onChatChanged(); paintKeepSoon();
    // Server-side save slots: the server index is the list; then move any settings-only slots over.
    vault.init(settings().slotCache).then(migrateLocal).catch(e => console.warn('[SavePoint] vault', e)).finally(() => render(true));
});

// Exposed for regression checks only.
globalThis.__savePoint = { toggleKeep, paintKeep, repairKeep, state, settings, summarize, listSaves, vault, migrateLocal, autoCollect, autoBlocked, autoCount, scheduleAuto, undo, loadSave, reconcile, syncHide, refreshInjection, handle, ui, render, estTokens, recordLine, reportText, addLoot, queueHtml, installLootBar, openLootDialog, fillSettings };
