# DeerFlow 后端资深面试题源码导读

这份笔记对应“除了前端的 20 个资深问题”。每题都先给源码入口，再解释面试官实际想考什么，以及你应该怎么组织答案。

## 1. Harness / App Split

**问题**：DeerFlow 把 `backend/app` Gateway 和 `backend/packages/harness` agent harness 分开有什么架构收益？这种 split 会带来哪些依赖边界和测试边界问题？

**对应源码**：

- `backend/AGENTS.md:168`：说明 Harness / App 分层。
- `backend/AGENTS.md:175`：明确 `app` 可以 import `deerflow`，反过来禁止。
- `backend/tests/test_harness_boundary.py`：用测试固定依赖边界。

**解释**：

`packages/harness/deerflow` 是可发布的 agent 框架层，包含 agent、tools、sandbox、MCP、skills、config、runtime 等通用能力。`app` 是具体 Gateway 应用层，包含 FastAPI router、IM channel、认证和 HTTP 生命周期。这样做的收益是 harness 可以被 CLI、TUI、嵌入式 client、Gateway 复用，而不被 FastAPI 或具体部署方式绑死。

资深答案要说到依赖方向：`app -> deerflow` 合法，`deerflow -> app` 非法。否则框架层会偷用应用层能力，最终导致单元测试难、嵌入式运行难、包发布困难。这个项目用边界测试防止架构腐化。

## 2. `/api/langgraph/*` 到 Gateway 路由兼容

**问题**：Nginx 将 `/api/langgraph/*` 重写到 Gateway 原生 `/api/*`，你会如何设计这层兼容，以避免 LangGraph 协议、Gateway REST API 和内部路由耦合过深？

**对应源码**：

- `backend/AGENTS.md:15`：说明 Gateway 内嵌 LangGraph-compatible runtime。
- `backend/AGENTS.md:16`：`/api/langgraph/*` 由 Nginx 暴露并重写到 Gateway native routers。
- `backend/app/gateway/services.py:733`：`start_run` 将 LangGraph platform 格式转换为内部 graph input 和 run config。
- `backend/packages/harness/deerflow/runtime/runs/worker.py:242`：`run_agent` 是真正执行 agent 的后台 worker。

**解释**：

这里不是单独起一个 LangGraph Server，而是 Gateway 自己实现一层兼容协议。HTTP 层接收 thread/run/stream 请求，转换成内部 `RunRecord`、`RunManager`、`StreamBridge` 和 LangGraph agent invocation。资深回答要强调“协议适配层”和“执行核心”分离：外部 URL 怎么长不应该污染 `make_lead_agent` 或 middleware 设计。

如果设计不好，Gateway router 会到处散落 LangGraph 协议细节；未来换 streaming bridge、增加 TUI/embedded client 或支持新的 LangGraph protocol 都会很痛。

## 3. Per-thread / Per-user / Global 隔离边界

**问题**：这个项目有线程级隔离、用户上下文和 sandbox。你会如何定义“隔离”的边界？哪些数据必须 per-thread，哪些可以 per-user，哪些可以全局缓存？

**对应源码**：

- `backend/packages/harness/deerflow/agents/middlewares/thread_data_middleware.py:24`：`ThreadDataMiddleware` 创建每个 thread 的 workspace/uploads/outputs 路径。
- `backend/packages/harness/deerflow/agents/middlewares/thread_data_middleware.py:52`：路径计算接受 `thread_id` 和 `user_id`。
- `backend/packages/harness/deerflow/config/paths.py:40`：`make_safe_user_id` 将外部身份归一化成安全 bucket 名。
- `backend/app/gateway/routers/memory.py:17`：memory router 解析当前请求对应的 memory owner。

**解释**：

DeerFlow 的 workspace、uploads、outputs 是 per-thread，同时落在 per-user bucket 下，避免不同用户同名 thread 或外部 IM 用户 id 冲突。memory 更接近 per-user，因为跨线程保留偏好和事实。MCP server 配置、public skill enable 状态、模型配置更偏全局，但 custom skill 和 memory 必须考虑用户隔离。

