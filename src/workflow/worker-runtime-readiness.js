import { basename } from "node:path";

export const WORKER_RUNTIME_READINESS_GATE_ID = "worker-runtime-readiness";
export const PLAYWRIGHT_PACKAGE = "playwright";

export const PLAYWRIGHT_REQUIRED_SCRIPTS = Object.freeze([
  "check:workbench:browser-events",
  "check:workbench:frontend-acceptance",
  "check:scheduler-dispatch-writeback",
  "check:closeout"
]);

export const PLAYWRIGHT_BACKED_TOOL_FILENAMES = Object.freeze([
  "tools/check-workbench-browser-events.mjs",
  "tools/check-workbench-frontend-acceptance.mjs",
  "tools/check-scheduler-dispatch-writeback.mjs",
  "tools/check-closeout.mjs"
]);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeCommandText(value) {
  return Array.isArray(value)
    ? value.map((part) => normalizeString(part)).filter(Boolean).join(" ")
    : normalizeString(value);
}

function normalizeAvailability(value) {
  if (value === true || value === false) return { available: value };
  if (value && typeof value === "object") {
    return {
      ...value,
      available: value.available === true
    };
  }
  return { available: false };
}

function dependencyReason(kind, value, matched) {
  return {
    kind,
    value,
    matched,
    dependency: PLAYWRIGHT_PACKAGE
  };
}

function commandContainsToolFilename(command, filename) {
  if (!command) return false;
  return command.includes(filename) || command.includes(basename(filename));
}

export function collectWorkerRuntimeRequirements(input = {}) {
  const scripts = asArray(input.scripts || input.script).map(normalizeString).filter(Boolean);
  const commands = asArray(input.commands || input.command || input.argv)
    .map(normalizeCommandText)
    .filter(Boolean);
  const detections = [];

  for (const script of scripts) {
    if (PLAYWRIGHT_REQUIRED_SCRIPTS.includes(script)) {
      detections.push(dependencyReason("script", script, script));
    }
  }

  for (const command of commands) {
    for (const script of PLAYWRIGHT_REQUIRED_SCRIPTS) {
      if (command.includes(script)) {
        detections.push(dependencyReason("command_script", command, script));
      }
    }
    for (const filename of PLAYWRIGHT_BACKED_TOOL_FILENAMES) {
      if (commandContainsToolFilename(command, filename)) {
        detections.push(dependencyReason("command_tool", command, filename));
      }
    }
  }

  return {
    requested_scripts: scripts,
    requested_commands: commands,
    required_packages: [...new Set(detections.map((item) => item.dependency))],
    detections
  };
}

export function evaluateWorkerRuntimeReadiness(input = {}) {
  const requirements = collectWorkerRuntimeRequirements(input);
  const availabilityInput = input.package_availability || input.packageAvailability || {};
  const packageAvailability = {};
  const issues = [];

  for (const packageName of requirements.required_packages) {
    const availability = normalizeAvailability(availabilityInput[packageName]);
    packageAvailability[packageName] = availability;
    if (!availability.available) {
      issues.push({
        code: "missing_runtime_dependency",
        gate_id: WORKER_RUNTIME_READINESS_GATE_ID,
        dependency: packageName,
        requested_by: requirements.detections
          .filter((item) => item.dependency === packageName)
          .map(({ kind, value, matched }) => ({ kind, value, matched })),
        message: `${packageName} must be locally available before running browser-backed worker validation`
      });
    }
  }

  return {
    gate_id: WORKER_RUNTIME_READINESS_GATE_ID,
    status: issues.length > 0 ? "fail" : "pass",
    requested_scripts: requirements.requested_scripts,
    requested_commands: requirements.requested_commands,
    required_packages: requirements.required_packages,
    package_availability: packageAvailability,
    detections: requirements.detections,
    issues
  };
}
