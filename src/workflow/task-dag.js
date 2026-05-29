import { PASS_SYNONYMS, FAIL_SYNONYMS, RUNNING_SYNONYMS, PENDING_SYNONYMS } from "./status-vocabulary.js";

const ALLOWED_STATUSES = new Set(["blocked", "done", "running", "pending", "rerun", "rollback"]);
const NON_DISPATCHABLE_STATUSES = new Set(["blocked", "done", "running"]);

// task-dag treats "done" as a success token IN ADDITION to the shared PASS_SYNONYMS
// (autonomous-run intentionally does not — see status-vocabulary.js + the two
// characterization nets). Keep this local addition so behavior is preserved exactly.
const DONE_STATUSES = new Set(["done", ...PASS_SYNONYMS]);
const BLOCKED_STATUSES = new Set(FAIL_SYNONYMS);
const RUNNING_STATUSES = new Set(RUNNING_SYNONYMS);
const PENDING_STATUSES = new Set(PENDING_SYNONYMS);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function issue(code, message, path) {
  return { code, message, path };
}

function nodeId(workPackage, index) {
  return normalizeString(
    workPackage?.id ||
      workPackage?.work_package_id ||
      workPackage?.task_id ||
      workPackage?.gate_id ||
      workPackage?.name ||
      `wp-${index + 1}`
  );
}

function nodeTitle(workPackage, id) {
  return normalizeString(workPackage?.title || workPackage?.summary || workPackage?.name || id);
}

function dependenciesFor(workPackage) {
  return compactStrings(workPackage?.depends_on || workPackage?.dependencies || workPackage?.after);
}

function normalizeStatus(value, fallback = "pending") {
  const status = normalizeToken(value);

  if (!status) return fallback;
  if (DONE_STATUSES.has(status)) return "done";
  if (RUNNING_STATUSES.has(status)) return "running";
  if (BLOCKED_STATUSES.has(status)) return "blocked";
  if (PENDING_STATUSES.has(status)) return "pending";
  if (status === "rerun") return "rerun";
  if (status === "rollback") return "rollback";

  return status;
}

function defaultStatusFor(workPackage, fallback = "pending") {
  if (workPackage?.dispatch_allowed === false) return "blocked";

  const action = normalizeToken(workPackage?.action);
  if (action === "rerun" || action === "rollback") return action;

  return fallback;
}

function normalizeNode(workPackage, index, options = {}) {
  const id = nodeId(workPackage, index);
  const fallbackStatus = options.defaultStatus || defaultStatusFor(workPackage);

  return {
    id,
    title: nodeTitle(workPackage, id),
    depends_on: dependenciesFor(workPackage),
    status: normalizeStatus(workPackage?.status || workPackage?.state || workPackage?.result || workPackage?.outcome, fallbackStatus),
    owned_files: compactStrings(workPackage?.owned_files),
    acceptance_gates: compactStrings(workPackage?.acceptance_gates || workPackage?.acceptanceGates),
    action: normalizeToken(workPackage?.action) || null,
    blocked_reasons: asArray(workPackage?.blocked_reasons),
    source: workPackage?.source || null
  };
}

function extractWorkPackages(input) {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return [];

  if (Array.isArray(input.nodes)) return input.nodes;

  return [
    ...asArray(input.work_packages),
    ...asArray(input.workPackages),
    ...asArray(input.next_work_packages),
    ...asArray(input.nextWorkPackages),
    ...asArray(input.subtasks)
  ];
}

function edgesFor(nodes) {
  return nodes.flatMap((node) => node.depends_on.map((dependencyId) => ({ from: dependencyId, to: node.id })));
}

function idCounts(nodes) {
  return nodes.reduce((counts, node) => {
    counts.set(node.id, (counts.get(node.id) || 0) + 1);
    return counts;
  }, new Map());
}

function detectCycles(nodes, issues) {
  const counts = idCounts(nodes);
  const graph = new Map();

  for (const node of nodes) {
    if (!node.id || counts.get(node.id) > 1) continue;
    graph.set(node.id, node.depends_on.filter((dependencyId) => counts.has(dependencyId)));
  }

  const visiting = new Set();
  const visited = new Set();

  function visit(id, stack) {
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id].join(" -> ");
      issues.push(issue("cycle_detected", `task DAG contains a cycle: ${cycle}`, "nodes"));
      return;
    }

    if (visited.has(id)) return;

    visiting.add(id);
    for (const dependencyId of graph.get(id) || []) {
      visit(dependencyId, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of graph.keys()) {
    if (!visited.has(id)) visit(id, []);
  }
}