资深答案要能画出三层：thread 是运行现场，user 是长期身份和私有资源，全局是共享配置和公共能力。最容易错的是把外部平台 id 直接当路径用，所以项目有 `make_safe_user_id`。

## 4. Request-scoped secrets 的泄露防护

**问题**：`Sandbox.execute_command(command, env, timeout)` 支持 request-scoped secrets。你会如何防止 secret 泄露到 prompt、日志、tool output、trace、artifact 和异常堆栈里？

**对应源码**：

- `backend/packages/harness/deerflow/sandbox/sandbox.py:57`：`execute_command` 接收 `env`。
- `backend/packages/harness/deerflow/sandbox/sandbox.py:67`：注释说明 env 用于短期用户 token，不放入 prompt、tool arguments 或 command string。
- `backend/app/gateway/services.py:225`：`_CONTEXT_RUNTIME_ONLY_KEYS` 只进入 runtime context，不进 persisted configurable。
- `backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py:377`：secret 只来自 `context.secrets`，不来自 host env。
- `backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py:381`：secret values 不记录日志，audit 只记名字。

**解释**：

核心思想是 out-of-band 传递。secret 不应该出现在模型 prompt、工具参数、命令字符串或 checkpoint 里，而是在 runtime context 中临时绑定，最后作为 sandbox 子进程 env 注入。`services.py` 还明确把 `github_token` 等 runtime-only key 留在 `config['context']`，避免进入 `configurable`，因为 configurable 会被 checkpoint 持久化。

资深回答还要补充：日志脱敏、trace 脱敏、artifact 不落 secret、异常不要拼接 secret value、tool output 预算和 redaction 都应该成为防线。

## 5. 多 sandbox provider 的统一错误模型

**问题**：sandbox 抽象同时有 Local、AIO、E2B、Boxlite 等实现。你会如何设计统一错误模型，让上层 agent 不关心具体 provider，同时又能保留可诊断性？

**对应源码**：

- `backend/packages/harness/deerflow/sandbox/sandbox.py:44`：`Sandbox` 抽象基类。
- `backend/packages/harness/deerflow/sandbox/sandbox.py:57`：命令执行接口。
- `backend/packages/harness/deerflow/sandbox/sandbox.py:106`：`download_file` 统一声明 `PermissionError`、`OSError`。
- `backend/README.md` Sandbox System：列出 LocalSandboxProvider 和 AioSandboxProvider 等实现。

**解释**：

抽象层规定了上层工具能依赖的接口：执行命令、读写文件、list、glob、grep、download。比如 path traversal 应该统一是 `PermissionError`，文件不存在统一是 `OSError` 或明确 HTTP 层映射，而不是 Docker SDK、E2B SDK、K8s client 的原始异常一路冒泡到 agent。

资深答案要说“两层错误”：对 agent/user 暴露稳定、可理解的错误；对日志/trace 保留 provider、container id、backend response、retryability 等诊断字段。

## 6. env key POSIX 校验的安全意义

**问题**：`env` key 在抽象层做 POSIX 环境变量名校验。这个设计解决了什么问题？如果未来某个 sandbox 实现通过 shell 拼接 env，会有哪些安全风险？

**对应源码**：

- `backend/packages/harness/deerflow/sandbox/sandbox.py:6`：说明 POSIX env-var name rule。
- `backend/packages/harness/deerflow/sandbox/sandbox.py:17`：`_validate_extra_env`。
- `backend/packages/harness/deerflow/sandbox/sandbox.py:20`：说明当前实现没有 shell splice，但抽象层做 defense-in-depth。
- `backend/packages/harness/deerflow/sandbox/sandbox.py:40`：非法 env key 直接 `ValueError`。

**解释**：

env value 通常会被 quote，但 env key 如果未来被拼到 shell 前缀里，例如 `KEY=value command`，恶意 key 可能包含 `;`、换行、命令替换等字符，变成命令注入。这个项目在抽象层提前规定 key 只能是 `[A-Za-z_][A-Za-z0-9_]*`，让所有 provider 继承同一契约。

