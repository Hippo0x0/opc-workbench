import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createOrchestrationCatalog} from '../src/orchestration-catalog.ts';
import {parseTemplateProposal,saveTemplateProposal} from '../src/chat-orchestration.ts';
import {createChat} from '../src/chat.ts';import {saveSettings} from '../src/settings.ts';import {startServer} from '../src/server.ts';
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'opc-compose-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const nodes=()=>[{id:'read',agentId:'opc-codebase-agent'},{id:'knowledge',agentId:'opc-knowledge-agent',parallel:true},{id:'approval',agentId:'system-approval'},{id:'export',agentId:'system-export'}];
const template=()=>({name:'自定义代码研究',description:'从对话创建',nodes:nodes()});
const proposal=value=>'已生成完整编排，待你确认。\n```opc-orchestration\n'+JSON.stringify(value)+'\n```';
const parse=(catalog,value)=>parseTemplateProposal(proposal(value),catalog,catalog.templates());
const wait=async fn=>{const deadline=Date.now()+5000;for(;;){if(fn())return;if(Date.now()>deadline)throw new Error('等待草案超时');await new Promise(resolve=>setTimeout(resolve,10));}};
const body=value=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
test('create proposal is validated, requires reviewed hash and saves only once',t=>{
 const catalog=createOrchestrationCatalog(temp(t)),result=parse(catalog,{operation:'create',template:template()});assert.ok(result.draft);assert.ok(!result.text.includes('```opc-orchestration'));assert.equal(catalog.templates().length,9);
 assert.throws(()=>saveTemplateProposal(result.draft,'stale',catalog),/草案已变化/);const saved=saveTemplateProposal(result.draft,result.draft.hash,catalog);assert.equal(saved.version,1);assert.equal(saved.nodes[1].parallel,true);assert.equal(catalog.templates().length,10);assert.equal(saveTemplateProposal(result.draft,result.draft.hash,catalog).id,saved.id);assert.equal(catalog.templates().length,10);
});
test('update preserves source identity and rejects a changed source version',t=>{
 const catalog=createOrchestrationCatalog(temp(t)),source=catalog.save(template());const result=parse(catalog,{operation:'update',sourceTemplateId:source.id,template:{...template(),name:'更新后的编排'}});assert.equal(result.draft.operation,'update');assert.equal(result.draft.sourceTemplateName,source.name);const saved=saveTemplateProposal(result.draft,result.draft.hash,catalog);assert.equal(saved.id,source.id);assert.equal(saved.version,2);
 const next=parse(catalog,{operation:'update',sourceTemplateId:source.id,template:{...template(),name:'过期草案'}});catalog.save({...saved,name:'页面中已更新'});assert.throws(()=>saveTemplateProposal(next.draft,next.draft.hash,catalog),/来源模板已变化/);assert.equal(catalog.templates().find(item=>item.id===source.id).name,'页面中已更新');
});
test('system template edits create a copy, never overwrite builtins',t=>{
 const catalog=createOrchestrationCatalog(temp(t)),source=catalog.templates()[0];const result=parse(catalog,{operation:'update',sourceTemplateId:source.id,template:template()});assert.equal(result.draft.operation,'create');const saved=saveTemplateProposal(result.draft,result.draft.hash,catalog);assert.notEqual(saved.id,source.id);assert.deepEqual(catalog.templates().find(item=>item.id===source.id),source);
});
test('invalid parallel writes, unknown Skills and missing gates never become savable drafts',t=>{
 const catalog=createOrchestrationCatalog(temp(t));for(const input of [
  {...template(),nodes:[{id:'a',agentId:'opc-codebase-agent'},{id:'b',agentId:'opc-coding-agent',parallel:true}]},
  {...template(),nodes:[{id:'a',agentId:'opc-codebase-agent',skillIds:['missing']}]},
  {...template(),nodes:[{id:'export',agentId:'system-export'}]},
  {...template(),nodes:[{id:'a',agentId:'opc-codebase-agent',prompt:'修改内置提示词'}]},
 ]){const result=parse(catalog,{operation:'create',template:input});assert.ok(result.draftError);assert.equal(result.draft,undefined);}assert.equal(catalog.templates().length,9);
});
test('ordinary replies remain unchanged and a modified draft cannot reuse an old digest',t=>{
 const catalog=createOrchestrationCatalog(temp(t));assert.deepEqual(parseTemplateProposal('普通回答',catalog,catalog.templates()),{text:'普通回答'});const result=parse(catalog,{operation:'create',template:template()});result.draft.template.name='未确认的更改';assert.throws(()=>saveTemplateProposal(result.draft,result.draft.hash,catalog),/草案已变化/);
});
test('chat retains drafts across refresh and passes them back for conversational refinement',async t=>{
 const root=temp(t);saveSettings(root,{model:'fixture/test'});let calls=0;const chat=createChat(root,{runAgent:async input=>{if(++calls===2){assert.ok(input.prompt.includes('currentDraft'));assert.ok(input.prompt.includes('自定义代码研究'));}return proposal({operation:'create',template:{...template(),name:calls===1?'自定义代码研究':'增加验证后的编排'}});}});t.after(()=>chat.close());chat.send({text:'创建一个并行研究编排'});await wait(()=>!chat.get().busy);assert.ok(chat.get().messages[1].draft);chat.send({text:'再修改一下'});await wait(()=>!chat.get().busy);assert.equal(chat.get().messages[3].draft.template.name,'增加验证后的编排');const restored=createChat(root);assert.ok(restored.get().messages[3].draft);const message=restored.get().messages[3];restored.saveDraft({messageId:message.id,hash:message.draft.hash});assert.ok(restored.get().messages[3].draft.savedTemplate);await restored.close();
});
test('chat draft HTTP save creates a usable template without starting a Run',async t=>{
 const root=temp(t);saveSettings(root,{model:'fixture/test'});const app=await startServer({root,port:0,runAgent:async()=>proposal({operation:'create',template:template()})});t.after(()=>app.close());const api=app.url+'/api/workbench';assert.equal((await fetch(api+'/chat/messages',body({text:'创建编排'}))).status,202);
 let state;for(let i=0;i<100;i++){state=await(await fetch(api+'/chat')).json();if(!state.busy)break;await new Promise(resolve=>setTimeout(resolve,10));}const message=state.messages.at(-1);assert.ok(message.draft);assert.equal((await(await fetch(api+'/orchestration/catalog')).json()).templates.length,9);
 assert.equal((await fetch(api+'/chat/orchestration',body({messageId:message.id,hash:'bad'}))).status,400);const response=await fetch(api+'/chat/orchestration',body({messageId:message.id,hash:message.draft.hash}));assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.template.version,1);assert.ok(saved.chat.messages.at(-1).draft.savedTemplate);assert.equal((await(await fetch(api+'/orchestration/runs')).json()).length,0);
 const preview=await fetch(api+'/orchestration/preview',body({templateId:saved.template.id,templateVersion:1,title:'新任务',description:'验证保存后的编排',repositoryIds:[],skillIds:[],supplement:''}));assert.equal(preview.status,200);
});
test('custom Agent prompts can contain Markdown code fences without breaking the proposal',t=>{
 const catalog=createOrchestrationCatalog(temp(t));const input={...template(),nodes:[{id:'custom',name:'格式审查',kind:'agent',readOnly:true,parallel:false,skillIds:[],prompt:'请返回如下格式：\n```json\n{"status":"OK"}\n```'}]};const result=parse(catalog,{operation:'create',template:input});assert.ok(result.draft);assert.equal(result.draft.template.nodes[0].prompt,input.nodes[0].prompt);
});
