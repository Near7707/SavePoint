// SavePoint Hide Probe — an experiment, not part of SavePoint.
// Question: can a message be left out of the AI request (generate_interceptor) while the chat file
// stays untouched? This extension never writes the chat file: marks live in the extension settings,
// the chat view only gets a CSS class, and the request list is trimmed in memory.
import { markOf, findMarked, planRemoval, applyRemoval, parseIds } from './probe-core.js';

const NAME = 'savepointHideProbe';
const LOG_MAX = 12;
const ctx = () => SillyTavern.getContext();

function store() {
    const all = ctx().extensionSettings;
    all[NAME] ??= { enabled: true, rooms: {}, log: [] };
    const s = all[NAME];
    s.rooms ??= {}; s.log ??= [];
    return s;
}
const save = () => ctx().saveSettingsDebounced();

function roomKey() {
    const c = ctx();
    const id = c.getCurrentChatId?.();
    if (!id) return null;
    const who = c.groupId ? `g:${c.groupId}` : `c:${c.characters?.[c.characterId]?.avatar ?? c.characterId}`;
    return `${who}/${id}`;
}
function marks() { const k = roomKey(); return k ? (store().rooms[k] ?? []) : []; }
function setMarks(list) {
    const k = roomKey();
    if (!k) return;
    if (list.length) store().rooms[k] = list; else delete store().rooms[k];
    save();
}