资深答案要点：这是面向未来实现的防御，不是因为当前 provider 已经有漏洞。抽象层约束比每个实现各自记得校验更可靠。

## 7. public/custom/legacy skill 迁移

**问题**：技能系统区分 `public/custom/legacy`，并且 legacy 只读。你会如何设计从旧版全局 custom skills 到用户隔离 custom skills 的迁移方案？

**对应源码**：

- `backend/packages/harness/deerflow/skills/types.py:10`：`SkillCategory`。
- `backend/packages/harness/deerflow/skills/types.py:13`：`PUBLIC` 是内置只读。
- `backend/packages/harness/deerflow/skills/types.py:14`：`CUSTOM` 是用户作者可编辑。
- `backend/packages/harness/deerflow/skills/types.py:15`：`LEGACY` 是迁移前全局 custom，展示为只读。
- `backend/packages/harness/deerflow/skills/storage/user_scoped_skill_storage.py`：用户隔离 skill storage。

**解释**：

legacy 的存在是迁移策略：不马上删除旧全局技能，避免用户升级后能力突然消失；但把它标成只读，防止继续在全局空间写入新状态。新的 custom skill 应该落到 user-scoped storage。

资深回答要包含：迁移时保持可见性、避免跨用户 bleed、处理同名覆盖、给出复制/升级路径、保留审计和回滚。不能简单把旧目录全量搬到每个用户名下，否则会造成权限和所有权混乱。

## 8. `required_secrets` 与 `secrets_autonomous`

**问题**：`Skill` 支持 `required_secrets` 和 `secrets_autonomous`。你会如何判定一个 secret 能否在“自主加载 skill context”时绑定，而不是只能在显式 slash activation 时绑定？

**对应源码**：

- `backend/packages/harness/deerflow/skills/types.py:25`：`SecretRequirement`。
- `backend/packages/harness/deerflow/skills/types.py:51`：`required_secrets`。
- `backend/packages/harness/deerflow/skills/types.py:52`：`secrets_autonomous` 注释。
- `backend/packages/harness/deerflow/skills/parser.py:101`：解析 `secrets-autonomous`。
- `backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py:486`：binding gates。
- `backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py:497`：autonomous path 会检查 `secrets_autonomous`。

**解释**：

显式 slash activation 是用户有意识地启用某个 skill，所以可以绑定该 skill 声明的 secret。自主加载 skill context 是模型自己读取了某个 skill 后进入上下文，风险更高，所以 `secrets-autonomous: false` 可以禁止这种自动绑定。

资深答案要说清楚“ceremony”：slash 是显式授权仪式，in-context 是被动/自主路径。安全默认要谨慎，malformed `secrets-autonomous` 在 parser 里 fail closed 到 False。

## 9. skill `allowed-tools` policy 应在哪里 enforce

**问题**：技能激活链里如果某个 skill 声明了 allowed tools，你会在哪里 enforce？prompt 层、middleware 层、tool registry 层、sandbox 层分别应该承担什么责任？

**对应源码**：

- `backend/packages/harness/deerflow/skills/parser.py:41`：解析 `allowed-tools`。
- `backend/packages/harness/deerflow/skills/types.py:49`：`Skill.allowed_tools`。
- `backend/packages/harness/deerflow/agents/middlewares/skill_tool_policy_middleware.py:42`：`SkillToolPolicyMiddleware`。
- `backend/packages/harness/deerflow/agents/middlewares/skill_tool_policy_middleware.py:43`：只限制 active skill context 中的 tools。
- `backend/packages/harness/deerflow/agents/middlewares/skill_tool_policy_middleware.py:140`：计算允许工具名，失败时保留 framework-safe tools。

**解释**：

prompt 层只能提示模型，不是安全边界。tool registry 可以减少模型可见 schema。middleware 必须在 model call 和 tool execution 两边 enforce，防止模型绕过可见 schema 调用旧工具。sandbox 层负责文件/命令能力的最终隔离，不应该理解 skill policy 的业务语义。

