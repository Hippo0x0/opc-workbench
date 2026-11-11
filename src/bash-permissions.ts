import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCommand, type CommandRunner } from "./command.ts";
import { dangerousDeleteReason } from "./dangerous-delete-guard.ts";

/** 不解析或改写模型 shell；权限由内核挂载及命名空间施加，子进程不能解除。 */
export function bashSandboxArgs(cwd: string, readOnly: boolean, command: string): string[] {
  const directory = fs.realpathSync(cwd);
  if (!fs.statSync(directory).isDirectory()) throw new Error("Bash 工作目录必须是目录");
  const forbidden = ["/", "/home", "/tmp", "/var", os.homedir()];
  if (forbidden.includes(directory) || ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/dev", "/proc", "/sys", "/run"]
    .some(root => directory === root || directory.startsWith(`${root}/`))) {
    throw new Error("Bash 必须使用具体任务工作目录，不能授权用户主目录或系统目录");
  }
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL", "--clearenv"];
  // 从空挂载空间开始。不能 ro-bind /，否则仍可能连到宿主 Unix socket。
  for (const root of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    if (fs.existsSync(root)) args.push("--ro-bind", root, root);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run",
    "--dir", "/run/agent-home", readOnly ? "--ro-bind" : "--bind", directory, directory,
    "--chdir", directory, "--setenv", "HOME", "/run/agent-home", "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
    "--", "/bin/bash", "--noprofile", "--norc", "-c", command);
  return args;
}

