# Workbench Shell

静态 PC / mobile 工作台入口。

- `desktop.html`：PC 单页工作台，固定占满浏览器视口，内部内容区允许纵向滚动。
- `mobile.html`：手机独立信息架构，不是 PC 页面缩放。
- `workbench.js`：只读取 `docs/examples/current-session-workbench-projection.json`，不解析日志或聊天记录。
- `projection-source.js`：projection 数据源抽象，默认读取本地 fixture，也支持 `?projection=/api/workbench/projection` 指向服务接口。

本 shell 只负责展示已经通过 schema gate 的 projection JSON。后续接真实服务时，接口返回也必须先通过 `tools/check-workbench-projection.mjs` 同等校验。

本地服务模式：

```bash
node tools/workbench-server.mjs 4180
```

- `GET /api/workbench/projection`
- `GET /api/workbench/projections`
- `GET /apps/workbench/desktop.html?projection=/api/workbench/projection`
- `GET /apps/workbench/mobile.html?projection=/api/workbench/projection`
