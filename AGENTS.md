# OPC Workbench 协作规则

- Node.js 22.19+、ESM、TypeScript strict；相对源码导入使用 `.ts`，构建时改写为 `.js`。
- 本项目是本机单用户的 Pi 编排与 Agent 工具。保持公共 npm 依赖、标准 Git、本地 Skills 和文件存储；不得加入专用企业平台、内网域名、SSO 或预置私有凭据。
- 开始先检查分支与工作区；保留已有改动。按“定位 → 小范围读取 → 修改 → 定向验证”完成业务闭环，避免无需求的框架化。
- 编排模板、Agent 交互、预算与冻结协议以 `src/orchestration-contract.ts`、`src/agent-protocol.ts` 和 `dev-docs/` 现行文档为准。
- 产品数据和凭据只在用户数据目录；不进入源码、测试快照或安装包。API 不返回模型密钥；日志和轨迹须脱敏。
- 可写 Agent 使用任务 worktree，顺序执行；只读 Agent 不授予 Bash/编辑工具。人工批准的完整正文必须与导出的版本一致。
- 本地 HTTP 仅监听回环地址，拒绝外域 Host 与跨来源请求；没有跨用户权限或远程部署语义。
- 修改后运行相关测试；跨执行器、API、打包边界时运行 `npm run check`、`npm test`、`npm run check:standalone`、`npm pack`。文档变化运行 `npm run check:current-docs`。
- 不自动发布包、推送 Git 或迁移旧凭据；用户明确要求时再执行。
