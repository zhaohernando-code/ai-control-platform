function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function statusOf(value) {
  return normalizeString(value).toLowerCase();
}

function finding({
  id,
  category,
  dimension,
  severity = "medium",
  title,
  message,
  evidence = [],
  owned_files = [],
  acceptance_gates = [],
  recommended_fix = "",
  evidence_needed = "",
  recommendation = "",
  options,
  priority_choices,
  scope_choices,
  depth_choices,
  automation_authority_choices,
  cadence_choices,
  cost_ceiling_choices,
  output_choices
}) {
  return {
    id,
    category,
    dimension,
    severity,
    title,
    message,
    evidence: asArray(evidence).map(normalizeString).filter(Boolean),
    owned_files,
    acceptance_gates,
    recommended_fix,
    evidence_needed,
    recommendation,
    options,
    priority_choices,
    scope_choices,
    depth_choices,
    automation_authority_choices,
    cadence_choices,
    cost_ceiling_choices,
    output_choices
  };
}

function projectStatusFindings(projectStatus = {}) {
  const findings = [];
  const blockers = asArray(projectStatus.blockers);
  if (blockers.length > 0) {
    findings.push(finding({
      id: "project-status-has-blockers",
      category: "defect",
      dimension: "flow_integrity",
      severity: "high",
      title: "项目状态仍存在阻塞项",
      message: `PROJECT_STATUS 记录了 ${blockers.length} 个阻塞项，治理流程不能把当前系统视为健康。`,
      recommended_fix: "把 PROJECT_STATUS.blockers 转成可派发修复工作包，逐项清理后再进入完成判断。",
      evidence: blockers.map((blocker) => normalizeString(blocker.id || blocker.title || blocker.reason || blocker)),
      owned_files: ["PROJECT_STATUS.json"],
      acceptance_gates: ["npm run check:closeout"]
    }));
  }

  if (normalizeString(projectStatus.next_step)) {
    findings.push(finding({
      id: "project-status-next-step-open",
      category: "evidence_gap",
      dimension: "iteration_evolution",
      severity: "medium",
      title: "项目状态仍有下一步但治理未形成闭环证据",
      message: "PROJECT_STATUS.next_step 仍存在，说明系统还有未完成的持续推进事项。",
      evidence_needed: "确认该 next_step 是否已经被 Context Pack、Work Package 或调度器接管，并记录可追踪证据。",
      evidence: [projectStatus.next_step],
      owned_files: ["PROJECT_STATUS.json", "src/workflow/project-status-continuation.js"],
      acceptance_gates: ["npm run check:closeout"]
    }));
  }

  return findings;
}

function gateFindings(input = {}) {
  const findings = [];
  const gates = [
    {
      key: "git_worktree_isolation",
      id: "git-worktree-isolation-failed",
      title: "Git 工作区隔离门禁失败",
      dimension: "quality_gate",
      owned_files: ["src/workflow/git-worktree-isolation.js", "tools/check-git-worktree-isolation.mjs"],
      acceptance_gates: ["npm run check:git-worktree-isolation", "npm run check:closeout"]
    },
    {
      key: "closeout",
      id: "closeout-failed",
      title: "收口门禁失败",
      dimension: "quality_gate",
      owned_files: ["tools/check-closeout.mjs"],
      acceptance_gates: ["npm run check:closeout"]
    },
    {
      key: "process_hardening",
      id: "process-hardening-failed",
      title: "流程硬化门禁失败",
      dimension: "system_robustness",
      owned_files: ["src/workflow/process-hardening.js", "tools/check-process-hardening.mjs"],
      acceptance_gates: ["npm run check:process-hardening", "npm run check:closeout"]
    }
  ];

  for (const gate of gates) {
    const result = input[gate.key] || input.gates?.[gate.key];
    if (!isObject(result) || statusOf(result.status) === "pass" || statusOf(result.status) === "not_configured") continue;
    const issues = asArray(result.issues);
    findings.push(finding({
      id: gate.id,
      category: "defect",
      dimension: gate.dimension,
      severity: "high",
      title: gate.title,
      message: issues[0]?.message || `${gate.key} status is ${result.status}`,
      recommended_fix: "失败门禁必须直接进入中台开发流程修复，不能只停留为告警。",
      evidence: issues.map((item) => item.code || item.message),
      owned_files: gate.owned_files,
      acceptance_gates: gate.acceptance_gates
    }));
  }

  return findings;
}

