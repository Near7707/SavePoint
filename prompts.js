// SavePoint prompts. The guide is user-editable; the data blocks and output format are fixed.

// Fingerprints of earlier default guides. A copy in settings that still matches one of them was
// never edited, so it is replaced by the current default. Only the fingerprints are kept here.
export function guideHash(text) {
    const t = String(text || '').trim();
    let a = 2166136261, b = 5381;
    for (let i = 0; i < t.length; i++) { const n = t.charCodeAt(i); a = Math.imul(a ^ n, 16777619); b = Math.imul(b, 33) ^ n; }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36) + t.length.toString(36);
}
export const OLD_GUIDE_HASHES = ['5ou1fys5ubzw1ux', '1egpjhool9w7i225', '36fl7y13xf8tq3i3', '1d0rnmfp52dmx43e', 'ly3aqj1ha5hnz45u', '1gvz32h1cw4kin4fo', '1osodnkjcehcg4gw'];

export const DEFAULT_GUIDE = `You keep the save file of an ongoing roleplay between {{char}} and {{user}}. Read the NEW MESSAGES and record what happened and what is now different: a scene journal plus the current state of people, items, open threads and the world.

LANGUAGE: write every field in English, even when the story is in another language. Translate; never copy sentences from the story. Only entity names and the "aliases" lists keep the story's original spelling.

WHAT TO KEEP
1. Changes: anything that alters the current state: who holds what, the condition of an item, injuries or lasting status, a relationship shifting because of something someone did or said, a promise made, kept or broken, a decision, a secret revealed, a new name. Record the start and the result of an action together, so the final outcome is never lost ("picked up the broken lantern, refitted the handle and returned it to its owner", not only "picked up the lantern"). If a later action changes the meaning of an earlier one, write the final outcome.
2. Moments: shared experiences, memorable conversations, jokes and newly revealed information that the characters could plausibly bring up again, even if nothing changes.
3. Uncertainty: guesses, unconfirmed identities, misunderstandings and things someone does not know yet. These change how characters should act later, so they belong in the outline of the part where they happen ("he guessed her name was Mara; she did not confirm it").

HOW TO WRITE POINTS
- One point per outcome, not per step. A fight, a game or an argument becomes the result and how it was reached in one line ("she caught the falling sign so he could cut it loose, clearing the street"); blow-by-blow moves and exact lines go into "notes".
- Keep a point to about 20 words. Never shorten by dropping who did it, the result, a negation, or whether something was confirmed; those come first.
- Banter that changes nothing becomes at most one moment point, or none if the outline already says it.
- Do not turn one experience into a lasting trait ("won one game" is not "a born champion").

WHAT TO LEAVE OUT
- Anything already defined in the CHARACTER CARD / PERSONA block: appearance, outfit, default gear, standing traits, default names and nicknames. Record only what changes or is newly revealed.
- Repeated actions, routine gestures, and turn-by-turn moves that change nothing.
- Guesses of your own. Write only what the messages show. An offer is an offer, not a completed deed. An unfinished action is recorded at its last confirmed point.
- In notes: details nobody will need later (weather, temperature, exact minutes), unless the story depends on them. Keep dates and times when they matter for the order of events.

CONSISTENCY: before writing the state lists, check them against your points and the messages: who won and who lost, who holds what now, who will do what. A result that follows a condition is written with the condition, naming who did what ("the ferry left before Mara arrived, so as agreed beforehand Theo kept her ticket"). Do not create a debt from winner/loser wording in a joke. Check what obligation was actually agreed and who bears it, and do not infer a debt that the result of a game did not create. Something both people simply decided to do together is not a bet or a debt. When the messages state the terms of a bet, stake or rule, write them as stated, for every side (winner, loser, tie), in the points and notes; never reshape them into a familiar pattern such as "loser pays, winner chooses". If the terms say both sides do the same thing, nobody owes anything to anyone.

STATE LISTS
- Only things that still exist and still matter: an item that was eaten, used up or thrown away leaves the item list; a knock with no lasting effect is not a condition.
- One record per item. When an item changes hands or condition, update its record; never add a second record for the same item. An item record says where the item is and what condition it is in now, not how it was used (use goes in the journal).
- Different names do not make different items. If the messages use two names for one object, it is one entity with both names as aliases; record two entities only when the messages show two separate objects.
- RELATIONSHIPS are written as what someone did or said and what it led to ("trusts her with the key after she kept his secret"), never as scores, levels or labels like "affection increased". When two people share the same act, do not repeat it on both sides: write for each person only how their own attitude or behaviour actually changed.
- A person's "condition" is a lasting physical or mental state (an injury, exhaustion, being drunk, grieving). Decisions, plans, opinions and guesses are not conditions; they go in the journal.
- A "secret" is something deliberately kept from someone, with "knownBy" listing who knows. Public acts (a public post, an announcement) are not secrets; they go in the journal.
- QUESTS are only firm promises, confirmed goals, debts, and real unresolved mysteries, never passing wishes or idle remarks. Close a quest (status "done" or "failed") when the messages show it.

SCENES: a scene ends only when the story clearly moves on: the place and the time change together, or the main activity is finished and a different one begins (they part ways, go to sleep, a later day starts). A brief change of topic, a short move within the same outing, or a pause after which the same activity continues does not end a scene. Several scenes may appear in one batch. The last scene is "ended": false if it is still going on at the last message.

Placeholders in the examples above (lantern, key, sign, ferry, ticket, Mara, Theo) are not part of this story; never record them.`;

