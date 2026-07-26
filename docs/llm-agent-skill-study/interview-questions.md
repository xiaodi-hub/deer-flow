# DeerFlow 常见面试题：LLM / Token / Context / Prompt / Tool / MCP / Agent / Skill

## 1. 基础理解题

本组源码坐标：`frontend/src/core/threads/hooks.ts:98`, `frontend/src/core/threads/hooks.ts:939`, `backend/app/gateway/routers/thread_runs.py:488`, `backend/app/gateway/services.py:611`, `backend/packages/harness/deerflow/runtime/runs/worker.py:242`, `backend/packages/harness/deerflow/agents/lead_agent/agent.py:443`, `backend/packages/harness/deerflow/agents/thread_state.py:239`。

### 1. DeerFlow 的一次聊天请求从前端到 LLM 大致经历哪些步骤？

参考答案：

前端 `useThreadStream` 调 LangGraph SDK 提交 run，Gateway 的 `/api/threads/{thread_id}/runs/stream` 进入 `start_run()`，`RunManager` 创建 `RunRecord`，后台启动 `run_agent()`。worker 注入 runtime context、RunJournal、tracing metadata，调用 `make_lead_agent()` 构建 LangGraph agent。agent 工厂创建模型、prompt、tools、middleware 和 `ThreadState`。执行时 LangGraph 通过 `StreamBridge` 输出 SSE，同时 RunJournal 写 run events 和 token usage。前端消费 `values`、`messages-tuple`、`custom` 更新 UI。

### 2. `configurable` 和 `context` 有什么区别？

参考答案：

`configurable` 偏 LangGraph 配置和 checkpoint 兼容，常见字段是 `thread_id`、`checkpoint_id`、`agent_name`、`model_name`。`context` 是运行时上下文，会进入 `Runtime.context` / tool runtime，承载 `run_id`、`user_id`、authz、secrets、app_config、non_interactive 等。DeerFlow 会把部分白名单字段同时写到两边，内部或 secret 类字段只放到 `context`，避免被 checkpoint 持久化。

### 3. DeerFlow 为什么使用 `ThreadState`，而不是只依赖 messages？

参考答案：

messages 只适合表达对话历史。DeerFlow 还需要保存 sandbox、artifacts、todos、goal、uploaded files、viewed images、deferred tool promotion、subagent delegation ledger、skill context 和 summary_text。这些都需要 reducer 控制合并语义，例如去重、终态不降级、限制列表长度、按 catalog hash 防止工具漂移。

### 4. prompt 是如何组装的？

参考答案：

`apply_prompt_template()` 从静态 system template 开始，按配置追加自定义 agent SOUL、自更新说明、skills section、deferred tools、MCP routing hints、subagent 编排说明、memory tool guidance、ACP/custom mounts 等。日期和 memory 等强动态内容不直接拼进 system prompt，而由 middleware 注入隐藏上下文。

### 5. DeerFlow 的 tools 来源有哪些？

参考答案：

来源包括 `config.yaml -> tools[]` 动态加载工具、built-in tools、skill evolution 的 `skill_manage`、subagent 的 `task`、vision 的 `view_image`、MCP tools、ACP agent tool。最终按名称去重，并经过 middleware 做权限、安全、审计、预算和错误处理。

## 2. LLM 与 Token 题

本组源码坐标：`backend/packages/harness/deerflow/config/model_config.py:4`, `backend/packages/harness/deerflow/models/factory.py:174`, `backend/packages/harness/deerflow/agents/lead_agent/agent.py:450`, `backend/packages/harness/deerflow/agents/middlewares/token_usage_middleware.py:231`, `backend/packages/harness/deerflow/agents/middlewares/token_usage_middleware.py:267`, `backend/packages/harness/deerflow/agents/middlewares/token_budget_middleware.py:62`, `backend/packages/harness/deerflow/runtime/journal.py:243`, `backend/packages/harness/deerflow/runtime/journal.py:724`, `backend/app/gateway/routers/thread_runs.py:990`, `frontend/src/core/threads/hooks.ts:2032`。

### 6. `create_chat_model()` 主要解决什么问题？

参考答案：

它把模型配置转换成 LangChain `BaseChatModel` 实例，动态加载 provider class，处理 thinking / reasoning_effort / vision 能力声明，归一化 OpenAI compatible 参数，默认开启 `stream_usage`，补充 streaming timeout，并按场景决定是否挂 tracing callbacks。

