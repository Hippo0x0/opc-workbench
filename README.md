# OPC Workbench

基于 Pi 的本地编排与 Agent 工作台：连接 Git 仓库与 Skills，执行研究、开发和实验，逐节点查看上下文、工具轨迹与结果。

需要 Node.js 22.19+、npm 和 Git。服务只监听 `127.0.0.1`，面向本机单用户。

## 从源码启动

```bash
npm ci
npm run build
node bin/opc-workbench.mjs --help
node bin/opc-workbench.mjs serve
```

浏览器访问 `http://127.0.0.1:4310`。源码已构建后，也可用 `npm start`。

## 配置模型

工作台直接调用 Pi 0.80.3，使用其通用 provider、API Key、OAuth、模型目录和会话能力。

例如，先在启动工作台的终端设置所选 provider 的标准环境变量，再在独立的「个人设置」页面（`/account/`）选择 `provider/model`。支持 OAuth 的 provider 可以在 Pi 会话中用 `/login` 配置：

```bash
node bin/opc-workbench.mjs agent
```

个人设置页也支持保存通用 provider 的 API Key，只写入本机 Pi 认证文件，不会读取或回显已保存的密钥。

安装包使用 `opc-workbench agent`。Pi 的认证与自定义模型文件位于 `~/.opc-workbench/agent/auth.json`、`models.json`，不会读取其他产品的专用配置目录。环境变量 `OPC_HOME` 可指定整个工作台的数据根目录。

本地 OpenAI 兼容服务也可配置到 `models.json`，例如已在本机启动的 Ollama：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

这里的 `apiKey` 是本地服务占位值；模型需事先在本地服务安装。不要把真实凭据提交到仓库。

## 首页对话

首页输入框连接真实 Pi 会话，支持连续对话、逐步显示回复、停止回复和刷新后恢复消息。发送消息会留在首页，不自动新建研究 Run。点击「创建研究任务」或研究类型入口时，才进入编排选择与上下文预览。

对话数据与 Pi 会话保存在数据根的 `chat/` 下；「新对话」保留上一段记录并开始独立会话。首页对话只授予读取工具；创建任务和修改配置通过对应页面完成。模型未配置或调用失败时显示明确原因，不把失败当作正常回复。

## 创建任务

1. 在「仓库」登记 Git 根目录，或显式提供 HTTPS/SSH URL 克隆。认证使用标准 Git credential helper 或 SSH Agent，URL 不接受内嵌密码与 Token。
2. 按需在「Skills」导入包含 `SKILL.md` 的完整本地目录，并为 Agent 选择默认 Skills。
3. 选择编排模板、填写任务和补充指令，预览每个节点的上下文，然后创建。
4. 在运行详情查看工具输入、输出、Token 用量、节点产物；可暂停、恢复、重试、补充指令，或与节点会话继续对话。
5. 人工确认页面展示完整报告；批准后将同一正文导出为本地 `report.md`。

内置通用研究、需求研究、方案研究、代码审查、故障排查、问题调查、性能优化、需求开发、Pi AutoResearch 共九种模板。可复制为自定义模板，调整 Agent、提示词、Skills、只读并行组与人工动作连接。系统模板和自定义模板使用同一个执行器。

每个任务冻结模板、Skills 完整副本及哈希、仓库 HEAD 和输入。仓库在任务独立 worktree 中执行，原目录的未提交改动不会进入任务。可写 Agent 顺序执行；只读节点可以并行。上下文预览后材料变化时须重新预览。

## 实验

实验节点使用 `init_experiment`、`run_experiment`、`log_experiment`，保留 `autoresearch.jsonl`、命令原始证据（每流最多 8 MiB，超限可能截断）、Git diff 与状态，以及工具轨迹。`keep/discard` 是实验记录，**不自动重置 Git 或回滚文件**；候选恢复由 Agent 在工作目录内执行。显式要求的轮次未完成时节点阻塞，可继续执行。

本地资料、代码与显式导入的 Skills 提供检索能力。额外知识源、网页检索或外部系统可由用户安装的通用 Skill 提供，工作台没有内置公司平台适配器。

## 数据与预算

| 项目 | 默认值 / 位置 |
| --- | --- |
| 数据根目录 | `~/.opc-workbench`；`OPC_HOME` 或 `serve --data-dir` 可覆盖 |
| 运行状态、会话、轨迹、报告 | `orchestration-runs/<runId>/` |
| 本地 Skill 版本 | `.orchestration/skill-library/` |
| Git 登记 | `repositories.json` |
| 模型、预算配置 | `settings.json` |
| Pi 认证和模型配置 | `agent/` |
| 单次 Agent 调用时限 | 60 分钟 |
| Run 总历时上限 | 360 分钟，包含暂停与等待人工确认 |
| 同组只读节点并发 | 3；可在创建 Run 的 budget 中显式配置 |

预算在创建任务时冻结；新设置仅影响新任务。这里的 60 分钟是单次模型 Agent 调用的历时，不是扣除模型排队后的活跃计算时间。Run 总历时在启动模型调用前检查；手动恢复已超预算任务会阻塞下一次调用。模型供应商配额由其服务端管理，工作台不冒充精确 TPM 计量器。

这是可信本机开发工具。只读节点只提供读取工具；编辑工具限制在任务目录。可写节点的 Bash 使用宿主用户权限并保留防误删检查；Git worktree 负责隔离代码变更，不是操作系统安全沙箱。可选严格 Linux Bash 隔离需要 Bubblewrap 等系统能力，参见源码中的 `OPC_RESEARCH_BASH_ISOLATION`。

## 开发与打包

```bash
npm run check
npm test
npm run check:standalone
npm run check:current-docs
npm pack
```

`npm test` 会构建并运行编排、Git、HTTP 与真实 Pi RPC 测试。测试模型是本机 OpenAI 兼容模拟服务，不消耗外部模型额度。真实 provider 网络、权限和配额需使用自己的通用模型配置验证。

`npm pack` 生成 `opc-workbench-0.1.0.tgz`；可用 `npm install -g ./opc-workbench-0.1.0.tgz` 安装。打包不会执行发布。安装包只包含编译产物、页面、启动入口与用户说明，不包含运行数据或凭据。

内部事实源见 [开发文档](dev-docs/README.md)。
