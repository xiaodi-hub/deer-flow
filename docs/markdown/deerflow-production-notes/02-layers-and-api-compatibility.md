# 分层与兼容 API

[总目录](./README.md) | [基础概念](./01-foundations.md) | [运行时中间件](./07-runtime-middleware-and-output-budget.md)

## 问题 1：为何拆分 `backend/app` 与 `backend/packages/harness`

### 当前实现

Harness 是可发布的 `deerflow.*` agent 框架，包含图、工具、Sandbox、MCP、Skill、模型和配置；`app.*` 是未发布的 FastAPI Gateway 与 IM 集成。依赖方向只允许 `app -> deerflow`，不允许反向导入，且 CI 由 [test_harness_boundary.py](../../../backend/tests/test_harness_boundary.py) 强制检查；模块定义见 [backend/AGENTS.md](../../../backend/AGENTS.md#harness--app-split)。

### 架构收益

1. **可移植性**：CLI、测试宿主或未来的另一种 HTTP/queue 宿主可复用 Harness，不把 FastAPI、Slack/Feishu SDK 或路由模型带进去。
2. **依赖反转**：agent 依赖抽象的 runtime context、provider、store，而不是 HTTP Request；部署层负责把认证、协议和生命周期适配进去。
3. **爆炸半径更小**：改一个渠道适配器不应重建 agent 图；改模型/Sandbox 不应影响 REST DTO。
4. **发布节奏清晰**：Harness 可语义化版本化，App 可按产品节奏演进。

### 必须守住的边界与测试

- Harness 不能导入 `app.*`，也不要读取 FastAPI `Request`、路由 schema 或环境特定全局单例；需要的值进入显式 `Runtime`/configurable context。
- App 不能绕过 Harness 内部状态机去直接操纵图状态、Sandbox 缓存或 memory 文件。应调用稳定 factory/service 接口。
- Harness 单测用 fake sandbox、fake store、fake clock；App 测试覆盖认证、DTO、依赖注入和协议适配；少量端到端测试验证二者契约。
- 对跨层 DTO 做契约测试和版本化，特别是 run event、tool result 与 error code。否则“没有 import”仍会形成隐蔽的 JSON 耦合。

常见失败模式是为“方便”让 Harness 调 App router 取用户信息，或让 App 直接修改 `ThreadState`。前者破坏可发布性，后者绕过 reducer、审计和并发语义。

## 问题 2：LangGraph 兼容层如何避免三层耦合

### 当前实现

浏览器默认访问 `/api/langgraph/*`；Nginx 将其重写为 Gateway 原生 `/api/*`，并关闭 SSE buffering/cache、延长超时。见 [nginx.local.conf](../../../docker/nginx/nginx.local.conf#L48)。Gateway 自身在生命周期装配 `RunManager`、store、checkpointer 与 `StreamBridge`，不是转发到独立 LangGraph Server，见 [deps.py](../../../backend/app/gateway/deps.py#L223)。

### 推荐分为三层适配

| 层 | 职责 | 不应做的事 |
| --- | --- | --- |
| Edge/Nginx | 路径前缀、流式传输、请求大小、转发头 | 不解析 LangGraph JSON 或做身份决策 |
| LangGraph compatibility router | SDK 协议 DTO、版本协商、错误/SSE 事件翻译 | 直接访问业务数据库或拼业务响应 |
| Gateway application service | `start/get/cancel/list run` 等内部命令、鉴权后的 owner、持久化 | 知道 URL 前缀或 SDK 的偶发字段 |

为每个协议版本定义显式 adapter：`LangGraphRunRequest -> StartRunCommand`，`RunEvent -> LangGraph SSE event`。未知字段采用“只在允许扩展区透传”的策略；对响应事件、HTTP code、取消语义和 pagination 建契约回归测试。给兼容路由加 `/api/langgraph/v1` 或 Accept-version，而不是让 Gateway 业务路由为 SDK 历史包袱持续分支。

认证、限流、trace 应在 rewrite 前后语义相同。Nginx 仅保留 path 兼容，不能让 `/api/langgraph` 绕过 `/api` 的 auth middleware。详见 [统一入口设计](./09-gateway-im-and-observability.md)。
