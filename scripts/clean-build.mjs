import fs from "node:fs";
fs.rmSync(new URL("../build/",import.meta.url),{recursive:true,force:true});