export const OUTPUT_FORMAT = `Return ONLY one JSON object, with the fields in this order:
{
  "checklist": {
    "promises": "...", "items": "...", "injuries_status": "...", "relationship_acts": "...",
    "secrets_revelations": "...", "decisions": "...", "new_names_places": "...", "moments": "...",
    "consistency": "who won/lost, who holds what, who will do what - checked against the messages"
  },
  "scenes": [
    {
      "scene": "continue" | "new",
      "start": <first message number of this scene; omit for the first scene>,
      "title": "short label",
      "where": "place",
      "who": ["entity ids or new refs involved"],
      "time": { "mode": "present" | "flashback", "start": <time stamp>, "end": <time stamp> },
      "points": [ { "text": "one line, about 20 words", "kind": "change" | "moment", "key": true | false, "msgs": [<message numbers>] } ],
      "notes": "detailed English notes for later recall: specifics, paraphrased dialogue, small objects, how things happened",
      "outline": "1-2 sentences for THIS PART only (these new messages in this scene): main events and results, plus anything still unconfirmed",
      "ended": true | false,
      "star": true | false
    }
  ],
  "entities": [
    { "ref": "new1", "type": "person" | "item" | "place", "name": "English name", "aliases": ["every name or word the messages use for it, original spelling"] },
    { "id": "e3", "aliases": ["newly used alias for a known entity"] }
  ],
  "changes": [
    { "op": "add", "type": "party", "entity": "<the PERSON this record is about>", "aspect": "relation" | "condition", "text": "...", "msgs": [..] },
    { "op": "add", "type": "item", "entity": "<the ITEM itself>", "holder": "<the PERSON or PLACE that has it now, or null>", "text": "the item's current condition / situation", "msgs": [..] },
    { "op": "add", "type": "quest", "kind": "promise" | "goal" | "debt" | "mystery", "status": "open" | "done" | "failed", "who": ["<person ids or refs>"], "text": "...", "terms": {"msg": <number>, "quote": "exact words"}, "due": {"expr": "deadline words copied exactly", "days": <days from when it was said, or null>, "date": "calendar date copied exactly or empty", "msg": <number>}, "msgs": [..] },
    { "op": "add", "type": "world", "kind": "place" | "rule" | "name" | "secret", "knownBy": ["<person ids or refs>"], "text": "...", "msgs": [..] },
    { "op": "update", "id": "r12", "text": "new full text", "holder": "<items only: the new PERSON or PLACE that has it>", "status": "<quests only: open | done | failed>", "terms": "<debts and promises, only when the terms themselves change>", "due": "<debts and promises, only when the deadline itself changes>", "msgs": [..] },
    { "op": "remove", "id": "r12", "msgs": [..] }
  ]
}

Field roles (ids/refs must have the right type):
- party: "entity" is a person. Use it for relationships and a person's condition.
- item: "entity" is the item (type "item"), never the person; the person or place that has it goes in "holder". "Theo now carries the key" -> entity = the key, holder = Theo. Anything that is about a person rather than an object belongs in a party record.
- quest "who" and world "knownBy" list people only.

Rules for the JSON:
1. "checklist" first: scan the messages for each category and note what you found in a few words, or "none". It is a working list and is not stored.
2. "scenes": only the first scene may be "continue", and only to extend the OPEN SCENE. Every scene needs a title, an outline and its points.
   A batch may stop in the middle of an ongoing scene. Record only outcomes confirmed within these messages; leave unfinished actions and unresolved conditions pending. A later return of an item is a new event, not a reason to erase the earlier handover. Never force a scene to end merely because this batch ends.
   Each scene's "outline" covers only the part in these new messages. Earlier parts of the OPEN SCENE keep their own outlines and are never rewritten, so do not repeat them.
   Every point is stored, but only "key" points are shown to the roleplay model together with the outlines and the CURRENT STATE. Set "key": true only for an important result, an unresolved matter or a recall cue that neither this part's outline nor the state lists (including the changes in this reply) already carry. If nothing needs adding, every point is false; never pick points just to have some.
3. "entities": declare each new person, item or place with a ref you invent ("new1", "new2", ...). For anything already in KNOWN ENTITIES use its id (e.g. "e3"), never a new ref and never a bare name. Two different things may share an alias (two keys can both be called by the same word), but each needs its own entry and a distinguishing English name. Every "who", "entity", "holder" and "knownBy" value must be an existing id or a ref declared here.
4. "changes": every state change in your points must appear here, and nothing may appear here that the messages do not show. Prefer "update" of an existing record over adding a near-duplicate. One record per fact: a person can have several records, and the same item can change hands several times through updates. A quest that is both made and finished inside these messages is added once with its final "status" ("done" or "failed") and the evidence for both; a quest that is still pending stays "open". An offer or suggestion is not a promise.
   Every debt or promise that you add needs "terms": the message number and the exact words from that message that set the terms, copied in the story's own language (not translated). Quote the whole condition with every side of it ("If it rains, Theo drives; otherwise Mara drives."), not only the part that seems to support your record. If no message states terms that create the debt or promise, do not record it. When a debt is paid or a promise kept or broken, update its "status" and cite the message that shows it; do not repeat "terms" unless the terms themselves changed.
   A debt or promise with a deadline also gets "due": "expr" copies the deadline words exactly as written in that message ("내일", "모레까지", "사흘 안에", "by tomorrow"), "msg" is that message. "days" is the exact number of days from the moment it was said ("내일" 1, "모레" 2, "오늘 밤" 0, "사흘 뒤" 3), or null when the words do not give one exact count ("며칠 안에", "이번 주말", "곧", "내일모레"). "date" copies a stated calendar date, else empty. Never compute a date from the current story time yourself, and omit "due" when no deadline was set. A deadline that has passed does not by itself mean the promise was broken; change the status only when the messages show it kept or broken.
5. Optional story time is recorded per part, NEVER from the computer clock or message send timestamps. A <time stamp> is {"relation":"same"|"explicit"|"advance"|"jump"|"unknown", "date":"exact original calendar expression or empty", "period":"dawn"|"morning"|"day"|"afternoon"|"evening"|"night"|"", "clock":"HH:mm or empty", "days":<nonnegative integer or null>, "elapsed":"original vague jump phrase or empty", "msg":<source message number>, "quote":"exact supporting words from that message"}.
   Use start/end for the time at the start/end of THIS part. With no time mention use {"relation":"same"}; unknown fields may be empty. "explicit" means the quoted ORIGINAL states the current date or time, with date copied verbatim. "advance" needs a quoted exact elapsed day count such as "the next day" (days:1); "jump" needs a quoted vague passage such as "weeks later", with elapsed preserved verbatim and days:null. "unknown" means a change occurred but its current time cannot be established. Never invent dates, calendar arithmetic or a day count for vague elapsed time. Never increment a day merely because night changed to dawn. Only claims supported by quoted originals are confirmed. Inherit unchanged time without inventing evidence.
   Quote a focused supporting phrase with at least two letters/numbers, not a single character such as "밤". For advance include the actual elapsed-day expression ("다음 날"/"그다음 날" = 1, "사흘 뒤" = 3, "일주일 뒤"/"a week later" = 7, "보름 뒤" = 15, "a fortnight later" = 14, "the next morning" = 1); a generic time band or fragment such as "다음" is not a day count. If an exact elapsed day count cannot be established, use unknown or a supported vague jump instead.
   "flashback" means the roleplay is ACTING a past scene; it records that part's time without advancing the present. Recalling or mentioning a past event in dialogue is not an acted flashback. "Meet tomorrow" is a future appointment, NOT the current time; record the promise in changes and do not advance the clock. Hypotheticals, quotations and imagined future events likewise do not advance current time. Date/quote/elapsed keep their original language; time metadata is exempt from English-only prose.
6. "msgs" is required on every point and change. Use message numbers from NEW MESSAGES only (#{FROM}-#{TO}). To refer to something already recorded in the open scene, you may cite its segment id (for example "g4").`;

