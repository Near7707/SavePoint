import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyMem,applyResult,cleanMem,detachMem,buildInjection,validateResult,memDiff,applyDiff} from '../core.js';
import {lastStoryTime,dateAt,editStoryTime,formatStoryStamp,sceneTimeRange,storyTimeContext} from '../temporal.js';
const raw=(relation,extra={})=>({relation,...extra});
function save(mem,time,words='Nothing changes.',room='room-A'){
 const index=mem.scenes.flatMap(s=>s.segs).length;
 const chunk={from:index,to:index,indices:[index],text:words,texts:{[index]:words}};
 const stamp=t=>t?{...t,msg:index,quote:t.quote??words}:undefined;
 const t=time===undefined?undefined:typeof time==='object'&&!Array.isArray(time)?{...time,start:stamp(time.start),end:stamp(time.end)}:time;
 const d={scenes:[{scene:mem.scenes.length?'continue':'new',title:'A neutral scene',where:'Station',who:[],outline:'A participant waited.',notes:'',ended:false,points:[{text:'A participant waited.',kind:'moment',key:true,msgs:[index]}],...(t===undefined?{}:{time:t})}],entities:[],changes:[]};
 assert.deepEqual(validateResult(d,{mem,chunk}),[],'time never invalidates an otherwise sound extraction');
 return applyResult(mem,d,chunk,{room}).mem;
}
const start=(mem=emptyMem(),date='2026-10-24',period='night')=>save(mem,{start:raw('explicit',{date,period}),end:raw('same')},`${date} ${period}.`);
const now=m=>lastStoryTime(m).stamp;
const date=m=>dateAt(now(m),m.timeAnchors);
const advance=(mem,days=1)=>save(mem,{end:raw('advance',{days,period:'morning'})},`The next ${days} days passed; it is morning.`);
test('explicit dates and exact next days retain one reference; omitted time inherits without extra claims',()=>{
 let m=start();const anchor=now(m).anchor;m=advance(m);assert.equal(date(m),'2026-10-25');assert.equal(now(m).day,1);assert.equal(now(m).anchor,anchor);assert.equal(now(m).certainty,'linked');
 m=save(m,undefined);assert.equal(date(m),'2026-10-25');assert.equal(now(m).period,'morning');
});
test('unverified dates break inference, later explicit evidence restores it',()=>{
 let m=start();m=save(m,{end:raw('explicit',{date:'2026-11-20',quote:'not in the original'})},'No date was stated.');assert.equal(now(m).certainty,'unconfirmed');
 m=advance(m);assert.equal(now(m).certainty,'unconfirmed');m=start(m,'2026-11-22','morning');assert.equal(date(m),'2026-11-22');
});
test('an acted flashback has dates but never moves the last recorded present',()=>{
 let m=start();m=save(m,{mode:'flashback',start:raw('explicit',{date:'2023-01-03'}),end:raw('same')},'2023-01-03: a scene three years ago.');
 assert.equal(date(m),'2026-10-24');assert.match(sceneTimeRange(m.scenes[0],m.timeAnchors),/flashback/);
 m=advance(m);assert.equal(date(m),'2026-10-25');
});
test('a vague jump creates a new incomparable reference; only local next days are counted',()=>{
 let m=start();const old=now(m).anchor;m=save(m,{end:raw('jump',{elapsed:'몇 주 뒤'})},'몇 주 뒤, 다시 만났다.');
 assert.notEqual(now(m).anchor,old);assert.equal(now(m).day,0);assert.equal(date(m),'');m=advance(m);assert.equal(now(m).day,1);
 assert.match(storyTimeContext(m,'ko'),/몇 주 뒤 · 이튿날/);assert(!storyTimeContext(m).includes('21'));
});
test('night to dawn with no elapsed-day evidence does not increment the day',()=>{
 let m=start();m=save(m,{end:raw('explicit',{period:'dawn'})},'It is dawn.');assert.equal(now(m).day,0);assert.equal(date(m),'2026-10-24');
});
test('custom calendars preserve labels; no invented month arithmetic',()=>{
 let m=start(emptyMem(),'왕국력 312년 봄 3일','morning');m=advance(m);assert.equal(date(m),'');assert.match(storyTimeContext(m,'ko'),/왕국력 312년 봄 3일 \+1일/);
});
test('bad optional fields are unknown, not failed summaries or current-clock dates',()=>{
 for(const time of ['broken',[],{end:raw('advance',{days:-1})},{end:raw('explicit',{date:'2026-02-30'})},{end:{relation:'manual',manual:true,date:'2035-01-01'}}]){
  const m=save(start(),time,'2026-02-30 was printed incorrectly.');assert.equal(now(m).certainty,'unconfirmed');
 }
});
test('source quotes must belong to this recorded part, not another same-number room',()=>{
 let m=start();m=save(m,{end:raw('explicit',{date:'2026-10-25',msg:0,quote:'2026-10-24 night.'})},'No date here.','room-B');
 assert.equal(now(m).certainty,'unconfirmed');
});
test('save round trips and cross-room import keep dates, reference days and original provenance',()=>{
 let m=advance(start());m=cleanMem(JSON.parse(JSON.stringify(m)));m=detachMem(m,'room-A');m=advance(m,1);
 assert.equal(date(m),'2026-10-26');assert.equal(m.scenes[0].segs[0].time.start.evidence.room,'room-A');
 assert.equal(m.scenes[0].segs[0].time.start.evidence.msg,0);
});
test('manual time edits recalculate later relative claims without overwriting explicit dates',()=>{
 let m=advance(start());m=start(m,'2026-10-30','morning');
 assert(editStoryTime(m,'g1',{date:'2026-10-26',day:'1',period:'night',mode:'present'},'room-A'));
 const gs=m.scenes[0].segs;assert.equal(gs[0].time.end.certainty,'manual');assert.equal(dateAt(gs[1].time.end,m.timeAnchors),'2026-10-27');assert.equal(date(m),'2026-10-30');
 m=cleanMem(m);assert.equal(m.scenes[0].segs[0].time.end.certainty,'manual');m=advance(m);assert.equal(dateAt(m.scenes[0].segs[0].time.end,m.timeAnchors),'2026-10-26');
});
test('history rollback restores reference anchors as well as the recorded parts',()=>{
 const a=start(),b=advance(a),diff=memDiff(a,b),old=applyDiff(b,diff,true);assert.deepEqual(old.timeAnchors,a.timeAnchors);assert.equal(date(old),'2026-10-24');
 const blank=emptyMem(),first=memDiff(blank,a),back=applyDiff(a,first,true);assert.equal(back.timeAnchors,undefined);assert.equal(lastStoryTime(back),null);
});
test('old memory remains undated and is not silently backfilled',()=>{
 const m=save(emptyMem(),undefined);assert.equal(cleanMem(m).scenes[0].segs[0].time,undefined);assert.equal(storyTimeContext(m),'');
});
test('injection leads with last-recorded time, includes flashback labels and obeys its token limit',()=>{
 let m=start();m=save(m,{mode:'flashback',start:raw('explicit',{date:'2023-01-03'})},'2023-01-03: a past scene.');
 const result=buildInjection(m,{budget:6000});assert.match(result.text,/Last recorded story time: 2026-10-24/);assert.match(result.text,/flashback/);assert.match(result.text,/Later unrecorded messages take priority/);
 assert(buildInjection(m,{budget:300}).tokens<=300);
});
test('manual time validates input before modifying the segment',()=>{
 const m=start(),before=JSON.stringify(m);assert.throws(()=>editStoryTime(m,'g1',{date:'2026-02-30',day:1}),/날짜/);assert.equal(JSON.stringify(m),before);
 assert.throws(()=>editStoryTime(m,'g1',{day:0}),/일 수/);assert.equal(JSON.stringify(m),before);
});

