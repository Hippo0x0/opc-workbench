export type JsonlEntry = Record<string, unknown>;

export interface AutoresearchConfigEntry extends JsonlEntry {
  type: "config";
  name?: string;
  metricName?: string;
  metricUnit?: string;
  bestDirection?: "lower" | "higher";
  baselineMetric?: number;
  baseline_metric?: number;
  targetMetric?: number;
  target_metric?: number;
  evaluationDirectory?: string;
}

export interface AutoresearchRunEntry extends JsonlEntry {
  run: number;
}

export interface ReconstructedMetricDef {
  name: string;
  unit: string;
}

export interface ReconstructedRun {
  run: number;
  commit: string;
  metric: number;
  wallClockSeconds: number | null;
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
  directionTitle?: string | null;
  asi?: Record<string, unknown>;
}

export interface ReconstructedJsonlState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  currentSegment: number;
  /** 显式指定的 baseline，按 segment 记录。未指定时由首个有效运行结果建立。 */
  segmentBaselineMetrics: Record<number, number>;
  /** 用户明确要求达到的主指标目标，按 segment 记录。 */
  segmentTargetMetrics: Record<number, number>;
  results: ReconstructedRun[];
  secondaryMetrics: ReconstructedMetricDef[];
}

const DEFAULT_METRIC_NAME = "metric";
const DEFAULT_METRIC_UNIT = "";
const DEFAULT_DIRECTION = "lower" as const;

function isObjectRecord(value: unknown): value is JsonlEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

function metricMapFrom(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) return {};

  const metrics: Record<string, number> = {};
  for (const [name, metric] of Object.entries(value)) {
    if (typeof metric === "number") metrics[name] = metric;
  }
  return metrics;
}

function statusFrom(value: unknown): ReconstructedRun["status"] {
  if (value === "discard") return "discard";
  if (value === "crash") return "crash";
  if (value === "checks_failed") return "checks_failed";
  return "keep";
}

function directionFrom(value: unknown): ReconstructedJsonlState["bestDirection"] {
  return value === "higher" ? "higher" : DEFAULT_DIRECTION;
}

function asiFrom(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function directionTitleFrom(value: unknown): string | null {
  if (!isObjectRecord(value)) return null;
  const title = value.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

function planningTitleFromEntry(entry: JsonlEntry): { revision: number; title: string } | null {
  if (entry.type !== "planning" || typeof entry.revision !== "number" || !Number.isInteger(entry.revision)) return null;
  const title = directionTitleFrom(entry.direction);
  return title ? { revision: entry.revision, title } : null;
}

function reconstructedState(): ReconstructedJsonlState {
  return {
    name: null,
    metricName: DEFAULT_METRIC_NAME,
    metricUnit: DEFAULT_METRIC_UNIT,
    bestDirection: DEFAULT_DIRECTION,
    currentSegment: 0,
    segmentBaselineMetrics: {},
    segmentTargetMetrics: {},
    results: [],
    secondaryMetrics: [],
  };
}

function configBaselineMetric(entry: AutoresearchConfigEntry): number | null {
  const value = typeof entry.baselineMetric === "number" ? entry.baselineMetric : entry.baseline_metric;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function configTargetMetric(entry: AutoresearchConfigEntry): number | null {
  const value = typeof entry.targetMetric === "number" ? entry.targetMetric : entry.target_metric;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function updateConfig(state: ReconstructedJsonlState, entry: AutoresearchConfigEntry, segment: number): void {
  if (typeof entry.name === "string") state.name = entry.name;
  if (typeof entry.metricName === "string") state.metricName = entry.metricName;
  if (typeof entry.metricUnit === "string") state.metricUnit = entry.metricUnit;
  state.bestDirection = directionFrom(entry.bestDirection);
  const baseline = configBaselineMetric(entry);
  if (baseline !== null) state.segmentBaselineMetrics[segment] = baseline;
  const target = configTargetMetric(entry);
  if (target !== null) state.segmentTargetMetrics[segment] = target;
}

function nextSegment(state: ReconstructedJsonlState, segment: number): number {
  if (state.results.length === 0) return segment;
  state.secondaryMetrics = [];
  return segment + 1;
}

function runFrom(
  entry: AutoresearchRunEntry,
  segment: number,
  planningTitles: Map<number, string>,
): ReconstructedRun {
  const planningRevision = typeof entry.planning_revision === "number" && Number.isInteger(entry.planning_revision)
    ? entry.planning_revision
    : null;
  const directionTitle = directionTitleFrom(entry.direction) ?? (
    planningRevision === null ? null : planningTitles.get(planningRevision) ?? null
  );
  return {
    run: typeof entry.run === "number" ? entry.run : 0,
    commit: typeof entry.commit === "string" ? entry.commit : "",
    metric: typeof entry.metric === "number" && Number.isFinite(entry.metric) ? entry.metric : Number.NaN,
    wallClockSeconds: typeof entry.wall_clock_seconds === "number" && Number.isFinite(entry.wall_clock_seconds)
      ? entry.wall_clock_seconds
      : null,
    metrics: metricMapFrom(entry.metrics),
    status: statusFrom(entry.status),
    description: typeof entry.description === "string" ? entry.description : "",
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
    segment,
    confidence: typeof entry.confidence === "number" ? entry.confidence : null,
    ...(directionTitle ? { directionTitle } : {}),
    asi: asiFrom(entry.asi),
  };
}

function registerSecondaryMetrics(state: ReconstructedJsonlState, metrics: Record<string, number>): void {
  for (const name of Object.keys(metrics)) {
    if (state.secondaryMetrics.find((metric) => metric.name === name)) continue;
    state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
  }
}

export function parseJsonlEntry(line: string): JsonlEntry | null {
  try {
    const parsed = JSON.parse(line);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isAutoresearchConfigEntry(entry: unknown): entry is AutoresearchConfigEntry {
  return isObjectRecord(entry) && entry.type === "config";
}

export function isAutoresearchRunEntry(entry: unknown): entry is AutoresearchRunEntry {
  return isObjectRecord(entry) && typeof entry.run === "number";
}

function firstConfigEntry(jsonlContent: string): AutoresearchConfigEntry | null {
  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);
    if (isAutoresearchConfigEntry(entry)) return entry;
  }
  return null;
}

export function hasAutoresearchConfigHeader(jsonlContent: string): boolean {
  return firstConfigEntry(jsonlContent) !== null;
}

export function extractAutoresearchSessionName(jsonlContent: string): string {
  return firstConfigEntry(jsonlContent)?.name || "Autoresearch";
}

export function reconstructJsonlState(jsonlContent: string): ReconstructedJsonlState {
  const state = reconstructedState();
  const planningTitles = new Map<number, string>();
  let segment = 0;

  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);
    if (!entry) continue;

    if (isAutoresearchConfigEntry(entry)) {
      segment = nextSegment(state, segment);
      state.currentSegment = segment;
      updateConfig(state, entry, segment);
      continue;
    }

    const planning = planningTitleFromEntry(entry);
    if (planning) {
      planningTitles.set(planning.revision, planning.title);
      continue;
    }

    if (!isAutoresearchRunEntry(entry)) continue;

    const run = runFrom(entry, segment, planningTitles);
    state.results.push(run);
    registerSecondaryMetrics(state, run.metrics);
  }

  return state;
}