资深答案要点：policy 只有 skill 被 slash 激活或进入 `skill_context` 后才生效，单纯 enable skill 不应该缩小全局工具集。

## 10. MCP 配置 RMW 锁与多 worker 问题

**问题**：MCP 配置存在 `extensions_config.json`，router 内部有 read-modify-write 锁。单进程锁只能解决 worker 内并发，如果部署成多 worker 或多副本，你会怎么改？

**对应源码**：

- `backend/app/gateway/routers/mcp.py:19`：说明 `_mcp_config_write_lock` 只序列化当前 worker 内 RMW。
- `backend/app/gateway/routers/mcp.py:23`：注释明确 cross-process writers 是另一个问题。
- `backend/app/gateway/routers/mcp.py:13`：读取和 reload `ExtensionsConfig`。
- `backend/packages/harness/deerflow/config/extensions_config.py:293`：`get_extensions_config` 使用进程内缓存。

**解释**：

现在的 lock 是 `asyncio.Lock()`，只能保护一个 Python 进程内两个并发 PUT 不互相覆盖。多 worker、多 pod、NFS 或共享 volume 下，仍可能有两个进程同时读旧文件、各自写回，导致丢更新。

资深改造方案：把配置移入数据库并用事务/行锁/version 字段做 optimistic locking；或使用跨进程 file lock；或把写入集中到单 writer 服务。还要考虑 reload cache 广播，否则一个 worker 写完，其他 worker 仍用旧缓存。

## 11. 配置热加载边界

**问题**：config 支持热加载，例如 feature flags 通过 `get_config` 每次请求读取。哪些配置适合热加载，哪些配置必须重启？为什么？

**对应源码**：

- `backend/packages/harness/deerflow/config/reload_boundary.py:1`：热加载边界的单一事实源。
- `backend/packages/harness/deerflow/config/reload_boundary.py:45`：startup-only fields。
- `backend/packages/harness/deerflow/config/reload_boundary.py:46`：database engine startup-only。
- `backend/packages/harness/deerflow/config/reload_boundary.py:49`：stream bridge singleton startup-only。
- `backend/packages/harness/deerflow/config/reload_boundary.py:50`：sandbox provider singleton startup-only。
- `backend/packages/harness/deerflow/config/reload_boundary.py:67`：scheduler service startup-only。

**解释**：

适合热加载的是请求级读取的配置，例如模型元数据、feature flags、部分 tool/skill 开关。必须重启的是启动期绑定的资源：数据库连接池、checkpointer、stream bridge、sandbox provider、logging handler、IM channel client、scheduler background task。

资深答案要说“谁持有这个配置快照”。如果对象在 lifespan startup 时构造并挂到 `app.state` 或单例缓存里，改 YAML 不会自动重建它。

## 12. scheduled-task 的 non-interactive 防伪造

**问题**：scheduled-task 是非交互运行，且 scheduler 内部调用才允许 `context.non_interactive=true`。你会如何防止普通客户端伪造 non-interactive context 绕过 `ask_clarification`？

**对应源码**：

- `backend/app/gateway/services.py:211`：`non_interactive` 是 internal-only key。
- `backend/app/gateway/services.py:243`：`strip_internal_context_keys` 清理非内部调用夹带的 internal key。
- `backend/app/gateway/services.py:737`：判断调用方是否内部认证。
- `backend/app/gateway/services.py:753`：只有 internal caller 才合并 internal context key。
- `backend/app/gateway/services.py:805`：scheduler 通过 `launch_scheduled_thread_run` 发起内部 run。
- `backend/app/gateway/services.py:840`：scheduler context 写入 `non_interactive: True`。
- `backend/packages/harness/deerflow/agents/lead_agent/agent.py:623`：non-interactive 时移除 `ask_clarification`。

**解释**：

普通 HTTP/IM 用户不能直接控制 `non_interactive`。Gateway 先判断 `request.state.auth_source == internal`，非内部调用会清理 `context` 和 `configurable` 中的 internal-only key。只有 scheduler 这类内部路径用 internal auth 构造 request，才能让 `non_interactive` 进入 runtime config。

