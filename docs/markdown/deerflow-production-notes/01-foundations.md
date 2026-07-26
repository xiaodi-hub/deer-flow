# 基础概念：理解后续设计讨论的四个坐标

[总目录](./README.md) | [分层与 API](./02-layers-and-api-compatibility.md) | [配置与调度](./06-distributed-config-and-scheduler.md)

## 1. 控制面、数据面与信任面

- **控制面**管理“规则”：配置、Skill 元数据、MCP 连接、调度任务、授权策略。它的写操作较少，但必须有版本、审计和并发控制。
- **数据面**执行“工作”：agent run、工具调用、Sandbox、SSE 事件、artifact 读写。它应可横向扩容、可重试，并为每个请求明确资源归属。
- **信任面**决定“谁能做什么”：认证后的 principal、角色、`user_id`、内部调用凭据、secret capability。不要把客户端 JSON 中的 `user_id` 或 `context` 当成信任事实。

Gateway 同时承载控制面和数据面，因此配置和身份应在入口处归一；Harness 只接收已经整理过的运行上下文。当前 Gateway 会把受信任的身份转换为运行上下文，且专门区分内部调用键，见 [services.py](../../../backend/app/gateway/services.py#L211)。

## 2. 隔离不是一个布尔值

隔离通常至少有五层：身份（A 看不到 B）、命名空间（路径/数据库查询带 owner）、运行（并发 run 不混状态）、计算（Sandbox 进程/网络/挂载隔离）和可观测性（日志、trace、artifact 同样不串租户）。某一层做了隔离，并不能替代其他层。例如每线程独立目录不能防止 API 按裸 `thread_id` 读取另一用户的数据库记录。

## 3. 幂等、至少一次与租约

外部 webhook、队列和 scheduler 往往是**至少一次投递**：同一消息可能来两次。幂等的做法是用稳定业务键（例如 `channel + connection + provider_message_id`）持久化去重，并让“创建 run”与“记录已受理”在一个事务或 outbox 流程里完成。

**租约（lease）**是带过期时间的临时所有权：worker 用比较并交换式数据库更新抢到任务，并持续心跳续租。租约只减少重复；任务副作用仍须幂等，因为 worker 可能在执行外部调用后、写成功状态前崩溃。当前 scheduler 已使用 `lease_owner` / `lease_expires_at`，但其启动期清理注释明确假设 MVP 为单 scheduler，见 [SQL repository](../../../backend/packages/harness/deerflow/persistence/scheduled_tasks/sql.py#L126)。

## 4. 认证、授权与能力令牌

认证回答“你是谁”，授权回答“你能访问此对象吗”，能力令牌回答“此 run 在很短的窗口内可使用哪个 secret 或操作”。请求级 secret 应属于最后一种：只在本次工具子进程环境中存在，不进入模型上下文，也不能被下一次 run 继承。

当前内部调用使用独立的固定头和常量时间比较，并可携带受信任的 owner，见 [internal_auth.py](../../../backend/app/gateway/internal_auth.py#L13)。这说明 `context.non_interactive` 一类字段必须建立在认证来源之上，而不是建立在“字段看起来像内部字段”之上。

## 5. 推荐的统一关联键

每条结构化日志、指标 exemplar、审计事件和异步消息至少带：`request_id`、`trace_id`、`run_id`、`thread_id`、`owner_user_id`、`auth_source`。工具和 Sandbox 再加 `tool_call_id`、`sandbox_id`；调度再加 `task_id`、`task_run_id`、`lease_owner`。其中用户标识在高基数指标中应做受控哈希或只放 trace，避免监控系统被无限标签值拖垮。

继续阅读：[身份隔离与密钥](./03-identity-isolation-and-secrets.md)。