### 7. 为什么 lead agent 内部创建模型时要传 `attach_tracing=False`？

参考答案：

因为 LangSmith / Langfuse callbacks 已经挂在 graph invocation root。graph 内模型调用如果再挂 model-level tracing，会产生重复 spans，而且 Langfuse 的 session/user metadata 需要在 root chain start 时提升，挂在 nested model 上会丢失这部分 trace attributes。

### 8. DeerFlow 如何统计 token usage？

参考答案：

模型响应的 `AIMessage.usage_metadata` 是基础来源。`TokenUsageMiddleware` 在模型响应后记录 usage 并添加 step attribution。`RunJournal.on_llm_end` 聚合 run 级 token、caller 维度 token、model 维度 token。subagent 内部由 `SubagentTokenCollector` 收集并汇报给父 RunJournal。run 结束后 worker 把汇总写入 RunStore，前端通过 token usage API 展示。

### 9. `TokenBudgetMiddleware` 为什么不直接 raise 异常？

参考答案：

它的目标是“带着已收集结果收尾”，不是让 run 崩溃。达到 hard stop 后，它移除 AIMessage 的 tool_calls，让 LangGraph 自然进入最终回答路径，并在 runtime context 写 `stop_reason=token_capped`。这样状态、事件、前端展示和 subagent 结果都能保持结构化。

### 10. 为什么 token warning 要延迟到下一次 model call 注入？

参考答案：

当前 AIMessage 可能带 tool_calls，后面必须接 ToolMessage。直接插入 warning 可能破坏 provider 和 LangGraph 对 tool call pairing 的约束。延迟注入可以保留消息结构，同时提醒模型尽快收尾。

### 11. subagent 的 token 如何并入父 run？

参考答案：

subagent 创建自己的 `SubagentTokenCollector`，收集每次 LLM 调用 usage。任务完成后 `task_tool` 调父 runtime callbacks 中的 `RunJournal.record_external_llm_usage_records()`，并按 `tool_call_id` 缓存汇总 usage。父 `TokenUsageMiddleware` 再把它合并回触发 `task` 的 AIMessage。

## 3. Context 与 Prompt 题

本组源码坐标：`backend/packages/harness/deerflow/agents/thread_state.py:110`, `backend/packages/harness/deerflow/agents/thread_state.py:151`, `backend/packages/harness/deerflow/agents/thread_state.py:205`, `backend/packages/harness/deerflow/agents/thread_state.py:239`, `backend/packages/harness/deerflow/agents/lead_agent/prompt.py:339`, `backend/packages/harness/deerflow/agents/lead_agent/prompt.py:820`, `backend/packages/harness/deerflow/agents/lead_agent/prompt.py:1003`, `backend/packages/harness/deerflow/agents/middlewares/dynamic_context_middleware.py:128`, `backend/packages/harness/deerflow/agents/middlewares/durable_context_middleware.py:196`, `backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py:78`, `backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py:447`。

### 12. DeerFlow 如何控制长上下文？

参考答案：

`DeerFlowSummarizationMiddleware` 根据配置自动触发 summarization，也支持 `/compact` 对应的手动 compaction API。它把旧 messages 摘要成 `summary_text`，保留近期 tail，并通过 `DurableContextMiddleware` 在后续模型请求中注入 summary。summary LLM 调用带 `TAG_NOSTREAM`，避免前端误显示。

### 13. 为什么 summary 存在 `summary_text` channel，而不是塞回 messages？

参考答案：

summary 是 durable context data，不是用户或 assistant 的真实发言。独立 channel 让 UI、checkpoint、上下文注入和权限解释更清楚，也避免把 summary 当作普通历史消息反复压缩或显示。

### 14. `DurableContextMiddleware` 的作用是什么？

参考答案：

它把 summary、subagent delegation ledger、skill_context 从 checkpoint state 注入到模型请求，同时用 system message 声明 authority contract：这些内容是历史数据，不是新指令。它也负责在 summarization 压缩前捕获 delegations 和 skill reads，防止重要上下文随 messages 被删除。

### 15. 为什么 DeerFlow 对 SOUL、skill metadata、summary text 等做 HTML escape？

参考答案：

这些内容可能来自用户、工具、agent 自编辑或外部包，是非可信文本。如果直接拼到 XML-like prompt block 中，恶意内容可以闭合标签并伪造 `<system-reminder>` 等高权限结构。escape 后模型仍能读到文本，但不能改变 prompt 结构。

