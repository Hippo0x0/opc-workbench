import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runLocalAgent, type AgentRunInput } from "./agent.ts";
import { object,textField,writeJson } from "./orchestration-catalog.ts";
import { readUserSettings } from "./settings.ts";
import { createResearchTextRedactor } from "./trace.ts";
export interface ChatMessage {id:string;role:"user"|"assistant";text:string;at:string;status:"completed"|"streaming"|"failed"|"cancelled";error?:string}
export interface ChatState {id:string;model:string;busy:boolean;messages:ChatMessage[]}
export function createChat(root:string,options:{runAgent?:(input:AgentRunInput)=>Promise<string>;env?:NodeJS.ProcessEnv;context?:()=>string}={}){
 const directory=path.join(root,"chat"),file=path.join(directory,"conversation.json");
 const fresh=():ChatState=>({id:randomUUID(),model:readUserSettings(root).model,busy:false,messages:[]});
 let state:ChatState;
 try{state=JSON.parse(fs.readFileSync(file,"utf8")) as ChatState;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;state=fresh();}
 const save=()=>writeJson(file,state);
 if(state.busy){state.busy=false;for(const message of state.messages)if(message.status==="streaming"){message.status="failed";message.error="上次对话已中断，请重新发送。";}save();}
 let controller:AbortController|undefined,pending:Promise<void>|undefined;
 const env=options.env??process.env,clean=createResearchTextRedactor(env,Number.MAX_SAFE_INTEGER);
 return {
  get(){return {...state,model:state.busy?state.model:readUserSettings(root).model};},
  send(value:unknown){
   if(state.busy)throw new Error("正在回复，请等待完成或停止当前回复");
   const text=textField(object(value).text,"消息",20000),settings=readUserSettings(root);
   if(!settings.model)throw new Error("请先在个人设置中选择默认模型并配置认证");
   const directoryForChat=path.join(directory,state.id),cwd=path.join(directoryForChat,"workspace");
   fs.mkdirSync(cwd,{recursive:true,mode:0o700});
   const reply:ChatMessage={id:randomUUID(),role:"assistant",text:"",at:new Date().toISOString(),status:"streaming"};
   state.model=settings.model;state.messages.push({id:randomUUID(),role:"user",text,at:new Date().toISOString(),status:"completed"},reply);
   state.busy=true;controller=new AbortController();const signal=controller.signal;save();
   let streamedText="";
   const input:AgentRunInput={cwd,model:settings.model,env:{...env,PI_CODING_AGENT_DIR:path.join(root,"agent")},readOnly:true,allowedTools:"read,grep,find,ls",timeoutMs:settings.timeouts.agentMinutes===null?0:settings.timeouts.agentMinutes*60000,signal,
    sessionPath:path.join(directoryForChat,"session.jsonl"),trace:{directory:directoryForChat,stageId:"chat",attempt:state.messages.filter(message=>message.role==="user").length},
    prompt:`你是 OPC Workbench 的对话助手。直接回答用户，保持上下文连贯，使用用户的语言。准确区分已核验事实与建议；没有实际执行时不要声称已创建任务、修改设置或运行实验。当前是只读对话，正式研究任务由用户通过页面创建并确认。\n\n工作台当前信息：\n${options.context?.()??"本地 Pi 工作台"}\n\n用户消息：\n${text}`,
    onTextDelta(delta){streamedText+=delta;reply.text=clean(streamedText);},
   };
   pending=Promise.resolve().then(()=> (options.runAgent??runLocalAgent)(input)).then(output=>{signal.throwIfAborted();if(!output.trim())throw new Error("模型未返回内容，请重试");reply.text=clean(output);reply.status="completed";}).catch(error=>{reply.status=signal.aborted?"cancelled":"failed";reply.error=signal.aborted?"已停止回复":clean(error instanceof Error?error.message:"模型调用失败");}).finally(()=>{state.busy=false;controller=undefined;save();});
   return this.get();
  },
  stop(){controller?.abort();return this.get();},
  reset(){
   if(state.busy)throw new Error("请先停止当前回复，再开始新对话");
   if(state.messages.length)writeJson(path.join(directory,state.id,"conversation.json"),state);
   state=fresh();save();return this.get();
  },
  async close(){controller?.abort();await pending;},
 };
}
