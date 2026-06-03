export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

export function jsonResponse(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readBody(req, options = {}) {
  const maxBytes = Number(options.maxBytes || options.max_bytes || DEFAULT_JSON_BODY_LIMIT_BYTES);
  return new Promise((resolveBody, reject) => {
    let body = "";
    let bytes = 0;
    let rejected = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (rejected) return;
      bytes += Buffer.byteLength(chunk, "utf8");
      if (Number.isFinite(maxBytes) && maxBytes > 0 && bytes > maxBytes) {
        rejected = true;
        reject(codedError("REQUEST_BODY_TOO_LARGE", `request body exceeds ${maxBytes} bytes`));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!rejected) resolveBody(body);
    });
    req.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

export async function readJsonBody(req, options = {}) {
  const body = await readBody(req, options);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw codedError("INVALID_JSON_BODY", "invalid json");
  }
}
