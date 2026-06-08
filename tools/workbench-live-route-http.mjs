import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { isLocalHostname } from "./workbench-live-route-url-auth.mjs";

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function looksLikeWorkbenchHtml(body) {
  const text = String(body || "");
  return (
    /<title>\s*AI Control Platform Workbench\s*<\/title>/iu.test(text) ||
    /data-view=["']desktop["']/iu.test(text) ||
    /data-bind=["']headline["']/iu.test(text) ||
    (/Control Platform/iu.test(text) && /workbench/iu.test(text))
  );
}

function redirectLocation(response) {
  const location = response.headers.location;
  return Array.isArray(location) ? location[0] : location || "";
}

function setCookieValues(headers) {
  const value = headers["set-cookie"];
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function detectAuthRedirect(response, fromUrl) {
  const status = Number(response.status || 0);
  const location = redirectLocation(response);
  if (status === 401 || status === 403) return false;
  if (status < 300 || status >= 400 || !location) return false;
  const resolved = new URL(location, fromUrl);
  const path = `${resolved.pathname}?${resolved.searchParams.toString()}`.toLowerCase();
  const clearsSession = setCookieValues(response.headers)
    .some((cookie) => /hz_auth_session=;/iu.test(cookie) || /hz_auth_session=\s*(?:;|$)/iu.test(cookie));
  return (
    resolved.searchParams.has("next") ||
    /(?:^|\/)(login|auth|signin|oauth)(?:\/|$)/iu.test(resolved.pathname) ||
    path.includes("next=%2fprojects%2f") ||
    clearsSession
  );
}

async function requestText(url, headers, options = {}, redirects = []) {
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const response = await new Promise((resolve, reject) => {
    const requestOptions = {
      method: "GET",
      headers,
      timeout: 15000
    };
    if (parsed.protocol === "https:" && options.allowInsecureLocalTest && isLocalHostname(parsed.hostname)) {
      requestOptions.rejectUnauthorized = false;
    }
    const req = transport(parsed, requestOptions, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({
          url,
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
    req.end();
  });

  const authRedirectDetected = detectAuthRedirect(response, url);
  const location = redirectLocation(response);
  const status = Number(response.status || 0);
  if (status >= 300 && status < 400 && location && redirects.length < MAX_REDIRECTS) {
    const nextUrl = new URL(location, url).toString();
    return requestText(nextUrl, headers, options, [
      ...redirects,
      {
        from_url: url,
        to_url: nextUrl,
        http_status: status,
        auth_redirect_detected: authRedirectDetected
      }
    ]);
  }

  return {
    ...response,
    finalUrl: url,
    redirects,
    authRedirectDetected: authRedirectDetected || redirects.some((redirect) => redirect.auth_redirect_detected)
  };
}

export function safeRequest(label, url, headers, options) {
  const requestFn = options.requestText || requestText;
  return requestFn(url, headers, options).catch((error) => ({
    label,
    url,
    finalUrl: url,
    status: 0,
    headers: {},
    body: "",
    redirects: [],
    authRedirectDetected: false,
    error: error.message
  }));
}

export function parseJsonObject(body) {
  try {
    const value = JSON.parse(body);
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

export function extractReferencedAssetUrls(html, baseUrl) {
  const body = String(html || "");
  const refs = [];
  const pattern = /\b(?:src|href)=["']([^"']*(?:\/_next\/static\/|\/favicon\.svg)[^"']*)["']/giu;
  for (const match of body.matchAll(pattern)) {
    try {
      refs.push(new URL(match[1], baseUrl).toString());
    } catch {
      // Ignore malformed HTML refs; the rendered-route checks will still fail if core markers are missing.
    }
  }
  return [...new Set(refs)];
}

export function assetPathMounted(url, projectId) {
  try {
    const parsed = new URL(url);
    return (
      parsed.pathname.startsWith(`/projects/${projectId}/_next/static/`) ||
      parsed.pathname === `/projects/${projectId}/favicon.svg`
    );
  } catch {
    return false;
  }
}
