"use client";

import { Alert, Card, Col, Descriptions, Row, Space, Tag, Typography } from "antd";

import { WORKBENCH_API_ENDPOINTS } from "@/lib/api";

const { Title, Paragraph, Text } = Typography;

/**
 * 总览首屏：仅作为 Next.js + antd 骨架的占位页。
 *
 * - 仅使用 antd 提供的 Card / Row / Col / Descriptions / Alert / Tag / Typography，
 *   不写裸 div 排版或自定义 CSS（详见 FRONTEND_REFACTOR_CONSTRAINTS.md）。
 * - 实际 projection 数据接入会在后续切片中通过 `lib/api` 客户端拉取
 *   `/api/workbench/projection`，并以 antd 的 Statistic/Timeline/Table 等组件渲染。
 */
export default function OverviewPage() {
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Title level={3} style={{ marginTop: 0 }}>
          欢迎使用 AI Control Platform 工作台
        </Title>
        <Paragraph>
          这是 Next.js (App Router) + Ant Design 骨架的初始页面。后续切片会按
          <Text code>apps/workbench/FRONTEND_MIGRATION_INVENTORY.md</Text>
          的迁移清单逐步把总览、项目、任务流、Agents、风险、治理、运行诊断等
          视图迁入。骨架阶段只验证：构建通过、布局组件全部走 antd、单页 app
          形态保留、与现有 workbench-server 的 API 联调路径已确认。
        </Paragraph>
        <Alert
          showIcon
          type="info"
          message="骨架阶段（实施步骤 02 / 7）"
          description="本页面用于占位 antd Layout 与 ConfigProvider 主题，后续切片将接入真实 projection 数据；当前主线展示仍由 desktop.html / mobile.html 提供回退。"
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card title="技术栈约束">
            <Descriptions column={1} size="small">
              <Descriptions.Item label="UI 框架">
                <Tag color="blue">Ant Design v5</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="应用框架">
                <Tag color="geekblue">React 18</Tag>
                <Tag color="purple">Next.js 14 · App Router</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="语言">
                <Tag color="cyan">TypeScript</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="形态">
                <Tag color="green">单页 app（路由切换不刷新）</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="基础组件来源">
                <Tag>仅来自 antd（禁止自造）</Tag>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="后端联调入口">
            <Paragraph type="secondary" style={{ marginTop: 0 }}>
              当前 Next.js dev/build 监听 4181，workbench-server 监听 4180。
              所有 API 仍由 <Text code>tools/workbench-server.mjs</Text> 暴露：
            </Paragraph>
            <Descriptions column={1} size="small">
              {WORKBENCH_API_ENDPOINTS.slice(0, 6).map((endpoint) => (
                <Descriptions.Item key={endpoint.path} label={endpoint.method}>
                  <Text code>{endpoint.path}</Text>
                </Descriptions.Item>
              ))}
            </Descriptions>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
