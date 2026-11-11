import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCommand } from "./command.ts";
import { dangerousDeleteReason } from "./dangerous-delete-guard.ts";
import { reconstructJsonlState } from "./jsonl.ts";
export default function experimentExtension(pi:ExtensionAPI):void {
 const cwd=process.cwd(),file=path.join(cwd,"autoresearch.jsonl");
 const append=(value:unknown)=>fs.appendFileSync(file,JSON.stringify(value)+"\n",{mode:0o600});
 const state=()=>reconstructJsonlState(fs.existsSync(file)?fs.readFileSync(file,"utf8"):"");
 const reply=(text:string)=>({content:[{type:"text" as const,text}],details:{}});
 let pending:{file:string;exitCode:number|null;durationMs:number}|undefined;
 pi.registerTool(defineTool({name:"init_experiment",label:"初始化实验",description:"初始化本次优化的指标、单位和方向；已有配置时保留原记录。",parameters:Type.Object({name:Type.String(),metricName:Type.String(),metricUnit:Type.String(),bestDirection:Type.Union([Type.Literal("lower"),Type.Literal("higher")])}),async execute(_id,params){
  if(fs.existsSync(file)&&fs.statSync(file).size)return reply("已有实验记录，请继续原指标，不能覆盖。");
  append({type:"config",...params});return reply("指标已初始化；下一步实际运行基线并登记。");
 }}));
 pi.registerTool(defineTool({name:"run_experiment",label:"运行实验",description:"实际执行一个基线或候选测量命令；stdout/stderr 保存为原始证据，每流最多 8 MiB，超限可能截断。",parameters:Type.Object({command:Type.String(),timeoutSeconds:Type.Optional(Type.Number({minimum:1,maximum:3600}))}),async execute(_id,params,signal){
  if(!fs.existsSync(file))throw new Error("先初始化实验");
  const current=state();if(current.results.filter(item=>item.segment===current.currentSegment).length>=Number(process.env.OPC_EXPERIMENT_MAX_ITERATIONS??5))throw new Error("已达到本轮实验轮次预算");
  const blocked=dangerousDeleteReason(params.command,cwd,process.env);if(blocked)throw new Error(blocked);
  if(/\bgit\s+push\b|\b(?:npm|pnpm)\s+publish\b/u.test(params.command))throw new Error("实验不得推送或发布");
  const started=Date.now(),directory=path.join(cwd,".experiments");fs.mkdirSync(directory,{recursive:true});
  const id=randomUUID(),evidence=path.join(directory,`${id}.json`);
  const result=await runCommand("bash",["--noprofile","--norc","-c",params.command],{cwd,signal,timeoutMs:(params.timeoutSeconds??600)*1000,maxOutputBytes:8*1024*1024,rejectOnNonZero:false,killProcessGroup:true});
  pending={file:evidence,exitCode:result.exitCode,durationMs:Date.now()-started};
  fs.writeFileSync(evidence,JSON.stringify({command:params.command,outputLimitBytes:8*1024*1024,...result,...pending},null,2),{mode:0o600});
  return reply(JSON.stringify({...pending,stdout:result.stdout,stderr:result.stderr}));
 }}));
 pi.registerTool(defineTool({name:"log_experiment",label:"登记实验",description:"根据最近一次 run_experiment 的原始输出登记指标与保留/丢弃/失败结论；不会自动改写 Git 或回滚文件。",parameters:Type.Object({metric:Type.Number(),status:Type.Union([Type.Literal("keep"),Type.Literal("discard"),Type.Literal("crash"),Type.Literal("checks_failed")]),description:Type.String()}),async execute(_id,params){
  if(!pending)throw new Error("必须先用 run_experiment 实际测量，每次测量只能登记一次");
  const current=state(),count=current.results.filter(item=>item.segment===current.currentSegment).length;
  const limit=Number(process.env.OPC_EXPERIMENT_MAX_ITERATIONS??5);if(count>=limit)throw new Error("已达到本轮实验轮次预算");
  if(pending.exitCode!==0&&params.status==="keep")throw new Error("命令失败的实验不能记为 keep");
  const commit=(await runCommand("git",["rev-parse","HEAD"],{cwd})).stdout.trim();
  append({run:count+1,...params,commit,wall_clock_seconds:pending.durationMs/1000,timestamp:Date.now(),evidence:pending.file});
  pending=undefined;return reply(`已登记第 ${count+1} 轮；请保留原始样本和正确性证据。`);
 }}));
}
