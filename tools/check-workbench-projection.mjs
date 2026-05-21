#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { validateWorkbenchProjectionSchema } from "../src/workflow/workbench-projection-schema.js";

const [, , projectionPath] = process.argv;

if (!projectionPath) {
  console.error("usage: check-workbench-projection.mjs <projection.json>");
  process.exit(2);
}

const projection = JSON.parse(readFileSync(projectionPath, "utf8"));
const validation = validateWorkbenchProjectionSchema(projection);

console.log(JSON.stringify(validation, null, 2));

if (validation.status !== "pass") {
  process.exit(1);
}
