"use client";

import { Button, Card, Empty, Space, Typography } from "antd";
import { SolutionOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";

const { Title, Paragraph } = Typography;

/**
 * 新建任务（requirements）—— 占位页。
 *
 * 后续切片会迁移 requirement-panel 表单到 antd Form + Select + Input.TextArea，
 * 对接 /api/workbench/requirements 并保留旧入口回退。
 */
export default function RequirementsPage() {
  const router = useRouter();

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          <SolutionOutlined style={{ marginRight: 8 }} />
          新建任务
        </Title>
        <Paragraph type="secondary">
          此模块将在后续切片中迁移为 antd Form + Select + Input.TextArea，
          对接 /api/workbench/requirements 接口。当前主线展示仍由
          desktop.html / mobile.html 提供回退。
        </Paragraph>
      </Card>
      <Card>
        <Empty
          description="需求表单将在后续切片中接入"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <Button type="primary" onClick={() => router.push("/")}>
            返回总览
          </Button>
        </Empty>
      </Card>
    </Space>
  );
}
