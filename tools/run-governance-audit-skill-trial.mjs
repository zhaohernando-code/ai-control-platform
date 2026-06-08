#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  AUDIT_SKILL_DIMENSIONS,
  DEFAULT_AUDIT_PROJECT_ROOT,
  evaluateAuditSkillTrialRun
} from "../src/workflow/audit-skill-trial-run.js";
import { runAgentInvocation } from "../src/workflow/agent-invocation.js";
import { createSqliteWorkbenchStateStore } from "../src/workflow/workbench-state-store.js";
import { DEFAULT_LIVE_WORKBENCH_STATE_DB } from "../src/workflow/workbench-live-state-cleanliness.js";
import {
  collectPreflightEvidence,
  truncate
} from "../src/workflow/governance-audit-evidence.js";
import { expandCompactAuditVerdict } from "../src/workflow/governance-audit-artifact-expansion.js";

const DEFAULT_SKILL_PATH = "/Users/hernando_zhao/.codex/skills/governance-audit-orchestrator/SKILL.md";
const DEFAULT_ROUTE = "http://127.0.0.1:4180/projects/ai-control-platform/";
const DEFAULT_OUTPUT = "tmp/audit-skill-trial/governance-audit-current.json";
const DEFAULT_RAW_OUTPUT = "tmp/audit-skill-trial/governance-audit-current.raw.txt";
const DEFAULT_PROMPT_OUTPUT = "tmp/audit-skill-trial/governance-audit-current.prompt.md";

function usage() {
  return [
    "usage: run-governance-audit-skill-trial.mjs [--project-root PATH] [--skill-path PATH] [--route URL] [--claimed-stack TEXT]",
    "       [--output PATH] [--raw-output PATH] [--prompt-output PATH] [--record-workbench-url URL]",
    "       [--runner-command CMD --runner-arg ARG...] [--state-db PATH] [--timeout-seconds N] [--no-fail-on-blocking-verdict]",
    "",
    "Invokes the governed agent invocation profile to read governance-audit-orchestrator/SKILL.md and produce an audit-skill-trial-run.v1 artifact."
  ].join("\n");
}

function requiredValue(argv, index, arg) { const value = argv[index + 1]; if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`); return value; }

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    skillPath: DEFAULT_SKILL_PATH,
    route: DEFAULT_ROUTE,
    claimedStack: "React + Next.js App Router + Ant Design",
    outputPath: DEFAULT_OUTPUT,
    rawOutputPath: DEFAULT_RAW_OUTPUT,
    promptOutputPath: DEFAULT_PROMPT_OUTPUT,
    runnerCommand: "",
    runnerArgs: [],
    recordWorkbenchUrl: "",
    stateDbPath: "",
    timeoutSeconds: 300,
    failOnBlockingVerdict: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-root") {
      options.projectRoot = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--skill-path") {
      options.skillPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--route") {
      options.route = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--claimed-stack") {
      options.claimedStack = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--output") {
      options.outputPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--raw-output") {
      options.rawOutputPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--prompt-output") {
      options.promptOutputPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--runner-command") {
      options.runnerCommand = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--state-db") {
      options.stateDbPath = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--record-workbench-url") {
      options.recordWorkbenchUrl = requiredValue(argv, index, arg);
      index += 1;
    } else if (arg === "--runner-arg") {
      options.runnerArgs.push(requiredValue(argv, index, arg));
      index += 1;
    } else if (arg === "--timeout-seconds") {
      options.timeoutSeconds = Number(requiredValue(argv, index, arg));
      index += 1;
    } else if (arg === "--no-fail-on-blocking-verdict") {
      options.failOnBlockingVerdict = false;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function ensureParent(path) { mkdirSync(dirname(resolve(path)), { recursive: true }); }

function buildPrompt(options) {
  const dimensions = AUDIT_SKILL_DIMENSIONS.map((dimension) => `- ${dimension}`).join("\n");
  return [
    "你是当前项目 closeout 的独立治理审计员。本次必须使用下方已加载的 skill 正文，而不是只验证既有 JSON。",
    "",
    `1. Skill entrypoint: ${options.skillPath}`,
    `2. 审计项目: ${options.projectRoot}`,
    `3. 当前用户可见入口: ${options.route}`,
    `4. 当前流程声称的前端目标/栈: ${options.claimedStack}`,
    "",
    "关键要求：",
    "- 不要修改文件，不要修复问题，只审计。",
    "- 不要相信 PROJECT_STATUS、历史报告、已有 audit JSON 或 agent 自述；它们只能作为线索。",
    "- 必须根据下面的只读证据包检查真实 served route，比较最终 URL、HTML entry、script/style assets、DOM markers 是否匹配声称的前端栈。",
    "- 如果源码里有新实现但真实入口仍服务旧 HTML/CSS/JS shell，必须按 skill 的 Live Frontend Entry Checks 作为明确缺陷。",
    "- 必须覆盖 13 个维度；不适用维度要给出理由。",
    "- 默认不要再运行命令；证据包已由 runner 即时收集，且按审计维度覆盖 live route、源码、测试门禁、发布/恢复、权限边界、成本控制、知识留存和模型协作。",
    "- 不要因为没有每个维度的独立 JSON 子报告而判定缺证；只有证据包缺少能判断该维度的真实命令/代码/运行时证据时，才指出 需补证，并说明缺少的具体证据。",
    "- 本次 closeout 的阻断口径是当前用户可见变更能否安全发布；不要把未专门演练历史灾难、生产中断或泛化自动修复生命周期作为本次阻断，除非证据包无法判断当前变更的恢复路径。",
    "- 如果证据包已经包含当前失败恢复流程的源码、API 路由、测试和真实 served route 证据，recovery_capability / auto_repair_authenticity 维度可判为通过或带条件通过；非阻断改进请输出 可选迭代 或 带条件通过，不要输出 需补证。",
    "",
    "13 个维度：",
    dimensions,
    "",
    "只输出一个小 JSON 对象，不要 Markdown，不要解释。runner 会把它扩展成 audit-skill-trial-run.v1：",
    "{",
    "  \"skill_used\": true,",
    "  \"final_verdict\": \"通过 | 带条件通过 | 不通过 | 需补证\",",
    "  \"findings\": [",
    "    {",
    "      \"id\": \"served-entry-stack-mismatch\",",
    "      \"dimension\": \"product_capability_gap | user_experience | quality_gate | flow_integrity\",",
    "      \"type\": \"明确缺陷 | 证据缺口 | 可选迭代\",",
    "      \"severity\": \"致命 | 高 | 中 | 低\",",
    "      \"disposition\": \"立即修复 | 继续取证 | 用户决策 | 延后\",",
    "      \"summary\": \"一句话说明\",",
    "      \"evidence_ids\": [\"served-route-headers\", \"served-route-html\", \"claimed-antd-code\", \"server-route-mapping\"],",
    "      \"user_visible\": true",
    "    }",
    "  ]",
    "}",
    "",
    "Loaded governance audit skill:",
    "```markdown",
    options.skillText || "skill text was not loaded",
    "```",
    "",
    "Runner-collected real-project evidence packet:",
    "```text",
    options.preflightEvidence || "preflight evidence was not collected",
    "```"
  ].join("\n");
}

