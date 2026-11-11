import { resultObject, descriptionList } from "./result-format.ts";
/** 本地 Research Scheduler 的 Agent 与节点交互契约。运行时只交换 JSON。 */
export const LOCAL_AGENT_PROTOCOL_VERSION = 1 as const;
export const LOCAL_AGENT_DEFINITION_VERSION = 1 as const;
export const MARKDOWN_RESULT_SCHEMA_ID = "markdown-result-v1" as const;

export const AGENT_CAPABILITIES = ["repository.read", "repository.prepare", "repository.write", "repository.commit", "knowledge.read", "test.execute", "test-result.read", "report.export"] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];

export const AGENT_ACTIONS = ["approve", "retry", "skip", "continue", "return-to-coding", "goto"] as const;
export type AgentActionId = typeof AGENT_ACTIONS[number];

export interface AgentInteractionField {
  id: string;
  type: "text" | "textarea" | "select";
  required: boolean;
  options?: string[];
}
export interface AgentInteractionDefinition {
  id: string;
  timing: "before-run" | "after-result";
  fields: AgentInteractionField[];
  actions: AgentActionId[];
}
export interface AgentActionBinding {
  /** 节点内唯一的按钮 ID；kind 是平台登记的动作语义。 */
  id: string;
  kind: AgentActionId;
  label: string;
  targetNodeId: string;
  interactionId: string;
}

/** 每个 Agent 都可以声明产物后由用户选择已连接的下一节点。节点不启用时自动顺序推进。 */
export const AFTER_RESULT_ROUTE: AgentInteractionDefinition = {
  id: "after-result-route", timing: "after-result",
  fields: [{ id: "comment", type: "textarea", required: false }], actions: ["goto"],
};
export const BEFORE_RUN_INPUT: AgentInteractionDefinition = {
  id: "before-run-input", timing: "before-run",
  fields: [{ id: "instruction", type: "textarea", required: false }], actions: ["continue"],
};

export function assertRegisteredCapabilities(values: readonly string[]): asserts values is readonly AgentCapability[] {
  const registered = new Set<string>(AGENT_CAPABILITIES);
  for (const value of values) if (!registered.has(value)) throw new Error(`未登记的 Agent 能力：${value}`);
}

export function assertAgentInteractions(interactions: readonly AgentInteractionDefinition[]): void {
  const actionIds = new Set<string>(AGENT_ACTIONS);
  const seen = new Set<string>();
  for (const interaction of interactions) {
    if (!/^[\w.-]{1,80}$/u.test(interaction.id) || seen.has(interaction.id)) throw new Error("Agent 交互 ID 无效或重复");
    seen.add(interaction.id);
    if (interaction.timing !== "before-run" && interaction.timing !== "after-result") throw new Error("Agent 交互时机无效");
    const fieldIds = new Set<string>();
    for (const field of interaction.fields) {
      if (!/^[\w.-]{1,80}$/u.test(field.id) || fieldIds.has(field.id)
        || !["text", "textarea", "select"].includes(field.type)) throw new Error("Agent 交互字段无效或重复");
      fieldIds.add(field.id);
      if (field.type === "select" && (!field.options?.length || field.options.some(option => !option.trim()))) {
        throw new Error("选择字段需要有效选项");
      }
    }
    if (!interaction.actions.length || new Set(interaction.actions).size !== interaction.actions.length
      || interaction.actions.some(action => !actionIds.has(action))) throw new Error("Agent 交互动作无效或重复");
  }
}

export function validateNodeActionBindings(input: {
  interactions: readonly AgentInteractionDefinition[];
  enabledInteractions: readonly string[];
  actions: readonly AgentActionBinding[];
  nodeIds: ReadonlySet<string>;
}): void {
  assertAgentInteractions(input.interactions);
  const available = new Map(input.interactions.map(interaction => [interaction.id, interaction]));
  const enabled = new Set(input.enabledInteractions);
  if (enabled.size !== input.enabledInteractions.length) throw new Error("节点启用交互不能重复");
  for (const id of enabled) if (!available.has(id)) throw new Error(`Agent 未声明交互 ${id}`);
  const seen = new Set<string>();
  for (const action of input.actions) {
    const interaction = available.get(action.interactionId);
    if (!interaction || interaction.timing !== "after-result" || !enabled.has(action.interactionId) || !interaction.actions.includes(action.kind)) {
      throw new Error(`节点动作 ${action.id} 未由 Agent 声明并启用`);
    }
    if (!/^[\w.-]{1,80}$/u.test(action.id)) throw new Error("节点动作 ID 无效");
    if (!input.nodeIds.has(action.targetNodeId)) throw new Error(`节点动作目标不存在：${action.targetNodeId}`);
    const key = action.id;
    if (seen.has(key) || !action.label.trim()) throw new Error("节点动作重复或缺少名称");
    seen.add(key);
  }
}

export function validateActionInputs(interaction: AgentInteractionDefinition, value: unknown): Record<string, string> {
  if (value === undefined) value = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("交互输入必须是 JSON 对象");
  const raw = value as Record<string, unknown>;
  const fields = new Map(interaction.fields.map(field => [field.id, field]));
  const result: Record<string, string> = {};
  for (const [key, fieldValue] of Object.entries(raw)) {
    const field = fields.get(key);
    if (!field || typeof fieldValue !== "string" || fieldValue.length > 20_000) throw new Error(`交互字段无效：${key}`);
    if (field.type === "select" && !field.options?.includes(fieldValue)) throw new Error(`交互选项无效：${key}`);
    result[key] = fieldValue;
  }
  for (const field of interaction.fields) if (field.required && !result[field.id]?.trim()) {
    throw new Error(`请填写 ${field.id}`);
  }
  return result;
}