const preview = (m, n = 40) => String(m?.mes ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const WHY = {
    'already-hidden': '이미 숨김(/hide·SavePoint) — 실리태번이 먼저 뺌',
    'not-in-request': '요청 목록에 없음(스와이프 대상 등)',
    'continue-target': '이어쓰기 대상이라 남김',
    'tool-kept': '도구 호출 메시지 — 실리태번이 요청에 넣어서 남김(실험 대상 아님)',
    ambiguous: '같은 시각·이름 메시지가 여럿이라 구분 못 해 남김',
    gone: '메시지를 찾지 못함(지워짐)',
};

// ───────── the interceptor
globalThis[NAME] = async function (core, _contextSize, _abort, type) {
    try {
        const s = store();
        if (!s.enabled) return;
        const list = marks();
        if (!list.length) return;
        const chat = ctx().chat;
        const before = core.length;
        const plan = planRemoval(chat, core, list, type);
        applyRemoval(core, plan.remove);
        const hiddenFlags = plan.removed.filter(r => chat[r.i]?.is_system).length;
        addLog({
            at: new Date().toLocaleString(), type: type ?? 'normal', room: roomKey(),
            before, after: core.length,
            removed: plan.removed.map(r => `#${r.i} ${preview(chat[r.i])}`),
            skipped: plan.skipped.map(x => `${x.i === undefined ? '?' : '#' + x.i} ${WHY[x.why] ?? x.why}`),
            touchedFile: hiddenFlags ? `경고: 뺀 메시지 중 ${hiddenFlags}개에 숨김 표시가 있음` : '채팅 메시지 표시 변경 없음',
        });
    } catch (e) {
        console.error('[Hide Probe] interceptor failed', e);
        addLog({ at: new Date().toLocaleString(), type: type ?? 'normal', error: String(e?.message ?? e) });
    }
};

function addLog(entry) {
    const s = store();
    s.log.unshift(entry);
    s.log.length = Math.min(s.log.length, LOG_MAX);
    save();
    renderPanel();
}

// ───────── chat view marks (screen only)
function paint() {
    $('#chat .mes.hp-hidden').removeClass('hp-hidden');
    const chat = ctx().chat ?? [];
    for (const mark of marks()) {
        const at = findMarked(chat, mark);
        if (at.i !== undefined) $(`#chat .mes[mesid="${at.i}"]`).addClass('hp-hidden');
    }
}

// ───────── actions
function hideIds(ids) {
    const chat = ctx().chat ?? [];
    const list = [...marks()];
    for (const i of ids) {
        const m = chat[i];
        if (!m) continue;
        if (list.some(mk => findMarked(chat, mk).i === i)) continue;
        list.push(markOf(m, chat));
    }
    setMarks(list);
}
function showIds(ids) {
    const chat = ctx().chat ?? [];
    const drop = new Set(ids);
    setMarks(marks().filter(mk => !drop.has(findMarked(chat, mk).i)));
}

function readIds() {
    const text = $('#hp_ids').val();
    const ids = parseIds(text, (ctx().chat ?? []).length);
    if (!ids || !ids.length) { toastr.warning('번호를 "2-5, 8"처럼 적어 주세요.'); return null; }
    return ids;
}

function resultText() {
    const s = store();
    const lines = ['Hide Probe 0.1.1', `방: ${roomKey() ?? '-'}`, `실험 숨김: ${listText().join(', ') || '없음'}`, ''];
    for (const e of s.log) {
        lines.push(`[${e.at}] ${e.type}${e.error ? ` 오류: ${e.error}` : ` · 목록 ${e.before} → ${e.after}`}`);
        for (const r of e.removed ?? []) lines.push(`  뺌 ${r}`);
        for (const r of e.skipped ?? []) lines.push(`  남김 ${r}`);
        if (e.touchedFile) lines.push(`  ${e.touchedFile}`);
    }
    return lines.join('\n');
}
async function copyResults() {
    const text = resultText();
    try { await navigator.clipboard.writeText(text); toastr.success('결과를 복사했어요.'); }
    catch {
        const t = document.createElement('textarea');
        t.value = text; document.body.append(t); t.select();
        try { document.execCommand('copy'); toastr.success('결과를 복사했어요.'); } catch { toastr.error('복사하지 못했어요.'); }
        t.remove();
    }
}

// ───────── panel
function listText() {
    const chat = ctx().chat ?? [];
    return marks().map(mk => {
        const at = findMarked(chat, mk);
        return at.i === undefined ? `? (${WHY[at.miss] ?? at.miss})` : `#${at.i}`;
    });
}

function renderPanel() {
    const box = $('#hp_panel');
    if (!box.length) return;
    const s = store();
    $('#hp_enabled').prop('checked', !!s.enabled);
    $('#hp_list').text(roomKey() ? (listText().join(', ') || '없음') : '열린 방 없음');
    const log = s.log.slice(0, 5).map(e => {
        const head = `${e.at} · ${e.type}${e.error ? ` · 오류: ${e.error}` : ` · 목록 ${e.before} → ${e.after}`}`;
        const rows = [...(e.removed ?? []).map(r => `뺌 ${r}`), ...(e.skipped ?? []).map(r => `남김 ${r}`)];
        return `${head}\n${rows.map(r => '  ' + r).join('\n')}`;
    }).join('\n\n');
    $('#hp_log').text(log || '아직 기록 없음 — 답변을 만들면 여기에 뭘 뺐는지 나와요.');
    paint();
}

function mountPanel() {
    if ($('#hp_panel').length) return;
    const html = `
    <div id="hp_panel" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🧪 SavePoint 하이드 실험</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <small>고른 메시지를 <b>AI 요청에서만</b> 빼요. 채팅 파일과 메시지 숨김 표시는 건드리지 않아요. 테스트용 방에서만 써 주세요.</small>
            <label class="checkbox_label"><input id="hp_enabled" type="checkbox"> 켜기</label>
            <div class="hp-row">
                <input id="hp_ids" class="text_pole" type="text" placeholder="예: 2-5, 8">
                <div id="hp_hide" class="menu_button">빼기</div>
                <div id="hp_show" class="menu_button">되돌리기</div>
                <div id="hp_clear" class="menu_button">이 방 전부 해제</div>
            </div>
            <div>이 방 실험 숨김: <span id="hp_list"></span></div>
            <div class="hp-row">
                <div id="hp_copy" class="menu_button">📋 결과 복사</div>
                <div id="hp_clear_log" class="menu_button">기록 지우기</div>
            </div>
            <pre id="hp_log" class="hp-log"></pre>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#hp_enabled').on('change', function () { store().enabled = this.checked; save(); });
    $('#hp_hide').on('click', () => { const ids = readIds(); if (ids) { hideIds(ids); renderPanel(); } });
    $('#hp_show').on('click', () => { const ids = readIds(); if (ids) { showIds(ids); renderPanel(); } });
    $('#hp_clear').on('click', () => { setMarks([]); renderPanel(); });
    $('#hp_copy').on('click', copyResults);
    $('#hp_clear_log').on('click', () => { store().log = []; save(); renderPanel(); });
}

jQuery(() => {
    mountPanel();
    renderPanel();
    const { eventSource, eventTypes: t } = ctx();
    const redraw = () => setTimeout(renderPanel, 0);
    for (const ev of ['CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_DELETED',
        'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MORE_MESSAGES_LOADED']) {
        if (t?.[ev]) eventSource.on(t[ev], redraw);
    }
});
