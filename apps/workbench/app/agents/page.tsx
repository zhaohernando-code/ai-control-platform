"use client";

import {
  ApiOutlined,
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  DeleteOutlined,
  ExclamationCircleFilled,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SettingOutlined
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography
} from "antd";
import type { CollapseProps } from "antd";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import {
  addAgentKey,
  deleteAgentKey,
  fetchAgents,
  runAgentHealthCheck,
  runAgentKeyHealthCheck,
  runFullAgentHealthCheck,
  updateAgentRoles,
  type AgentApiKey,
  type AgentChannel,
  type AgentHealthStatus,
  type AgentRoleDefinition,
  type AgentsResponse
} from "@/lib/api/agents";

const { Title, Text } = Typography;

const STATUS_COLOR: Record<AgentHealthStatus, string> = {
  success: "#389e0d",
  warning: "#d48806",
  error: "#cf1322",
  unknown: "#8c8c8c",
  testing: "#1677ff"
};

function formatTime(value: string | null | undefined): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusIcon(status: AgentHealthStatus, loading = false) {
  if (loading) return <Spin size="small" />;
  if (status === "success") return <CheckCircleFilled style={{ color: STATUS_COLOR.success }} />;
  if (status === "warning") return <ExclamationCircleFilled style={{ color: STATUS_COLOR.warning }} />;
  if (status === "error") return <CloseCircleFilled style={{ color: STATUS_COLOR.error }} />;
  return <ClockCircleOutlined style={{ color: STATUS_COLOR.unknown }} />;
}

function statusText(status: AgentHealthStatus): string {
  return {
    success: "可用",
    warning: "部分可用",
    error: "不可用",
    unknown: "未检测",
    testing: "检测中"
  }[status];
}

function roleLabels(roles: Record<string, boolean>, definitions: AgentRoleDefinition[]): string {
  const enabled = definitions.filter((role) => roles[role.id]).map((role) => role.label);
  return enabled.length > 0 ? enabled.join("、") : "未配置";
}

