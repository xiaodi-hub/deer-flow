# 身份、隔离与请求级密钥

[总目录](./README.md) | [基础概念](./01-foundations.md) | [Sandbox 契约](./04-sandbox-contract-and-errors.md) | [记忆与 Artifact](./08-memory-governance-and-artifact-security.md)

## 问题 3：如何定义 thread、user 与全局缓存的隔离边界

### 建议的数据分类

| 范围 | 应放入的东西 | 不能放入的东西 |
| --- | --- | --- |
| per-run | request secret、取消 token、工具调用临时状态、trace span | 长期 memory、可复用凭据 |
| per-thread | 消息/checkpoint、todo、artifact 清单、工作目录、当前 sandbox 绑定、run 串行/ownership | 跨会话用户偏好 |
| per-user | 长期 memory、私有 custom skill、OAuth 授权引用、配额与审计记录 | 未经同意的其他用户内容 |
| 全局/服务级 | 只读 public skill、模型 tokenizer、MCP schema 缓存、连接池、特性开关快照 | 用户数据、未加 owner 的 artifact/memory |

当前 `ThreadDataMiddleware` 在用户隔离目录下建立 thread workspace/uploads/outputs，见 [中间件装配说明](../../../backend/packages/harness/deerflow/agents/middlewares/tool_error_handling_middleware.py#L184)。DeerMem 文件缓存也以 `(user_id, agent_name)` 分区，见 [storage.py](../../../backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/storage.py#L67)。

更底层地，当前运行时使用 `ContextVar` 保存当前用户，仓储默认从它解析 user scope；线程状态还包含 sandbox、artifact、upload、todo、goal、skill context 和 summary，见 [user_context.py](../../../backend/packages/harness/deerflow/runtime/user_context.py#L1) 与 [thread_state.py](../../../backend/packages/harness/deerflow/agents/thread_state.py#L34)。`ContextVar` 会随 `create_task`/`to_thread` 继承，因此后台任务必须显式捕获 owner 或使用干净 context，不能“恰好继承”前台用户。

### 强制规则

所有存取接口应接收 `OwnerScope(user_id, tenant_id?)`，数据库查询使用 `WHERE id=? AND owner_id=?`，而非先 `get(id)` 再在 Python 比对。路径使用安全规范化后的 owner 和 thread，并在解析后验证仍位于批准根目录。缓存 key 至少包含租户/用户、授权版本与内容版本；删除用户时失效相关缓存、后台队列和搜索索引。

线程不等于安全主体：同一线程的所有访问仍必须经过当前 caller 的 owner 授权；系统内部代理只能带由认证中间件验证的“代表谁”身份。

## 问题 4：如何阻断 request-scoped secret 的全链路泄漏

### 当前实现基础

Sandbox 抽象的 `execute_command(..., env=...)` 明确用于请求级 secret，且要求 POSIX key；[sandbox.py](../../../backend/packages/harness/deerflow/sandbox/sandbox.py#L57)。bash 工具在执行和返回前会对注入值掩码，相关逻辑在 [tools.py](../../../backend/packages/harness/deerflow/sandbox/tools.py#L1634)。环境策略也避免继承宿主敏感环境，见 [env_policy.py](../../../backend/packages/harness/deerflow/sandbox/env_policy.py#L1)。

Gateway 会移除客户端伪造的私有 context 键，并避免将 secret 写入可持久化/回显的 run config，见 [services.py](../../../backend/app/gateway/services.py#L475) 和 [secret_context.py](../../../backend/packages/harness/deerflow/runtime/secret_context.py#L130)。这只能处理明文、已知路径；编码、拆分、子进程转存和 provider 原始异常仍需下述纵深控制。

### 生产设计：让 secret 只存在于最短路径

1. **Prompt**：Skill metadata 只暴露需求名称/能力状态，例如“`ERP_TOKEN` 已可用”，绝不把值、URL query、Base64 或完整 header 写入 system prompt、memory、todo、模型重试上下文。
2. **解析与绑定**：Gateway 从服务器端 vault/连接记录按 `(owner, skill, run)` 签发短 TTL capability；Harness 只得到内部的 secret handle 或已审计的 `env` 字典。禁止由用户消息、MCP 返回值或客户端 `context` 提供 secret。
3. **执行**：仅把值传给单次子进程 env；不要写入 Sandbox 常驻环境、命令行参数、cwd 文件、artifact 名称。禁用 shell debug (`set -x`)，限制 `/proc/*/environ`、进程枚举和子进程继承。
4. **输出与异常**：结构化 redactor 在 logger、ToolMessage、trace attribute、HTTP error、SSE event、artifact 预览前运行。既掩码精确值，也掩码凭据格式和 URI 中的密码；异常链只保留安全 `error_code`/provider request id。
5. **存储与导出**：事件存储默认保存已净化摘要；原始调试 payload 只有受限、加密、短保留的 break-glass 存储。导出、support bundle、Langfuse/OTel exporter 再次 redaction，不能假定上游已处理。

验证应用泄漏测试：secret 出现在 stdout/stderr、异常、嵌套 JSON、URL、分块 SSE、日志 extra、trace baggage、压缩 artifact、模型复述时均应被替换；再断言下一个 run 的 `env` 不含该键。Skill 的绑定规则见 [Skill 专题](./05-skill-migration-secrets-and-tool-policy.md)。