export function fillNames(text, names) {
    return String(text).replace(/\{\{char\}\}/gi, names.char || 'the character').replace(/\{\{user\}\}/gi, names.user || 'the user');
}

export function buildExtractPrompt({ guide, names, card, context, chunk, note = '' }) {
    const format = OUTPUT_FORMAT.replace('{FROM}', chunk.from).replace('{TO}', chunk.to);
    return [
        fillNames(guide, names),
        '',
        '[CHARACTER CARD / PERSONA: already known, do not record]',
        card || '(not available)',
        '',
        '[KNOWN ENTITIES]',
        context.entities,
        '',
        '[CURRENT STATE] (record ids for update/remove)',
        context.state,
        '',
        '[LAST RECORDED STORY TIME: later messages take priority]',
        context.time || '(not recorded; do not infer a calendar date)',
        '',
        '[OPEN SCENE] (continue it if the new messages carry on the same scene)',
        context.open === '(none)' ? '(none: there is no open scene, so the first scene must be "new")' : context.open,
        '',
        '[RECENT SCENES] (for continuity only, do not repeat)',
        context.recent,
        '',
        ...(note ? ['[BATCH NOTE]', note, ''] : []),
        `[NEW MESSAGES] #${chunk.from} to #${chunk.to}`,
        chunk.text,
        '',
        fillNames(format, names),
    ].join('\n');
}

