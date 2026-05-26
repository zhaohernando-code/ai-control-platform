import type { ThemeConfig } from "antd";

/**
 * Workbench theme tokens.
 *
 * 这里只承载平台中性主题与运营语义颜色，避免在组件层散落硬编码。
 * 设计 token 直接对接 antd v5 的 ThemeConfig，禁止再造一套自定义变量。
 */
export const workbenchTheme: ThemeConfig = {
  cssVar: true,
  hashed: false,
  token: {
    colorPrimary: "#1677ff",
    colorInfo: "#1677ff",
    colorSuccess: "#16a34a",
    colorWarning: "#f59e0b",
    colorError: "#dc2626",
    borderRadius: 8,
    fontSize: 14
  },
  components: {
    Layout: {
      headerBg: "#001529",
      headerColor: "#ffffff",
      siderBg: "#001529",
      bodyBg: "#f5f7fb",
      headerHeight: 56
    },
    Menu: {
      darkItemBg: "#001529",
      darkItemSelectedBg: "#1677ff"
    },
    Card: {
      borderRadiusLG: 12
    },
    Typography: {
      titleMarginBottom: "0.4em"
    }
  }
};

export type WorkbenchTheme = typeof workbenchTheme;
