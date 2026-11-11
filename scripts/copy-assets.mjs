import fs from "node:fs";
fs.cpSync(new URL("../src/assets/",import.meta.url),new URL("../build/assets/",import.meta.url),{recursive:true});
