import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentTrace } from "./trace.ts";

/** 仅在 Scheduler 显式开启时采集每次请求前的应用输入；不记录 provider 请求或认证头。 */
export default function traceExtension(pi: ExtensionAPI): void {
  const directory = process.env.OPC_STAGE_TRACE_DIRECTORY;
  const stageId = process.env.OPC_STAGE_TRACE_STAGE;
  const attempt = Number(process.env.OPC_STAGE_TRACE_ATTEMPT);
  if (!directory || !stageId || !Number.isSafeInteger(attempt) || attempt < 1) return;
  const trace = createAgentTrace({ directory, stageId, attempt }, process.env);
  let turn = 0;
  let prompt = "";
  pi.on("before_agent_start", (event) => { prompt = event.prompt; });
  pi.on("turn_start", () => { turn += 1; });
  pi.on("context", (event, context) => {
    const active = new Set(pi.getActiveTools());
    const tools = pi.getAllTools().filter((tool) => active.has(tool.name))
      .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    trace.input(turn, context.getSystemPrompt(), prompt, event.messages, tools);
  });
}
