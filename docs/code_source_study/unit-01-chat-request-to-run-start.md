# 第 01 单元：一次聊天请求到 Run 启动

日期：2026-07-21

## 学习目标

追踪一次普通网页聊天请求：从输入框提交，经 Gateway 的 run 准入，到后台 `run_agent()` 任务被创建。本单元在图实际执行前结束。

## 前置知识

- React Hooks 与乐观 UI 状态
- LangGraph 的 `RunnableConfig`、线程和 checkpoint
- FastAPI middleware 与 Server-Sent Events（SSE）

## 阅读顺序

1. [`page.tsx`](/G:/2026github/deer-flow/frontend/src/app/workspace/chats/[thread_id]/page.tsx:100)
   - 将 `useThreadStream().sendMessage` 连接到 `InputBox`。
2. [`input-box.tsx`](/G:/2026github/deer-flow/frontend/src/components/workspace/input-box.tsx:844)
   - 判断输入框命令，并把普通消息继续向下传递。
3. [`hooks.ts`](/G:/2026github/deer-flow/frontend/src/core/threads/hooks.ts:1042)
   - 管理乐观状态、文件上传和 `thread.submit`。
4. [`api-client.ts`](/G:/2026github/deer-flow/frontend/src/core/api/api-client.ts:169)、[`config/index.ts`](/G:/2026github/deer-flow/frontend/src/core/config/index.ts:21)
   - 创建 LangGraph-compatible SDK client，并注入 CSRF 请求头。
5. [`nginx.local.conf`](/G:/2026github/deer-flow/docker/nginx/nginx.local.conf:50)
   - 改写兼容 API 前缀，并确保 SSE 流不会被缓冲。
6. [`thread_runs.py`](/G:/2026github/deer-flow/backend/app/gateway/routers/thread_runs.py:496)、[`services.py`](/G:/2026github/deer-flow/backend/app/gateway/services.py:609)
   - 准入请求、持久化 run 记录，并启动 `run_agent` 后台任务。

## 请求链路

```text
InputBox
  -> ChatPage.handleSubmit
  -> useThreadStream.sendMessage
  -> LangGraph SDK runs.stream
  -> POST /api/langgraph/threads/{threadId}/runs/stream
  -> Nginx 改写 -> /api/threads/{threadId}/runs/stream
  -> stream_run -> start_run
  -> RunManager.create_or_reject
  -> asyncio.create_task(run_agent(...))
```

## 源码事实

### 前端入口与状态

- [`ChatPage`](/G:/2026github/deer-flow/frontend/src/app/workspace/chats/[thread_id]/page.tsx:100) 创建 `useThreadStream`，并在 [`handleSubmit`](/G:/2026github/deer-flow/frontend/src/app/workspace/chats/[thread_id]/page.tsx:171) 中调用其返回的 `sendMessage`。
- 对于新对话，`useThreadStream` 接收到的运行线程 ID 是 `undefined`，而页面仍保留显示用的线程 ID。后端确认创建线程后，[`onStart`](/G:/2026github/deer-flow/frontend/src/app/workspace/chats/[thread_id]/page.tsx:120) 才替换浏览器 URL。
- [`InputBox.handleSubmit`](/G:/2026github/deer-flow/frontend/src/components/workspace/input-box.tsx:929) 先区分 `/goal`、`/compact`、停止、空输入和普通输入。普通输入经 [`submitThreadMessage`](/G:/2026github/deer-flow/frontend/src/components/workspace/input-box.tsx:844) 和页面传入的回调向下传递；输入框本身不是普通消息的 HTTP 实现层。
- [`useThreadStream.sendMessage`](/G:/2026github/deer-flow/frontend/src/core/threads/hooks.ts:1368) 通过 `sendInFlightRef` 阻止本地重复派发，写入乐观的用户消息，并暴露上传状态。
- 上传完成后，[`thread.submit`](/G:/2026github/deer-flow/frontend/src/core/threads/hooks.ts:1514) 提交 messages，并明确请求 `values`、`messages-tuple`、`custom` 三类流事件，同时开启 subgraph 和可恢复流。
- [`useStream`](/G:/2026github/deer-flow/frontend/src/core/threads/hooks.ts:1042) 以 `assistantId: "lead_agent"`、允许重连和一条 state history 创建。[`onCreated`](/G:/2026github/deer-flow/frontend/src/core/threads/hooks.ts:1048) 接收后端的 `thread_id`、`run_id` 并更新 UI cache。

### 传输与 Gateway 边界

