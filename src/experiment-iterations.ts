/** 用户明确的实验总轮次，包含 baseline；未指定时由模板提供默认值。 */
export function requestedExperimentIterations(input: {
  title: string;
  description: string;
  taskPrompt: string;
}): number | undefined {
  for (const raw of [input.taskPrompt, input.title, input.description]) {
    const text = raw.normalize("NFKC").replace(/第\s*[0-9]+\s*轮/gu, "");
    const counts = new Set<number>();
    const patterns = [
      /(?<![\d.])(-?[0-9]+(?:\.[0-9]+)?)\s*(?:轮|次实验|次迭代)/gu,
      /(?:实验轮次|迭代轮次|实验次数)\s*[:：为是=]?\s*(-?[0-9]+(?:\.[0-9]+)?)/gu,
      /\b(-?[0-9]+(?:\.[0-9]+)?)\s+(?:iterations?|rounds?|experiments?)\b/giu,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const count = Number(match[1]);
        if (!Number.isSafeInteger(count) || count < 1) throw new Error("实验轮次必须是正整数");
        counts.add(count);
      }
    }
    if (counts.size > 1) throw new Error("任务中存在多个不同的实验轮次，请明确实验总轮次");
    if (counts.size === 1) return counts.values().next().value;
  }
  return undefined;
}
