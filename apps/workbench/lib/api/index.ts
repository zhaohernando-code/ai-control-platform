/**
 * Workbench API 客户端入口。
 *
 * - 唯一职责：把 Next.js 客户端对后端的访问统一收敛到 `apps/workbench/lib/api/`，
 *   不允许在组件内直接拼 URL 或硬编码 host，以便后续切片切换 base 与 mock。
 * - 后端 endpoint 列表必须与 `apps/workbench/FRONTEND_MIGRATION_INVENTORY.md`
 *   第 5 节保持一致；新增 endpoint 必须先更新清单，再补这里的常量。
 * - 真实业务方法在后续切片中以 React Query / fetch wrapper 接入。
 */

export interface WorkbenchEndpoint {
  method: "GET" | "POST";
  path: string;
  description: string;
}

export const WORKBENCH_API_BASE: string =
  (typeof process !== "undefined" && process.env?.WORKBENCH_API_BASE) ||
  "";

export const WORKBENCH_API_ENDPOINTS: ReadonlyArray<WorkbenchEndpoint> = [
  { method: "GET", path: "/api/workbench/projection", description: "一屏 projection" },
  { method: "GET", path: "/api/workbench/projections", description: "projection history 列表" },
  { method: "GET", path: "/api/workbench/snapshot", description: "指定 snapshot 的 workflow state" },
  { method: "POST", path: "/api/workbench/snapshots", description: "写入新 snapshot" },
  { method: "GET", path: "/api/workbench/events", description: "operator 事件账本读取" },
  { method: "POST", path: "/api/workbench/events", description: "operator 事件写入" },
  { method: "POST", path: "/api/workbench/requirements", description: "新建任务（需求录入）" },
  { method: "POST", path: "/api/workbench/plan-reviews", description: "方案审核（approve / revise）" },
  { method: "POST", path: "/api/workbench/next-action", description: "已守护的下一步动作" },
  { method: "POST", path: "/api/workbench/scheduler-dispatch", description: "调度派发" },
  { method: "POST", path: "/api/workbench/scheduler-dispatch-plan", description: "调度派发起草" },
  { method: "POST", path: "/api/workbench/scheduler-dispatch-run", description: "调度派发执行回写" },
  { method: "POST", path: "/api/workbench/scheduler-next-cycle", description: "调度下一周期入队" },
  {
    method: "POST",
    path: "/api/workbench/autonomous-scheduler-loop",
    description: "自治调度循环"
  },
  {
    method: "POST",
    path: "/api/workbench/autonomous-scheduler-loop-resume",
    description: "自治调度循环 resume"
  },
  {
    method: "POST",
    path: "/api/workbench/project-status-continuation",
    description: "项目状态续跑"
  },
  { method: "POST", path: "/api/workbench/context-pack-cycle", description: "Context Pack 周期" },
  {
    method: "POST",
    path: "/api/workbench/context-work-packages-run",
    description: "Context Pack 工作包派发"
  },
  { method: "POST", path: "/api/workbench/reviewer-shard-run", description: "reviewer shard 触发" },
  {
    method: "POST",
    path: "/api/workbench/reviewer-provider-health",
    description: "reviewer provider 健康事实写入"
  },
  {
    method: "POST",
    path: "/api/workbench/reviewer-shard-result",
    description: "reviewer shard 结果回写"
  },
  {
    method: "POST",
    path: "/api/workbench/agent-lifecycle-pool",
    description: "Agent 生命周期池写入"
  },
  { method: "GET", path: "/api/workbench/agents", description: "Agent 与 API Key 健康状态" },
  { method: "POST", path: "/api/workbench/agents/health-check", description: "全量 Agent Key 可用性测试" },
  { method: "POST", path: "/api/workbench/agent-keys", description: "新增 Agent API Key" },
  {
    method: "POST",
    path: "/api/workbench/workbench-browser-events-run",
    description: "浏览器事件回放"
  }
];

export function resolveWorkbenchUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error(`workbench api path must start with '/': ${path}`);
  }
  return `${WORKBENCH_API_BASE}${path}`;
}

export async function fetchWorkbenchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveWorkbenchUrl(path), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(`workbench api ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}
