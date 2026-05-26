"use client";

import { AntdRegistry } from "@ant-design/nextjs-registry";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";

import { workbenchTheme } from "./theme";

/**
 * AppProviders 把 antd 的 ConfigProvider、AntdRegistry（用于 Next.js
 * App Router 的 SSR 样式注入）和 AntdApp（用于 message/notification/modal
 * 的静态实例上下文）固定为唯一基础容器。
 *
 * 子组件请直接复用 antd 提供的基础与布局组件，禁止再自造 Layout/Card/
 * Button/Form 等同名组件，详见 `apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md`。
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AntdRegistry>
      <ConfigProvider locale={zhCN} theme={workbenchTheme}>
        <AntdApp>{children}</AntdApp>
      </ConfigProvider>
    </AntdRegistry>
  );
}
