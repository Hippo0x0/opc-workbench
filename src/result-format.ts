/** 仅移除字符串外、紧邻对象或数组结束符的尾逗号，不改写字段和值。 */
function parseObjectText(text: string): unknown {
  try { return JSON.parse(text); } catch { /* 尝试无歧义的语法归一。 */ }
  let normalized = "", quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      normalized += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    if (c === ",") {
      let next = i + 1;
      while (next < text.length && /\s/u.test(text[next]!)) next++;
      let previous = i - 1;
      while (previous >= 0 && /\s/u.test(text[previous]!)) previous--;
      if ((text[next] === "}" || text[next] === "]")
          && previous >= 0 && !/[{\[,:]/u.test(text[previous]!)) continue;
    }
    normalized += c;
  }
  return JSON.parse(normalized);
}

/** 只处理表达形式，不猜测状态、路由或业务结论。 */
export function resultObject(output: string, label: string): Record<string, unknown> {
  let direct: unknown;
  try { direct = parseObjectText(output.trim()); } catch { /* 尝试从说明中提取。 */ }
  if (direct !== undefined) {
    if (!direct || typeof direct !== "object" || Array.isArray(direct)) throw new Error(`${label} 未返回单一 JSON 对象`);
    return direct as Record<string, unknown>;
  }
  const objects: Record<string, unknown>[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < output.length; i++) {
    const c = output[i];
    if (start < 0) { if (c === "{") { start = i; depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        const value = parseObjectText(output.slice(start, i + 1));
        if (value && typeof value === "object" && !Array.isArray(value)) objects.push(value as Record<string, unknown>);
      } catch { /* 非 JSON 的说明文字不构成候选。 */ }
      start = -1;
    }
  }
  if (objects.length !== 1) throw new Error(`${label} 未返回单一 JSON 对象`);
  return objects[0]!;
}

/** 描述字段保留信息；对象保留原 JSON，不推断其中的业务含义。 */
export function descriptionList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(item => {
    if (item === undefined || item === null) return [];
    const text = typeof item === "string" ? item.trim() : JSON.stringify(item);
    return text ? [text] : [];
  });
}

export function unavailableValidation(output: string): string {
  return JSON.stringify({status:"DEGRADED",passed:false,summary:"验证结果格式无法解析，尚未取得可信验证结论",
    gaps:["验证结论不可用；以下原始回复仅供审阅，不能作为通过依据"],details:[],originalOutput:output});
}
