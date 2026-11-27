import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewAnswers,reviewMaterials,reviewSourceKey,reviewIsStale,quoteParts,serializeReviewReport,validateReviewReport} from '../frontend/committee-ui.js';
import rubric from '../frontend/rubric.json' with {type:'json'};
function workspace() {return {company:'가상회사',role:'개발',facts:[],questions:[{id:'q1',title:'경험',headRevisionId:'r2',approvedRevisionId:'r1',revisions:[{id:'r1',text:'😀 첫 경험\n  성과'},{id:'r2',text:'저장 초안'}]},{id:'q2',title:'협업',headRevisionId:'r3',approvedRevisionId:null,revisions:[{id:'r3',text:'협업 경험'}]}]};}
function report(w=workspace()) {
 const personas=rubric.roles.map(r=>({id:r.id,label:r.label,valid:true,score:r.criteria.reduce((a,c)=>a+c.weight,0),max:r.criteria.reduce((a,c)=>a+c.weight,0),criteria:r.criteria.map(c=>({id:c.id,label:c.label,level:'L4',weight:c.weight,points:c.weight})),deductions:[]}));
 const rounds=[{personas:structuredClone(personas)}];
 return {format:'careerproof-committee-report',version:1,sourceKey:'0'.repeat(64),source:{scope:'question',drafts:false,answerId:'q1'},provider:'ollama',model:'synthetic',questionCount:2,answers:reviewMaterials(w,{scope:'question',drafts:false,answerId:'q1'}).answers,result:{scope:'question',mode:'fast',personas:personas.map(p=>({...p,samples:1,complete:true,range:null})),rounds,total:{value:100,max:100,range:null,samples:1,complete:true},warnings:[],usage:{costUsd:'0'},calls:[]}};
}
test('approved versions precede opt-in saved drafts',()=>{const w=workspace();assert.equal(reviewAnswers(w).length,1);assert.equal(reviewAnswers(w,true).length,2);assert.equal(reviewAnswers(w,true)[0].text,'😀 첫 경험\n  성과');});
test('fingerprint binds only selected materials and contains no raw workspace',async()=>{
 const w=workspace(),r=report(w);r.sourceKey=await reviewSourceKey(w,r.source);
 assert.match(r.sourceKey,/^[a-f0-9]{64}$/);assert.equal(await reviewIsStale(w,r),false);
 w.questions[0].revisions[1].text='historic private draft';w.questions[1].title='unselected private title';
 w.research={portfolio:{filename:'private.pdf',pages:[{text:'private unused document'}]}};
 assert.equal(await reviewIsStale(w,r),false);
 assert.equal(JSON.stringify(r).includes('historic private draft'),false);
 assert.equal(JSON.stringify(r).includes('unselected private title'),false);
 assert.equal(JSON.stringify(r).includes('private unused document'),false);
 w.research.jdText='필수 요건: Python 개발 경험';assert.equal(await reviewIsStale(w,r),true);
 delete w.research;w.questions[0].revisions[0].text+=' 수정';assert.equal(await reviewIsStale(w,r),true);
});
test('import cannot pair different answers with a current claimed hash',async()=>{
 const w=workspace(),r=report(w);r.sourceKey=await reviewSourceKey(w,r.source);
 r.answers[0].text='forged alternative answer';validateReviewReport(r);
 assert.equal(await reviewIsStale(w,r),true);
});
test('scope, selected draft and format rules affect identity',async()=>{
 const w=workspace(),source={scope:'application',drafts:true,answerId:null};
 const r=report(w);r.source=source;r.answers=reviewMaterials(w,source).answers;r.sourceKey=await reviewSourceKey(w,source);
 assert.equal(await reviewIsStale(w,r),false);w.questions[1].revisions[0].text+=' changed';assert.equal(await reviewIsStale(w,r),true);
 assert.notEqual(await reviewSourceKey(w,source),await reviewSourceKey(w,{...source,drafts:false}));
 const key=await reviewSourceKey(w,source);w.questions[0].rule={maxChars:10};assert.notEqual(await reviewSourceKey(w,source),key);
});
test('unexpected report, answer, usage and call fields cannot be exported on import',()=>{
 for(const mutate of [r=>r.private='secret',r=>r.answers[0].revisions=['secret'],r=>r.result.private='secret',r=>r.result.usage.key='secret',r=>r.result.calls.push({provider:'ollama',path:'/api/chat',key:'secret'}),r=>r.source.key='secret']) {
  const r=report();mutate(r);assert.throws(()=>validateReviewReport(r));
 }
});

