import fs from "node:fs";
import path from "node:path";

export interface TraceTarget { directory: string; stageId: string; attempt: number }
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 仅提取文本，不复制签名、图片或原始事件。 */
function textContent(value: unknown): string {
  return Array.isArray(value) ? value.map((block: unknown) => {
    const item = object(block);
    return item.type === "text" && typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n") : "";
}

export function createResearchTextRedactor(env: NodeJS.ProcessEnv, maxCharacters = 16_000) {
  const secrets = Object.entries(env).filter(([key, value]) =>
    /token|secret|password|api.?key|credential|cookie/iu.test(key) && value && value.length >= 6).map(([,value])=>value!);
  return (value: unknown): string => {
    let result = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    for (const secret of secrets) result = result.split(secret).join("[已隐藏]");
    return result.replace(/\bBearer\s+[\w.+/=-]+/giu, "Bearer [已隐藏]")
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, "[已隐藏]")
      .replace(/("[^"\n]*(?:token|secret|password|api[_-]?key|authorization|cookie)[^"\n]*"\s*:\s*)"(?:\\.|[^"\\])*"/giu, '$1"[已隐藏]"')
      .replace(/([?&](?:AWSAccessKeyId|Signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s"<>]+/giu, "$1[已隐藏]")
      .replace(/\b(?:sk-)[A-Za-z0-9_-]{12,}/gu, "[已隐藏]")
      .replace(/((?:[\w-]*(?:token|secret|password|api[_-]?key|authorization|cookie)[\w-]*)["']?\s*[:=]\s*["']?)[^\s"',;}&]+/giu, "$1[已隐藏]")
      .slice(0, maxCharacters);
  };
}

export function createAgentTrace(target: TraceTarget, env: NodeJS.ProcessEnv) {
  const clean = createResearchTextRedactor(env);
  let buffer = "";
  let dropping = false;
  let finalText = "";
  let modelError: string | undefined;
  let turn = 0;
  let thinkingMs: number | undefined;
  let thinkingStarted: number | undefined;
  const starts = new Map<string, number>();
  const write = (entry: Record<string, unknown>) => {
    try {
      fs.mkdirSync(target.directory, { recursive: true });
      fs.appendFileSync(path.join(target.directory, "stage-trace.jsonl"),
        JSON.stringify({ ...target, directory: undefined, at: new Date().toISOString(), turn, ...entry }) + "\n", { mode: 0o600 });
    } catch { /* 观测文件写入失败不终止研究。 */ }
  };
  const consume = (line: string) => {
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(line)); } catch { return; }
    const now = Date.now();
    const id = typeof event.toolCallId === "string" ? event.toolCallId.slice(0, 200) : "";
    if (event.type === "turn_start") {
      turn += 1;
      thinkingMs = undefined; thinkingStarted = undefined;
      starts.set("model", now);
      write({ kind: "model_start", label: "模型调用" });
    } else if (event.type === "message_update") {
      const update = object(event.assistantMessageEvent);
      if (update.type === "thinking_start") thinkingStarted = now;
      if (update.type === "thinking_end" && thinkingStarted !== undefined) {
        thinkingMs = (thinkingMs ?? 0) + now - thinkingStarted;
        thinkingStarted = undefined;
      }
    } else if (event.type === "message_end") {
      const message = object(event.message);
      if (message.role !== "assistant") return;
      modelError = message.stopReason === "error" ? clean(message.errorMessage || "模型调用失败") : undefined;
      const text = textContent(message.content);
      const content = Array.isArray(message.content) ? message.content.map(object) : [];
      const thinking = content.filter((block) => block.type === "thinking" && typeof block.thinking === "string")
        .map((block) => block.thinking).join("\n");
      const calls = content.filter((block) => block.type === "toolCall")
        .map((block) => ({ name: block.name, arguments: block.arguments, id: block.id }));
      // 最终结构化产物使用原始公开文本；仅观测副本脱敏。
      if (text) finalText = text;
      const usage = object(message.usage);
      const tokens = typeof usage.totalTokens === "number" ? usage.totalTokens : undefined;
      write({ kind: "assistant", label: "助手回复", output: clean(calls.length ? { reply: text, toolCalls: calls } : text || message.errorMessage || ""),
        ...(thinking ? { thinking: clean(thinking) } : {}), thinkingMs,
        isError: message.stopReason === "error" || message.stopReason === "aborted",
        model: clean(message.model ?? ""), tokens,
        durationMs: starts.has("model") ? now - starts.get("model")! : undefined });
    } else if (event.type === "tool_execution_start") {
      starts.set(id, now);
      write({ kind: "tool_start", callId: id, label: clean(event.toolName ?? "工具"), input: clean(event.args) });
    } else if (event.type === "tool_execution_end") {
      write({ kind: "tool_end", callId: id, label: clean(event.toolName ?? "工具"),
        output: clean(textContent(object(event.result).content)), isError: event.isError === true,
        durationMs: starts.has(id) ? now - starts.get(id)! : undefined });
      starts.delete(id);
    }
  };
  return {
    input(callTurn: number, systemPrompt: string, userPrompt: string, messages: unknown[], tools?: unknown[]) {
      const context = messages.map((value) => {
        const message = object(value);
        const content = Array.isArray(message.content) ? message.content.map(object).flatMap<Record<string, unknown>>((block) => {
          if (block.type === "text") return [{ type: "text", text: block.text }];
          if (block.type === "toolCall") return [{ type: "toolCall", name: block.name, arguments: block.arguments }];
          return [];
        }) : typeof message.content === "string" ? message.content : [];
        return { role: message.role, toolName: message.toolName, content };
      });
      write({ turn: callTurn, kind: "input", label: "系统提示词 · 用户提示词 · 上下文",
        input: JSON.stringify({ systemPrompt: clean(systemPrompt), userPrompt: clean(userPrompt), context: clean(context),
          ...(tools ? { tools: clean(tools) } : {}) }) });
    },
    push(chunk: string) {
      for (const piece of chunk.split(/(?<=\n)/u)) {
        if (!dropping) buffer += piece;
        if (buffer.length > 4 * 1024 * 1024) { buffer = ""; dropping = true; }
        if (piece.endsWith("\n")) {
          if (!dropping) consume(buffer);
          buffer = ""; dropping = false;
        }
      }
    },
    finish() { if (buffer && !dropping) consume(buffer); buffer = ""; return finalText; },
    modelError() { return modelError; },
  };
}

/** 交接已有脱敏轨迹中的工具事实，不解释命令业务含义或推断调用是否到达服务端。 */
export function writeStageToolEvidence(directory: string, stageId: string): string | undefined {
  const source = path.join(directory, "stage-trace.jsonl");
  if (!fs.existsSync(source)) return undefined;
  const events: Array<Record<string, unknown>> = [];
  let malformedLines = 0;
  for (const [index,line] of fs.readFileSync(source,"utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let event: Record<string,unknown>;
    try { event=object(JSON.parse(line)); } catch { malformedLines++;continue; }
    if(event.stageId===stageId && ["tool_start","tool_end"].includes(String(event.kind))) {
      events.push({...event,traceRef:`trace:${index+1}`});
    }
  }
  if(!events.length)return undefined;
  const file=path.join(directory,`tool-evidence.${encodeURIComponent(stageId)}.json`);
  fs.writeFileSync(file,JSON.stringify({stageId,source,malformedLines,events},null,2)+"\n",{mode:0o600});
  return file;
}

/** 按原文件行号分页，同一个模型/工具事件保持稳定 seq。 */
export function readTracePage(directory:string,stageId:string,params:URLSearchParams){
 const file=path.join(directory,"stage-trace.jsonl"),lines=fs.existsSync(file)?fs.readFileSync(file,"utf8").split("\n").filter(Boolean):[];
 const entries:Array<Record<string,unknown>>=[];
 lines.forEach((line,index)=>{try{const event=object(JSON.parse(line));if(event.stageId===stageId)entries.push({...event,seq:index+1});}catch{/* 原文件保留用于诊断，无法解析的行不参与展示。 */}});
 const integer=(name:string,fallback:number)=>{const raw=params.get(name),value=raw===null?fallback:Number(raw);if(!Number.isSafeInteger(value)||value<0)throw new Error("轨迹分页参数无效");return value;};
 const after=integer("after",0),before=integer("before",Number.MAX_SAFE_INTEGER),limit=Math.min(200,Math.max(1,integer("limit",100)));
 const candidates=entries.filter(event=>Number(event.seq)>after&&Number(event.seq)<before);
 const items=params.has("after")?candidates.slice(0,limit):candidates.slice(-limit);
 return {items,cursor:items.at(-1)?.seq??after,hasMoreBefore:items.length>0&&entries.some(event=>Number(event.seq)<Number(items[0]!.seq))};
}
