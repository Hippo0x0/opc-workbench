# 运行与打包

- 公共 npm 依赖和 package-lock.json 是安装事实源。使用 `npm ci`，禁止依赖同机其他仓库的 node_modules。
- 源码位于 `src/`、`web/src/`；构建产物为 `build/` 与 `web/dist/`，均不提交。`scripts/copy-assets.mjs` 复制可选 Linux 权限辅助程序。
- 开发检查：`npm run check`、`npm test`、`npm run check:standalone`。文档检查：`npm run check:current-docs`。测试模型为本机模拟服务，真实 Pi 子进程会执行工具和生成会话。
- `npm pack` 的 prepack 会校验类型、构建并检查项目独立性。安装包仅包含 bin、build、web/dist、README、LICENSE、NOTICE；不包含项目凭据、任务、缓存与原始运行数据。
- `opc-workbench serve` 默认端口 4310，可用 `--port` 指定；服务只绑定 127.0.0.1。`OPC_HOME` 改变 CLI 与 Agent 的默认数据根。serve 的 `--data-dir` 是该服务的覆盖项，单独启动 agent 时应使用相同 OPC_HOME。
- Pi models.json 与 auth.json 位于数据根下 agent 目录。API 仅返回配置存在状态，不返回密钥，不复制其他产品登录态。
- 本地 package 构建不等于 npm 发布；发布、推送与公开仓库创建均须用户明确要求。
- 删除 Run 前必须停止执行。仓库取消登记不删除源目录，克隆的缓存和 Skill 历史版本也不会被隐式递归删除。