### 16. 为什么要做 SystemMessageCoalescing？

参考答案：

一些 provider 或 OpenAI-compatible 后端只接受最前方一个 system message，或者拒绝非 leading SystemMessage。middleware 链上多个模块可能插入 system message，所以最后统一 coalesce 成单个 leading system message，提高 provider 兼容性。

## 4. Tool 与 MCP 题

本组源码坐标：`backend/packages/harness/deerflow/tools/tools.py:45`, `backend/packages/harness/deerflow/tools/builtins/tool_search.py:64`, `backend/packages/harness/deerflow/tools/builtins/tool_search.py:142`, `backend/packages/harness/deerflow/tools/builtins/tool_search.py:200`, `backend/packages/harness/deerflow/tools/builtins/tool_search.py:282`, `backend/packages/harness/deerflow/tools/builtins/tool_search.py:310`, `backend/packages/harness/deerflow/mcp/cache.py:115`, `backend/packages/harness/deerflow/mcp/cache.py:141`, `backend/packages/harness/deerflow/mcp/cache.py:191`, `backend/packages/harness/deerflow/mcp/tools.py:425`, `backend/packages/harness/deerflow/mcp/tools.py:569`, `backend/packages/harness/deerflow/mcp/session_pool.py:47`, `backend/packages/harness/deerflow/mcp/session_pool.py:126`, `backend/packages/harness/deerflow/mcp/session_pool.py:378`。

### 17. 为什么 MCP tools 要缓存？

参考答案：

MCP tool discovery 可能需要启动 stdio server、连远程服务或 OAuth，成本高且不应该每轮重复。`mcp/cache.py` 缓存工具列表，并用 extensions config 的 path + mtime + size + sha256 判断是否变化。变化后 reset cache 和 session pool，保证配置更新能生效。

### 18. 为什么 stdio MCP 需要 session pool？

参考答案：

一些 MCP server 是有状态的，例如 Playwright 浏览器。如果每次工具调用都新建 session，浏览器状态会丢失。session pool 以 `(server_name, user_id:thread_id)` 为 scope 复用 session，同时隔离不同用户和线程。owner task 模式还避免 anyio cancel scope 被不同 task 退出导致崩溃。

### 19. MCP 输出中的本地路径为什么要重写？

参考答案：

stdio MCP server 可能返回主机本地路径，但 DeerFlow 后续工具和 artifact API 使用 `/mnt/user-data/...` virtual path。路径重写只允许当前 user/thread 的 user-data 文件映射到 virtual path，既让截图/文件可访问，也避免暴露主机其他路径。

### 20. `tool_search` 解决什么问题？

参考答案：

MCP 工具太多时，全部绑定给模型会占用大量 token 并降低工具选择质量。`tool_search` 把 MCP 工具延迟暴露：prompt 只列名字，模型查询后才拿完整 schema，promotion 写入 ThreadState。这样减少 schema 噪音，同时保留工具可发现性。

### 21. `tool_search` promotion 为什么要带 catalog hash？

参考答案：

工具名本身不够安全。MCP 配置变化后，同名工具可能对应不同 schema。catalog hash 把 promotion 绑定到构图时的工具目录，目录变化时旧 promotion 会失效，防止持久状态暴露错误工具。

### 22. 工具权限为什么不能只靠 prompt？

参考答案：

LLM 可能不遵守 prompt，也可能被注入诱导。DeerFlow 用 middleware 同时过滤模型可见 schema 和实际 tool execution。例如 active skill 的 `allowed-tools` 会影响 model request、tool call 和 `tool_search` 返回结果，形成运行时强约束。

### 23. `ReadBeforeWriteMiddleware` 的价值是什么？

参考答案：

它要求修改已有文件前必须先读取目标文件，并校验最新 hash 匹配。这样可以避免模型基于过期上下文覆盖用户或其他任务刚改过的文件，尤其适合长对话、并行工具和多轮编辑场景。

## 5. Agent 与 Subagent 题

