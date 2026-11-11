import type { OrchestrationRun } from "../../src/orchestration-contract.ts";
import { OrchestrationOutput } from "./OrchestrationOutput.tsx";
import "./repository-discovery.css";

type Preparation = NonNullable<OrchestrationRun["repositoryPreparation"]>;
const roles = { main: "主仓库", dependency: "源码依赖", context: "上下文仓库" };
function webUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* SSH 地址仍可作为文本查看。 */ }
  return undefined;
}

export function RepositoryDiscoveryReport({ preparation, output }: { preparation: Preparation; output: string }) {
  const ready = preparation.records.filter(record => record.status === "ready").length;
  const unavailable = preparation.records.length - ready;
  const gaps = [...new Set(preparation.gaps)].filter(gap => !preparation.records.some(record => record.reason === gap));
  return <div className="repo-discovery">
    <div className="repo-discovery-overview">
      <p>{preparation.summary}</p>
      {preparation.records.length > 0 && <div className="repo-discovery-counts" aria-label="仓库准备概况">
        <span className="repo-discovery-status ready">{ready} 个已就绪</span>
        {unavailable > 0 && <span className="repo-discovery-status unavailable">{unavailable} 个未就绪</span>}
      </div>}
    </div>
    {preparation.records.length === 0 && <p className="repo-discovery-empty">{preparation.required === false ? "本次任务无需代码仓库。" : "尚未准备好可供下游使用的仓库。"}</p>}
    <div className="repo-discovery-list">{preparation.records.map((record, index) => {
      const href = webUrl(record.url);
      return <article className="repo-discovery-card" key={`${record.id}:${index}`}>
        <div className="repo-discovery-heading"><div><span className="repo-discovery-role">{roles[record.role]}</span><h3>{record.name}</h3></div>
          <span className={`repo-discovery-status ${record.status}`}>{record.status === "ready" ? "已就绪" : "未就绪"}</span></div>
        {record.url && <p className="repo-discovery-url">{href ? <a href={href} target="_blank" rel="noreferrer">{record.url} ↗</a> : record.url}</p>}
        {(record.path || record.baseCommit) && <dl className="repo-discovery-metadata">
          {record.path && <><dt>本地路径</dt><dd><code>{record.path}</code></dd></>}
          {record.baseCommit && <><dt>基准提交</dt><dd><code title={record.baseCommit}>{record.baseCommit.slice(0, 12)}</code></dd></>}
        </dl>}
        {record.reason && <p className="repo-discovery-reason">{record.reason}</p>}
        {record.evidence.length > 0 && <details className="repo-discovery-evidence"><summary>定位依据 · {record.evidence.length} 条</summary>
          <ul>{record.evidence.map((evidence, evidenceIndex) => <li key={evidenceIndex}>{evidence}</li>)}</ul>
        </details>}
      </article>;
    })}</div>
    {gaps.length > 0 && <aside className="repo-discovery-gaps"><h3>待确认事项</h3><ul>{gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></aside>}
    <details className="repo-discovery-original"><summary>原始产物</summary><OrchestrationOutput output={output}/></details>
  </div>;
}
