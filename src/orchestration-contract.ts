import type { ResearchBudget } from "./types.ts";
import type { AgentActionBinding, AgentCapability, AgentInteractionDefinition } from "./agent-protocol.ts";
export interface OrchestrationSkill { id: string; name: string; description: string; directory: string; hash: string; content: string }
export interface OrchestrationNode {
  id: string; agentId?: string; baseAgentId?: string; name: string; prompt: string; skillIds: string[]; readOnly: boolean;
  agentVersion?: 1; outputSchemaId?: "markdown-result-v1";
  kind: "agent" | "approval" | "export"; parallel: boolean; placement?: "up" | "down";
  /** Agent 定义可提供的交互；自定义 Agent 随节点定义一起冻结。 */
  interactions?: AgentInteractionDefinition[];
  capabilities?: AgentCapability[];
  /** 本次节点选择启用的交互与从用户动作到已定义节点的连接。 */
  enabledInteractions?: string[];
  actions?: AgentActionBinding[];
}
export interface OrchestrationTemplate { id: string; name: string; description: string; version: number; system: boolean; nodes: OrchestrationNode[] }
export interface ContextSection { title: string; source: string; content: string }
export interface OrchestrationInput { templateId: string; templateVersion: number; title: string; description: string; repositoryIds: string[]; skillIds: string[]; supplement: string; budget?: Partial<ResearchBudget> }
export interface FrozenOrchestration { protocolVersion?: 1; template: OrchestrationTemplate; skills: OrchestrationSkill[]; input: OrchestrationInput; repositories: Array<{id: string; path: string; name: string; commit:string}>; hash: string }
export interface NativeAutoresearchView { dashboardUrl: string; runCount: number; bestMetric: number | null; metricName: string; metricUnit: string; tokenUsage: number; progressLabel: string }
export interface OrchestrationNodeResult { nativeAutoresearch?: NativeAutoresearchView; nativeExperimentStarted?: boolean; status: "waiting" | "running" | "completed" | "blocked" | "review" | "skipped"; agentStatus?: "OK" | "DEGRADED" | "FAILED" | "CANCELLED"; gaps?: string[]; output?: string; startedAt?: string; finishedAt?: string; durationMs?: number; error?: string; url?: string; approvedBy?: string; digest?: string; sections?: ContextSection[]; supplementalPrompt?: string; preRunInteractionId?: string; preRunInputs?: Record<string,string>; selectedActionId?: string; actionInputs?: Record<string,string> }
export interface OrchestrationMessage { id: string; nodeId: string; text: string; createdAt: string; status: "waiting" | "delivering" | "delivered" | "undelivered" | "chatting" | "replied"; error?: string }
export interface RepositoryBinding { id:string; nodeId:string; preparedAt:string; url:string; name:string; role:"main"|"dependency"|"context"; evidence:string[]; status:"ready"|"unavailable"; path?:string; baseCommit?:string; reason?:string }
export interface OrchestrationRun { id: string; title: string; createdAt: string; updatedAt: string; owner: string; model: string; status: "RUNNING" | "PAUSED" | "BLOCKED" | "REVIEW_REQUIRED" | "COMPLETED" | "CANCELLED"; frozen: FrozenOrchestration; nodes: Record<string, OrchestrationNodeResult>; /** 旧节点结果只供追溯，不能进入后续节点输入。 */ history?: Array<{nodeId:string;at:string;result:OrchestrationNodeResult}>; pendingTransition?: {sourceNodeId:string;targetNodeId:string;actionId:string;inputs:Record<string,string>}; messages?: OrchestrationMessage[]; agentTimeoutMinutes?: number | null; runWallTimeMinutes?: number|null; agentInvocations?: number; cwd: string; error?: string; repositoryBindings?:RepositoryBinding[]; repositoryPreparation?:{nodeId:string;required?:boolean;summary:string;gaps:string[];records:RepositoryBinding[]} }
