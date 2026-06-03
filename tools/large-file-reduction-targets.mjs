export function minimumReductionFor(lines, threshold = 500) {
  const baseLines = Number(lines);
  if (!Number.isFinite(baseLines) || baseLines <= threshold) return 0;
  if (baseLines > 2000) return Math.min(Math.ceil(baseLines * 0.25), 500);
  if (baseLines > 1000) return Math.min(Math.ceil(baseLines * 0.2), 250);
  return 150;
}

function integerValue(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function targetIssue(path, code, message, extra = {}) {
  return {
    code,
    severity: "error",
    path,
    message,
    ...extra
  };
}

export function validateReductionTarget({ path, entry, currentLines, threshold = 500 }) {
  const targetThreshold = Math.max(Number(threshold) || 500, 500);
  if (entry.status !== "planned_refactor" || currentLines <= targetThreshold) {
    return { issues: [], summary: null };
  }

  const target = entry.reduction_target;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return {
      issues: [
        targetIssue(
          path,
          "planned_refactor_missing_reduction_target",
          `${path} is planned_refactor above ${targetThreshold} lines and must declare reduction_target`
        )
      ],
      summary: null
    };
  }

  const baseLines = integerValue(target.base_lines);
  const targetLines = integerValue(target.target_lines);
  const minimumReduction = integerValue(target.minimum_reduction);
  const terminalCondition = stringValue(target.terminal_condition);
  const nextPhase = stringValue(target.next_phase);
  const issues = [];

  if (!baseLines || !targetLines || !minimumReduction || !terminalCondition) {
    issues.push(targetIssue(
      path,
      "planned_refactor_invalid_reduction_target",
      `${path} reduction_target must include positive integer base_lines, target_lines, minimum_reduction, and terminal_condition`
    ));
  }

  if (baseLines && currentLines > baseLines) {
    issues.push(targetIssue(
      path,
      "planned_refactor_reduction_target_base_below_current",
      `${path} current line count exceeds reduction_target.base_lines`,
      { base_lines: baseLines, current_lines: currentLines }
    ));
  }

  const requiredMinimum = minimumReductionFor(baseLines || currentLines, targetThreshold);
  if (baseLines && minimumReduction && minimumReduction < requiredMinimum) {
    issues.push(targetIssue(
      path,
      "planned_refactor_reduction_target_too_weak",
      `${path} minimum_reduction is below the material reduction criterion`,
      {
        base_lines: baseLines,
        minimum_reduction: minimumReduction,
        required_minimum_reduction: requiredMinimum
      }
    ));
  }

  if (baseLines && targetLines && minimumReduction && targetLines > baseLines - minimumReduction) {
    issues.push(targetIssue(
      path,
      "planned_refactor_reduction_target_too_weak",
      `${path} target_lines does not reduce the file by minimum_reduction`,
      {
        base_lines: baseLines,
        target_lines: targetLines,
        minimum_reduction: minimumReduction
      }
    ));
  }

  if (baseLines && targetLines && targetLines >= baseLines) {
    issues.push(targetIssue(
      path,
      "planned_refactor_invalid_reduction_target",
      `${path} target_lines must be lower than base_lines`,
      { base_lines: baseLines, target_lines: targetLines }
    ));
  }

  return {
    issues,
    summary: {
      base_lines: baseLines,
      target_lines: targetLines,
      minimum_reduction: minimumReduction,
      required_minimum_reduction: requiredMinimum,
      terminal_condition: terminalCondition,
      next_phase: nextPhase,
      target_gap: targetLines ? Math.max(0, currentLines - targetLines) : null,
      target_met: Boolean(targetLines && currentLines <= targetLines)
    }
  };
}