资深答案要强调：不能只在前端隐藏字段，也不能只相信 body.context。服务端必须以认证来源为准，并在所有入口统一 scrub。

## 13. 分布式 scheduler 的 lease、并发和崩溃恢复

**问题**：调度器有 lease、poll interval、max concurrent runs。你会如何设计分布式 scheduler，避免重复执行、任务饥饿和 worker 崩溃后的永久锁死？

**对应源码**：

- `backend/packages/harness/deerflow/config/scheduler_config.py:4`：scheduler 配置模型。
- `backend/app/scheduler/service.py:18`：`ScheduledTaskService`。
- `backend/app/scheduler/service.py:39`：`run_once` 先计算 active runs，再按 budget claim。
- `backend/app/scheduler/service.py:47`：通过 `claim_due_tasks` 加 lease。
- `backend/app/scheduler/service.py:98`：overlap policy 为 skip 时检测 active run。
- `backend/app/scheduler/service.py:303`：startup 时标记 stale active runs 和 stuck once tasks。
- `backend/app/scheduler/service.py:332`：后台 poll loop。

**解释**：

这个服务有基本的 lease owner、lease seconds、并发上限和启动恢复。资深设计要继续往数据库原子性讲：`claim_due_tasks` 应该在事务里 `where lease_expired and due` 更新 lease owner，避免两个 worker 同时 claim；active run 计数要准确；once task 的失败/中断要终态化；worker 崩溃后依靠 lease expiry 和 startup reconciliation 恢复。

还要说公平性：不能每轮只抢最早几条导致某些任务长期饥饿，可以按 next_run_at、priority、tenant 做排序和限流。

## 14. Agent middleware 链顺序

**问题**：agent runtime 中间件链应该如何排序？例如 skill activation、tool policy、tool output budget、sandbox binding、memory injection，顺序错了会出现什么 bug？

**对应源码**：

- `backend/README.md` Middleware Chain：列出 ThreadData、Uploads、Sandbox、Summarization、Todo、Title、Memory、ViewImage、Clarification 的顺序。
- `backend/packages/harness/deerflow/agents/lead_agent/agent.py:572`：创建 agent 时传入 `build_middlewares(...)`。
- `backend/packages/harness/deerflow/agents/middlewares/thread_data_middleware.py:82`：ThreadData 在 before_agent 中提供 thread paths。
- `backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py`：负责 slash skill 和 secret binding。
- `backend/packages/harness/deerflow/agents/middlewares/skill_tool_policy_middleware.py`：负责 allowed-tools policy。

**解释**：

middleware 顺序是 agent 系统的“隐形架构”。ThreadData 必须早于 sandbox/file tools，因为工具需要 workspace/uploads/outputs。Uploads 应该早于模型调用，因为上传文件要注入上下文。Clarification 必须靠后截获 `ask_clarification` 并中断。Skill activation 和 tool policy 要在模型看到工具 schema 和真正执行工具之前生效。

顺序错会导致：工具拿不到路径、模型看不到上传文件、skill policy 只提示不执行、clarification 被当普通工具跑完、memory 在错误的上下文上提取。

## 15. Persistent memory 的多用户与审计

**问题**：对于持久化 memory，你会如何处理多用户、多线程、删除权、导出权和“被 agent 自动写入”的可审计性？

**对应源码**：

- `backend/app/gateway/routers/memory.py:17`：解析 memory owner。
- `backend/app/gateway/routers/memory.py:20`：IM 内部 owner header 映射到真实用户 memory。
- `backend/app/gateway/routers/memory.py:27`：raw owner id 通过 `make_safe_user_id` 清洗。
- `backend/app/gateway/routers/memory.py:74`：`MemoryResponse` schema。
- `backend/app/gateway/routers/memory.py:62`：memory fact 包含 `source`、`confidence`、`sourceError`。

**解释**：

memory 是跨线程长期数据，所以必须以 user 为 owner，而不是当前 thread。IM channel 代表用户调用时，要通过可信 internal owner header 找到真正 owner。fact 里保留 source thread 和 confidence，是审计自动记忆来源的基础。

