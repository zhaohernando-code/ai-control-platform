import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_DEEPSEEK_REVIEW_SCRIPT = "/Users/hernando_zhao/.codex/skills/claude-deepseek-review/scripts/run_claude_deepseek_review.py";
const DEFAULT_PROJECT_CWD = "/Users/hernando_zhao/codex/projects/ai-control-platform";
const DEFAULT_MODEL = "deepseek-v4-pro[1m]";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function toolString(shard = {}) {
  return asArray(shard.allowed_tools).map(normalizeString).filter(Boolean).join(",");
}

function jsonCandidate(text) {
  const value = normalizeString(text);
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const arrayStart = value.indexOf("[");
  const arrayEnd = value.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) return value.slice(arrayStart, arrayEnd + 1);

  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) return value.slice(objectStart, objectEnd + 1);

  return "";
}

function normalizeFindingShape(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.findings)) return parsed.findings;
  if (parsed && typeof parsed === "object") return [parsed];
  return [];
}

export function parseClaudeDeepSeekFindings(stdout = "") {
  const candidate = jsonCandidate(stdout);
  if (!candidate) return [];
  try {
    return normalizeFindingShape(JSON.parse(candidate));
  } catch {
    return [];
  }
}

export function createClaudeDeepSeekShardCommand(input = {}) {
  const shard = input.shard || {};
  const promptFile = normalizeString(input.prompt_file || input.promptFile);
  const cwd = normalizeString(input.cwd) || DEFAULT_PROJECT_CWD;
  const script = normalizeString(input.script_path || input.scriptPath) || DEFAULT_DEEPSEEK_REVIEW_SCRIPT;
  const tools = input.tools !== undefined ? normalizeString(input.tools) : toolString(shard);
  const timeoutSeconds = Number(input.timeout_seconds || input.timeoutSeconds || shard.timeout_seconds || 180) || 180;
  const model = normalizeString(input.model || shard.model) || DEFAULT_MODEL;
  const args = [
    script,
    "--cwd",
    cwd,
    "--prompt-file",
    promptFile,
    "--timeout-seconds",
    String(timeoutSeconds),
    "--tools",
    tools,
    "--model",
    model
  ];

  if (input.add_dir !== false && input.addDir !== false) {
    args.push("--add-dir", normalizeString(input.add_dir || input.addDir || cwd));
  }

  return {
    command: normalizeString(input.python || input.python_bin || input.pythonBin) || "python3",
    args,
    cwd,
    timeout_seconds: timeoutSeconds,
    tools,
    model
  };
}

export function createClaudeDeepSeekShardExecutor(options = {}) {
  const commandRunner = options.commandRunner || ((command, args, runnerOptions) => spawnSync(command, args, runnerOptions));

  return async ({ shard, prompt }) => {
    const tempDir = mkdtempSync(join(tmpdir(), "reviewer-shard-ds-"));
    const promptFile = join(tempDir, `${normalizeString(shard?.id) || "reviewer-shard"}.md`);
    writeFileSync(promptFile, prompt);
    const command = createClaudeDeepSeekShardCommand({
      ...options,
      shard,
      prompt_file: promptFile
    });
    const result = commandRunner(command.command, command.args, {
      cwd: command.cwd,
      encoding: "utf8",
      timeout: (command.timeout_seconds + 5) * 1000
    });
    const stdout = normalizeString(result.stdout);
    const stderr = normalizeString(result.stderr);
    const exitCode = Number(result.status ?? result.exitCode ?? 0);
    const timedOut = exitCode === 124 || /CLAUDE_DEEPSEEK_TIMEOUT/.test(stderr);
    const findings = parseClaudeDeepSeekFindings(stdout);
    const provenance = {
      executor_kind: "claude_deepseek",
      provider: "deepseek",
      model: command.model,
      timeout_seconds: command.timeout_seconds,
      tools: command.tools,
      external_call_budget_used: 1
    };

    if (exitCode === 0 && findings.length > 0) {
      return {
        status: findings.some((finding) => normalizeString(finding.status).toLowerCase() === "fail") ? "fail" : "pass",
        findings,
        provenance,
        stdout,
        stderr
      };
    }

    if (exitCode === 0) {
      return {
        status: "pass",
        findings: [
          {
            id: `${shard.id}-reviewer-text-pass`,
            status: "pass",
            severity: "info",
            category: "reviewer",
            message: stdout || "external shard reviewer returned no structured findings"
          }
        ],
        provenance,
        stdout,
        stderr
      };
    }

    return {
      status: "fail",
      findings: [
        {
          id: `${shard.id}-${timedOut ? "deepseek-timeout" : "deepseek-error"}`,
          status: "fail",
          severity: "medium",
          category: timedOut ? "reviewer_timeout" : "reviewer_executor",
          message: timedOut
            ? `DeepSeek shard reviewer timed out after ${command.timeout_seconds}s`
            : `DeepSeek shard reviewer failed with exit code ${exitCode}`,
          evidence: {
            stdout,
            stderr,
            model: command.model,
            tools: command.tools,
            timeout_seconds: command.timeout_seconds
          }
        }
      ],
      provenance,
      stdout,
      stderr
    };
  };
}

export {
  DEFAULT_DEEPSEEK_REVIEW_SCRIPT,
  DEFAULT_MODEL,
  DEFAULT_PROJECT_CWD
};
