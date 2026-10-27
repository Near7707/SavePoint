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