资深答案要补足产品和合规层：用户应能查看、删除、修正、导出自己的 memory；agent 自动写入要有来源、时间、置信度和错误纠正字段；跨用户绝不能读写同一个 memory bucket。

## 16. Gateway 多入口统一 auth、rate limit、trace、identity

**问题**：Gateway 同时服务 REST API、LangGraph-compatible runtime、IM channel bridge。你会如何统一 auth、rate limit、request tracing 和 user identity resolution？

**对应源码**：

- `backend/app/gateway/services.py:315`：`inject_authenticated_user_context` 将认证身份写入 run context。
- `backend/app/gateway/services.py:737`：区分 internal caller。
- `backend/app/gateway/services.py:760`：服务端权威注入 user context。
- `backend/packages/harness/deerflow/runtime/runs/worker.py:363`：构造 runtime context。
- `backend/packages/harness/deerflow/runtime/runs/worker.py:388`：注入 Langfuse metadata。
- `backend/packages/harness/deerflow/runtime/runs/worker.py:391`：trace metadata 绑定 thread/user/assistant/model。

**解释**：

DeerFlow 的入口很多，但最后都要落到统一 run lifecycle。身份也必须统一：浏览器用户、IM owner、scheduler owner、internal user 都要映射成 runtime 可用的 user_id，并且 server-owned 字段不能由客户端伪造。

资深答案要说：auth 在 Gateway 边界完成，identity 进入 runtime context，trace id 进入 metadata，rate limit 应按 user/channel/thread/run 类型分层。否则 IM、HTTP、scheduler 会各自绕过一套安全和观测逻辑。

## 17. IM channel 的幂等、重试、顺序和长任务回调

**问题**：如果一个 IM channel，例如 Slack 或 Feishu，把外部消息桥接到同一个 agent runtime，你会如何处理幂等、重试、消息顺序和长任务回调？

**对应源码**：

- `backend/app/channels/service.py:311`：根据 channel name 动态加载并启动 channel。
- `backend/app/channels/manager.py:223`：从 LangGraph runs.wait result 提取响应。
- `backend/app/channels/manager.py:254`：特殊处理 `ask_clarification` tool message。
- `backend/README.md` IM Channels：说明 Feishu streaming、同 thread 快速追问排队、card patch。

**解释**：

IM 平台是外部事件源，常见问题是重复投递、乱序、同一 thread 正在跑、用户追问太快、平台消息卡片需要持续更新。ChannelService 负责启动具体 channel，ChannelManager 负责把外部消息转成 DeerFlow thread/run，并把结果抽取回平台。

资深答案要讲：外部 message id 做幂等键；同 thread 串行化或排队；平台 retry 不应创建重复 run；长任务用 running card / streaming patch；clarification 要能以 IM 可读文本返回。

## 18. Tool output budget 策略

**问题**：工具输出可能很大，项目里有 tool output budget middleware。你会如何定义预算策略？按 token、字节、MIME type、工具类别，还是用户计划等级？

**对应源码**：

- `backend/packages/harness/deerflow/agents/middlewares/tool_output_budget_middleware.py`：工具输出预算 middleware。
- `backend/packages/harness/deerflow/sandbox/sandbox.py:153`：sandbox grep 支持 `max_results`。
- `backend/packages/harness/deerflow/sandbox/sandbox.py:149`：sandbox glob 支持 `max_results`。
- `backend/packages/harness/deerflow/runtime/runs/worker.py:482`：stream loop 持续 publish chunks。

**解释**：

工具输出预算不是简单截断字符串。agent 需要足够信息继续推理，但不能让一次 grep、bash、MCP query、网页抓取把上下文撑爆。这个项目已经在底层工具接口暴露 `max_results`，并通过 middleware 管控输出进入模型的规模。

资深答案要说多维预算：字节/token 上限、结构化摘要、MIME 类型差异、工具类别差异、可恢复 artifact 链接、用户 tier 或模型 context 限额。还要保证截断是显式的，让模型知道输出不完整。

