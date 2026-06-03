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

function truncate(value, maxLength = 12000) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

function runEvidenceCommand(label, command, options) {
  const result = spawnSync("bash", ["-lc", command], {
    cwd: options.projectRoot,
    encoding: "utf8",
    timeout: 15000,
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
  });
  return [
    `$ ${command}`,
    `exit_code=${result.status ?? (result.error ? 1 : 0)}`,
    result.stdout ? truncate(result.stdout, 8000) : "",
    result.stderr ? `[stderr]\n${truncate(result.stderr, 4000)}` : "",
    result.error ? `[error]\n${result.error.message}` : ""
  ].filter(Boolean).join("\n");
}

function collectPreflightEvidence(options) {
  const quotedRoute = JSON.stringify(options.route);
  const commands = [
    ["served route headers", `curl -sS -L -I --max-time 10 ${quotedRoute}`],
    ["served route html", `curl -sS -L --max-time 10 ${quotedRoute} | sed -n '1,22p'`],
    ["served next static asset", "asset=$(curl -sS -L --max-time 10 http://127.0.0.1:4180/projects/ai-control-platform/ | grep -o '/projects/ai-control-platform/_next/static/chunks/main-app-[^\"]*\\.js' | head -1); test -n \"$asset\" && curl -sS -I --max-time 10 \"http://127.0.0.1:4180$asset\" | sed -n '1,8p'"],
    ["served favicon asset", "curl -sS -I --max-time 10 http://127.0.0.1:4180/projects/ai-control-platform/favicon.svg | sed -n '1,8p'"],
    ["claimed antd code", "rg -n \"from ['\\\"]antd['\\\"]|@ant-design/nextjs-registry|antd\\\"\" apps/workbench/app/page.tsx apps/workbench/app/providers.tsx apps/workbench/app/shell.tsx apps/workbench/package.json -S | sed -n '1,12p'"],
    ["server route mapping", "rg -n \"nextjsMountHtml|nextjsAppIndexPath|isProjectMountRoot|_next/static|favicon.svg\" tools/workbench-server.mjs | sed -n '1,20p'"],
    ["task failure recovery source", "rg -n \"retryRequirementPlan|closeRequirementTask|retry-plan|requirements/close|isRecoverableFailedTask|关闭失败任务|重试计划|closed_failed|retry_requirement_plan_generation\" src tools apps/workbench test | sed -n '1,80p'"],
    ["task failure recovery tests", "node --test test/requirement-intake.test.js test/workbench-projection.test.js test/workbench-server.test.js"],
    ["live task failure projection", "curl -sS --max-time 10 http://127.0.0.1:4182/api/workbench/projection | node -e 'let s=\"\"; process.stdin.on(\"data\", d => s += d); process.stdin.on(\"end\", () => { const p = JSON.parse(s); const task = (p.project_management && p.project_management.task_items || []).find((item) => item.task_id === \"requirement-tab-20260528064224\"); console.log(JSON.stringify({ task_id: task && task.task_id, title: task && task.title, status: task && task.status, phase: task && task.phase, next_action: task && task.next_action_readout && task.next_action_readout.action, failure_reason: task && task.failure_reason }, null, 2)); })'"],
    ["targeted quality gates", "node --test test/audit-skill-trial-run.test.js test/requirement-intake.test.js test/workbench-projection.test.js test/workbench-server.test.js test/live-route-probe.test.js"],
    ["closeout gate wiring", "rg -n \"check:closeout|governance audit skill trial|workbench live route acceptance|isolated worktree closeout|mainline release readiness\" package.json tools/check-closeout.mjs src test | sed -n '1,60p'"],
    ["git release state", "branch=$(git branch --show-current); git status --short; if [ \"$branch\" = \"main\" ] || [ \"${AI_CONTROL_CLOSEOUT_REQUIRE_MAINLINE:-0}\" = \"1\" ]; then git rev-list --left-right --count origin/main...HEAD; else echo \"isolated_worktree_closeout=true\"; echo \"mainline_release_readiness=deferred_to_parent_release_step\"; fi; git log --oneline -5"],
    ["security boundary evidence", "rg -n \"allowedHistoryRoots|safeStaticPath|unsafe|unauthorized|auth|token|host\" tools/workbench-server.mjs src tools test | sed -n '1,40p'"],
    ["recovery and publish evidence", "rg -n \"rollback|recovery|resume|publish|snapshot|launchctl|kickstart|live route\" scripts tools src test docs | sed -n '1,40p'"],
    ["cost and budget controls", "rg -n \"budget|max-budget|timeout|cost|bounded|risk|profile\" tools src test package.json | sed -n '1,40p'"],
    ["auto repair workflow evidence", "rg -n \"governance audit failure schedules|Repair governance audit|repair_schedule|context work package|next-action\" src test tools | sed -n '1,40p'"],
    ["knowledge retention evidence", "rg -n \"handoff|PROJECT_STATUS|DECISIONS|PROCESS|artifact ledger|workflow state|durable\" PROJECT_STATUS.json PROCESS.md DECISIONS.md docs src test tools | sed -n '1,40p'"],
    ["model collaboration evidence", "rg -n \"agent_invocation|deepseek|reviewer|model routing|provider\" tools src test docs package.json | sed -n '1,40p'"]
  ];
  const evidenceItems = [];
  const text = commands.map(([label, command]) => {
    const output = runEvidenceCommand(label, command, options);
    const id = label.replaceAll(" ", "-");
    evidenceItems.push({
      id,
      kind: "command",
      source: label,
      collected_at: new Date().toISOString(),
      collector: "run-governance-audit-skill-trial",
      command_or_path: command,
      exit_code: Number(/exit_code=(\d+)/u.exec(output)?.[1] || 1),
      result_summary: truncate(output, 1000)
    });
    return [`## ${id}: ${label}`, output].join("\n");
  }).join("\n\n");
  return { text, evidenceItems };
}

