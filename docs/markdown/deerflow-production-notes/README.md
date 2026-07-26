# DeerFlow 生产架构与安全笔记

> 本组笔记依据当前仓库源码（2026-07-21）整理。每个结论都会区分“**当前实现**”与“**生产建议**”：前者可由链接源码直接验证，后者是面向多副本、合规和故障恢复的演进方案，不应误读为项目已经实现。

## 阅读地图

| 文件 | 覆盖问题 | 核心主题 |
| --- | --- | --- |
| [01-基础概念](./01-foundations.md) | 基础补充 | 控制面/数据面、租约、幂等、信任边界 |
| [02-分层与兼容 API](./02-layers-and-api-compatibility.md) | 1、2 | Harness/App split、LangGraph 兼容层 |
| [03-身份隔离与密钥](./03-identity-isolation-and-secrets.md) | 3、4 | per-thread/per-user、请求级 secret 防泄漏 |
| [04-Sandbox 契约](./04-sandbox-contract-and-errors.md) | 5、6 | 跨 provider 错误模型、环境变量安全 |
| [05-Skill 治理](./05-skill-migration-secrets-and-tool-policy.md) | 7、8、9 | custom 迁移、secret 资格、工具授权 |
| [06-配置与调度](./06-distributed-config-and-scheduler.md) | 10、11、12、13 | 分布式 RMW、热加载、非交互与租约 |
| [07-运行时中间件与预算](./07-runtime-middleware-and-output-budget.md) | 14、18 | 中间件顺序、工具输出预算 |
| [08-记忆与 Artifact](./08-memory-governance-and-artifact-security.md) | 15、19 | 长期记忆治理、下载和渲染安全 |
| [09-Gateway、IM 与可观测性](./09-gateway-im-and-observability.md) | 16、17、20 | 统一横切能力、IM 可靠投递、指标 |

## 快速定位源码

- [Harness/App 导入防火墙测试](../../../backend/tests/test_harness_boundary.py) 与 [后端模块指南](../../../backend/AGENTS.md#harness--app-split)
- [Gateway 运行时装配](../../../backend/app/gateway/deps.py#L223)、[服务层运行上下文](../../../backend/app/gateway/services.py#L211)
- [Nginx LangGraph 路由](../../../docker/nginx/nginx.local.conf#L48)
- [中间件链装配](../../../backend/packages/harness/deerflow/agents/middlewares/tool_error_handling_middleware.py#L155)
- [Sandbox 抽象](../../../backend/packages/harness/deerflow/sandbox/sandbox.py#L44)、[scheduler 服务](../../../backend/app/scheduler/service.py#L17)

## 使用约定

文中“资源所有者”是经认证解析后的 `user_id`，不是客户端任意提交的字段；“线程”是 `thread_id` 对应的一次会话状态边界；“run”是一次具体执行尝试。生产系统应把这三者及 `trace_id` 贯穿数据库、日志、事件和审计记录。

下一篇：[基础概念](./01-foundations.md)。
