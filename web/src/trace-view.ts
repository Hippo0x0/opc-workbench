export type TraceEntry = { seq: number; at: string; attempt: number; turn: number; kind: string; label: string;
  input?: string; output?: string; thinking?: string; thinkingMs?: number; callId?: string; durationMs?: number; tokens?: number; model?: string; isError?: boolean };
export type TraceRow = { id: number | string; at: string; attempt: number; turn: number; kind: "input" | "model" | "tool";
  label: string; input?: string; output?: string; thinking?: string; thinkingMs?: number; durationMs?: number; tokens?: number; model?: string; started: boolean; endedAt?: string; ended: boolean; failed: boolean };

export function traceRows(entries: TraceEntry[]): TraceRow[] {
  const toolEnds = new Map(entries.filter((entry) => entry.kind === "tool_end").map((entry) => [`${entry.attempt}:${entry.callId}`, entry]));
  const replies = new Map(entries.filter((entry) => entry.kind === "assistant").map((entry) => [`${entry.attempt}:${entry.turn}`, entry]));
  const toolStarts = new Set(entries.filter((entry) => entry.kind === "tool_start").map((entry) => `${entry.attempt}:${entry.callId}`));
  const modelStarts = new Set(entries.filter((entry) => entry.kind === "model_start").map((entry) => `${entry.attempt}:${entry.turn}`));
  const inputs = new Map(entries.filter((entry) => entry.kind === "input").map((entry) => [`${entry.attempt}:${entry.turn}`, entry.input]));
  const previousInputs = new Map<number, Record<string, unknown>>();
  const rows: TraceRow[] = [];
  for (const entry of entries) {
    if (entry.kind === "tool_end" && toolStarts.has(`${entry.attempt}:${entry.callId}`)
      || entry.kind === "assistant" && modelStarts.has(`${entry.attempt}:${entry.turn}`)) continue;
    if (entry.kind === "input") {
      let fields: unknown;
      try { fields = JSON.parse(entry.input ?? ""); } catch { /* 无结构的历史输入按单条展示。 */ }
      if (fields && typeof fields === "object" && !Array.isArray(fields)) {
        const current = fields as Record<string, unknown>;
        const previous = previousInputs.get(entry.attempt);
        for (const [key, label] of [["systemPrompt", "系统提示词"], ["tools", "工具定义"], ["userPrompt", "用户提示词"], ["context", "上下文"]] as const) {
          const value = current[key];
          if (typeof value !== "string" || !value || value === previous?.[key]) continue;
          let content = value;
          if (key === "context") {
            content = contextChange(value, previous?.[key], current.userPrompt);
            if (!content) continue;
          }
          rows.push({ id: `${entry.seq}:${key}`, at: entry.at, attempt: entry.attempt, turn: entry.turn, kind: "input",
            label: `${label}${previous?.[key] !== undefined ? "更新" : ""}`, input: content, started: false, ended: true, failed: false });
        }
        previousInputs.set(entry.attempt, current);
        continue;
      }
    }
    const end = entry.kind === "tool_start" ? toolEnds.get(`${entry.attempt}:${entry.callId}`)
      : entry.kind === "model_start" ? replies.get(`${entry.attempt}:${entry.turn}`) : entry;
    rows.push({ id: entry.seq, at: entry.at, attempt: entry.attempt, turn: entry.turn,
      kind: entry.kind === "input" ? "input" : entry.kind.startsWith("tool_") ? "tool" : "model",
      label: entry.kind === "input" ? entry.label : entry.kind.startsWith("tool_") ? entry.label : end?.model || "模型调用",
      input: entry.input ?? (entry.kind === "model_start" || entry.kind === "assistant" ? inputs.get(`${entry.attempt}:${entry.turn}`) : undefined),
      output: end?.output, thinking: end?.thinking, thinkingMs: end?.thinkingMs, durationMs: end?.durationMs,
      tokens: end?.tokens, model: end?.model, started: entry.kind.endsWith("_start"), endedAt: end?.at,
      ended: Boolean(end), failed: end?.isError === true });
  }
  // 同轮的输入位于模型调用前；模型/工具事件维持原有顺序。
  return rows.sort((left, right) => left.attempt - right.attempt || left.turn - right.turn
    || (left.kind === "input" ? 0 : 1) - (right.kind === "input" ? 0 : 1));
}
function contextChange(current: string, previous: unknown, userPrompt: unknown): string {
  try {
    const next: unknown = JSON.parse(current);
    if (!Array.isArray(next)) return current;
    const before: unknown = typeof previous === "string" ? JSON.parse(previous) : [];
    if (!Array.isArray(before)) return current;
    const appended = before.length <= next.length && before.every((item, index) => JSON.stringify(item) === JSON.stringify(next[index]));
    if (!appended) return current; // 压缩、替换等变化展示新上下文，不伪装为追加。
    const extra = next.slice(before.length).filter((item: unknown) => {
      if (!item || typeof item !== "object") return true;
      const message = item as Record<string, unknown>;
      if (message.role === "assistant" || message.role === "toolResult") return false;
      const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
        ? message.content.map((block: unknown) => block && typeof block === "object" && "text" in block ? block.text : "").join("\n") : "";
      return message.role !== "user" || text !== userPrompt;
    });
    return extra.length ? JSON.stringify(extra) : "";
  } catch { return current; }
}
export const tracePreview = (value?: string): string => (value ?? "").replace(/\s+/gu, " ").slice(0, 240);
export const traceStatus = (row: TraceRow, active: boolean): string => row.failed ? "失败" : row.ended ? "已完成" : active ? "执行中" : "已中断";
