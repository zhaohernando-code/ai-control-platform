#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { changedFilesFromGit } from "./select-affected-tests.mjs";

export const GOVERNANCE_LEVELS = Object.freeze({
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4
});

const LEVEL_LABELS = Object.freeze({
  L0: "docs_or_evidence_only",
  L1: "test_only_or_test_split",
  L2: "tool_or_helper_refactor",
  L3: "workflow_or_service_logic",
  L4: "user_visible_runtime_or_gate_entrypoint"
});

const GATE_SYSTEM_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tools/select-governance-gates.mjs",
  "tools/select-affected-tests.mjs",
  "tools/run-affected-tests.mjs",
  "tools/check-test-location.mjs",
  "tools/check-closeout.mjs"
]);

const L4_TOOL_RE = /^tools\/(?:check-workbench-(?:live-route|public-browser-route|next-served-route|browser-events|next-browser-events|next-frontend-acceptance)|check-scheduler-dispatch-writeback|probe-workbench-live-route)\.mjs$/;
const L3_TOOL_RE = /^tools\/(?:workbench-server|run-known-risk-closeout|risk-closeout-orchestrator-contract|run-autonomous-closeout-loop|run-autonomous-scheduler-loop|run-scheduler-dispatch-plan|create-scheduler-dispatch-plan)\.mjs$/;

function normalizePath(path) {
  return String(path || "").trim().split(sep).join("/");
}

function isJsonFile(path) {
  return extname(path) === ".json";
}

function isCheckableJsFile(path) {
  return /\.(?:mjs|js)$/.test(path);
}

function isDocsOrEvidence(path) {
  return path.startsWith("docs/") || path === ".largefile-manifest.json" || path.startsWith("PROJECT_STATUS");
}

function classifyFile(path) {
  if (GATE_SYSTEM_FILES.has(path)) {
    return {
      level: "L4",
      reason: `${path} changes governance, package, or closeout entrypoint behavior`
    };
  }
  if (path.startsWith("apps/workbench/")) {
    return { level: "L4", reason: `${path} changes user-visible Workbench runtime` };
  }
  if (L4_TOOL_RE.test(path)) {
    return { level: "L4", reason: `${path} changes browser, served-route, live-route, or closeout-adjacent gate behavior` };
  }
  if (path.startsWith("src/workflow/") || L3_TOOL_RE.test(path)) {
    return { level: "L3", reason: `${path} changes workflow, scheduler, server, or orchestrator logic` };
  }
  if (path.startsWith("tools/") || path.startsWith("src/")) {
    return { level: "L2", reason: `${path} changes a tool/helper implementation without matching L3/L4 runtime patterns` };
  }
  if (path.startsWith("test/")) {
    return { level: "L1", reason: `${path} changes tests or test helpers` };
  }
  if (isDocsOrEvidence(path)) {
    return { level: "L0", reason: `${path} changes documentation, evidence, or governance metadata` };
  }
  return { level: "L2", reason: `${path} is not classified; conservatively treating it as helper-level risk` };
}

function maxLevel(classifications) {
  let winner = "L0";
  for (const item of classifications) {
    if (GOVERNANCE_LEVELS[item.level] > GOVERNANCE_LEVELS[winner]) winner = item.level;
  }
  return winner;
}

function command(id, description, cmd, args, options = {}) {
  return {
    id,
    description,
    cmd,
    args,
    heavy: Boolean(options.heavy),
    required: options.required !== false
  };
}

function changedJsonFiles(changed) {
  return changed.filter((file) => isJsonFile(file) && existsSync(resolve(process.cwd(), file)));
}

function changedJsFiles(changed) {
  return changed.filter((file) => isCheckableJsFile(file) && existsSync(resolve(process.cwd(), file)));
}

function addUnique(commands, next) {
  if (!commands.some((item) => item.id === next.id)) commands.push(next);
}

