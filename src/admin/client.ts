type Values=Record<string,string|number|boolean>;
type Field={type:'string'|'number'|'boolean';required?:boolean;default?:string|number|boolean;enum?:Array<string|number|boolean>;maxLength?:number;format?:string};
type Template={id:string;name:string;version:number;inputs:Record<string,Field>};
type Delivery={id:string;kind:'email'|'push';state:string;attempts:number;error:string|null};
type Source={id:string;reference:string;error?:string|null};
type Pass={serial:string;version:number;templateId:string;personalization:Values;source:Source|null;deliveries:Delivery[];walletURL:string;downloadURL:string};
type Row={serial:string;displayName:string;memberId:string;homeClub:string;template_id:string;status:string;version:number;modified:number;source_id:string|null;sync_error:string|null};
type Component={id:string;name:string;state:string;detail:string;latencyMs?:number};
type Health={checkedAt:string;state:string;metrics:Record<string,number>;components:Component[]};
type View='passes'|'templates'|'status';
type Tab='details'|'delivery'|'updates';
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const input=(id:string)=>el<HTMLInputElement>(id);
const button=(id:string)=>el<HTMLButtonElement>(id);
const select=(id:string)=>el<HTMLSelectElement>(id);
const dialog=el<HTMLDialogElement>('editor');
const show=(id:string,visible:boolean)=>el(id).classList.toggle('hidden',!visible);
const node=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,className?:string)=>{
  const result=document.createElement(tag);if(text!==undefined)result.textContent=text;if(className)result.className=className;return result;
};
let key='',catalog:Template[]=[],current:Pass|null=null,loaded:Row[]=[],cursor:string|null=null,total=0;
let view:View=location.pathname==='/status'?'status':readView(),tab:Tab='details';
let ready=false,busy=false,detailsBaseline='',sourceBaseline='',loadSequence=0,listSequence=0;
let listAbort:AbortController|undefined,searchTimer:number|undefined,healthPending:Promise<void>|undefined;
let issueAttempt:{fingerprint:string;serial:string}|null=null,resendAttempt:{to:string;serial:string;id:string}|null=null;

