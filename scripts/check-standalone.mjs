import fs from "node:fs";
import path from "node:path";
const forbidden=/\b(?:meituan|sankuai|dianping|turing(?:ai)?|multica|conan|friday|mc|mis|talos|mtskills|citadel|knowbase|raptor|catpaw|mcli|ciba|hpx|onesql)\b|infra-autoresearch|@(?:mtfe|dp|sankuai|meituan)[/+]/iu;
const compiledForbidden=/(?:sankuai|meituan|dianping)\.(?:com|net|org|info)|\b(?:turing(?:ai)?|multica|conan|friday)\b|@(?:mtfe|dp|sankuai|meituan)\/|(?:TURINGAI|MULTICA|FRIDAY|CIBA|SSO_USER)_[A-Z_]+/iu;
const skipped=new Set([".git","node_modules"]),files=[];
function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){if(skipped.has(entry.name))continue;const file=path.join(directory,entry.name);if(entry.isSymbolicLink())throw new Error(`项目文件不能链接到外部目录：${file}`);if(entry.isDirectory())walk(file);else if(entry.isFile()&&!file.endsWith(".tgz"))files.push(file);}}
walk(".");
for(const file of files){
 if(file===path.join("scripts","check-standalone.mjs"))continue;
 const data=fs.readFileSync(file);if(data.includes(0))continue;
 // 压缩后的前端依赖可能使用短变量名；按域名、包名与平台标识检查，避免把随机变量误认成平台。
 const rule=file.startsWith(`web${path.sep}dist${path.sep}`)?compiledForbidden:forbidden;
 data.toString("utf8").split("\n").forEach((line,i)=>{if(rule.test(line))throw new Error(`发现未剥离的企业引用：${file}:${i+1}`);});
}
const lock=JSON.parse(fs.readFileSync("package-lock.json","utf8"));
for(const [name,pkg] of Object.entries(lock.packages)){if(pkg.link||name.includes("../"))throw new Error(`依赖仍引用本机路径：${name}`);if(pkg.resolved&&!pkg.resolved.startsWith("https://registry.npmjs.org/"))throw new Error(`依赖不是公共 registry：${name}`);}
console.log(`独立性检查通过（${files.length} 个项目文件，公共 npm 锁文件）`);
