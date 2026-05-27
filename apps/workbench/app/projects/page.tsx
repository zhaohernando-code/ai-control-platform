"use client";

import { Button, Card, Empty, Space, Typography } from "antd";
import { ProjectOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";

const { Title, Paragraph } = Typography;

/**
 * 项目列表（projects）—— 占位页。
 *
 * 后续切片会迁移到 antd Table / List + Tag + Progress，
 * 对接 /api/workbench/projection 中的 project_rows 数据。
 */
export default function ProjectsPage() {
  const router = useRouter();

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Title level={4} style={{ marginTop: 0 }}>
          <ProjectOutlined style={{ marginRight: 8 }} />
          项目列表
        </Title>
        <Paragraph type="secondary">
          此模块将在后续切片中迁移为 antd Table + Tag + Progress，
          展示项目阶段、当前任务、Agent、进度和更新时间。
        </Paragraph>
      </Card>
      <Card>
        <Empty
          description="项目列表将在后续切片中接入"
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
