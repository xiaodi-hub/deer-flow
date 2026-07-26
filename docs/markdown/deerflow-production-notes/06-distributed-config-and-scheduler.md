# 分布式配置、非交互执行与 Scheduler

[总目录](./README.md) | [基础概念](./01-foundations.md) | [Gateway 与可观测性](./09-gateway-im-and-observability.md)

## 问题 10：多 worker/multi-replica 下的 `extensions_config.json` 更新

当前 MCP router 以进程内 `asyncio.Lock` 包住 worker-thread 内的 read-modify-write，源码注释明确说明 cross-process writer 是另一问题，见 [mcp.py](../../../backend/app/gateway/routers/mcp.py#L21) 和 [更新入口](../../../backend/app/gateway/routers/mcp.py#L467)。这可避免一个 event loop 内丢更新，不能避免两个 pod 同时读旧 JSON 后互相覆盖。

生产优先把配置迁入数据库：`extension_config(tenant, version, document, updated_at)`，使用 `UPDATE ... WHERE version=:expected_version` 的 optimistic concurrency，冲突返回 409 和当前 ETag。每次成功写入 outbox `config.changed`；各副本订阅通知并按版本刷新本地缓存。若短期仍用文件，应使用共享存储支持的分布式锁 + 临时文件 fsync + 原子 rename + revision sidecar，但网络文件系统锁语义和缓存使其仍不如 DB 可靠。

配置读 API 返回 revision/ETag，写 API 要求 `If-Match`；审计记录 actor、旧/新 hash 和 diff 摘要。敏感字段只存 vault reference，响应使用现有掩码逻辑，绝不回传明文。

## 问题 11：哪些配置热加载，哪些必须重启

当前项目已有单一边界表 [reload_boundary.py](../../../backend/packages/harness/deerflow/config/reload_boundary.py#L1)：Gateway 每请求可解析 AppConfig，但启动期构建的 engine、checkpointer、event store、stream bridge、Sandbox provider、logging、channels、scheduler、run ownership 不会自动重建。

**适合热加载**：纯决策且一次 run 可读取快照的 feature flag、模型/温度/预算、Skill 启停、allowlist、可变速率限制、展示文案、非结构性策略阈值。每个 run 在开始取 config version 并贯穿到底，避免同一 run 中途换模型或预算。

**必须重启或受控滚动重载**：数据库 DSN/连接池、schema migration、checkpointer/store 类型、Sandbox provider/网络/挂载、TLS/认证密钥加载方式、日志 handler/exporter、IM client、scheduler 线程、run ownership heartbeat。原因不是“读不到新文件”，而是这些对象已持有 socket、线程、连接池、后台任务或安全上下文。推荐配置 API 返回 `applied_now`/`restart_required`，并让部署系统执行 drain -> restart。

## 问题 12：如何防客户端伪造 `non_interactive`

当前服务层将 `non_interactive` 标为只给内部认证调用方的键，并在非内部路径清洗它，见 [services.py](../../../backend/app/gateway/services.py#L211) 与 [services.py](../../../backend/app/gateway/services.py#L738)。内部令牌在认证中间件验证，见 [auth_middleware.py](../../../backend/app/gateway/auth_middleware.py#L93)；scheduler launch 才服务器端构造 `context={"non_interactive": True}`，见 [services.py](../../../backend/app/gateway/services.py#L829)。

继续保持“**认证来源决定能力**”：客户端 body 的该字段一律丢弃；仅 AuthMiddleware 验证服务间凭据后写入不可伪造的 `request.state.auth_source`；服务层依据该 state 构造新的 context allowlist；Harness 从 server-owned context 决定移除 `ask_clarification`。同时限制内部 token 的网络来源、轮换并记录 actor/task/run；不要让任何渠道 adapter 直接信任外部 message metadata。

## 问题 13：分布式 scheduler 如何防重复、饥饿和永久锁

当前 `ScheduledTaskService` 计算全局活动预算、按数据库租约 claim due task，并实现 overlap/启动清理，见 [service.py](../../../backend/app/scheduler/service.py#L39)。生产化应补足：

1. 用单条 DB 原子 claim：`FOR UPDATE SKIP LOCKED` 或条件 `UPDATE`，写入 `lease_owner`、`lease_epoch`、`lease_expires_at`；只认数据库时钟。
2. runner 每 `lease/3` 心跳续租；完成时以 `(task_id, lease_owner, lease_epoch)` compare-and-set 写终态。失去租约立即停止继续 dispatch。
3. 任务的副作用带 idempotency key `task_id + scheduled_for`；run/task-run 使用唯一约束。租约过期接管仍可能与旧 worker 重叠，幂等是最后防线。
4. 公平调度按 `next_run_at, priority, aging` 排序，并对单租户/单任务限额；保留 max concurrent 全局、每 tenant、每 task 三层配额，避免长任务吃光所有槽位。
5. 崩溃恢复扫描过期 lease，标记原 attempt `lost`，用指数退避、最大次数、dead-letter/告警处理失败；不能仅“清锁”而不留下执行证据。

监控 lease age、claim conflict、延迟、饥饿、重复抑制和失锁次数，详见 [可观测性专题](./09-gateway-im-and-observability.md)。
