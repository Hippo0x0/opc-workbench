#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
process.env.PI_CODING_AGENT_DIR ??= path.join(process.env.OPC_HOME || path.join(os.homedir(),".opc-workbench"),"agent");
// Run upstream Pi directly; provider resolution, OAuth and sessions remain Pi-owned.
const entry=path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),"cli.js");
await import(pathToFileURL(entry).href);
