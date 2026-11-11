import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChat } from '../src/chat.ts';
import { saveSettings } from '../src/settings.ts';
import { startServer } from '../src/server.ts';
const temp=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'opc-chat-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const wait=async fn=>{const limit=Date.now()+4000;for(;;){const value=fn();if(value)return value;if(Date.now()>limit)throw new Error('等待对话超时');await new Promise(resolve=>setTimeout(resolve,10));}};
const body=value=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
test('home chat streams, saves history and reuses a Pi session for the next turn',async t=>{
 const root=temp(t);saveSettings(root,{model:'fixture/test'});const inputs=[];let release;
 const chat=createChat(root,{runAgent:async input=>{inputs.push(input);if(inputs.length===1){input.onTextDelta('部分回复');await new Promise(resolve=>{release=resolve;});return '完整回复';}return '第二轮，保留上下文';}});t.after(()=>chat.close());
 chat.send({text:'第一条消息'});await wait(()=>release);assert.equal(chat.get().busy,true);assert.equal(chat.get().messages[1].text,'部分回复');assert.throws(()=>chat.send({text:'插队'}),/正在回复/);assert.throws(()=>chat.reset(),/停止/);release();await wait(()=>!chat.get().busy);
 chat.send({text:'第二条消息'});await wait(()=>!chat.get().busy);assert.equal(inputs[0].sessionPath,inputs[1].sessionPath);assert.equal(chat.get().messages.length,4);assert.equal(chat.get().messages[3].text,'第二轮，保留上下文');
 const restored=createChat(root,{runAgent:async()=> '下一轮'});assert.deepEqual(restored.get().messages,chat.get().messages);await restored.close();
 const previous=chat.get().id;chat.reset();assert.notEqual(chat.get().id,previous);assert.equal(chat.get().messages.length,0);assert.ok(fs.existsSync(path.join(root,'chat',previous,'conversation.json')));
});
test('missing model keeps input out of history and model failures remain visible',async t=>{
 const root=temp(t);const chat=createChat(root,{runAgent:async()=>{throw new Error('服务不可用');}});assert.throws(()=>chat.send({text:'你好'}),/个人设置/);assert.equal(chat.get().messages.length,0);saveSettings(root,{model:'fixture/test'});chat.send({text:'你好'});await wait(()=>!chat.get().busy);assert.equal(chat.get().messages[1].status,'failed');assert.equal(chat.get().messages[1].error,'服务不可用');await chat.close();
});
test('stop cancels the active Pi request and keeps the partial reply',async t=>{
 const root=temp(t);saveSettings(root,{model:'fixture/test'});let started=false;
 const chat=createChat(root,{runAgent:input=>new Promise((resolve,reject)=>{input.onTextDelta('部分内容');started=true;input.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})});chat.send({text:'继续'});await wait(()=>started);chat.stop();await wait(()=>!chat.get().busy);assert.equal(chat.get().messages[1].status,'cancelled');assert.equal(chat.get().messages[1].text,'部分内容');await chat.close();
});
test('HTTP chat endpoints preserve messages, reject concurrent sends and do not create Runs',async t=>{
 const root=temp(t);saveSettings(root,{model:'fixture/test'});let finish;
 const app=await startServer({root,port:0,runAgent:()=>new Promise(resolve=>{finish=resolve;})});t.after(()=>app.close());
 const base=app.url+'/api/workbench';let response=await fetch(base+'/chat/messages',body({text:'讨论一下需求'}));assert.equal(response.status,202);await wait(()=>finish);
 response=await fetch(base+'/chat/messages',body({text:'并发发送'}));assert.equal(response.status,409);assert.equal((await(await fetch(base+'/orchestration/runs')).json()).length,0);finish('# 正常对话');await wait(()=>!app.runtime.list().length&&finish);await new Promise(resolve=>setTimeout(resolve,20));const state=await(await fetch(base+'/chat')).json();assert.equal(state.messages[1].text,'# 正常对话');assert.equal(state.busy,false);assert.equal((await fetch(app.url+'/account/')).status,200);
});
test('provider API keys are stored privately and never returned by settings or model APIs',async t=>{
 const root=temp(t);const app=await startServer({root,port:0,runAgent:async()=> 'test'});t.after(()=>app.close());const key='fixture-private-api-key';
 const response=await fetch(app.url+'/api/workbench/models/auth',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'openai',apiKey:key})});assert.equal(response.status,200);assert.ok(!(await response.text()).includes(key));assert.equal(fs.statSync(path.join(root,'agent','auth.json')).mode&0o777,0o600);
 for(const endpoint of ['/models','/settings'])assert.ok(!(await(await fetch(app.url+'/api/workbench'+endpoint)).text()).includes(key));
 const malformed=await fetch(app.url+'/api/workbench/models/auth',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'../outside',apiKey:key})});assert.equal(malformed.status,400);assert.ok(!(await malformed.text()).includes(key));
});