本组源码坐标：`backend/packages/harness/deerflow/agents/lead_agent/agent.py:238`, `backend/packages/harness/deerflow/agents/lead_agent/agent.py:443`, `backend/packages/harness/deerflow/agents/lead_agent/agent.py:475`, `backend/packages/harness/deerflow/agents/lead_agent/agent.py:557`, `backend/packages/harness/deerflow/agents/lead_agent/agent.py:623`, `backend/packages/harness/deerflow/tools/builtins/task_tool.py:60`, `backend/packages/harness/deerflow/tools/builtins/task_tool.py:230`, `backend/packages/harness/deerflow/subagents/registry.py:50`, `backend/packages/harness/deerflow/subagents/executor.py:76`, `backend/packages/harness/deerflow/subagents/executor.py:394`, `backend/packages/harness/deerflow/subagents/executor.py:1025`, `backend/packages/harness/deerflow/agents/middlewares/subagent_limit_middleware.py:95`, `backend/packages/harness/deerflow/runtime/runs/worker.py:180`。

### 24. lead agent 和 custom agent 是什么关系？

参考答案：

custom agent 不是独立 runtime，而是同一个 lead agent 工厂读取 `agent_name` 后加载对应 SOUL、config、tool groups、skills、model。这样能复用同一套 run lifecycle、middleware、权限、tracing、streaming 和 checkpoint。

### 25. plan/pro/ultra 模式如何影响 agent？

参考答案：

前端把模式转换成 runtime context。通常 thinking/pro/ultra 会影响 `thinking_enabled` 和 `reasoning_effort`，pro/ultra 开启 plan mode 的 TodoMiddleware，ultra 开启 subagent tool。后端在 `make_lead_agent()` 和 `build_middlewares()` 中读取这些 runtime config。

### 26. subagent 的执行链路是什么？

参考答案：

lead agent 调用 `task` tool。`task_tool` 解析 subagent config、继承父 run 的 thread/sandbox/user/authz/model/tool_groups，创建 `SubagentExecutor`。executor 创建子 agent，并在后台线程池和 isolated event loop 中运行。结果通过 polling 返回 ToolMessage，过程通过 custom stream events 推给前端。

### 27. 为什么 subagent 不暴露 `task` 工具？

参考答案：

防止递归委派导致无限任务树、成本爆炸和难以监控。subagent 是隔离上下文和并行执行的工具，不是再启动一整套无限编排器。

### 28. `SubagentLimitMiddleware` 为什么必要？

参考答案：

prompt 中的“最多 N 个 subagent”不是硬约束。middleware 会截断超出的 `task` tool_calls，并按 run_id 统计总 delegation 数。这样能控制并发、成本、运行时间和系统负载。

### 29. subagent step history 如何支持前端 reload 后查看？

参考答案：

实时运行时，`task_tool` 通过 custom events 发 step 更新。worker 里的 `_SubagentEventBuffer` 会把 subagent step events 批量写入 RunEventStore。前端历史消息里带 run_id，展开任务卡片时按 `/runs/{runId}/events?task_id=...` 分页拉回 step timeline。

## 6. Skill 题

本组源码坐标：`backend/packages/harness/deerflow/skills/describe.py:51`, `backend/packages/harness/deerflow/skills/describe.py:102`, `backend/packages/harness/deerflow/skills/describe.py:150`, `backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py:87`, `backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py:135`, `backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py:357`, `backend/packages/harness/deerflow/agents/middlewares/skill_tool_policy_middleware.py:42`, `backend/packages/harness/deerflow/agents/middlewares/skill_tool_policy_middleware.py:204`, `backend/packages/harness/deerflow/agents/middlewares/skill_tool_policy_middleware.py:248`, `backend/packages/harness/deerflow/skills/tool_policy.py:18`, `backend/packages/harness/deerflow/skills/tool_policy.py:28`, `backend/packages/harness/deerflow/skills/storage/local_skill_storage.py:29`。

### 30. skill 和 tool 的区别是什么？

参考答案：

tool 是可调用能力，比如读文件、搜索、执行命令。skill 是持久化工作流说明，告诉 agent 在某类任务中如何组织工具、参考哪些资源、遵循哪些约束。skill 可以声明 allowed-tools，但本身不是工具调用。

### 31. skill 的发现方式有哪些？

参考答案：

legacy 模式把 enabled skills 的 metadata 渲染进 `<available_skills>`。deferred discovery 模式只渲染 `<skill_index>` 名称，模型调用 `describe_skill` 获取描述、allowed tools 和路径，再用 `read_file` 读取完整 SKILL.md。slash activation 则由用户显式 `/<skill-name>` 触发，runtime 直接注入完整 skill 内容。