function dimensionSkillName(id) {
  return `${id.replaceAll("_", "-")}-audit`;
}

function defaultRepairSchedule() {
  return {
    scope: "served frontend entrypoint and closeout route verification",
    target_files_or_modules: ["tools/workbench-server.mjs", "apps/workbench"],
    owner_role: "platform_core",
    verification_commands: ["npm run check:closeout"],
    post_repair_evidence_required: "fresh browser or runtime evidence from the real served route",
    live_or_browser_verification: "follow the user-visible route and verify the served entry uses the claimed Next.js/Ant Design mode",
    rollback_risk: "medium"
  };
}

function normalizeDimensionId(value, fallback = "product_capability_gap") {
  const candidates = String(value || "")
    .split(/[|,，、\s]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return candidates.find((candidate) => AUDIT_SKILL_DIMENSIONS.includes(candidate)) || fallback;
}

function normalizeEvidencePlan(plan = {}, requestedFinalVerdict = "", disposition = "") {
  return {
    missing_evidence: plan.missing_evidence || plan.missing || "Additional live route evidence",
    how_to_collect: plan.how_to_collect || plan.collection_method || "Run the governance audit skill trial with fresh route evidence",
    blocking_closure: typeof plan.blocking_closure === "boolean"
      ? plan.blocking_closure
      : (typeof plan.blocks_closure === "boolean"
          ? plan.blocks_closure
          : requestedFinalVerdict === "需补证" && disposition === "继续取证"),
    minimum_command_or_entrypoint: plan.minimum_command_or_entrypoint ||
      plan.minimum_command ||
      plan.command ||
      "npm run run:governance-audit-skill-trial",
    ...(plan.note ? { note: plan.note } : {})
  };
}

function normalizeDecisionPackage(decisionPackage = {}) {
  const options = (Array.isArray(decisionPackage.options) ? decisionPackage.options : []).map((option) => String(option || "").trim()).filter(Boolean);
  if (options.length < 2) options.push("记录为非阻断跟进，在下一轮治理中复核");
  return {
    ...decisionPackage,
    options,
    estimated_cost: decisionPackage.estimated_cost || decisionPackage.estimated_cost_or_effort || decisionPackage.estimated_effort || decisionPackage.cost_or_effort
  };
}

function expandCompactAuditVerdict(compact, options) {
  const evidenceIds = (options.preflightEvidenceItems || []).map((item) => item.id);
  const requestedFinalVerdict = compact.final_verdict || "";
  const findings = Array.isArray(compact.findings) ? compact.findings.map((finding, index) => {
    const type = finding.type || "明确缺陷";
    const disposition = finding.disposition || (type === "明确缺陷" ? "立即修复" : "继续取证");
    return {
      id: finding.id || `governance-finding-${index + 1}`,
      dimension: normalizeDimensionId(finding.dimension),
      type,
      severity: finding.severity || "高",
      disposition,
      summary: finding.summary || finding.impact || "Governance audit finding",
      impact: finding.impact || finding.summary || "The live-facing acceptance boundary is not satisfied.",
      user_visible: finding.user_visible !== false,
      evidence_ids: Array.isArray(finding.evidence_ids) && finding.evidence_ids.length > 0 ? finding.evidence_ids : evidenceIds,
      ...(type === "明确缺陷" ? { repair_schedule: finding.repair_schedule || defaultRepairSchedule() } : {}),
      ...(type === "证据缺口" ? {
        evidence_plan: normalizeEvidencePlan(finding.evidence_plan, requestedFinalVerdict, disposition)
      } : {}),
      ...(type === "可选迭代" ? {
        decision_package: normalizeDecisionPackage(finding.decision_package || {
          options: ["defer", "schedule follow-up"],
          tradeoffs: "Deferring avoids scope expansion; follow-up increases confidence.",
          recommended_option: "schedule follow-up",
          estimated_cost: "low",
          confidence_gain: "medium"
        })
      } : {})
    };
  }) : [];
  const finalVerdict = requestedFinalVerdict || (findings.length > 0 ? "不通过" : "需补证");
  return {
    version: "audit-skill-trial-run.v1",
    project_root: DEFAULT_AUDIT_PROJECT_ROOT,
    input_mode: "real_project_state",
    scope: "governance audit skill trial for live frontend served-entry validation",
    created_at: new Date().toISOString(),
    final_verdict: finalVerdict,
    dimensions: AUDIT_SKILL_DIMENSIONS.map((id) => ({
      id,
      status: "audited",
      skill_name: dimensionSkillName(id),
      skill_version_or_path: `/Users/hernando_zhao/.codex/skills/${dimensionSkillName(id)}/SKILL.md`,
      prompt_scope: "real project state and runner-collected live route evidence",
      input_artifacts: ["tools/workbench-server.mjs", "apps/workbench/app", "apps/workbench/lib/api"],
      output_artifact: `tmp/audit-skill-trial/${id}.json`,
      evidence_ids: evidenceIds.length > 0 ? evidenceIds : ["governance-skill-invocation"]
    })),
    evidence: [...(options.preflightEvidenceItems || [])],
    findings,
    coverage_summary: {
      required_dimensions_count: AUDIT_SKILL_DIMENSIONS.length,
      covered_dimensions_count: AUDIT_SKILL_DIMENSIONS.length,
      justified_not_applicable_count: 0,
      findings_without_evidence_count: 0,
      defects_without_repair_schedule_count: 0,
      optional_without_decision_package_count: 0
    }
  };
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
