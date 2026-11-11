import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** 少数调用方需要自行按退出码组装稳定错误契约；默认仍保持非零退出即 reject。 */
  rejectOnNonZero?: boolean;
  /** 独立交互执行在取消时一并结束包装器及其子进程；不影响其它运行任务。 */
  killProcessGroup?: boolean;
  /** 增量消费 stdout；调用方负责有界解析，不改变命令结果。 */
  onStdout?: (chunk: string) => void;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/**
 * Wrapper 子进程执行器。错误信息故意不回显 argv：解析 prompt 里包含完整
 * Issue/评论，若像通用 command runner 那样拼接 argv，会把用户内容带进日志。
 */
export function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${command} 执行已取消`));
      return;
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxOutputBytes = options.maxOutputBytes ?? 512 * 1024;
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";

    const processGroup = options.killProcessGroup === true && process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: processGroup,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const kill = (signal: NodeJS.Signals) => {
      if (processGroup && child.pid) {
        try { process.kill(-child.pid, signal); } catch { /* 执行组已经退出。 */ }
      } else child.kill(signal);
    };
    const stop = () => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 1_000).unref?.();
    };
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs) : null;
    timer?.unref?.();

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const appendBounded = (current: string, chunk: unknown): string =>
      `${current}${String(chunk)}`.slice(-maxOutputBytes);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => {
        // 子进程提前退出时由 close/error 事件返回最终结果。
      });
      child.stdin?.end(options.stdin);
    }
    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
      options.onStdout?.(String(chunk));
    });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", (error) => finish(() => reject(new Error(`无法启动 ${command}：${error.message}`))));
    child.once("close", (exitCode, signal) => finish(() => {
      if (options.signal?.aborted) {
        reject(new Error(`${command} 执行已取消`));
        return;
      }
      if (timedOut) {
        reject(new Error(`${command} 执行超时（${timeoutMs}ms）`));
        return;
      }
      const result = { exitCode, signal, stdout, stderr };
      if (exitCode === 0 || options.rejectOnNonZero === false) {
        resolve(result);
        return;
      }
      const detail = stderr.trim().slice(0, 1_000);
      reject(new Error(`${command} 执行失败（退出码 ${exitCode}）${detail ? `：${detail}` : ""}`));
    }));
  });
}
