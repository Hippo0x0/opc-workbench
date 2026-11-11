import { parseBudget } from "./settings.ts";
import { loadValidationEvidence, reviewValidationEvidence } from "./validation-evidence.ts";
import { checkoutResearchWorktree } from "./worktree-checkout.ts";
import {bindDiscoveredRepositories,isRepositoryPreparation,runRepositories,primaryRunRepository} from "./orchestration-repositories.ts";
import { writeStageToolEvidence } from "./trace.ts";
import { unavailableValidation } from "./result-format.ts";
import { skillDiscovery } from "./skill-library.ts";
import type { StageTask } from "./types.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createOrchestrationCatalog, digest, ids, object, textField, writeJson } from "./orchestration-catalog.ts";
import { orchestrationReportMarkdown } from "./orchestration-report.ts";
import type { ContextSection, FrozenOrchestration, OrchestrationInput, OrchestrationNode, OrchestrationNodeResult, OrchestrationRun, OrchestrationSkill, OrchestrationMessage } from "./orchestration-contract.ts";
import { createRuntimeManagement } from "./runtime-management.ts";
import { runLocalAgent, parseStageResult, type AgentRunInput } from "./agent.ts";
import { runCommand, type CommandRunner } from "./command.ts";
import { readUserSettings } from "./settings.ts";
import { requestedExperimentIterations } from "./experiment-iterations.ts";
import { reconstructJsonlState } from "./jsonl.ts";
import { LOCAL_AGENT_PROTOCOL_VERSION, parseActionNodeResult, parseStandaloneAgentOutcome, parseValidationOutcome, VALIDATION_RESULT_CONTRACT, validateActionInputs } from "./agent-protocol.ts";

