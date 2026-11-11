import { bootstrapSkillLibrary } from "./skill-library.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AFTER_RESULT_ROUTE, BEFORE_RUN_INPUT, AGENT_ACTIONS, LOCAL_AGENT_DEFINITION_VERSION, MARKDOWN_RESULT_SCHEMA_ID,
  assertRegisteredCapabilities, validateNodeActionBindings,
  type AgentActionBinding, type AgentCapability, type AgentInteractionDefinition } from "./agent-protocol.ts";

import type { OrchestrationSkill, OrchestrationNode, OrchestrationTemplate } from "./orchestration-contract.ts";
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}
export function textField(value: unknown, label: string, max: number, optional = false): string {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max) throw new Error(`${label}格式或长度无效`);
  return value.trim();
}
export function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20 || value.some(x => typeof x !== "string" || !/^[\w:.-]{1,200}$/u.test(x))) throw new Error("Skill 列表无效");
  return [...new Set(value as string[])];
}
export function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
export { systemAgents } from "./builtins.ts";
import { systemAgents, defaultTemplates } from "./builtins.ts";
function parseActions(value: unknown): AgentActionBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error("节点动作列表无效");
  return value.map(item => {
    const row = object(item);
    const id = textField(row.id, "动作 ID", 80);
    const kind = textField(row.kind, "动作类型", 80);
    if (!AGENT_ACTIONS.some(action => action === kind)) throw new Error(`未登记的节点动作：${kind}`);
    return { id, kind: kind as AgentActionBinding["kind"], label: textField(row.label, "动作名称", 80),
      targetNodeId: textField(row.targetNodeId, "动作目标", 80),
      interactionId: textField(row.interactionId, "交互 ID", 80) };
  });
}
function parseInteractions(value: unknown): AgentInteractionDefinition[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error("Agent 交互定义无效");
  return value.map(item => {
    const row = object(item);
    if (!Array.isArray(row.fields) || row.fields.length > 20 || !Array.isArray(row.actions) || row.actions.length > 20) {
      throw new Error("Agent 交互字段或动作无效");
    }
    return { id: textField(row.id, "交互 ID", 80), timing: row.timing as AgentInteractionDefinition["timing"],
      fields: row.fields.map(value => { const field = object(value); return {
        id: textField(field.id, "字段 ID", 80), type: field.type as AgentInteractionDefinition["fields"][number]["type"],
        required: field.required === true,
        ...(field.options === undefined ? {} : { options: Array.isArray(field.options) && field.options.length <= 20
          && field.options.every(option => typeof option === "string" && option.trim() && option.length <= 200)
          ? [...field.options] as string[] : (() => { throw new Error("交互选项无效"); })() }),
      }; }), actions: [...row.actions] as AgentInteractionDefinition["actions"] };
  });
}
export function createOrchestrationCatalog(root: string, home = os.homedir()) {
  const directory = path.join(root, ".orchestration");
  const templateFile = path.join(directory, "templates.json");
  const library = () => bootstrapSkillLibrary(root, home);
  const skills = () => library().list();
  function agents(): OrchestrationNode[] {
    return systemAgents.map(node=>({...node,skillIds:library().bindings()[node.agentId??node.id]??node.skillIds}));
  }
  function templates(): OrchestrationTemplate[] {
    return [...defaultTemplates(agents()),...readJson<OrchestrationTemplate[]>(templateFile,[])];
  }
  function validate(value: unknown): OrchestrationTemplate {
    const raw = object(value), builtin = agents();
    const id = raw.id === undefined ? randomUUID() : textField(raw.id, "模板 ID", 64);
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error("系统模板不可修改；请复制为自定义编排");
    if (!Array.isArray(raw.nodes) || !raw.nodes.length || raw.nodes.length > 30) throw new Error("编排需包含 1 至 30 个节点");
    const nodes: OrchestrationNode[] = raw.nodes.map((value, i) => {
      const row = object(value);
      const nodeId = textField(row.id, "节点 ID", 80);
      if (!/^[\w-]+$/u.test(nodeId)) throw new Error("节点 ID 格式无效");
      if (row.agentId !== undefined) {
        const system = builtin.find(node => node.agentId === row.agentId);
        if (!system) throw new Error("系统 Agent 不存在");
        return { ...system, id: nodeId, parallel: i > 0 && row.parallel === true,
          placement: i > 0 && row.parallel === true && row.placement === "up" ? "up" as const : undefined,
          skillIds: row.skillIds === undefined ? system.skillIds : ids(row.skillIds),
          enabledInteractions: ids(row.enabledInteractions ?? []), actions: parseActions(row.actions) };
      }
      const kind = row.kind === "approval" ? "approval" : "agent";
      if (kind === "approval" && row.parallel === true) throw new Error("人工确认必须是独立的顺序节点");
      const baseAgentId = row.baseAgentId === undefined ? undefined : textField(row.baseAgentId, "来源 Agent", 100);
      if (baseAgentId && (kind !== "agent" || !builtin.some(node => node.kind === "agent" && node.agentId === baseAgentId))) {
        throw new Error("来源 Agent 不存在");
      }
      const interactions = kind === "agent" ? parseInteractions(row.interactions ?? [BEFORE_RUN_INPUT, AFTER_RESULT_ROUTE]) : [];
      const inherited=baseAgentId?builtin.find(node=>node.agentId===baseAgentId):undefined;
      const capabilities = kind === "agent" ? ids(row.capabilities ?? inherited?.capabilities ?? (row.readOnly === false
        ? ["repository.read", "repository.write", "repository.commit"] : ["repository.read"])) : [];
      assertRegisteredCapabilities(capabilities);
      if(inherited&&capabilities.some(capability=>!inherited.capabilities?.includes(capability as AgentCapability)))throw new Error("复制 Agent 不能启用来源未声明的能力");
      if(kind==="agent"&&row.readOnly===false&&!capabilities.includes("repository.write"))throw new Error("可写 Agent 必须声明 repository.write");
      if(kind==="agent"&&row.readOnly!==false&&capabilities.some(capability=>["repository.write","repository.commit"].includes(capability)))throw new Error("只读 Agent 不能启用仓库写入能力");
      return { id: nodeId, name: textField(row.name, "Agent 名称", 80), kind, parallel: i > 0 && row.parallel === true,
        ...(kind === "agent" ? {agentVersion: LOCAL_AGENT_DEFINITION_VERSION, outputSchemaId: MARKDOWN_RESULT_SCHEMA_ID} : {}),
        placement: i > 0 && row.parallel === true && row.placement === "up" ? "up" as const : undefined,
        ...(baseAgentId ? {baseAgentId} : {}),
        prompt: textField(row.prompt, "提示词", 30_000, kind === "approval"), skillIds: kind === "approval" ? [] : ids(row.skillIds ?? []), readOnly: row.readOnly !== false,
        interactions, capabilities: [...capabilities], enabledInteractions: ids(row.enabledInteractions ?? []),
        actions: parseActions(row.actions) };
    });
    if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error("节点 ID 不能重复");
    for (let i = 1; i < nodes.length; i++) if (nodes[i]!.parallel && nodes[i - 1]!.kind === "approval") throw new Error("不能与人工确认节点并行");
    for (let i=0;i<nodes.length;i++) {
      const node=nodes[i]!;
      if (node.kind !== "agent" && node.parallel) throw new Error("人工确认与导出必须顺序执行");
      if (node.kind === "export" && (i===0 || nodes[i-1]!.kind!=="approval")) throw new Error("资产化导出前必须紧邻一个人工确认节点");
      if (node.parallel && (!node.readOnly || nodes[i-1]!.kind!=="agent" || !nodes[i-1]!.readOnly)) throw new Error("并行组只允许不可写 Agent，请将可写节点改为顺序执行");
    }
    for (let i=0;i<nodes.length;) {
      let end=i;
      while(end+1<nodes.length&&nodes[end+1]!.parallel)end++;
      const group=nodes.slice(i,end+1);
      if(end>i&&group.some(node=>node.capabilities?.includes("repository.prepare"))
        &&(group.filter(node=>node.capabilities?.includes("repository.prepare")).length!==1
          ||group.some(node=>!node.capabilities?.includes("repository.prepare")&&(node.agentId??node.baseAgentId)!=="opc-troubleshooting-agent")))
        throw new Error("仓库准备仅允许与只读自动排障并行，其余节点必须在汇合后执行");
      if(nodes.slice(i,end+1).filter(node=>node.actions?.length).length>1)throw new Error("同一并行组只能有一个产物后动作节点");
      i=end+1;
    }
    const nodeIds = new Set(nodes.map(node => node.id));
    for (const node of nodes) {
      if (node.kind !== "agent" && (node.enabledInteractions?.length || node.actions?.length)) throw new Error("系统节点不能配置 Agent 交互");
      validateNodeActionBindings({ interactions: node.interactions ?? [], enabledInteractions: node.enabledInteractions ?? [],
        actions: node.actions ?? [], nodeIds });
      if((node.interactions??[]).filter(interaction=>interaction.timing==="before-run"&&node.enabledInteractions?.includes(interaction.id)).length>1)
        throw new Error("同一节点只能启用一个运行前交互");
      if(node.actions?.some(action=>action.kind!=="goto"))throw new Error("自定义编排当前只支持 goto 连接；请选择已定义的目标节点");
      if (node.capabilities) assertRegisteredCapabilities(node.capabilities);
    }
    const available = new Set(skills().map(skill => skill.id));
    for (const node of nodes) if (node.skillIds.some(id => !available.has(id))) throw new Error(`${node.name} 引用的 Skill 已不可用`);
    return { id, name: textField(raw.name, "模板名称", 100), description: textField(raw.description, "模板说明", 2000, true),
      version: 1, system: false, nodes };
  }
  return { skills, agents, templates, validate,
    registerSkill(value: unknown) {
      const input = object(value), directory = textField(input.path, "Skill 目录", 2048);
      if (!path.isAbsolute(directory)) throw new Error("请选择 Skill 绝对路径");
      return library().importDirectory(directory, input.name ? { name: textField(input.name, "Skill 名称", 100) } : {});
    },
    updateSkill(value: unknown) {
      const input = object(value), managed = library(), previous = managed.get(textField(input.id, "Skill ID", 200));
      if (!previous.source.path) throw new Error("Skill 缺少本地来源");
      return managed.importDirectory(previous.source.path, { name: previous.name, updateId: previous.id, source: previous.source });
    },
    removeSkill(id: string) {
      const references = [...readJson<OrchestrationTemplate[]>(templateFile, []).flatMap(template => template.nodes.filter(node => node.skillIds.includes(id)).map(node => `${template.name} / ${node.name}`)), ...agents().filter(agent => agent.skillIds.includes(id)).map(agent => agent.name)];
      return library().remove(id, references);
    },
    setAgentSkills(agentId: string, selected: unknown) {
      if (!agents().some(agent => agent.agentId === agentId || agent.id === agentId)) throw new Error("Agent 不存在");
      return library().setBindings(agentId, selected);
    },
    save(value: unknown) {
      const template = validate(value), all = readJson<OrchestrationTemplate[]>(templateFile, []);
      const previous = all.find(item => item.id === template.id);
      if (previous && object(value).version !== previous.version) throw new Error("模板已更新，请刷新后重新编辑");
      template.version = (previous?.version ?? 0) + 1;
      writeJson(templateFile, [...all.filter(item => item.id !== template.id), template]);
      return template;
    },
    remove(id: string) {
      if (id.startsWith("system-")) throw new Error("系统模板不可删除");
      writeJson(templateFile, readJson<OrchestrationTemplate[]>(templateFile, []).filter(template => template.id !== id));
    },
  };
}
