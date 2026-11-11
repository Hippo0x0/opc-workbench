import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { runLocalAgent } from '../build/agent.js';
import { reconstructJsonlState } from '../src/jsonl.ts';
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'opc-pi-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
async function fixture(t,root,respond){
 let requests=0;
 const server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  try{
   const delta=respond(body,++requests);
   res.writeHead(200,{'content-type':'text/event-stream'});
   const base={id:'fixture-completion',object:'chat.completion.chunk',created:1,model:'fixture'};
   res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})}\n\n`);
   res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:delta.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\n`);
   res.end('data: [DONE]\n\n');
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:{message:error.message}}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const agentDirectory=path.join(root,'agent');fs.mkdirSync(agentDirectory);
 fs.writeFileSync(path.join(agentDirectory,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'fixture-key',models:[{id:'test',name:'Test fixture',contextWindow:32768,maxTokens:1024,input:['text'],reasoning:false}]}}}));
 return {env:{...process.env,PI_CODING_AGENT_DIR:agentDirectory},requests:()=>requests};
}
const call=(name,args,id)=>({tool_calls:[{index:0,id:`call_${id}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
test('real Pi RPC performs a read tool call and saves the same session + trace',async t=>{
 const root=temp(t);fs.writeFileSync(path.join(root,'proof.txt'),'proof-from-local-disk');let tools;
 const service=await fixture(t,root,(body,count)=>{tools=body.tools?.map(tool=>tool.function.name);if(count===1)return call('read',{path:'proof.txt'},count);assert.ok(body.messages.some(message=>message.role==='tool'&&String(message.content).includes('proof-from-local-disk')));return {content:'# Verified local evidence'};});
 const session=path.join(root,'session.jsonl');
 const result=await runLocalAgent({cwd:root,model:'fixture/test',env:service.env,prompt:'Read proof.txt and report.',readOnly:true,timeoutMs:15000,sessionPath:session,trace:{directory:root,stageId:'reader',attempt:1}});
 assert.equal(result,'# Verified local evidence');assert.equal(service.requests(),2);assert.deepEqual(tools.sort(),['find','grep','ls','read']);assert.ok(fs.statSync(session).size>0);
 const trace=fs.readFileSync(path.join(root,'stage-trace.jsonl'),'utf8');assert.ok(trace.includes('tool_start'));assert.ok(trace.includes('proof-from-local-disk'));assert.ok(trace.includes('systemPrompt'));
 // Resume the saved context with the same upstream Pi runtime.
 const resumed=await runLocalAgent({cwd:root,model:'fixture/test',env:service.env,prompt:'Summarize previous evidence.',readOnly:true,timeoutMs:15000,sessionPath:session});assert.equal(resumed,'# Verified local evidence');
});
test('native experiment tools measure, register a round and emit original evidence',async t=>{
 const root=temp(t);execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.org','commit','--allow-empty','-qm','init']);
 const service=await fixture(t,root,(body,count)=>{
  if(count===1)return call('init_experiment',{name:'baseline',metricName:'latency',metricUnit:'ms',bestDirection:'lower'},count);
  if(count===2)return call('run_experiment',{command:'printf "latency=12\\n"'},count);
  if(count===3)return call('log_experiment',{metric:12,status:'keep',description:'baseline measured'},count);
  return {content:'# Baseline\nMeasured latency: 12 ms.'};
 });
 const task={protocolVersion:1,schemaVersion:1,researchId:'test',runId:'test',stageId:'experiment',attempt:1,agentId:'opc-experiment-agent',frozenInputRef:'test',acceptedArtifactRefs:[],objective:'measure',constraints:[],capabilityGrant:['test.execute'],budget:{maxIterations:1}};
 const output=await runLocalAgent({cwd:root,model:'fixture/test',env:service.env,prompt:'Initialize, measure and log one baseline.',readOnly:false,timeoutMs:20000,trace:{directory:root,stageId:'experiment',attempt:1},nativeAutoresearch:{task,reportDirectory:path.join(root,'report'),maxIterations:1,requiredIterations:1}});
 const result=JSON.parse(output);assert.equal(result.status,'OK');assert.equal(result.metrics.runCount,1);const raw=fs.readFileSync(path.join(root,'autoresearch.jsonl'),'utf8');assert.equal(reconstructJsonlState(raw).results[0].metric,12);const record=JSON.parse(raw.trim().split('\n').at(-1));assert.ok(fs.existsSync(record.evidence));assert.ok(fs.readFileSync(record.evidence,'utf8').includes('latency=12'));assert.equal(service.requests(),4);
});
test('Pi empty responses are rejected rather than returned as successful artifacts',async t=>{
 const root=temp(t);const service=await fixture(t,root,()=>({content:''}));
 await assert.rejects(runLocalAgent({cwd:root,model:'fixture/test',env:service.env,prompt:'test',readOnly:true,timeoutMs:3000}),/Agent|模型|model|Model|超时/);
});
test('home chat uses real Pi RPC and carries previous user and assistant messages across turns',async t=>{
 const root=temp(t);const service=await fixture(t,root,(body,count)=>{
  if(count===1)return {content:'记住了，数字是42。'};
  assert.ok(JSON.stringify(body.messages).includes('请记住数字42'));
  assert.ok(JSON.stringify(body.messages).includes('记住了，数字是42。'));
  return {content:'上一轮的数字是42。'};
 });
 const {saveSettings}=await import('../src/settings.ts');saveSettings(root,{model:'fixture/test'});
 const {startServer}=await import('../build/server.js');const app=await startServer({root,port:0,env:service.env});t.after(()=>app.close());
 const waitForReply=async()=>{const deadline=Date.now()+10000;for(;;){const state=await(await fetch(app.url+'/api/workbench/chat')).json();if(!state.busy)return state;if(Date.now()>deadline)throw new Error('Pi chat timeout');await new Promise(resolve=>setTimeout(resolve,25));}};
 for(const text of ['请记住数字42','上一轮是什么数字？']){const response=await fetch(app.url+'/api/workbench/chat/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});assert.equal(response.status,202);const state=await waitForReply();assert.equal(state.messages.at(-1).status,'completed');}
 const state=await waitForReply();assert.equal(state.messages.length,4);assert.equal(state.messages.at(-1).text,'上一轮的数字是42。');assert.equal(service.requests(),2);
});
