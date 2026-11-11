import path from "node:path";
import fs from "node:fs";
import { object,textField } from "./orchestration-catalog.ts";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
export function modelCatalog(root:string){
 const directory=path.join(root,"agent");
 const registry=ModelRegistry.create(AuthStorage.create(path.join(directory,"auth.json")),path.join(directory,"models.json"));
 if(registry.getError())throw new Error("Pi models.json 配置无效，请检查模型配置文件");
 return {directory,models:registry.getAll().map(model=>({id:`${model.provider}/${model.id}`,name:model.name,provider:model.provider,contextWindow:model.contextWindow,configured:registry.hasConfiguredAuth(model)}))};
}

export function saveProviderAuth(root:string,value:unknown){
 const raw=object(value),provider=textField(raw.provider,"provider",100),apiKey=textField(raw.apiKey,"API Key",16384);
 if(!/^[a-z0-9][a-z0-9._-]*$/iu.test(provider)||/[\r\n\0]/u.test(apiKey))throw new Error("模型认证格式无效");
 if(!modelCatalog(root).models.some(model=>model.provider===provider))throw new Error("请先在 Pi models.json 中登记该 provider 的模型");
 const file=path.join(root,"agent","auth.json"),auth=AuthStorage.create(file);
 if(auth.drainErrors().length)throw new Error("现有 Pi 认证文件无效，请先修复后重试");
 auth.set(provider,{type:"api_key",key:apiKey});
 if(auth.drainErrors().length)throw new Error("保存模型认证失败，请检查数据目录权限");
 fs.chmodSync(file,0o600);
 return {ok:true,provider};
}
