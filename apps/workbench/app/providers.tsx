"use client";

import { createCache, extractStyle, StyleProvider } from "@ant-design/cssinjs";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useServerInsertedHTML } from "next/navigation";
import { type ReactNode } from "react";

import { workbenchTheme } from "./theme";

/**
 * 全局稳定的 antd 样式缓存 —— 在模块加载时创建一次，跨路由切换复用。
 *
 * AntdRegistry 内部用 useState 创建缓存，虽然跨 re-render 稳定，
 * 但每次根 layout 因路由变化 re-render 时仍会走一遍 StyleProvider 渲染路径，
 * 导致 cssinjs 内部的 token cache miss → 重新计算 CSS 变量 → 闪烁。
 *
 * 直接用 createCache + StyleProvider + useServerInsertedHTML 替代 AntdRegistry，
 * 并将 cache 提升到模块顶层，彻底避免因 re-render 引起的样式抖动。
 */
const globalCache = createCache();

/**
 * AppProviders 把 antd 的 ConfigProvider、StyleProvider（用于 Next.js
 * App Router 的 SSR 样式注入）和 AntdApp（用于 message/notification/modal
 * 的静态实例上下文）固定为唯一基础容器。
 *
 * 子组件请直接复用 antd 提供的基础与布局组件，禁止再自造 Layout/Card/
 * Button/Form 等同名组件，详见 `apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md`。
 */
export function AppProviders({ children }: { children: ReactNode }) {
  // SSR 时提取已收集的 antd 样式并注入到 <head> 中；
  // useServerInsertedHTML 只在服务端执行，客户端不会重复注入。
  useServerInsertedHTML(() => {
    const styleText = extractStyle(globalCache, { plain: true, once: true });
    if (!styleText || styleText.includes('.data-ant-cssinjs-cache-path{content:"";}')) {
      return null;
    }
    return (
      <style
        id="antd-cssinjs"
        data-rc-order="prepend"
        data-rc-priority="-1000"
        dangerouslySetInnerHTML={{ __html: styleText }}
      />
    );
  });

  return (
    <StyleProvider cache={globalCache}>
      <ConfigProvider locale={zhCN} theme={workbenchTheme}>
        <AntdApp>{children}</AntdApp>
      </ConfigProvider>
    </StyleProvider>
  );
}
