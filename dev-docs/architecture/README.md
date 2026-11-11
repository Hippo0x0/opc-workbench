# 架构与执行边界

产品是本机单用户工具。`bin/opc-workbench.mjs` 启动编译后的 CLI；`agent` 子命令直接运行上游 Pi。默认数据根为 `~/.opc-workbench`，不依赖其他产品目录。

- `src/orchestration-runtime.ts` 拥有 Run 状态机、冻结上下文、串并行组、审批与后续节点连接。运行状态保存在原子替换的 `state.json`。进程重启后，未完成任务转为 BLOCKED，须用户恢复，不自动重复外部写入。
- `src/orchestration-catalog.ts` 拥有模板版本、Agent 定义校验和 Skill 绑定。系统模板只读，用户可复制修改。只读并行组完成后汇合；可写节点禁止并行。
- `src/agent.ts` 通过上游 Pi `RpcClient` 启动真正的 Agent 子进程，保留会话和 steering。只读节点工具白名单为 read/grep/find/ls；工具收集和模型配置不经过自建模型代理。
- `src/experiment-extension.ts` 提供测量和轮次记录工具，原始命令输出保存到 `.experiments`，正式记录保存在 `autoresearch.jsonl`。结果不自动执行 Git 回滚。
- `src/runtime-management.ts` 登记本地 Git 根目录或显式克隆的通用 Git URL。每个 Run 冻结 HEAD，并在自己的工作目录准备 detached worktree。Run 删除时注销其 worktree，不删除登记源仓库。
- `src/skill-library.ts` 导入完整本地 Skill 副本并保留版本；Run 再冻结所选版本，不自动扫描和导入用户其他工具的 Skills。符号链接包拒绝导入。
- `src/trace.ts` 保存模型/工具事件和 Token 信息，先脱敏再写入；交叉验证读取当前 Run 的原始证据。原始工具轨迹的展示副本有字符上限，不能冒充完整测量日志。
- `src/server.ts` 提供 `/api/workbench/*` 与构建后的 React 页面。只监听回环地址，单一身份为 `local`，不连接数据库或远程管理端。

审批材料包含完整正文及前序产物摘要哈希；提交旧摘要会拒绝。批准后导出直接复制审批正文，不再调用模型改写。模板或 Skill 的后续修改只影响新任务。

预算创建时冻结。单次 Agent 调用默认 60 分钟；Run 总历时默认 360 分钟，并在每次模型调用前核对。测试使用注入 Agent 或本机模型模拟服务，不使用真实生产账号。

首页对话由 `src/chat.ts` 管理，复用同一 Pi session.jsonl 保持上下文。单用户同一会话一次只接受一个回复；第二个发送返回冲突，可显式停止或在结束后继续。消息与失败状态写入 chat/conversation.json；开始新对话前归档旧记录。进程重启时将未完成回复标记中断，不自动重发。`AgentRunInput.onTextDelta` 向页面提供已生成正文；页面轮询当前会话逐步展示，不额外消耗模型请求。

`web/src/PersonalSettings.tsx` 是独立的个人设置页面，负责默认模型、预算与通用 provider API Key 输入。认证写入复用上游 Pi AuthStorage，文件权限 0600；API 和页面不读取、回显凭据值。首页对话在未配置模型时引导该页面。

对话编排由 `src/chat-orchestration.ts` 解析明确的 opc-orchestration 输出块，生成规范化草案。模型上下文包含当前 Agent、Skills 元数据、模板拓扑和上一份草案，内置节点压缩为引用以避免重复提示词。草案生成复用 catalog.validate，不授予 Pi 文件写工具；确认保存复用 catalog.save 与现有模板版本检查，系统模板只复制。草案与来源版本随对话保存，用户可继续对话调整；来源版本变化时拒绝覆盖。

`web/src/ChatTemplateDraft.tsx` 展示可查看的节点、提示词和完整配置，再调用保存接口。`web/src/HomeChat.tsx` 的轨迹面板复用 AgentTrace；Run 和对话的轨迹分页由 `src/trace.ts` 同一函数提供，无外部观测平台依赖。
