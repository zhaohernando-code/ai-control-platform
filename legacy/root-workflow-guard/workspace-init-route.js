"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { resolveSharedSupportPath } = require("./control-paths");

function normalize(text) {
  return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(text) {
  return normalize(text).match(/[a-z0-9_/-]+/g) || [];
}

function cjkNgrams(text) {
  const grams = new Set();
  const matches = String(text || "").match(/[\u4e00-\u9fff]+/g) || [];
  for (const chunk of matches) {
    const normalizedChunk = normalize(chunk);
    if (normalizedChunk.length < 2) {
      continue;
    }
    grams.add(normalizedChunk);
    for (let size = 2; size <= Math.min(5, normalizedChunk.length); size += 1) {
      for (let start = 0; start <= normalizedChunk.length - size; start += 1) {
        grams.add(normalizedChunk.slice(start, start + size));
      }
    }
  }
  return grams;
}

const RUNTIME_HINTS = [
  "runtime",
  "live",
  "deploy",
  "deployment",
  "publish",
  "launchagent",
  "launchd",
  "tunnel",
  "health",
  "线上",
  "发布",
  "部署",
  "运行",
  "隧道",
];

const STATE_HINTS = [
  "queue",
  "worker",
  "workers",
  "approval",
  "approvals",
  "log",
  "logs",
  "state",
  "队列",
  "审批",
  "日志",
  "状态",
];

const TOKEN_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "after",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "main",
  "of",
  "on",
  "only",
  "or",
  "the",
  "to",
  "with",
]);

function meaningfulTokens(text) {
  return Array.from(new Set(
    tokenize(text).filter((token) => token && token.length >= 3 && !TOKEN_STOPWORDS.has(token)),
  ));
}

function scoreWorkspaceProject(query, project) {
  const queryNorm = normalize(query);
  const queryTokens = new Set(meaningfulTokens(query));
  const queryCjk = cjkNgrams(query);
  const aliases = Array.isArray(project?.aliases) ? project.aliases.map((item) => normalize(item)) : [];
  const keywords = Array.isArray(project?.keywords) ? project.keywords.map((item) => normalize(item)) : [];
  const displayName = normalize(project?.display_name || "");
  const projectId = normalize(project?.project_id || "");
  const routes = Object.values(project?.entry_routes || {}).join(" ").toLowerCase();
  const reasons = [];
  let score = 0;

  const exactAlias = aliases.find((alias) => queryNorm === alias);
  if (exactAlias) {
    score += 120;
    reasons.push(`exact alias match: ${exactAlias}`);
  }

  const partialAlias = aliases.find((alias) => alias && (alias.includes(queryNorm) || queryNorm.includes(alias)));
  if (!exactAlias && partialAlias) {
    score += 80;
    reasons.push(`partial alias match: ${partialAlias}`);
  }

  if (queryNorm === projectId || queryNorm === displayName) {
    score += 70;
    reasons.push("exact project id/display name match");
  } else if ((projectId && queryNorm.includes(projectId)) || (displayName && queryNorm.includes(displayName))) {
    score += 40;
    reasons.push("project id/display name included in query");
  }

  const keywordHits = keywords.filter((keyword) => keyword && queryNorm.includes(keyword));
  if (keywordHits.length) {
    score += Math.min(45, 15 * keywordHits.length);
    reasons.push(`keyword match: ${keywordHits.slice(0, 3).join(", ")}`);
  }

  const tokenText = [aliases.join(" "), keywords.join(" "), displayName, projectId, normalize(project?.project_type || "")]
    .filter(Boolean)
    .join(" ");
  const overlappingTokens = Array.from(queryTokens).filter((token) => token && tokenText.includes(token));
  if (overlappingTokens.length) {
    score += Math.min(30, 10 * overlappingTokens.length);
    reasons.push(`token overlap: ${overlappingTokens.slice(0, 3).join(", ")}`);
  }

  const aliasCjk = new Set();
  for (const alias of aliases) {
    for (const gram of cjkNgrams(alias)) {
      aliasCjk.add(gram);
    }
  }
  const keywordCjk = new Set();
  for (const keyword of keywords) {
    for (const gram of cjkNgrams(keyword)) {
      keywordCjk.add(gram);
    }
  }
  const cjkHits = Array.from(queryCjk).filter((gram) => aliasCjk.has(gram) || keywordCjk.has(gram)).sort();
  if (cjkHits.length) {
    score += Math.min(36, 12 * cjkHits.length);
    reasons.push(`CJK overlap: ${cjkHits.slice(0, 3).join(", ")}`);
  }

  const routeTokens = new Set(meaningfulTokens(routes));
  const routeTokenHits = Array.from(queryTokens).filter((token) => routeTokens.has(token));
  if (routeTokenHits.length) {
    score += 10;
    reasons.push(`route overlap: ${routeTokenHits.slice(0, 3).join(", ")}`);
  }

  return {
    score,
    reasons,
  };
}