function commandFindings(input = {}) {
  return asArray(input.command_results || input.commandResults).flatMap((result) => {
    if (!isObject(result) || statusOf(result.status) === "pass") return [];
    const commandId = normalizeString(result.id || result.command || "governance-command");
    const commandText = `${result.error || ""}\n${result.stderr || ""}\n${result.stdout || ""}`;
    const hasArtifact = isObject(result.artifact) || result.artifact_status || result.artifactStatus;
    const failedToRun = statusOf(result.status) === "error" ||
      statusOf(result.status) === "not_runnable" ||
      (!hasArtifact && (
        commandText.includes("ERR_MODULE_NOT_FOUND") ||
        commandText.includes("Cannot find package") ||
        commandText.includes("command not found") ||
        commandText.includes("did not produce a readable artifact")
      ));
    return [finding({
      id: `governance-command-${commandId.replace(/[^a-zA-Z0-9._-]+/g, "-")}`,
      category: failedToRun ? "evidence_gap" : "defect",
      dimension: failedToRun ? "flow_integrity" : "quality_gate",
      severity: failedToRun ? "medium" : "high",
      title: failedToRun ? "治理扫描命令无法执行" : "治理扫描命令执行失败",
      message: result.error || result.stderr || `${result.command || commandId} exited with ${result.exit_code ?? "unknown"}`,
      recommended_fix: failedToRun ? "" : "失败的治理门禁必须进入中台开发流程修复。",
      evidence_needed: failedToRun ? "补齐运行依赖或命令环境后重新采集真实门禁证据。" : "",
      evidence: [result.command, result.stdout, result.stderr].filter(Boolean),
      owned_files: ["package.json", "tools"],
      acceptance_gates: ["npm run check:closeout"]
    })];
  });
}

function frontendAcceptanceFindings(frontendAcceptance = {}) {
  const status = statusOf(frontendAcceptance.status);
  if (!status || status === "pass" || status === "not_configured") return [];

  if (frontendAcceptance.repair_required === true || Number(frontendAcceptance.blocking_count || 0) > 0 || status === "fail") {
    const workPackage = frontendAcceptance.repair_work_package || {};
    return [finding({
      id: "frontend-acceptance-blockers",
      category: "defect",
      dimension: "user_experience",
      severity: "high",
      title: "前端验收存在阻塞问题",
      message: frontendAcceptance.latest_finding || "PC/mobile workbench frontend acceptance has blocking findings.",
      recommended_fix: "使用前端验收修复工作包处理 PC/mobile 可见性、导航、资源和布局问题。",
      evidence: [
        frontendAcceptance.artifact_id,
        `${frontendAcceptance.blocking_count || 0} blocking frontend finding(s)`,
        ...asArray(frontendAcceptance.finding_codes)
      ],
      owned_files: asArray(workPackage.owned_files).length ? workPackage.owned_files : ["apps/workbench", "test/workbench-shell.test.js"],
      acceptance_gates: asArray(workPackage.acceptance_gates).length
        ? workPackage.acceptance_gates
        : ["npm run check:workbench:frontend-acceptance", "npm run check:workbench:browser-events", "npm run check:closeout"]
    })];
  }

  return [finding({
    id: "frontend-acceptance-evidence-missing",
    category: "evidence_gap",
    dimension: "user_experience",
    severity: "medium",
    title: "前端验收状态不可判定",
    message: `frontend acceptance status is ${frontendAcceptance.status}`,
    evidence_needed: "补充最新 PC/mobile release acceptance artifact，再决定是否需要修复。",
    evidence: [frontendAcceptance.artifact_id],
    owned_files: ["tools/check-workbench-frontend-acceptance.mjs"],
    acceptance_gates: ["npm run check:workbench:frontend-acceptance"]
  })];
}