export function retryNote(errors, languageIssues) {
    const lines = ['', '', 'YOUR PREVIOUS REPLY WAS REJECTED. Fix these problems and return the complete JSON again. For each problem, reread the message it cites and write what that message actually shows; do not just swap fields to pass the check:'];
    for (const e of errors.slice(0, 25)) lines.push('- ' + e);
    if (languageIssues.length) lines.push(`- These fields were not written in English: ${languageIssues.slice(0, 15).join(', ')}. Translate them into English; only names and aliases keep the original spelling.`);
    return lines.join('\n');
}

// Sent only with a rejected extraction; explicit gaps stop repeated guesses at hidden messages.
export function extractionRepairNote(chunk, previous) {
    const ids = [...new Set(chunk.indices || [])].sort((a, b) => a - b);
    const ranges = [];
    for (let i = 0; i < ids.length; i++) {
        const first = ids[i]; let last = first;
        while (i + 1 < ids.length && ids[i + 1] === last + 1) last = ids[++i];
        ranges.push(first === last ? `#${first}` : `#${first}–#${last}`);
    }
    const starts = (Array.isArray(previous?.scenes) ? previous.scenes : []).slice(0, 20)
        .map((sc, i) => `${i + 1}: ${i === 0 ? chunk.from : JSON.stringify(sc?.start ?? '(missing)')}`).join('; ');
    return `\n[EXTRACTION REPAIR]\nAllowed message numbers in THIS request: ${ranges.join(', ')}. Numbers in the gaps are unavailable. First scene starts at #${chunk.from}. Previous reply's scene starts: ${starts || '(none)'}. Each later start must be in the allowed list, strictly after the preceding start. Keep each point with ALL its actual supporting messages; do not invent, merge different scenes, or discard evidence to pass validation. Return the complete scenes array with title, outline, points and any state changes. A scene still in progress is valid for a quick save; do not omit it merely because it has not ended. Omit unknown place information rather than inventing it. Correct the reported fields using the original messages.`;
}

