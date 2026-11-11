import fs from "node:fs";
import path from "node:path";
import { object, writeJson } from "./orchestration-catalog.ts";
import type { ResearchBudget } from "./types.ts";
export interface Settings {model:string;runWallTimeMinutes:number|null;timeouts:{agentMinutes:number|null}}
function minutes(value:unknown):number|null {if(value===null)return null;if(typeof value!=="number"||!Number.isFinite(value)||value<1||value>1440)throw new Error("时限必须为 1 至 1440 分钟，或 null（不限）");return value;}
export function readUserSettings(root:string):Settings {
 try {return JSON.parse(fs.readFileSync(path.join(root,"settings.json"),"utf8")) as Settings;}
 catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return {model:"",runWallTimeMinutes:360,timeouts:{agentMinutes:60}};}
}
export function saveSettings(root:string,value:unknown):Settings {
 const raw=object(value),previous=readUserSettings(root);
 const model=raw.model===undefined?previous.model:raw.model;
 if(typeof model!=="string"||!model.trim()||!model.includes("/")||model.length>300||/[\r\n]/u.test(model))throw new Error("模型格式为 provider/model");
 const result={model:model.trim(),runWallTimeMinutes:raw.runWallTimeMinutes===undefined?previous.runWallTimeMinutes:minutes(raw.runWallTimeMinutes),timeouts:{agentMinutes:raw.agentMinutes===undefined?previous.timeouts.agentMinutes:minutes(raw.agentMinutes)}};
 writeJson(path.join(root,"settings.json"),result);return result;
}
export function parseBudget(value:unknown):ResearchBudget {
 const raw=object(value),result:ResearchBudget={maxConcurrency:3};
 for(const key of ["maxConcurrency","maxAgentInvocations","maxWallTimeMinutes","stageTimeoutMinutes"] as const){
  if(raw[key]===undefined)continue;
  const v=raw[key];if(typeof v!=="number"||!Number.isInteger(v)||v<1||v>(key==="maxConcurrency"?20:key==="maxAgentInvocations"?1000:1440))throw new Error(`预算 ${key} 无效`);
  result[key]=v;
 }
 return result;
}