- 默认 SDK 基址是 `${window.location.origin}/api/langgraph`（[`getLangGraphBaseURL`](/G:/2026github/deer-flow/frontend/src/core/config/index.ts:21)）。
- [`createCompatibleClient`](/G:/2026github/deer-flow/frontend/src/core/api/api-client.ts:169) 用该地址和 CSRF 请求钩子创建 `LangGraphClient`。对于状态变更请求，[`injectCsrfHeader`](/G:/2026github/deer-flow/frontend/src/core/api/api-client.ts:28) 将 `csrf_token` cookie 写入 `X-CSRF-Token`。
- [Nginx 的兼容路由](/G:/2026github/deer-flow/docker/nginx/nginx.local.conf:50) 将 `/api/langgraph/*` 改写为 `/api/*`，关闭 proxy buffering/cache，开启 chunked transfer，并提供长请求超时。
- [`stream_run`](/G:/2026github/deer-flow/backend/app/gateway/routers/thread_runs.py:496) 注册 `POST /api/threads/{thread_id}/runs/stream`，要求经过认证且有该线程所有权的 run 创建权限。它先调用 [`start_run`](/G:/2026github/deer-flow/backend/app/gateway/services.py:609)，再用 [`sse_consumer`](/G:/2026github/deer-flow/backend/app/gateway/services.py:831) 返回 SSE `StreamingResponse`。
- [`stream_run`](/G:/2026github/deer-flow/backend/app/gateway/routers/thread_runs.py:501) 的响应包含 `Content-Location: /api/threads/{thread_id}/runs/{run_id}`，SDK 据此取得新建 run 的资源位置。

### Run 准入与后台交接

- [`langgraph_runtime`](/G:/2026github/deer-flow/backend/app/gateway/deps.py:223) 在 Gateway 启动时构造 `StreamBridge`、checkpointer、持久化或内存 run store、event store、thread store 和 `RunManager`。它会[恢复无主 in-flight run](/G:/2026github/deer-flow/backend/app/gateway/deps.py:313)，并在配置启用时启动 ownership lease heartbeat。
- [`start_run`](/G:/2026github/deer-flow/backend/app/gateway/services.py:609) 校验模型是否在配置 allowlist 中，并在创建 run 前检查线程所有权。
- [`RunManager.create_or_reject` 的调用点](/G:/2026github/deer-flow/backend/app/gateway/services.py:675) 位于 `goal_thread_lock(thread_id)` 内，持久化经过脱敏的配置副本，并执行请求指定的 multitask strategy。
- [`normalize_input`](/G:/2026github/deer-flow/backend/app/gateway/services.py:145) 通过 LangChain 的消息转换进行标准化；格式错误的消息返回 HTTP 400，外部调用者不能保留服务端专属消息元数据。
- [`merge_run_context_overrides`](/G:/2026github/deer-flow/backend/app/gateway/services.py:258) 限制可接受的 context key，[`inject_authenticated_user_context`](/G:/2026github/deer-flow/backend/app/gateway/services.py:315) 将认证身份写入后台 run context，并禁止客户端伪造授权属性。
- 最后，[`asyncio.create_task(run_agent(...))`](/G:/2026github/deer-flow/backend/app/gateway/services.py:747) 创建后台任务，将 task 记录在 run 上后立刻返回。

## 状态模型

| 边界 | 改变的状态 | 所有者 |
| --- | --- | --- |
| 输入框 | 草稿、斜杠命令分类、本地校验 | `InputBox` |
| Thread hook | `sendInFlightRef`、乐观消息、上传标记、流线程 ID | `useThreadStream` |
| Gateway | 认证用户、已校验请求、`RunRecord`、线程元数据 | FastAPI + `start_run` |
| 后台边界 | `RunRecord.task`、图输入、已清洗的 `RunnableConfig` | `RunManager` / worker |

## 生产设计取舍

- 流式：关闭 Nginx proxy buffering；否则 SSE 会被聚合，模型和工具事件不能及时到达前端。
- 并发：前端 guard 只改善体验；`RunManager.create_or_reject` 才是跨标签页、跨客户端的权威控制。
- 隔离：认证、owner check、checkpointer 的 `thread_id` 和服务端写入的 user context 一起保护线程和工具边界。
- 恢复：run store 与启动时的 orphan recovery 让 run 记录可跨 Gateway 重启保留；流重连细节在下一单元分析。
- 安全：浏览器状态变更请求通过 [`CSRFMiddleware.dispatch`](/G:/2026github/deer-flow/backend/app/gateway/csrf_middleware.py:190) 的双提交 cookie 校验 CSRF。
- 扩展：应用暴露 LangGraph Platform-compatible API；[`resolve_agent_factory`](/G:/2026github/deer-flow/backend/app/gateway/services.py:382) 将各种 assistant ID 解析到 lead-agent factory，而 [`build_run_config`](/G:/2026github/deer-flow/backend/app/gateway/services.py:431) 将 custom agent 选择经清洗后的 runtime config 传递。

