#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export {
  buildArtifact,
  parseAcceptanceOptions
} from "./retired-workbench-frontend-acceptance.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error(JSON.stringify({
    status: "retired",
    error: "legacy static Workbench frontend acceptance has been retired; use tools/check-workbench-next-frontend-acceptance.mjs"
  }, null, 2));
  process.exit(1);
}
