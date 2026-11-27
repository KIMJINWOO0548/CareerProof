import { researchContext } from "./research.js";

const cache = new WeakMap();
const cloudModels = {anthropic:"claude-haiku-4-5-20251001",openai:"gpt-4.1-mini-2025-04-14",gemini:"gemini-2.5-flash-lite"};
const isCloud = provider => Object.hasOwn(cloudModels, provider);
import rubric from "./rubric.json" with { type: "json" };
const roles = rubric.roles;
const anchors = rubric.levels;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = () => { throw new Error("보고서 형식·점수·원문 근거를 확인할 수 없습니다."); };
const near = (a,b) => typeof a === "number" && Math.abs(a-b)<.0011;

export function reviewAnswers(workspace, drafts = false) {
  return workspace.questions.flatMap(q => {
    const id = q.approvedRevisionId || (drafts ? q.headRevisionId : null);
    const r = q.revisions.find(r => r.id === id);
    return r?.text.trim() ? [{id:q.id,title:q.title,text:r.text,revisionId:r.id,approved:!!q.approvedRevisionId}] : [];
  });
}
export function reviewMaterials(workspace, source) {
  const all = reviewAnswers(workspace, source.drafts);
  const answers = (source.scope === 'question' ? all.filter(a => a.id === source.answerId) : all).map(({id,title,text}) => ({id,title,text}));
  const { requirements, portfolio, brief } = researchContext(workspace);
  const official = (workspace.research?.officialSources ?? []).map(s => `${s.label} · ${s.url}\n${s.text}`);
  const formatRules = workspace.questions.filter(q => answers.some(a => a.id === q.id))
    .map(q => ({ id: q.id, limit: q.limit, rule: q.rule }));
  return { answers, requirements, portfolio, brief: [brief, ...official].join("\n\n"), formatRules: JSON.stringify(formatRules) };
}
export async function reviewSourceKey(workspace, source) {
  const bytes = new TextEncoder().encode(JSON.stringify({source,materials:reviewMaterials(workspace,source)}));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,'0')).join('');
}
export async function reviewIsStale(workspace, report) {
  if (!report.source) return true;
  // The file's claimed digest alone cannot authenticate its answer text.
  if (JSON.stringify(report.answers) !== JSON.stringify(reviewMaterials(workspace,report.source).answers)) return true;
  return report.sourceKey !== await reviewSourceKey(workspace,report.source);
}
export function quoteParts(text, deduction) {
  const chars = Array.from(text);
  const {start,end,quote} = deduction;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || end<=start || end>chars.length || chars.slice(start,end).join("")!==quote) return null;
  return [chars.slice(0,start).join(""),quote,chars.slice(end).join("")];
}
// Imported reports remain user-provided files, never authenticated model receipts.
export function validateReviewReport(report) {
  if (report?.format!=="careerproof-committee-report" || report.version!==1 || typeof report.sourceKey!=="string" || !Array.isArray(report.answers) || !report.answers.length || report.answers.length>10 || typeof report.model!=="string" || !["ollama","anthropic","openai","gemini"].includes(report.provider)) fail();
  const only=(o,allowed)=>{if(!o || typeof o!=='object' || Array.isArray(o) || Object.keys(o).some(k=>!allowed.includes(k))) fail();};
  only(report,['format','version','createdAt','sourceKey','source','questionCount','provider','model','answers','result']);
  if(!/^[a-f0-9]{64}$/.test(report.sourceKey)) fail();
  only(report.source,['scope','drafts','answerId']);
  if(!['question','application'].includes(report.source.scope) || typeof report.source.drafts!=='boolean' || (report.source.scope==='question'?typeof report.source.answerId!=='string':report.source.answerId!==null)) fail();
  if(!Number.isSafeInteger(report.questionCount) || report.questionCount<report.answers.length) fail();
  const ids = new Set();
  for (const a of report.answers) {
    only(a,['id','title','text']);
    if (typeof a?.id!=="string" || ids.has(a.id) || typeof a.text!=="string" || typeof a.title!=="string") fail();
    ids.add(a.id);
  }
  const r=report.result;
  only(r,['scope','mode','total','personas','rounds','warnings','usage','calls']);
  if(r.scope!==report.source.scope || (r.scope==='question' && report.answers[0].id!==report.source.answerId)) fail();
  if(r.usage!==undefined) {
    only(r.usage,['costUsd','knownCostUsd','inputTokens','outputTokens']);
    for(const [k,v] of Object.entries(r.usage)) if(k.endsWith('Tokens')?(!Number.isSafeInteger(v)||v<0):(v!==null && (typeof v!=='string'||!/^\d+(?:\.\d+)?(?:E[+-]?\d+)?$/i.test(v)))) fail();
  }
  if(r.calls!==undefined) {
    if(!Array.isArray(r.calls)) fail();
    for(const call of r.calls) {only(call,['provider','path']);if(call.provider!==report.provider || !({ollama:['/api/show','/api/chat'],anthropic:['/v1/messages','/v1/messages/count_tokens'],openai:['/v1/chat/completions'],gemini:[`/v1beta/models/${report.model}:generateContent`]}[call.provider]??[]).includes(call.path)) fail();}
  }
  if (!["question","application"].includes(r?.scope) || !["fast","deep"].includes(r.mode) || (r.scope==="question" && report.answers.length!==1) || !Array.isArray(r.personas) || r.personas.length!==5 || !Array.isArray(r.warnings) || r.warnings.some(w=>typeof w!=="string")) fail();
  const expected=r.mode==='fast'?1:3;
  if(!Array.isArray(r.rounds) || r.rounds.length!==expected) fail();
  const keys=(o,allowed)=>{if(!o || Object.keys(o).some(k=>!allowed.includes(k))) fail();};
  const coverage=ps=>ps.flatMap(p=>p.criteria.filter(c=>c.level!=='not_assessable').map(c=>c.id));
  const round3=n=>Math.round(n*1000)/1000;
  const med=xs=>{const a=[...xs].sort((a,b)=>a-b);return round3((a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2);};
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const compare=(actual,wanted)=>{for(const [k,v] of Object.entries(wanted)) {if(typeof v==='number'? !near(actual[k],v):!same(actual[k],v)) fail();}};
  for(const rr of r.rounds) {
    keys(rr,['personas']);
    if(!Array.isArray(rr.personas) || rr.personas.length>5 || new Set(rr.personas.map(p=>p.id)).size!==rr.personas.length) fail();
    for(const p of rr.personas) {
      keys(p,['id','label','valid','score','max','criteria','deductions']);
      const role=roles.find(x=>x.id===p.id);
      if(!role || p.label!==role.label || p.valid!==true || !Array.isArray(p.criteria) || p.criteria.length!==3 || !Array.isArray(p.deductions)) fail();
      let score=0,max=0;
      role.criteria.forEach((spec,i)=>{
        const c=p.criteria[i];
        keys(c,['id','label','level','weight','points','reason']);
        if(c.id!==spec.id || c.label!==spec.label || c.weight!==spec.weight) fail();
        const ds=p.deductions.filter(d=>d.criterionId===c.id);
        if(c.level==='not_assessable') {
          if(c.points!==null || typeof c.reason!=='string' || !c.reason.trim() || c.reason.length>700 || c.reason.includes('CPMASK_') || ds.length) fail();
        } else {
          if(!Object.hasOwn(anchors,c.level) || !near(c.points,c.weight*anchors[c.level]) || (c.level==='L4'?ds.length!==0:ds.length<1) || ds.length>3 || Object.hasOwn(c,'reason')) fail();
          score+=c.points;max+=c.weight;
        }
      });
      for(const d of p.deductions) {
        keys(d,['answerId','quote','start','end','criterionId','reason','fix']);
        const a=report.answers.find(a=>a.id===d.answerId);
        if(!a || !p.criteria.some(c=>c.id===d.criterionId) || !quoteParts(a.text,d) || ['quote','reason','fix'].some(k=>typeof d[k]!=='string'||!d[k].trim()||d[k].length>700||d[k].includes('CPMASK_'))) fail();
      }
      compare(p,{score:round3(score),max});
    }
    rr.personas.sort((a,b)=>roles.findIndex(x=>x.id===a.id)-roles.findIndex(x=>x.id===b.id));
  }
  roles.forEach(role=>{
    const matches=r.personas.filter(p=>p.id===role.id);if(matches.length!==1) fail();
    const p=matches[0],ss=r.rounds.flatMap(rr=>rr.personas.filter(p=>p.id===role.id));
    keys(p,['id','label','valid','score','max','criteria','deductions','samples','complete','range']);
    if(!ss.length) {compare(p,{id:role.id,label:role.label,valid:false,score:null,max:0,criteria:[],deductions:[],samples:0,complete:false,range:null});return;}
    const best=ss.reduce((a,b)=>a.max>=b.max?a:b), cs=ss.filter(p=>same(coverage([p]),coverage([best])));
    const chosen=[...cs].sort((a,b)=>a.score-b.score)[Math.floor(cs.length/2)];
    compare(p,{...chosen,score:med(cs.map(p=>p.score)),samples:cs.length,complete:chosen.max===role.criteria.reduce((n,c)=>n+c.weight,0),range:r.mode==='deep'&&cs.length>=2?[Math.min(...cs.map(p=>p.score)),Math.max(...cs.map(p=>p.score))]:null});
  });
  const obs=r.rounds.filter(rr=>rr.personas.length).map(rr=>({value:round3(rr.personas.reduce((n,p)=>n+p.score,0)),max:rr.personas.reduce((n,p)=>n+p.max,0),coverage:coverage(rr.personas)}));
  const best=obs.reduce((a,b)=>!a||b.max>a.max||(b.max===a.max&&b.coverage.length>a.coverage.length)?b:a,null);
  const paired=obs.filter(t=>same(t.coverage,best?.coverage));
  keys(r.total,['value','max','samples','complete','range']);
  compare(r.total,{value:paired.length?med(paired.map(t=>t.value)):null,max:best?.max??0,samples:paired.length,complete:!!best&&best.coverage.length===15,range:r.mode==='deep'&&paired.length>=2?[Math.min(...paired.map(t=>t.value)),Math.max(...paired.map(t=>t.value))]:null});
  return report;
}

export function serializeReviewReport(report) {
  validateReviewReport(report);
  const json=JSON.stringify(report,null,2);
  if(new TextEncoder().encode(json).length>4*1024*1024) throw new Error('보고서가 가져오기 제한 4MiB를 초과하여 내려받을 수 없습니다. 평가 문항 수를 줄이세요.');
  return json;
}

function resultHTML(report, stale) {
  const r=report.result, t=r.total;
  return `<section class="panel committee-results" aria-label="위원회 평가 결과">
    <div class="section-line"><h2>검토 결과</h2><button type="button" class="btn secondary" data-download>보고서 JSON 받기</button></div>
    ${stale?'<p class="committee-warning" role="status">원문 또는 채용·포트폴리오 자료가 변경되었습니다. 이전 자료의 결과이며 현재 답변의 점수가 아닙니다.</p>':''}
    <p>${r.scope==='question'?'문항 평가':`지원서 중 ${report.answers.length} / ${report.questionCount}문항 평가`} · ${esc(report.model)} · ${r.mode==='fast'?'빠른':'심층'} 검토</p>
    <p class="committee-score">${t.value===null?'유효 점수 없음':`${t.value} / ${t.max}점`} ${t.complete?'':'<span class="badge warning">부분 결과</span>'}</p>
    <p class="metadata">${t.range?`관측 회차 범위 ${t.range[0]}–${t.range[1]}점 · `:''}동일 기준의 유효 회차 ${t.samples}개. 분모는 해당 회차의 평가 가능한 기준만 합산합니다. 부분 결과를 100점으로 환산하지 않습니다.</p>
    <p>이 점수는 작성 근거의 진단이며 합격 확률이 아닙니다. 동일 모델의 5개 관점은 독립적인 사람 5명의 의견이 아닙니다. 같은 모델로 작성·평가하면 자기 선호가 생길 수 있습니다. 블라인드 처리도 편향을 완전히 없애지는 못합니다.</p>
    <details class="action-details"><summary>15개 기준별 L1–L4 앵커와 자료 범위</summary><p>L1=0%, L2=40%, L3=70%, L4=100%. 적용 가능하나 근거 없음은 L1, 필수 자료 자체가 없으면 사유와 함께 평가 불가로 표시하고 분모에서 제외합니다.</p>${roles.map(role=>`<h3>${esc(role.label)} · ${role.criteria.reduce((n,c)=>n+c.weight,0)}점</h3>${role.criteria.map(c=>`<p><strong>${esc(c.label)} (${c.weight})</strong><br>${Object.entries(c.anchors).map(([l,a])=>`${l}: ${esc(a)}`).join('<br>')}</p>`).join('')}`).join('')}<p>실무 팀장: 답변·채용 요구사항·포트폴리오 / 실무 팀원: 답변·요구사항·포트폴리오 / 인사 팀장: 답변·회사 브리프 / 인사 담당자: 답변·분량 규칙 / 임원: 답변 앞 1,500자 원문 연결 발췌·브리프 요약 (별도 요약·핵심 주장 3개 미제공). Fast는 공유 입력 1회로 접근 격리가 없습니다. Deep은 역할별 독립 호출 3회이며 같은 기준의 실제 회차만 비교합니다. 회차가 2개 이상일 때만 관측 범위를 표시합니다. 아래 근거는 해당 역할의 상위 중앙 표본이므로 총점 중앙 회차와 다를 수 있습니다.</p></details>
    ${r.warnings.map(w=>`<p class="committee-warning">${esc(w)}</p>`).join('')}
    <div class="committee-personas">${r.personas.map(p=>`<article class="committee-persona"><h3>${esc(p.label)}</h3><p class="committee-persona-score">${p.valid?`${p.score} / ${p.max}점`:'유효 평가 없음'}</p><p class="metadata">${p.samples} / ${r.mode==='fast'?1:3}표본${p.range?` · 범위 ${p.range[0]}–${p.range[1]}`:''}</p>
      ${p.criteria.map(c=>`<p><strong>${esc(c.label)}</strong> · ${esc(c.level)} · ${c.level==='not_assessable'?`평가 불가 · ${esc(c.reason)}`:`${c.points} / ${c.weight}`}</p>`).join('')}
      ${p.deductions.map((d,i)=>`<div class="committee-deduction"><button type="button" class="quote-button" data-persona="${esc(p.id)}" data-deduction="${i}" aria-label="감점 원문 보기: ${esc(d.quote)}">“${esc(d.quote)}”</button><p>${esc(d.reason)}</p><p><strong>수정 행동:</strong> ${esc(d.fix)}</p></div>`).join('')}
    </article>`).join('')}</div>
    <div data-original tabindex="-1" class="committee-original" aria-live="polite"><p>감점 인용을 선택하면 평가 당시 원문에서 해당 문장을 표시합니다.</p></div>
    <p class="metadata">보고 비용: ${r.usage?.costUsd===null?'불명확 · 제공자 사용 내역 확인':`$${esc(r.usage?.costUsd ?? '미보고')}`} · 전송 기록 ${Array.isArray(r.calls)?r.calls.length:0}건 (모델 확인·토큰 계산 포함)</p>
    <p class="metadata">결과는 이 프로젝트의 탭 메모리에 보관됩니다. 페이지 이동 후에도 남지만 새로고침 전 보고서를 내려받으세요. 가져온 파일은 사용자 제공 자료이며 서버 서명으로 인증되지 않습니다.</p>
  </section>`;
}

export function mountCommittee(stage, {workspace, writerModel = "", onChanged = () => {}}) {
  let busy=false, report=cache.get(workspace), disposed=false;
  stage.innerHTML=`<div class="committee form-flow"><section class="panel"><h2>다섯 관점으로 답변 검토</h2><p>확정 답변을 기준으로 근거와 수정 행동을 확인합니다. 점수는 합격 예측이 아닙니다.</p>
    <form class="form-flow" data-committee-form><fieldset class="committee-fields"><legend>평가 자료와 실행 설정</legend>
    <label class="check-row"><input type="checkbox" name="drafts">확정본이 없는 문항은 저장된 최신 초안 사용 (저장 전 편집은 제외)</label>
    <div class="field-grid"><label class="field"><span>범위</span><select name="scope"><option value="question">선택 문항</option><option value="application">사용 가능한 지원서 문항</option></select></label><label class="field"><span>평가 문항</span><select name="answer"></select></label></div>
    <p data-coverage class="metadata"></p><div class="field-grid"><label class="field"><span>제공자</span><select name="provider"><option value="ollama">Ollama · 설치된 로컬 모델</option><option value="anthropic">Anthropic · 내 API 키</option><option value="openai">OpenAI · 내 API 키</option><option value="gemini">Gemini · 내 API 키</option></select></label><label class="field"><span>모델</span><input name="model" required maxlength="120" placeholder="예: qwen3:8b" autocomplete="off"></label></div>
    <p data-writer-warning class="committee-warning" role="status" hidden></p>
    <label class="field" data-key hidden><span>BYOK API 키 (이번 요청의 헤더에만 사용)</span><input type="password" name="key" autocomplete="off" maxlength="512"></label>
    <div class="field-grid"><label class="field"><span>평가 모드</span><select name="mode"><option value="fast">빠른 · 생성 최대 1회</option><option value="deep">심층 · 5관점 × 3회, 생성 최대 15회</option></select></label><label class="field"><span>총 예산 상한 (USD · 최대 1)</span><input type="number" name="budget" min="0" max="1" step="0.001" value="0"></label></div>
    <p class="metadata">Fast는 동일 입력을 공유하므로 자료 접근이 격리되지 않습니다. 블라인드 자료는 입력에서 제외하세요. Deep은 실제 역할별 호출을 분리하며 관측 범위는 신뢰구간이 아닙니다. 자동 재시도 없음. 로컬 모델 확인 1회, Anthropic은 생성마다 토큰 계산 요청이 추가됩니다. OpenAI·Gemini는 전송할 UTF-8 바이트 수와 여유분으로 입력 비용을 보수적으로 확보합니다. 클라우드는 최대 출력 비용을 먼저 확보하며 예산 부족 시 부분 결과가 됩니다. 심층 검토는 최대 180초 안에서 진행합니다.</p>
    <label class="field"><span>블라인드 처리할 이름·학교 등 (한 줄에 하나)</span><textarea name="redact" rows="2" placeholder="직접 입력한 문구를 전송 전 서버에서 가립니다."></textarea></label>
    <details class="action-details"><summary>전송할 정확한 자료 확인</summary><pre data-materials class="committee-materials"></pre></details>
    <p>전송 자료: 선택한 답변·문항 제목, 채용 요구사항, 포트폴리오 본문. 서버가 입력한 블라인드 문구와 이메일·전화번호를 가린 뒤 선택한 모델에 보냅니다. 실무 팀장은 답변·요구사항·포트폴리오, 실무 팀원은 답변·요구사항·포트폴리오, 인사 팀장은 답변·회사 브리프, 인사 담당자는 답변·분량 규칙, 임원은 답변 앞 1,500자 발췌·브리프 요약을 읽습니다. 임원용 별도 요약·핵심 주장 3개는 미제공으로 표시합니다. Fast에서는 이 자료를 공통 입력으로 공유합니다.</p>
    <label class="check-row"><input name="consent" type="checkbox" required>위 자료와 제공자·모드·예산을 확인했으며 모델 전송에 동의합니다.</label>
    <div><button class="btn primary" type="submit">동의한 자료로 평가 시작</button></div>
    </fieldset></form><p data-review-status role="status" aria-live="polite"></p>
    <label class="field"><span>이 프로젝트에서 내려받은 보고서 가져오기 (최대 4MiB)</span><input data-import type="file" accept=".json,application/json"></label></section><div data-results></div></div>`;
  const form=stage.querySelector('[data-committee-form]'), fields=form.querySelector('fieldset'), output=stage.querySelector('[data-results]'), status=stage.querySelector('[data-review-status]');
  const el=name=>form.elements.namedItem(name);
  const selected=()=> { const all=reviewAnswers(workspace,el('drafts').checked); return el('scope').value==='question'?all.filter(a=>a.id===el('answer').value):all; };
  const sourceSelection=()=>({scope:el('scope').value,drafts:el('drafts').checked,answerId:el('scope').value==='question'?el('answer').value:null});
  const materials=()=>reviewMaterials(workspace,sourceSelection());
  function updateWriterWarning() {
    const warning=stage.querySelector('[data-writer-warning]');
    warning.hidden=!writerModel || el('model').value.trim()!==writerModel;
    warning.textContent=warning.hidden?'':'작성에 사용한 모델과 같습니다. 같은 모델의 자기 선호가 평가에 반영될 수 있으니 다른 모델도 고려하세요.';
  }
  function update() {
    updateWriterWarning();
    const all=reviewAnswers(workspace,el('drafts').checked), old=el('answer').value;
    el('answer').innerHTML=all.map(a=>`<option value="${esc(a.id)}">${esc(a.title)} · ${a.approved?'확정본':'저장 초안'}</option>`).join('');
    if(all.some(a=>a.id===old)) el('answer').value=old;
    el('answer').disabled=el('scope').value==='application';
    stage.querySelector('[data-coverage]').textContent=`평가 ${selected().length} / 전체 ${workspace.questions.length}문항 · 확정 ${all.filter(a=>a.approved).length}문항 · 비어 있거나 미선택인 문항 제외 · 최대 10문항`;
    stage.querySelector('[data-materials]').textContent=JSON.stringify(materials(),null,2);
  }
  let showVersion=0;
  async function show() {
    const version=++showVersion, current=report;
    const stale=current?await reviewIsStale(workspace,current):false;
    if(disposed || version!==showVersion || current!==report) return;
    output.innerHTML=report?resultHTML(report,stale):'<section class="panel"><p class="empty-message">아직 평가하지 않았습니다. 모델 연결 없이 점수를 만들지 않습니다.</p></section>';
    if(!report) return;
    output.querySelector('[data-download]').onclick=()=> {
      let json;try {json=serializeReviewReport(report);} catch(error) {status.textContent=error.message;return;}
      const url=URL.createObjectURL(new Blob([json],{type:'application/json'}));
      const a=document.createElement('a'); a.href=url; a.download='careerproof-committee-report.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    output.querySelectorAll('[data-deduction]').forEach(button=>button.onclick=()=> {
      const d=report.result.personas.find(p=>p.id===button.dataset.persona).deductions[Number(button.dataset.deduction)], a=report.answers.find(a=>a.id===d.answerId), parts=quoteParts(a.text,d), view=output.querySelector('[data-original]');
      if(!parts) return;
      view.innerHTML=`<h3>${esc(a.title)} · 평가 당시 원문</h3><p class="plain-output">${esc(parts[0])}<mark>${esc(parts[1])}</mark>${esc(parts[2])}</p>`;
      view.focus(); view.scrollIntoView({block:'nearest',behavior:'smooth'});
    });
  }
  form.addEventListener('change',event=> {
    if(event.target.name!=='consent') el('consent').checked=false;
    if(event.target.name==='provider') {
      const cloud=isCloud(el('provider').value);
      stage.querySelector('[data-key]').hidden=!cloud;
      el('model').value=cloud?cloudModels[el('provider').value]:''; el('model').readOnly=cloud;
      el('budget').value=cloud?'0.1':'0'; el('budget').min=cloud?'0.001':'0';
      el('key').value=''; el('key').required=cloud;
    }
    update();
  });
  form.addEventListener('input',event=> {if(event.target.name!=='consent') el('consent').checked=false; updateWriterWarning();});
  form.onsubmit=async event=> {
    event.preventDefault(); if(busy || !form.reportValidity()) return;
    const data=materials();
    if(!data.answers.length || data.answers.length>10) {status.textContent='평가할 답변을 1~10개 선택하세요. 확정본이 없다면 저장 초안 사용을 직접 선택하세요.'; return;}
    const provider=el('provider').value, model=el('model').value.trim();
    if((provider!=='ollama' && !isCloud(provider)) || (isCloud(provider) && model!==cloudModels[provider])) {status.textContent='평가 제공자와 고정 모델을 확인하세요.'; return;}
    const body={...data,provider,model,writerModel,scope:el('scope').value,mode:el('mode').value,budgetUsd:el('budget').value,confirmed:el('consent').checked,redactTerms:el('redact').value.split('\n').map(s=>s.trim()).filter(Boolean)};
    const source=sourceSelection(), questionCount=workspace.questions.length;
    const headers={'Content-Type':'application/json','X-CareerProof-Request':'1','X-CareerProof-Command':crypto.randomUUID()};
    if(isCloud(provider)) headers['X-LLM-API-Key']=el('key').value;
    el('key').value=''; busy=true; fields.disabled=true; stage.querySelector('[data-import]').disabled=true;
    status.textContent='모델 검토 중입니다. 설정은 잠겨 있으며 자동 재시도하지 않습니다.';
    try {
      const sourceKey=await reviewSourceKey(workspace,source);
      const response=await fetch('/api/committee',{method:'POST',headers,body:JSON.stringify(body),cache:'no-store'});
      const result=await response.json();
      if(!response.ok) throw new Error(result.error?.message || (typeof result.error==='string'?result.error:result.message) || '평가 요청을 처리하지 못했습니다.');
      const next={format:'careerproof-committee-report',version:1,createdAt:new Date().toISOString(),sourceKey,source,questionCount,provider,model,answers:clone(data.answers),result};
      validateReviewReport(next); report=next; cache.set(workspace,report);
      if(!disposed && stage.contains(form)) {show(); status.textContent='검토가 끝났습니다. 실제 유효 점수와 원문 근거를 확인하세요.';}
      onChanged();
    } catch(error) {if(!disposed && stage.contains(form)) status.textContent=`${error.message} 자동 재시도하지 않았습니다. 클라우드 요청이었다면 사용 내역을 확인한 뒤 직접 다시 실행하세요.`;}
    finally {delete headers['X-LLM-API-Key']; busy=false; if(!disposed && stage.contains(form)) {fields.disabled=false; stage.querySelector('[data-import]').disabled=false; update();}}
  };
  stage.querySelector('[data-import]').onchange=async event=> {
    try {
      const file=event.target.files?.[0]; if(!file) return;
      if(file.size>4*1024*1024) throw new Error('보고서는 4MiB 이하여야 합니다.');
      const next=validateReviewReport(JSON.parse(await file.text()));
      if(await reviewIsStale(workspace,next)) throw new Error('현재 프로젝트 자료와 일치하지 않는 보고서입니다. 원래 작업 JSON을 먼저 복원하세요.');
      report=next; cache.set(workspace,report); show(); status.textContent='원문 근거와 점수 계산을 확인한 사용자 보고서입니다. 서버 인증은 제공하지 않습니다.';
    } catch(error) {status.textContent=error.message;} finally {event.target.value='';}
  };
  update(); show();
  return {dispose(){disposed=true;},isBusy(){return busy;}};
}
