import type { OrchestrationNode, OrchestrationTemplate } from "./orchestration-contract.ts";
import { BEFORE_RUN_INPUT, AFTER_RESULT_ROUTE } from "./agent-protocol.ts";
const agent=(id:string,name:string,prompt:string,readOnly=true):OrchestrationNode=>({id:`opc-${id}-agent`,agentId:`opc-${id}-agent`,name,prompt,readOnly,kind:"agent",parallel:false,skillIds:[],agentVersion:1,outputSchemaId:"markdown-result-v1",interactions:[BEFORE_RUN_INPUT,AFTER_RESULT_ROUTE],capabilities:readOnly?["repository.read","knowledge.read"]:["repository.read","repository.write","repository.commit","test.execute"]});
export const systemAgents:OrchestrationNode[]=[
 agent("research-planner","研究规划","澄清任务目标、范围、成功条件与证据源。模糊信息列出合理假设和待核验项；根据本地资料与用户选择的 Skills 制定可执行计划，不虚构输入。"),
 agent("repository-preparation","仓库准备","核对用户绑定仓库与任务的相关性、HEAD 和目录。没有仓库时准确交付缺口并继续文档研究，不伪造源码或实验结果。"),
 agent("troubleshooting","问题排查","根据已有材料提出可证伪的假设、诊断步骤和证据缺口，明确事实与推断。"),
 agent("codebase","代码检索","只读搜索绑定的本地代码，给出文件路径、符号和定位证据；不能把未读取的代码当事实。"),
 agent("knowledge","知识检索","按需读取本次提供的本地 Skills 与资料，逐条引用来源；资料不可用时说明缺口。"),
 agent("requirements","需求定义","形成需求说明与验收标准，标明角色、流程、异常、边界和缺失输入；不把推断说成用户已确认的决定。"),
 agent("solution","方案设计","结合需求与代码证据比较可行方案，给出约束、取舍、实现步骤、测试和回滚条件。"),
 agent("coding","编码实现","在指定 worktree 中完成需求，遵循仓库约定并运行定向验证，报告改动和真实验证结果；禁止推送、创建 PR 或发布。",false),
 agent("experiment","实验执行","使用 init_experiment、run_experiment、log_experiment 执行可重复的基线与候选测量，记录原始输出、指标、正确性与保留/丢弃决定；缺少条件时如实报告。",false),
 agent("cross-validation","交叉验证","独立核查上游证据与结论，指出未验证事项，区分执行完成与业务目标达成。"),
 agent("decision","综合决策","基于可定位证据给出结论、置信边界、未解决风险与下一步。"),
 agent("report-asset","报告生成","使用 Markdown 汇总完整报告，保留任务、方法、证据、结果、缺口与复现步骤；不得宣称缺少证据的成功。"),
 {id:"system-approval",agentId:"system-approval",name:"人工确认",prompt:"展示完整材料，批准后冻结该版本供下游导出。",readOnly:true,kind:"approval",parallel:false,skillIds:[]},
 {id:"system-export",agentId:"system-export",name:"导出报告",prompt:"将已批准的完整 Markdown 原样保存到本地。",readOnly:false,kind:"export",parallel:false,skillIds:[]},
];
export function defaultTemplates(agents:OrchestrationNode[]):OrchestrationTemplate[]{
 const presets:Array<[string,string,string[]]>=[
 ["general-research-v1","通用研究",["research-planner","codebase","knowledge","decision","report-asset"]],
 ["requirement-research-v1","需求研究",["research-planner","requirements","cross-validation","report-asset"]],
 ["solution-research-v1","方案研究",["research-planner","codebase","solution","cross-validation","report-asset"]],
 ["code-review-v1","代码审查",["research-planner","codebase","cross-validation","report-asset"]],
 ["online-incident-v1","故障排查",["research-planner","troubleshooting","codebase","decision","report-asset"]],
 ["finding-investigation-v1","问题调查",["research-planner","knowledge","codebase","decision","report-asset"]],
 ["performance-optimization-v1","性能优化",["research-planner","codebase","experiment","cross-validation","report-asset"]],
 ["development-v1","需求开发",["requirements","codebase","solution","coding","cross-validation","report-asset"]],
 ["autoresearch-v1","Pi AutoResearch",["experiment"]],
 ];
 return presets.map(([id,name,steps])=>({id:`system-${id}`,name,description:"本地 Pi 编排；冻结上下文、按顺序执行、人工确认后导出。",version:1,system:true,nodes:[...steps.map((step,i)=>{const node=agents.find(a=>a.agentId===`opc-${step}-agent`)!;return {...node,id:`node-${i}-${step}`,parallel:step==="knowledge"&&steps[i-1]==="codebase"};}),{...agents.find(a=>a.kind==="approval")!,id:"approval"},{...agents.find(a=>a.kind==="export")!,id:"export"}]}));
}
