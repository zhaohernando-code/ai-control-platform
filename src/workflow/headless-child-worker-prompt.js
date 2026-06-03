import {
  promptSafeContextPack,
  promptSafeWorkflowIdentity,
  promptSafeWorkPackage,
  promptSafetyPreamble
} from "./external-prompt-safety.js";
import {
  selectedChildAcceptanceGates,
  selectedParentAcceptanceGates,
  withAcceptanceGates
} from "./headless-acceptance-gates.js";
import { CHILD_WORKER_ROLE } from "./headless-worker-planning.js";

function normalizeString(value) {
  return String(value || "").trim();
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function childWorkerCommandOutputPath(workPackage = {}, options = {}) {
  const explicit = normalizeString(options.child_worker_output_path || options.childWorkerOutputPath);
  if (!explicit) return null;
  return explicit
    .replaceAll("{work_package_id}", safeIdPart(workPackage.id))
    .replaceAll("{run_id}", safeIdPart(options.run_id || options.runId || "run"))
    .replaceAll("{cycle_id}", safeIdPart(options.cycle_id || options.cycleId || "cycle"));
}

function promptSafeFocusedContextPack(contextPack = {}, workPackage = {}, acceptanceGates = []) {
  const safeContextPack = promptSafeContextPack(contextPack);
  const focusedWorkPackage = withAcceptanceGates(workPackage, acceptanceGates);
  return {
    ...safeContextPack,
    acceptance_gates: acceptanceGates,
    subtasks: [promptSafeWorkPackage(focusedWorkPackage)]
  };
}

export function headlessChildWorkerPrompt(workflowState = {}, workPackage = {}, options = {}) {
  const contextPack = workflowState?.manifest?.context_pack || {};
  const acceptanceGates = selectedChildAcceptanceGates(workPackage, contextPack, options);
  const parentAcceptanceGates = selectedParentAcceptanceGates(workPackage, contextPack, options);
  const focusedWorkPackage = withAcceptanceGates(workPackage, acceptanceGates);
  const outputPath = normalizeString(options.child_worker_output_path_resolved || options.childWorkerOutputPathResolved) ||
    childWorkerCommandOutputPath(workPackage, {
      ...options,
      run_id: workflowState?.manifest?.run_id,
      cycle_id: workflowState?.manifest?.cycle_id
    });
  const outputPathInstructions = outputPath
    ? [
        "",
        "Final response protocol:",
        `- Write exactly one JSON object to child_worker_output_path: ${outputPath}`,
        "- Also print exactly the same JSON object as the final stdout content.",
        "- The JSON object must match the Required JSON shape above."
      ]
    : [];
  return [
    "# AI Control Platform Bounded Implementation Task",
    "",
    "role=bounded_implementation_worker",
    "host=platform_core",
    "Return exactly one JSON object. Do not wrap it in prose.",
    "",
    promptSafetyPreamble(),
    "",
    "You are not the coordinator. Only implement the bounded task.",
    "",
    "Required rules:",
    "- Read AGENTS.md, PROCESS.md, PROJECT_STATUS.json, PROJECT_RULES.md, docs/contracts/CODEX_PROXY_HANDOFF_CN.md, and this task context.",
    "- Do not read more than five extra files outside the task context unless you first report why.",
    "- First produce the minimum runnable diff, then explain design.",
    "- If no patch is possible within the time box, return status=fail with no_diff=true, blocker, read_files, and next_minimal_patch_position.",
    "- If the current mainline already satisfies the selected task, return status=pass with changed_files=[], no_diff=true, passing child gates, durable state evidence, and continuation readiness.",
    "- Do not modify managed projects, legacy directories, or files outside owned_files.",
    "- Do not create, switch to, or delegate into another worktree; the current working directory is the only execution root for this bounded child task.",
    "- Do not create .claude/worktrees or run claude --worktree; return status=fail if the current execution root is unsuitable.",
    "- If you are running inside an isolated worker worktree, commit the bounded changes on the current worker branch before returning status=pass; the parent runner owns mainline integration.",
    "- Run only the child acceptance gates listed below. Do not run deferred parent-owned release gates from the isolated worker branch.",
    "- Deferred parent-owned release gates are not your failure criteria. If all child acceptance gates pass and your bounded diff is committed, return status=pass, process_hardening={required:false,status:\"not_required\"}, continuation_readiness.ready=true, and self_evaluation.aligned=true.",
    "- Do not set process_hardening.status=\"pending\", continuation_readiness.ready=false, or self_evaluation.aligned=false solely because deferred_parent_gates remain for the parent runner.",
    "",
    "Required JSON shape:",
    JSON.stringify({
      status: "pass|fail",
      role: CHILD_WORKER_ROLE,
      host: "platform_core",
      changed_files: ["owned file path"],
      no_diff: false,
      test_results: [{ command: "focused test command", status: "pass|fail" }],
      deferred_parent_gates: ["parent-owned gate not run by child"],
      durable_state_updated: true,
      process_hardening: { required: false, status: "not_required|completed" },
      continuation_readiness: { ready: true },
      self_evaluation: { aligned: true, drifted: false, evidence_sufficient: true },
      blocker: null,
      read_files: [],
      next_minimal_patch_position: null
    }, null, 2),
    "",
    "Workflow identity:",
    JSON.stringify(promptSafeWorkflowIdentity(workflowState), null, 2),
    "",
    "Task context:",
    JSON.stringify(promptSafeFocusedContextPack(contextPack, workPackage, acceptanceGates), null, 2),
    "",
    "Selected task:",
    JSON.stringify(promptSafeWorkPackage(focusedWorkPackage), null, 2),
    "",
    "Child acceptance gates:",
    JSON.stringify(acceptanceGates, null, 2),
    "",
    "Deferred parent-owned release gates:",
    JSON.stringify(parentAcceptanceGates, null, 2),
    ...outputPathInstructions
  ].join("\n");
}