function readView():View{const value=location.hash.slice(1);return value==='templates'||value==='status'?value:'passes';}
function notice(message:string,error=false,inside=dialog.open){const target=el(inside?'editor-notice':'notice');target.textContent=message;target.classList.toggle('error',error);}
function fail(error:unknown){notice(error instanceof Error?error.message:'Request failed.',true);}
function uuid(){
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  if(!crypto.getRandomValues)throw new Error('Open this site over HTTPS.');
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  return Array.from(bytes,(n,i)=>([4,6,8,10].includes(i)?'-':'')+n.toString(16).padStart(2,'0')).join('');
}
async function api<T>(path:string,options:RequestInit={}):Promise<T>{
  const response=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json',Authorization:'Bearer '+key,...options.headers}});
  const data=await response.json();
  if(!response.ok)throw Object.assign(new Error(response.status===412?'This pass changed elsewhere. Close and reopen it before saving.':data.error||'Request failed.'),{status:response.status});
  return data as T;
}
function badge(state:string,label?:string){return node('span',label||({healthy:'Verified',configured:'Configured',unconfigured:'Not configured',warning:'Attention',error:'Error'}[state]??state),'badge '+state);}
function selected(){return catalog.find(t=>t.id===select('template').value)!;}
function sourceValue():Source|null{return select('source').value?{id:select('source').value,reference:input('reference').value.trim()}:null;}
function values():Values{
  const data:Values={};
  for(const[name,spec]of Object.entries(selected().inputs)){
    const field=input('field-'+name);
    if(spec.type==='boolean')data[name]=field.checked;
    else if(field.value){
      if(spec.type==='number')data[name]=Number(field.value);
      else if(spec.format==='date-time')data[name]=field.value===field.dataset.originalDisplay?field.dataset.originalValue!:new Date(field.value).toISOString();
      else data[name]=field.value;
    }
  }
  return data;
}
function detailFingerprint(){return JSON.stringify({templateId:selected().id,values:values()});}
function detailsDirty(){return ready&&detailFingerprint()!==detailsBaseline;}
function sourceDirty(){return ready&&JSON.stringify(sourceValue())!==sourceBaseline;}
function dirty(){return detailsDirty()||sourceDirty()||(!current&&ready&&!!input('recipient').value);}
function updateState(){
  const changed=dirty();el('save-state').textContent=busy?'Working…':changed?'Unsaved changes':current?'Saved':'';
  dialog.querySelectorAll<HTMLButtonElement>('[data-write]').forEach(b=>b.disabled=busy||!ready);
  button('save-pass').disabled=busy||!ready||!!current&&!detailsDirty();
  button('save-source').disabled=busy||!ready||!sourceDirty();
  button('sync').disabled=busy||!current?.source||sourceDirty();
  show('save-pass',!current||tab==='details');
}
function setBusy(value:boolean){
  busy=value;
  dialog.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea').forEach(field=>field.disabled=busy||(field.id==='template'&&!!current));
  updateState();
}
async function write(action:()=>Promise<void>){if(busy)return;setBusy(true);notice('');try{await action();}catch(error){fail(error);}finally{setBusy(false);}}
function localDate(value:string){const d=new Date(value);if(!Number.isFinite(d.getTime()))return '';const pad=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;}
function renderFields(data:Values={}){
  el('fields').replaceChildren();el('optional-fields').replaceChildren();
  const labels:Record<string,string>={memberName:'Member name',memberId:'Member number',homeClub:'Home gym',memberPortalURL:'Member portal URL',expirationDate:'Expiration',voided:'Void pass'};
  for(const[name,spec]of Object.entries(selected().inputs)){
    const wrap=node('div',undefined,name==='message'?'field-wide':undefined);
    const label=node('label',(labels[name]??name.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase()))+(spec.required?' *':''));label.htmlFor='field-'+name;
    const field=spec.enum?node('select'):name==='message'?node('textarea'):node('input');
    field.id='field-'+name;field.name=name;field.required=!!spec.required;
    if(spec.enum)for(const value of spec.enum)field.append(new Option(String(value),String(value)));
    if(field instanceof HTMLInputElement){field.type=spec.type==='boolean'?'checkbox':spec.type==='number'?'number':spec.format==='https-url'?'url':spec.format==='date-time'?'datetime-local':'text';if(spec.format==='date-time')field.step='1';}
    const value=data[name]??spec.default??'';
    if(spec.type==='boolean'){(field as HTMLInputElement).checked=Boolean(value);wrap.className='checkbox-field';wrap.append(field,label);}
    else{
      field.value=spec.format==='date-time'?localDate(String(value)):String(value);
      if(spec.format==='date-time'){field.dataset.originalDisplay=field.value;field.dataset.originalValue=String(value);}
      if(spec.maxLength&&!(field instanceof HTMLSelectElement))field.maxLength=spec.maxLength;
      wrap.append(label,field);
    }
    field.addEventListener('input',()=>{updatePreview();updateState();});
    const advanced=['message','voided','expirationDate','memberPortalURL'].includes(name)&&!spec.required;
    el(advanced?'optional-fields':'fields').append(wrap);
  }
  show('more-fields',el('optional-fields').childElementCount>0);
  detailsBaseline=detailFingerprint();updatePreview();
}
function updatePreview(){
  const data=values();el<HTMLImageElement>('preview-art').src='/brand/'+encodeURIComponent(selected().id)+'/background@2x.png';
  el('preview-name').textContent=String(data.memberName||'New member');
  el('preview-summary').textContent=[data.memberId,data.homeClub,data.membership].filter(Boolean).join(' · ')||'Membership';
}
function switchTab(next:Tab){
  tab=next;
  for(const name of ['details','delivery','updates'] as Tab[]){show('panel-'+name,name===next);const b=button('tab-'+name);b.setAttribute('aria-selected',String(name===next));b.tabIndex=name===next?0:-1;}
  updateState();
}
function sourceState(){
  const value=sourceValue();show('reference-field',!!value);input('reference').required=!!value;
  el('source-note').textContent=current?.source?.error?'Last sync failed.':value?'Linked data updates this pass automatically.':'Edit this pass here to update it.';
  updateState();
}
function applyPass(pass:Pass){
  current=pass;select('template').value=pass.templateId;renderFields(pass.personalization);
  select('source').value=pass.source?.id??'';input('reference').value=pass.source?.reference??'';sourceBaseline=JSON.stringify(sourceValue());
  el('editor-kind').textContent='Edit pass';el('editor-title').textContent=String(pass.personalization.memberName||'Pass details');el('editor-badge').textContent='v'+pass.version;
  el('pass-serial').textContent=pass.serial;el('pass-version').textContent=String(pass.version);button('save-pass').textContent='Save';
  show('new-delivery',false);show('existing-delivery',true);show('source-actions',true);show('pass-info',true);select('template').disabled=true;
  el('result').replaceChildren();for(const[label,url]of [['View pass',pass.walletURL],['Download',pass.downloadURL]]){const link=node('a',label);link.href=url;link.target='_blank';link.rel='noreferrer';el('result').append(link);}
  ready=true;renderDeliveries();sourceState();updateState();
}
function openEditor(){notice('',false,false);notice('',false,true);el<HTMLDetailsElement>('more-fields').open=false;el<HTMLDetailsElement>('pass-info').open=false;if(!dialog.open)dialog.showModal();}
function closeEditor(){
  if(busy){notice('Wait for the request to finish.');return;}
  if(dirty()&&!confirm('Discard unsaved changes?'))return;
  ++loadSequence;ready=false;dialog.close();current=null;
}
function newPass(templateId?:string){
  ++loadSequence;current=null;ready=false;issueAttempt=null;resendAttempt=null;
  select('template').disabled=false;select('template').value=templateId??catalog[0].id;select('source').value='';input('reference').value='';input('recipient').value='';input('resend-to').value='';
  renderFields();sourceBaseline=JSON.stringify(null);el('editor-kind').textContent='New pass';el('editor-title').textContent='Member details';el('editor-badge').textContent='Draft';el('result').replaceChildren();button('save-pass').textContent='Create pass';
  show('new-delivery',true);show('existing-delivery',false);show('source-actions',false);show('pass-info',false);show('editor-loading',false);show('editor-content',true);
  ready=true;sourceState();switchTab('details');openEditor();input('field-'+Object.keys(selected().inputs)[0]).focus();
}
async function loadPass(serial:string){
  const sequence=++loadSequence;ready=false;current=null;resendAttempt=null;issueAttempt=null;input('resend-to').value='';
  openEditor();show('editor-loading',true);show('editor-content',false);el('editor-title').textContent='Pass details';updateState();
  try{const pass=await api<Pass>('/passes/'+encodeURIComponent(serial));if(sequence!==loadSequence)return;applyPass(pass);show('editor-content',true);switchTab('details');}
  catch(error){if(sequence===loadSequence){dialog.close();fail(error);}}
  finally{if(sequence===loadSequence)show('editor-loading',false);}
}
function renderDeliveries(){
  const holder=el('deliveries');holder.replaceChildren();
  if(!current?.deliveries.length){holder.append(node('p','No deliveries.','small muted help'));return;}
  for(const delivery of current.deliveries){
    const row=node('div',undefined,'delivery'),copy=node('div');copy.append(node('strong',delivery.kind==='email'?'Email':'Wallet update'),node('p',`${delivery.attempts} attempt${delivery.attempts===1?'':'s'}${delivery.error?' · '+delivery.error:''}`));
    const state=delivery.state==='sent'?'healthy':delivery.state==='failed'?'error':'warning';
    row.append(copy,badge(state,delivery.state==='sent'?(delivery.kind==='email'?'Accepted':'Complete'):delivery.state));
    if(delivery.state==='failed'){
      const retry=node('button','Retry','secondary');retry.type='button';retry.dataset.write='';
      retry.onclick=()=>write(async()=>{await api('/passes/'+encodeURIComponent(current!.serial)+'/deliveries/'+encodeURIComponent(delivery.id)+'/retry',{method:'POST'});await refreshDeliveries();notice('Retry queued.');});row.append(retry);
    }
    holder.append(row);
  }
}
async function refreshDeliveries(){
  if(!current)return;const serial=current.serial,sequence=loadSequence;button('refresh-deliveries').disabled=true;
  try{const latest=await api<Pass>('/passes/'+encodeURIComponent(serial));if(sequence!==loadSequence||current?.serial!==serial)return;current.deliveries=latest.deliveries;renderDeliveries();updateState();}
  finally{button('refresh-deliveries').disabled=false;}
}
function listFilters(){return {q:input('search').value.trim(),template:select('filter-template').value,status:select('filter-status').value};}
function renderRows(){
  const holder=el('pass-list');holder.replaceChildren();
  for(const pass of loaded){
    const row=node('tr');const cell=(column:string)=>{const td=node('td');td.dataset.column=column;row.append(td);return td;};
    const member=node('div',undefined,'member-cell'),image=node('img',undefined,'avatar');image.src='/brand/'+encodeURIComponent(pass.template_id)+'/background@2x.png';image.alt='';
    const copy=node('div'),name=node('button',pass.displayName,'member-link');name.type='button';name.setAttribute('aria-label','Edit '+pass.displayName);name.onclick=()=>void loadPass(pass.serial);copy.append(name,node('p',pass.memberId||pass.serial.slice(0,12),'member-id'));member.append(image,copy);cell('member').append(member);
    cell('gym').textContent=pass.homeClub||'—';cell('template').textContent=catalog.find(t=>t.id===pass.template_id)?.name??pass.template_id;
    const state=pass.status==='Active'?'healthy':['Suspended','Expired'].includes(pass.status)?'warning':'';
    cell('status').append(badge(state,pass.status||'—'));
    const updated=cell('updated');updated.append(node('span',new Date(pass.modified*1000).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})),node('small','v'+pass.version+(pass.sync_error?' · Sync failed':pass.source_id?' · API':''),'cell-sub'));
    const open=node('button','Open','row-action');open.type='button';open.setAttribute('aria-label','Open '+pass.displayName);open.onclick=()=>void loadPass(pass.serial);cell('action').append(open);holder.append(row);
  }
  show('list-empty',!loaded.length);show('more-passes',!!cursor);
  const filtered=Object.values(listFilters()).some(Boolean);el('empty-title').textContent=filtered?'No matches':'No passes';el('empty-description').textContent=filtered?'Try another search or filter.':'Create a pass to get started.';show('clear-filters',filtered);
  el('list-count').textContent=`${loaded.length} of ${total} pass${total===1?'':'es'}`;
}
async function browse(append=false){
  const sequence=++listSequence;listAbort?.abort();const controller=new AbortController();listAbort=controller;
  const params=new URLSearchParams(listFilters());if(append&&cursor)params.set('after',cursor);
  button('refresh-list').disabled=true;button('more-passes').disabled=true;el('list-count').textContent='Loading…';
  if(!append){loaded=[];cursor=null;el('pass-list').replaceChildren();show('list-empty',false);show('more-passes',false);}
  try{const data=await api<{passes:Row[];next:string|null;total:number}>('/passes?'+params,{signal:controller.signal});if(sequence!==listSequence)return;loaded=append?[...loaded,...data.passes]:data.passes;cursor=data.next;total=data.total;renderRows();}
  catch(error){if(sequence!==listSequence||controller.signal.aborted)return;el('list-count').textContent='Could not load passes.';fail(error);}
  finally{if(sequence===listSequence){button('refresh-list').disabled=false;button('more-passes').disabled=false;}}
}
function templateCards(){
  const holder=el('template-cards');holder.replaceChildren();
  for(const template of catalog){const card=node('article',undefined,'panel'),art=node('div',undefined,'theme-art');art.style.backgroundImage=`url('/brand/${encodeURIComponent(template.id)}/background@2x.png')`;const logo=node('img');logo.src='/brand/'+encodeURIComponent(template.id)+'/logo@2x.png';logo.alt=template.name;art.append(logo);const body=node('div',undefined,'template-body');body.append(node('h2',template.name),node('p',`Version ${template.version} · ${Object.keys(template.inputs).length} fields`));const use=node('button','New pass','secondary');use.type='button';use.onclick=()=>newPass(template.id);body.append(use);card.append(art,body);holder.append(card);}
}
function refreshHealth(){
  if(healthPending)return healthPending;
  button('refresh-health').disabled=true;
  healthPending=(async()=>{
    const data=await api<Health>('/status');for(const[k,v]of Object.entries(data.metrics))el('count-'+k).textContent=String(v);
    el('nav-count').textContent=String(data.metrics.passes);el('pass-heading-count').textContent=`${data.metrics.passes} membership pass${data.metrics.passes===1?'':'es'}`;
    el('checked-at').textContent='Checked '+new Date(data.checkedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});el('health-dot').className='health-dot '+data.state;
    const errors=data.components.filter(c=>['error','warning'].includes(c.state)).length;
    el('health-summary').replaceChildren(badge(errors?'warning':'healthy',errors?'Needs attention':'Checks passed'),node('span',errors?`${errors} component${errors===1?'':'s'} need attention.`:`${data.components.filter(c=>c.state==='healthy').length} verified · ${data.components.filter(c=>c.state==='configured').length} configured · ${data.components.filter(c=>c.state==='unconfigured').length} not configured`));
    const holder=el('components');holder.replaceChildren();
    for(const c of data.components){const row=node('article',undefined,'component'),copy=node('div');copy.append(node('h3',c.name),node('p',c.detail+(c.latencyMs!==undefined?' · '+c.latencyMs+' ms':'')));row.append(copy,badge(c.state));holder.append(row);}
  })().finally(()=>{button('refresh-health').disabled=false;healthPending=undefined;});
  return healthPending;
}
function switchView(next:View,changeURL=true){
  view=next;for(const name of ['passes','templates','status'])show('view-'+name,name===view);
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);b.setAttribute('aria-current',b.dataset.view===view?'page':'false');});
  const title={passes:'Passes',templates:'Templates',status:'Status'}[view];el('breadcrumb').textContent=title;document.title='Wallet · '+title;
  if(changeURL)history.pushState(null,'','/studio#'+view);
  notice('',false,false);if(key&&view==='status')void refreshHealth().catch(fail);
}
async function savePass(){
  const form=el<HTMLFormElement>('pass-form');
  if(!form.checkValidity()){switchTab('details');el<HTMLDetailsElement>('more-fields').open=true;form.reportValidity();return;}
  if(!current&&!input('recipient').checkValidity()){switchTab('delivery');input('recipient').reportValidity();return;}
  if(!current&&sourceValue()&&!input('reference').checkValidity()){switchTab('updates');input('reference').reportValidity();return;}
  await write(async()=>{
    if(current){
      const patch:Record<string,unknown>=values();for(const name of Object.keys(current.personalization))if(!(name in patch))patch[name]=null;
      const result=await api<{changed:boolean}>('/passes/'+encodeURIComponent(current.serial),{method:'PATCH',headers:{'If-Match':`"${current.version}"`},body:JSON.stringify({personalization:patch})});
      const latest=await api<Pass>('/passes/'+encodeURIComponent(current.serial));
      // Source edits have a separate save action. Do not overwrite them when saving fields.
      const sourceDraft=sourceValue(),sourceWasDirty=sourceDirty();applyPass(latest);
      if(sourceWasDirty){select('source').value=sourceDraft?.id??'';input('reference').value=sourceDraft?.reference??'';sourceState();}
      notice(result.changed?'Saved. Wallet update queued.':'No changes.');
    }else{
      const body:{templateId:string;personalization:Values;email?:string;source?:Source;serial?:string}={templateId:selected().id,personalization:values()};
      if(input('recipient').value)body.email=input('recipient').value;const source=sourceValue();if(source)body.source=source;
      const fingerprint=JSON.stringify(body);if(!issueAttempt||issueAttempt.fingerprint!==fingerprint)issueAttempt={fingerprint,serial:uuid()};body.serial=issueAttempt.serial;
      try{await api('/passes',{method:'POST',body:JSON.stringify(body)});}catch(error){if((error as {status?:number}).status!==409)throw error;}
      const pass=await api<Pass>('/passes/'+encodeURIComponent(body.serial));issueAttempt=null;applyPass(pass);notice(body.email?'Pass created. Email queued.':'Pass created.');
    }
    await Promise.all([browse(),refreshHealth().catch(()=>{})]);
  });
}