### 32. 为什么 skill 启用不等于激活？

参考答案：

启用只代表可发现。如果启用即激活，那么所有 skill 的 allowed-tools、secrets 或行为约束都会同时影响 agent，造成权限扩大和上下文污染。DeerFlow 只有在 slash activation 或模型实际读取 skill 后，才把它放入 active skill context。

### 33. slash skill activation 做了哪些安全校验？

参考答案：

它检查 skill 是否安装、启用、在当前 agent allowlist 内；读取路径必须是合法 SKILL.md；注入内容会 escape；run context 记录 activation key，避免 tool loop 中重复注入；同时记录审计事件。

### 34. `SkillToolPolicyMiddleware` 如何限制工具？

参考答案：

它根据 slash activation 或 `ThreadState.skill_context` 找 active skills，计算 allowed tool names。如果有限制，就过滤 model request 里的工具 schema，阻止未授权 tool execution，并过滤 `tool_search` 返回的 deferred MCP schemas。slash policy 在本 run 内优先，防止被动读取其他 skill 扩权。

### 35. skill secrets 为什么按 path 而不是 name 绑定？

参考答案：

因为 custom skill 可以 shadow 同名 public skill。按 name 绑定可能把 public skill 的引用错配到 custom skill 的 secrets，形成 confused deputy。按 canonical container path 严格匹配更安全。

### 36. skill 安装和编辑为什么需要安全扫描？

参考答案：

skill 会影响 agent 行为，甚至能引用脚本和工具。安装/编辑时做静态扫描和 LLM 安全扫描，可以阻止明显恶意、越权或 prompt injection 风险的 skill 包进入持久能力库。

## 7. 观测与排障题

本组源码坐标：`backend/packages/harness/deerflow/runtime/journal.py:56`, `backend/packages/harness/deerflow/runtime/journal.py:192`, `backend/packages/harness/deerflow/runtime/journal.py:243`, `backend/packages/harness/deerflow/runtime/journal.py:724`, `backend/packages/harness/deerflow/runtime/events/store/db.py:26`, `backend/packages/harness/deerflow/runtime/events/store/db.py:160`, `backend/packages/harness/deerflow/runtime/events/store/db.py:229`, `backend/packages/harness/deerflow/tracing/factory.py:37`, `backend/packages/harness/deerflow/tracing/metadata.py:29`, `backend/packages/harness/deerflow/tracing/metadata.py:80`, `backend/app/gateway/trace_middleware.py:17`, `backend/app/gateway/routers/thread_runs.py:949`, `backend/app/gateway/routers/thread_runs.py:990`。

### 37. 如何查看一次 run 的状态和 token？

参考答案：

用 `GET /api/threads/{thread_id}/runs/{run_id}` 查看状态、模型、token 汇总、message count、stop_reason。用 `GET /api/threads/{thread_id}/token-usage` 看线程聚合 token。运行中如果启用 active progress，RunJournal 也会节流更新 RunManager progress snapshot。

### 38. 如何查看一次 run 的详细执行事件？

参考答案：

用 `GET /api/threads/{thread_id}/runs/{run_id}/events`。它来自 RunEventStore，包括 LLM request/response、tool result、middleware audit、subagent step 等。按 `event_types`、`task_id`、`after_seq` 可以过滤。

### 39. Langfuse trace 如何与 DeerFlow thread/run 对齐？

参考答案：

`inject_langfuse_metadata()` 把 thread_id 映射为 `langfuse_session_id`，user_id 映射为 `langfuse_user_id`，assistant/model/env 写成 trace name/tags。Gateway TraceMiddleware 还可把请求级 `X-Trace-Id` 绑定到 `deerflow_trace_id`，使 HTTP 日志和 Langfuse trace 可关联。

### 40. 如果前端显示历史消息顺序错乱，应该看哪里？

参考答案：

先看 RunEventStore 的 `seq` 是否连续、`/messages/page` 返回顺序是否正确，再看前端 `mergeMessages()`、`buildVisibleHistoryMessages()`、summarization transient bridge 的 identity dedupe。checkpoint messages 和 run events 是两套来源，前端会把历史、live stream、optimistic message 合并。

### 41. 如果 MCP 工具配置更新后不生效，应该检查什么？

参考答案：

检查 `extensions_config.json` 是否写入成功，`reload_extensions_config()` 是否调用，`reset_mcp_tools_cache()` 是否执行。还要检查 cache signature 是否变化、MCP server 是否 enabled、tool name 是否通过安全校验、stdio command 是否被 API allowlist 允许。

