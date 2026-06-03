function parseJsonString(text, state) {
  const start = state.index;
  state.index += 1;
  let escaped = false;
  while (state.index < text.length) {
    const char = text[state.index];
    state.index += 1;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      return JSON.parse(text.slice(start, state.index));
    }
  }
  throw new SyntaxError("Unterminated JSON string");
}

function skipWhitespace(text, state) {
  while (/\s/.test(text[state.index] || "")) state.index += 1;
}

function parseLiteral(text, state, literal) {
  if (text.slice(state.index, state.index + literal.length) !== literal) {
    throw new SyntaxError(`Expected ${literal}`);
  }
  state.index += literal.length;
}

function parseNumber(text, state) {
  const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(state.index));
  if (!match) throw new SyntaxError("Expected JSON number");
  state.index += match[0].length;
}

function parseArray(text, state, path, duplicates) {
  state.index += 1;
  skipWhitespace(text, state);
  if (text[state.index] === "]") {
    state.index += 1;
    return;
  }
  let itemIndex = 0;
  while (state.index < text.length) {
    parseValue(text, state, `${path}[${itemIndex}]`, duplicates);
    skipWhitespace(text, state);
    if (text[state.index] === "]") {
      state.index += 1;
      return;
    }
    if (text[state.index] !== ",") throw new SyntaxError("Expected comma in JSON array");
    state.index += 1;
    skipWhitespace(text, state);
    itemIndex += 1;
  }
  throw new SyntaxError("Unterminated JSON array");
}

function parseObject(text, state, path, duplicates) {
  state.index += 1;
  const keys = new Set();
  skipWhitespace(text, state);
  if (text[state.index] === "}") {
    state.index += 1;
    return;
  }
  while (state.index < text.length) {
    if (text[state.index] !== "\"") throw new SyntaxError("Expected JSON object key");
    const key = parseJsonString(text, state);
    const keyPath = path ? `${path}.${key}` : key;
    if (keys.has(key)) {
      duplicates.push({
        code: "duplicate_json_key",
        path: keyPath,
        key
      });
    }
    keys.add(key);
    skipWhitespace(text, state);
    if (text[state.index] !== ":") throw new SyntaxError("Expected colon after JSON key");
    state.index += 1;
    parseValue(text, state, keyPath, duplicates);
    skipWhitespace(text, state);
    if (text[state.index] === "}") {
      state.index += 1;
      return;
    }
    if (text[state.index] !== ",") throw new SyntaxError("Expected comma in JSON object");
    state.index += 1;
    skipWhitespace(text, state);
  }
  throw new SyntaxError("Unterminated JSON object");
}

function parseValue(text, state, path, duplicates) {
  skipWhitespace(text, state);
  const char = text[state.index];
  if (char === "{") return parseObject(text, state, path, duplicates);
  if (char === "[") return parseArray(text, state, path, duplicates);
  if (char === "\"") return parseJsonString(text, state);
  if (char === "t") return parseLiteral(text, state, "true");
  if (char === "f") return parseLiteral(text, state, "false");
  if (char === "n") return parseLiteral(text, state, "null");
  return parseNumber(text, state);
}

export function findDuplicateJsonKeys(text) {
  const duplicates = [];
  const state = { index: 0 };
  parseValue(text, state, "", duplicates);
  skipWhitespace(text, state);
  if (state.index !== text.length) throw new SyntaxError("Unexpected trailing JSON content");
  return duplicates;
}
