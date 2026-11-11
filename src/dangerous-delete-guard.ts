import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 防误操作检查，不是完整 shell 解释器或 Python/Node 系统调用沙箱。
const WORDS = /(?:\\.|'[^']*'|"(?:\\.|[^"\\])*"|[^\s;&|()])+|[;&|()\n]/gu;
const DELETE = new Set(["rm", "rmdir", "unlink"]);

function expand(word: string, env: NodeJS.ProcessEnv): string | undefined {
  if (word.includes("$(") || word.includes("`")) return undefined;
  let unknown = false;
  const result = word.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|([^'"]+)/gu, (_, literal, quoted, plain) => {
    if (literal !== undefined) return literal;
    return String(quoted ?? plain).replace(/\\(.)|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
      (_match, escaped, braced, name) => {
        if (escaped !== undefined) return escaped;
        const value = env[braced ?? name];
        if (value === undefined) unknown = true;
        return value ?? "";
      });
  });
  if (unknown || result.includes("$") || !result) return undefined;
  if (result.startsWith("~") && result !== "~" && !result.startsWith("~/")) return undefined;
  return result === "~" ? env.HOME ?? os.homedir()
    : result.startsWith("~/") ? path.join(env.HOME ?? os.homedir(), result.slice(2)) : result;
}

function resolvedTarget(value: string, cwd: string): string {
  const absolute = path.resolve(cwd, value);
  let existing = absolute;
  const tail: string[] = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    tail.unshift(path.basename(existing)); existing = path.dirname(existing);
  }
  try { return path.resolve(fs.realpathSync(existing), ...tail); } catch { return absolute; }
}

/** 拦截高层目录及其通配清空；正常仓库和构建目录清理不受限制。 */
export function dangerousDeleteReason(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME ?? os.homedir();
  const protectedPaths = new Set(["/", "/home", "/root", "/tmp", "/var", "/usr", "/etc", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/data", home]
    .map(value => resolvedTarget(value, cwd)));
  const reason = "已拦截高风险删除：不能删除或清空根目录、HOME 或系统高层目录；请指定具体文件或子目录";
  const uncertain = "无法确定删除范围，命令未执行；请把删除目标改为明确的具体路径";
  // 不求值 shell 内赋值；它可能覆盖传入环境，使用这些变量的删除需明确路径。
  env = { ...env };
  for (const assignment of command.matchAll(/(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=/gu)) delete env[assignment[1]!];
  let directory: string | undefined = cwd;
  const segments: string[][] = [[]];
  for (const token of command.match(WORDS) ?? []) {
    if ([";", "&", "|", "(", ")", "\n"].includes(token)) segments.push([]);
    else segments.at(-1)!.push(token);
  }
  for (const words of segments) {
    if (!words.length) continue;
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index] ?? "")) index++;
    const executable = path.basename(words[index] ?? "");
    if (["bash", "sh"].includes(executable) && words.includes("-c")) {
      const body = words[words.indexOf("-c") + 1];
      if (body) {
        const nested = dangerousDeleteReason(body.replace(/^(['"])([\s\S]*)\1$/u, "$2"), directory ?? cwd, env);
        if (nested) return nested;
      }
    }
    if (executable === "cd" || executable === "pushd") {
      const target = expand(words[index + (words[index + 1] === "--" ? 2 : 1)] ?? "~", { ...env, PWD: directory });
      directory = target && directory ? resolvedTarget(target, directory) : undefined;
      continue;
    }
    if (["sudo", "command", "env"].includes(executable)) {
      const found = words.findIndex((word, i) => i > index && DELETE.has(path.basename(word)));
      if (found >= 0) index = found;
    }
    const name = path.basename(words[index] ?? "");
    const findDelete = name === "find" && words.some(word => word === "-delete" || DELETE.has(path.basename(word)));
    if (!DELETE.has(name) && !findDelete) continue;
    const targets = findDelete ? words.slice(index + 1, words.findIndex((word, i) => i > index && word.startsWith("-")))
      : words.slice(index + 1).filter(word => !word.startsWith("-"));
    if (findDelete && !targets.length) targets.push(".");
    for (const raw of targets) {
      const value = expand(raw, { ...env, PWD: directory });
      if (!value || !directory) return uncertain;
      const glob = value.search(/[*?\[{]/u);
      const target = glob >= 0 ? path.dirname(value.slice(0, glob) + "placeholder") : value;
      if (protectedPaths.has(resolvedTarget(target, directory))) return reason;
      if (glob >= 0 && value.slice(glob).includes("/")) return uncertain;
    }
  }
  return undefined;
}