### 42. 如果 token usage 总是 0，可能是什么原因？

参考答案：

provider 没有返回 usage metadata；OpenAI compatible 没打开 `stream_usage`；模型 wrapper 没把 usage 写进 `AIMessage.usage_metadata`；RunJournal callback 没挂到 graph root；subagent usage 没有通过 collector 汇报；RunStore completion persistence 失败。

### 43. 如果 tool call 一直重复，系统如何处理？

参考答案：

`ToolProgressMiddleware` 会根据工具结果质量和错误类别给 warning 或 block，`LoopDetectionMiddleware` 会检测重复工具调用循环，`TokenBudgetMiddleware` 也可能因成本达到阈值强制收尾。RunEventStore 和 RunJournal 可用于定位重复发生在哪个 tool 和哪个 message step。

## 8. 开放设计题

本组源码坐标：`backend/app/gateway/services.py:258`, `backend/app/gateway/services.py:805`, `backend/app/gateway/services.py:840`, `backend/app/gateway/app.py:257`, `backend/app/gateway/app.py:270`, `backend/app/scheduler/service.py:18`, `backend/packages/harness/deerflow/tools/tools.py:45`, `backend/packages/harness/deerflow/models/factory.py:174`, `backend/packages/harness/deerflow/agents/middlewares/skill_tool_policy_middleware.py:42`, `backend/packages/harness/deerflow/tools/builtins/tool_search.py:200`, `backend/packages/harness/deerflow/runtime/journal.py:56`, `backend/packages/harness/deerflow/tracing/factory.py:37`。

### 44. 为什么 DeerFlow 把 observability 做成 RunJournal + tracing providers 两层？

参考答案：

RunJournal 是产品内的结构化事件和统计，支撑历史、调试、token、前端任务卡片；LangSmith/Langfuse/Monocle 是外部 tracing，用于跨 LLM/tool/graph 的调用链观测。两者用途不同，前者是业务数据，后者是分布式追踪。

### 45. 如果要新增一个工具，你会接入哪里？

参考答案：

普通工具可以在 config `tools[]` 里通过 `use` 指向 LangChain tool；内置框架工具放到 `tools/builtins` 并由 `get_available_tools()` 条件加入；外部生态工具优先用 MCP server 接入。还要考虑 tool group、skill allowed-tools、tool output budget、错误类型、审计和测试。

### 46. 如果要新增一个模型 provider，你会改哪里？

参考答案：

新增 provider class，确保继承合适的 LangChain `BaseChatModel` 或 compatible class；在 config 中设置 `use`、`model`、能力字段和 provider 参数。必要时在 `create_chat_model()` 增加 provider 特殊归一化逻辑，但应优先通过 config 表达。

### 47. 如果要让 skill 支持更精细权限，你会怎么做？

参考答案：

可以扩展 skill metadata，从工具名 allowlist 扩展到参数级策略、resource scope、MCP server scope 或 secret scope。关键是仍要在 `SkillToolPolicyMiddleware` 的 model schema、execution、tool_search result 三层同时生效，不能只扩展 prompt。

### 48. 如果有 1000 个 MCP 工具，现有设计还缺什么？

参考答案：

现有 deferred loading 能减少 schema 暴露，但 catalog search 仍是内存本地 keyword/regex。更大规模时可以引入 embedding/ranking、server/tool 分层目录、使用频率缓存、按 skill/agent/tool group 预过滤、以及更强的 tool metadata taxonomy。

### 49. 如果计划任务是非交互式，为什么要移除 `ask_clarification`？

参考答案：

计划任务没有在线用户等待回答。如果保留 clarification，agent 可能停在需要用户输入的状态，任务无法完成。DeerFlow 只允许内部认证路径设置 `non_interactive=true`，并在 lead toolset 中移除 `ask_clarification`，避免普通客户端强制 agent 跳过澄清。

### 50. DeerFlow 这种架构最大的复杂度在哪里？

参考答案：

复杂度在运行时上下文和权限边界：同一套 agent 要支持 Web、IM、scheduler、custom agent、MCP、subagent、skill、memory、sandbox、多用户和多 worker。项目用统一 run lifecycle、middleware chain、ThreadState reducer、RunJournal、context scrubbing 和 tool policy 来把复杂度集中管理。
