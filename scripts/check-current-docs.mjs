import fs from "node:fs";
import path from "node:path";
const files=["README.md","AGENTS.md","dev-docs/README.md","dev-docs/api/README.md","dev-docs/architecture/README.md","dev-docs/governance/project-operations.md"];
for(const file of files){const text=fs.readFileSync(file,"utf8");for(const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)){const target=match[1].split("#")[0];if(target&&!target.includes("://")&&!fs.existsSync(path.resolve(path.dirname(file),target)))throw new Error(`文档链接不存在：${file} → ${target}`);}}
console.log(`现行文档与链接检查通过（${files.length} 份）`);
