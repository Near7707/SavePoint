import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyMem,normalizeResult,validateResult,applyResult,cleanMem,dupState,sceneFull,buildInjection} from '../core.js';
import {extractionRepairNote} from '../prompts.js';
const chunk=(from=0,to=2)=>({from,to,indices:Array.from({length:to-from+1},(_,i)=>from+i),text:'',texts:{}});
const point=(n=0)=>({text:'A participant returned the repaired token.',kind:'moment',key:true,msgs:[n]});
const data=(scene={})=>({scenes:[{scene:'new',title:'At the gate',where:'Gate',who:[],outline:'The token was returned.',notes:'',ended:false,points:[point()],...scene}],entities:[],changes:[]});
const normalize=d=>{normalizeResult(d,{mem:emptyMem(),chunk:chunk()});return d;};
test('missing title and outline preserve validated points with explicit temporary markers',()=>{
 const d=normalize(data({title:'',outline:''}));assert.deepEqual(validateResult(d,{mem:emptyMem(),chunk:chunk()}),[]);
 const m=cleanMem(applyResult(emptyMem(),d,chunk()).mem);const s=m.scenes[0];assert.equal(s.titlePending,true);assert.equal(s.segs[0].outlinePending,true);assert.equal(s.segs[0].points[0].text,point().text);
 assert.equal(dupState(s,s.segs[0].points[0]),null);assert.equal(sceneFull(s).split(point().text).length-1,1);
 assert(buildInjection(m).text.includes(point().text));
});
test('a subsequent continuation replaces only an automatically temporary title',()=>{
 const d=normalize(data({title:null}));let m=applyResult(emptyMem(),d,chunk()).mem;
 const next=data({scene:'continue',title:'The token returns',points:[point(3)]});m=applyResult(m,next,chunk(3,3)).mem;assert.equal(m.scenes[0].title,'The token returns');assert.equal(m.scenes[0].titlePending,undefined);
 m.scenes[0].title='Chosen title';m.scenes[0].titlePending=true;m.scenes[0].titleUser=true;
 const protectedMem=cleanMem(applyResult(m,next,chunk(4,4)).mem);assert.equal(protectedMem.scenes[0].title,'Chosen title');assert.equal(protectedMem.scenes[0].titleUser,true);
});
test('malformed point arrays and absent content are never converted into successful empty saves',()=>{
 for(const points of [undefined,{},[],[{text:'A point.',kind:'moment',key:true,msgs:[]}]]) {
  const d=normalize(data({title:'',outline:'',points}));assert(validateResult(d,{mem:emptyMem(),chunk:chunk()}).length>0);
 }
});
test('metadata repair cannot excuse invalid evidence or unknown entities',()=>{
 for(const sc of [{title:'',outline:'',points:[point(999)]},{title:'',outline:'',who:['missing']}]) {
  const d=normalize(data(sc));assert(validateResult(d,{mem:emptyMem(),chunk:chunk()}).length>0);
 }
});
test('different new scenes with conflicting boundaries are not merged by metadata repair',()=>{
 const d=data();d.scenes.push({...d.scenes[0],title:'Harbor arrival',where:'Harbor',start:0});normalize(d);
 assert.equal(d.scenes.length,2);assert(validateResult(d,{mem:emptyMem(),chunk:chunk()}).length>0);
});
test('repair request lists real message ranges including holes and preceding starts',()=>{
 const t=extractionRepairNote({from:60,indices:[60,61,62,63,65,66,79]}, {scenes:[{}, {start:64}]});
 assert(t.includes('#60–#63, #65–#66, #79'));assert(t.includes('1: 60; 2: 64'));assert(t.includes('strictly after'));
});
test('a valid outline with no extra points can still receive a temporary title',()=>{
 const d=normalize(data({title:'',points:[]}));assert.deepEqual(validateResult(d,{mem:emptyMem(),chunk:chunk()}),[]);assert.equal(d.scenes[0].titlePending,true);assert.equal(d.scenes[0].outlinePending,undefined);
});
test('editing or deleting a provisional outline source cannot leave an obsolete claim in injection',async()=>{
 const {refreshProvisionalOutlines}=await import('../core.js');const d=normalize(data({outline:''}));const m=applyResult(emptyMem(),d,chunk()).mem;
 m.scenes[0].segs[0].points[0].text='The token is still broken.';refreshProvisionalOutlines(m);
 const injection=buildInjection(m).text;assert(injection.includes('The token is still broken.'));assert(!injection.includes('returned the repaired token'));
 m.scenes[0].segs[0].points=[];refreshProvisionalOutlines(m);assert.equal(m.scenes[0].segs[0].outline,'');
});
test('provisional outlines respect selection, pins, reselection and rekeying',async()=>{
 const {refreshProvisionalOutlines,applyRekey}=await import('../core.js');
 const d=normalize(data({outline:'',points:[point(),{...point(),text:'An optional detail was mentioned.',key:false},{...point(),text:'A pinned detail remains.'}]}));
 let m=applyResult(emptyMem(),d,chunk()).mem;let g=m.scenes[0].segs[0];
 assert(!buildInjection(m).text.includes('optional detail'));
 g.points[0].keyUser=false;g.points[2].pin=true;g.points[2].keyUser=false;refreshProvisionalOutlines(m);
 let injection=buildInjection(m).text;assert(!injection.includes('returned the repaired token'));assert(injection.includes('pinned detail'));
 g.points[1].keyUser=true;refreshProvisionalOutlines(m);assert(buildInjection(m).text.includes('optional detail'));
 delete g.points[1].keyUser;m=applyRekey(m,'s1',{'g1.1':true});assert(m.scenes[0].segs[0].outline.includes('optional detail'));
 m=applyRekey(m,'s1',{'g1.1':false});assert(!m.scenes[0].segs[0].outline.includes('optional detail'));
});
test('pinned fallback points appear once and belong to the dedicated pinned section',async()=>{
 const {refreshProvisionalOutlines}=await import('../core.js');
 const m=applyResult(emptyMem(),normalize(data({outline:''})),chunk()).mem,g=m.scenes[0].segs[0],p=g.points[0];
 p.pin=true;refreshProvisionalOutlines(m);let injection=buildInjection(m).text;
 assert.equal(injection.split(p.text).length-1,1,'the existing final injection already avoids an exact duplicate');
 assert.equal(g.outline,'','a pinned point no longer takes space in a provisional outline');
 assert(injection.includes('## Pinned points'));
 p.pin=false;refreshProvisionalOutlines(m);injection=buildInjection(m).text;
 assert.equal(injection.split(p.text).length-1,1);assert(g.outline.includes(p.text));
 p.keyUser=false;refreshProvisionalOutlines(m);assert(!buildInjection(m).text.includes(p.text));
});
