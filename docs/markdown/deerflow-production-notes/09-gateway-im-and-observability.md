# Gateway、IM Bridge 与生产级可观测性

[总目录](./README.md) | [配置与调度](./06-distributed-config-and-scheduler.md) | [身份隔离](./03-identity-isolation-and-secrets.md)

## 问题 16：REST、LangGraph runtime 与 IM 的统一横切能力

将三条入口规范化为 `AuthenticatedEnvelope`：`principal`、`owner_scope`、`auth_source`、`request_id/trace_id`、`rate_limit_subject`、`transport metadata`。REST 和 LangGraph compatibility router 由同一 AuthMiddleware 认证，IM adapter 先验证 provider 签名/事件，再解析已绑定的内部 owner，并以内部服务凭据调用相同 Gateway command service。

当前认证中间件已经区分 session、auth-disabled 与 internal 来源，见 [auth_middleware.py](../../../backend/app/gateway/auth_middleware.py#L93)；Gateway 还会把内部 owner 映射为有效 user，见 [internal_auth.py](../../../backend/app/gateway/internal_auth.py#L74)。

统一方案应让 authz 在资源服务层执行，不依赖 URL 前缀；rate limit 至少分 `IP/anonymous`、`user`、`tenant`、`channel connection`、昂贵工具/模型 token 五类，并把拒绝写为标准错误。trace 从入站 W3C traceparent 或生成 `trace_id`，贯穿 run、工具、Sandbox、MCP 和 IM callback；向外只暴露安全 request id。

## 问题 17：Slack/Feishu 等 IM Bridge 的幂等、顺序、长任务

当前 channel manager 会以 owner header 调 Gateway，并对同一 thread 的并发 run 采用 reject；流式路径累积文本并发布更新，见 [manager.py](../../../backend/app/channels/manager.py#L1703)。这解决部分会话并发，不等于 webhook 投递可靠性。

当前 MessageBus、inbound 去重表和会话锁主要是进程内机制：去重窗口约 10 分钟且有容量上限，见 [manager.py](../../../backend/app/channels/manager.py#L70) 与 [message_bus.py](../../../backend/app/channels/message_bus.py#L134)。因此多副本或重启后仍可能重复投递，不能将现有行为视为分布式幂等保证。

建议 adapter 在收到 webhook 后：

1. 校验签名、时间窗和 replay protection；以 `(provider, connection_id, event_id/message_id)` 做唯一去重，先持久化 inbox，再快速 ACK 平台。
2. 由 worker 从 inbox 创建或恢复 `channel_message` job；使用同一 idempotency key 调 Gateway `start_run`。网络超时后可安全重试，不会生成第二个 run。
3. 将 provider conversation/thread 映射到 DeerFlow thread，并按该 key 做顺序 mailbox（一个会话串行、不同会话并行）。超出队列上限时有明确 busy/backpressure 响应。
4. 长任务将 run_id 与外部 message id 持久化；流式更新以可编辑的 progress message 节流，final 使用 outbox 投递。发送失败指数退避、去重，终态回调幂等。
5. 明确顺序语义：同一会话保证按已接受顺序开始，不承诺平台乱序消息的“时间旅行”；对迟到事件使用 provider timestamp + window 规则并审计。

## 问题 20：六层 observability 优先级

先建立统一 SLO：成功 run 比率、端到端 p50/p95/p99 延迟、排队延迟、用户可见流式首 token 时间、错误预算。所有指标带低基数 `provider/model/tool_kind/status`；高基数 `run_id/trace_id/user` 只进入日志和 trace。

项目已有良好起点：Trace middleware 生成/传播请求 trace，RunJournal 记录 run、LLM、token 和延迟事件，见 [trace_middleware.py](../../../backend/app/gateway/trace_middleware.py#L17) 与 [journal.py](../../../backend/packages/harness/deerflow/runtime/journal.py#L44)。下面的清单是把这些零散事件收敛为 metrics、traces、logs、audit 四种可运营信号。

| 层 | 首批指标与事件 |
| --- | --- |
| Agent run | `runs_started/completed/failed/cancelled`、active runs、queue/TTFT/total duration、token in/out、retry/interrupt、按 model/入口/状态；run timeline trace |
| Tool call | 调用数、duration、错误分类、重试、policy deny、输出原始/注入字节、截断/redaction；不得记录参数明文 |
| Sandbox | acquire latency、pool hit、ready failure、execute timeout/exit、CPU/内存/磁盘/网络拒绝、lease/release 泄漏、provider availability |
| MCP | connect/reconnect、schema cache hit、每 server/tool latency/error、circuit breaker 状态、OAuth refresh、协议/序列化失败、输出预算 |
| Scheduler | due lag、claim 成功/冲突、active slots、lease renewal/loss、重复抑制、task starvation、attempt outcome、DLQ/backoff |
| Persistence | DB pool 使用/等待、事务/查询延迟、锁等待/死锁、checkpoint/event append、outbox backlog、memory queue depth、缓存 hit、迁移版本 |

告警要对应可操作的症状：TTFT 和 queue 同涨看容量；sandbox timeout 分 provider 看供应商；scheduler due lag + lease loss 看 worker/DB；MCP 单 server 错误看 circuit breaker；数据库 pool 等待看连接耗尽。为 run 创建结构化 audit timeline，并把日志、trace、run event 通过 `trace_id/run_id` 关联，排障才不必靠全文搜索猜测。

回到：[总目录](./README.md)。