el<HTMLFormElement>('auth-form').onsubmit=async event=>{
  event.preventDefault();const submit=el('auth-form').querySelector('button')!;submit.disabled=true;key=input('token').value;
  try{
    const data=await api<{templates:Template[];sources:string[]}>('/templates');catalog=data.templates;
    select('template').replaceChildren();select('filter-template').replaceChildren(new Option('All templates',''));select('filter-status').replaceChildren(new Option('All statuses',''));select('source').replaceChildren(new Option('Manual',''));
    const statuses=new Set<string>(['Voided']);
    for(const template of catalog){select('template').append(new Option(template.name,template.id));select('filter-template').append(new Option(template.name,template.id));for(const status of template.inputs.status?.enum??[])statuses.add(String(status));}
    for(const status of statuses)select('filter-status').append(new Option(status,status));for(const source of data.sources)select('source').append(new Option(source,source));
    input('token').value='';show('signin',false);show('app-content',true);show('signout',true);templateCards();switchView(view,false);
    await Promise.all([browse(),refreshHealth()]);
  }catch(error){fail(error);if(!catalog.length)key='';}finally{submit.disabled=false;}
};
button('signout').onclick=()=>location.reload();
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b=>b.onclick=()=>switchView(b.dataset.view as View));
window.addEventListener('popstate',()=>switchView(location.pathname==='/status'?'status':readView(),false));
button('new-pass').onclick=()=>newPass();button('close-editor').onclick=closeEditor;button('cancel-editor').onclick=closeEditor;
dialog.addEventListener('cancel',event=>{event.preventDefault();closeEditor();});
window.addEventListener('beforeunload',event=>{if(dialog.open&&(dirty()||busy)){event.preventDefault();event.returnValue='';}});
select('template').onchange=()=>{const baseline=detailsBaseline,data=valuesForCurrentFields();renderFields(data);detailsBaseline=baseline;updateState();};
function valuesForCurrentFields():Values{const data:Values={};for(const field of el('pass-form').querySelectorAll<HTMLInputElement>('input,select,textarea'))if(field.id.startsWith('field-'))data[field.name]=field.type==='checkbox'?field.checked:field.type==='number'?Number(field.value):field.type==='datetime-local'&&field.value?new Date(field.value).toISOString():field.value;return data;}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b=>{
  b.onclick=()=>switchTab(b.dataset.tab as Tab);
  b.onkeydown=event=>{const names:Tab[]=['details','delivery','updates'];if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?2:(names.indexOf(tab)+(event.key==='ArrowRight'?1:2))%3;switchTab(names[index]);button('tab-'+names[index]).focus();};
});
input('search').oninput=()=>{clearTimeout(searchTimer);listAbort?.abort();searchTimer=window.setTimeout(()=>void browse(),250);};
for(const id of ['filter-template','filter-status'])select(id).onchange=()=>{clearTimeout(searchTimer);void browse();};
button('clear-filters').onclick=()=>{input('search').value='';select('filter-template').value='';select('filter-status').value='';void browse();};
button('refresh-list').onclick=()=>void Promise.all([browse(),refreshHealth()]).catch(fail);button('more-passes').onclick=()=>void browse(true);button('refresh-health').onclick=()=>void refreshHealth().catch(fail);
el<HTMLFormElement>('pass-form').onsubmit=event=>{event.preventDefault();void savePass().catch(fail);};
select('source').onchange=sourceState;input('reference').oninput=updateState;input('recipient').oninput=updateState;
button('refresh-deliveries').onclick=()=>void refreshDeliveries().catch(fail);
el<HTMLFormElement>('source-form').onsubmit=event=>{
  event.preventDefault();if(!current)return;
  void write(async()=>{await api('/passes/'+encodeURIComponent(current!.serial)+'/source',{method:'PUT',body:JSON.stringify({source:sourceValue()})});current!.source=sourceValue();sourceBaseline=JSON.stringify(sourceValue());sourceState();notice('Source saved.');await refreshHealth().catch(()=>{});});
};
button('sync').onclick=()=>{if(!current?.source)return;void write(async()=>{await api('/passes/'+encodeURIComponent(current!.serial)+'/sync',{method:'POST'});notice('Sync queued. Reopen the pass to load the result.');});};
el<HTMLFormElement>('resend-form').onsubmit=event=>{
  event.preventDefault();if(!current)return;
  void write(async()=>{const serial=current!.serial,to=input('resend-to').value;if(!resendAttempt||resendAttempt.to!==to||resendAttempt.serial!==serial)resendAttempt={serial,to,id:uuid()};await api('/passes/'+encodeURIComponent(serial)+'/email',{method:'POST',headers:{'Idempotency-Key':resendAttempt.id},body:JSON.stringify({to})});resendAttempt=null;await refreshDeliveries();notice('Email queued.');});
};
switchView(view,false);
