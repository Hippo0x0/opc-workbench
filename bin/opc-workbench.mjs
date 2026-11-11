#!/usr/bin/env node
const [major,minor]=process.versions.node.split(".").map(Number);
if(major<22||(major===22&&minor<19)){console.error("opc-workbench 需要 Node.js 22.19+");process.exit(1);}
try {
 if(process.argv[2]==="agent"){
  process.argv.splice(2,1);await import("./pi.mjs");
 }else{const {main}=await import("../build/cli.js");await main();}
}catch(error){console.error(error instanceof Error?error.message:"执行失败");process.exitCode=1;}