## 19. Artifact 安全：XSS、路径穿越、跨用户读取

**问题**：artifact 下载和展示涉及 MIME 类型、active content、sandbox 文件路径。你会如何防止 HTML/JS artifact 造成 XSS、路径穿越或跨用户读取？

**对应源码**：

- `backend/app/gateway/routers/artifacts.py:20`：active content MIME types。
- `backend/app/gateway/routers/artifacts.py:138`：active content 或 download 走 attachment。
- `backend/app/gateway/routers/artifacts.py:147`：artifact endpoint。
- `backend/app/gateway/routers/artifacts.py:152`：`require_permission("threads", "read", owner_check=True)`。
- `backend/app/gateway/routers/artifacts.py:193`：内部 owner header 归一化。
- `backend/app/gateway/routers/artifacts.py:204`：用 `resolve_thread_virtual_path` 解析 thread virtual path。

**解释**：

生成的 HTML/SVG 是 active content，不能默认 inline 展示，否则可能执行脚本或触发 XSS。router 把 `text/html`、`application/xhtml+xml`、`image/svg+xml` 强制 attachment。路径方面，外部请求传的是 virtual path，服务端用 `resolve_thread_virtual_path` 映射到真实路径，并结合 thread owner 权限校验。

资深答案要覆盖三层：权限检查、路径解析防 traversal、MIME/Content-Disposition 防 active content inline 执行。

## 20. 生产级 observability 改造

**问题**：如果你要给这个项目做一次生产级可靠性改造，你会优先补哪些 observability 指标？请具体到 agent run、tool call、sandbox、MCP、scheduler、persistence 六个层面。

**对应源码**：

- `backend/packages/harness/deerflow/runtime/runs/worker.py:242`：run worker 主执行路径。
- `backend/packages/harness/deerflow/runtime/runs/manager.py:187`：RunManager 管理 run 状态和持久化。
- `backend/packages/harness/deerflow/runtime/stream_bridge/base.py:37`：StreamBridge 抽象 producer/consumer。
- `backend/packages/harness/deerflow/persistence/bootstrap.py:473`：schema bootstrap。
- `backend/app/scheduler/service.py:39`：scheduler poll/claim。
- `backend/app/gateway/routers/mcp.py:19`：MCP config 写入锁和缓存 reload。
- `backend/packages/harness/deerflow/sandbox/sandbox.py:44`：sandbox 抽象。

**解释**：

这个项目是 agent runtime，可靠性问题通常不是单个 HTTP 500，而是 run 卡住、stream 丢事件、sandbox 起不来、MCP tool 慢、scheduler 重复执行、SQLite/Postgres 锁等待。observability 要围绕生命周期打点。

可以这样答：

- agent run：run 状态转换、耗时、stop_reason、模型名、token、隐藏 continuation 次数、rollback 次数。
- tool call：工具名、耗时、成功率、输出大小、截断次数、policy deny 次数。
- sandbox：provider、acquire/release 耗时、命令耗时、timeout、容器健康、文件 IO 错误。
- MCP：server/tool 维度延迟、OAuth refresh、cache hit、schema promotion、tool error。
- scheduler：claimed/skipped/launched/failed、lease expiry、active run count、poll loop error。
- persistence：bootstrap 分支、DB retry、lock wait、checkpoint/read/write latency、run event batch flush 失败。

资深答案重点不是“接 Prometheus”四个字，而是指标必须贴合 DeerFlow 的真实执行路径。

## 复习顺序建议

1. 先读 `backend/AGENTS.md` 的 Architecture、Agent System、Middleware Chain。
2. 再读 `backend/app/gateway/services.py`，理解 HTTP run 如何进入 `run_agent`。
3. 然后读 `backend/packages/harness/deerflow/agents/lead_agent/agent.py`，看工具、模型、skill、middleware 怎样组装。
4. 最后按专题读 sandbox、skills、MCP、scheduler、memory、artifacts。

能把这 20 题讲清楚，基本就能说明你理解了 DeerFlow 后端的核心架构，而不是只会跑项目。
