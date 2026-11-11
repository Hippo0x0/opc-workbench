# 本地 API 契约

地址为 `http://127.0.0.1:4310`，API 根路径 `/api/workbench`。这是本机单用户 API，不提供公网或跨用户语义。所有写请求体为 JSON，最大 1 MB；跨来源请求与非本机 Host 拒绝。错误返回 `{ "error": "中文原因" }`。

| 方法 | 路径（省略根前缀） | 作用 |
| --- | --- | --- |
| GET | `/health` | 产品名、健康状态 |
| GET / PUT | `/settings` | 读取/保存默认 model、agentMinutes、runWallTimeMinutes；不返回密钥 |
| GET | `/chat` | 当前首页会话、messages、busy 和默认 model |
| POST | `/chat/messages` | text；启动真实 Pi 回复，202 返回当前会话；忙时 409 |
| POST | `/chat/stop` | 空 JSON；停止当前回复并保留已显示内容 |
| POST | `/chat/new` | 空 JSON；新建会话并保留旧记录；忙时 409 |
| PUT | `/models/auth` | provider、apiKey；通过 Pi AuthStorage 保存，返回 ok/provider，不回显密钥 |
| GET | `/models` | Pi 模型目录和模型可用认证状态；不验证网络或配额 |
| GET / POST / DELETE | `/runtime/repositories` | 列举/登记/取消仓库登记；POST 接收 path 或 url；DELETE 查询参数 id |
| GET | `/orchestration/catalog` | templates、agents、skills |
| POST / DELETE | `/orchestration/templates` | 保存版本化自定义模板；删除用查询参数 id |
| GET / POST / PUT / DELETE | `/orchestration/skills` | 列举、本地导入、按来源更新、移除登记；DELETE 用 id |
| PUT | `/orchestration/skills/agents` | agentId、skillIds 默认绑定 |
| POST | `/orchestration/preview` | 冻结模板版本、输入、仓库提交与 Skills，返回 frozen.hash、sections |
| GET / POST | `/orchestration/runs` | 列举/创建；POST 必须携带预览的 contextHash，材料变化时拒绝 |
| GET / DELETE | `/orchestration/runs/{id}` | 读取/删除已停止的 Run；删除包括其独立 worktree |
| POST | `/orchestration/runs/{id}/control` | 操作状态机与审批 |
| POST | `/orchestration/runs/{id}/messages` | nodeId、text，运行中 steering 或结束后只读会话 |
| POST | `/orchestration/runs/{id}/messages/{messageId}/as-chat` | 将未送达消息转为结束节点的只读会话 |
| GET | `/orchestration/runs/{id}/trace` | stageId、limit、after/before 分页；返回 items、cursor、hasMoreBefore |
| GET | `/orchestration/runs/{id}/report` | 下载已批准并导出的 Markdown |

创建体：templateId、templateVersion、title、description、repositoryIds、skillIds、supplement、contextHash；可选 budget 包含 maxConcurrency、maxAgentInvocations、maxWallTimeMinutes、stageTimeoutMinutes。协议类型见 `src/orchestration-contract.ts`。

控制 action 为 pause、cancel、resume、retry、continue、skip、approve、submit-before-run、select-action。节点操作携带 nodeId；continue 可携带 supplementalPrompt；approve、submit-before-run、select-action 必须携带当前 digest。before-run 和 after-result 的输入与动作以冻结 Agent 交互定义为准，可写节点不可跳过。

Run 状态为 RUNNING、PAUSED、BLOCKED、REVIEW_REQUIRED、COMPLETED、CANCELLED。取消保留证据，可由用户显式恢复；完成态不能继续改写流水线。

首页对话与 Run 生命周期独立，共用默认模型和单次 Agent 调用时限。会话消息包含 id、role、text、at、status 和可选 error；status 为 completed、streaming、failed 或 cancelled。GET 读取进行中的文本，供页面逐步显示；POST 不接受客户端提供会话文件路径或模型密钥。模型为空时拒绝发送并提示个人设置，不写入失败的用户消息。个人设置页面路径为 `/account/`；模型与认证、预算在该独立页面管理。