export const TRANSLATE_PROMPT = `Translate each item's "text" into natural Korean for a reader following a roleplay story. Keep names as they are. Do not add or drop information.
Return ONLY a JSON array: [{"id": "...", "ko": "..."}]

Items:
`;

// Step 1 of automatic collection: only find where scenes start and whether they are over.
export const SCENE_END_RULE = `A scene ends only when the story clearly moves on: the place and the time change together, or the main activity of the scene is finished and a different one begins (for example they part ways, go to sleep, or a later day starts). These do NOT end a scene: a brief change of topic, a short move within the same outing (walking to the next stall, stepping outside for a moment), or a pause or interruption after which the same activity continues.`;

export function buildBoundaryPrompt({ names, open, from, to, text }) {
    const openText = open
        ? [`"${open.title}"${open.where ? ` @ ${open.where}` : ''}`, `Outline so far: ${open.outlineText ?? open.outline}`,
            ...open.segs.flatMap(g => g.points.map(p => `- ${p.text}`)).slice(-12)].join('\n')
        : '(none)';
    return fillNames(`You are marking scene boundaries in an ongoing roleplay between {{char}} and {{user}}. Do not summarize anything.

${SCENE_END_RULE}

[OPEN SCENE] (already partly recorded; the new messages may continue it)
${openText}

[NEW MESSAGES] #${from} to #${to}
${text}

Return ONLY one JSON object:
{
  "continues_open_scene": true | false,
  "scenes": [ { "start": <message number>, "label": "a few words", "ended": true | false } ]
}
Rules:
1. "continues_open_scene" is true if the first new messages carry on the OPEN SCENE, false if they already belong to a new scene. It is false when there is no open scene.
2. List the scenes in the new messages in order. The first scene starts at #${from}. Every "start" is a message number from NEW MESSAGES, in increasing order.
3. "ended" is true only if that scene clearly finished and the next scene in your list has begun. The last scene is the one still going on at #${to}: mark it false unless it clearly finished at the very last message.`, names);
}

export function batchNote({ boundary, continuesOpen }) {
    return [
        `Every scene in these messages is confirmed finished: a new scene begins right after #${boundary}. Set "ended": true for every scene.`,
        continuesOpen ? 'The first messages continue the OPEN SCENE: the first scene must be "continue".' : 'The first messages begin a new scene: the first scene must be "new".',
    ].join('\n');
}