test('merging a same-mode continuation preserves each time transition and its evidence', async()=>{
 const {normalizeResult}=await import('../core.js');
 const words={0:'2026-10-24 night.',1:'The next day.',2:'Two days later.'};
 const chunk={from:0,to:2,indices:[0,1,2],text:Object.values(words).join('\n'),texts:words};
 const sc=(scene,start,n,time)=>({scene,start,title:'A neutral scene',where:'',who:[],outline:'A participant waited.',notes:'',ended:false,points:[{text:'A participant waited.',kind:'moment',key:true,msgs:[n]}],time});
 const d={scenes:[sc('new',undefined,0,{mode:'present',start:{relation:'explicit',date:'2026-10-24',msg:0,quote:words[0]},end:{relation:'same'}}),sc('continue',1,1,{mode:'present',start:{relation:'advance',days:1,msg:1,quote:words[1]},end:{relation:'advance',days:2,msg:2,quote:words[2]}})],entities:[],changes:[]};
 normalizeResult(d,{mem:emptyMem(),chunk});assert.equal(d.scenes.length,1);assert.deepEqual(validateResult(d,{mem:emptyMem(),chunk}),[]);
 let m=applyResult(emptyMem(),d,chunk,{room:'room-A'}).mem;assert.equal(date(m),'2026-10-27');assert.equal(m.scenes[0].segs[0].time.via.length,2);
 m=cleanMem(m);editStoryTime(m,'g1',{date:'2026-10-28',day:5});assert.equal(date(m),'2026-10-28');
});

