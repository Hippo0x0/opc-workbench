import React, { useState } from "react";
import { orchestrationReportMarkdown } from "../../src/orchestration-report.ts";
import { reportMarkdown } from "./markdown.ts";
import "./orchestration-output.css";
import "./performance-plan.css";

type RecordValue = Record<string, unknown>;
const labels: Record<string, string> = {
  objective: "研究目标", scope: "研究范围", nonGoals: "不包含", successCriteria: "完成标准",
  researchQuestions: "研究问题", missingInputs: "缺少的输入", assumptions: "待验证假设",
  retrievalSummary: "检索汇总", evidence: "证据", gaps: "证据缺口",
  question: "问题", children: "子问题", critical: "关键问题", evidenceSources: "计划证据源",
  answerCriteria: "回答标准", dependsOn: "依赖问题", source: "来源", locator: "定位",
  status: "状态", summary: "摘要", details: "详情", questionId: "问题编号", evidenceId: "证据编号",
  evidenceIds: "关联证据", sourceAgent: "检索 Agent", sourceUri: "来源链接", sourceVersion: "来源版本",
  capturedAt: "获取时间", excerpt: "证据摘录", direction: "证据方向", evidenceType: "证据类型",
  notes: "备注", description: "缺口说明", impact: "影响", suggestedSource: "建议来源",
  primaryMetric: "主指标", name: "指标名称", unit: "计量单位", metricUnit: "计量单位",
  metricDirection: "优化方向", target: "目标", targetRationale: "目标说明",
  baselineMethod: "基线方法", correctnessChecks: "正确性检查", workload: "正式负载",
  workloadContract: "负载约束", command: "执行入口", discoveryCommand: "发现清单",
  channels: "计划证据源", questionType: "问题类型", type: "问题类型", experimentRequired: "需要实验",
};
const hidden = new Set(["schemaVersion", "scenario"]);
const channelLabels: Record<string, string> = { codebase: "代码检索", knowledge: "资料检索", web: "联网检索" };
function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function Value({ value }: { value: unknown }): React.ReactNode {
  if (value === null || value === undefined || value === "") return <span className="muted">暂无</span>;
  if (Array.isArray(value)) return value.length ? <ul className="oc-result-list">{value.map((item, index) => <li key={index}><Value value={item}/></li>)}</ul> : <span className="muted">暂无</span>;
  if (isRecord(value)) return <div className="oc-result-fields">{Object.entries(value).filter(([key]) => !hidden.has(key)).map(([key, item]) =>
    <div className="oc-result-field" key={key}><strong>{labels[key] || key}</strong>{key === "sourceUri" && typeof item === "string" && /^https?:\/\//u.test(item) ? <a href={item} target="_blank" rel="noopener noreferrer">{item}</a> : ["command", "discoveryCommand"].includes(key) && typeof item === "string" ? <code className="oc-plan-command">{item}</code> : <Value value={item}/>}</div>)}</div>;
  if (typeof value === "boolean") return <span>{value ? "是" : "否"}</span>;
  return <span>{String(value)}</span>;
}
function QuestionDetails({ item }: { item: RecordValue }) {
  return <>{Object.entries(item).filter(([key]) => !["id", "question", "children", "critical"].includes(key)).map(([key, value]) =>
    <div className="oc-question-detail" key={key}><span>{labels[key] || key}</span>
      {["channels", "evidenceSources"].includes(key) && Array.isArray(value)
        ? <div className="oc-plan-sources">{value.map((source, index) => <span key={index}><Value value={typeof source === "string" ? channelLabels[source] || source : source}/></span>)}</div>
        : <Value value={value}/>}</div>)}
    {Array.isArray(item.children) && item.children.length > 0 && <Questions questions={item.children}/>}</>;
}
function QuestionTitle({ item, index }: { item: RecordValue; index: number }) {
  return <><span className="oc-question-id">{String(item.id ?? index + 1)}</span><strong>{String(item.question ?? "未命名问题")}</strong>
    {item.critical === true && <span className="oc-critical">关键</span>}</>;
}
function Questions({ questions }: { questions: unknown[] }) {
  return <div className="oc-question-list">{questions.map((item, index) => {
    if (!isRecord(item)) return <div className="oc-question" key={index}><Value value={item}/></div>;
    return <article className="oc-question" key={String(item.id ?? index)}>
      <div className="oc-question-title"><QuestionTitle item={item} index={index}/></div>
      <QuestionDetails item={item}/>
    </article>;
  })}</div>;
}
function PlanHeading({ number, children }: { number: string; children: React.ReactNode }) {
  return <h3 className="oc-plan-heading"><span>{number}</span>{children}</h3>;
}
function PlanQuestions({ questions }: { questions: unknown[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(questions.length ? [0] : []));
  const allExpanded = questions.length > 0 && expanded.size === questions.length;
  return <section className="oc-plan-section"><div className="oc-plan-section-bar"><PlanHeading number="03">研究问题</PlanHeading>
    {questions.length > 0 && <button type="button" className="oc-plan-toggle" aria-label={`${allExpanded ? "收起" : "展开"}全部研究问题`}
      onClick={() => setExpanded(allExpanded ? new Set() : new Set(questions.map((_, index) => index)))}>{allExpanded ? "收起全部" : "展开全部"}</button>}</div>
    {questions.length ? <div className="oc-plan-questions">{questions.map((item, index) => <details className="oc-plan-question" key={index} open={expanded.has(index)}
      onToggle={event => {
        const open = event.currentTarget.open;
        setExpanded(previous => {
          if (previous.has(index) === open) return previous;
          const next = new Set(previous); if (open) next.add(index); else next.delete(index); return next;
        });
      }}><summary><div className="oc-question-title">{isRecord(item) ? <QuestionTitle item={item} index={index}/> : <Value value={item}/>}</div>
        {isRecord(item) && Array.isArray(item.children) && item.children.length > 0 && <span className="oc-plan-question-count">{item.children.length} 个子问题</span>}
        <span className="oc-plan-chevron" aria-hidden="true">›</span></summary>
      <div className="oc-plan-question-body">{isRecord(item) && <QuestionDetails item={item}/>}</div>
    </details>)}</div> : <p className="muted">尚未生成研究问题</p>}
  </section>;
}
function PerformancePlan({ plan }: { plan: RecordValue }) {
  const metric: RecordValue = isRecord(plan.primaryMetric) ? plan.primaryMetric : { name: plan.primaryMetric, unit: plan.metricUnit, direction: plan.metricDirection };
  const direction = metric.direction === "minimize" ? "↓ 越低越好" : metric.direction === "maximize" ? "↑ 越高越好" : metric.direction;
  const executionKeys = ["baselineMethod", "correctnessChecks", "workload", "workloadContract", "successCriteria"];
  const boundaryKeys = ["scope", "nonGoals", "missingInputs", "assumptions"];
  const present = (key: string) => key in plan && plan[key] !== undefined && plan[key] !== null;
  const handled = new Set(["objective", "primaryMetric", "metricUnit", "metricDirection", "researchQuestions", ...executionKeys, ...boundaryKeys]);
  const metricExtra = Object.fromEntries(Object.entries(metric).filter(([key]) => !["name", "unit", "direction", "target", "targetRationale"].includes(key)));
  return <div className="oc-performance-plan">
    <section className="oc-plan-section"><PlanHeading number="01">研究目标</PlanHeading><div className="oc-plan-objective"><Value value={plan.objective}/></div></section>
    <section className="oc-plan-section"><PlanHeading number="02">主指标</PlanHeading><dl className="oc-plan-metric">
      <div><dt>指标名称</dt><dd><Value value={metric.name}/></dd></div>
      <div><dt>计量单位</dt><dd><Value value={metric.unit}/></dd></div>
      <div><dt>优化方向</dt><dd className="oc-plan-direction"><Value value={direction}/></dd></div>
      <div><dt>目标</dt><dd>{metric.target === undefined || metric.target === null || metric.target === "" ? <span className="oc-plan-pending">待确认</span> : <Value value={metric.target}/>}</dd>
        {metric.targetRationale !== undefined && <dd className="oc-plan-metric-note"><Value value={metric.targetRationale}/></dd>}</div>
    </dl>{Object.keys(metricExtra).length > 0 && <div className="oc-plan-metric-extra"><Value value={metricExtra}/></div>}</section>
    <PlanQuestions key={JSON.stringify(plan.researchQuestions)} questions={Array.isArray(plan.researchQuestions) ? plan.researchQuestions : []}/>
    {executionKeys.some(present) && <section className="oc-plan-section"><PlanHeading number="04">执行与验收</PlanHeading><div className="oc-plan-support">{executionKeys.filter(present).map(key =>
      <section key={key}><h4>{labels[key]}</h4><Value value={plan[key]}/></section>)}</div></section>}
    {boundaryKeys.some(present) && <details className="oc-plan-boundary"><summary>研究范围与执行边界</summary><div className="oc-plan-support">{boundaryKeys.filter(present).map(key =>
      <section key={key}><h4>{labels[key]}</h4><Value value={plan[key]}/></section>)}</div></details>}
    {Object.entries(plan).filter(([key]) => !handled.has(key) && !hidden.has(key)).map(([key, value]) =>
      <section className="oc-plan-section" key={key}><h4>{labels[key] || key}</h4><Value value={value}/></section>)}
    <p className="oc-plan-footnote">仅展示研究计划，不代表实验已执行。</p>
  </div>;
}
export function OrchestrationOutput({ output }: { output: string }) {
  const report = orchestrationReportMarkdown(output);
  if (report) return <div className="oc-output markdown-content" dangerouslySetInnerHTML={{ __html: reportMarkdown(report) }}/>;
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { /* Agent 也可以返回 Markdown。 */ }
  if (!isRecord(parsed)) return <div className="oc-output markdown-content" dangerouslySetInnerHTML={{ __html: reportMarkdown(output) }}/>;
  if (typeof parsed.objective === "string" && ("primaryMetric" in parsed || parsed.scenario === "performance-optimization-v1")) {
    return <div className="oc-output oc-structured-output"><PerformancePlan plan={parsed}/>
      <details className="oc-result-raw"><summary>查看原始 JSON</summary><pre>{JSON.stringify(parsed, null, 2)}</pre></details></div>;
  }
  return <div className="oc-output oc-structured-output">
    {Object.entries(parsed).filter(([key]) => !hidden.has(key)).map(([key, value]) =>
      <section className="oc-result-section" key={key}><h3>{labels[key] || key}</h3>{key === "researchQuestions" && Array.isArray(value) ? <Questions questions={value}/> : <Value value={value}/>}</section>)}
    <details className="oc-result-raw"><summary>查看原始 JSON</summary><pre>{JSON.stringify(parsed, null, 2)}</pre></details>
  </div>;
}
