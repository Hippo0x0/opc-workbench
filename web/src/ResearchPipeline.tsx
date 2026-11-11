import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";

export type PipelineStage = {
  id: string;
  label: string;
  status: "complete" | "active" | "waiting" | "skipped" | "blocked";
  durationMs?: number;
  progressLabel?: string;
  parallel?: boolean;
  gate?: boolean;
};

export function ResearchPipeline({ title, stages, selected, onSelect, status, statusLabel, paused, executorActive, actions, metadata, compactSlots = false, draggable = false }: {
  title: string;
  stages: PipelineStage[];
  selected: string;
  onSelect: (id: string) => void;
  status: string;
  statusLabel: string;
  paused: boolean;
  executorActive: boolean;
  actions?: ReactNode;
  metadata?: ReactNode;
  compactSlots?: boolean;
  draggable?: boolean;
}) {
  const drag = useRef<{x: number; left: number} | null>(null);
  const [dragging, setDragging] = useState(false);
  const startDrag = (event: PointerEvent<HTMLElement>) => {
    if (!draggable || event.button !== 0 || (event.target as Element).closest("button")) return;
    drag.current = {x: event.clientX, left: event.currentTarget.scrollLeft};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    if (Math.abs(event.clientX - drag.current.x) > 3) setDragging(true);
    event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
  };
  const endDrag = (event: PointerEvent<HTMLElement>) => {
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const groups: PipelineStage[][] = [];
  stages.forEach(stage => {
    if (stage.parallel && groups.length) groups[groups.length - 1]!.push(stage);
    else groups.push([stage]);
  });
  const duration = (milliseconds?: number) => {
    if (milliseconds === undefined) return null;
    const seconds = Math.max(1, Math.round(milliseconds / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  const node = (stage: PipelineStage, style?: CSSProperties) => {
    const isPaused = stage.status === "active" && paused;
    const running = stage.status === "active" && (status === "RUNNING" || (status === "APPROVED" && stage.id === "export"))
      && !paused && executorActive && !stage.gate;
    return <button key={stage.id} type="button" style={style} className={`stage ${stage.status} ${selected === stage.id ? "selected" : ""} ${isPaused ? "is-paused" : ""} ${running ? "is-running" : ""}`} onClick={() => onSelect(stage.id)}>
      {stage.durationMs !== undefined && <small className="stage-duration">{duration(stage.durationMs)}</small>}
      <i>{stage.status === "complete" ? "✓" : stage.status === "skipped" ? "—" : stage.status === "blocked" ? "!" : isPaused ? "Ⅱ" : ""}</i>
      <span>{stage.label}</span>
      {isPaused ? <small className="stage-progress">已暂停</small> : stage.progressLabel && <small className="stage-progress">{stage.progressLabel}</small>}
    </button>;
  };
  // 为两行节点名、进度与下一节点上方的耗时预留各自空间。
  const parallelStep = 112;
  return <section className={`panel pipeline sdlc-pipeline ${compactSlots ? "compact-slots" : ""}`} style={compactSlots ? {"--pipeline-slots": groups.length} as CSSProperties : undefined}><header><div className="sdlc-pipeline-heading"><h2>{title}</h2>
    <span className={`status sdlc-run-status ${status}`}>● Run {statusLabel}</span></div>
    {actions}</header>
    <div className={`sdlc-flow-scroll ${draggable ? "is-draggable" : ""} ${dragging ? "is-dragging" : ""}`} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
    <div className="flow">{groups.map((group, index) => group.length === 1 ? node(group[0]!) :
      <div key={`parallel-${index}`} className={`parallel ${["complete", "skipped"].includes(group[0]!.status) ? "reached" : ""}`} style={{ "--parallel-height": `${42 + (group.length - 1) * parallelStep}px` } as CSSProperties}>
        {group.map((stage, lane) => node(stage, { "--parallel-offset": `${lane * parallelStep}px` } as CSSProperties))}
      </div>)}</div></div>
    {metadata && <div className="sdlc-pipeline-meta">{metadata}</div>}
  </section>;
}