function buildCommands(level, changed) {
  const commands = [];
  const jsonFiles = changedJsonFiles(changed);
  const jsFiles = changedJsFiles(changed);

  if (jsonFiles.length > 0) {
    addUnique(commands, command(
      "json-parse",
      "Parse changed JSON evidence/config files",
      process.execPath,
      ["tools/select-governance-gates.mjs", "--check-json", ...jsonFiles]
    ));
  }

  for (const file of jsFiles) {
    addUnique(commands, command(
      `node-check:${file}`,
      `Syntax check ${file}`,
      process.execPath,
      ["--check", file]
    ));
  }

  if (GOVERNANCE_LEVELS[level] >= GOVERNANCE_LEVELS.L1 && GOVERNANCE_LEVELS[level] < GOVERNANCE_LEVELS.L4) {
    addUnique(commands, command(
      "test-affected",
      "Run affected tests selected from the changed file set",
      "npm",
      ["run", "test:affected", "--", ...changed]
    ));
  }

  if (
    GOVERNANCE_LEVELS[level] >= GOVERNANCE_LEVELS.L1 ||
    changed.includes(".largefile-manifest.json")
  ) {
    addUnique(commands, command(
      "check-large-files",
      "Run large-file manifest and queue gate",
      "npm",
      ["run", "check:large-files"]
    ));
  }

  if (level === "L4") {
    addUnique(commands, command("npm-test", "Run full Node test suite", "npm", ["test"], { heavy: true }));
    addUnique(commands, command("check-large-files", "Run large-file manifest and queue gate", "npm", ["run", "check:large-files"]));
    addUnique(commands, command("check-closeout", "Run full repository closeout gate", "npm", ["run", "check:closeout"], { heavy: true }));
  }

  addUnique(commands, command("diff-check", "Reject whitespace and conflict-marker diff errors", "git", ["diff", "--check"]));
  return commands;
}

function reviewPolicyFor(level) {
  if (level === "L0") return "No model review required unless governance meaning changes.";
  if (level === "L1") return "DeepSeek Flash short review for non-trivial test moves; require parity evidence for test splits.";
  if (level === "L2") return "DeepSeek Flash bounded review for helper extraction or CLI behavior-preserving refactors.";
  if (level === "L3") return "DeepSeek Pro or sharded review for workflow/server logic before merge.";
  return "DeepSeek Pro/sharded review plus full closeout before merge or publish.";
}

export function selectGovernanceGates(changedFiles, options = {}) {
  const changed = [...new Set((changedFiles || []).map(normalizePath).filter(Boolean))].sort();
  if (options.forceLevel && !Object.hasOwn(GOVERNANCE_LEVELS, options.forceLevel)) {
    throw new Error(`unknown governance gate level: ${options.forceLevel}`);
  }
  if (changed.length === 0) {
    return {
      version: "governance-gate-plan.v1",
      status: "noop",
      level: "L0",
      label: LEVEL_LABELS.L0,
      changed,
      reasons: ["no changed files detected"],
      commands: [],
      full_closeout_required: false,
      review_policy: reviewPolicyFor("L0")
    };
  }

  const classifications = changed.map((file) => ({ file, ...classifyFile(file) }));
  const level = options.forceLevel || maxLevel(classifications);
  const commands = buildCommands(level, changed);

  return {
    version: "governance-gate-plan.v1",
    status: "planned",
    level,
    label: LEVEL_LABELS[level],
    changed,
    classifications,
    reasons: classifications.map((item) => item.reason),
    commands,
    full_closeout_required: level === "L4",
    full_closeout_policy: level === "L4"
      ? "required for user-visible runtime, package, browser gate, or closeout entrypoint changes"
      : "not required for this layer; run full closeout only at batch closeout or manual escalation",
    review_policy: reviewPolicyFor(level)
  };
}

function runCommand(item) {
  process.stdout.write(`\n[governance:gates] ${item.id}: ${item.description}\n`);
  process.stdout.write(`$ ${[item.cmd, ...item.args].join(" ")}\n`);
  const result = spawnSync(item.cmd, item.args, { cwd: process.cwd(), stdio: "inherit", env: process.env });
  return result.status ?? 1;
}

function checkJson(files) {
  for (const file of files) {
    JSON.parse(readFileSync(file, "utf8"));
  }
}

function parseCli(argv) {
  const options = { run: false, json: false, checkJson: false };
  const changed = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run") options.run = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--check-json") options.checkJson = true;
    else if (arg === "--level") {
      options.forceLevel = argv[index + 1];
      index += 1;
    } else {
      changed.push(arg);
    }
  }
  return { options, changed };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
}

if (isMain()) {
  const { options, changed } = parseCli(process.argv.slice(2));
  if (options.checkJson) {
    checkJson(changed);
    process.exit(0);
  }

  const detected = changed.length > 0 ? changed : changedFilesFromGit();
  const plan = selectGovernanceGates(detected, options);
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");

  if (options.run) {
    for (const item of plan.commands) {
      const status = runCommand(item);
      if (status !== 0) process.exit(status);
    }
  }
}
