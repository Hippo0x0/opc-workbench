import React, { useEffect, useState } from "react";
import type { ManagedSkill } from "../../src/skill-library.ts";
import type { OrchestrationNode } from "../../src/orchestration-contract.ts";
type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
const base = "/api/workbench/orchestration";
const send = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reason = (e: unknown) => e instanceof Error ? e.message : String(e);
function Selection({ skills, value, change }: { skills: ManagedSkill[]; value: string[]; change: (ids: string[]) => void }) {
  return <div className="oc-skill-grid">{skills.map(skill => <label className="oc-check" key={skill.id}><input type="checkbox" checked={value.includes(skill.id)} onChange={e => change(e.target.checked ? [...value, skill.id] : value.filter(id => id !== skill.id))}/><span>{skill.name}<small>{skill.description} · v{skill.version}</small></span></label>)}</div>;
}
export function TaskSkillPicker({ request, value, change }: { request: Api; value: string[]; change: (ids: string[]) => void }) {
  const [skills, setSkills] = useState<ManagedSkill[]>([]), [error, setError] = useState("");
  useEffect(() => { let alive = true; void request<ManagedSkill[]>(`${base}/skills`).then(rows => { if (alive) setSkills(rows); }).catch(e => { if (alive) setError(reason(e)); }); return () => { alive = false; }; }, [request]);
  return <section className="full"><h2>追加 Skills（可选）</h2><p className="muted">本次追加对所有节点可见，Agent 按需读取；创建后冻结版本。导入和默认绑定在「本地运行时 → Skills」管理。</p>{error && <p role="alert">{error}</p>}<Selection skills={skills} value={value} change={change}/>{!skills.length && !error && <p className="muted">尚未导入 Skill。</p>}</section>;
}
export function SkillLibraryPanel({ request }: { request: Api }) {
  const [skills, setSkills] = useState<ManagedSkill[]>([]), [agents, setAgents] = useState<OrchestrationNode[]>([]);
  const [location, setLocation] = useState(""), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [selected, setSelected] = useState<ManagedSkill>();
  const [agentId, setAgentId] = useState(""), [bindings, setBindings] = useState<string[]>([]);
  async function load() { const catalog = await request<{ skills: ManagedSkill[]; agents: OrchestrationNode[] }>(`${base}/catalog`); setSkills(catalog.skills); setAgents(catalog.agents); }
  useEffect(() => { void load().catch(e => setError(reason(e))); }, []);
  async function action(work: () => Promise<unknown>, message: string) { setBusy(true); setError(""); setNotice(""); try { await work(); await load(); setNotice(message); } catch (e) { setError(reason(e)); } finally { setBusy(false); } }
  async function importSkill(e: React.FormEvent) { e.preventDefault(); await action(() => request(`${base}/skills`, send({ path: location, ...(name.trim() ? { name: name.trim() } : {}) })), "Skill 已导入托管库，可在节点或任务中选择。"); }
  return <section className="oc-card"><div className="oc-row"><div><h2>Skill 库</h2><p className="muted">统一导入完整副本，原目录移动不影响已导入内容；更新只影响之后创建的任务。</p></div><button disabled={busy} onClick={() => void action(load, "已刷新")}>刷新</button></div>
    {error && <p role="alert" className="oc-error">{error}</p>}{notice && <p role="status" className="oc-success">{notice}</p>}
    <form onSubmit={importSkill} className="oc-register"><input aria-label="Skill 来源地址" required value={location} onChange={e => setLocation(e.target.value)} placeholder="包含 SKILL.md 的绝对目录"/><input aria-label="导入名称" value={name} onChange={e => setName(e.target.value)} placeholder="名称可选；重名时必须改名"/><button disabled={busy}>导入</button></form>
    <p className="muted">导入不会执行包内脚本，也不会授予额外工具权限。</p>
    <h3>Agent 默认 Skills</h3><p className="muted">修改仅影响新建任务；用户仍可在自定义节点中取消或替换默认选择。</p>
    <select aria-label="配置 Agent 默认 Skills" value={agentId} onChange={e => { setAgentId(e.target.value); setBindings(agents.find(agent => (agent.agentId ?? agent.id) === e.target.value)?.skillIds ?? []); }}><option value="">选择 Agent</option>{agents.filter(agent => agent.kind !== "approval").map(agent => <option key={agent.id} value={agent.agentId ?? agent.id}>{agent.name}</option>)}</select>
    {agentId && <><Selection skills={skills} value={bindings} change={setBindings}/><button disabled={busy} onClick={() => void action(() => request(`${base}/skills/agents`, send({ agentId, skillIds: bindings }, "PUT")), "Agent 默认 Skills 已保存")}>保存默认选择</button></>}
    <div className="oc-skill-grid">{skills.map(skill => <article key={skill.id}><h3>{skill.name} <small>v{skill.version}</small></h3><p>{skill.description}</p><p className="muted">{skill.source.path}</p><div className="oc-actions"><button onClick={() => setSelected(skill)}>查看说明</button><button disabled={busy} onClick={() => void action(() => request(`${base}/skills`, send({ id: skill.id }, "PUT")), "已更新；已有 Run 保持原版本")}>更新</button><button disabled={busy} onClick={() => { if (window.confirm(`删除「${skill.name}」的登记？仍被引用时会拒绝删除；已有 Run 不受影响。`)) void action(() => request(`${base}/skills?id=${encodeURIComponent(skill.id)}`, { method: "DELETE" }), "已删除登记"); }}>删除</button></div></article>)}</div>
    {selected && <div className="oc-overlay"><section className="oc-dialog" role="dialog" aria-modal="true" aria-label="Skill 说明"><div className="oc-row"><h2>{selected.name}</h2><button onClick={() => setSelected(undefined)}>关闭</button></div><pre>{selected.content}</pre></section></div>}
  </section>;
}
