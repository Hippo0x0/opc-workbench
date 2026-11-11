import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand } from "./command.ts";
import { object, textField, writeJson } from "./orchestration-catalog.ts";
interface Repository {id:string;path:string;name:string}
export function createRuntimeManagement(root:string) {
 const file=path.join(root,"repositories.json");
 async function records():Promise<Repository[]>{try{return JSON.parse(await fs.readFile(file,"utf8")) as Repository[];}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw e;}}
 const git=async(cwd:string,args:string[])=>(await runCommand("git",["-C",cwd,...args],{timeoutMs:60_000})).stdout.trim();
 return {
  async repositories(){return Promise.all((await records()).map(async(repo)=>{try{const [branch,status]=await Promise.all([git(repo.path,["branch","--show-current"]),git(repo.path,["status","--porcelain"])]);return {...repo,available:true,branch:branch||"detached HEAD",modified:Boolean(status)};}catch{return {...repo,available:false,branch:"不可用",modified:false};}}));},
  async register(value:unknown){
   const raw=object(value);let directory:string;
   if(raw.url!==undefined){
    const url=textField(raw.url,"Git URL",2048);
    validateGitUrl(url);
    directory=path.join(root,"repositories",randomUUID());await fs.mkdir(path.dirname(directory),{recursive:true});
    try{await runCommand("git",["clone","--",url,directory],{env:{...process.env,GIT_TERMINAL_PROMPT:"0"},timeoutMs:300_000});}catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
   }else{const location=textField(raw.path,"仓库绝对路径",2048);if(!path.isAbsolute(location))throw new Error("请输入仓库绝对路径");directory=await fs.realpath(location);}
   if(directory===path.parse(directory).root)throw new Error("不能登记根目录");
   const top=await fs.realpath(await git(directory,["rev-parse","--show-toplevel"]));if(top!==directory)throw new Error("请选择 Git 仓库根目录");
   await git(directory,["rev-parse","--verify","HEAD"]);
   const rows=await records(),existing=rows.find(repo=>repo.path===directory);
   if(existing)return existing;
   const repo={id:randomUUID(),path:directory,name:path.basename(directory)};writeJson(file,[...rows,repo]);return repo;
  },
  async remove(id:string){writeJson(file,(await records()).filter(repo=>repo.id!==id));return {ok:true};}
 };
}
export function validateGitUrl(value:string){
 if(/^git@[a-zA-Z0-9.-]+:[\w./-]+(?:\.git)?$/u.test(value))return;
 let url:URL;try{url=new URL(value);}catch{throw new Error("使用 HTTPS 或 SSH Git URL");}
 if(!["https:","ssh:"].includes(url.protocol)||url.password||(url.protocol==="https:"&&url.username)||!url.hostname)throw new Error("使用不含凭据的 HTTPS 或 SSH Git URL；认证交由 Git/SSH 配置");
}
