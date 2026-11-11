import { SkillLibraryPanel } from "./SkillLibrary.tsx";
import React, { useEffect, useRef, useState } from "react";
import type { OrchestrationNode as Node, OrchestrationTemplate as Template, OrchestrationSkill as Skill, ContextSection, FrozenOrchestration, OrchestrationRun, OrchestrationInput } from "../../src/orchestration-contract.ts";
import { OrchestrationOutput } from "./OrchestrationOutput.tsx";
import { RepositoryDiscoveryReport } from "./RepositoryDiscoveryReport.tsx";
import { AgentTrace } from "./AgentTrace.tsx";
import { reportMarkdown } from "./markdown.ts";
import { ResearchPipeline, type PipelineStage } from "./ResearchPipeline.tsx";
import "./orchestration.css";
type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
export const ORCHESTRATION_ENTRY_ENABLED = true;
const base = "/api/workbench/orchestration";
const send = (body: unknown, method = "POST"): RequestInit => ({ method, headers: {"content-type":"application/json"}, body: JSON.stringify(body) });
const newId = () => crypto.randomUUID?.() ?? "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0]! & 15 >> Number(c) / 4).toString(16));
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
type FlowDirection = "left" | "right" | "up" | "down";
function groupBounds(nodes: Node[], index: number) {
  let start = index;
  while (start > 0 && nodes[start]!.parallel) start--;
  let end = index;
  while (end + 1 < nodes.length && nodes[end + 1]!.parallel) end++;
  return { start, end };
}
export function OrchestrationFlow({ nodes, selected, select, results, insert, remove, clearSelection, canvas = false }: {
  nodes: Node[]; selected: number; select: (i: number) => void; results?: OrchestrationRun["nodes"];
  insert?: (i: number, direction: FlowDirection) => void; remove?: (i: number) => void; clearSelection?: () => void; canvas?: boolean;
}) {
  const editable = canvas || Boolean(insert);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{x: number; y: number; left: number; top: number; moved: boolean} | null>(null);
  const groups: number[][] = [];
  nodes.forEach((node, index) => { if(node.parallel && groups.length) groups.at(-1)!.push(index); else groups.push([index]); });
  const laneGap = editable ? 130 : 72;
  const lanes = groups.map(group => {
    let up = 0, down = 0;
    return group.map((index, lane) => lane === 0 ? 0 : editable && nodes[index]!.placement === "up" ? --up : ++down);
  });
  const above = Math.max(0, ...lanes.flatMap(group => group.map(lane => -lane)));
  const below = Math.max(0, ...lanes.flat());
  const baseline = editable ? 108 + above * laneGap : 24;
  const groupWidth = 200;
  const width = Math.max(1000, groups.length * groupWidth + 200);
  const height = editable ? Math.max(520, baseline + below * laneGap + 145) : Math.max(128, baseline + below * laneGap + 84);
  const center = editable ? 19 : 16;
  const changeZoom = (next: number) => setZoom(Math.max(.5, Math.min(1.5, Math.round(next * 10) / 10)));
  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const canvas = event.currentTarget;
    pan.current = {x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop, moved: false};
    canvas.setPointerCapture(event.pointerId);
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pan.current) return;
    const dx = event.clientX - pan.current.x, dy = event.clientY - pan.current.y;
    if (!pan.current.moved && Math.hypot(dx, dy) < 4) return;
    pan.current.moved = true;
    setPanning(true);
    event.currentTarget.scrollLeft = pan.current.left - dx;
    event.currentTarget.scrollTop = pan.current.top - dy;
  };
  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pan.current) return;
    if (!pan.current.moved) clearSelection?.();
    pan.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className={`oc-flow-frame ${editable ? "oc-edit-flow" : "oc-readonly-flow"}`}>{editable && <div className="oc-flow-tools" aria-label="画布缩放">
    <button type="button" aria-label="缩小画布" disabled={zoom <= .5} onClick={() => changeZoom(zoom - .1)}>−</button>
    <button type="button" aria-label="重置画布缩放" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button>
    <button type="button" aria-label="放大画布" disabled={zoom >= 1.5} onClick={() => changeZoom(zoom + .1)}>＋</button>
  </div>}<div className={`oc-flow-scroll ${panning ? "is-panning" : ""}`} onPointerDown={editable ? startPan : undefined} onPointerMove={editable ? movePan : undefined} onPointerUp={editable ? endPan : undefined} onPointerCancel={editable ? endPan : undefined}><div className="oc-flow-size" style={{width: editable ? width * zoom : "100%", minWidth: editable ? undefined : groups.length * 154, height: height * (editable ? zoom : 1)}}><div className="oc-flow" style={{width: editable ? width : "100%", height, transform: editable ? `scale(${zoom})` : undefined}}>{groups.map((group, g) => <div key={g} className="oc-group" style={{left: editable ? 100 + g * groupWidth : undefined, width: editable ? groupWidth : undefined, height}}>
    <div className="oc-mainline" style={{top: baseline + center}}/>
    {group.length > 1 && <svg className="oc-branches" width={editable ? groupWidth : "100%"} height={height} viewBox={`0 0 ${groupWidth} ${height}`} preserveAspectRatio="none" aria-hidden="true">{lanes[g]!.slice(1).map((offset, lane) => {
      const mainY = baseline + center, branchY = mainY + offset * laneGap;
      const radius = editable ? 12 : 9, left = editable ? 35 : 23, right = groupWidth - left;
      const cornerY = branchY > mainY ? branchY - radius : branchY + radius;
      return <path key={lane} d={`M ${left} ${mainY} V ${cornerY} Q ${left} ${branchY} ${left + radius} ${branchY} H ${right - radius} Q ${right} ${branchY} ${right} ${cornerY} V ${mainY}`}/>;
    })}</svg>}
    {group.map((i, lane) => {
      const node=nodes[i]!, result=results?.[node.id];
      const canParallel=group.every(index=>nodes[index]!.kind==="agent"&&nodes[index]!.readOnly);
      const top = baseline + lanes[g]![lane]! * laneGap;
      return <React.Fragment key={node.id}><button type="button" className={`oc-node ${selected===i?"selected":""} ${result?.status || ""}`} style={{top}} onClick={()=>select(i)} onKeyDown={event=>{if(remove&&(event.key==="Backspace"||event.key==="Delete")){event.preventDefault();remove(i);}}} aria-pressed={selected===i} title={node.name}>
        {result?.durationMs !== undefined && <span className="oc-duration">{Math.round(result.durationMs/1000)}s</span>}<span className="oc-circle">{result?.status==="completed"?"✓":result?.status==="blocked"?"!":i+1}</span><span>{node.name}</span><small>{node.kind==="approval"?"人工确认":node.kind==="export"?"资产化导出":node.agentId?"系统 Agent":"自定义 Agent"}</small></button>
        {insert&&selected===i&&<div className="oc-connectors" style={{top:top+19}} aria-label="连接新节点">
          {([ ["left","←","左侧添加顺序节点"], ["right","→","右侧添加顺序节点"], ["up","↑","上方添加并行节点"], ["down","↓","下方添加并行节点"] ] as const).map(([direction,arrow,label])=><button key={direction} type="button" className={`oc-direction oc-direction-${direction}`} aria-label={label} title={canParallel||direction==="left"||direction==="right"?label:"并行组仅支持不可写 Agent"} disabled={(direction==="up"||direction==="down")&&!canParallel} onClick={()=>insert(i,direction)}>{arrow}</button>)}
        </div>}
      </React.Fragment>;
    })}
  </div>)}</div></div></div></div>;
}
export function ContextPreview({ sections, title = "上下文预览" }: {sections: ContextSection[]; title?: string}) {
  const [full,setFull]=useState(false);
  return <div className="oc-context"><div className="oc-row"><h3>{title}</h3><button type="button" onClick={()=>setFull(!full)}>{full?"分段查看":"完整查看"}</button></div>{full?<pre>{sections.map(x=>`## ${x.title} · ${x.source}\n${x.content}`).join("\n\n")}</pre>:sections.map((s,i)=><details key={i} open={i===0}><summary>{s.title}<small>{s.source} · {s.content.length} 字符</small></summary><pre>{s.content}</pre></details>)}</div>;
}
export function SkillPicker({skills, value, change, disabled=false}: {skills: Skill[];value:string[];change:(ids:string[])=>void;disabled?:boolean}) {
  const [query,setQuery]=useState("");
  return <div><input aria-label="搜索 Skills" placeholder="搜索名称或说明" value={query} onChange={e=>setQuery(e.target.value)}/>{skills.filter(s=>(s.name+s.description).toLowerCase().includes(query.toLowerCase())).map(s=><label className="oc-skill" key={s.id}><input type="checkbox" disabled={disabled} checked={value.includes(s.id)} onChange={e=>change(e.target.checked?[...value,s.id]:value.filter(id=>id!==s.id))}/><span><strong>{s.name}</strong><small>{s.description}</small></span></label>)}{!skills.length&&<p className="muted">本机暂无可用 Skills，请先在本地运行时登记目录。</p>}</div>;
}
export function RuntimeSkills({request}: {request:Api}) { return <SkillLibraryPanel request={request}/>; }