function skillFiles(directory: string) {
  const files: Array<{name:string; data:Buffer;mode:number}> = []; let bytes = 0;
  function walk(relative: string) {
    for (const entry of fs.readdirSync(path.join(directory,relative), {withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if ([".git","node_modules","__pycache__"].includes(entry.name)) continue;
      const name=path.join(relative,entry.name);
      if(entry.isSymbolicLink()) throw new Error("所选 Skill 包含符号链接，无法冻结；请使用独立文件目录");
      if(entry.isDirectory()) walk(name);
      else if(entry.isFile()) {
        if(files.length>=1000) throw new Error("Skill 文件数量超过 1000");
        const file=path.join(directory,name),size=fs.statSync(file).size;
        bytes+=size; if(bytes>8*1024*1024) throw new Error("单个 Skill 内容超过 8 MB");
        files.push({name,data:fs.readFileSync(file),mode:0o600|(fs.statSync(file).mode&0o111)});
      }
    }
  }
  walk(""); return files;
}
const skillHash=(files:ReturnType<typeof skillFiles>)=>digest(JSON.stringify(files.map(file=>[file.name,file.mode,digest(file.data.toString("base64"))])));
const actionMaterialDigest=(result:OrchestrationNodeResult)=>digest(JSON.stringify({output:result.output??"",
  agentStatus:result.agentStatus??null,gaps:result.gaps??[]}));
export function orchestrationSections(frozen:FrozenOrchestration,node:OrchestrationNode,outputs?:Record<string,string>,skillRoot?:string):ContextSection[] {
  return [
    {title:"Agent 提示词",source:node.agentId||"自定义 Agent",content:node.prompt},
    {title:"任务需求",source:"本次任务",content:`${frozen.input.title}\n\n${frozen.input.description}`},
    {title:"仓库与执行环境",source:"登记的本机仓库",content:JSON.stringify(frozen.repositories,null,2)+(frozen.repositories.length?"\n已有代码在本机，不要重复 clone；需要修改时仅在执行目录的独立 worktree 内操作，不得 push、创建 PR 或发布。":"\n本次未绑定仓库。只使用已提供的资料，不伪造源码、实验或仓库状态；需要代码时明确指出缺口。")},
    {title:"Skills",source:"节点选择 + 本次追加",content:skillDiscovery(frozen.skills.filter(skill=>[...node.skillIds,...frozen.input.skillIds].includes(skill.id)), skill=>skillRoot?path.join(skillRoot,skill.id,"SKILL.md"):`<本Run>/skills/${skill.id}/SKILL.md`)},
    {title:"前序产物",source:outputs?"已完成节点":"执行时注入",content:outputs?JSON.stringify(outputs,null,2):"运行时注入已完成前序节点产物；当前尚未产生。"},
    {title:"补充指令",source:"本次任务",content:frozen.input.supplement||"未填写"},
  ];
}
export function createOrchestrationRuntime(root:string,options:{home?:string;env?:NodeJS.ProcessEnv;commandRunner?:CommandRunner;runAgent?:(input:AgentRunInput)=>Promise<string>;}={}) {
  const catalog=createOrchestrationCatalog(root,options.home), management=createRuntimeManagement(root);
  const directory=path.join(root,"orchestration-runs"), active=new Map<string,AbortController>(), live=new Map<string,OrchestrationRun>();
  const sessions=new Map<string,{steer(message:string):Promise<void>}>();
  const observed=new Set<string>();
  const chats=new Map<string,Promise<void>>();
  const env=options.env??process.env, command=options.commandRunner??runCommand;
  const agent=options.runAgent??((input:AgentRunInput)=>runLocalAgent(input,command));
  const runDir=(id:string)=>{if(!/^[a-f0-9-]{36}$/u.test(id))throw new Error("编排任务 ID 无效");return path.join(directory,id);};
  const sessionPath=(run:OrchestrationRun,node:OrchestrationNode)=>path.join(runDir(run.id),".agent-sessions",`${node.id}.jsonl`);
  async function captureExperimentEvidence(run:OrchestrationRun,node:OrchestrationNode,cwd:string,baselineCommit:string,signal:AbortSignal) {
    const evidenceDirectory=path.join(runDir(run.id),"evidence",node.id);
    fs.mkdirSync(evidenceDirectory,{recursive:true,mode:0o700});
    const git=async(args:string[])=>{
      try{return (await command("git",["-C",cwd,...args],{signal,timeoutMs:60_000})).stdout.trim();}
      catch(error){return `证据采集失败：${error instanceof Error?error.message:String(error)}`;}
    };
    const toolEvidenceFile=writeStageToolEvidence(runDir(run.id),node.id);
    const candidateCommit=await git(["rev-parse","HEAD"]);
    const status=await git(["status","--short"]);
    const committedDiff=await git(["diff","--binary",`${baselineCommit}..HEAD`]);
    const workingDiff=await git(["diff","--binary","HEAD"]);
    const diffFile=path.join(evidenceDirectory,"git-diff.patch");
    const statusFile=path.join(evidenceDirectory,"git-status.txt");
    fs.writeFileSync(diffFile,[committedDiff,workingDiff].filter(Boolean).join("\n"),{mode:0o600});
    fs.writeFileSync(statusFile,status||"工作区干净\n",{mode:0o600});
    const roundsFile=path.join(cwd,"autoresearch.jsonl");
    if(fs.existsSync(roundsFile))fs.copyFileSync(roundsFile,path.join(evidenceDirectory,"rounds.jsonl"));
    const manifestFile=path.join(evidenceDirectory,"manifest.json");
    writeJson(manifestFile,{
      schemaVersion:1,kind:"native-autoresearch-evidence",runId:run.id,nodeId:node.id,
      worktree:cwd,baselineCommit,candidateCommit,gitStatusFile:statusFile,gitDiffFile:diffFile,toolEvidenceFile,
      autoresearchJsonl:path.join(cwd,"autoresearch.jsonl"),
      autoresearchReportDirectory:path.join(runDir(run.id),"autoresearch",node.id),
      traceDirectory:runDir(run.id),capturedAt:new Date().toISOString(),
    });
    return {manifestFile,baselineCommit,candidateCommit,toolEvidenceFile};
  }
  function save(run:OrchestrationRun){run.updatedAt=new Date().toISOString();writeJson(path.join(runDir(run.id),"state.json"),run);}
  function messageKey(run:OrchestrationRun,nodeId:string){return `${run.id}:${nodeId}`;}
  function settleMessages(run:OrchestrationRun,nodeId:string,terminal:boolean){
    for(const item of run.messages??[])if(item.nodeId===nodeId&&["waiting","delivering"].includes(item.status))item.status=terminal?"undelivered":"waiting";
    save(run);
  }
  async function dispatchMessages(run:OrchestrationRun,nodeId:string){
    const client=sessions.get(messageKey(run,nodeId));if(!client)return;
    if((run.messages??[]).some(item=>item.nodeId===nodeId&&item.status==="delivering"))return;
    const item=(run.messages??[]).find(item=>item.nodeId===nodeId&&item.status==="waiting");if(!item)return;
    item.status="delivering";save(run);
    try{await client.steer(item.text);}catch(error){item.status="undelivered";item.error=error instanceof Error?error.message:String(error);save(run);void dispatchMessages(run,nodeId);}
  }
  function get(id:string):OrchestrationRun {
    const current=live.get(id);if(current)return current;
    const run=JSON.parse(fs.readFileSync(path.join(runDir(id),"state.json"),"utf8")) as OrchestrationRun;
    if(run.status==="RUNNING"&&!active.has(id)){run.status="BLOCKED";run.error="执行进程已停止，可继续执行未完成节点";for(const result of Object.values(run.nodes))if(result.status==="running")result.status="waiting";for(const item of run.messages??[])if(item.status==="delivering")item.status="waiting";save(run);}
    return run;
  }
  async function preview(value:unknown) {
    const raw=object(value), template=catalog.templates().find(t=>t.id===raw.templateId);
    if(!template)throw new Error("编排模板不存在");
    if(raw.templateVersion!==template.version)throw new Error("模板版本已变化，请重新预览上下文");
    const input:OrchestrationInput={templateId:template.id,templateVersion:template.version,title:textField(raw.title,"任务标题",200),description:textField(raw.description,"任务需求",20000,true),repositoryIds:ids(raw.repositoryIds??[]),skillIds:ids(raw.skillIds??[]),supplement:textField(raw.supplement,"补充指令",10000,true),...(raw.budget?{budget:parseBudget(raw.budget)}:{})};
    const experimentIndex = template.nodes.findIndex(node => node.kind === "agent" && !node.readOnly
      && (node.agentId ?? node.baseAgentId) === "opc-experiment-agent");
    const preparesRepository = experimentIndex >= 0 && template.nodes.slice(0,experimentIndex).some(isRepositoryPreparation);
    const needsBoundRepository = template.id === "system-autoresearch-v1"
      || experimentIndex >= 0 && !preparesRepository;
    if (!input.repositoryIds.length && needsBoundRepository) throw new Error(template.id === "system-autoresearch-v1"
      ? "Pi-AutoResearch 需要选择已登记的 Git 仓库" : "原生实验需要选择已登记的目标 Git 仓库");
    const records=await management.repositories();
    const repositories=await Promise.all(input.repositoryIds.map(async id=>{const repo=records.find(repo=>repo.id===id);if(!repo?.available)throw new Error("选中的仓库已不可用");return {id:repo.id,name:repo.name,path:repo.path,commit:(await command("git",["-C",repo.path,"rev-parse","HEAD"],{env,timeoutMs:60_000})).stdout.trim()};}));
    const available=catalog.skills(), selected=[...new Set([...input.skillIds,...template.nodes.flatMap(n=>n.skillIds)])];
    const skills:OrchestrationSkill[]=selected.map(id=>{const skill=available.find(s=>s.id===id);if(!skill)throw new Error("引用的 Skill 已不可用，请重新选择");return {...skill,hash:skillHash(skillFiles(skill.directory))};});
    const valueToFreeze={protocolVersion:LOCAL_AGENT_PROTOCOL_VERSION,template,skills,input,repositories};
    const frozen:FrozenOrchestration={...valueToFreeze,hash:digest(JSON.stringify(valueToFreeze))};
    return {frozen,sections:template.nodes.map(node=>({nodeId:node.id,sections:orchestrationSections(frozen,node)}))};
  }
  async function prepare(run:OrchestrationRun,signal:AbortSignal) {
    fs.mkdirSync(run.cwd,{recursive:true});
    for(const repository of run.frozen.repositories){
      const target=path.join(run.cwd,repository.id);
      if(fs.existsSync(target)){await command("git",["-C",target,"rev-parse","--show-toplevel"],{signal});continue;}
      await checkoutResearchWorktree({source:repository.path,target,commit:repository.commit,env,signal,commandRunner:command});
    }
  }
  async function execute(run:OrchestrationRun,signal:AbortSignal) {
    const modelEnv={...env,PI_CODING_AGENT_DIR:path.join(root,"agent")};
    const budget=run.frozen.input.budget;
    const invoke=async(input:AgentRunInput,deadline?:number)=>{
      const nodeRemaining=deadline===undefined?undefined:deadline-Date.now();
      if(nodeRemaining!==undefined&&nodeRemaining<=0)throw new Error("验证节点执行时限已耗尽");
      if(budget?.maxAgentInvocations!==undefined&&(run.agentInvocations??0)>=budget.maxAgentInvocations)throw new Error("RESEARCH_BUDGET_EXHAUSTED: maxAgentInvocations");
      const wallLimits=[run.runWallTimeMinutes,budget?.maxWallTimeMinutes].filter((value):value is number=>typeof value==="number");
      const runWallTimeMinutes=wallLimits.length?Math.min(...wallLimits):null;
      const remaining=runWallTimeMinutes===null?undefined:runWallTimeMinutes*60_000-(Date.now()-Date.parse(run.createdAt));
      if(remaining!==undefined&&remaining<=0)throw new Error("RESEARCH_BUDGET_EXHAUSTED: maxWallTimeMinutes");
      const limits=[nodeRemaining,run.agentTimeoutMinutes==null?undefined:run.agentTimeoutMinutes*60_000,remaining,budget?.stageTimeoutMinutes===undefined?undefined:budget.stageTimeoutMinutes*60_000].filter((item):item is number=>item!==undefined);
      run.agentInvocations=(run.agentInvocations??0)+1;save(run);
      return agent({...input,...(limits.length?{timeoutMs:Math.min(...limits)}:{})});
    };
    await prepare(run,signal);
    const groups:OrchestrationNode[][]=[];
    for(const node of run.frozen.template.nodes){if(node.parallel&&groups.length)groups.at(-1)!.push(node);else groups.push([node]);}
    for(const group of groups){
      signal.throwIfAborted();
      const awaitingAction=group.find(node=>node.kind==="agent"&&node.actions?.length
        &&run.nodes[node.id]?.status==="completed"&&!run.nodes[node.id]?.selectedActionId);
      if(awaitingAction){
        const result=run.nodes[awaitingAction.id]!;
        result.status="review";
        result.digest=actionMaterialDigest(result);
        run.status="REVIEW_REQUIRED";save(run);return;
      }
      const outputs=Object.fromEntries(Object.entries(run.nodes)
        .filter(([id,r])=>["completed","skipped"].includes(r.status)&&run.frozen.template.nodes.find(n=>n.id===id)?.kind!=="approval")
        .map(([id,r])=>[id,r.status==="skipped"?`[节点已跳过；无 Agent 产物] ${r.error??"用户选择跳过"}`:r.output||""]));
      const beforeRun=group.find(node=>node.kind==="agent"&&node.enabledInteractions?.some(id=>
        node.interactions?.some(interaction=>interaction.id===id&&interaction.timing==="before-run"))
        &&!run.nodes[node.id]?.preRunInputs&&!["completed","skipped"].includes(run.nodes[node.id]!.status));
      if(beforeRun){
        const interaction=beforeRun.interactions!.find(item=>item.timing==="before-run"&&beforeRun.enabledInteractions?.includes(item.id))!;
        const sections=orchestrationSections({...run.frozen,repositories:runRepositories(run)},beforeRun,outputs);
        const result=run.nodes[beforeRun.id]!;
        result.status="review";result.preRunInteractionId=interaction.id;result.sections=sections;
        result.digest=digest(JSON.stringify({nodeId:beforeRun.id,interactionId:interaction.id,sections}));
        run.status="REVIEW_REQUIRED";save(run);return;
      }
      const gate=group.find(node=>node.kind==="approval");
      if(gate&&run.nodes[gate.id]!.status!=="completed"){
        const preceding=run.frozen.template.nodes.slice(0,run.frozen.template.nodes.indexOf(gate));
        const report=[...preceding].reverse().find(node=>(node.agentId ?? node.baseAgentId)==="opc-report-asset-agent");
        let material=report?outputs[report.id]||"":"";
        if(material)material=orchestrationReportMarkdown(material)??material;
        if(!material)material=`# ${run.title}\n\n`+preceding.filter(node=>outputs[node.id]).map(node=>`## ${node.name}\n\n${outputs[node.id]}`).join("\n\n");
        if(run.pendingTransition?.targetNodeId===gate.id)material+=`\n\n## 用户选择\n\n${JSON.stringify(run.pendingTransition.inputs)}`;
        run.nodes[gate.id]={status:"review",output:material,digest:digest(JSON.stringify({material,outputs})),sections:orchestrationSections({...run.frozen,repositories:runRepositories(run)},gate,outputs)};run.status="REVIEW_REQUIRED";save(run);return;
      }
      if(group.length>1&&group.some(isRepositoryPreparation)
        &&(group.filter(isRepositoryPreparation).length!==1||group.some(node=>!isRepositoryPreparation(node)&&(node.agentId??node.baseAgentId)!=="opc-troubleshooting-agent")))
        throw new Error("仓库准备仅允许与只读自动排障并行，其余节点必须在汇合后执行");

      if(group.length>1&&group.some(n=>!n.readOnly))
        throw new Error("并行组包含可写 Agent；请在模板中改为顺序执行，避免同时修改同一 worktree");
      const groupRepositories=runRepositories(run);
      const groupPrimaryRepository=primaryRunRepository(run);
      const pending=group.filter(node=>!["completed","skipped"].includes(run.nodes[node.id]!.status));
      let cursor=0;
      const results=await Promise.allSettled(Array.from({length:Math.min(pending.length,budget?.maxConcurrency??3)},async()=>{
        while(cursor<pending.length){const node=pending[cursor++]!;
        const started=Date.now(),result=run.nodes[node.id]!;
        result.status="running";result.startedAt=new Date(started).toISOString();delete result.error;
        const sections=orchestrationSections({...run.frozen,repositories:groupRepositories},node,outputs,path.join(runDir(run.id),"skills"));
        if(isRepositoryPreparation(node)){
          const registered=(await management.repositories()).filter(repo=>repo.available).slice(0,20).map(repo=>({id:repo.id,name:repo.name,path:repo.path}));
          sections[2]!.content+=`\n可复用的本机登记候选（仅是线索，不代表任务目标）：${JSON.stringify(registered)}\n核对 origin、项目/组件与任务相关性后再选择；不要直接把第一个目录当主仓库。`;
        }
        if(run.pendingTransition?.targetNodeId===node.id)sections.push({title:"用户选择的下一步",source:run.pendingTransition.sourceNodeId,
          content:JSON.stringify({actionId:run.pendingTransition.actionId,inputs:run.pendingTransition.inputs},null,2)});
        if(result.supplementalPrompt)sections.push({title:"节点补充指令",source:"本次节点继续执行",content:result.supplementalPrompt});
        if(result.preRunInputs)sections.push({title:"运行前输入",source:"用户确认",content:JSON.stringify(result.preRunInputs,null,2)});
        sections[2]!.content+=`\n实际执行目录：${run.cwd}\n隔离 worktree：${JSON.stringify(runRepositories(run).map(repo=>({name:repo.name,path:repo.worktreePath})))}`;
        result.sections=sections;save(run);
        try {
          if(node.kind==="export") {
            const previous=run.frozen.template.nodes[run.frozen.template.nodes.indexOf(node)-1];
            const approved=previous?run.nodes[previous.id]:undefined;
            if(!approved?.approvedBy||approved.status!=="completed"||!approved.output)throw new Error("导出前必须确认完整报告");
            const file=path.join(runDir(run.id),"report.md");
            fs.writeFileSync(file,approved.output,{mode:0o600});
            result.output=approved.output;result.url=`/api/workbench/orchestration/runs/${run.id}/report`;
            result.status="completed";return;
          }
          const savedSession=sessionPath(run,node);
          const continueSession=Boolean(result.supplementalPrompt&&fs.existsSync(savedSession));
          const nativeExperiment=(node.agentId??node.baseAgentId)==="opc-experiment-agent"&&!node.readOnly;
          const repository=groupPrimaryRepository;
          if(nativeExperiment&&!repository&&run.frozen.template.nodes.some(isRepositoryPreparation)){
            result.agentStatus="DEGRADED";result.gaps=["仓库发现与准备未取得可用主仓库"];
            result.output="实验未执行：没有准备完成的主仓库。请参阅仓库准备产物中的候选、来源与失败原因；后续研究继续，不宣称实验成功。";
            result.status="completed";settleMessages(run,node.id,true);return;
          }
          if(nativeExperiment&&!repository)throw new Error("实验执行需要已登记的目标 Git 仓库，请绑定仓库后创建任务");
          const cwd=repository?repository.worktreePath:run.cwd;
          const jsonlPath=path.join(cwd,"autoresearch.jsonl");
          const resumeExperiment=nativeExperiment&&result.nativeExperimentStarted===true&&fs.existsSync(jsonlPath);
          const previousManifest=path.join(runDir(run.id),"evidence",node.id,"manifest.json");
          const frozenBaseline=resumeExperiment&&fs.existsSync(previousManifest)
            ? JSON.parse(fs.readFileSync(previousManifest,"utf8")) as {baselineCommit?:unknown}
            : undefined;
          const baselineCommit=typeof frozenBaseline?.baselineCommit==="string"&&frozenBaseline.baselineCommit
            ? frozenBaseline.baselineCommit
            : nativeExperiment?(await command("git",["-C",cwd,"rev-parse","HEAD"],{signal,timeoutMs:60_000})).stdout.trim():"";
          const frozenIterations=nativeExperiment?requestedExperimentIterations({title:run.title,description:run.frozen.input.description,taskPrompt:run.frozen.input.supplement}):undefined;
          const additionalIterations=nativeExperiment&&result.supplementalPrompt?requestedExperimentIterations({title:"",description:"",taskPrompt:result.supplementalPrompt}):undefined;
          const requestedIterations=additionalIterations??frozenIterations;
          const previous=resumeExperiment?reconstructJsonlState(fs.readFileSync(jsonlPath,"utf8")):undefined;
          const completedIterations=previous?previous.results.filter(item=>item.segment===previous.currentSegment).length:0;
          const maxIterations=resumeExperiment?Math.max(frozenIterations??5,completedIterations+(additionalIterations??1)):requestedIterations??5;
          const task:StageTask={protocolVersion:1,schemaVersion:1,researchId:run.id,runId:run.id,stageId:node.id,attempt:1,agentId:"opc-experiment-agent",frozenInputRef:run.frozen.hash,acceptedArtifactRefs:[],objective:run.title,constraints:["no-push"],capabilityGrant:node.capabilities??[],budget:{maxIterations}};
          const contextPrompt=sections.map(section=>`## ${section.title}\n${section.content}`).join("\n\n");
          const validationResult = !nativeExperiment && !node.actions?.length && (node.baseAgentId ?? node.agentId) === "opc-cross-validation-agent";
          const actionResultContract=node.actions?.length&&!nativeExperiment
            ? `\n\n本节点启用了产物后的人工选择。只返回一个单一 JSON 对象，不要代码块或额外说明：{\"protocolVersion\":1,\"agentVersion\":${node.agentVersion??1},\"nodeId\":${JSON.stringify(node.id)},\"agentId\":${JSON.stringify(node.agentId??node.baseAgentId??node.id)},\"status\":\"OK|DEGRADED|FAILED|CANCELLED\",\"summary\":\"简要结论\",\"gaps\":[],\"payload\":{\"markdown\":\"完整正文及可定位证据\"}}。DEGRADED 的缺口写入 gaps；不要自行选择后续节点。`
            : validationResult ? "\n\n" + VALIDATION_RESULT_CONTRACT : "";
          if(nativeExperiment){result.nativeExperimentStarted=true;save(run);}
          const toolGrant=node.readOnly?"read,grep,find,ls":undefined;
          const agentInput:AgentRunInput={cwd,model:run.model,env:modelEnv,signal,readOnly:node.readOnly,timeoutMs:0,
            ...(node.readOnly&&!groupRepositories.length?{bashArtifactDirectory:cwd}:{}),
            ...(toolGrant!==undefined?{allowedTools:toolGrant}:{}),
            ...(!node.readOnly&&!nativeExperiment?{stagePolicy:"local-code-only" as const}:{}),
            isolatedSkills:true,promptViaStdin:true,
            sessionPath:savedSession,
            interactive:{
              ready(client:{steer(message:string):Promise<void>}){sessions.set(messageKey(run,node.id),client);void dispatchMessages(run,node.id);},
              queueChanged(steering:readonly string[]){const item=(run.messages??[]).find(item=>item.nodeId===node.id&&item.status==="delivering");if(!item)return;
                if(steering.includes(item.text))observed.add(item.id);
                else if(observed.delete(item.id)){item.status="delivered";save(run);void dispatchMessages(run,node.id);}},
              pending(){return (run.messages??[]).some(item=>item.nodeId===node.id&&["waiting","delivering"].includes(item.status));},
              closed(){sessions.delete(messageKey(run,node.id));for(const item of run.messages??[])if(item.nodeId===node.id)observed.delete(item.id);settleMessages(run,node.id,run.nodes[node.id]?.status==="completed");},
            },
            prompt:nativeExperiment?contextPrompt+`\n\n使用 Pi AutoResearch 原生循环：首次测量前用 init_experiment 初始化指标、单位和方向，已有配置的续跑不重复初始化；正式基线和候选测量必须通过 run_experiment 执行并用 log_experiment 登记结果，不能只用 bash 自建测量循环后直接结束。每轮记录原始样本和正确性证据，固定 benchmark 与正确性检查，通过 log_experiment 记录 keep/discard/crash；禁止 push。${resumeExperiment?"保留已有轮次并继续执行。":"新建实验会话。"}${requestedIterations===undefined?`默认最多 ${maxIterations} 轮，达到目标可提前结束。`:`本次须完成到总计 ${maxIterations} 轮，不因暂无收益提前结束。`}`:continueSession?result.supplementalPrompt!+actionResultContract:contextPrompt+actionResultContract,
            ...(nativeExperiment?{nativeAutoresearch:{task,reportDirectory:path.join(runDir(run.id),"autoresearch",node.id),maxIterations,...(resumeExperiment?{resume:true}:{}),...(requestedIterations!==undefined?{requiredIterations:maxIterations}:{})}}:{}),
            skills:run.frozen.skills.filter(skill=>[...node.skillIds,...run.frozen.input.skillIds].includes(skill.id))
              .map(skill=>path.join(runDir(run.id),"skills",skill.id)),
            trace:{directory:runDir(run.id),stageId:node.id,attempt:1}};
          const validationEvidence=validationResult?loadValidationEvidence(runDir(run.id),
            run.frozen.template.nodes.filter(previous=>previous.id!==node.id&&outputs[previous.id]!==undefined)
              .map(previous=>({id:previous.id,output:outputs[previous.id]!})),modelEnv):undefined;
          const validationLimits=[run.agentTimeoutMinutes??undefined,budget?.stageTimeoutMinutes].filter((value):value is number=>value!==undefined);
          const validationDeadline=validationLimits.length?started+Math.min(...validationLimits)*60_000:undefined;
          let output=validationEvidence?await reviewValidationEvidence({directory:runDir(run.id),nodeId:node.id,
            context:`任务：${run.title}\n${run.frozen.input.description}\n${run.frozen.input.supplement}\n核验要求：${node.prompt}`,
            evidence:validationEvidence,signal,concurrency:Math.min(3,budget?.maxConcurrency??3),
            invoke:(prompt,phase,attempt,validationSignal)=>invoke({cwd,model:run.model,env:modelEnv,signal:validationSignal,
              readOnly:true,allowedTools:"",isolatedSkills:true,promptViaStdin:true,timeoutMs:0,prompt,
              trace:{directory:runDir(run.id),stageId:node.id,attempt}},validationDeadline)})
            :await invoke(agentInput);
          signal.throwIfAborted();if(!output.trim())throw new Error("Agent 未返回内容");
          if(isRepositoryPreparation(node)){
            output=await bindDiscoveredRepositories({root,run,nodeId:node.id,output,env,command,signal});
            result.agentStatus=(run.repositoryPreparation?.required===false||primaryRunRepository(run))&&!run.repositoryPreparation?.gaps.length?"OK":"DEGRADED";
            result.gaps=run.repositoryPreparation?.gaps??[];save(run);
          }
          let material=output;
          if(node.actions?.length){
            if(nativeExperiment){
              const artifact=parseStageResult(output,task);
              result.agentStatus=artifact.status;result.gaps=artifact.gaps.map(gap=>gap.description);
              result.output=output;
              if(["FAILED","CANCELLED"].includes(artifact.status))throw new Error(`Agent 结果为 ${artifact.status}：${artifact.summary}`);
            }else{
              let artifact:ReturnType<typeof parseActionNodeResult>;
              try{artifact=parseActionNodeResult(output,node.id,node.agentId??node.baseAgentId??node.id);}
              catch(error){
                if(/额度已使用完毕|剩余额度为\s*0/u.test(output))throw new Error(`模型 ${run.model} 额度已用完，请待额度恢复后重新执行当前节点`);
                if(output.length>60_000)throw error;
                const repaired=await invoke({cwd,model:run.model,env:modelEnv,signal,readOnly:true,allowedTools:"",isolatedSkills:true,
                  timeoutMs:0,promptViaStdin:true,prompt:`只修正以下回复的 JSON 格式或缺失的必需字段，不增加或删除业务事实；无证据处标为 DEGRADED 并写入 gaps。按原节点契约返回单一 JSON 对象，不要代码块或解释。\n\n${actionResultContract}\n\n${output}`,
                  trace:{directory:runDir(run.id),stageId:node.id,attempt:2}});
                signal.throwIfAborted();
                artifact=parseActionNodeResult(repaired,node.id,node.agentId??node.baseAgentId??node.id);
              }
              result.agentStatus=artifact.status;result.gaps=artifact.gaps;
              result.output=artifact.markdown;
              if(["FAILED","CANCELLED"].includes(artifact.status))throw new Error(`Agent 结果为 ${artifact.status}：${artifact.summary}`);
              material=artifact.markdown;
            }
          }else if(!nativeExperiment){
            let outcome:ReturnType<typeof parseStandaloneAgentOutcome>;
            if(validationResult){
              try{outcome=parseValidationOutcome(output);}
              catch(error){
                let repaired = unavailableValidation(output);
                try {
                  if(output.length<=60_000) repaired=await invoke({cwd,model:run.model,env:modelEnv,signal,readOnly:true,allowedTools:"",isolatedSkills:true,
                    timeoutMs:0,promptViaStdin:true,prompt:`只修正以下验证结果的格式和字段，不重新验证、不改变业务结论，不添加证据。原文 ${String(error instanceof Error?error.message:error)}。\n${VALIDATION_RESULT_CONTRACT}\n\n${output}`,
                    trace:{directory:runDir(run.id),stageId:node.id,attempt:2}});
                  signal.throwIfAborted();
                  outcome=parseValidationOutcome(repaired);
                } catch {
                  signal.throwIfAborted();
                  repaired=unavailableValidation(output);outcome=parseValidationOutcome(repaired);
                }
                output=repaired;material=repaired;
              }
            }else outcome=parseStandaloneAgentOutcome(output);
            if(outcome){
              result.agentStatus=outcome.status;result.gaps=outcome.gaps;result.output=output;
              if(["FAILED","CANCELLED"].includes(outcome.status))throw new Error(`Agent 结果为 ${outcome.status}：${outcome.summary}`);
            }
          }
          if(!nativeExperiment && node.kind==="agent" && (node.agentId??node.baseAgentId)!=="opc-report-asset-agent") {
            const evidenceFile=writeStageToolEvidence(runDir(run.id),node.id);
            if(evidenceFile)material+=`\n\n## Runtime 工具证据交接\n\n- 本节点完整工具事件：${evidenceFile}\n- 原始轨迹：${path.join(runDir(run.id),"stage-trace.jsonl")}\n核验与报告必须以这些事件中的命令实参、返回、失败和重复尝试复核执行声明，不能只采信节点摘要。不要把工具调用数当作服务端请求数；无法确认的请求次数明确标为未知。`;
          }
          if(nativeExperiment){
            const evidence=await captureExperimentEvidence(run,node,cwd,baselineCommit,signal);
            material+=`\n\n## 实验原始证据交接（后续验证必须读取）\n\n- 证据清单：${evidence.manifestFile}\n- 完整实验工具事件：${evidence.toolEvidenceFile??"未采集到工具事件"}\n- 原始轮次记录：${jsonlPath}\n- 实验起始提交：${evidence.baselineCommit}\n- 实验结束提交：${evidence.candidateCommit}\n- 候选工作区：${cwd}\n\n原生轮次为零只表示没有正式 log_experiment 记录，不代表未改码、未测量或没有候选。验证节点必须读取完整工具事件、证据清单、原始轮次记录、Git 状态与 diff，分别报告正式轮次、工具中可核验的诊断/候选测量和缺失证据；未记录轮次不得冒充已验收轮次，也不能抹去实际测量。并独立核对基线/候选来源、原始样本、正确性结果和改动范围；不能只复述本节点摘要。`;
          }
          if ((node.agentId ?? node.baseAgentId)==="opc-report-asset-agent") {
            const reportFile=path.join(run.cwd,"report.json");
            if (fs.existsSync(reportFile)) {
              const stat=fs.statSync(reportFile);
              if (stat.isFile() && stat.size <= 2*1024*1024 && stat.mtimeMs >= started) {
                material=orchestrationReportMarkdown(fs.readFileSync(reportFile,"utf8")) ?? output;
              }
            }
          }
          if(nativeExperiment && agentInput.nativeAutoresearch?.requiredIterations!==undefined){
            const state=reconstructJsonlState(fs.existsSync(jsonlPath)?fs.readFileSync(jsonlPath,"utf8"):"");
            const count=state.results.filter(item=>item.segment===state.currentSegment).length;
            if(count<agentInput.nativeAutoresearch.requiredIterations){
              result.output=material;result.agentStatus="FAILED";
              result.gaps=[`用户要求 ${agentInput.nativeAutoresearch.requiredIterations} 轮，实际完成 ${count} 轮`];
              throw new Error(`实验轮次未完成：${count}/${agentInput.nativeAutoresearch.requiredIterations}；已保留进度，请继续执行或由用户主动暂停、取消任务`);
            }
          }
          result.output=material;result.status="completed";settleMessages(run,node.id,true);
          if(run.pendingTransition?.targetNodeId===node.id)delete run.pendingTransition;
          if(group.length>1&&node.actions?.length){
            result.status="review";result.digest=actionMaterialDigest(result);run.status="REVIEW_REQUIRED";save(run);
            active.get(run.id)?.abort();
          }
        }catch(error){result.status=signal.aborted?"waiting":"blocked";result.error=error instanceof Error?error.message:String(error);throw error;}
        finally{result.durationMs=(result.durationMs??0)+Date.now()-started;result.finishedAt=new Date().toISOString();save(run);}
        }
      }));
      const failure=results.find(result=>result.status==="rejected");if(failure?.status==="rejected")throw failure.reason;
      const decision=group.find(node=>node.kind==="agent"&&node.actions?.length
        &&run.nodes[node.id]?.status==="completed"&&!run.nodes[node.id]?.selectedActionId);
      if(decision){
        const result=run.nodes[decision.id]!;
        result.status="review";result.digest=actionMaterialDigest(result);
        run.status="REVIEW_REQUIRED";save(run);return;
      }
    }
    run.status="COMPLETED";save(run);
  }
  function launch(run:OrchestrationRun) {
    if(active.has(run.id))throw new Error("任务仍在执行，请等待当前执行结束");
    const controller=new AbortController();active.set(run.id,controller);live.set(run.id,run);run.status="RUNNING";delete run.error;save(run);
    void fs.promises.mkdir(run.cwd,{recursive:true}).then(()=>execute(run,controller.signal)).catch(error=>{if(controller.signal.aborted){const stored=get(run.id);run.status=stored.status==="CANCELLED"?"CANCELLED":stored.status==="REVIEW_REQUIRED"?"REVIEW_REQUIRED":"PAUSED";}else{run.status="BLOCKED";run.error=error instanceof Error?error.message:String(error);}save(run);}).finally(async()=>{save(run);active.delete(run.id);live.delete(run.id);});
  }
  function startChat(run:OrchestrationRun,node:OrchestrationNode,item:OrchestrationMessage){
    const key=messageKey(run,node.id),savedSession=sessionPath(run,node);
    if(!fs.existsSync(savedSession))throw new Error("此节点没有可恢复的 Pi 会话，无法在原上下文中对话");
    item.status="chatting";save(run);
    const prior=chats.get(key)??Promise.resolve();
    const current=prior.catch(()=>{}).then(async()=>{
      try{
        const modelEnv={...env,PI_CODING_AGENT_DIR:path.join(root,"agent")};
        const native=(node.agentId??node.baseAgentId)==="opc-experiment-agent"&&!node.readOnly;
        const cwd=native?(primaryRunRepository(run)?.worktreePath??run.cwd):run.cwd;
        await agent({cwd,model:run.model,env:modelEnv,readOnly:true,allowedTools:"read,grep,find,ls",disableExtensions:true,isolatedSkills:true,timeoutMs:0,
          sessionPath:savedSession,prompt:item.text+"\n\n这是已结束节点的只读对话。不得修改文件、提交、推进流水线或改变已接受的产物。",promptViaStdin:true,
          trace:{directory:runDir(run.id),stageId:node.id,attempt:2}});
        item.status="replied";delete item.error;
      }catch(error){item.status="undelivered";item.error=error instanceof Error?error.message:String(error);}
      save(run);
    });
    chats.set(key,current);void current.finally(()=>{if(chats.get(key)===current)chats.delete(key);});
  }
  return {catalog,preview,get,
    message(id:string,value:unknown,owner:string){
      const raw=object(value),run=get(id),nodeId=textField(raw.nodeId,"节点 ID",80),node=run.frozen.template.nodes.find(item=>item.id===nodeId);
      if(run.owner!==owner)throw new Error("任务不存在");
      if(!node||node.kind!=="agent")throw new Error("请选择 Agent 节点");
      const content=textField(raw.text,"消息",20000);
      const chatNow=["COMPLETED","CANCELLED"].includes(run.status)||run.nodes[nodeId]?.status==="completed";
      if(chatNow&&!fs.existsSync(sessionPath(run,node)))throw new Error("此节点没有可恢复的 Pi 会话，无法在原上下文中对话");
      const item:OrchestrationMessage={id:randomUUID(),nodeId,text:content,createdAt:new Date().toISOString(),status:"waiting"};
      (run.messages??=[]).push(item);save(run);
      if(chatNow)startChat(run,node,item);
      else if(run.nodes[nodeId]?.status==="running")void dispatchMessages(run,nodeId);
      return run;
    },
    asChat(id:string,messageId:string,owner:string){
      const run=get(id),item=run.messages?.find(item=>item.id===messageId);
      if(run.owner!==owner)throw new Error("任务不存在");
      if(!item||item.status!=="undelivered")throw new Error("消息不是未送达状态");
      const node=run.frozen.template.nodes.find(node=>node.id===item.nodeId);
      if(!node||!["COMPLETED","CANCELLED"].includes(run.status)&&run.nodes[node.id]?.status!=="completed")throw new Error("节点尚未结束");
      startChat(run,node,item);return run;
    },
    summaries(){if(!fs.existsSync(directory))return [];return fs.readdirSync(directory).filter(id=>/^[a-f0-9-]{36}$/u.test(id)).map(id=>{
      const run=live.get(id)??JSON.parse(fs.readFileSync(path.join(runDir(id),"state.json"),"utf8")) as OrchestrationRun;
      return {id:run.id,title:run.title,status:run.status};
    });},
    list(){if(!fs.existsSync(directory))return [];return fs.readdirSync(directory).filter(id=>/^[a-f0-9-]{36}$/u.test(id)).map(id=>get(id)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));},
    async remove(id:string){
      const run=get(id);
      if(active.has(id)||run.status==="RUNNING")throw new Error("任务仍在执行，请先暂停或取消后再删除");
      for(const repo of run.frozen.repositories){const target=path.join(run.cwd,repo.id);if(fs.existsSync(target))await command("git",["-C",repo.path,"worktree","remove","--force",target],{env,timeoutMs:60_000});}
      await fs.promises.rm(runDir(id),{recursive:true});
      return {deleted:true};
    },
    async create(value:unknown,owner:string,trusted?:{model?:string}){
      const raw=object(value),{frozen}=await preview(raw);
      if(raw.contextHash!==frozen.hash)throw new Error("上下文已变化，请刷新预览后再创建任务");
      const settings=readUserSettings(root),model=trusted?.model??settings.model;
      if(!model.trim())throw new Error("请先配置 Pi 模型（provider/model）");
      const id=randomUUID(),now=new Date().toISOString();
      for(const skill of frozen.skills){const files=skillFiles(skill.directory);if(skillHash(files)!==skill.hash)throw new Error("Skill 内容已变化，请重新预览");for(const file of files){const target=path.join(runDir(id),"skills",skill.id,file.name);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.writeFileSync(target,file.data,{mode:file.mode});}}
      const run:OrchestrationRun={id,title:frozen.input.title,createdAt:now,updatedAt:now,owner,model,agentTimeoutMinutes:settings.timeouts.agentMinutes,runWallTimeMinutes:settings.runWallTimeMinutes,status:"PAUSED",frozen,nodes:Object.fromEntries(frozen.template.nodes.map(node=>[node.id,{status:"waiting"}])),cwd:path.join(runDir(id),"workspace")};
      save(run);launch(run);return run;
    },
    control(id:string,value:unknown,owner:string){
      const raw=object(value),run=get(id);
      if(run.owner!==owner)throw new Error("任务不存在");
      if(raw.action==="pause"||raw.action==="cancel"){
        if(run.status==="COMPLETED"||run.status==="CANCELLED")throw new Error("任务已结束");
        run.status=raw.action==="pause"?"PAUSED":"CANCELLED";save(run);active.get(id)?.abort();return run;
      }
      if(active.has(id))throw new Error("当前执行尚未退出，请稍后再操作");
      if(run.status==="COMPLETED")throw new Error("任务已结束");
      if(raw.action==="retry"||raw.action==="continue"||raw.action==="skip"){
        const nodeId=textField(raw.nodeId,"节点 ID",80);
        const index=run.frozen.template.nodes.findIndex(node=>node.id===nodeId);
        if(index<0)throw new Error("节点不存在");
        const node=run.frozen.template.nodes[index]!;
        if(node.kind!=="agent")throw new Error("人工确认和导出节点不支持此操作");
        if(raw.action==="skip"&&!node.readOnly)throw new Error("可写节点不能跳过");
        const result=run.nodes[node.id]!;
        const supplemental=raw.action==="continue"||raw.action==="retry"&&raw.supplementalPrompt!==undefined?textField(raw.supplementalPrompt,"补充指令",20000):undefined;
        let groupEnd=index;
        while(groupEnd+1<run.frozen.template.nodes.length&&run.frozen.template.nodes[groupEnd+1]!.parallel)groupEnd++;
        for(let next=groupEnd+1;next<run.frozen.template.nodes.length;next++){
          const item=run.frozen.template.nodes[next]!,old=run.nodes[item.id]!;
          if(old.status!=="waiting")(run.history??=[]).push({nodeId:item.id,at:new Date().toISOString(),result:structuredClone(old)});
          run.nodes[item.id]={status:"waiting"};
        }
        if(raw.action==="retry")fs.rmSync(sessionPath(run,node),{force:true});
        if(result.status!=="waiting")(run.history??=[]).push({nodeId:node.id,at:new Date().toISOString(),result:structuredClone(result)});
        run.nodes[node.id]={status:raw.action==="skip"?"skipped":"waiting",...(supplemental?{supplementalPrompt:supplemental}:{}),
          ...(raw.action==="continue"&&result.nativeExperimentStarted?{nativeExperimentStarted:true}:{}),
          ...(raw.action==="continue"&&result.durationMs!==undefined?{durationMs:result.durationMs}:{})};
        if(raw.action==="skip"&&run.pendingTransition?.targetNodeId===node.id)delete run.pendingTransition;
        save(run);launch(run);return run;
      }
      if(raw.action==="select-action"){
        if(run.status!=="REVIEW_REQUIRED")throw new Error("当前没有待选择的节点动作");
        const nodeId=textField(raw.nodeId,"节点 ID",80),actionId=textField(raw.actionId,"动作 ID",80);
        const source=run.frozen.template.nodes.find(node=>node.id===nodeId);
        const result=source?run.nodes[source.id]:undefined;
        const binding=source?.actions?.find(action=>action.id===actionId);
        const interaction=source?.interactions?.find(item=>item.id===binding?.interactionId);
        if(!source||!result||result.status!=="review"||result.preRunInteractionId||!binding||!interaction||interaction.timing!=="after-result"||!source.enabledInteractions?.includes(interaction.id)){
          throw new Error("节点动作不可用");
        }
        if(typeof raw.digest!=="string"||raw.digest!==result.digest||result.digest!==actionMaterialDigest(result)){
          throw new Error("节点材料已变化，请重新查看并确认");
        }
        const inputs=validateActionInputs(interaction,raw.inputs);
        const nodes=run.frozen.template.nodes;
        const sourceIndex=nodes.findIndex(node=>node.id===source.id);
        const targetIndex=nodes.findIndex(node=>node.id===binding.targetNodeId);
        if(targetIndex<0)throw new Error("动作目标不存在");
        run.pendingTransition={sourceNodeId:source.id,targetNodeId:binding.targetNodeId,actionId,inputs};
        (run.history??=[]).push({nodeId:source.id,at:new Date().toISOString(),result:structuredClone(result)});
        result.status="completed";result.selectedActionId=actionId;result.actionInputs=inputs;
        if(targetIndex<=sourceIndex){
          for(let index=targetIndex;index<nodes.length;index++){
            const item=nodes[index]!,prior=run.nodes[item.id]!;
            if(prior.status!=="waiting"&&item.id!==source.id)(run.history??=[]).push({nodeId:item.id,at:new Date().toISOString(),result:structuredClone(prior)});
            run.nodes[item.id]={status:"waiting"};
          }
        }else{
          let groupStart=sourceIndex;
          while(groupStart>0&&nodes[groupStart]!.parallel)groupStart--;
          for(let index=groupStart;index<sourceIndex;index++){
            const item=nodes[index]!,prior=run.nodes[item.id]!;
            if(prior.status!=="waiting")(run.history??=[]).push({nodeId:item.id,at:new Date().toISOString(),result:structuredClone(prior)});
            run.nodes[item.id]={status:"skipped",error:`同组动作由「${source.name}」选择跳转至「${nodes[targetIndex]!.name}」`};
          }
          for(let index=sourceIndex+1;index<targetIndex;index++){
            const item=nodes[index]!,prior=run.nodes[item.id]!;
            if(prior.status!=="waiting")(run.history??=[]).push({nodeId:item.id,at:new Date().toISOString(),result:structuredClone(prior)});
            run.nodes[item.id]={status:"skipped",error:`由「${source.name}」选择跳转至「${nodes[targetIndex]!.name}」`};
          }
          for(let index=targetIndex;index<nodes.length;index++){
            const item=nodes[index]!,prior=run.nodes[item.id]!;
            if(prior.status!=="waiting")(run.history??=[]).push({nodeId:item.id,at:new Date().toISOString(),result:structuredClone(prior)});
            run.nodes[item.id]={status:"waiting"};
          }
        }
        save(run);launch(run);return run;
      }
      if(raw.action==="submit-before-run"){
        if(run.status!=="REVIEW_REQUIRED")throw new Error("当前没有待确认的运行前输入");
        const nodeId=textField(raw.nodeId,"节点 ID",80),node=run.frozen.template.nodes.find(item=>item.id===nodeId);
        const result=node?run.nodes[node.id]:undefined;
        const interaction=node?.interactions?.find(item=>item.id===result?.preRunInteractionId&&item.timing==="before-run");
        if(!node||!result||result.status!=="review"||!interaction||!node.enabledInteractions?.includes(interaction.id))throw new Error("运行前交互不可用");
        if(typeof raw.digest!=="string"||raw.digest!==result.digest||result.digest!==digest(JSON.stringify({nodeId,interactionId:interaction.id,sections:result.sections})))
          throw new Error("节点材料已变化，请重新查看并确认");
        result.preRunInputs=validateActionInputs(interaction,raw.inputs);
        result.status="waiting";delete result.digest;delete result.preRunInteractionId;
        save(run);launch(run);return run;
      }
      if(raw.action==="approve"){
        const node=run.frozen.template.nodes.find(n=>n.kind==="approval"&&run.nodes[n.id]?.status==="review");if(!node||run.status!=="REVIEW_REQUIRED")throw new Error("当前没有待审批节点");
        const result=run.nodes[node.id]!;if(typeof raw.digest!=="string"||result.digest!==raw.digest)throw new Error("审批材料已变化，请重新查看并确认");
        result.status="completed";result.approvedBy=owner;result.finishedAt=new Date().toISOString();save(run);
        if(run.pendingTransition?.targetNodeId===node.id)delete run.pendingTransition;
      } else if(raw.action!=="resume")throw new Error("不支持的编排操作");
      if(run.status==="REVIEW_REQUIRED"&&raw.action!=="approve")throw new Error("请先确认当前完整材料");
      launch(run);return run;
    },
    close(){for(const controller of active.values())controller.abort();},
  };
}