export async function executeSandboxedBash(input: {
  cwd: string; readOnly: boolean; command: string; signal?: AbortSignal; timeout?: number;
  env?: NodeJS.ProcessEnv;
  artifactDirectory?: string;
  onData(data: Buffer): void;
}, runner: CommandRunner = runCommand): Promise<{ exitCode: number | null }> {
  const executionEnv = { ...process.env, ...input.env };
  const blocked = dangerousDeleteReason(input.command, input.cwd, executionEnv);
  if (blocked) throw new Error(blocked);
  // 默认只防灾难性误删；严格隔离必须显式开启，失败时不自动降级。
  if (executionEnv.OPC_RESEARCH_BASH_ISOLATION !== "1") {
    const result = await runner("/bin/bash", ["--noprofile", "--norc", "-c", input.command], {
      cwd: input.cwd, env: executionEnv, signal: input.signal, killProcessGroup: true,
      timeoutMs: input.timeout === undefined ? 0 : input.timeout * 1000,
      maxOutputBytes: 512 * 1024, rejectOnNonZero: false,
      onStdout: chunk => input.onData(Buffer.from(chunk)),
    });
    if (result.stderr) input.onData(Buffer.from(result.stderr));
    return { exitCode: result.exitCode };
  }
  if (process.platform !== "linux") throw new Error("当前平台未提供受限 Bash 执行器，已拒绝宿主机执行");
  if (input.readOnly) {
    const helper = fileURLToPath(new URL("./assets/readonly-bash.py", import.meta.url));
    // 沿用具体任务目录校验，绝不把 HOME/系统目录授予写入。
    bashSandboxArgs(input.cwd, true, "true");
    const cwd = fs.realpathSync(input.cwd);
    const roots = ["pr-materials", ".agent-tmp", ".agent-cache"].map(name => {
      const directory = path.join(cwd, name);
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
      if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory
        || !fs.statSync(directory).isDirectory()) throw new Error("Bash 材料或缓存目录无效，不能授权符号链接");
      return directory;
    });
    if (input.artifactDirectory !== undefined) {
      if (input.artifactDirectory !== cwd || fs.existsSync(path.join(cwd, ".git"))) {
        throw new Error("Bash 材料工作区必须是当前无仓库的独立任务目录");
      }
      roots.unshift(cwd);
    }
    const permissionArgs = ["-I", "-S", "-B", helper, "--writable-roots", JSON.stringify(roots)];
    const env = { ...process.env, ...input.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("LD_") || key.startsWith("PYTHON") || ["BASH_ENV", "ENV", "IFS"].includes(key)) delete env[key];
    }
    env.TMPDIR = path.join(cwd, ".agent-tmp");
    env.XDG_CACHE_HOME = path.join(cwd, ".agent-cache");
    env.npm_config_cache = path.join(env.XDG_CACHE_HOME, "npm");
    env.NPM_CONFIG_CACHE = env.npm_config_cache;
    env.PYTHONDONTWRITEBYTECODE = "1";
    const options = { cwd: input.cwd, env, signal: input.signal, killProcessGroup: true, maxOutputBytes: 512 * 1024 };
    try {
      const probe = await runner("/usr/bin/python3", [...permissionArgs, "--probe", "true"], { ...options, timeoutMs: 5_000 });
      if (probe.exitCode !== 0) throw new Error("只读权限探针失败");
    } catch (error) {
      throw new Error("Bash 只读权限不可用，已拒绝执行；需要普通用户、Python 3、libseccomp、seccomp 和 Landlock ABI 3+ 支持", { cause: error });
    }
    const result = await runner("/usr/bin/python3", [...permissionArgs, "--command", input.command], {
      ...options, timeoutMs: input.timeout === undefined ? 0 : input.timeout * 1000, rejectOnNonZero: false,
      onStdout: chunk => input.onData(Buffer.from(chunk)),
    });
    if (result.exitCode === 125 && result.stderr.startsWith("[readonly-bash]")) {
      throw new Error("Bash 只读权限不可用，已拒绝执行", { cause: new Error(result.stderr.trim()) });
    }
    if (result.stderr) input.onData(Buffer.from(result.stderr));
    return { exitCode: result.exitCode };
  }
  const args = bashSandboxArgs(input.cwd, input.readOnly, input.command);
  const probeArgs = bashSandboxArgs(input.cwd, input.readOnly, "true");
  try {
    const probe = await runner("/usr/bin/bwrap", probeArgs, { cwd: input.cwd, env: {}, timeoutMs: 5_000,
      maxOutputBytes: 4096, signal: input.signal, killProcessGroup: true });
    if (probe.exitCode !== 0) throw new Error("隔离探针失败");
  } catch (error) {
    throw new Error("Bash 权限隔离不可用，已拒绝执行；需要管理员提供支持 Bubblewrap/用户命名空间的执行环境，不允许关闭隔离后重试", { cause: error });
  }
  const result = await runner("/usr/bin/bwrap", args, { cwd: input.cwd, env: {},
    timeoutMs: input.timeout === undefined ? 0 : input.timeout * 1000,
    signal: input.signal, killProcessGroup: true, rejectOnNonZero: false,
    onStdout: chunk => input.onData(Buffer.from(chunk)), maxOutputBytes: 512 * 1024 });
  if (result.stderr) input.onData(Buffer.from(result.stderr));
  return { exitCode: result.exitCode };
}

/** 每个 Local Agent 都显式加载；不受 allowedTools 或 disableExtensions 的默认值影响。 */
export default function bashPermissions(pi: ExtensionAPI): void {
  const readOnly = process.env.OPC_RESEARCH_BASH_WRITE !== "workspace";
  const artifactDirectory = process.env.OPC_RESEARCH_BASH_ARTIFACT_DIRECTORY;
  pi.registerTool({ ...createBashToolDefinition(process.cwd(), { operations: {
    exec: (command, cwd, options) => executeSandboxedBash({ cwd, command, readOnly, artifactDirectory, ...options }),
  } }), name: "restricted_bash", label: "受限 Bash",
    description: "执行 Bash，默认拦截删除根目录、HOME 和系统高层目录等高风险删除命令；正常 Git、构建和具体目录清理可用。无法确定删除目标时请改用明确路径。这是命令防误操作检查，不限制任意程序的系统调用。仅当 OPC_RESEARCH_BASH_ISOLATION=1 时额外启用严格 OS 隔离，隔离不可用则拒绝执行。" });
}
