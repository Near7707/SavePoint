// SavePoint vault: save slots and autosaves stored as files in the SillyTavern server's
// user files folder (data/<user>/user/files/), independent of settings.json.
//
// Rules
// - savepoint-index.json is the one authoritative list. The copy in settings is only a cache
//   that is overwritten from it; the two are never updated separately.
// - Every change: write the new content file -> write the index -> delete files no longer
//   listed. Before an index is overwritten, the previous one is kept as savepoint-index.prev.json.
// - Autosaves use fixed names per room (savepoint-auto-<room>-0..3.json), so a room's autosaves
//   can be found by opening that room even if both index files are lost. Four names rotate
//   while three are kept, so a new autosave never overwrites one that is still listed.
// - The server has no "list folder" API. Manual slots can only be found through an index file;
//   without one they must be imported by hand from the server folder.

export const INDEX = 'savepoint-index.json';
export const PREV_INDEX = 'savepoint-index.prev.json';
export const AUTO_KEEP = 3;
const AUTO_NAMES = 4;

const clone = v => structuredClone(v);
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v);

function hash(text) {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        const n = text.charCodeAt(i);
        a = Math.imul(a ^ n, 16777619);
        b = Math.imul(b, 33) ^ n;
    }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
export const roomHash = roomKey => hash(String(roomKey || ''));
export const autoName = (rh, k) => `savepoint-auto-${rh}-${k}.json`;
export const slotName = id => `savepoint-slot-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
const fileOk = name => /^[a-zA-Z0-9_\-.]+$/.test(name) && !name.startsWith('.');

// What the index and the settings cache keep about a slot: everything but the memory itself.
export function metaOf(record, file, k) {
    const { mem: _m, local: _l, ...rest } = record;
    const meta = { ...clone(rest), file };
    if (Number.isInteger(k)) meta.k = k;
    return meta;
}
export const fileBody = record => ({ format: 'savepoint', version: record.version || '', saves: [record] });
const indexBody = saves => ({ format: 'savepoint-index', updated: Date.now(), saves });
const validIndex = d => plain(d) && d.format === 'savepoint-index' && Array.isArray(d.saves) &&
    d.saves.every(e => plain(e) && typeof e.id === 'string' && typeof e.file === 'string' && fileOk(e.file));
const recordFrom = d => (plain(d) && d.format === 'savepoint' && Array.isArray(d.saves) && plain(d.saves[0]) && plain(d.saves[0].mem) ? d.saves[0] : null);

export class Vault {
    // io: { put(name, obj), get(name) -> obj | null (missing), del(name), exists(names) -> {name: bool} }
    constructor(io, { onChange = () => {} } = {}) {
        this.io = io;
        this.onChange = onChange;
        this.entries = [];
        this.ready = false;       // init finished
        this.online = false;      // server storage works
        this.hadIndex = false;    // an index was read or written in this session
        this.notice = null;       // e.g. 'index-missing'
        this.error = null;
        this.lastBackup = null;
        this.queue = Promise.resolve();
    }
    // All vault operations run one at a time.
    run(fn) {
        const p = this.queue.then(fn);
        this.queue = p.catch(() => {});
        return p;
    }
    fail(e) { this.error = String(e?.message || e); throw e; }

    async writeIndex(next) {
        // Keep the previous list; but never overwrite an existing backup list with nothing
        // when this session never had an index to begin with.
        if (this.hadIndex) await this.io.put(PREV_INDEX, indexBody(this.entries));
        await this.io.put(INDEX, indexBody(next));
        this.entries = next; this.hadIndex = true; this.error = null; this.lastBackup = Date.now();
        this.onChange(clone(next));
    }

    // cache: entries from settings (meta only). Returns nothing; sets online/notice.
    async init(cache = []) {
        return this.run(async () => {
            let idx;
            try { idx = await this.io.get(INDEX); } catch (e) { this.online = false; this.ready = true; this.error = String(e?.message || e); return; }
            this.online = true;
            if (validIndex(idx)) {
                this.entries = idx.saves; this.hadIndex = true;
                this.onChange(clone(this.entries));
            } else {
                // No index. A cache from settings can rebuild it if its files still exist.
                const prev = await this.io.get(PREV_INDEX).catch(() => null);
                if (validIndex(prev)) this.notice = 'index-missing';
                const known = (cache || []).filter(e => plain(e) && typeof e.file === 'string' && fileOk(e.file));
                if (known.length) {
                    const there = await this.io.exists(known.map(e => e.file));
                    const alive = known.filter(e => there[e.file]);
                    if (alive.length) await this.writeIndex(alive);
                }
            }
            this.ready = true;
        });
    }

    // Store a full record (with mem). Autosaves rotate per room; manual slots overwrite their file.
    async put(record, { keepRooms = 30 } = {}) {
        return this.run(async () => {
            try {
                const others = this.entries.filter(e => e.id !== record.id && !(record.auto && e.auto && e.roomHash === record.roomHash));
                let file, k, removed = [], next;
                if (record.auto) {
                    const autos = this.entries.filter(e => e.auto && e.roomHash === record.roomHash).sort((a, b) => b.updated - a.updated);
                    const taken = new Set(autos.map(e => e.k));
                    k = [...Array(AUTO_NAMES).keys()].find(n => !taken.has(n)) ?? autos[autos.length - 1].k;
                    file = autoName(record.roomHash, k);
                    const kept = autos.filter(e => e.k !== k).slice(0, AUTO_KEEP - 1);
                    removed = autos.filter(e => !kept.includes(e));
                    next = [metaOf(record, file, k), ...kept, ...others];
                    // Only the newest `keepRooms` rooms keep autosaves.
                    const rooms = [...new Set(next.filter(e => e.auto).sort((a, b) => b.updated - a.updated).map(e => e.roomHash))];
                    const drop = new Set(rooms.slice(keepRooms));
                    removed.push(...next.filter(e => e.auto && drop.has(e.roomHash)));
                    next = next.filter(e => !(e.auto && drop.has(e.roomHash)));
                } else {
                    file = slotName(record.id);
                    const i = this.entries.findIndex(e => e.id === record.id);
                    next = i >= 0 ? this.entries.map(e => (e.id === record.id ? metaOf(record, file) : e)) : [metaOf(record, file), ...others];
                }
                await this.io.put(file, fileBody(record));
                await this.writeIndex(next);
                for (const e of removed) if (e.file !== file && !next.some(x => x.file === e.file)) await this.io.del(e.file).catch(() => {});
                return metaOf(record, file, k);
            } catch (e) { this.fail(e); }
        });
    }

    async read(entry) {
        const d = await this.io.get(entry.file);
        const rec = recordFrom(d);
        if (!rec) throw new Error('세이브 파일을 찾지 못했거나 형식이 잘못됐어요.');
        return rec;
    }

    async remove(id) {
        return this.run(async () => {
            const e = this.entries.find(x => x.id === id);
            if (!e) return;
            try {
                await this.writeIndex(this.entries.filter(x => x.id !== id));
                await this.io.del(e.file).catch(() => {});
            } catch (err) { this.fail(err); }
        });
    }

    // Renaming an autosave turns a copy of it into a manual slot (the autosave rotation is left alone).
    async rename(id, name, newId) {
        const e = this.entries.find(x => x.id === id);
        if (!e) return null;
        const rec = await this.read(e);
        rec.name = name;
        if (e.auto) { rec.auto = false; rec.id = newId; delete rec.roomHash; }
        return this.put(rec);
    }

    // Look for backups without changing anything.
    async find(rh) {
        const found = new Map();
        const add = (meta, source) => { if (meta && fileOk(meta.file) && !found.has(meta.file)) found.set(meta.file, { ...meta, source }); };
        const idx = await this.io.get(INDEX).catch(() => null);
        if (validIndex(idx)) idx.saves.forEach(e => add(e, 'index'));
        const prev = await this.io.get(PREV_INDEX).catch(() => null);
        if (validIndex(prev)) prev.saves.forEach(e => add(e, 'prev'));
        if (rh) {
            for (let k = 0; k < AUTO_NAMES; k++) {
                const name = autoName(rh, k);
                if (found.has(name)) continue;
                const rec = recordFrom(await this.io.get(name).catch(() => null));
                if (rec) add({ ...metaOf(rec, name, k), roomHash: rh, auto: true }, 'room');
            }
        }
        const list = [...found.values()];
        const there = list.length ? await this.io.exists(list.map(e => e.file)) : {};
        return list.map(e => ({ ...e, exists: e.source === 'room' ? true : !!there[e.file],
            listed: this.entries.some(x => x.file === e.file && x.updated === e.updated) }))
            .sort((a, b) => b.updated - a.updated);
    }

    // Put a found backup back into the index (reads the file first so the list matches it).
    async restore(item) {
        return this.run(async () => {
            const rec = recordFrom(await this.io.get(item.file));
            if (!rec) throw new Error('백업 파일을 읽지 못했어요.');
            const meta = metaOf(rec, item.file, item.k);
            if (item.auto) { meta.auto = true; meta.roomHash = item.roomHash || rec.roomHash; }
            const next = [meta, ...this.entries.filter(e => e.id !== meta.id && e.file !== meta.file)];
            try { await this.writeIndex(next); } catch (e) { this.fail(e); }
            return meta;
        });
    }
}
