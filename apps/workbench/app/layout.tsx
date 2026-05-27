import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

import { AppProviders } from "./providers";
import { WorkbenchShell } from "./shell";

const workbenchMountPrefix = process.env.WORKBENCH_MOUNT_PREFIX || "";

/**
 * Root layout：单页应用形态的唯一壳。
 *
 * - 严禁在这里写裸 div + 自定义 CSS 去模拟 antd Layout/Sider/Header；
 *   壳由 `<WorkbenchShell>` 用 antd 的 Layout 系列组件实现。
 * - 路由切换通过 Next.js App Router 的 `children` 投影完成，不触发整页刷新，
 *   维持当前“单页 app”形态（详见 FRONTEND_REFACTOR_CONSTRAINTS.md）。
 */
export const metadata: Metadata = {
  title: "AI Control Platform Workbench",
  description:
    "AI Control Platform 中台工作台：项目管理、任务流、Agents、风险、治理、运行诊断的一屏入口。",
  icons: {
    icon: `${workbenchMountPrefix}/favicon.svg`
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#001529"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0 }}>
        <AppProviders>
          <WorkbenchShell>{children}</WorkbenchShell>
        </AppProviders>
      </body>
    </html>
  );
}
