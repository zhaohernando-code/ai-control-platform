import { readFileSync } from "node:fs";
import { extname, normalize, resolve } from "node:path";

import { mimeTypeFor } from "./workbench-mime-types.mjs";

function safeStaticPath(root, pathname) {
  const normalized = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(root, normalized.replace(/^[/\\]/, ""));

  if (!filePath.startsWith(root)) {
    return null;
  }

  return filePath;
}

function sendStaticFile(res, filePath, options = {}) {
  const content = readFileSync(filePath);
  const transformed = typeof options.transform === "function" ? options.transform(content) : content;
  res.writeHead(200, {
    "content-type": options.content_type || mimeTypeFor(extname(filePath)),
    "cache-control": options.cache_control || "no-store"
  });
  res.end(transformed);
}

function isProjectMountRoot(pathname) {
  return /^\/projects\/ai-control-platform\/?$/.test(String(pathname || ""));
}

export function projectMountRoutePathname(pathname) {
  const mountPrefix = "/projects/ai-control-platform";
  const routePathname = String(pathname || "");
  if (routePathname === mountPrefix) return "/";
  if (routePathname.startsWith(`${mountPrefix}/`)) {
    return routePathname.slice(mountPrefix.length) || "/";
  }
  return routePathname;
}

export function createWorkbenchStaticRouteHandler({
  root,
  serveLegacyStatic = false,
  jsonResponse
} = {}) {
  if (!root) throw new Error("workbench static route root is required");
  if (typeof jsonResponse !== "function") {
    throw new Error("workbench static route jsonResponse function is required");
  }

  return {
    routePathname: projectMountRoutePathname,
    handleProjectMountRoot(url, res) {
      if (!isProjectMountRoot(url.pathname)) return false;
      if (!serveLegacyStatic) {
        jsonResponse(res, 404, {
          error: "workbench pages are served by Next.js; this process only serves /api/workbench/*"
        });
        return true;
      }
      const basePath = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
      res.writeHead(302, {
        location: `${basePath}apps/workbench/desktop.html${url.search}`,
        "cache-control": "no-store"
      });
      res.end();
      return true;
    },
    handleFallback(url, res) {
      if (url.pathname === "/favicon.svg") {
        if (!serveLegacyStatic) {
          jsonResponse(res, 404, { error: "not found" });
          return true;
        }
        const faviconPath = safeStaticPath(root, "/apps/workbench/favicon.svg");
        if (faviconPath) {
          sendStaticFile(res, faviconPath);
          return true;
        }
      }

      if (!serveLegacyStatic) {
        jsonResponse(res, 404, {
          error: "workbench pages are served by Next.js; this process only serves /api/workbench/*"
        });
        return true;
      }

      const resolvedPath = safeStaticPath(
        root,
        url.pathname === "/" ? "/apps/workbench/desktop.html" : url.pathname
      );
      if (!resolvedPath) {
        jsonResponse(res, 404, { error: "not found" });
        return true;
      }

      sendStaticFile(res, resolvedPath);
      return true;
    }
  };
}