function loadWorkspaceIndex(rootDir) {
  const indexPath = resolveSharedSupportPath(rootDir, "WORKSPACE_INDEX.json");
  if (!indexPath || !fs.existsSync(indexPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.projects)) {
      return null;
    }
    return {
      indexPath,
      projects: parsed.projects,
    };
  } catch {
    return null;
  }
}

function resolveWorkspaceRoute(query, rootDir) {
  const workspaceIndex = loadWorkspaceIndex(rootDir);
  if (!workspaceIndex) {
    return null;
  }
  const ranked = workspaceIndex.projects
    .map((project) => {
      const { score, reasons } = scoreWorkspaceProject(query, project);
      return { project, score, reasons };
    })
    .sort((left, right) => right.score - left.score);
  if (!ranked.length) {
    return null;
  }
  const [best, second] = ranked;
  const bestConfidence = Math.min(0.99, best.score > 0 ? best.score / 140 : 0.05);
  return {
    indexPath: workspaceIndex.indexPath,
    query,
    best,
    secondScore: second?.score || 0,
    confidence: Number(bestConfidence.toFixed(2)),
    needsFallbackSearch: best.score < 80,
    shouldCheckRuntime: Boolean(best.project?.runtime_path) && RUNTIME_HINTS.some((hint) => normalize(query).includes(hint)),
    shouldCheckCodexSystem: STATE_HINTS.some((hint) => normalize(query).includes(hint)),
  };
}

function resolveStateProjectFromWorkspaceProject(workspaceProject, stateProjects = []) {
  if (!workspaceProject || !Array.isArray(stateProjects)) {
    return null;
  }
  const workspaceProjectId = String(workspaceProject.project_id || "").trim();
  const workspaceRepoPath = path.resolve(String(workspaceProject.repo_path || "").trim() || ".");
  const workspaceRepoBaseName = path.basename(workspaceRepoPath);

  return stateProjects.find((project) => (
    String(project?.id || "").trim() === workspaceProjectId
    || path.resolve(String(project?.path || "").trim() || ".") === workspaceRepoPath
    || path.basename(String(project?.path || "").trim() || "") === workspaceRepoBaseName
  )) || null;
}

function shouldAcceptWorkspaceRoute(route) {
  if (!route?.best?.project || route.best.score <= 0) {
    return false;
  }
  if (route.best.score <= route.secondScore) {
    return false;
  }
  return route.best.score >= 12 || route.best.reasons.some((reason) => (
    reason.startsWith("exact alias match:")
    || reason.startsWith("partial alias match:")
    || reason.startsWith("keyword match:")
    || reason.startsWith("CJK overlap:")
  ));
}

function maybeResolveTaskWorkspaceRoute(body, state, rootDir, options = {}) {
  const explicitProjectId = String(options.explicitProjectId || body?.projectId || "").trim();
  if (explicitProjectId && explicitProjectId !== "__auto_route__") {
    return null;
  }
  const query = [
    body?.workspaceHint,
    body?.title,
    body?.description,
    body?.requestedProject?.name,
    body?.requestedProject?.description,
  ].filter(Boolean).join("\n");
  if (!query.trim()) {
    return null;
  }
  const route = resolveWorkspaceRoute(query, rootDir);
  if (!route || !shouldAcceptWorkspaceRoute(route)) {
    return null;
  }
  const mappedProject = resolveStateProjectFromWorkspaceProject(route.best.project, state?.projects || []);
  if (!mappedProject) {
    return null;
  }
  return {
    indexPath: route.indexPath,
    query,
    workspaceProjectId: String(route.best.project.project_id || "").trim(),
    resolvedProjectId: String(mappedProject.id || "").trim(),
    resolvedProjectPath: String(mappedProject.path || "").trim(),
    reasons: route.best.reasons,
    confidence: route.confidence,
    score: route.best.score,
    secondScore: route.secondScore,
    canonicalDocs: Array.isArray(route.best.project.canonical_docs) ? route.best.project.canonical_docs : [],
    shouldCheckRuntime: route.shouldCheckRuntime,
    shouldCheckCodexSystem: route.shouldCheckCodexSystem,
    needsFallbackSearch: route.needsFallbackSearch,
  };
}

module.exports = {
  loadWorkspaceIndex,
  maybeResolveTaskWorkspaceRoute,
  resolveStateProjectFromWorkspaceProject,
  resolveWorkspaceRoute,
  scoreWorkspaceProject,
};
