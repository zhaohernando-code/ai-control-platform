#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitRemoteSyncState, hasDirtyGit, mainlineContainmentGaps } = require("./git-remote-state");

const DEFAULT_ROOT = path.resolve(__dirname, "..");
const CODEX_ROOT = path.resolve(process.env.CODEX_WORKFLOW_ROOT || process.env.CODEX_CONTROL_ROOT || DEFAULT_ROOT);
const SESSION_DIR = path.join(CODEX_ROOT, ".codex-system", "workflow-sessions");
const LOCK_DIR = path.join(CODEX_ROOT, ".codex-system", "locks");
const COMPLETION_RE = /\b(done|complete|completed|implemented|fixed|verified|published|merged)\b|完成|已完成|实现|已实现|修复|已修复|验证|已验证|发布|已发布|合入|已合入/i;
const VALIDATION_RE = /\b(npm\s+test|npm\s+run\s+(build|check|test)|node\s+--test|pytest|ruff|tsc\b|vite\s+build|curl\b|playwright|safari|browser|health)\b/i;
const LIVE_RE = /hernando-zhao\.cn|\/middle\b|\/stocks\b|\/chat\b|\/projects\/|\/tools\/|safari|browser/i;
const DOC_RE = /\b(PROJECT_STATUS\.json|DECISIONS\.md|PROCESS\.md|CLAUDE\.md|KNOWN_TRAPS\.md)\b/;

function parseArgs(argv) {
  const args = { agent: "codex", event: "" };
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1] || "";
    if (key === "--agent") {
      args.agent = value || args.agent;
      index += 1;
    } else if (key === "--event") {
      args.event = value || args.event;
      index += 1;
    }
  }
  return args;
}

function readStdinJson() {
  const input = fs.readFileSync(0, "utf8").trim();
  if (!input) {
    return {};
  }
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileSegment(value) {
  return String(value || "session")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 120) || "session";
}

function statePathFor(input) {
  const sessionId = input.session_id || input.sessionId || "local";
  return path.join(SESSION_DIR, `${sanitizeFileSegment(sessionId)}.json`);
}

function loadSessionState(input) {
  ensureDir(SESSION_DIR);
  const filePath = statePathFor(input);
  const state = safeReadJson(filePath, {}) || {};
  state.sessionId ||= String(input.session_id || input.sessionId || "local");
  state.startedAt ||= new Date().toISOString();
  state.events ||= [];
  state.mutations ||= [];
  state.routes ||= [];
  state.evidence ||= {
    validation: false,
    liveVerification: false,
    docsTouched: false,
    commitOrMerge: false,
    publish: false,
    remotePush: false,
  };
  return { filePath, state };
}

