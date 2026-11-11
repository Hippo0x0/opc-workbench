import { createOrchestrationCatalog,digest,object,textField } from "./orchestration-catalog.ts";
import type { OrchestrationTemplate } from "./orchestration-contract.ts";
export interface ChatTemplateDraft {
 operation:"create"|"update";template:OrchestrationTemplate;hash:string;
 sourceTemplateId?:string;sourceTemplateName?:string;sourceVersion?:number;savedTemplate?:{id:string;version:number};
}
export const COMPOSITION_PROMPT=`你可以通过对话生成或修改工作台编排。普通讨论直接返回 Markdown，不要强行生成编排。
当用户要求生成或修改编排时，先简要说明，然后输出唯一一个 opc-orchestration 代码块，内容是单一 JSON 对象：
{ "operation":"create 或 update", "sourceTemplateId":"修改或复制已有模板时的真实 ID，可省略", "template":{ "name":"模板名称", "description":"说明", "nodes":[节点完整配置] } }
节点格式：复用内置 Agent 时使用 {id,agentId,parallel,skillIds}；自定义或修改提示词时使用 {id,name,prompt,kind:"agent",readOnly,parallel,skillIds,baseAgentId?,capabilities?}，不能用 agentId 假装修改内置定义。人工确认使用 agentId:"system-approval"，本地导出使用 agentId:"system-export"。
模板列表中的内置节点仅压缩为引用，完整定义在 agents 中；根据真实定义还原和修改。不要猜测 Agent、Skill 或动作 ID；仅使用当前登记的能力。并行仅允许只读 Agent；导出必须紧邻人工确认之后。节点 ID 唯一，最多30个。
修改已保存的自定义模板使用 update，并引用 sourceTemplateId；系统模板保持只读，修改时生成 create 副本。对尚未保存的草案继续修改时，仍按原 create/update 意图返回完整模板。不要输出由服务器管理的模板 id、version、system。
草案由工作台校验并展示给用户，只有用户点击保存才写入模板。生成草案不能宣称已保存、已启动任务或已修改仓库。若草案校验失败，根据 currentDraftError 修正；保留用户未要求改动的配置。`;
export function compositionContext(catalog:ReturnType<typeof createOrchestrationCatalog>){
 return {agents:catalog.agents(),skills:catalog.skills().map(({id,name,description})=>({id,name,description})),
  templates:catalog.templates().map(template=>({...template,nodes:template.nodes.map(node=>node.agentId?{
   id:node.id,agentId:node.agentId,parallel:node.parallel,placement:node.placement,skillIds:node.skillIds,
   enabledInteractions:node.enabledInteractions,actions:node.actions,
  }:node)}))};
}
export function parseTemplateProposal(output:string,catalog:ReturnType<typeof createOrchestrationCatalog>,snapshot:OrchestrationTemplate[]):{text:string;draft?:ChatTemplateDraft;draftError?:string}{
 const blocks=[...output.matchAll(/^```opc-orchestration[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/gmu)];
 if(!blocks.length)return output.includes("```opc-orchestration")?{text:output.slice(0,output.indexOf("```opc-orchestration")).trim(),draftError:"编排草案不完整，请继续对话补全配置。"}:{text:output};
 const text=output.replace(/^```opc-orchestration[ \t]*\r?\n[\s\S]*?^```[ \t]*\r?$/gmu,"").trim()||"编排草案已生成，请查看配置。";
 try{
  if(blocks.length!==1)throw new Error("每条回复只能包含一个完整编排草案");
  const raw=object(JSON.parse(blocks[0]![1]!));
  if(raw.operation!=="create"&&raw.operation!=="update")throw new Error("编排操作必须为 create 或 update");
  const sourceId=raw.sourceTemplateId===undefined?undefined:textField(raw.sourceTemplateId,"来源模板",200);
  const source=sourceId?snapshot.find(template=>template.id===sourceId):undefined;
  if(sourceId&&!source)throw new Error("来源模板不存在，请使用当前登记的模板");
  if(raw.operation==="update"&&!source)throw new Error("修改已有编排需要指定来源模板");
  const operation:ChatTemplateDraft["operation"]=raw.operation==="update"&&source&&!source.system?"update":"create";
  const candidate=object(raw.template);
  if(Array.isArray(candidate.nodes))for(const value of candidate.nodes){
   const node=object(value),builtin=catalog.agents().find(agent=>agent.agentId===node.agentId);
   if(builtin&&node.prompt!==undefined&&node.prompt!==builtin.prompt)throw new Error("修改内置 Agent 提示词时请使用 baseAgentId 创建自定义副本");
  }
  const template=catalog.validate({...candidate,id:operation==="update"?source!.id:undefined});
  template.version=operation==="update"?source!.version:0;
  const material={operation,template,...(source?{sourceTemplateId:source.id,sourceTemplateName:source.name,sourceVersion:source.version}:{})};
  return {text,draft:{...material,hash:digest(JSON.stringify(material))}};
 }catch(error){return {text,draftError:`编排草案校验失败：${error instanceof Error?error.message:"格式无效"}。请继续对话修正。`};}
}
export function saveTemplateProposal(draft:ChatTemplateDraft,hash:unknown,catalog:ReturnType<typeof createOrchestrationCatalog>){
 const material={operation:draft.operation,template:draft.template,...(draft.sourceTemplateId?{sourceTemplateId:draft.sourceTemplateId,sourceTemplateName:draft.sourceTemplateName,sourceVersion:draft.sourceVersion}:{})};
 if(typeof hash!=="string"||hash!==draft.hash||digest(JSON.stringify(material))!==draft.hash)throw new Error("草案已变化，请重新查看完整草案后保存");
 if(draft.savedTemplate){const saved=catalog.templates().find(template=>template.id===draft.savedTemplate!.id);if(!saved)throw new Error("已保存模板已被删除，请重新生成草案");return saved;}
 if(draft.operation==="update"){
  const current=catalog.templates().find(template=>template.id===draft.sourceTemplateId);
  if(!current||current.system||current.version!==draft.sourceVersion)throw new Error("来源模板已变化，请继续对话重新生成草案");
 }
 const saved=catalog.save(draft.template);draft.savedTemplate={id:saved.id,version:saved.version};return saved;
}
