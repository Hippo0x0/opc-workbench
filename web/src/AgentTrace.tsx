import React, { useEffect, useRef, useState } from "react";
import { traceRows, tracePreview, traceStatus, type TraceEntry, type TraceRow } from "./trace-view.ts";
import "./trace.css";
type Page = { items: TraceEntry[]; cursor: number; hasMoreBefore: boolean };
export type TraceMessage = { id: string; text: string; createdAt: string; status: string; error?: string; paused?: boolean; onResume?: () => void; onAsChat?: () => void };
const duration = (ms?: number) => ms === undefined ? "未记录" : ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(2)} 秒`;
function Content({ text }: { text?: string }) {
  if (!text) return <p className="muted">未记录</p>;
  let formatted = text;
  try { formatted = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 保留文本。 */ }
  return <pre>{formatted}</pre>;
}
function InputContent({ text }: { text?: string }) {
  let value: unknown;
  try { value = JSON.parse(text ?? ""); } catch { return <Content text={text} />; }
  if (!value || typeof value !== "object" || !("systemPrompt" in value)) return <Content text={text} />;
  const fields = value as Record<string, unknown>;
  return <>{([['systemPrompt', '系统提示词'], ['tools', '工具定义'], ['userPrompt', '用户提示词'], ['context', '上下文']] as const).filter(([key]) => fields[key] !== undefined).map(([key, label]) =>
    <section key={key}><b>{label}</b><Content text={typeof fields[key] === "string" ? fields[key] : undefined} /></section>)}</>;
}
function ModelOutput({ thinking, output }: { thinking?: string; output?: string }) {
  let reply = output;
  let calls: unknown[] = [];
  try {
    const value: unknown = JSON.parse(output ?? "");
    if (value && typeof value === "object" && "reply" in value && typeof value.reply === "string"
      && "toolCalls" in value && Array.isArray(value.toolCalls)) {
      reply = value.reply; calls = value.toolCalls;
    }
  } catch { /* 非结构化输出按原文本展示。 */ }
  return <><section><b>思考</b><Content text={thinking} /></section>
    {reply || !calls.length ? <section><b>回复</b><Content text={reply} /></section> : null}
    {calls.length > 0 && <section><b>工具调用</b><Content text={JSON.stringify(calls)} /></section>}</>;
}
export function AgentTrace({ issueId, runId, stageId, active: stageActive, load, baseUrl, footer, messages = [] }: {
  issueId?: string; runId?: string; stageId: string; active: boolean; load: (url: string) => Promise<Page>;
  baseUrl?: string; footer?: React.ReactNode; messages?: TraceMessage[];
}) {
  // 已完成节点仍可继续对话，回复中的模型调用不能按节点终态显示为中断。
  const active = stageActive || messages.some(message => message.status === "chatting");
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [older, setOlder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<TraceRow["id"] | null>(null);
  const [tab, setTab] = useState("overview");
  const [actualTime, setActualTime] = useState(true);
  const follow = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const inspector = useRef<HTMLDivElement>(null);
  const base = baseUrl ?? `/api/workbench/stage-trace?issueId=${encodeURIComponent(issueId ?? "")}&runId=${encodeURIComponent(runId ?? "")}&stageId=${encodeURIComponent(stageId)}&limit=100`;
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let after: number | null = null;
    setEntries([]); setOlder(false); setError(""); setLoading(true);
    const pull = async () => {
      try {
        const initial = after === null;
        const page = await load(base + (initial ? "" : `&after=${after}`));
        if (stopped) return;
        after = page.cursor;
        if (initial) setOlder(page.hasMoreBefore);
        setEntries((current) => [...current, ...page.items]); setError(""); setLoading(false);
      } catch { if (!stopped) { setError("轨迹读取失败"); setLoading(false); } }
      if (!stopped && (active || footer)) timer = window.setTimeout(() => void pull(), active ? 1000 : 3000);
    };
    void pull();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [base, active, load, Boolean(footer)]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [entries, messages]);
  const loadOlder = async () => {
    if (busy || !entries[0]) return;
    setBusy(true);
    const height = scroll.current?.scrollHeight ?? 0;
    try {
      const page = await load(`${base}&before=${entries[0].seq}`);
      follow.current = false;
      setEntries((current) => [...page.items, ...current]); setOlder(page.hasMoreBefore);
      requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop += scroll.current.scrollHeight - height; });
    } catch { setError("轨迹读取失败"); } finally { setBusy(false); }
  };
  const allRows = traceRows(entries);
  const messageInputRows = new Set<TraceRow["id"]>();
  const matchedMessageIds = new Set<string>();
  for (const item of messages) {
    if (!["delivered", "chatting", "replied"].includes(item.status)) continue;
    const matches = allRows.filter(row => row.kind === "input" && Date.parse(row.at) >= Date.parse(item.createdAt) - 2000
      && (row.input ?? "").includes(item.text));
    const prompt = matches.find(row => row.label.startsWith("用户提示词")) ?? matches[0];
    if (prompt) { messageInputRows.add(prompt.id); matchedMessageIds.add(item.id); }
  }
  const visibleMessages = messages.filter(item => !["delivered", "chatting", "replied"].includes(item.status)
    || !matchedMessageIds.has(item.id));
  const messageRows = <div className="trace-messages" aria-live="polite">{visibleMessages.map(item =>
    <div key={item.id} className="trace-message"><span className="trace-kind">消息</span><p>{item.text}</p><small>{item.status === "waiting" ? item.paused ? "任务已暂停，继续执行后发送" : "等待发送" : item.status === "delivering" ? "等待 Agent 接收"
      : item.status === "delivered" ? "已送达" : item.status === "chatting" ? "等待模型回复"
        : item.status === "replied" ? "已回复" : `未送达${item.error ? `：${item.error}` : ""}`}</small>
      {item.onResume && <button type="button" onClick={item.onResume}>继续执行并发送</button>}
      {item.onAsChat && <button type="button" onClick={item.onAsChat}>作为对话发送</button>}</div>)}</div>;
  const rows = allRows.filter((row) => `${row.label} ${row.input ?? ""} ${row.thinking ?? ""} ${row.output ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const current = allRows.find((row) => row.id === selected);
  useEffect(() => { if (inspector.current) inspector.current.scrollTop = 0; }, [selected, tab]);
  const start = Date.parse(entries[0]?.at ?? "");
  const span = Math.max(1, ...allRows.map((row) => Date.parse(row.at) - start + (row.durationMs ?? 0)));
  const inputGroups = new Map<string, TraceRow[]>();
  for (const row of rows) if (row.kind === "input") inputGroups.set(row.at, [...(inputGroups.get(row.at) ?? []), row]);
  const timelineLeft = (row: TraceRow, index: number): string => {
    if (!actualTime) return `${index / Math.max(1, rows.length) * 99}%`;
    const percent = (Date.parse(row.at) - start) / span * 99;
    if (row.kind !== "input") return `${percent}%`;
    const group = inputGroups.get(row.at) ?? [];
    // 输入是瞬时事件，不伪造耗时；同一快照的分项标记展开，保证各项可点击。
    const offset = group.indexOf(row) * 12;
    return `min(calc(${percent}% + ${offset}px), calc(100% - ${Math.max(1, group.length) * 12 - offset}px))`;
  };
  const select = (id: TraceRow["id"], locate = false) => {
    const row = allRows.find((item) => item.id === id);
    setSelected(id); setTab(row?.kind === "model" ? "output" : row?.kind === "input" ? "input" : "overview"); follow.current = false;
    if (locate) requestAnimationFrame(() => {
      const container = scroll.current;
      const row = container?.querySelector<HTMLElement>(`[data-trace-id="${id}"]`);
      if (container && row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientHeight / 2;
    });
  };
  if (entries.length === 0) return <div className="agent-trace-with-footer"><details className="agent-trace trace-empty" open={Boolean(error) || visibleMessages.length > 0}>
    <summary><b>执行轨迹</b><span className="muted">{error ? "轨迹加载失败" : loading ? "正在加载轨迹…" : "暂无执行轨迹"}</span>
      <span className="trace-empty-toggle"><span className="expand-label">展开</span><span className="collapse-label">收起</span></span></summary>
    <p className={error ? "trace-empty-error" : "muted"} role={error ? "alert" : undefined}>{error || "暂无执行轨迹"}</p>{messageRows}
  </details>{footer && <div className="trace-footer">{footer}</div>}</div>;
  return <section className="agent-trace">
    <header><b>执行轨迹</b><button className="trace-time-mode" aria-pressed={actualTime} onClick={() => setActualTime((value) => !value)}>{actualTime ? "实际时长" : "等宽操作"}</button><span className="muted">{allRows.filter((row) => row.kind !== "input").length} 次调用</span><input aria-label="搜索轨迹" placeholder="搜索" value={search} onChange={(event) => setSearch(event.target.value)} /></header>
    {entries.length > 0 && <div className="trace-timeline" aria-label="执行时间轴">{(["input", "model", "tool"] as const).map((kind) => <div key={kind} className="trace-lane"><small>{kind === "input" ? "输入" : kind === "model" ? "模型" : "工具"}</small><div>{rows.map((row, index) => row.kind !== kind ? null : <button key={row.id} aria-label={`${kind === "input" ? "输入" : kind === "model" ? "模型" : "工具"} ${row.label}，第 ${row.turn} 轮`} aria-pressed={selected === row.id} className={`${kind} ${kind === "input" ? row.label.startsWith("用户") ? "input-user" : row.label.startsWith("上下文") ? "input-context" : row.label.startsWith("工具") ? "input-tools" : "" : ""} ${row.failed ? "failed" : ""}`} title={`${row.label} · ${traceStatus(row, active)} · ${row.kind === "input" ? "输入事件" : duration(row.durationMs)}${row.thinking ? " · 思考 → 回复" : ""}`} style={{ left: timelineLeft(row, index), width: actualTime && kind === "input" ? "10px" : `${actualTime ? Math.max(.35, (row.durationMs ?? 0) / span * 99) : 98 / Math.max(1, rows.length)}%` }} onClick={() => select(row.id, true)}>
      {kind === "model" && row.thinkingMs !== undefined && row.durationMs ? <><span className="trace-thinking-segment" title="思考" style={{ width: `${Math.min(100, row.thinkingMs / row.durationMs * 100)}%` }} /><span className="trace-reply-segment" title="回复" /></> : null}
    </button>)}</div></div>)}</div>}
    <div className={`trace-workspace ${current ? "inspecting" : ""}`}>
      <div className="trace-rows" ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}>
        {older && <button onClick={() => void loadOlder()} disabled={busy}>{busy ? "加载中…" : "加载更早轨迹"}</button>}
        {error && <p role="alert">{error}</p>}{!entries.length && !error && <p className="muted">暂无执行轨迹</p>}
        {rows.map((row, index) => <React.Fragment key={row.id}>{(index === 0 || rows[index - 1]?.turn !== row.turn || rows[index - 1]?.attempt !== row.attempt) && <div className="trace-turn">A{row.attempt} · 第 {row.turn} 轮</div>}
          <button data-trace-id={row.id} className={`trace-row ${row.kind} ${messageInputRows.has(row.id) ? "user-message" : ""} ${row.failed ? "failed" : ""} ${selected === row.id ? "selected" : ""}`} aria-pressed={selected === row.id} onClick={() => select(row.id)}>
            <span className="trace-kind">{messageInputRows.has(row.id) ? "用户" : row.kind === "input" ? "输入" : row.kind === "tool" ? "工具" : "模型"}</span><strong>{messageInputRows.has(row.id) ? "用户输入" : row.label}</strong><span className="trace-inline-input">{row.kind === "model" ? row.thinking ? `思考：${tracePreview(row.thinking)}` : "" : tracePreview(row.input)}</span><span className="trace-inline-output">{row.kind === "model" ? row.thinking ? " → 回复：" : "回复：" : row.input ? "→ " : ""}{tracePreview(row.output) || traceStatus(row, active)}</span><small>{row.kind === "input" ? "" : duration(row.durationMs)}</small>
          </button></React.Fragment>)}
        {messageRows}
      </div>
      {current && <aside className="trace-inspector" aria-label="轨迹详情"><header><b>{current.kind === "input" ? "输入" : current.kind === "tool" ? "工具" : "模型"} · {current.label}</b><button aria-label="关闭轨迹详情" onClick={() => setSelected(null)}>×</button></header><small>A{current.attempt} · 第 {current.turn} 轮</small><nav>{([['overview', '概述'], ['input', current.kind === 'model' ? '完整输入' : '输入'], ['output', current.kind === 'model' ? '思考与回复' : '输出'], ['timing', '计时']] as const).map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</nav>
        <div className="trace-inspector-body" ref={inspector}>{tab === "overview" ? <><dl><dt>状态</dt><dd>{traceStatus(current, active)}</dd><dt>模型</dt><dd>{current.model || "—"}</dd><dt>Token</dt><dd>{current.tokens ?? "未记录"}</dd><dt>时长</dt><dd>{duration(current.durationMs)}</dd><dt>思考耗时</dt><dd>{duration(current.thinkingMs)}</dd></dl>{current.kind !== "model" && <><InputContent text={current.input} /><Content text={current.output} /></>}</> : tab === "input" ? <InputContent text={current.input} /> : tab === "output" ? current.kind === "model" ? <ModelOutput thinking={current.thinking} output={current.output} /> : <Content text={current.output} /> : <dl>
          <dt>开始时间</dt><dd>{current.started ? new Date(current.at).toLocaleString("zh-CN", { hour12: false }) : "未记录"}</dd>
          <dt>时长</dt><dd>{duration(current.durationMs)}</dd>
          <dt>结束时间</dt><dd>{current.endedAt ? new Date(current.endedAt).toLocaleString("zh-CN", { hour12: false }) : "未记录"}</dd>
        </dl>}</div>
      </aside>}
    </div>
    {footer && <div className="trace-footer">{footer}</div>}
  </section>;
}
