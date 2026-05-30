// Static file MIME-type table for the workbench HTTP server, extracted from
// workbench-server.mjs (P2-8 god-file split #5). Pure data + a small lookup helper; no
// server state. Kept separate so the server entry doesn't carry a 15-entry literal inline.

export const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

// Resolve the content-type for a file extension (with leading dot), defaulting to a binary
// stream so an unknown type is never served as text.
export function mimeTypeFor(ext = "") {
  return MIME_TYPES[String(ext).toLowerCase()] || "application/octet-stream";
}
