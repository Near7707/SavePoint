// v0.6.58: the room gate for checks that run parts of index.js on their own (vm boxes): an open,
// confirmed room whose chat file always has what was written. The gate itself is checked in guard tests
// and the browser suites.
export function gateBox() {
    class Unconfirmed extends Error {}
    class RoomBlocked extends Error {}
    return {
        gate: { unsure: null, status: 'ready' }, OWN_KEYS: [], Unconfirmed, RoomBlocked,
        gateOpen: () => true, roomReady: async () => true, gateMessage: () => '', blockRoom() {}, warnBlocked() {}, markUnsure() {}, confirmUnsure: async () => true,
        serverCovered: async () => ({ ok: true, snap: null, rev: null, count: 0 }), readServerChat: async () => ({ ok: true, snap: null, rev: null, count: 0 }),
        pageBase: () => null, pageSnap: () => null, plainHash: () => '', snapshot: () => ({ meta: {} }), writeResult: () => 'ok', samePage: () => true,
        cancelMoved: () => new Error('moved'),
    };
}
