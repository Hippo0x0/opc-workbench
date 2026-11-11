import fs from "node:fs";
import path from "node:path";
import type { CommandRunner } from "./command.ts";

/** Git 对象大小只是完整检出的下界，不含文件块、索引及 checkout filter 的额外开销。 */
export async function checkoutResearchWorktree(input: {
  source: string; target: string; commit:string; env: NodeJS.ProcessEnv; signal?: AbortSignal; commandRunner: CommandRunner;
}): Promise<void> {
  const directory = path.dirname(input.target);
  let requiredBytes = 0, pending = "", streamed = false, invalid = false;
  const consume = (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n"); pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "-") continue; // gitlink 没有本仓可展开的 blob 大小。
      if (!/^\d+$/u.test(line)) { invalid = true; continue; }
      requiredBytes += Number(line);
    }
  };
  const estimate = await input.commandRunner("git", ["-C", input.source, "ls-tree", "-r", "--format=%(objectsize)", input.commit], {
    env: { ...input.env, GIT_NO_LAZY_FETCH: "1" }, signal: input.signal, timeoutMs: 60_000, maxOutputBytes: 1024,
    onStdout(chunk) { streamed = true; consume(chunk); },
  });
  if (!streamed) consume(estimate.stdout);
  if (pending) consume("\n");
  if (invalid || !Number.isSafeInteger(requiredBytes)) throw new Error("Git 返回的检出空间估算无效");
  const disk = fs.statfsSync(directory), availableBytes = disk.bavail * disk.bsize;
  const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);
  if (requiredBytes > availableBytes) {
    throw new Error(`Git worktree 检出空间不足：目标目录 ${input.target}，所在磁盘可用 ${gib(availableBytes)} GiB，` +
      `仓库完整检出至少需要 ${gib(requiredBytes)} GiB（尚不含索引、文件块和过滤器开销）。请清理该目标盘或将研究目录迁移至容量足够的数据盘后重试；实验尚未开始。`);
  }
  const result = await input.commandRunner("git", ["-C", input.source, "worktree", "add", "--detach", input.target, input.commit], {
    env: input.env, signal: input.signal, timeoutMs: 60_000, maxOutputBytes: 64 * 1024, rejectOnNonZero: false,
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(-2000);
    const diskFull = /No space left on device|ENOSPC|Disk quota exceeded/iu.test(result.stderr);
    const summary = diskFull ? "Git worktree 检出失败：目标磁盘空间或配额不足" : `Git worktree 检出失败（退出码 ${result.exitCode}）`;
    throw new Error(`${summary}；目标目录 ${input.target}${detail ? `。${detail}` : ""}` +
      (diskFull ? "。请清理该目标盘或扩容后重试；实验尚未开始。" : ""));
  }
}