test('naming an existing reference changes display only, not stored day offsets',()=>{
 let m=save(emptyMem(),{start:{relation:'same'},end:{relation:'same'}});m=advance(m,2);
 const before=m.scenes.map(s=>s.segs.map(g=>g.time.end.day));const anchor=now(m).anchor;
 m.timeAnchors[anchor].date='2026-10-24';assert.equal(date(m),'2026-10-26');assert.deepEqual(m.scenes.map(s=>s.segs.map(g=>g.time.end.day)),before);
});
test('separate branches preserve inherited days but never mutate each other or share new jump references',()=>{
 const original=start();const a=save(structuredClone(original),{end:raw('jump',{elapsed:'Weeks later'})},'Weeks later.','room-B');
 const b=save(structuredClone(original),{end:raw('jump',{elapsed:'Months later'})},'Months later.','room-C');
 assert.notEqual(now(a).anchor,now(b).anchor);assert.equal(date(original),'2026-10-24');assert.equal(Object.keys(original.timeAnchors).length,1);
});
test('a user can correct the start independently and inherited end/following days reflow',()=>{
 let m=advance(start());editStoryTime(m,'g1',{edge:'start',date:'2026-10-26',day:1,period:'night',mode:'present'});
 assert.equal(m.scenes[0].segs[0].time.start.certainty,'manual');assert.equal(dateAt(m.scenes[0].segs[0].time.end,m.timeAnchors),'2026-10-26');assert.equal(date(m),'2026-10-27');
});
test('editing a custom-calendar time band preserves its existing calendar reference',()=>{
 let m=advance(start(emptyMem(),'왕국력 312년 봄 3일'));const g=m.scenes[0].segs[1];editStoryTime(m,g.id,{date:'',day:2,period:'afternoon',mode:'present'});
 assert.match(storyTimeContext(m,'ko'),/왕국력 312년 봄 3일 \+1일 · 오후/);
});
test('the original wall clock and future appointments do not themselves change story time',()=>{
 let m=start();m=save(m,{start:raw('same'),end:raw('same')},'Meet tomorrow. This is only an appointment, not the next day.');assert.equal(date(m),'2026-10-24');
});
test('long original calendar labels still respect a small memory injection budget',()=>{
 const label='긴이름'.repeat(55);const m=start(emptyMem(),label);assert(buildInjection(m,{budget:300}).tokens<=300);
});

