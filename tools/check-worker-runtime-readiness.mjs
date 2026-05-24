#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  PLAYWRIGHT_PACKAGE,
  evaluateWorkerRuntimeReadiness
} from "../src/workflow/worker-runtime-readiness.js";

const requireFromCwd = createRequire(`${process.cwd()}/package.json`);

function hasFlag(flag, args) {
  return args.includes(flag);
}

function valuesAfterRepeatedFlag(flag, args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && index + 1 < args.length) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function rawCommandArgs(args) {
  const separatorIndex = args.indexOf("--");
  if (separatorIndex >= 0) return args.slice(separatorIndex + 1);
  const consumedIndexes = new Set();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--script" && index + 1 < args.length) {
      consumedIndexes.add(index);
      consumedIndexes.add(index + 1);
      index += 1;
    }
  }
  return args.filter((_, index) => !consumedIndexes.has(index));
}

function resolvePackage(packageName) {
  try {
    return {
      available: true,
      resolved: requireFromCwd.resolve(packageName)
    };
  } catch (error) {
    return {
      available: false,
      error_code: error?.code || "PACKAGE_RESOLVE_FAILED",
      message: error?.message
    };
  }
}

export function parseWorkerRuntimeReadinessArgs(args = process.argv.slice(2)) {
  const commandArgs = rawCommandArgs(args);
  return {
    scripts: valuesAfterRepeatedFlag("--script", args),
    commands: commandArgs.length > 0 ? [commandArgs] : []
  };
}

export function checkWorkerRuntimeReadiness(args = process.argv.slice(2)) {
  const parsed = parseWorkerRuntimeReadinessArgs(args);
  return evaluateWorkerRuntimeReadiness({
    ...parsed,
    package_availability: {
      [PLAYWRIGHT_PACKAGE]: resolvePackage(PLAYWRIGHT_PACKAGE)
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (hasFlag("--help", process.argv.slice(2))) {
    console.log("usage: check-worker-runtime-readiness.mjs [--script <npm-script>] [-- <raw command...>]");
    process.exit(0);
  }

  const result = checkWorkerRuntimeReadiness();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "pass") {
    process.exit(1);
  }
}
