// v0.6.72: the part of SillyTavern's script.js SavePoint reads: whether SillyTavern is writing the chat file
// right now (a live binding, like the real export). Tests flip it with M.stScript.setChatSaving(true/false).
export let isChatSaving = false;
export function setChatSaving(v) { isChatSaving = !!v; }
