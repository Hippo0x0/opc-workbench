import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createOrchestrationRuntime } from '../src/orchestration-runtime.ts';
import { createOrchestrationCatalog } from '../src/orchestration-catalog.ts';
import { createRuntimeManagement, validateGitUrl } from '../src/runtime-management.ts';
import { createSkillLibrary } from '../src/skill-library.ts';
import { saveSettings, parseBudget } from '../src/settings.ts';
import { startServer } from '../src/server.ts';
import { agentArguments } from '../src/agent.ts';
import { writablePath } from '../src/workspace-policy.ts';
import { createResearchTextRedactor } from '../src/trace.ts';
import { reportMarkdown } from '../web/src/markdown.ts';
const tmp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'opc-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
const wait=async(fn)=>{const deadline=Date.now()+6000;for(;;){const result=fn();if(result)return result;if(Date.now()>deadline)throw new Error('等待状态超时');await new Promise(resolve=>setTimeout(resolve,15));}};
const configure=root=>saveSettings(root,{model:'fixture/test'});
const input=(templateId,extra={})=>({templateId,templateVersion:1,title:'测试任务',description:'准确核对本地证据',repositoryIds:[],skillIds:[],supplement:'',...extra});
async function create(runtime,raw){const preview=await runtime.preview(raw);return runtime.create({...raw,contextHash:preview.frozen.hash},'local');}
function agentNode(id,extra={}){return {id,name:id,kind:'agent',prompt:'执行并提供证据',skillIds:[],readOnly:true,parallel:false,...extra};}

