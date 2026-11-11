/** 从报告 Agent 的 JSON 输出中提取供展示和审批的同一份 Markdown 正文。 */
export function orchestrationReportMarkdown(output: string): string | undefined {
  const fenced = /```json\s*([\s\S]*)\s*```\s*$/iu.exec(output);
  for (const source of [output, fenced?.[1]]) {
    if (!source) continue;
    try {
      const value: unknown = JSON.parse(source);
      if (value && typeof value === "object" && !Array.isArray(value)
        && "reportMarkdown" in value && typeof value.reportMarkdown === "string" && value.reportMarkdown.trim()) {
        return value.reportMarkdown;
      }
    } catch { /* 普通 Markdown 或非报告 JSON 原样交给现有渲染器。 */ }
  }
  return undefined;
}