function browserEventFindings(workbenchBrowserEvents = {}) {
  const status = statusOf(workbenchBrowserEvents.status);
  if (!status || status === "pass" || status === "not_configured") return [];
  return [finding({
    id: "workbench-browser-events-not-pass",
    category: status === "fail" ? "defect" : "evidence_gap",
    dimension: "quality_gate",
    severity: status === "fail" ? "high" : "medium",
    title: "工作台浏览器事件验收未通过",
    message: `workbench browser events status is ${workbenchBrowserEvents.status}`,
    recommended_fix: "修复浏览器事件场景失败项，并重新生成可写回的验收 artifact。",
    evidence_needed: "补充完整 browser-events run artifact，确认是否为真实 UI 缺陷。",
    evidence: [
      workbenchBrowserEvents.artifact_id,
      `${workbenchBrowserEvents.scenario_count || 0} scenario(s)`,
      `${workbenchBrowserEvents.overflow_count || 0} overflow issue(s)`
    ],
    owned_files: ["tools/check-workbench-browser-events.mjs", "apps/workbench"],
    acceptance_gates: ["npm run check:workbench:browser-events", "npm run check:closeout"]
  })];
}

function schedulerFindings(input = {}) {
  const findings = [];
  const dispatch = input.scheduler_dispatch || {};
  const continuation = input.scheduler_continuation || {};
  const loop = input.scheduler_loop || {};

  if (["fail", "blocked"].includes(statusOf(dispatch.status))) {
    findings.push(finding({
      id: "scheduler-dispatch-not-pass",
      category: "defect",
      dimension: "flow_integrity",
      severity: "high",
      title: "调度派发未通过",
      message: dispatch.policy_latest_issue || `scheduler dispatch status is ${dispatch.status}`,
      recommended_fix: "修复 scheduler dispatch plan、策略或执行器失败项，并写回调度证据。",
      evidence: [dispatch.artifact_id, dispatch.policy_status, dispatch.policy_latest_issue],
      owned_files: ["src/workflow/scheduler-dispatch-plan.js", "tools/run-scheduler-dispatch-plan.mjs"],
      acceptance_gates: ["npm run check:scheduler-dispatch-writeback", "npm run check:closeout"]
    }));
  }

  if (continuation.ready === true && Number(continuation.next_work_package_count || 0) > 0) {
    findings.push(finding({
      id: "scheduler-continuation-ready-not-consumed",
      category: "evidence_gap",
      dimension: "flow_integrity",
      severity: "medium",
      title: "调度续跑已就绪但缺少消费证据",
      message: "scheduler continuation is ready and still has next work packages.",
      evidence_needed: "补充下一轮 scheduler loop 消费 continuation 的写回证据。",
      evidence: [continuation.artifact_id, `${continuation.next_work_package_count} package(s)`],
      owned_files: ["src/workflow/scheduler-dispatch-continuation.js", "src/workflow/autonomous-scheduler-loop.js"],
      acceptance_gates: ["npm run check:scheduler-dispatch-writeback", "npm run check:closeout"]
    }));
  }

  if (["fail", "blocked"].includes(statusOf(loop.status))) {
    findings.push(finding({
      id: "autonomous-scheduler-loop-not-pass",
      category: "defect",
      dimension: "recovery_capability",
      severity: "high",
      title: "自主调度循环未通过",
      message: loop.latest_issue || `scheduler loop status is ${loop.status}`,
      recommended_fix: "修复自主调度循环恢复或执行策略，确保可从 durable state 续跑。",
      evidence: [loop.latest_projection_id, loop.latest_issue],
      owned_files: ["src/workflow/autonomous-scheduler-loop.js", "tools/run-autonomous-scheduler-loop.mjs"],
      acceptance_gates: ["npm run check:closeout"]
    }));
  }

  return findings;
}