test('all builtin templates validate and can be copied without external platform capabilities',t=>{const catalog=createOrchestrationCatalog(tmp(t));assert.equal(catalog.templates().length,9);for(const template of catalog.templates()){const copy=catalog.save({...template,id:undefined});assert.equal(copy.system,false);assert.equal(copy.nodes.length,template.nodes.length);}});
test('parallel read-only agents converge, approval freezes material and export is identical',async t=>{
 const root=tmp(t);configure(root);let current=0,max=0;
 const runtime=createOrchestrationRuntime(root,{runAgent:async()=>{current++;max=Math.max(max,current);await new Promise(resolve=>setTimeout(resolve,35));current--;return '# 可核验的结论';}});t.after(()=>runtime.close());
 const template=runtime.catalog.save({name:'并行',nodes:[agentNode('a'),agentNode('b',{parallel:true}),{id:'approval',agentId:'system-approval'},{id:'export',agentId:'system-export'}]});
 const run=await create(runtime,input(template.id));await wait(()=>runtime.get(run.id).status==='REVIEW_REQUIRED');assert.equal(max,2);
 const review=runtime.get(run.id).nodes.approval;
 assert.throws(()=>runtime.control(run.id,{action:'approve',digest:'stale'},'local'),/材料已变化/);
 runtime.control(run.id,{action:'approve',digest:review.digest},'local');await wait(()=>runtime.get(run.id).status==='COMPLETED');
 assert.equal(fs.readFileSync(path.join(root,'orchestration-runs',run.id,'report.md'),'utf8'),review.output);
});
test('freeze rejects a changed Skill after preview and snapshots full packages',async t=>{
 const root=tmp(t),source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'SKILL.md'),'---\nname: examples\ndescription: test\n---\nOriginal');fs.writeFileSync(path.join(source,'helper.txt'),'helper');configure(root);
 const runtime=createOrchestrationRuntime(root,{runAgent:async()=> '完成'});t.after(()=>runtime.close());const skill=runtime.catalog.registerSkill({path:source});
 const raw=input('system-requirement-research-v1',{skillIds:[skill.id]});const preview=await runtime.preview(raw);fs.writeFileSync(path.join(skill.directory,'helper.txt'),'changed');
 await assert.rejects(runtime.create({...raw,contextHash:preview.frozen.hash},'local'),/上下文已变化/);
 const run=await create(runtime,raw);assert.equal(fs.readFileSync(path.join(root,'orchestration-runs',run.id,'skills',skill.id,'helper.txt'),'utf8'),'changed');await wait(()=>runtime.get(run.id).status==='REVIEW_REQUIRED');
});
test('Git worktree preserves source dirty changes and is removed with the run',async t=>{
 const root=tmp(t),repo=path.join(root,'repo');fs.mkdirSync(repo);git(repo,'init');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.org');fs.writeFileSync(path.join(repo,'README.md'),'committed');git(repo,'add','.');git(repo,'commit','-m','init');fs.writeFileSync(path.join(repo,'README.md'),'dirty source');
 configure(root);const registered=await createRuntimeManagement(root).register({path:repo});let observed;
 const runtime=createOrchestrationRuntime(root,{runAgent:async value=>{observed=fs.readFileSync(path.join(value.cwd,'README.md'),'utf8');return '完成';}});t.after(()=>runtime.close());const template=runtime.catalog.save({name:'Git',nodes:[agentNode('read')]});const run=await create(runtime,input(template.id,{repositoryIds:[registered.id]}));await wait(()=>runtime.get(run.id).status==='COMPLETED');await new Promise(resolve=>setTimeout(resolve,20));assert.equal(observed,'committed');assert.equal(fs.readFileSync(path.join(repo,'README.md'),'utf8'),'dirty source');await runtime.remove(run.id);assert.equal(git(repo,'worktree','list','--porcelain').split('\n').filter(line=>line.startsWith('worktree ')).length,1);
});
test('pause cancels only its own agent; resume and failure retry preserve outputs',async t=>{
 const root=tmp(t);configure(root);let calls=0;
 const runtime=createOrchestrationRuntime(root,{runAgent:async value=>{if(++calls===1)await new Promise((resolve,reject)=>{value.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});return '已恢复';}});t.after(()=>runtime.close());const template=runtime.catalog.save({name:'暂停',nodes:[agentNode('a')]});const run=await create(runtime,input(template.id));await wait(()=>calls===1);runtime.control(run.id,{action:'pause'},'local');await wait(()=>runtime.get(run.id).nodes.a.status==='waiting');await new Promise(resolve=>setTimeout(resolve,20));assert.equal(runtime.get(run.id).status,'PAUSED');runtime.control(run.id,{action:'resume'},'local');await wait(()=>runtime.get(run.id).status==='COMPLETED');assert.equal(runtime.get(run.id).nodes.a.output.includes('已恢复'),true);
});
test('process restart marks in-flight nodes blocked, then restores them on resume',async t=>{const root=tmp(t);configure(root);let release;const runtime=createOrchestrationRuntime(root,{runAgent:()=>new Promise(resolve=>{release=resolve;})});const template=runtime.catalog.save({name:'恢复',nodes:[agentNode('a')]});const run=await create(runtime,input(template.id));await wait(()=>release);const recovered=createOrchestrationRuntime(root,{runAgent:async()=> '恢复完成'});assert.equal(recovered.get(run.id).status,'BLOCKED');recovered.control(run.id,{action:'resume'},'local');await wait(()=>recovered.get(run.id).status==='COMPLETED');release('原执行结束');runtime.close();recovered.close();});
test('parallel write nodes and export without adjacent approval are rejected',t=>{const catalog=createOrchestrationCatalog(tmp(t));assert.throws(()=>catalog.save({name:'危险并行',nodes:[agentNode('a'),agentNode('b',{readOnly:false,parallel:true,capabilities:['repository.write']})]}),/并行/);assert.throws(()=>catalog.save({name:'错误导出',nodes:[{id:'export',agentId:'system-export'}]}),/人工确认/);});
test('before-run input and after-result goto require current material digest',async t=>{const root=tmp(t);configure(root);const runtime=createOrchestrationRuntime(root,{runAgent:async value=>JSON.stringify({protocolVersion:1,agentVersion:1,nodeId:'a',agentId:'a',status:'OK',summary:'完成',gaps:[],payload:{markdown:'# 结果'}})});t.after(()=>runtime.close());const template=runtime.catalog.save({name:'交互',nodes:[agentNode('a',{enabledInteractions:['before-run-input','after-result-route'],actions:[{id:'approve',kind:'goto',label:'确认',targetNodeId:'approval',interactionId:'after-result-route'}]}),{id:'approval',agentId:'system-approval'}]});const run=await create(runtime,input(template.id));await wait(()=>runtime.get(run.id).status==='REVIEW_REQUIRED');let node=runtime.get(run.id).nodes.a;assert.equal(node.preRunInteractionId,'before-run-input');runtime.control(run.id,{action:'submit-before-run',nodeId:'a',digest:node.digest,inputs:{instruction:'核对'}},'local');await wait(()=>runtime.get(run.id).nodes.a.output);node=runtime.get(run.id).nodes.a;assert.equal(node.status,'review');runtime.control(run.id,{action:'select-action',nodeId:'a',actionId:'approve',digest:node.digest,inputs:{}},'local');await wait(()=>runtime.get(run.id).nodes.approval.status==='review');});
test('explicit local Skill imports reject symlinks and bound skills cannot be deleted',t=>{const root=tmp(t),source=path.join(root,'skill');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'SKILL.md'),'test');const library=createSkillLibrary(root),skill=library.importDirectory(source);library.setBindings('agent',[skill.id]);assert.throws(()=>library.remove(skill.id,[]),/引用/);fs.symlinkSync('/etc/passwd',path.join(source,'link'));assert.throws(()=>library.importDirectory(source,{name:'other'}),/符号链接/);});
test('read-only allowlist and editor scope fail closed',t=>{const root=tmp(t);assert.throws(()=>agentArguments({cwd:root,model:'fixture/test',prompt:'',env:{},readOnly:true,allowedTools:'bash',timeoutMs:0}),/只读/);assert.equal(writablePath(root,'inside/file'),true);assert.equal(writablePath(root,'../outside'),false);fs.symlinkSync('/tmp',path.join(root,'link'));assert.equal(writablePath(root,'link/outside'),false);});
test('budgets and repository URLs reject invalid input',()=>{assert.throws(()=>parseBudget({maxConcurrency:0}),/无效/);assert.throws(()=>parseBudget({stageTimeoutMinutes:-1}),/无效/);assert.throws(()=>validateGitUrl('https://user:secret@example.org/repo'),/凭据/);validateGitUrl('git@github.com:example/project.git');assert.throws(()=>validateGitUrl('--upload-pack=bad'),/Git URL/);});
test('trace redaction removes secrets and Markdown escapes active content',()=>{assert.equal(createResearchTextRedactor({API_KEY:'fixture-secret'})('fixture-secret'), '[已隐藏]');const html=reportMarkdown('<script>alert(1)</script>\n[x](javascript:alert(1))');assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));});
test('HTTP serves standalone UI, supports catalog + runs, rejects foreign origins',async t=>{
 const root=tmp(t);configure(root);const app=await startServer({root,port:0,runAgent:async()=> '# 测试结果'});t.after(()=>app.close());
 assert.equal((await fetch(app.url+'/')).status,200);assert.ok((await(await fetch(app.url+'/')).text()).includes('OPC Workbench'));
 const headers={'content-type':'application/json'};const catalog=await(await fetch(app.url+'/api/workbench/orchestration/catalog')).json();assert.equal(catalog.templates.length,9);
 const bad=await fetch(app.url+'/api/workbench/settings',{method:'PUT',headers:{...headers,origin:'https://attacker.example'},body:'{}'});assert.equal(bad.status,403);
 const raw=input('system-requirement-research-v1');const preview=await(await fetch(app.url+'/api/workbench/orchestration/preview',{method:'POST',headers,body:JSON.stringify(raw)})).json();const response=await fetch(app.url+'/api/workbench/orchestration/runs',{method:'POST',headers,body:JSON.stringify({...raw,contextHash:preview.frozen.hash})});assert.equal(response.status,201);const run=await response.json();await wait(()=>app.runtime.get(run.id).status==='REVIEW_REQUIRED');assert.equal((await fetch(app.url+`/api/workbench/orchestration/runs/${run.id}/trace?stageId=no`)).status,404);assert.equal((await fetch(app.url+'/api/company')).status,404);
});
test('preview freezes the repository commit and detects changes before Run creation',async t=>{
 const root=tmp(t),repo=path.join(root,'repo');fs.mkdirSync(repo);git(repo,'init','-q');git(repo,'config','user.name','Fixture');git(repo,'config','user.email','fixture@example.org');git(repo,'commit','--allow-empty','-qm','first');configure(root);
 const registered=await createRuntimeManagement(root).register({path:repo});const runtime=createOrchestrationRuntime(root,{runAgent:async()=> '完成'});t.after(()=>runtime.close());const template=runtime.catalog.save({name:'冻结提交',nodes:[agentNode('a')]});const raw=input(template.id,{repositoryIds:[registered.id]}),preview=await runtime.preview(raw);assert.equal(preview.frozen.repositories[0].commit,git(repo,'rev-parse','HEAD'));git(repo,'commit','--allow-empty','-qm','second');await assert.rejects(runtime.create({...raw,contextHash:preview.frozen.hash},'local'),/上下文已变化/);
});
test('Run budget snapshot ignores later settings and limits each invocation',async t=>{
 const root=tmp(t);configure(root);let timeout;
 const runtime=createOrchestrationRuntime(root,{runAgent:async value=>{timeout=value.timeoutMs;return '完成';}});t.after(()=>runtime.close());const template=runtime.catalog.save({name:'预算',nodes:[agentNode('a')]});const run=await create(runtime,input(template.id,{budget:{maxConcurrency:2,stageTimeoutMinutes:2,maxWallTimeMinutes:5}}));saveSettings(root,{model:'fixture/other',agentMinutes:1,runWallTimeMinutes:1});await wait(()=>runtime.get(run.id).status==='COMPLETED');assert.equal(run.agentTimeoutMinutes,60);assert.equal(run.runWallTimeMinutes,360);assert.equal(run.model,'fixture/test');assert.equal(timeout,120000);
});