function applyArgTokens(value, options) {
  return String(value)
    .replaceAll("{prompt_path}", options.promptOutputPath)
    .replaceAll("{project_root}", options.projectRoot)
    .replaceAll("{skill_path}", options.skillPath)
    .replaceAll("{output_path}", options.outputPath)
    .replaceAll("{raw_output_path}", options.rawOutputPath);
}

function runnerCommand(options) {
  if (!options.runnerCommand) return null;
  const command = options.runnerCommand;
  const args = options.runnerArgs.map((arg) => applyArgTokens(arg, options));
  return { command, args };
}

function recordArtifactToWorkbench(artifact, options) {
  if (!options.recordWorkbenchUrl) return null;
  const result = spawnSync("curl", [
    "-sS",
    "-X", "POST",
    "--max-time", "20",
    "-H", "content-type: application/json",
    "--data-binary", JSON.stringify({ artifact }),
    options.recordWorkbenchUrl
  ], {
    cwd: options.projectRoot,
    encoding: "utf8"
  });
  const exitCode = result.status ?? (result.error ? 1 : 0);
  let payload = null;
  try {
    payload = result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    payload = null;
  }
  return {
    status: exitCode === 0 && payload?.status === "created" ? "pass" : "fail",
    exit_code: exitCode,
    response: payload,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || ""
  };
}

function extractJsonObject(text) {
  const fenced = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)].map((match) => match[1].trim());
  for (const candidate of fenced.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.version === "audit-skill-trial-run.v1") return parsed;
      if (typeof parsed?.result === "string") return extractJsonObject(parsed.result);
      return parsed;
    } catch {
      // Keep trying plain object extraction below.
    }
  }

  const raw = String(text);
  const parsedObjects = [];
  for (let start = raw.indexOf("{"); start >= 0; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = raw.slice(start, index + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed?.version === "audit-skill-trial-run.v1") return parsed;
            if (typeof parsed?.result === "string") return extractJsonObject(parsed.result);
            parsedObjects.push(parsed);
          } catch {
            break;
          }
        }
      }
    }
  }
  if (parsedObjects.length > 0) return parsedObjects[0];
  const textualVerdict = extractTextualFinalVerdict(raw);
  if (textualVerdict) return textualVerdict;
  throw new Error("governed agent output did not contain a parseable JSON object");
}

