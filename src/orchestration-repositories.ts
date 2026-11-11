import path from "node:path";
import type { OrchestrationNode, OrchestrationRun } from "./orchestration-contract.ts";
import type { CommandRunner } from "./command.ts";
export const isRepositoryPreparation=(node:OrchestrationNode)=>(node.agentId??node.baseAgentId)==="opc-repository-preparation-agent";
export function runRepositories(run:OrchestrationRun){return run.frozen.repositories.map(repo=>({...repo,worktreePath:path.join(run.cwd,repo.id)}));}
export const primaryRunRepository=(run:OrchestrationRun)=>runRepositories(run)[0];
export async function bindDiscoveredRepositories(input:{root:string;run:OrchestrationRun;nodeId:string;output:string;env:NodeJS.ProcessEnv;command:CommandRunner;signal:AbortSignal}){
 const records=await Promise.all(runRepositories(input.run).map(async(repo)=>({id:repo.id,nodeId:input.nodeId,preparedAt:new Date().toISOString(),url:repo.path,name:repo.name,role:"main" as const,evidence:["用户显式绑定的 Git 仓库"],status:"ready" as const,path:repo.worktreePath,baseCommit:(await input.command("git",["-C",repo.worktreePath,"rev-parse","HEAD"],{signal:input.signal})).stdout.trim()})));
 input.run.repositoryPreparation={nodeId:input.nodeId,required:records.length>0,summary:records.length?`已准备 ${records.length} 个独立 worktree`:"用户未绑定仓库；仅继续文档研究，需要改码或实验时请登记并绑定仓库。",gaps:[],records};
 return input.output+"\n\n"+input.run.repositoryPreparation.summary;
}
