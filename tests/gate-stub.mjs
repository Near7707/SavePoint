// v0.6.58: the room gate for checks that run parts of index.js on their own (vm boxes): an open,
// confirmed room whose chat file always has what was written. The gate itself is checked in guard tests
// and the browser suites.
export function gateBox() {
    class Unconfirmed extends Error {}
    class RoomBlocked extends Error {}
    return {
        gate: { unsure: null, status: 'ready', seen: null, cut: null, why: '' }, SESSION: 'test', OWN_KEYS: [], Unconfirmed, RoomBlocked,
        gateOpen: () => true, gateHere: () => true, roomReady: async () => true, gateMessage: () => '', blockRoom() {}, warnBlocked() {}, markUnsure() {}, confirmUnsure: async () => true,
        serverCovered: async () => ({ ok: true, snap: null, rev: null, count: 0 }), readServerChat: async () => ({ ok: true, snap: null, rev: null, count: 0 }),
        pageSnap: () => null, sendSnap: () => null, snapshot: () => ({ meta: {} }), writeResult: () => 'ok', samePage: () => true,
        cancelMoved: () => new Error('moved'), queueIdle: async () => true, setSeen() {},
        // v0.6.61: a change no longer valid at its turn; the write receipt; QUICK through the queue.
        Stale: class extends Error {}, proofOf: () => null, canon: JSON.stringify, newId: () => 'wid',
        quickSaveChecked: async () => null,
        // v0.6.76: SillyTavern's write in progress (none here); a failure once a write may have landed.
        // v0.6.83: every failed write is settled by reading the file; here, as before: one that may have landed
        // stays (its error), any other is taken back.
        stIdle: async () => false, settleWrite: async e => (e?.landed ? e : 'revert'),
        // v0.6.87: a file read back becomes the base (always, here).
        fileBase: () => ({ ok: true }),
        // v0.6.90: the turn of the last deletion on the page (none here), passed to settleWrite with what was written.
        delTick: 0,
        // v0.7.0-a: the room's turn (none changes here), the source check waited for (always fine here), a record
        // check running (shown on screen only), loot reasons kept on screen only (none here).
        roomEpoch: 0, reconcileNow: async () => true, checkRunning: () => false, lootShown: st => st?.lootQueue || [], lootNotesHere: () => null,
        // v0.7.0-a2: the recorded messages are unchanged here (the second source check before a save's request).
        firstMismatch: () => -1,
    };
}

// v0.7.0-b1: the room's memory store (index.js pageBox/pageMem/setPageMem) for a box whose memory lives at
// `meta().savePoint`, as the chat metadata did before.
export function memAccess(meta) {
    const boxMem = box => box?.savePoint;
    const putBoxMem = (box, st) => { if (!box) return; if (st === undefined) delete box.savePoint; else box.savePoint = st; };
    return { pageBox: () => meta(), boxMem, putBoxMem, pageMem: () => boxMem(meta()), setPageMem: st => putBoxMem(meta(), st) };
}