function extractTextualFinalVerdict(text) {
  const pattern = /(?:总评|最终结论|最终判定|审计结论|overall verdict)(?:\*\*)?\s*[:：]\s*[`"'“”‘’]*\s*(带条件通过|不通过|需补证|通过)(?=\s*[`"'“”‘’]*(?:$|\s|[。.!！,，;；:：\-—]))/iu;
  const match = String(text || "").split(/\r?\n/u).map((line) => line.match(pattern)).find(Boolean);
  return match ? { skill_used: true, final_verdict: match[1], findings: [] } : null;
}

function normalizeArtifact(artifact, options, invocation) {
  artifact = artifact?.version === "audit-skill-trial-run.v1"
    ? artifact
    : expandCompactAuditVerdict(artifact || {}, options);
  const evidence = Array.isArray(artifact.evidence) ? artifact.evidence : [];
  const invocationEvidenceId = "governance-skill-invocation";
  if (!evidence.some((item) => item?.id === invocationEvidenceId)) {
    evidence.push({
      id: invocationEvidenceId,
      kind: "command",
      source: "Governed agent governance audit skill invocation",
      collected_at: invocation.invoked_at,
      collector: "governance-audit-orchestrator",
      command_or_path: `${invocation.runner_command} ${invocation.runner_args.join(" ")} using ${options.skillPath}`,
      exit_code: invocation.exit_code,
      result_summary: "agent invocation was used to read and apply governance-audit-orchestrator/SKILL.md against real project state."
    });
  }
  return {
    ...artifact,
    evidence,
    skill_invocation: invocation
  };
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(2);
}

if (options.help) {
  console.log(usage());
  process.exit(0);
}

options.projectRoot = resolve(options.projectRoot);
options.skillPath = resolve(options.skillPath);
options.skillText = truncate(readFileSync(options.skillPath, "utf8"), 18000);
const preflight = options.runnerCommand ? { text: "", evidenceItems: [] } : collectPreflightEvidence(options);
options.preflightEvidence = preflight.text;
options.preflightEvidenceItems = preflight.evidenceItems;
ensureParent(options.promptOutputPath);
ensureParent(options.rawOutputPath);
ensureParent(options.outputPath);
writeFileSync(options.promptOutputPath, `${buildPrompt(options)}\n`);

const customRunner = runnerCommand(options);
const invokedAt = new Date().toISOString();
const result = customRunner
  ? spawnSync(customRunner.command, customRunner.args, {
    cwd: options.projectRoot,
    encoding: "utf8",
    timeout: Number.isFinite(options.timeoutSeconds) ? (options.timeoutSeconds + 15) * 1000 : 315000,
    env: {
      ...process.env,
      PATH: [
        process.env.PATH,
        "/Users/hernando_zhao/.local/bin",
        "/Users/hernando_zhao/.nvm/versions/node/v22.16.0/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin"
      ].filter(Boolean).join(":")
    }
  })
  : runAgentInvocation({
    profile_id: "governance_audit_skill_trial",
    prompt_file: options.promptOutputPath,
    cwd: options.projectRoot,
    timeout_ms: Number.isFinite(options.timeoutSeconds) ? options.timeoutSeconds * 1000 : 300000,
    invocation_id: `governance-audit-skill-trial:${invokedAt}`
  }, {
    stateStore: createSqliteWorkbenchStateStore({
      dbPath: options.stateDbPath ||
        process.env.AI_CONTROL_WORKBENCH_STATE_DB ||
        DEFAULT_LIVE_WORKBENCH_STATE_DB
    })
  });
const command = customRunner?.command || result.invocation?.command || "agent_invocation";
const args = customRunner?.args || result.invocation?.command_audit?.args || [];

const rawOutput = [
  result.stdout || "",
  result.stderr ? `\n[stderr]\n${result.stderr}` : "",
  result.error ? `\n[error]\n${result.error.message}` : ""
].join("");
writeFileSync(options.rawOutputPath, rawOutput);

const exitCode = Number.isFinite(Number(result.status))
  ? Number(result.status)
  : Number(result.result?.exit_code ?? (result.status === "pass" ? 0 : 1));
if (exitCode !== 0) {
  console.error(`Governed agent governance audit invocation failed with exit code ${exitCode}`);
}

try {
  const artifact = normalizeArtifact(extractJsonObject(result.stdout || rawOutput), options, {
    provider: "agent_invocation",
    profile_id: "governance_audit_skill_trial",
    model: result.invocation?.model || null,
    skill_path: options.skillPath,
    runner_command: command,
    runner_args: args,
    prompt_path: options.promptOutputPath,
    raw_output_path: options.rawOutputPath,
    exit_code: exitCode,
    invoked_at: invokedAt
  });
  writeFileSync(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const recordResult = recordArtifactToWorkbench(artifact, options);

  const validation = evaluateAuditSkillTrialRun(artifact, {
    expectedProjectRoot: DEFAULT_AUDIT_PROJECT_ROOT
  });
  console.log(JSON.stringify({
    gate_id: "governance-audit-skill-trial",
    invocation_exit_code: exitCode,
    artifact_path: options.outputPath,
    raw_output_path: options.rawOutputPath,
    record_workbench: recordResult,
    validation
  }, null, 2));

  if (exitCode !== 0 || validation.status !== "pass") {
    process.exit(1);
  }
  if (recordResult && recordResult.status !== "pass") {
    console.error("governance audit skill artifact could not be recorded to workbench");
    process.exit(1);
  }
  if (options.failOnBlockingVerdict && !["通过", "带条件通过"].includes(String(artifact.final_verdict || "").trim())) {
    console.error(`governance audit skill verdict blocks closeout: ${artifact.final_verdict}`);
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Module body performs the CLI work.
}
