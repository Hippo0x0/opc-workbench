import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { createAgentTrace, type TraceTarget } from "./trace.ts";
import { reconstructJsonlState } from "./jsonl.ts";
import { resultObject } from "./result-format.ts";
import type { CommandRunner } from "./command.ts";
import type { StageTask, StageResult } from "./types.ts";
export interface AgentRunInput {
 cwd:string;model:string;env:NodeJS.ProcessEnv;prompt:string;signal?:AbortSignal;readOnly:boolean;timeoutMs:number;
 allowedTools?:string;disableExtensions?:boolean;isolatedSkills?:boolean;promptViaStdin?:boolean;
 onTextDelta?:(delta:string)=>void;
 sessionPath?:string;skills?:string[];stagePolicy?:"local-code-only";bashArtifactDirectory?:string;trace?:TraceTarget;
 nativeAutoresearch?:{task:StageTask;reportDirectory:string;maxIterations:number;resume?:boolean;requiredIterations?:number};
 interactive?:{ready(client:{steer(message:string):Promise<void>}):void;queueChanged?(steering:readonly string[]):void;turnEnded?():void;pending?():boolean;closed?():void};
}
export function assertModelResponseAvailable(output:string):void {
 if(/^(?:rate_limit_exceeded|overloaded_error|server_overloaded|insufficient_quota)(?:\s*[:：]|\s*$)/iu.test(output.trim()))throw new Error("模型服务未返回有效产物");
}
export function parseStageResult(output:string,_task:StageTask):StageResult {
 const result=resultObject(output,"实验产物");
 if(!["OK","DEGRADED","FAILED","CANCELLED"].includes(String(result.status))||!Array.isArray(result.gaps))throw new Error("实验产物无效");
 return result as unknown as StageResult;
}
export function agentArguments(input:AgentRunInput):string[] {
 const extension=(file:string)=>["--extension",fileURLToPath(new URL(`./${file}.js`,import.meta.url))];
 const args=["--no-extensions","--no-skills","--no-prompt-templates","--no-themes","--model",input.model];
 if(input.sessionPath){fs.mkdirSync(path.dirname(input.sessionPath),{recursive:true,mode:0o700});args.push("--session",input.sessionPath);}else args.push("--no-session");
 const requested=input.allowedTools??(input.readOnly?"read,grep,find,ls":"read,grep,find,ls,bash,edit,write");
 const readTools=new Set(["read","grep","find","ls"]);
 const names=requested.split(",").filter(Boolean);
 if(input.readOnly&&names.some(name=>!readTools.has(name)))throw new Error("只读 Agent 仅允许 read/grep/find/ls");
 const tools=names.map(name=>name==="bash"?"restricted_bash":name);
 if(!input.readOnly){args.push(...extension("bash-permissions"),...extension("workspace-policy"));}
 if(input.nativeAutoresearch){if(input.readOnly)throw new Error("实验节点必须可写");args.push(...extension("experiment-extension"));tools.push("init_experiment","run_experiment","log_experiment");}
 args.push(...(tools.length?["--tools",tools.join(",")]:["--no-tools"]));
 if(input.trace)args.push(...extension("trace-extension"));
 for(const directory of input.skills??[])args.push("--skill",directory);
 return args;
}
export async function runLocalAgent(input:AgentRunInput,_commandRunner?:CommandRunner):Promise<string> {
 const controller=new AbortController();
 const signal=input.signal?AbortSignal.any([input.signal,controller.signal]):controller.signal;
 const timer=input.timeoutMs>0?setTimeout(()=>controller.abort(new Error("Agent 执行超时")),input.timeoutMs):undefined;
 const env:NodeJS.ProcessEnv={...input.env,OPC_RESEARCH_BASH_WRITE:input.readOnly?"none":"workspace"};
 if(input.trace){env.OPC_STAGE_TRACE_DIRECTORY=input.trace.directory;env.OPC_STAGE_TRACE_STAGE=input.trace.stageId;env.OPC_STAGE_TRACE_ATTEMPT=String(input.trace.attempt);}
 if(input.nativeAutoresearch)env.OPC_EXPERIMENT_MAX_ITERATIONS=String(input.nativeAutoresearch.maxIterations);
 const trace=input.trace?createAgentTrace(input.trace,env):undefined;
 try {
  if(input.nativeAutoresearch&&!input.nativeAutoresearch.resume){
   const prior=path.join(input.cwd,"autoresearch.jsonl");
   if(fs.existsSync(prior)){
    fs.mkdirSync(input.nativeAutoresearch.reportDirectory,{recursive:true});
    fs.renameSync(prior,path.join(input.nativeAutoresearch.reportDirectory,`prior-records-${randomUUID()}.jsonl`));
   }
  }
  const output=await runInteractiveAgent({...input,signal},env,agentArguments(input),input.prompt,trace);
  if(!input.nativeAutoresearch)return output;
  const file=path.join(input.cwd,"autoresearch.jsonl");
  const state=reconstructJsonlState(fs.existsSync(file)?fs.readFileSync(file,"utf8"):"");
  const results=state.results.filter(item=>item.segment===state.currentSegment);
  const count=results.length;
  const task=input.nativeAutoresearch.task;
  const result:StageResult={schemaVersion:1,stageId:task.stageId,attempt:task.attempt,agentId:task.agentId,status:count?"OK":"DEGRADED",summary:`完成 ${count} 轮实验`,reportMarkdown:output,gaps:count?[]:[{description:"没有正式实验轮次记录"}],artifacts:[{path:file}],metrics:{runCount:count,metricName:state.metricName,metricUnit:state.metricUnit}};
  fs.mkdirSync(input.nativeAutoresearch.reportDirectory,{recursive:true});
  fs.writeFileSync(path.join(input.nativeAutoresearch.reportDirectory,"result.json"),JSON.stringify(result,null,2),{mode:0o600});
  return JSON.stringify(result);
 } finally {if(timer)clearTimeout(timer);}
}
async function runInteractiveAgent(input: AgentRunInput, env: NodeJS.ProcessEnv, args: string[], prompt: string,
  trace?: ReturnType<typeof createAgentTrace>): Promise<string> {
  const client = new RpcClient({ cliPath: fileURLToPath(new URL("../bin/pi.mjs", import.meta.url)),
    cwd: input.cwd, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), args });
  let done: (() => void) | undefined;
  let rejectIdle: ((error: Error) => void) | undefined;
  let modelError: string | undefined;
  let responseText = "";
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  const unsubscribe = client.onEvent((event) => {
    trace?.push(JSON.stringify(event) + "\n");
    if(event.type==="message_update"&&event.assistantMessageEvent.type==="text_delta")input.onTextDelta?.(event.assistantMessageEvent.delta);
    if (event.type === "message_end" && event.message.role === "assistant") {
      modelError = event.message.stopReason === "error" ? event.message.errorMessage || "模型调用失败"
        : event.message.stopReason === "aborted" ? "Agent 已中断" : undefined;
      const text = event.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (text.trim()) responseText = text;
    }
    const queueEvent = event as unknown as { type: string; steering?: readonly string[] };
    if (queueEvent.type === "queue_update") input.interactive?.queueChanged?.(queueEvent.steering ?? []);
    if (event.type === "turn_end") input.interactive?.turnEnded?.();
    if (event.type === "agent_end") {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (!input.interactive?.pending?.()) done?.(); }, 300);
    }
  });
  const abort = () => { rejectIdle?.(new Error("Agent 已中断")); void client.abort().catch(() => {}); };
  const heartbeat = setInterval(() => {
    if (checking) return;
    checking = true;
    void client.getState().catch((error: unknown) => rejectIdle?.(error instanceof Error ? error : new Error(String(error))))
      .finally(() => { checking = false; });
  }, 10_000);
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    input.signal?.throwIfAborted();
    await client.start();
    input.signal?.throwIfAborted();
    await client.setSteeringMode("one-at-a-time");
    input.signal?.throwIfAborted();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const idle = new Promise<void>((resolve, reject) => { done = resolve; rejectIdle = reject; });
      // prompt 尚未完成时也可能取消；提前接住拒绝，后续仍由 completion 传播错误。
      void idle.catch(() => {});
      input.signal?.throwIfAborted();
      const request = client.prompt(attempt === 0 ? prompt
        : "上一轮没有返回正式正文。请继续当前任务，按原要求输出完整的正式结果，不要只返回思考内容。");
      const completion = Promise.all([request, idle]);
      if (attempt === 0) input.interactive?.ready({ steer: (message) => client.steer(message) });
      await completion;
      input.signal?.throwIfAborted();
      if (modelError) throw new Error(modelError);
      const output = trace?.finish() ?? responseText;
      if (output.trim()) { assertModelResponseAvailable(output); return output; }
    }
    throw new Error("Agent 未返回正式内容，同一对话自动重试一次后仍为空");
  } finally {
    clearInterval(heartbeat);
    if (idleTimer) clearTimeout(idleTimer);
    input.interactive?.closed?.();
    input.signal?.removeEventListener("abort", abort);
    unsubscribe();
    await client.stop();
  }
}