test('download stays within the matching import byte limit',()=>{
 const r=report();assert.deepEqual(JSON.parse(serializeReviewReport(r)),r);
 r.answers[0].text='가'.repeat(2*1024*1024);assert.throws(()=>serializeReviewReport(r),/4MiB/);
});

test('quote offsets use Unicode codepoints and verify exact text',()=>{assert.deepEqual(quoteParts('😀 첫 경험\n  성과',{start:2,end:11,quote:'첫 경험\n  성과'}),['😀 ','첫 경험\n  성과','']);assert.equal(quoteParts('😀 첫 경험',{start:3,end:4,quote:'첫'}),null);assert.equal(quoteParts('원문',{start:0,end:999,quote:'원문'}),null);});
test('full denominator and fabricated total rejected',()=>{const r=report();validateReviewReport(r);r.result.total.value=99;assert.throws(()=>validateReviewReport(r));});
test('partial denominator follows actual round coverage',()=>{const r=report();r.result.rounds[0].personas.shift();Object.assign(r.result.personas[0],{valid:false,score:null,max:0,samples:0,complete:false,range:null,criteria:[],deductions:[]});Object.assign(r.result.total,{value:80,max:80,range:null,samples:1,complete:false});validateReviewReport(r);r.result.total.max=100;assert.throws(()=>validateReviewReport(r));});
test('not assessable requires reason and excludes weight',()=>{const r=report();for(const p of [r.result.personas[0],r.result.rounds[0].personas[0]]) {Object.assign(p.criteria[0],{level:'not_assessable',points:null,reason:'자료 미확보'});p.score=12;p.max=12;}r.result.personas[0].complete=false;Object.assign(r.result.total,{value:92,max:92,complete:false});validateReviewReport(r);delete r.result.rounds[0].personas[0].criteria[0].reason;assert.throws(()=>validateReviewReport(r));});
test('deductions require original quote and aligned criterion',()=>{const r=report();for(const p of [r.result.personas[0],r.result.rounds[0].personas[0]]) {Object.assign(p.criteria[0],{level:'L3',points:5.6});Object.assign(p,{score:17.6,deductions:[{criterionId:'tech_1',answerId:'q1',start:2,end:3,quote:'첫',reason:'역할 불명확',fix:'역할 추가'}]});}Object.assign(r.result.total,{value:97.6});validateReviewReport(r);r.result.rounds[0].personas[0].deductions[0].start=3;assert.throws(()=>validateReviewReport(r));});
test('deep range must match paired round observations',()=>{const r=report();r.result.mode='deep';r.result.rounds.push(structuredClone(r.result.rounds[0]),structuredClone(r.result.rounds[0]));for(const p of r.result.personas){p.samples=3;p.range=[p.score,p.score];}Object.assign(r.result.total,{samples:3,range:[100,100]});validateReviewReport(r);r.result.total.range=[90,100];assert.throws(()=>validateReviewReport(r));});

test('real backend reports satisfy the shared frontend contract in both modes',async()=>{
 const {execFileSync}=await import('node:child_process');
 for(const mode of ['fast','deep']) {
  const result=JSON.parse(execFileSync('python',['-c',`import json;from tests.test_committee import Fake,request;from backend.committee import review_application;print(json.dumps(review_application(request('${mode}'),send=Fake())))`],{encoding:'utf8'}));
  const r=report();r.answers=[{id:'answer-1',title:'지원 동기',text:'😀 첫 경험\n  성과를 확인했습니다.'}];r.source={scope:result.scope,drafts:false,answerId:result.scope==='question'?'answer-1':null};r.result=result;validateReviewReport(r);
 }
});
