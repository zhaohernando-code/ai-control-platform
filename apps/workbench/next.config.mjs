// Next.js configuration for the AI Control Platform workbench.
//
// The public workbench entry is served by the Next.js App Router runtime.
// `tools/workbench-server.mjs` remains the API backend only; page routes,
// dynamic App Router routes, and Next assets are handled by Next itself.

const workbenchMountPrefix = process.env.WORKBENCH_MOUNT_PREFIX ||
  (process.env.NODE_ENV === "production" ? "/projects/ai-control-platform" : "");
const workbenchApiBase = process.env.WORKBENCH_API_BASE ||
  (workbenchMountPrefix || "");
const workbenchApiProxyTarget = process.env.WORKBENCH_API_PROXY_TARGET ||
  "http://127.0.0.1:4182";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  basePath: workbenchMountPrefix || undefined,
  assetPrefix: workbenchMountPrefix || undefined,
  // The new app intentionally lives under `apps/workbench/app/`.
  // During the slice rollout, `pageExtensions` is left at the
  // default so we can mix `.tsx` pages without surprise.
  experimental: {
    typedRoutes: true
  },
  // antd v5 在 Next.js App Router 下需要这些包参与 transpile，避免
  // server components 客户端清单解析时丢失 barrel optimized 子模块。
  // 参考 antd 官方与 @ant-design/nextjs-registry 的集成指引。
  transpilePackages: [
    "antd",
    "@ant-design/icons",
    "@ant-design/nextjs-registry",
    "rc-util",
    "rc-pagination",
    "rc-picker",
    "rc-notification",
    "rc-tooltip",
    "rc-tree",
    "rc-table"
  ],
  // API base for client-side calls. In dev mode the new shell talks to
  // the existing `tools/workbench-server.mjs` over HTTP on 127.0.0.1:4180;
  // the value can be overridden via `WORKBENCH_API_BASE` to point at the
  // mounted edge route once the cut-over slice lands.
  env: {
    WORKBENCH_API_BASE: workbenchApiBase,
    WORKBENCH_MOUNT_PREFIX: workbenchMountPrefix
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: `${workbenchMountPrefix || ""}/api/workbench/:path*`,
          destination: `${workbenchApiProxyTarget}/api/workbench/:path*`,
          basePath: false
        },
        {
          source: "/api/workbench/:path*",
          destination: `${workbenchApiProxyTarget}/api/workbench/:path*`
        }
      ]
    };
  }
};

export default nextConfig;
