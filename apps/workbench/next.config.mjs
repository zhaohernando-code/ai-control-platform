// Next.js configuration for the AI Control Platform workbench skeleton.
//
// The legacy static shell is mounted by `tools/workbench-server.mjs` under
// `/projects/ai-control-platform/apps/workbench/...`. The Next.js skeleton is
// authored under the same project to make the eventual cut-over a path change
// rather than a host change. During the migration, the Next.js dev/build runs
// on its own port (default 4181) and proxies workbench-server APIs from
// `http://127.0.0.1:4180`. See `apps/workbench/README.md` for the local
// interop matrix.

const workbenchMountPrefix = process.env.WORKBENCH_MOUNT_PREFIX ||
  (process.env.NODE_ENV === "production" ? "/projects/ai-control-platform" : "");
const workbenchApiBase = process.env.WORKBENCH_API_BASE ||
  (workbenchMountPrefix || "http://127.0.0.1:4180");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  assetPrefix: workbenchMountPrefix || undefined,
  // Keep production builds output-self-contained so the eventual
  // hand-off to the public mount (`/projects/ai-control-platform/...`)
  // stays declarative; today this is verified via `next build` only.
  output: "standalone",
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
  }
};

export default nextConfig;