/** 有产物后决策的 Agent 必须交付可核对的结构化结果。建议文本绝不解释为路由。 */
export function parseActionNodeResult(output: string, nodeId: string, agentId: string): {
  status: "OK" | "DEGRADED" | "FAILED" | "CANCELLED"; summary: string; markdown: string; gaps: string[];
} {
  let raw: unknown;
  try { raw = resultObject(output, "Agent"); }
  catch { throw new Error("Agent 未返回单一 JSON 产物"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Agent 产物不是 JSON 对象");
  const result = raw as Record<string, unknown>;
  if (result.protocolVersion !== LOCAL_AGENT_PROTOCOL_VERSION || result.agentVersion !== LOCAL_AGENT_DEFINITION_VERSION
    || result.nodeId !== nodeId || result.agentId !== agentId) {
    throw new Error("Agent 产物身份或协议版本不匹配");
  }
  if (!["OK", "DEGRADED", "FAILED", "CANCELLED"].includes(String(result.status))) throw new Error("Agent 结果状态无效");
  if (typeof result.summary !== "string" || !result.summary.trim() || result.summary.length > 1000) throw new Error("Agent 结果摘要无效");
  if (!result.payload || typeof result.payload !== "object" || Array.isArray(result.payload)) throw new Error("Agent 结果缺少 payload");
  const payload = result.payload as Record<string, unknown>;
  if (typeof payload.markdown !== "string" || !payload.markdown.trim()) throw new Error("Agent 结果缺少 Markdown 正文");
  if (!Array.isArray(result.gaps) || result.gaps.some(gap => typeof gap !== "string" || !gap.trim())) throw new Error("Agent 证据缺口无效");
  if (result.status === "DEGRADED" && result.gaps.length === 0) throw new Error("DEGRADED 结果必须列出证据缺口");
  return { status: result.status as "OK" | "DEGRADED" | "FAILED" | "CANCELLED", summary: result.summary,
    markdown: payload.markdown, gaps: result.gaps as string[] };
}

/** 无动作节点也可能交付 StageResult JSON；其失败状态不能被当作普通正文吞掉。 */
export function parseStandaloneAgentOutcome(output: string): {
  status: "OK" | "DEGRADED" | "FAILED" | "CANCELLED"; summary: string; gaps: string[];
} | null {
  let value: unknown;
  try { value = resultObject(output, "Agent"); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.status === undefined) return null;
  if (!["OK", "DEGRADED", "FAILED", "CANCELLED"].includes(String(result.status))) {
    throw new Error("Agent 结果状态无效");
  }
  const gaps = Array.isArray(result.gaps) ? result.gaps.flatMap(gap => {
    if (typeof gap === "string" && gap.trim()) return [gap.trim()];
    if (gap && typeof gap === "object" && !Array.isArray(gap)) {
      const row = gap as Record<string, unknown>;
      for (const field of ["description", "problem", "whyInsufficient", "finding"]) {
        if (typeof row[field] === "string" && row[field].trim()) return [row[field].trim()];
      }
    }
    return [];
  }) : [];
  const summary = typeof result.summary === "string" && result.summary.trim()
    ? result.summary.trim() : gaps[0] ?? `Agent 返回 ${result.status}，未提供摘要`;
  return { status: result.status as "OK" | "DEGRADED" | "FAILED" | "CANCELLED", summary, gaps };
}

/** 验证节点的执行状态与业务验证结论分别校验，不推断或改写结论。 */
export const VALIDATION_RESULT_CONTRACT = `只返回一个 JSON 对象，不要代码块：{"status":"DEGRADED","passed":false,"summary":"验证结论","gaps":["具体证据缺口"],"details":[]}。status 只能是大写 OK、DEGRADED、FAILED、CANCELLED。验证已完成但证据不足或验收未通过时使用 DEGRADED、passed:false 并列出 gaps；充分验证通过时使用 OK、passed:true、gaps:[]；只有节点无法完成验证或被取消时使用 FAILED/CANCELLED、passed:false。passed 是业务验证结论，不能代替 status。summary 必须非空，gaps 必须是字符串数组；保留已有证据、缺口和结论，不新增事实。`;

export function parseValidationOutcome(output: string): NonNullable<ReturnType<typeof parseStandaloneAgentOutcome>> {
  let value: unknown;
  try { value = resultObject(output, "Agent"); } catch { throw new Error("验证节点未返回单一 JSON 对象"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("验证节点产物不是 JSON 对象");
  const result = value as Record<string, unknown>;
  if (typeof result.passed !== "boolean") throw new Error("验证节点缺少布尔 passed 结论");
  if (typeof result.summary !== "string" || !result.summary.trim()) throw new Error("验证节点缺少 summary");
  result.gaps = descriptionList(result.gaps);
  const outcome = parseStandaloneAgentOutcome(JSON.stringify(result));
  if (!outcome) throw new Error("验证节点缺少执行状态 status");
  if (outcome.status === "OK" && (!result.passed || outcome.gaps.length > 0)) throw new Error("验证未通过或存在缺口时不能返回 OK");
  if (outcome.status !== "OK" && result.passed) throw new Error("非 OK 状态不能声明验证通过");
  if (outcome.status === "DEGRADED" && outcome.gaps.length === 0) throw new Error("DEGRADED 结果必须列出证据缺口");
  return outcome;
}
