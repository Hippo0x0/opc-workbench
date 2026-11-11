import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export function writablePath(cwd:string,file:string):boolean {
 const root=fs.realpathSync(cwd),target=path.resolve(root,file);
 if(target!==root&&!target.startsWith(root+path.sep))return false;
 let existing=target;
 while(!fs.existsSync(existing)){const parent=path.dirname(existing);if(parent===existing)return false;existing=parent;}
 const real=fs.realpathSync(existing);
 return real===root||real.startsWith(root+path.sep);
}
export default function workspacePolicy(pi:ExtensionAPI):void {
 pi.on("tool_call",event=>{
  if(event.toolName==="write"||event.toolName==="edit"){
   const input=event.input as {path?:unknown};
   if(typeof input.path!=="string"||!writablePath(process.cwd(),input.path))return {block:true,reason:"编辑目标必须位于本次任务工作目录内"};
  }
  if(event.toolName==="restricted_bash"){
   const input=event.input as {command?:unknown};
   if(typeof input.command!=="string")return {block:true,reason:"命令参数无效"};
   if(/(?:^|[;&|()\s])(?:git\s+(?:-[Cc]\s+\S+\s+)*push|npm\s+publish|pnpm\s+publish)(?:\s|$)/iu.test(input.command))return {block:true,reason:"任务节点不能推送代码或发布包"};
  }
  return undefined;
 });
}