export default function AgentsPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [registry, setRegistry] = useState<AgentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [testingScope, setTestingScope] = useState<string | null>(null);
  const [roleAgent, setRoleAgent] = useState<AgentChannel | null>(null);
  const [roleDraft, setRoleDraft] = useState<Record<string, boolean>>({});
  const [addKeyAgent, setAddKeyAgent] = useState<AgentChannel | null>(null);
  const [form] = Form.useForm();
  const [isPending, startTransition] = useTransition();

  const loadAgents = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAgents()
      .then((data) => setRegistry(data))
      .catch((err: Error) => setError(err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const definitions = useMemo(() => registry?.role_definitions || [], [registry]);

  const runCheck = useCallback((scope: string, action: () => Promise<unknown>) => {
    setTestingScope(scope);
    startTransition(async () => {
      try {
        await action();
        message.success("可用性测试已完成");
        loadAgents();
      } catch (err) {
        message.error(err instanceof Error ? err.message : "可用性测试失败");
      } finally {
        setTestingScope(null);
      }
    });
  }, [loadAgents, message]);

  const openRoleModal = useCallback((agent: AgentChannel) => {
    setRoleAgent(agent);
    setRoleDraft(agent.roles);
  }, []);

  const saveRoles = useCallback(() => {
    if (!roleAgent) return;
    startTransition(async () => {
      try {
        await updateAgentRoles(roleAgent.id, roleDraft);
        message.success("职能设置已保存");
        setRoleAgent(null);
        loadAgents();
      } catch (err) {
        message.error(err instanceof Error ? err.message : "职能设置保存失败");
      }
    });
  }, [loadAgents, message, roleAgent, roleDraft]);

  const openAddKeyModal = useCallback((agent: AgentChannel) => {
    setAddKeyAgent(agent);
    form.resetFields();
  }, [form]);

  const submitKey = useCallback((values: { alias: string; key: string; competitive?: boolean }) => {
    if (!addKeyAgent) return;
    startTransition(async () => {
      try {
        await addAgentKey({
          agent_id: addKeyAgent.id,
          alias: values.alias,
          key: values.key,
          competitive: values.competitive === true
        });
        message.success("API Key 已添加");
        setAddKeyAgent(null);
        form.resetFields();
        loadAgents();
      } catch (err) {
        message.error(err instanceof Error ? err.message : "API Key 添加失败");
      }
    });
  }, [addKeyAgent, form, loadAgents, message]);

  const removeKey = useCallback((key: AgentApiKey) => {
    startTransition(async () => {
      try {
        await deleteAgentKey(key.id);
        message.success("API Key 已删除");
        loadAgents();
      } catch (err) {
        message.error(err instanceof Error ? err.message : "API Key 删除失败");
      }
    });
  }, [loadAgents, message]);

  const collapseItems: CollapseProps["items"] = useMemo(() => {
    return (registry?.agents || []).map((agent) => {
      const agentTesting = testingScope === "all" || testingScope === `agent:${agent.id}`;
      return {
        key: agent.id,
        label: (
          <Space size="middle" wrap>
            {statusIcon(agent.status, agentTesting)}
            <Text strong>{agent.label}</Text>
            {agent.account_login ? (
              <Tag color={agent.status === "success" ? "success" : agent.status === "warning" ? "warning" : agent.status === "error" ? "error" : "default"}>
                账号：{statusText(agent.status)}
              </Tag>
            ) : (
              <Tag color={agent.status === "success" ? "success" : agent.status === "warning" ? "warning" : agent.status === "error" ? "error" : "default"}>
                {agent.key_counts.available}/{agent.key_counts.total}
              </Tag>
            )}
            <Text type="secondary">{roleLabels(agent.roles, definitions)}</Text>
          </Space>
        ),
        extra: (
          <Space>
            <Tooltip title="职能设置">
              <Button
                type="text"
                icon={<SettingOutlined />}
                onClick={(event) => {
                  event.stopPropagation();
                  openRoleModal(agent);
                }}
              />
            </Tooltip>
            <Tooltip title="可用性测试">
              <Button
                type="text"
                icon={<ReloadOutlined spin={agentTesting} />}
                loading={agentTesting}
                onClick={(event) => {
                  event.stopPropagation();
                  runCheck(`agent:${agent.id}`, () => runAgentHealthCheck(agent.id));
                }}
              />
            </Tooltip>
          </Space>
        ),
        children: agent.account_login ? (
          <List
            dataSource={[agent]}
            renderItem={(accountAgent) => {
              const health = accountAgent.account_health || {
                status: "unknown" as AgentHealthStatus,
                latency_ms: null,
                checked_at: null,
                error_code: null,
                error_summary: null
              };
              return (
                <List.Item
                  actions={[
                    <Tooltip title="可用性测试" key="refresh">
                      <Button
                        type="text"
                        icon={<ReloadOutlined spin={agentTesting} />}
                        loading={agentTesting}
                        onClick={() => runCheck(`agent:${agent.id}`, () => runAgentHealthCheck(agent.id))}
                      />
                    </Tooltip>
                  ]}
                >
                  <List.Item.Meta
                    avatar={statusIcon(health.status, agentTesting)}
                    title={
                      <Space wrap>
                        <Text strong>账号登录状态</Text>
                        <Tag color="purple">Codex account</Tag>
                        <Tag>{statusText(health.status)}</Tag>
                      </Space>
                    }
                    description={
                      <Space direction="vertical" size={0}>
                        <Text type="secondary">账号登录版不展示或管理 API Key，可用性测试会检查本机 CLI 与登录态。</Text>
                        <Text type="secondary">
                          {accountAgent.default_model || "默认模型"} · {formatTime(health.checked_at)}
                        </Text>
                        {health.error_summary && (
                          <Text type="danger">{health.error_summary}</Text>
                        )}
                      </Space>
                    }
                  />
                </List.Item>
              );
            }}
          />
        ) : (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <List
              dataSource={agent.keys}
              locale={{ emptyText: <Empty description="暂无 API Key" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              renderItem={(key) => {
                const keyTesting = testingScope === "all" || testingScope === `agent:${agent.id}` || testingScope === `key:${key.id}`;
                return (
                  <List.Item
                    actions={[
                      <Popconfirm
                        key="delete"
                        title="确认删除这个 API Key？"
                        okText="删除"
                        cancelText="取消"
                        onConfirm={() => removeKey(key)}
                      >
                        <Button type="text" danger icon={<DeleteOutlined />} />
                      </Popconfirm>,
                      <Tooltip title="可用性测试" key="refresh">
                        <Button
                          type="text"
                          icon={<ReloadOutlined spin={keyTesting} />}
                          loading={keyTesting}
                          onClick={() => runCheck(`key:${key.id}`, () => runAgentKeyHealthCheck(key.id))}
                        />
                      </Tooltip>
                    ]}
                  >
                    <List.Item.Meta
                      avatar={statusIcon(key.health.status, keyTesting)}
                      title={
                        <Space wrap>
                          <Text strong>{key.alias}</Text>
                          <Tag color={key.competitive ? "blue" : "gold"}>
                            {key.competitive ? "竞争 key" : "非竞争 key"}
                          </Tag>
                          <Tag>{statusText(key.health.status)}</Tag>
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={0}>
                          <Text code>{key.masked_secret || "未显示"}</Text>
                          <Text type="secondary">
                            {key.provider || key.auth_type || "provider"} · {key.default_model || "默认模型"} · {formatTime(key.health.checked_at)}
                          </Text>
                          {key.health.error_summary && (
                            <Text type="danger">{key.health.error_summary}</Text>
                          )}
                        </Space>
                      }
                    />
                  </List.Item>
                );
              }}
            />
            <Button icon={<PlusOutlined />} onClick={() => openAddKeyModal(agent)}>
              添加 Key
            </Button>
          </Space>
        )
      };
    });
  }, [definitions, openAddKeyModal, openRoleModal, registry, removeKey, runCheck, testingScope]);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Space align="center" style={{ width: "100%", justifyContent: "space-between" }} wrap>
            <Space>
              <RobotOutlined style={{ fontSize: 20 }} />
              <Title level={4} style={{ margin: 0 }}>Agents</Title>
            </Space>
            <Space wrap>
              <Button onClick={() => router.push("/flow")}>查看任务流</Button>
              <Button
                type="primary"
                icon={<ReloadOutlined />}
                loading={testingScope === "all"}
                onClick={() => runCheck("all", runFullAgentHealthCheck)}
              >
                全量可用性测试
              </Button>
              <Text type="secondary">最后刷新时间：{formatTime(registry?.last_refresh_at)}</Text>
            </Space>
          </Space>
          <Text type="secondary">
            API Key 健康、竞争锁策略和 Agent 职能配置会参与后续任务流调度。
          </Text>
        </Space>
      </Card>
      {error && (
        <Alert
          showIcon
          type="error"
          message="Agents 加载失败"
          description={error.message}
          action={<Button size="small" danger onClick={loadAgents}>重试</Button>}
        />
      )}
      <Spin spinning={loading && !registry}>
        <Collapse items={collapseItems} bordered={false} />
      </Spin>

      <Modal
        title={roleAgent ? `${roleAgent.label} 职能设置` : "职能设置"}
        open={Boolean(roleAgent)}
        onCancel={() => setRoleAgent(null)}
        onOk={saveRoles}
        confirmLoading={isPending}
        destroyOnClose
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          {definitions.map((role) => (
            <Space key={role.id} style={{ width: "100%", justifyContent: "space-between" }}>
              <Text>{role.label}</Text>
              <Switch
                checked={roleDraft[role.id] === true}
                onChange={(checked) => setRoleDraft((current) => ({ ...current, [role.id]: checked }))}
              />
            </Space>
          ))}
        </Space>
      </Modal>

      <Modal
        title={addKeyAgent ? `添加 ${addKeyAgent.label} API Key` : "添加 API Key"}
        open={Boolean(addKeyAgent)}
        onCancel={() => setAddKeyAgent(null)}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={submitKey} initialValues={{ competitive: false }}>
          <Form.Item label="别名" name="alias" rules={[{ required: true, message: "请输入别名" }]}>
            <Input prefix={<ApiOutlined />} placeholder="例如：主力 key" maxLength={60} />
          </Form.Item>
          <Form.Item label="Key" name="key" rules={[{ required: true, message: "请输入 API Key" }]}>
            <Input.Password placeholder="只会保存到本机 runtime SQLite" />
          </Form.Item>
          <Form.Item label="是否为竞争 key" name="competitive" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={isPending}>
              添加
            </Button>
            <Button onClick={() => setAddKeyAgent(null)}>取消</Button>
          </Space>
        </Form>
      </Modal>
    </Space>
  );
}