function saveSessionState(filePath, state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function loadWorkspaceIndex() {
  const index = safeReadJson(path.join(CODEX_ROOT, "WORKSPACE_INDEX.json"), { projects: [] }) || { projects: [] };
  const projects = Array.isArray(index.projects) ? index.projects.slice() : [];
  projects.push({
    project_id: "codex",
    display_name: "Codex Workspace Governance",
    aliases: ["codex", "根仓", "工作区治理"],
    keywords: ["workflow", "hooks", "governance", "workspace"],
    repo_path: CODEX_ROOT,
    runtime_path: "",
    canonical_docs: [
      path.join(CODEX_ROOT, "PROJECT_STATUS.json"),
      path.join(CODEX_ROOT, "CODEX.md"),
      path.join(CODEX_ROOT, "PROCESS.md"),
    ],
    live_verification_required: false,
  });
  return projects
    .filter((project) => project && project.repo_path)
    .map((project) => ({
      id: String(project.project_id || "").trim(),
      name: String(project.display_name || project.project_id || "").trim(),
      repoPath: path.resolve(String(project.repo_path || "")),
      runtimePath: project.runtime_path ? path.resolve(String(project.runtime_path || "")) : "",
      canonicalDocs: Array.isArray(project.canonical_docs) ? project.canonical_docs : [],
      liveVerificationRequired: Boolean(project.live_verification_required || project.entry_routes?.user || project.entry_routes?.canonical),
      aliases: Array.isArray(project.aliases) ? project.aliases : [],
      keywords: Array.isArray(project.keywords) ? project.keywords : [],
      projectType: String(project.project_type || ""),
    }))
    .sort((left, right) => right.repoPath.length - left.repoPath.length);
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function projectFromWorktreePath(projects, rootPath, resolvedPath) {
  if (!isPathInside(rootPath, resolvedPath)) return null;
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  const key = normalize(path.relative(rootPath, resolvedPath).split(path.sep).filter(Boolean)[0]);
  return projects.find((project) => [project.id, project.name, ...project.aliases].some((value) => normalize(value) === key)) || null;
}

function classifyPath(candidatePath) {
  const resolved = path.resolve(candidatePath || CODEX_ROOT);
  const projects = loadWorkspaceIndex();
  const workerRoot = path.join(CODEX_ROOT, "worker-workspaces");
  const serverWorktreeRoot = path.join(CODEX_ROOT, ".codex-system", "worktrees");
  const worktreeProject = projectFromWorktreePath(projects, workerRoot, resolved) || projectFromWorktreePath(projects, serverWorktreeRoot, resolved);
  const repoProject = projects.find((item) => isPathInside(item.repoPath, resolved)) || null;
  return {
    path: resolved,
    project: worktreeProject || repoProject,
    inWorkerWorktree: isPathInside(workerRoot, resolved),
    inServerWorktree: isPathInside(serverWorktreeRoot, resolved),
    inCanonical: Boolean(repoProject && isPathInside(repoProject.repoPath, resolved)),
  };
}

function runGit(repoPath, args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function shortGitSnapshot() {
  const repos = [
    CODEX_ROOT,
    path.join(CODEX_ROOT, "projects", "ai-control-platform"),
    path.join(CODEX_ROOT, "projects", "local-control-server"),
    path.join(CODEX_ROOT, "projects", "dashboard-ui"),
    path.join(CODEX_ROOT, "projects", "stock_dashboard"),
    path.join(CODEX_ROOT, "projects", "lobechat"),
  ];
  return repos
    .filter((repoPath) => fs.existsSync(path.join(repoPath, ".git")))
    .map((repoPath) => {
      const status = runGit(repoPath, ["status", "--short", "--branch"]).stdout || "status unavailable";
      const worktrees = runGit(repoPath, ["worktree", "list"]).stdout || "worktree list unavailable";
      return `## ${path.relative(CODEX_ROOT, repoPath) || "codex"}\n${status}\n${worktrees}`;
    })
    .join("\n\n");
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function resolvePromptRoute(prompt) {
  const query = normalizeText(prompt);
  if (!query) {
    return null;
  }
  let best = null;
  for (const project of loadWorkspaceIndex()) {
    let score = 0;
    const reasons = [];
    for (const alias of project.aliases) {
      const normalized = normalizeText(alias);
      if (normalized && query.includes(normalized)) {
        score += 100;
        reasons.push(`alias:${alias}`);
      }
    }
    for (const keyword of project.keywords) {
      const normalized = normalizeText(keyword);
      if (normalized && query.includes(normalized)) {
        score += 20;
        reasons.push(`keyword:${keyword}`);
      }
    }
    if (!best || score > best.score) {
      best = { project, score, reasons };
    }
  }
  return best && best.score > 0 ? best : null;
}

function isPlatformCoreProject(project) {
  return project?.id === "ai-control-platform" || project?.projectType === "platform-core";
}

function promptRouteOverridesCwd(promptRoute, cwdProject) {
  if (!promptRoute || !isPlatformCoreProject(promptRoute.project)) {
    return false;
  }
  if (!cwdProject) {
    return true;
  }
  if (cwdProject.id === promptRoute.project.id) {
    return false;
  }
  return promptRoute.score >= 100;
}

function toolCommand(input) {
  const toolInput = input.tool_input || input.toolInput || {};
  return String(toolInput.command || toolInput.cmd || toolInput.patch || "");
}

function toolTargetPaths(input) {
  const toolInput = input.tool_input || input.toolInput || {};
  const candidates = [
    toolInput.file_path,
    toolInput.path,
    toolInput.cwd,
    toolInput.workdir,
  ].filter(Boolean);
  const command = toolCommand(input);
  const fileMatches = command.matchAll(/^\*{3}\s+(?:Add|Update|Delete) File:\s+(.+)$/gm);
  for (const match of fileMatches) {
    candidates.push(match[1]);
  }
  if (!candidates.length) {
    candidates.push(input.cwd || process.cwd());
  }
  return candidates.map((candidate) => {
    const value = String(candidate || "").trim();
    return path.isAbsolute(value) ? value : path.resolve(input.cwd || process.cwd(), value);
  });
}

function isMutation(input) {
  const toolName = String(input.tool_name || input.toolName || "").toLowerCase();
  if (/apply_patch|edit|write|multiedit|notebookedit/.test(toolName)) {
    return true;
  }
  const command = toolCommand(input);
  if (!command) {
    return false;
  }
  return [
    /(^|\s)(apply_patch|tee|touch|mv|cp|rm|mkdir|rmdir)\b/i,
    /(^|\s)git\s+(add|commit|merge|rebase|worktree\s+add|branch\s+-D)\b/i,
    /(^|\s)npm\s+run\s+(build|check)\b/i,
    /(^|\s)npm\s+(install|ci)\b/i,
    /(^|\s)python3?\b.*\b(write|open\(|Path\()/i,
    /(^|\s)(>|>>)/,
  ].some((pattern) => pattern.test(command));
}

function blockResponse(agent, event, reason) {
  if (event === "Stop" || event === "PreCompact" || event === "UserPromptSubmit") {
    return {
      decision: "block",
      reason,
    };
  }
  if (event === "PermissionRequest") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: reason },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isBlockingResponse(response) {
  if (!response) {
    return false;
  }
  if (response.decision === "block") {
    return true;
  }
  const hookOutput = response.hookSpecificOutput || {};
  return hookOutput.permissionDecision === "deny"
    || hookOutput.decision?.behavior === "deny";
}

function recordEvidence(state, input) {
  const command = toolCommand(input);
  const text = [
    command,
    String(input.tool_response?.stdout || ""),
    String(input.tool_response?.stderr || ""),
    JSON.stringify(input.tool_input || {}),
  ].join("\n");
  if (VALIDATION_RE.test(text)) {
    state.evidence.validation = true;
  }
  if (LIVE_RE.test(text)) {
    state.evidence.liveVerification = true;
  }
  if (DOC_RE.test(text)) {
    state.evidence.docsTouched = true;
  }
  if (/\bgit\s+(commit|merge)\b/i.test(text)) {
    state.evidence.commitOrMerge = true;
  }
  if (/\bgit\s+push\b|pushed to (origin|remote)|remote (merge|push|sync)|origin\/(main|master|trunk)/i.test(text)) {
    state.evidence.remotePush = true;
  }
  if (/\b(publish|published|rsync|launchctl|server_release_sync|local_sync)\b/i.test(text)) {
    state.evidence.publish = true;
  }
}

function sessionStart(input, state) {
  const snapshot = shortGitSnapshot();
  state.lastGitSnapshotAt = new Date().toISOString();
  state.lastGitSnapshot = snapshot;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: [
        "Workflow guard is active. Before editing, use an isolated task worktree; canonical checkouts are read/integration/publish baselines.",
        "Current repository snapshot:",
        snapshot,
      ].join("\n\n"),
    },
  };
}

function userPromptSubmit(input, state) {
  const cwdClassification = classifyPath(input.cwd || process.cwd());
  const promptRoute = resolvePromptRoute(input.prompt || "");
  const route = promptRouteOverridesCwd(promptRoute, cwdClassification.project)
    ? {
      ...promptRoute,
      reasons: [
        ...promptRoute.reasons,
        cwdClassification.project ? `overrode cwd:${cwdClassification.project.id}` : "prompt-platform-core",
      ],
    }
    : cwdClassification.project
      ? { project: cwdClassification.project, score: 1000, reasons: [cwdClassification.inCanonical ? "cwd:canonical" : "cwd:worktree"] }
      : promptRoute;
  if (route) {
    const record = {
      at: new Date().toISOString(),
      projectId: route.project.id,
      projectName: route.project.name,
      repoPath: route.project.repoPath,
      score: route.score,
      reasons: route.reasons,
      canonicalDocs: route.project.canonicalDocs,
    };
    state.routes.push(record);
    state.lastRoute = record;
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [
          `Workspace route resolved to ${record.projectId} (${record.projectName}).`,
          `Repo: ${record.repoPath}`,
          record.canonicalDocs.length ? `Canonical docs:\n${record.canonicalDocs.map((item) => `- ${item}`).join("\n")}` : "",
        ].filter(Boolean).join("\n"),
      },
    };
  }
  return null;
}

function preToolUse(input, state, agent, event) {
  if (!isMutation(input)) {
    return null;
  }
  const targets = toolTargetPaths(input);
  const classifications = targets.map(classifyPath);
  const blocked = classifications.find((item) => item.project && item.inCanonical && !item.inWorkerWorktree && !item.inServerWorktree);
  if (blocked) {
    return blockResponse(
      agent,
      event,
      [
        `Workflow gate blocked mutation inside canonical checkout for ${blocked.project.id}.`,
        `Target: ${blocked.path}`,
        "Create or use an isolated task worktree under ~/codex/worker-workspaces/<project-id>/<yyyymmdd>-<slug>-<taskid8> before editing.",
      ].join("\n"),
    );
  }
  const firstProject = classifications.find((item) => item.project)?.project || null;
  state.mutations.push({
    at: new Date().toISOString(),
    event,
    toolName: input.tool_name || input.toolName || "",
    projectId: firstProject?.id || "",
    targetPaths: targets,
  });
  if (targets.some((target) => DOC_RE.test(target))) {
    state.evidence.docsTouched = true;
  }
  return null;
}

function latestProjectFromState(state, input) {
  const cwdProject = classifyPath(input.cwd || process.cwd()).project;
  const mutationProjectId = [...state.mutations].reverse().find((item) => item.projectId)?.projectId || "";
  if (cwdProject) {
    return cwdProject;
  }
  if (mutationProjectId) {
    return loadWorkspaceIndex().find((project) => project.id === mutationProjectId) || null;
  }
  return null;
}

function stopGate(input, state, agent, event) {
  const lastMessage = String(input.last_assistant_message || input.lastAssistantMessage || "");
  if (!COMPLETION_RE.test(lastMessage)) return null;
  const hasRecordedMutations = state.mutations.length > 0;
  const project = latestProjectFromState(state, input);
  const byId = new Map(loadWorkspaceIndex().map((item) => [item.id, item]));
  const projectsToCheck = [...new Set(state.mutations.map((item) => item.projectId).filter(Boolean))].map((id) => byId.get(id)).filter(Boolean);
  if (!projectsToCheck.length && project) projectsToCheck.push(project);
  const missing = [];
  if (hasRecordedMutations && !state.evidence.validation) missing.push("run and record a relevant validation command");
  if (hasRecordedMutations && project?.liveVerificationRequired && !state.evidence.liveVerification) {
    missing.push("verify the real served route in a browser or with live route evidence");
  }
  if (hasRecordedMutations && !state.evidence.docsTouched) missing.push("update the durable project docs/status files or write a handoff before closing");
  const git = hasDirtyGit(input.cwd || process.cwd());
  if (git.dirty) missing.push(`commit or intentionally resolve dirty git state in ${git.repo}`);
  if (!projectsToCheck.length) {
    const remote = gitRemoteSyncState(git.repo || input.cwd || process.cwd());
    if (remote.checked && !remote.synced) {
      missing.push(`push/merge the canonical branch to its upstream remote (${remote.reason})`);
    } else if (!remote.checked && state.evidence.commitOrMerge && !state.evidence.remotePush) {
      missing.push("record upstream remote push/merge evidence for the canonical branch");
    }
  }
  for (const item of projectsToCheck) {
    const remote = gitRemoteSyncState(item.repoPath);
    if (remote.checked && !remote.synced) {
      missing.push(`push/merge the canonical branch for ${item.id} to its upstream remote (${remote.reason})`);
    } else if (!remote.checked && state.evidence.commitOrMerge && !state.evidence.remotePush) {
      missing.push(`record upstream remote push/merge evidence for ${item.id}`);
    }
    missing.push(...mainlineContainmentGaps(item.repoPath, state.mutations.filter((mutation) => mutation.projectId === item.id), { checkRelease: Boolean(state.evidence.publish || item.liveVerificationRequired) }));
  }
  if (!missing.length) return null;
  return blockResponse(
    agent,
    event,
    `Workflow closeout gate is incomplete:\n- ${missing.join("\n- ")}\nContinue the task and satisfy these items before presenting it as complete.`,
  );
}

function compactGate(input, state, agent, event) {
  if (!state.mutations.length || state.evidence.docsTouched) return null;
  return blockResponse(
    agent,
    event,
    "Workflow compact gate blocked compaction because this session changed files without updating durable status/handoff docs. Write current phase, decisions, progress, blockers, and next steps first.",
  );
}

function main() {
  const args = parseArgs(process.argv);
  const input = readStdinJson();
  const event = args.event || input.hook_event_name || input.hookEventName || "";
  const { filePath, state } = loadSessionState(input);
  state.events.push({ at: new Date().toISOString(), event, cwd: input.cwd || process.cwd() });

  let response = null;
  if (event === "SessionStart") {
    response = sessionStart(input, state);
  } else if (event === "UserPromptSubmit") {
    response = userPromptSubmit(input, state);
  } else if (event === "PreToolUse" || event === "PermissionRequest") {
    response = preToolUse(input, state, args.agent, event);
  } else if (event === "PostToolUse" || event === "PostToolUseFailure" || event === "PostToolBatch") {
    recordEvidence(state, input);
  } else if (event === "Stop" || event === "SubagentStop") {
    response = stopGate(input, state, args.agent, "Stop");
  } else if (event === "PreCompact") {
    response = compactGate(input, state, args.agent, event);
  }

  saveSessionState(filePath, state);
  if (response) {
    printJson(response);
    if (args.agent === "claude" && isBlockingResponse(response)) {
      process.exitCode = 2;
    }
  }
}

main();
