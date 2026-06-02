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

export function createWorkbenchStaticRouteHandler({ root, jsonResponse } = {}) {
  if (!root) throw new Error("workbench static route root is required");
  if (typeof jsonResponse !== "function") {
    throw new Error("workbench static route jsonResponse function is required");
  }

  const apiOnlyResponse = (res) => jsonResponse(res, 404, {
    error: "workbench pages are served by Next.js; this process only serves /api/workbench/*"
  });

  return {
    routePathname: projectMountRoutePathname,
    handleProjectMountRoot(url, res) {
      if (!isProjectMountRoot(url.pathname)) return false;
      apiOnlyResponse(res);
      return true;
    },
    handleFallback(url, res) {
      if (url.pathname === "/favicon.svg") {
        jsonResponse(res, 404, { error: "not found" });
        return true;
      }

      apiOnlyResponse(res);
      return true;
    }
  };
}