export function OrchestrationPage({request,navigate}: {request:Api;navigate:(path:string)=>void}) {
  const [templates,setTemplates]=useState<Template[]>([]),[agents,setAgents]=useState<Node[]>([]),[skills,setSkills]=useState<Skill[]>([]),[draft,setDraft]=useState<Template>(),[selected,setSelected]=useState(0),[tab,setTab]=useState("prompt"),[dirty,setDirty]=useState(false),[error,setError]=useState(""),[busy,setBusy]=useState(false),[adding,setAdding]=useState<{index:number;direction:FlowDirection}>(),[runs,setRuns]=useState<OrchestrationRun[]>([]);
  async function load(){try{const result=await request<{templates:Template[];agents:Node[];skills:Skill[]}>(`${base}/catalog`);setTemplates(result.templates);setAgents(result.agents);setSkills(result.skills);setDraft(current=>current??result.templates[0]);setRuns(await request<OrchestrationRun[]>(`${base}/runs`));}catch(e){setError(message(e));}}
  useEffect(()=>{void load();},[]);
  const node=draft?.nodes[selected];
  function editNode(patch:Partial<Node>){if(!draft||draft.system||!node)return;setDraft({...draft,nodes:draft.nodes.map((n,i)=>i===selected?{...n,...patch}:n)});setDirty(true);}
  function choose(t:Template){if(dirty&&!window.confirm("放弃当前未保存修改？"))return;setDraft(structuredClone(t));setSelected(0);setDirty(false);setError("");}
  function create(copy=false){if(dirty&&!window.confirm("放弃当前未保存修改？"))return;setDraft({id:newId(),name:copy?`${draft?.name} · 副本`:"新编排",description:"",version:0,system:false,nodes:copy&&draft?structuredClone(draft.nodes):[{id:newId(),name:"自定义 Agent",prompt:"请基于任务要求完成研究，并输出结论、证据和未决问题。",skillIds:[],readOnly:true,kind:"agent",parallel:false}]});setSelected(0);setDirty(true);}
  async function save(){if(!draft)return;setBusy(true);setError("");try{const saved=await request<Template>(`${base}/templates`,send(draft));setDraft(saved);setDirty(false);await load();}catch(e){setError(message(e));}finally{setBusy(false);}}
  function remove(index:number){if(!draft||draft.system)return;if(draft.nodes.length<2){setError("至少保留一个节点");return;}const nodes=[...draft.nodes];const removedId=nodes[index]!.id;const wasGroupStart=!nodes[index]!.parallel;nodes.splice(index,1);if(wasGroupStart&&nodes[index]?.parallel)nodes[index]={...nodes[index]!,parallel:false};nodes[0]={...nodes[0]!,parallel:false};setDraft({...draft,nodes:nodes.map(item=>({...item,actions:item.actions?.filter(action=>action.targetNodeId!==removedId)}))});setSelected(Math.min(index,nodes.length-1));setDirty(true);setError("");}
  function add(n:Node){if(!draft||!adding)return;const {index,direction}=adding;const bounds=groupBounds(draft.nodes,index);const parallel=direction==="up"||direction==="down";if(parallel&&(!n.readOnly||n.kind!=="agent"||draft.nodes.slice(bounds.start,bounds.end+1).some(item=>item.kind!=="agent"||!item.readOnly))){setError("并行组仅支持不可写 Agent");return;}const nodes=[...draft.nodes];const at=direction==="left"?bounds.start:bounds.end+1;nodes.splice(at,0,{...n,id:newId(),parallel,placement:direction==="up"?"up":undefined});setDraft({...draft,nodes});setSelected(at);setAdding(undefined);setDirty(true);setError("");}
  function move(direction:-1|1){if(!draft||draft.system)return;const nodes=draft.nodes;const current=groupBounds(nodes,selected);const adjacentIndex=direction<0?current.start-1:current.end+1;if(adjacentIndex<0||adjacentIndex>=nodes.length)return;const adjacent=groupBounds(nodes,adjacentIndex);const currentGroup=nodes.slice(current.start,current.end+1);const adjacentGroup=nodes.slice(adjacent.start,adjacent.end+1);const start=Math.min(current.start,adjacent.start);const next=[...nodes];next.splice(start,currentGroup.length+adjacentGroup.length,...(direction<0?currentGroup.concat(adjacentGroup):adjacentGroup.concat(currentGroup)));setDraft({...draft,nodes:next});setSelected(start+(direction<0?selected-current.start:adjacentGroup.length+selected-current.start));setDirty(true);}
  return <main className="main oc-page">
    <div className="oc-row oc-heading"><div><h1>任务编排</h1><p className="muted">选择节点后，从四周的箭头连接新节点；上、下方向添加并行 Agent。</p></div><button className="primary" onClick={()=>create()}>＋ 新建编排</button></div>
    {error&&<p className="oc-error" role="alert">{error}</p>}
    {!draft?<p>正在加载编排…</p>:<div className="oc-studio">
      <nav className="oc-templates" aria-label="编排模板">{templates.map(t=><button key={t.id} className={t.id===draft.id?"selected":""} onClick={()=>choose(t)}>{t.name}<small>{t.system?"系统模板 · 只读":`自定义 · v${t.version}`}</small></button>)}</nav>
      <section className="oc-canvas">
        <div className="oc-row"><div>{draft.system?<h2>{draft.name}</h2>:<input aria-label="编排名称" value={draft.name} onChange={e=>{setDraft({...draft,name:e.target.value});setDirty(true);}} />}<small>{draft.nodes.length} 个节点 · {dirty?"未保存修改":`v${draft.version}`}</small></div><div className="oc-actions"><button onClick={()=>create(true)}>复制为新编排</button>{!draft.system&&<button disabled={busy||!dirty} onClick={()=>void save()}>保存</button>}<button className="primary" disabled={dirty} onClick={()=>navigate(`/orchestration/new/${draft.id}/`)}>使用模板</button></div></div>
        <OrchestrationFlow nodes={draft.nodes} selected={selected} select={setSelected} clearSelection={()=>setSelected(-1)} canvas insert={draft.system?undefined:(index,direction)=>setAdding({index,direction})} remove={draft.system?undefined:remove}/>
      </section>
      {node&&<section className="oc-editor" aria-label="节点配置">
        <div className="oc-editor-head"><div><h2>{node.name}</h2><p>{draft.id==="system-autoresearch-v1"?"使用 Pi OPC Workbench 原生循环执行实验；创建时须选择已登记的 Git 仓库。":draft.system?"系统模板使用同一 Pi 编排执行器。复制后可调整节点、Skills 和提示词。":"自定义编排按节点顺序执行，并行组完成后汇合。任务会冻结本次配置；后续修改模板不影响已有任务。"}</p></div><div className="oc-editor-head-actions"><span className="oc-tag">{node.kind==="approval"?"人工确认":node.kind==="export"?"资产化导出":node.agentId?"系统 Agent · 定义只读":"自定义 Agent"}</span>{node.agentId&&node.kind==="agent"&&!draft.system&&<button onClick={()=>editNode({agentId:undefined,baseAgentId:node.agentId,name:node.name+" · 副本"})}>复制为自定义 Agent</button>}</div></div>
        <div className="oc-tabs">{[["prompt","提示词"],["skills","Skills"],["actions","节点交互"],["context","上下文"]].map(([key,label])=><button key={key} className={tab===key?"selected":""} onClick={()=>setTab(key!)}>{label}</button>)}</div>
        <div className="oc-editor-content">{tab==="prompt"?<><label>名称<input value={node.name} disabled={draft.system||!!node.agentId} onChange={e=>editNode({name:e.target.value})}/></label><label>Agent 提示词<textarea rows={13} value={node.prompt} readOnly={draft.system||!!node.agentId||node.kind!=="agent"} onChange={e=>editNode({prompt:e.target.value})}/></label>{node.kind==="agent"&&<label className="oc-check"><input type="checkbox" disabled={draft.system||!!node.agentId||!!node.baseAgentId&&!!agents.find(agent=>agent.agentId===node.baseAgentId)?.readOnly} checked={node.readOnly} onChange={e=>editNode({readOnly:e.target.checked,capabilities:e.target.checked?(node.capabilities??[]).filter(capability=>!["repository.write","repository.commit","test.execute"].includes(capability)):[...new Set([...(node.capabilities??[]),"repository.read","repository.write","repository.commit","test.execute"])] as Node["capabilities"]})}/>不提供 edit/write 工具</label>}<small>系统 Agent 定义不可修改；工具限制不构成操作系统隔离。</small></>:tab==="skills"?<SkillPicker skills={skills} value={node.skillIds} change={skillIds=>editNode({skillIds})} disabled={draft.system||node.kind!=="agent"}/>:tab==="actions"?<div className="oc-action-editor"><p>运行前可收集用户补充指令；产物后可由用户选择已连接的节点。</p>{node.kind==="agent"&&<><label className="oc-check"><input type="checkbox" disabled={draft.system||!node.interactions?.some(item=>item.id==="before-run-input")} checked={node.enabledInteractions?.includes("before-run-input")??false} onChange={e=>editNode({enabledInteractions:e.target.checked?[...(node.enabledInteractions??[]),"before-run-input"]:(node.enabledInteractions??[]).filter(id=>id!=="before-run-input")})}/>启用运行前输入</label><label className="oc-check"><input type="checkbox" disabled={draft.system} checked={node.enabledInteractions?.includes("after-result-route")??false} onChange={e=>editNode({enabledInteractions:e.target.checked?[...(node.enabledInteractions??[]),"after-result-route"]:(node.enabledInteractions??[]).filter(id=>id!=="after-result-route"),actions:e.target.checked?node.actions:[]})}/>启用产物后人工选择</label>{node.enabledInteractions?.includes("after-result-route")&&<>{(node.actions??[]).map((action,index)=><div className="oc-action-row" key={action.id}><input aria-label={`动作 ${index+1} 名称`} value={action.label} disabled={draft.system} onChange={e=>editNode({actions:node.actions?.map(item=>item.id===action.id?{...item,label:e.target.value}:item)})}/><select aria-label={`动作 ${index+1} 目标`} value={action.targetNodeId} disabled={draft.system} onChange={e=>editNode({actions:node.actions?.map(item=>item.id===action.id?{...item,targetNodeId:e.target.value}:item)})}>{draft.nodes.map(target=><option key={target.id} value={target.id}>{target.name}</option>)}</select><button disabled={draft.system} onClick={()=>editNode({actions:node.actions?.filter(item=>item.id!==action.id)})}>移除</button></div>)}<button disabled={draft.system||draft.nodes.length<2} onClick={()=>editNode({actions:[...(node.actions??[]),{id:newId(),kind:"goto",label:"继续到下一节点",targetNodeId:draft.nodes[Math.min(selected+1,draft.nodes.length-1)]!.id,interactionId:"after-result-route"}]})}>添加连接</button></>}</>}</div>:<ContextPreview sections={[{title:"Agent 指令",source:node.agentId?"系统定义":"自定义",content:node.prompt},{title:"Skills",source:"节点配置",content:node.skillIds.map(id=>{const skill=skills.find(s=>s.id===id);return skill?`${skill.name} · ${skill.description}（按需读取 SKILL.md）`:"Skill 不可用";}).join("\n\n")||"未选择"},{title:"任务与前序产物",source:"执行时注入",content:"创建任务时预览需求、仓库与补充指令；前序产物在执行时注入。"}]}/>}</div>
        {!draft.system&&<p className="oc-keyboard-hint">选中画布节点后按 Backspace 删除。</p>}
      </section>}
    </div>}
    {!!runs.length&&<section className="oc-card oc-recent"><h2>编排任务</h2>{runs.map(run=><button key={run.id} onClick={()=>navigate(`/orchestration/runs/${run.id}/`)}>{run.title}<small>{run.status} · {new Date(run.createdAt).toLocaleString()}</small></button>)}</section>}
    {adding&&<div className="oc-overlay"><section className="oc-dialog" role="dialog" aria-modal="true" aria-label="添加 Agent"><div className="oc-row"><h2>{adding.direction==="up"||adding.direction==="down"?"添加并行 Agent":"连接新节点"}</h2><button onClick={()=>setAdding(undefined)}>关闭</button></div><p>{adding.direction==="up"||adding.direction==="down"?"并行节点仅支持不可写 Agent。":"选择系统 Agent，或创建自定义节点。"}</p>{agents.filter(agent=>(adding.direction==="left"||adding.direction==="right")||(agent.kind==="agent"&&agent.readOnly)).map(agent=><button className="oc-agent-choice" key={agent.id} onClick={()=>add(agent)}>＋ {agent.name}</button>)}<div className="oc-actions">{(adding.direction==="left"||adding.direction==="right")&&<button onClick={()=>add({id:"",name:"人工确认",prompt:"",skillIds:[],readOnly:true,kind:"approval",parallel:false})}>人工确认</button>}<button className="primary" onClick={()=>add({id:"",name:"自定义 Agent",prompt:"根据任务上下文执行研究，输出结论与证据。",skillIds:[],readOnly:true,kind:"agent",parallel:false})}>自定义 Agent</button></div></section></div>}
  </main>;
}
export function NewOrchestrationRun({request,navigate,templateId,initialInput}: {request:Api;navigate:(path:string)=>void;templateId?:string;initialInput?:OrchestrationInput}) {
  const [templates,setTemplates]=useState<Template[]>([]),[skills,setSkills]=useState<Skill[]>([]),[repos,setRepos]=useState<Array<{id:string;name:string;path:string;available:boolean}>>([]);
  const [chosen,setChosen]=useState(initialInput?.templateId||templateId||""),[title,setTitle]=useState(initialInput?.title||""),[description,setDescription]=useState(initialInput?.description||""),[supplement,setSupplement]=useState(initialInput?.supplement||""),[skillIds,setSkillIds]=useState<string[]>(initialInput?.skillIds||[]),[repositoryIds,setRepositoryIds]=useState<string[]>(initialInput?.repositoryIds||[]),[selected,setSelected]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [preview,setPreview]=useState<{frozen:FrozenOrchestration;sections:Array<{nodeId:string;sections:ContextSection[]}>}>();
  useEffect(()=>{void Promise.all([request<{templates:Template[];skills:Skill[]}>(`${base}/catalog`),request<typeof repos>("/api/workbench/runtime/repositories")]).then(([catalog,repositories])=>{const available=catalog.templates.filter(t=>!t.system||!t.id.startsWith("system-sdlc-"));setTemplates(available);setSkills(catalog.skills);setRepos(repositories);setChosen(current=>current||available.find(t=>t.id==="system-general-research-v1")?.id||available[0]?.id||"");}).catch(e=>setError(message(e)));},[]);
  const template=templates.find(t=>t.id===chosen);
  const input={templateId:chosen,templateVersion:template?.version,title,description,skillIds,repositoryIds,supplement};
  const signature=JSON.stringify(input);
  const [previewSignature,setPreviewSignature]=useState("");
  const stale=signature!==previewSignature;
  async function prepare(){setBusy(true);setError("");try{const result=await request<NonNullable<typeof preview>>(`${base}/preview`,send(input));setPreview(result);setPreviewSignature(signature);}catch(e){setError(message(e));}finally{setBusy(false);}}
  async function create(){if(!preview||stale)return;setBusy(true);setError("");try{const run=await request<OrchestrationRun>(`${base}/runs`,send({...input,contextHash:preview.frozen.hash}));navigate(`/orchestration/runs/${run.id}/`);}catch(e){setError(message(e));setBusy(false);}}
  return <section className="oc-page oc-create"><div className="oc-row"><h2>使用编排模板</h2><button onClick={()=>navigate("/orchestration/")}>管理编排</button></div>{error&&<p role="alert" className="oc-error">{error}</p>}{!templates.length?<p>还没有可用编排，请先创建模板。</p>:<><section className="oc-card"><label>编排模板<select value={chosen} onChange={e=>{setChosen(e.target.value);setSelected(0);}}>{templates.map(t=><option key={t.id} value={t.id}>{t.name} · v{t.version}</option>)}</select></label><label>任务标题<input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label><label>需求或问题<textarea rows={4} value={description} maxLength={20000} onChange={e=>setDescription(e.target.value)}/></label><h3>本机仓库</h3><p className="muted">使用已登记仓库的 HEAD 创建任务独立 worktree，不复制未提交改动，不重新 clone。</p>{repos.filter(r=>r.available).map(repo=><label className="oc-check" key={repo.id}><input type="checkbox" checked={repositoryIds.includes(repo.id)} onChange={e=>setRepositoryIds(e.target.checked?[...repositoryIds,repo.id]:repositoryIds.filter(id=>id!==repo.id))}/>{repo.name}<small>{repo.path}</small></label>)}<details><summary>本次追加 Skills · {skillIds.length} 个</summary><p>应用到所有 Agent，人工确认节点不执行 Skills。</p><SkillPicker skills={skills} value={skillIds} change={setSkillIds}/></details><label>本次补充指令<textarea rows={2} value={supplement} maxLength={10000} onChange={e=>setSupplement(e.target.value)}/></label></section>
  <section className="oc-card"><div className="oc-row"><h2>上下文预览</h2><button disabled={busy||!title.trim()} onClick={()=>void prepare()}>{busy?"处理中…":"刷新预览"}</button></div>{stale&&preview&&<p className="oc-warning">表单已修改，请刷新预览后创建任务。</p>}{preview&&<><OrchestrationFlow nodes={preview.frozen.template.nodes} selected={selected} select={setSelected}/><ContextPreview sections={preview.sections[selected]?.sections||[]}/></>}{!preview&&<p className="muted">填写需求后刷新预览，逐个查看 Agent 提示词、Skills、仓库和前序产物占位。</p>}</section><div className="oc-row"><small>提交时冻结模板、提示词与 Skill 文件；使用任务创建人的个人模型。</small><button className="primary" disabled={busy||!preview||stale} onClick={()=>void create()}>创建并开始执行</button></div></>}</section>;
}
export function OrchestrationRunPage({request,id}: {request:Api;id:string}) {
  const [run,setRun]=useState<OrchestrationRun>(),[error,setError]=useState(""),[selected,setSelected]=useState(0),[busy,setBusy]=useState(false),[tab,setTab]=useState("trace");
  const [chatText,setChatText]=useState(""),[chatBusy,setChatBusy]=useState(false);
  const [section,setSection]=useState<"root"|"pipeline">("pipeline");
  const [promptOpen,setPromptOpen]=useState(false),[supplementalPrompt,setSupplementalPrompt]=useState("");
  const [actionComment,setActionComment]=useState("");
  const [beforeRunInputs,setBeforeRunInputs]=useState<Record<string,string>>({});
  useEffect(()=>{let disposed=false,initial=true;setRun(undefined);setSelected(0);const poll=async()=>{try{const next=await request<OrchestrationRun>(`${base}/runs/${id}`);if(disposed)return;setRun(next);if(initial){const index=Math.max(0,next.frozen.template.nodes.findIndex(node=>["review","running","blocked"].includes(next.nodes[node.id]!.status)));setSelected(index);setTab(next.frozen.template.nodes[index]?.kind==="agent"?"trace":"context");initial=false;}}catch(e){if(!disposed)setError(message(e));}};void poll();const timer=setInterval(()=>void poll(),3000);return()=>{disposed=true;clearInterval(timer);};},[id]);
  async function control(action:string,extra:Record<string,unknown>={}){setBusy(true);setError("");try{setRun(await request<OrchestrationRun>(`${base}/runs/${id}/control`,send({action,...extra})));setPromptOpen(false);setSupplementalPrompt("");}catch(e){setError(message(e));}finally{setBusy(false);}}
  async function sendMessage(nodeId:string){if(!chatText.trim())return;setChatBusy(true);setError("");try{setRun(await request<OrchestrationRun>(`${base}/runs/${id}/messages`,send({nodeId,text:chatText.trim()})));}catch(e){setError(message(e));}finally{setChatText("");setChatBusy(false);}}
  async function asChat(messageId:string){setChatBusy(true);setError("");try{setRun(await request<OrchestrationRun>(`${base}/runs/${id}/messages/${messageId}/as-chat`,send({})));}catch(e){setError(message(e));}finally{setChatBusy(false);}}
  if(!run)return <main className="main oc-page">{error||"正在加载编排任务…"}</main>;
  const node=run.frozen.template.nodes[selected]!,result=run.nodes[node.id]!;
  const statuses:Record<string,string>={RUNNING:"执行中",PAUSED:"已暂停",BLOCKED:"已阻塞",REVIEW_REQUIRED:"待人工确认",COMPLETED:"已完成",CANCELLED:"已取消"};
  const pipelineStages: PipelineStage[] = run.frozen.template.nodes.map(item => {
    const itemResult = run.nodes[item.id];
    const state = itemResult?.status;
    return {id:item.id,label:item.name,parallel:item.parallel,durationMs:itemResult?.durationMs,
      status:state==="completed"?"complete":state==="skipped"?"skipped":state==="running"||state==="review"?"active":state==="blocked"?"blocked":"waiting",
      gate:item.kind==="approval",progressLabel:itemResult?.nativeAutoresearch?.progressLabel ?? (state==="review"?"待人工确认":undefined)};
  });
  const nodeActionAllowed=!busy&&["PAUSED","BLOCKED","CANCELLED","REVIEW_REQUIRED"].includes(run.status)&&node.kind==="agent";
  const approvalActionAllowed=!busy&&run.status==="REVIEW_REQUIRED"&&node.kind==="approval"&&result.status==="review"&&Boolean(result.digest);
  const beforeRunInteraction=node.interactions?.find(item=>item.id===result.preRunInteractionId&&item.timing==="before-run");
  const beforeRunAllowed=!busy&&run.status==="REVIEW_REQUIRED"&&node.kind==="agent"&&result.status==="review"&&Boolean(beforeRunInteraction)&&Boolean(result.digest);
  const routeActionAllowed=!busy&&run.status==="REVIEW_REQUIRED"&&node.kind==="agent"&&result.status==="review"&&!result.preRunInteractionId&&Boolean(result.digest);
  const approvalContinuesToExport=run.frozen.template.nodes[selected+1]?.kind==="export";
  const pipelineActions = <div className="sdlc-pipeline-actions" role="group" aria-label="整个任务操作">
    <button className="pause-action" disabled={busy||run.status!=="RUNNING"} onClick={()=>void control("pause")}>暂停执行</button>
    <button className="retry-action" disabled={busy||!["PAUSED","BLOCKED","CANCELLED"].includes(run.status)} onClick={()=>void control("resume")}>继续执行</button>
    <button className="skip-action" disabled={busy||["CANCELLED","COMPLETED"].includes(run.status)} onClick={()=>{if(confirm("取消此编排任务？已完成的产物保留。"))void control("cancel");}}>取消任务</button>
  </div>;
  return <main className="main research-run sdlc-page oc-run">
    <div className="breadcrumb">本地项目 / {run.id}</div>
    <div className="title-row sdlc-title-row"><h1>{run.title}</h1><nav className="sdlc-section-tabs" aria-label="任务页面">
      <button type="button" className={section==="root"?"active":""} aria-current={section==="root"?"page":undefined} onClick={()=>setSection("root")}>Root Issue</button>
      <button type="button" className={section==="pipeline"?"active":""} aria-current={section==="pipeline"?"page":undefined} onClick={()=>setSection("pipeline")}>流水线</button>
    </nav></div>
    {error&&<p role="alert" className="oc-error">{error}</p>}
    {run.status==="BLOCKED"?<section className="sdlc-blocker" role="alert"><strong>当前阻断原因</strong>
      <p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{run.error?.trim()||run.frozen.template.nodes
        .filter(item=>run.nodes[item.id]?.status==="blocked"&&run.nodes[item.id]?.error?.trim())
        .map(item=>`${item.name}：${run.nodes[item.id]!.error}`).join("\n")||"任务已阻塞，未提供详细原因。请查看执行详情或活动记录。"}</p>
    </section>:run.error&&<p className="oc-error">{run.error}</p>}
    {section==="root"?<>
      <details className="root-issue" open><summary><div><b>Root Issue</b><em>{run.frozen.template.name}</em>
        <span>创建人　<strong>{run.owner}</strong></span><span>创建时间　<strong>{run.createdAt}</strong></span>
        <span>模板　<strong>{run.frozen.template.name} · v{run.frozen.template.version}</strong></span></div>
        <mark><span className="expand-label">点击展开</span><span className="collapse-label">点击收起</span></mark></summary>
        <div className="root-body"><section className="root-row"><b>需求描述</b><div className="description markdown-content" dangerouslySetInnerHTML={{__html:reportMarkdown(run.frozen.input.description||"未填写需求描述")}}/></section>
          <section className="root-row"><b>代码仓库</b><div>{run.frozen.repositories.length?run.frozen.repositories.map(repo=><p key={repo.id}><strong>{repo.name}</strong><br/><code>{repo.path}</code></p>):"创建时未指定"}</div></section>
          {run.repositoryPreparation&&<section className="root-row"><b>仓库准备结果</b><div><p>{run.repositoryPreparation.summary}</p>{run.repositoryBindings?.map(repo=><p key={repo.id}><strong>{repo.name}</strong> · 已就绪 · {repo.role==="main"?"主仓库":repo.role==="dependency"?"依赖":"上下文"}<br/><code>{repo.path}</code><br/>起始提交：<code>{repo.baseCommit}</code></p>)}{run.repositoryPreparation.records.filter(repo=>repo.status==="unavailable").map((repo,index)=><p key={index}><strong>{repo.url||"候选仓库"}</strong> · 未就绪<br/>{repo.reason}</p>)}{run.repositoryPreparation.gaps.length>0&&<p>缺口：{run.repositoryPreparation.gaps.join("；")}</p>}<p>初始冻结输入保持不变；下游使用已校验的仓库准备结果。</p></div></section>}
          <section className="root-row"><b>补充指令</b><div className="description markdown-content" dangerouslySetInnerHTML={{__html:reportMarkdown(run.frozen.input.supplement||"未填写补充指令")}}/></section>
          <section className="root-row"><b>执行上下文</b><div><p>模型：{run.model}</p><p>本次追加 Skills：{run.frozen.skills.filter(skill=>run.frozen.input.skillIds.includes(skill.id)).map(skill=>skill.name).join("、")||"无"}</p><p>需求与模板按创建时版本冻结；各节点的提示词和 Skills 可在流水线的冻结上下文中查看。</p></div></section>
        </div></details>
      <section className="panel sdlc-root-information"><h2>运行信息</h2><div className="detail-grid"><section><h3>任务</h3><p>ID：<code>{run.id}</code></p><p>发起人：{run.owner}</p><p>状态：{statuses[run.status]}</p><p>创建于：{run.createdAt}</p><p>更新于：{run.updatedAt}</p></section><section><h3>执行环境</h3><p>模型：{run.model}</p><p>工作目录：<code>{run.cwd}</code></p><p>模板：{run.frozen.template.name} · v{run.frozen.template.version}</p></section></div></section>
    </>:<>
    <ResearchPipeline title={`${run.frozen.template.name} 执行流水线`} stages={pipelineStages} selected={node.id} compactSlots draggable
      onSelect={nodeId=>{setSelected(run.frozen.template.nodes.findIndex(item=>item.id===nodeId));setTab(run.frozen.template.nodes.find(item=>item.id===nodeId)?.kind==="agent"?"trace":"context");setPromptOpen(false);setChatText("");}}
      status={run.status} statusLabel={statuses[run.status]!} paused={run.status==="PAUSED"}
      executorActive={run.status==="RUNNING"} actions={pipelineActions}
      metadata={<>{run.frozen.template.name} · v{run.frozen.template.version}　·　更新于 {run.updatedAt}</>} />
    <section className="panel details sdlc-details oc-run-details">
      <div className="oc-run-node-heading"><h2>{node.name}</h2></div>
      <nav>
        <div className="sdlc-nav-tabs">{node.kind==="agent"&&<button className={tab==="trace"?"active":""} onClick={()=>setTab("trace")}>执行详情</button>}<button className={tab==="context"?"active":""} onClick={()=>setTab("context")}>冻结上下文</button></div>
        <div className="sdlc-toolbar" aria-label="当前节点操作"><div className="sdlc-toolbar-group" role="group" aria-label="当前节点操作">
          <span className="sdlc-toolbar-label">当前节点</span>
          {node.kind==="agent"?<>
            <button className="prompt-action" disabled={!nodeActionAllowed} onClick={()=>{setSupplementalPrompt("");setPromptOpen(true);}}>补充 Prompt</button>
            <button className="retry-action" disabled={!nodeActionAllowed} onClick={()=>{if(confirm(`重新执行「${node.name}」？该节点后续产物将失效。`))void control("retry",{nodeId:node.id});}}>重新执行</button>
            <button className="skip-action" disabled={!nodeActionAllowed||!node.readOnly} title={node.readOnly?"跳过当前节点并重新生成后续产物":"可写节点不能跳过"} onClick={()=>{if(confirm(`跳过「${node.name}」？该节点后续产物将失效。`))void control("skip",{nodeId:node.id});}}>跳过节点</button>
          </>:node.kind==="approval"?<button className="primary" disabled={!approvalActionAllowed}
            title={result.status==="review"?"确认当前冻结的完整材料，并放行后续节点":result.status==="completed"?"当前材料已批准":"等待前序节点生成完整审批材料"}
            onClick={()=>{if(confirm("确认当前展示的完整前序材料，并继续后续节点？"))void control("approve",{digest:result.digest});}}>
            {busy?"批准中…":result.status==="completed"?"已批准":approvalContinuesToExport?"批准并导出":"批准并继续"}
          </button>:<span className="muted">资产化导出由流水线自动执行</span>}
        </div></div>
      </nav>
      {promptOpen&&<form className="oc-node-prompt" onSubmit={event=>{event.preventDefault();void control("continue",{nodeId:node.id,supplementalPrompt});}}>
        <label htmlFor="oc-supplemental-prompt">补充当前节点指令</label>
        <p>保留当前节点的已有执行记录；后续节点会根据新结果重新执行。</p>
        <textarea id="oc-supplemental-prompt" autoFocus rows={4} maxLength={20000} value={supplementalPrompt} onChange={event=>setSupplementalPrompt(event.target.value)}/>
        <div className="oc-row"><small>{supplementalPrompt.length.toLocaleString()} / 20,000</small><div className="oc-actions"><button type="button" onClick={()=>setPromptOpen(false)}>取消</button><button className="primary" disabled={busy||!supplementalPrompt.trim()}>补充并继续</button></div></div>
      </form>}
      <div className="detail-body">
      {tab==="trace"&&node.kind==="agent"?<AgentTrace key={`${id}:${node.id}`} stageId={node.id} active={result.status==="running"} load={request}
        baseUrl={`${base}/runs/${encodeURIComponent(id)}/trace?stageId=${encodeURIComponent(node.id)}&limit=100`}
        messages={(run.messages??[]).filter(item=>item.nodeId===node.id).map(item=>({ ...item,
          ...(run.status==="PAUSED"&&item.status==="waiting"?{paused:true,...(!busy?{onResume:()=>void control("resume")}:{} )}:{}),
          ...(item.status==="undelivered"&&(["COMPLETED","CANCELLED"].includes(run.status)||result.status==="completed")&&!chatBusy
            ? { onAsChat: ()=>void asChat(item.id) } : {}) }))}
        footer={<form className="oc-chat-composer" onSubmit={event=>{event.preventDefault();void sendMessage(node.id);}}><label htmlFor="oc-chat-input">发送给「{node.name}」</label>
          <textarea id="oc-chat-input" rows={1} maxLength={20000} value={chatText} onChange={event=>{setChatText(event.target.value);event.currentTarget.style.height="auto";event.currentTarget.style.height=`${Math.min(event.currentTarget.scrollHeight,160)}px`;}} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void sendMessage(node.id);}}} placeholder="给当前节点补充指令或提问；Enter 发送，Shift+Enter 换行"/>
          <button className="primary" disabled={chatBusy||!chatText.trim()}>发送</button>
        </form>}/>
        :<ContextPreview sections={result.sections||[{title:"Agent 提示词",source:"创建时冻结",content:node.prompt},{title:"前序材料",source:"执行时注入",content:"节点尚未执行，实际上下文将在执行时记录。"}]}/>}

      </div>
    </section>
    <section className="panel sdlc-results"><div className="sdlc-detail">
      <header><h2>产物结果 · {node.name}</h2><div className="oc-result-actions"><span>{result.status==="completed"?"已完成":result.status==="running"?"执行中":result.status==="review"?"待人工确认":result.status==="blocked"?"已阻塞":result.status==="skipped"?"已跳过":"未开始"}</span></div></header>
      {result.error&&<p className="oc-error">{result.error}</p>}
      {result.agentStatus==="DEGRADED"&&!!result.gaps?.length&&<div className="oc-warning"><strong>Agent 产物待补证</strong><ul>{result.gaps.map((gap,index)=><li key={index}>{gap}</li>)}</ul></div>}
      {result.output?(run.repositoryPreparation?.nodeId===node.id&&result.output.startsWith("# Runtime 仓库准备交接")
        ?<RepositoryDiscoveryReport preparation={run.repositoryPreparation} output={result.output}/>
        :<OrchestrationOutput output={result.output}/>):<p className="muted">{beforeRunAllowed?"请确认运行前输入后开始执行。":result.status==="running"?"Agent 正在执行，完成后展示结果。":result.status==="skipped"?"节点已跳过。":"节点尚未产生结果。"}</p>}
      {beforeRunAllowed&&beforeRunInteraction&&<form className="oc-route-decision" onSubmit={event=>{event.preventDefault();void control("submit-before-run",{nodeId:node.id,digest:result.digest,inputs:beforeRunInputs});}}>
        {beforeRunInteraction.fields.map(field=><label key={field.id}>{field.id}{field.type==="select"?<select required={field.required} value={beforeRunInputs[field.id]??""} onChange={event=>setBeforeRunInputs({...beforeRunInputs,[field.id]:event.target.value})}><option value="">请选择</option>{field.options?.map(option=><option key={option} value={option}>{option}</option>)}</select>:field.type==="textarea"?<textarea rows={3} maxLength={20000} required={field.required} value={beforeRunInputs[field.id]??""} onChange={event=>setBeforeRunInputs({...beforeRunInputs,[field.id]:event.target.value})}/>:<input maxLength={20000} required={field.required} value={beforeRunInputs[field.id]??""} onChange={event=>setBeforeRunInputs({...beforeRunInputs,[field.id]:event.target.value})}/>}</label>)}
        <button className="primary" disabled={busy}>确认并执行</button>
      </form>}
      {routeActionAllowed&&<div className="oc-route-decision"><label>补充说明（可选）<textarea rows={3} maxLength={20000} value={actionComment} onChange={event=>setActionComment(event.target.value)}/></label><div className="oc-actions">{(node.actions??[]).map(action=><button key={action.id} className="primary" disabled={busy} onClick={()=>{if(confirm(`选择「${action.label}」并前往「${run.frozen.template.nodes.find(item=>item.id===action.targetNodeId)?.name}」？`))void control("select-action",{nodeId:node.id,actionId:action.id,digest:result.digest,inputs:actionComment?{comment:actionComment}:{}});}}>{action.label}</button>)}</div></div>}
    </div></section>
    </>}
  </main>;
}