function modelCollaborationFindings(input = {}) {
  const findings = [];
  const providerHealth = input.reviewer_provider_health || input.provider_health || {};
  const shardReview = input.reviewer_shard_review || input.shard_review || {};

  if (["unhealthy", "blocked", "fail"].includes(statusOf(providerHealth.provider_health || providerHealth.status))) {
    findings.push(finding({
      id: "reviewer-provider-unhealthy",
      category: "evidence_gap",
      dimension: "model_collaboration",
      severity: "medium",
      title: "模型评审 Provider 健康状态异常",
      message: providerHealth.latest_issue || providerHealth.next_action || "reviewer provider health is not healthy.",
      evidence_needed: "补充 provider smoke、fallback 或 shard split 证据，判断是否需要切模型或拆分任务。",
      evidence: [providerHealth.artifact_id, providerHealth.next_action],
      owned_files: ["src/workflow/reviewer-provider-health.js", "src/workflow/reviewer-scope-split.js"],
      acceptance_gates: ["npm run check:closeout"]
    }));
  }

  if (Number(shardReview.pending_shards || 0) > 0) {
    findings.push(finding({
      id: "reviewer-shards-pending",
      category: "evidence_gap",
      dimension: "model_collaboration",
      severity: "medium",
      title: "模型评审仍有分片待完成",
      message: `${shardReview.pending_shards} reviewer shard(s) are still pending.`,
      evidence_needed: "继续执行待完成 reviewer shard，并生成 aggregate 证据。",
      evidence: [shardReview.next_shard],
      owned_files: ["src/workflow/reviewer-shard-runner.js", "tools/run-reviewer-shard.mjs"],
      acceptance_gates: ["npm run check:closeout"]
    }));
  }

  return findings;
}

function governanceProcessFindings(input = {}, generatedFindings = []) {
  if (generatedFindings.length > 0) return [];
  if (input.require_scanner_findings !== true && input.requireScannerFindings !== true) return [];

  return [finding({
    id: "self-governance-no-real-findings-recorded",
    category: "evidence_gap",
    dimension: "flow_integrity",
    severity: "low",
    title: "本轮自我治理没有发现真实问题，但仍需保留扫描证据",
    message: "治理扫描器没有从真实门禁和状态中发现问题；这不是手工样本结论，需要保留已扫描来源清单。",
    evidence_needed: "记录本轮扫描覆盖的真实证据源，避免把空结果误读为未执行检查。",
    evidence: asArray(input.evidence_sources || input.evidenceSources),
    owned_files: ["src/workflow/self-governance-scanner.js", "tools/build-self-governance-report.mjs"],
    acceptance_gates: ["node --test test/self-governance.test.js"]
  })];
}

export function generateSelfGovernanceFindings(input = {}) {
  const sources = input.governance_sources || input.governanceSources || input;
  const generated = [
    ...projectStatusFindings(sources.project_status || sources.projectStatus || {}),
    ...commandFindings(sources),
    ...gateFindings(sources),
    ...frontendAcceptanceFindings(sources.frontend_acceptance || sources.frontendAcceptance || {}),
    ...browserEventFindings(sources.workbench_browser_events || sources.workbenchBrowserEvents || {}),
    ...schedulerFindings(sources),
    ...modelCollaborationFindings(sources)
  ];
  const fallback = governanceProcessFindings(sources, generated);

  return {
    version: "self-governance-scan.v1",
    status: "pass",
    source_count: Object.keys(sources || {}).length,
    finding_count: generated.length + fallback.length,
    findings: [...generated, ...fallback]
  };
}
