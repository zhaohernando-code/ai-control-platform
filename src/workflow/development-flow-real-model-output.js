export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "changed_files", "test_results", "completion_evidence", "self_evaluation"],
  properties: {
    status: { enum: ["pass", "fail"] },
    changed_files: {
      type: "array",
      items: { type: "string" },
      minItems: 1
    },
    test_results: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "status"],
        properties: {
          command: { type: "string" },
          status: { enum: ["pass", "fail"] }
        }
      }
    },
    completion_evidence: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string" }
      }
    },
    self_evaluation: {
      type: "object",
      additionalProperties: false,
      required: ["aligned", "skipped_steps"],
      properties: {
        aligned: { type: "boolean" },
        skipped_steps: {
          type: "array",
          items: { type: "string" }
        }
      }
    }
  }
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function issue(code, message, path = "") {
  return { code, message, path };
}

function statusPass(value) {
  return ["pass", "passed", "ok", "success"].includes(normalizeToken(value));
}

function jsonCandidate(text = "") {
  const value = normalizeString(text);
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) return value.slice(objectStart, objectEnd + 1);
  return "";
}

function normalizeParsedModelJson(parsed) {
  if (!isObject(parsed)) return null;
  if (isObject(parsed.structured_output || parsed.structuredOutput)) {
    return parsed.structured_output || parsed.structuredOutput;
  }
  if (typeof parsed.result === "string") return parseModelJson(parsed.result) || parsed;
  if (isObject(parsed.result)) return parsed.result;
  return parsed;
}

export function parseModelJson(text = "") {
  const value = normalizeString(text);
  if (!value) return null;
  try {
    return normalizeParsedModelJson(JSON.parse(value));
  } catch {
    const candidate = jsonCandidate(value);
    if (!candidate || candidate === value) return null;
    try {
      return normalizeParsedModelJson(JSON.parse(candidate));
    } catch {
      return null;
    }
  }
}

export function outputContract(parsed = {}) {
  const issues = [];
  if (!isObject(parsed)) {
    return {
      status: "fail",
      issues: [issue("model_output_not_json", "model output did not contain a JSON object")]
    };
  }
  if (!statusPass(parsed.status)) issues.push(issue("model_output_status_not_pass", "model output status must be pass", "status"));
  if (asArray(parsed.changed_files).length === 0) issues.push(issue("model_output_missing_changed_files", "changed_files is required", "changed_files"));
  if (!asArray(parsed.test_results).some((entry) => statusPass(entry?.status))) {
    issues.push(issue("model_output_missing_passing_test", "test_results must include a passing test", "test_results"));
  }
  if (!isObject(parsed.completion_evidence)) issues.push(issue("model_output_missing_completion_evidence", "completion_evidence is required", "completion_evidence"));
  if (!isObject(parsed.self_evaluation)) issues.push(issue("model_output_missing_self_evaluation", "self_evaluation is required", "self_evaluation"));
  return {
    status: issues.length === 0 ? "pass" : "fail",
    issues
  };
}