test('short literal time quotes work without relaxing normalized terms quotes',async()=>{
 const {findQuote}=await import('../core.js');
 for(const quote of ['다음 날','이틀 뒤','새벽','3시']) {
  const isDay=quote==='다음 날'||quote==='이틀 뒤';
  const m=save(start(),{end:raw(isDay?'advance':'explicit',{quote,...(isDay?{days:quote==='다음 날'?1:2}:{period:'dawn'})})},`이야기는 ${quote}에 이어졌다.`);
  assert.notEqual(now(m).certainty,'unconfirmed',quote);
 }
 assert.equal(findQuote('다음 날 아침','다음 날'),null,'promise quote minimum remains unchanged');
 const absent=save(start(),{end:raw('advance',{days:1,quote:'다음날'})},'다음 날 아침');assert.equal(now(absent).certainty,'unconfirmed');
 const normalized=save(start(),{end:raw('advance',{days:1,quote:'이튿날 아침이 밝았다'})},'**이튿날**\n아침이 밝았다.');assert.equal(date(normalized),'2026-10-25');
});
test('a flashback without any known time never invents a recording reference',()=>{
 let m=start();m=save(m,{mode:'flashback'},'An undated past scene.');const t=m.scenes[0].segs.at(-1).time;
 assert.equal(t.start.certainty,'unconfirmed');assert.equal(t.end.anchor,null);
 assert(!sceneTimeRange({segs:[{time:t}]},m.timeAnchors,'ko').includes('기록 기준'));
 assert.equal(date(m),'2026-10-24');
});
test('a period alone after an unknown interval is dated locally, never recording day one',()=>{
 let m=advance(start(),4);m=save(m,{end:raw('unknown')});
 m=save(m,{end:raw('explicit',{period:'night'})},'밤이 깊었다.');
 assert.equal(storyTimeContext(m,'ko'),'날짜 미상 · 밤');
 assert(!buildInjection(m).text.includes('Last recorded story time: recording day 1'));
 m=advance(m);assert.match(storyTimeContext(m,'ko'),/날짜 미상 · 이튿날/);
 const same=cleanMem(JSON.parse(JSON.stringify(m)));assert.equal(storyTimeContext(same,'ko'),storyTimeContext(m,'ko'));
});
test('only the initial present reference uses recording-day wording',()=>{
 let m=save(emptyMem(),{start:raw('same')});assert.equal(storyTimeContext(m,'ko'),'기록 기준 1일째');
 m=advance(m,4);assert.match(storyTimeContext(m,'ko'),/기록 기준 5일째/);
 m=save(m,{end:raw('unknown')});m=save(m,{end:raw('explicit',{period:'night'})},'The night grew dark.');
 const label=storyTimeContext(m,'ko');editStoryTime(m,'g1',{edge:'start',date:'',day:1,period:'morning'});
 assert.equal(storyTimeContext(m,'ko'),label,'recomputation does not rename a later local reference');
});
test('backward present ISO dates are held unknown, while flashbacks and manual corrections remain valid',()=>{
 let m=start();m=save(m,{end:raw('explicit',{date:'2026-10-20'})},'The letter was dated 2026-10-20.');
 assert.equal(now(m).certainty,'unconfirmed');assert.equal(now(m).day,null);
 m=advance(m);assert.equal(now(m).certainty,'unconfirmed');
 let f=start();f=save(f,{mode:'flashback',start:raw('explicit',{date:'2026-10-22'}),end:raw('explicit',{date:'2026-10-20'})},'2026-10-22, then another past scene: 2026-10-20.');
 assert.equal(dateAt(f.scenes[0].segs.at(-1).time.end,f.timeAnchors),'2026-10-20');assert.equal(date(f),'2026-10-24');
 editStoryTime(f,'g1',{date:'2026-10-20',day:1,mode:'present'});assert.equal(date(f),'2026-10-20');
 let custom=start();custom=start(custom,'왕국력 312년 봄 3일');assert.notEqual(now(custom).certainty,'unconfirmed');
});
test('a blank manual day remains unknown through persistence and recomputation',()=>{
 let m=start();m=save(m,{end:raw('unknown')});const g=m.scenes[0].segs.at(-1);
 editStoryTime(m,g.id,{date:'',day:'',period:'night',mode:'present'});
 assert.equal(now(m).day,null);assert.equal(now(m).certainty,'manual');assert.equal(storyTimeContext(m,'ko'),'날짜 미상 · 밤');
 m=cleanMem(JSON.parse(JSON.stringify(m)));editStoryTime(m,g.id,{date:'',day:'',period:'evening',mode:'present'});
 assert.equal(now(m).day,null);assert.equal(storyTimeContext(m,'ko'),'날짜 미상 · 저녁');
 m=advance(m);assert.match(storyTimeContext(m,'ko'),/날짜 미상 · 이튿날/);
});
test('a manual date with no day stays a usable calendar date without assigning a recording day',()=>{
 let m=save(emptyMem(),{end:raw('unknown')});editStoryTime(m,'g1',{date:'2026-10-24',day:'',period:'night'});
 assert.equal(now(m).day,null);assert.equal(date(m),'2026-10-24');m=advance(m);assert.equal(date(m),'2026-10-25');
});
test('an explicitly entered manual day is visible as its own reference',()=>{
 const m=save(emptyMem(),{end:raw('unknown')});editStoryTime(m,'g1',{day:5,period:'night'});
 assert.equal(storyTimeContext(m,'ko'),'직접 지정 기준 5일째 · 밤');
});
test('legacy multiple record anchors keep only the first reference numbered',()=>{
 let m=save(emptyMem(),{start:raw('same')});m=save(m,{end:raw('unknown')});
 m=save(m,{end:raw('explicit',{period:'night'})},'The night grew dark.');
 for(const a of Object.values(m.timeAnchors)){delete a.numbered;delete a.counted;a.kind='record';}
 m=cleanMem(m);const gs=m.scenes[0].segs;
 assert.equal(formatStoryStamp(gs[0].time.end,m.timeAnchors,'ko'),'기록 기준 1일째');
 assert.equal(storyTimeContext(m,'ko'),'날짜 미상 · 밤');
});
test('null manual days and local references survive room detachment and history replay',()=>{
 const before=save(start(),{end:raw('unknown')});let after=structuredClone(before);
 editStoryTime(after,'g2',{day:'',period:'night'});const diff=memDiff(before,after);
 const restored=applyDiff(after,diff,true);assert.deepEqual(restored,before);
 after=cleanMem(detachMem(applyDiff(restored,diff,false),'room-A'));
 assert.equal(now(after).day,null);assert.equal(storyTimeContext(after,'ko'),'날짜 미상 · 밤');
 after=advance(after);assert.match(storyTimeContext(after,'ko'),/날짜 미상 · 이튿날/);
});
