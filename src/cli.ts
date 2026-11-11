import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { startServer } from "./server.ts";
import { saveSettings } from "./settings.ts";
import { modelCatalog } from "./models.ts";
import { createRuntimeManagement } from "./runtime-management.ts";
import { createOrchestrationCatalog } from "./orchestration-catalog.ts";
export async function main(args=process.argv.slice(2)){
 const command=args[0]??"serve",values=args.slice(1);
 const flag=(name:string,fallback?:string)=>{const index=values.indexOf(name);if(index<0)return fallback;const value=values[index+1];if(!value||value.startsWith("--"))throw new Error(`${name} 缺少参数`);return value;};
 const root=path.resolve(flag("--data-dir",process.env.OPC_HOME||path.join(os.homedir(),".opc-workbench"))!);
 if(command==="--version"||command==="-v"){const pkg:unknown=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));console.log((pkg as {version:string}).version);return;}
 if(command==="--help"||command==="help"){
  console.log(`opc-workbench — Pi 编排与 Agent 工作台

  opc-workbench serve [--port 4310] [--data-dir <目录>]
  opc-workbench agent [Pi 参数…]       直接运行 Pi（在会话中使用 /login 登录）
  opc-workbench models                 列出 Pi 模型与认证可用状态
  opc-workbench configure --model provider/model
  opc-workbench repo add <绝对路径>     登记本机 Git 仓库
  opc-workbench repo clone <Git URL>    使用标准 Git 克隆并登记
  opc-workbench repo list
  opc-workbench skill add <绝对路径>    导入完整本地 Skill 包

数据目录默认 ~/.opc-workbench；也可设置 OPC_HOME。服务仅监听本机。`);return;
 }
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 if(command==="models"){console.log(JSON.stringify(modelCatalog(root),null,2));return;}
 if(command==="configure"){console.log(JSON.stringify(saveSettings(root,{model:flag("--model")}),null,2));return;}
 if(command==="repo"){
  const management=createRuntimeManagement(root);
  const result=values[0]==="list"?await management.repositories():values[0]==="add"?await management.register({path:values[1]}):values[0]==="clone"?await management.register({url:values[1]}):(()=>{throw new Error("使用 repo add / clone / list");})();
  console.log(JSON.stringify(result,null,2));return;
 }
 if(command==="skill"&&values[0]==="add"){console.log(JSON.stringify(createOrchestrationCatalog(root).registerSkill({path:values[1]}),null,2));return;}
 if(command!=="serve")throw new Error("未知命令，使用 opc-workbench --help 查看帮助");
 const port=Number(flag("--port","4310"));if(!Number.isInteger(port)||port<0||port>65535)throw new Error("端口无效");
 const app=await startServer({root,port});
 console.log(`OPC Workbench: ${app.url}\n数据目录: ${root}`);
 let closing=false;const stop=()=>{if(closing)return;closing=true;void app.close().finally(()=>process.exit());};
 process.once("SIGINT",stop);process.once("SIGTERM",stop);
}
