# Workbench Shell

静态 PC / mobile 工作台入口。

- `desktop.html`：PC 单页工作台，固定占满浏览器视口，内部内容区允许纵向滚动。
- `mobile.html`：手机独立信息架构，不是 PC 页面缩放。
- `workbench.js`：只读取 `docs/examples/current-session-workbench-projection.json`，不解析日志或聊天记录。
- `projection-source.js`：projection 数据源抽象，默认读取本地 fixture，也支持 `?projection=/api/workbench/projection` 指向服务接口。

本 shell 只负责展示已经通过 schema gate 的 projection JSON。后续接真实服务时，接口返回也必须先通过 `tools/check-workbench-projection.mjs` 同等校验。

产品主语是项目管理，合同见 `docs/contracts/PROJECT_MANAGEMENT_WORKBENCH_CN.md`。PC / mobile 首屏必须显示项目列表、`ai-control-platform`、当前阶段、当前任务、Agent、进度和项目生命周期；运行诊断只能作为次级信息。

本地服务模式：

```bash
node tools/workbench-server.mjs 4180
```

- `GET /api/workbench/projection`
- `GET /api/workbench/projections`
- `GET /api/workbench/events`
- `POST /api/workbench/events`
- `GET /api/workbench/snapshot?id=<id>`
- `POST /api/workbench/snapshots`
- `GET /apps/workbench/desktop.html?projection=/api/workbench/projection`
- `GET /apps/workbench/mobile.html?projection=/api/workbench/projection`

Projection API 优先从 history item 的 `input_path` 读取 workflow state input 并动态生成 projection；`projection_path` 只作为没有 input snapshot 的兼容回退。History path 必须是受控根目录下的相对路径：`docs/examples/` 或配置的 snapshot root。
Snapshot API 写入 projection-ready workflow state input，并把新 snapshot 提升为 history latest。

## 运行态存储

Live Workbench 不应把运行态直接写进 Git-tracked JSON 文件。`tools/workbench-server.mjs` 支持 `--state-db <path>`，启用后会把以下运行态写入 SQLite：

- `PROJECT_STATUS` 等项目状态。
- projection history latest 和 workflow snapshot。
- operator event ledger。

`scripts/start-workbench-live.sh` 默认使用：

```bash
$HOME/codex/runtime/ai-control-platform/workbench-state/workbench-state.sqlite
```

`docs/examples/*.json` 仍作为 fixture/seed 使用；首次启动 DB 模式时会把 history 中的 workflow input seed 到 SQLite snapshot，之后 live 写入只更新 SQLite，不回写 seed JSON。