// Re-choose key points of a stored scene without collecting it again.
export function buildRekeyPrompt({ names, scene, state, items }) {
    return fillNames(`You are tidying the memory of a roleplay between {{char}} and {{user}}. Below is one recorded scene: its outline, the current state lists, and its stored points.
Every point stays stored. Choose which points should also be shown to the roleplay model together with the outline and the state lists.

Set true only for a point that adds an important result, an unresolved matter or a recall cue that neither the outline nor the state lists already carry. Set false for anything the outline or the state already says, for banter, and for step-by-step detail. If nothing needs adding, every point is false.

[SCENE] "${scene.title}"${scene.where ? ` @ ${scene.where}` : ''}
Outline: ${scene.outlineText ?? scene.outline}

[CURRENT STATE]
${state || '(empty)'}

[POINTS] (id: text)
${items.map(x => `${x.id}: ${x.text}`).join('\n')}

Return ONLY one JSON object: {"keys": {"<point id>": true | false, ...}} with every point id listed above.`, names);
}

// After a batch is saved: look for contradictions and misreadings. Warnings only; nothing is changed.
export function buildCheckPrompt({ names, records, journal, terms = '', messages, notShown = [] }) {
    return fillNames(`You are checking the memory of a roleplay between {{char}} and {{user}} for errors. Below are records just written from the latest messages, the journal parts they come from, and the original messages they cite.

The ORIGINAL MESSAGES decide what is true. Records and journal lines are only claims about them.
Report only real problems, of these two kinds:
1. misread: a record, a point or an outline states something the ORIGINAL MESSAGES contradict, for example a joke treated as a binding bet or debt, an obligation nobody agreed to, the terms of a bet, stake or rule written differently from how they were stated, the wrong person doing something, a result reversed. Put the id of the WRONG statement in "about". When a record and a journal line disagree, read the messages and report only the one they contradict; never report a statement the messages support just because another line disagrees with it.
2. unclear: two statements disagree and the messages shown do not settle which one is right. Put one id in "about" and the other in "also". Do not guess which is wrong.
Do not report wording, style, missing minor details, or things that only seem unlikely. When the messages are ambiguous, do not report.
This is one batch of a larger review. Each supplied statement travels with its full cited messages; never assume a statement or an event outside this batch was checked. Report a misread only when the messages shown contradict the statement or clearly show something else in its place. If supporting evidence is unavailable, do not report a misread. Use only message numbers actually shown in this request.
For journal points with user-selected excerpts, also check that the point preserves the selected meaning, including material conditions and negations. Report an unrelated point or a material omission as a misread. A request to remember something is not itself a story fact.
${terms ? `
[TERMS] (the words that set each debt or promise, with the sentences around them, copied by code from the original)
${terms}

For each record with TERMS, read the context and the messages from its first to its last evidence, then check: who must do what for whom, under which condition, whether it was actually agreed, and whether the terms changed later in the messages. If both sides were to do the same thing, nobody owes anyone. Report the record as a misread if it states an obligation, a debtor or a condition that the terms do not create.
When TERMS is labelled as a cached quotation from a previous chat, its old message number is not a current-chat reference. Compare the supplied current events with that saved quotation and context only. The complete earlier agreement cannot be rechecked here; never report an earlier fact as unsupported merely because the earlier original messages are unavailable.
` : ''}
[RECORDS] (id: text)
${records || '(none)'}

[JOURNAL] (part outlines "gN" and points "gN.M")
${journal || '(none)'}

[ORIGINAL MESSAGES]${notShown.length ? ` (not shown for length: ${notShown.map(n => '#' + n).join(', ')})` : ''}
${messages || '(none)'}

Return ONLY one JSON object:
{"issues": [{"about": "<one id from above: a record (r3), a point (g2.4) or a part outline (g2)>", "also": "<unclear only: the other id>", "kind": "misread" | "unclear", "basis": "contradicted" | "unsupported", "problem": "one short English sentence", "conflict": ["the statement in question", "the message line or statement it conflicts with"], "msgs": [<message numbers>]}]}
"basis": "contradicted" when a message line says something different (copy that line word for word as the second "conflict" entry); "unsupported" when the messages simply do not show it.
If nothing is wrong, return {"issues": []}.`, names);
}


