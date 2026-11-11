import { parse as parseYaml } from "yaml";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { OrchestrationSkill } from "./orchestration-contract.ts";
import type { AgentRunInput } from "./agent.ts";

export interface SkillSource { kind: "local"; path?: string }
export interface ManagedSkill extends OrchestrationSkill { version: number; source: SkillSource }
export interface SkillSnapshot { skills: ManagedSkill[]; bindings: Record<string, string[]>; extraIds: string[] }
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
function read<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
function save(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function skillIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20 || value.some(id => typeof id !== "string" || !/^[\w:.-]{1,200}$/u.test(id))) throw new Error("Skill 列表无效");
  return [...new Set(value as string[])];
}
export function skillTree(directory: string): Array<{ name: string; data: Buffer; mode: number }> {
  const files: Array<{ name: string; data: Buffer; mode: number }> = [];
  let bytes = 0;
  function walk(relative: string) {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      if (name === ".git") continue;
      const file = path.join(relative, name), absolute = path.join(directory, file), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("Skill 包内不能包含符号链接，请提供完整文件副本");
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 8 * 1024 * 1024 || files.length >= 4000) throw new Error("Skill 包超过 8 MB 或 4000 个文件");
        files.push({ name: file, data: fs.readFileSync(absolute), mode: 0o600 | (stat.mode & 0o111) });
      } else throw new Error("Skill 包含不支持的文件类型");
    }
  }
  walk("");
  if (!files.some(file => file.name === "SKILL.md")) throw new Error("请选择包含 SKILL.md 的目录");
  return files;
}
export const skillTreeHash = (files: ReturnType<typeof skillTree>) => hash(JSON.stringify(files.map(file => [file.name, file.mode, hash(file.data)])));
function copy(files: ReturnType<typeof skillTree>, target: string) {
  for (const file of files) {
    const destination = path.join(target, file.name);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, file.data, { mode: file.mode });
  }
}
export function createSkillLibrary(root: string) {
  const base = path.join(root, ".orchestration", "skill-library"), registry = path.join(base, "registry.json");
  const list = () => read<ManagedSkill[]>(registry, []);
  const bindingsFile = path.join(base, "agent-bindings.json");
  const bindings = () => read<Record<string, string[]>>(bindingsFile, {});
  function get(id: string) { const skill = list().find(item => item.id === id); if (!skill) throw new Error("Skill 不存在"); return skill; }
  function importDirectory(directory: string, options: { name?: string; updateId?: string; legacyId?: string; source?: SkillSource } = {}) {
    const real = fs.realpathSync(directory), files = skillTree(real);
    const file = files.find(item => item.name === "SKILL.md")!;
    let content = file.data.toString("utf8");
    if (file.data.length > 128 * 1024) throw new Error("SKILL.md 超过 128 KB");
    const header = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1] ?? "";
    const metadata: unknown = header ? parseYaml(header) : {};
    const field = (key: string): string | undefined => metadata && typeof metadata === "object" && key in metadata && typeof (metadata as Record<string, unknown>)[key] === "string" ? ((metadata as Record<string, unknown>)[key] as string).trim() : undefined;
    const name = (options.name ?? field("name") ?? path.basename(real)).trim();
    if (!name || name.length > 100 || /[\r\n\x00-\x1f]/u.test(name)) throw new Error("Skill 名称无效");
    const all = list(), previous = options.updateId ? get(options.updateId) : undefined;
    if (previous && name !== previous.name) throw new Error("更新不能改变 Skill 名称，请重新导入");
    if (all.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase() && item.id !== previous?.id)) throw new Error("Skill 名称已存在，请改名后重新导入");
    if (options.name) {
      content = /^---\r?\n/u.test(content)
        ? content.replace(/^---\r?\n([\s\S]*?)\r?\n---/u, (_, body: string) => `---\n${/^name:/mu.test(body) ? body.replace(/^name:.*$/mu, `name: ${JSON.stringify(name)}`) : `name: ${JSON.stringify(name)}\n${body}`}\n---`)
        : `---\nname: ${JSON.stringify(name)}\n---\n${content}`;
      file.data = Buffer.from(content);
    }
    const id = previous?.id ?? options.legacyId ?? randomUUID(), version = (previous?.version ?? 0) + 1;
    if (!/^[\w-]{1,200}$/u.test(id)) throw new Error("Skill ID 无效");
    const target = path.join(base, id, `v${version}`);
    if (fs.existsSync(target)) throw new Error("Skill 版本目录已存在，请刷新后重试");
    copy(files, target);
    const skill: ManagedSkill = { id, name, description: field("description") ?? "查看 SKILL.md 了解使用方式", directory: target,
      content, hash: skillTreeHash(files), version, source: options.source ?? previous?.source ?? { kind: "local", path: real } };
    save(registry, [...all.filter(item => item.id !== id), skill]);
    return skill;
  }
  return { list, get, importDirectory, bindings,
    setBindings(agentId: string, value: unknown) {
      if (!/^[\w-]{1,100}$/u.test(agentId)) throw new Error("Agent ID 无效");
      const selected = skillIds(value); selected.forEach(get);
      const all = bindings(); all[agentId] = selected; save(bindingsFile, all); return selected;
    },
    remove(id: string, references: string[]) {
      get(id);
      const defaults = Object.entries(bindings()).filter(([, values]) => values.includes(id)).map(([agent]) => agent);
      const users = [...new Set([...references, ...defaults])];
      if (users.length) throw new Error(`Skill 仍被引用，请先移除或替换：${users.join("、")}`);
      // 已创建 Run 使用独立冻结副本；不递归删除用户目录或历史版本文件。
      save(registry, list().filter(item => item.id !== id)); return { ok: true };
    },
  };
}
export function bootstrapSkillLibrary(root: string, _home?: string) { return createSkillLibrary(root); }
export function freezeSkills(root: string, directory: string, agentDefaults: Record<string, string[]>, extra: unknown = []): SkillSnapshot {
  const library = createSkillLibrary(root), all = library.list(), configured = library.bindings();
  const bindings = Object.fromEntries(Object.entries(agentDefaults).map(([agent, names]) => [agent, configured[agent] ?? all.filter(skill => names.includes(skill.name)).map(skill => skill.id)]));
  const extraIds = skillIds(extra), selected = [...new Set([...Object.values(bindings).flat(), ...extraIds])];
  const skills = selected.map(id => {
    const skill = library.get(id), files = skillTree(skill.directory);
    if (skillTreeHash(files) !== skill.hash) throw new Error(`Skill 托管内容已变化，请显式更新：${skill.name}`);
    const target = path.join(directory, "skills", id); copy(files, target);
    return { ...skill, directory: target };
  });
  return { skills, bindings, extraIds };
}
export function applySkillSnapshot(input: AgentRunInput, snapshot: SkillSnapshot | undefined, agentId: string): AgentRunInput {
  if (!snapshot) return input; // 已有 Run 沿用原冻结契约，不重新选择当前 Skill。
  const ids = new Set([...(snapshot.bindings[agentId] ?? []), ...snapshot.extraIds]);
  const selected = snapshot.skills.filter(skill => ids.has(skill.id));
  return { ...input, prompt: selected.length ? `${input.prompt}\n\nSkill 使用边界：只从本次显式提供的目录中按需读取正文；资料与脚本相对冻结 Skill 目录定位，不依赖原安装目录。Skill 不扩大工具权限或改变节点职责；有环境修复职责的 Agent 可在现有权限内尝试，其余沿用现有降级机制。` : input.prompt, isolatedSkills: true, skills: selected.map(skill => skill.directory) };
}
export function skillDiscovery(skills: OrchestrationSkill[], location: (skill: OrchestrationSkill) => string): string {
  if (!skills.length) return "未选择 Skill";
  return "以下为本节点可用的 Skill 目录。根据任务需要使用 read 读取对应 SKILL.md，再按需读取参考资料或执行脚本。Skill 不改变节点职责和工具权限；环境问题由具备相应职责与工具的 Agent 处理，其余沿用现有降级机制；冲突由 Agent 在现有权限和任务目标内自行取舍。\n" + skills.map(skill => JSON.stringify({ name: skill.name, description: skill.description, path: location(skill) })).join("\n");
}