## 框架知识与推断

- 框架知识：LangGraph React SDK 负责 `runs.stream` 的精确 HTTP 路径拼接；DeerFlow 提供基址与兼容服务端路由。
- 推断：由 SDK 基址和 Gateway 路由可推出，正常外部请求是 `/api/langgraph/threads/{threadId}/runs/stream`，进入 Gateway 后成为 `/api/threads/{threadId}/runs/stream`。这来自协议和源码的组合，不是 DeerFlow 前端手写该 URL 字符串。

## 验证锚点

- [`api-client.test.ts`](/G:/2026github/deer-flow/frontend/tests/unit/core/api/api-client.test.ts:1)
- [`stream-mode.test.ts`](/G:/2026github/deer-flow/frontend/tests/unit/core/api/stream-mode.test.ts:1)
- [`test_gateway_services.py`](/G:/2026github/deer-flow/backend/tests/test_gateway_services.py:1)
- [`test_runtime_lifecycle_e2e.py`](/G:/2026github/deer-flow/backend/tests/test_runtime_lifecycle_e2e.py:1)
- [`test_run_manager.py`](/G:/2026github/deer-flow/backend/tests/test_run_manager.py:1)

## 复述问题

1. [`stream_run`](/G:/2026github/deer-flow/backend/app/gateway/routers/thread_runs.py:496) 为什么先执行 [`start_run`](/G:/2026github/deer-flow/backend/app/gateway/services.py:609)，再返回 `StreamingResponse`？这如何将 HTTP/SSE 连接和实际 agent 执行解耦？
2. [`start_run`](/G:/2026github/deer-flow/backend/app/gateway/services.py:639) 为什么在创建 `RunRecord` 前校验 `model_name` 的配置 allowlist？它防御的风险是什么？
3. [`start_run`](/G:/2026github/deer-flow/backend/app/gateway/services.py:649) 已有路由 `owner_check=True` 时，为什么仍要在 service 层检查线程所有权？这对 stateless run 和内部调用意味着什么？
4. [`goal_thread_lock`](/G:/2026github/deer-flow/backend/app/gateway/services.py:675) 与 [`RunManager.create_or_reject`](/G:/2026github/deer-flow/backend/app/gateway/services.py:677) 分别解决哪一种并发问题？为什么一个前端防重入标记不足以替代它们？
5. [`inject_authenticated_user_context`](/G:/2026github/deer-flow/backend/app/gateway/services.py:315) 为什么必须在 `asyncio.create_task(run_agent(...))` 前将认证身份写入 run context？请区分认证/授权、用户隔离和运行记录三个职责。

## 学习者作答校正

### 题 5：为什么 Gateway 要在启动任务前把 authenticated user 写进 run context？

你的回答中“写入运行上下文”方向正确；这里的 `ZWTE` 应理解为 JWT 认证结果。需要修正后两点：

- JWT 的解析与认证发生在 [`AuthMiddleware.dispatch`](/G:/2026github/deer-flow/backend/app/gateway/auth_middleware.py:88)，成功后把用户写入 `request.state.user` 和请求期 ContextVar（[`auth_middleware.py`](/G:/2026github/deer-flow/backend/app/gateway/auth_middleware.py:148)）。线程 owner 权限在 [`start_run`](/G:/2026github/deer-flow/backend/app/gateway/services.py:649) 的后台任务创建前完成检查；它不是依赖 LLM 调用时再判断。
- 运行执行情况由 `RunRecord`、`RunManager` 和事件/持久化存储负责，而不是 authenticated user context 的核心职责；[`RunManager.create_or_reject`](/G:/2026github/deer-flow/backend/app/gateway/services.py:675) 创建 run，随后 [`start_run`](/G:/2026github/deer-flow/backend/app/gateway/services.py:747) 保存后台 task。

可存入学习档案的版本：

> Gateway 在创建后台 `run_agent` 任务前，将已经认证的用户身份写入 `config["context"]`。HTTP 请求返回后，请求级 ContextVar 不应作为后台工具的唯一身份来源；工具和 middleware 仍需知道当前用户，才能把文件、记忆、线程数据等操作限制在正确的用户作用域。认证和线程 owner 授权在任务启动前完成，run 的执行记录则由 `RunRecord`、`RunManager` 和事件存储负责。该设计同时避免客户端伪造 `user_id`、`is_internal` 等服务端拥有的授权字段。

## 下一单元

从 [`worker.py::run_agent`](/G:/2026github/deer-flow/backend/packages/harness/deerflow/runtime/runs/worker.py:242) 开始：追踪状态转换、agent 构建、checkpoint 配置、流发布、取消和终态清理。