function normalizeDag(input, options = {}) {
  const nodes = extractWorkPackages(input).map((workPackage, index) => normalizeNode(workPackage, index, options));
  return {
    status: "built",
    nodes,
    edges: edgesFor(nodes)
  };
}

export function validateTaskDag(input) {
  const dag = input?.nodes && input?.edges ? input : normalizeDag(input);
  const nodes = asArray(dag.nodes).map((node, index) => normalizeNode(node, index));
  const issues = [];
  const counts = idCounts(nodes);

  nodes.forEach((node, index) => {
    const path = `nodes[${index}]`;

    if (!node.id) {
      issues.push(issue("missing_node_id", "task node id is required", `${path}.id`));
    }

    if (node.id && counts.get(node.id) > 1) {
      issues.push(issue("duplicate_id", `${node.id} is duplicated`, `${path}.id`));
    }

    if (!ALLOWED_STATUSES.has(node.status)) {
      issues.push(
        issue(
          "invalid_status",
          `status must be one of: ${Array.from(ALLOWED_STATUSES).join(", ")}`,
          `${path}.status`
        )
      );
    }

    for (const dependencyId of node.depends_on) {
      if (dependencyId === node.id) {
        issues.push(issue("self_dependency", `${node.id} cannot depend on itself`, `${path}.depends_on`));
      } else if (!counts.has(dependencyId)) {
        issues.push(issue("unknown_dependency", `${dependencyId} is not a known task node id`, `${path}.depends_on`));
      }
    }
  });

  detectCycles(nodes, issues);

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function buildTaskDag(input, options = {}) {
  const dag = normalizeDag(input, options);
  const validation = validateTaskDag(dag);

  return {
    ...dag,
    status: validation.status,
    issues: validation.issues
  };
}

export function getDispatchableNodes(input) {
  const dag = input?.nodes && input?.edges ? input : buildTaskDag(input);
  const validation = validateTaskDag(dag);

  if (validation.status !== "pass") return [];

  const nodeById = new Map(dag.nodes.map((node) => [node.id, node]));

  return dag.nodes.filter((node) => {
    if (NON_DISPATCHABLE_STATUSES.has(node.status)) return false;
    if (node.blocked_reasons.length > 0) return false;

    return node.depends_on.every((dependencyId) => nodeById.get(dependencyId)?.status === "done");
  });
}

function sourceNodeIdFrom(decision, options) {
  return normalizeString(
    options.sourceNodeId ||
      decision?.source_node_id ||
      decision?.sourceNodeId ||
      decision?.source_work_package_id ||
      decision?.work_package_id ||
      decision?.node_id ||
      decision?.source?.id
  );
}

function mergeOrAppendNode(nodes, nextNode) {
  const existingIndex = nodes.findIndex((node) => node.id === nextNode.id);
  if (existingIndex === -1) {
    nodes.push(nextNode);
    return;
  }

  nodes[existingIndex] = {
    ...nodes[existingIndex],
    ...nextNode,
    depends_on: nextNode.depends_on.length > 0 ? nextNode.depends_on : nodes[existingIndex].depends_on,
    owned_files: nextNode.owned_files.length > 0 ? nextNode.owned_files : nodes[existingIndex].owned_files
  };
}

export function applyRunDecisionToDag(input, decision = {}, options = {}) {
  const dag = buildTaskDag(input);
  const action = normalizeStatus(decision.action || decision.status || decision.decision);
  const sourceNodeId = sourceNodeIdFrom(decision, options);
  const nodes = dag.nodes.map((node) => ({ ...node, depends_on: [...node.depends_on] }));

  if (action === "done") {
    for (const node of nodes) {
      if (node.id === sourceNodeId || (!sourceNodeId && node.status === "running")) {
        node.status = "done";
      }
    }
  } else if (action === "rerun" || action === "rollback") {
    asArray(decision.next_work_packages || decision.nextWorkPackages).forEach((workPackage, index) => {
      mergeOrAppendNode(nodes, normalizeNode(workPackage, nodes.length + index, { defaultStatus: action }));
    });
  } else if (normalizeToken(decision.action || decision.status || decision.decision) === "human_intervention") {
    for (const node of nodes) {
      if (node.status !== "done") node.status = "blocked";
    }
  }

  const nextDag = buildTaskDag(nodes);

  return {
    ...nextDag,
    applied_decision: normalizeToken(decision.action || decision.status || decision.decision) || null,
    source_node_id: sourceNodeId || null,
    blockers: asArray(decision.blockers)
  };
}

export { ALLOWED_STATUSES };
