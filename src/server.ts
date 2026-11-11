import { createChat } from "./chat.ts";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOrchestrationRuntime } from "./orchestration-runtime.ts";
import { createRuntimeManagement } from "./runtime-management.ts";
import { readUserSettings, saveSettings } from "./settings.ts";
import { modelCatalog, saveProviderAuth } from "./models.ts";
import { createResearchTextRedactor, readTracePage } from "./trace.ts";
import { object, textField } from "./orchestration-catalog.ts";
import type { AgentRunInput } from "./agent.ts";
class HttpError extends Error {readonly status:number;constructor(status:number,message:string){super(message);this.status=status;}}
export async function startServer(options:{root:string;port?:number;runAgent?:(input:AgentRunInput)=>Promise<string>;env?:NodeJS.ProcessEnv}) {
 fs.mkdirSync(options.root,{recursive:true,mode:0o700});
 const runtime=createOrchestrationRuntime(options.root,{runAgent:options.runAgent,env:options.env}),management=createRuntimeManagement(options.root);
 const webRoot=path.resolve(fileURLToPath(new URL("../web/dist/",import.meta.url)));
 const clean=createResearchTextRedactor(options.env??process.env);
 const owner="local";
 const chat=createChat(options.root,{runAgent:options.runAgent,env:options.env,context:()=>JSON.stringify({runs:runtime.summaries().slice(-20),templates:runtime.catalog.templates().map(template=>({id:template.id,name:template.name}))})});
 const server=http.createServer((req,res)=>{void handle(req,res).catch(error=>{
  if(res.headersSent){res.destroy();return;}
  const status=error instanceof HttpError?error.status:(error as NodeJS.ErrnoException).code==="ENOENT"?404:400;
  json(res,{error:clean(error instanceof Error?error.message:"请求失败")},status);
 });});
 function json(res:http.ServerResponse,value:unknown,status=200){res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});res.end(JSON.stringify(value));}
 async function body(req:http.IncomingMessage):Promise<unknown>{
  if(!req.headers["content-type"]?.startsWith("application/json"))throw new HttpError(415,"请求体必须为 JSON");
  const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw new HttpError(413,"请求超过 1 MB");chunks.push(chunk as Buffer);}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new HttpError(400,"JSON 格式无效");}
 }
 async function handle(req:http.IncomingMessage,res:http.ServerResponse){
  const host=req.headers.host??"";
  if(!/^(?:127\.0\.0\.1|localhost):\d+$/u.test(host))throw new HttpError(403,"仅允许本机访问");
  if(req.headers.origin&&req.headers.origin!==`http://${host}`)throw new HttpError(403,"拒绝跨来源请求");
  const url=new URL(req.url??"/",`http://${host}`),route=url.pathname,method=req.method??"GET";
  const api="/api/workbench",base=`${api}/orchestration`;
  if(route===`${api}/health`&&method==="GET"){json(res,{ok:true,product:"opc-workbench"});return;}
  if(route===`${api}/settings`){if(method==="GET")json(res,readUserSettings(options.root));else if(method==="PUT")json(res,saveSettings(options.root,await body(req)));else throw new HttpError(405,"方法不支持");return;}
  if(route===`${api}/chat`&&method==="GET"){json(res,chat.get());return;}
  if(route===`${api}/chat/trace`&&method==="GET"){
   const id=chat.get().id;if(url.searchParams.get("conversationId")!==id)throw new HttpError(404,"对话不存在或已切换");
   json(res,readTracePage(path.join(options.root,"chat",id),"chat",url.searchParams));return;
  }
  if(route===`${api}/chat/orchestration`&&method==="POST"){const value=await body(req);if(chat.get().busy)throw new HttpError(409,"请先等待当前回复完成");json(res,chat.saveDraft(value));return;}
  if(route===`${api}/chat/messages`&&method==="POST"){const value=await body(req);if(chat.get().busy)throw new HttpError(409,"正在回复，请先停止当前回复");json(res,chat.send(value),202);return;}
  if(route===`${api}/chat/stop`&&method==="POST"){await body(req);json(res,chat.stop());return;}
  if(route===`${api}/chat/new`&&method==="POST"){await body(req);if(chat.get().busy)throw new HttpError(409,"请先停止当前回复");json(res,chat.reset());return;}
  if(route===`${api}/models/auth`&&method==="PUT"){json(res,saveProviderAuth(options.root,await body(req)));return;}
  if(route===`${api}/models`&&method==="GET"){json(res,modelCatalog(options.root));return;}
  if(route===`${api}/runtime/repositories`){
   if(method==="GET")json(res,await management.repositories());else if(method==="POST")json(res,await management.register(await body(req)));else if(method==="DELETE")json(res,await management.remove(textField(url.searchParams.get("id"),"仓库 ID",200)));else throw new HttpError(405,"方法不支持");return;
  }
  if(route===`${base}/catalog`&&method==="GET"){json(res,{templates:runtime.catalog.templates(),agents:runtime.catalog.agents(),skills:runtime.catalog.skills()});return;}
  if(route===`${base}/templates`){if(method==="POST")json(res,runtime.catalog.save(await body(req)));else if(method==="DELETE"){runtime.catalog.remove(textField(url.searchParams.get("id"),"模板 ID",64));json(res,{ok:true});}else throw new HttpError(405,"方法不支持");return;}
  if(route===`${base}/skills`){
   if(method==="GET")json(res,runtime.catalog.skills());else if(method==="POST")json(res,runtime.catalog.registerSkill(await body(req)));else if(method==="PUT")json(res,runtime.catalog.updateSkill(await body(req)));else if(method==="DELETE")json(res,runtime.catalog.removeSkill(textField(url.searchParams.get("id"),"Skill ID",200)));else throw new HttpError(405,"方法不支持");return;
  }
  if(route===`${base}/skills/agents`&&method==="PUT"){const raw=object(await body(req));json(res,runtime.catalog.setAgentSkills(textField(raw.agentId,"Agent ID",100),raw.skillIds));return;}
  if(route===`${base}/preview`&&method==="POST"){json(res,await runtime.preview(await body(req)));return;}
  if(route===`${base}/runs`){if(method==="GET")json(res,runtime.list());else if(method==="POST")json(res,await runtime.create(await body(req),owner),201);else throw new HttpError(405,"方法不支持");return;}
  const match=new RegExp(`^${base}/runs/([a-f0-9-]{36})(?:/(.*))?$`,"u").exec(route);
  if(match){
   const id=match[1]!,tail=match[2]??"";
   if(!tail&&method==="GET"){json(res,runtime.get(id));return;}
   if(!tail&&method==="DELETE"){json(res,await runtime.remove(id));return;}
   if(tail==="control"&&method==="POST"){json(res,runtime.control(id,await body(req),owner));return;}
   if(tail==="messages"&&method==="POST"){json(res,runtime.message(id,await body(req),owner));return;}
   const message=/^messages\/([a-f0-9-]{36})\/as-chat$/u.exec(tail);
   if(message&&method==="POST"){json(res,runtime.asChat(id,message[1]!,owner));return;}
   const run=runtime.get(id);
   const directory=path.dirname(run.cwd);
   if(tail==="report"&&method==="GET"){
    const content=fs.readFileSync(path.join(directory,"report.md"));
    res.writeHead(200,{"content-type":"text/markdown; charset=utf-8","content-disposition":'attachment; filename="report.md"',"cache-control":"no-store"});res.end(content);return;
   }
   if(tail==="trace"&&method==="GET"){
    const stageId=url.searchParams.get("stageId");
    if(!run.frozen.template.nodes.some(node=>node.id===stageId))throw new HttpError(404,"节点不存在");
    json(res,readTracePage(directory,stageId!,url.searchParams));return;
   }
  }
  if(route.startsWith("/api/"))throw new HttpError(404,"接口不存在");
  if(method!=="GET"&&method!=="HEAD")throw new HttpError(405,"方法不支持");
  const relative=decodeURIComponent(route).replace(/^\/+/,""),requested=path.resolve(webRoot,relative);
  if(requested!==webRoot&&!requested.startsWith(webRoot+path.sep))throw new HttpError(404,"文件不存在");
  const file=fs.existsSync(requested)&&fs.statSync(requested).isFile()?requested:path.join(webRoot,"index.html");
  const types:Record<string,string>={".html":"text/html; charset=utf-8",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png"};
  res.writeHead(200,{"content-type":types[path.extname(file)]??"application/octet-stream","x-content-type-options":"nosniff","content-security-policy":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(method==="HEAD"?undefined:fs.readFileSync(file));
 }
 await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(options.port??4310,"127.0.0.1",resolve);});
 const address=server.address();if(!address||typeof address==="string")throw new Error("监听地址不可用");
 return {server,runtime,url:`http://127.0.0.1:${address.port}`,close:async()=>{runtime.close();await chat.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
