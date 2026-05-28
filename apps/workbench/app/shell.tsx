"use client";

import {
  AppstoreOutlined,
  AuditOutlined,
  DashboardOutlined,
  ExperimentOutlined,
  ProjectOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SolutionOutlined,
  WarningOutlined
} from "@ant-design/icons";
import { Layout, Menu, Space, Spin, Typography } from "antd";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useCallback, useMemo, useTransition } from "react";

const { Sider, Content } = Layout;
const { Title } = Typography;

/**
 * WorkbenchShell：固定 antd Layout 骨架（Sider + Header + Content）。
 *
 * - 严格使用 antd 提供的 Layout/Sider/Header/Content/Menu，禁止用 div+css
 *   重新实现等价能力。
 * - 路由项与 `apps/workbench/FRONTEND_MIGRATION_INVENTORY.md` 第 2 节中
 *   的 SPA tab 一一对应，保证单页 app 形态不漂移。
 * - 工作台子页面通过 `children` 渲染，路由切换不触发整页刷新。
 */
const NAV_ITEMS = [
  { key: "overview", label: "总览", icon: <DashboardOutlined />, href: "/" },
  { key: "requirements", label: "新建任务", icon: <SolutionOutlined />, href: "/requirements" },
  { key: "projects", label: "项目", icon: <ProjectOutlined />, href: "/projects" },
  { key: "flow", label: "任务流", icon: <AppstoreOutlined />, href: "/flow" },
  { key: "agents", label: "Agents", icon: <RobotOutlined />, href: "/agents" },
  { key: "risks", label: "风险", icon: <WarningOutlined />, href: "/risks" },
  { key: "governance", label: "治理", icon: <SafetyCertificateOutlined />, href: "/governance" },
  { key: "runs", label: "运行诊断", icon: <ExperimentOutlined />, href: "/runs" }
] as const;

type NavKey = (typeof NAV_ITEMS)[number]["key"];

function selectedKeyFromPath(pathname: string | null): NavKey {
  if (!pathname || pathname === "/") return "overview";
  const segment = pathname.split("/").filter(Boolean)[0];
  const match = NAV_ITEMS.find((item) => item.key === segment);
  return (match?.key as NavKey) ?? "overview";
}

export function WorkbenchShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const selectedKey = useMemo(() => selectedKeyFromPath(pathname), [pathname]);
  const menuItems = useMemo(
    () =>
      NAV_ITEMS.map((item) => ({
        key: item.key,
        label: item.label,
        icon: item.icon
      })),
    []
  );

  // 使用 startTransition 包裹路由切换，让 antd 的状态更新（selectedKeys）
  // 与页面内容切换在同一帧内完成，避免中间态闪烁。
  const handleMenuClick = useCallback(
    ({ key }: { key: string }) => {
      const target = NAV_ITEMS.find((item) => item.key === key);
      if (target && target.href !== pathname) {
        startTransition(() => {
          router.push(target.href, { scroll: false });
        });
      }
    },
    [router, pathname, startTransition]
  );

  return (
    <Layout style={{ minHeight: "100vh" }} data-view="desktop">
      <Sider
        breakpoint="lg"
        collapsedWidth={64}
        theme="dark"
        width={220}
        style={{ position: "sticky", top: 0, height: "100vh" }}
      >
        <Space
          align="center"
          style={{ width: "100%", padding: "16px 16px 8px", color: "#ffffff" }}
        >
          <AuditOutlined style={{ fontSize: 20 }} />
          <Title level={5} style={{ color: "#ffffff", margin: 0 }}>
            AI Control Platform
          </Title>
        </Space>
        <Menu
          theme="dark"
          mode="inline"
          items={menuItems}
          selectedKeys={[selectedKey]}
          onClick={handleMenuClick}
          data-component="workbench-nav"
        />
      </Sider>
      <Layout>
        <Content style={{ padding: 24 }}>
          <Spin spinning={isPending} size="large">
            {children}
          </Spin>
        </Content>
      </Layout>
    </Layout>
  );
}
