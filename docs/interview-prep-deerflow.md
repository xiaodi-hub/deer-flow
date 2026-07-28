# DeerFlow 面试背诵文档

这份文档按候选人口吻整理，适合用来讲“业务理解、项目架构、问题解决能力、数据指标和稳定性治理”。涉及真实线上数值的地方用 `[替换为真实数据]` 标注，面试时不要硬编；仓库级事实指标来自当前本地代码阅读。

## 30 秒项目介绍

DeerFlow 是一个基于 LangGraph 的 AI Super Agent 工作台。它不是单纯的 ChatBot，而是把多轮对话、场景化 Agent、工具调用、MCP 扩展、技能系统、沙箱文件系统、长期记忆、子任务并发和定时任务整合到一个完整产品里。

用户入口是 Agent Gallery。用户可以选择或创建某个场景 Agent，比如金融分析、AI 新闻、学习助手，然后在这个 Agent 下创建多个会话。每个 Agent 可以配置自己的模型、工具组、MCP allowlist、技能 allowlist、SOUL.md、记忆策略和工作区策略，但底层仍复用同一个 `lead_agent` 运行时，避免每个场景重复造执行链路。

我讲这个项目时会强调三点：第一，它解决的是“AI 能不能真正完成任务”的问题，而不是只生成文本；第二，它在工程上解决了流式运行、并发任务、上下文压缩、工具安全和状态一致性；第三，它把 token、运行状态、子任务进度、workspace diff 等指标沉淀下来，方便做质量、成本和稳定性治理。

## 1 分钟背诵版

我参与的 DeerFlow 可以理解成一个可扩展的 AI Agent 平台。它的产品目标是把“问答式 AI”升级成“能执行复杂任务的工作台”：用户可以选一个场景 Agent，上传文件，发起任务，Agent 可以调用工具、读写工作区文件、生成报告或代码，也可以把复杂任务拆给多个子 Agent 并行执行。

架构上是一个 monorepo，主要分四层：Nginx 作为统一入口，端口是 2026；Gateway API 是 FastAPI，端口是 8001，同时内嵌 LangGraph-compatible 运行时；前端是 Next.js 16 + React 19，端口是 3000；Provisioner 是可选沙箱服务，端口是 8002。后端又拆成 `app` 和 `harness` 两层，`app` 负责 Gateway、鉴权、IM channel 和 HTTP API，`harness` 是可复用的 Agent 框架，里面包含 agent runtime、middleware、tools、sandbox、MCP、skills、memory、subagents、tracing 等能力。这个边界用测试保证，`harness` 不能反向依赖 `app`。

我认为这个项目最难的不是接模型，而是把长任务做稳定。一个 Agent run 里会有流式输出、工具调用、文件变更、子任务事件、token 统计和 checkpoint 写入，任何一个环节失败都会造成 UI 卡住、消息重复、历史错乱或成本不可控。所以后端有 RunManager 管 run 生命周期、并发策略、取消和 lease；worker 负责 LangGraph 流式执行、事件发布、checkpoint、workspace diff 和 token 汇总；StreamBridge 用 memory 或 Redis Streams 做 SSE 事件分发，支持 `Last-Event-ID` 断线重连。前端用 TanStack Query 和 LangGraph SDK 消费 `values`、`messages-tuple`、`custom` 三类流事件，把历史、实时流和 optimistic message 合并。

如果面试官问业务价值，我会说：Agent Gallery 降低了用户从空白输入开始配置 Agent 的成本；子任务和沙箱提高复杂任务成功率；定时任务把一次性交互变成持续自动化；token 和运行指标让平台能按成功率、延迟、成本、错误率去优化，而不是凭感觉调 prompt。

## 项目真实规模指标

这些是当前仓库阅读得到的事实，适合在面试里当“项目复杂度”背景，不要说成线上业务数据。

| 指标 | 当前仓库情况 |
| --- | --- |
| 工程文件规模 | 约 1784 个源码/文档文件，本地粗略统计约 34 万行工程文件 |
| 后端规模 | 约 891 个后端文件，Python 代码约 20 万行 |
| 前端规模 | `frontend/src + frontend/tests` 约 533 个文件，TS/TSX 约 6.2 万行 |
| Gateway API | 22 个 router 文件，约 120 个 HTTP endpoint decorator |
| Agent 中间件 | 38 个 middleware Python 文件 |
| 测试覆盖 | 404 个后端测试文件，98 个前端测试文件；`rg` 匹配到约 4453 个 test 函数/测试类声明 |
| 技能系统 | `skills/public` 下 24 个顶层技能包，约 30 个 `SKILL.md` |
| 服务拓扑 | Nginx 2026、Gateway 8001、Frontend 3000、可选 Provisioner 8002 |
| 技术栈 | Python 3.12、FastAPI、LangGraph、LangChain、SQLAlchemy/Alembic、SQLite/Postgres、Redis Streams、Next.js 16、React 19、TypeScript、TanStack Query |

## 业务理解怎么讲

### 用户痛点

传统聊天式 AI 有三个明显问题：

1. 用户每次都要从空白输入开始组织 prompt，场景沉淀弱。
2. 复杂任务中间步骤多，单 Agent 容易上下文爆炸、工具循环、结果不可复现。
3. 任务结果通常只停留在对话文本里，不能自然产出文件、报告、代码、幻灯片或可追踪的运行记录。

DeerFlow 的产品设计是围绕这些痛点做的：

1. Agent Gallery 把常用场景产品化，每个 Agent 有独立的模型、工具、技能、记忆和工作区策略。
2. Lead Agent + Subagents 把复杂任务拆解并行处理，主 Agent 做规划和汇总，子 Agent 做局部探索。
3. Sandbox + workspace + artifacts 让 Agent 真正读写文件，输出可以落到工作区和产物目录。
4. Run events、token usage、workspace changes 和 feedback 让平台有可观测数据，用来迭代质量和成本。

### 北极星指标

如果让我为这个项目设计业务指标，我会选：

`有效任务完成率 = 满足用户目标的成功 run 数 / 用户发起 run 数`

原因是 DeerFlow 的核心价值不是聊天活跃，而是“把复杂任务做完”。这个指标可以结合 `/goal` 的自动评估、用户 feedback、产物生成和 run terminal status 一起判断。

### 指标体系

| 类别 | 指标 | 说明 |
| --- | --- | --- |
| 激活 | Gallery 访问到首个会话创建转化率 | 衡量 Agent Gallery 是否降低上手门槛 |
| 激活 | Agent 创建完成率 | 衡量自定义 Agent 配置流程是否顺畅 |
| 留存 | 周活 Agent 数、复用会话数 | 看用户是否真的把 Agent 当工作流使用 |
| 质量 | 任务成功率、goal satisfied rate | 衡量复杂任务完成能力 |
| 效率 | 平均任务耗时、P95 run duration、TTFT | 衡量等待体验 |
| 成本 | 单次成功任务 token、按模型 token 分布 | 控制 LLM 成本 |
| 稳定性 | run error rate、SSE reconnect success、cancel success | 衡量平台稳定性 |
| 工具效果 | 工具调用成功率、read/write 失败率、子任务完成率 | 定位 Agent 执行瓶颈 |
| 安全 | 被 guardrail/read-before-write 拦截次数 | 评估安全策略命中情况 |
| 产物 | artifact 生成率、workspace diff 查看率 | 衡量“从回答到交付物”的价值 |

## 架构怎么讲

### 总体架构

可以这样背：

DeerFlow 的入口是 Nginx，它把 `/api/langgraph/*` 代理到 Gateway 的 LangGraph-compatible runtime，把其他 `/api/*` 代理到 Gateway REST routers，非 API 请求转给 Next.js 前端。Gateway 不是单纯 API 层，它内嵌了 agent runtime，因此无论 Web、TUI、IM channel 还是 scheduled task，都复用同一套 run lifecycle。

后端有一个很重要的拆分：`backend/app` 是应用层，负责 FastAPI、鉴权、渠道、路由和服务编排；`backend/packages/harness/deerflow` 是 Agent 框架层，包含 lead agent、middleware、tools、sandbox、skills、MCP、memory、subagents、runtime 和 tracing。这个拆分的好处是 Agent harness 可以作为独立包复用，也避免框架层依赖具体应用层。

### 一次消息的链路

1. 前端在 chat page 里提交用户输入，支持文件、voice input、input polish、`/goal`、`/compact` 等入口。
2. `useThreadStream` 调用 LangGraph SDK，发起 thread run，指定 `streamMode = ["values", "messages-tuple", "custom"]`。
3. Gateway 创建 run record，RunManager 处理并发策略，例如 reject、interrupt、rollback，以及 run status。
4. worker 构建 LangGraph agent，注入 runtime context、checkpointer、store、tracing metadata、RunJournal。
5. `lead_agent` 解析运行时配置，选择模型，装配工具和 middleware。
6. Agent 执行过程中产生 AI token、tool calls、tool results、subagent events、workspace changes。
7. StreamBridge 发布 SSE 事件，前端实时消费并更新消息、todos、artifacts、subtask card、token usage。
8. run 结束后，后端持久化 completion、token、duration、workspace diff，并发布 end 事件。

## 核心模块背诵稿

### 1. Agent Gallery 和自定义 Agent

候选人口吻：

这个项目里我会把 Agent Gallery 当成一个产品化重点讲。早期 AI 工具很容易变成一个通用聊天框，用户每次都要重新描述角色、工具和输出格式。DeerFlow 把这些沉淀成自定义 Agent profile，每个 profile 包含 `config.yaml` 和 `SOUL.md`，可以定义展示信息、默认模型、工具组、MCP allowlist、技能 allowlist、记忆策略、工作区策略和 starter prompts。

技术上我关注两点。第一是隔离，custom agents 存在 `{base_dir}/users/{user_id}/agents/{agent_name}` 下，避免不同用户之间配置串掉；同时兼容旧的 shared layout，迁移前可读但新写入走 per-user layout。第二是配置不丢字段，更新接口只管理一部分字段，像 GitHub binding 这种手写配置要通过 `preserve_non_managed_fields` 保留下来，避免用户在 UI 改一个 description 就把高级配置抹掉。

可以强调的业务指标：

| 指标 | 价值 |
| --- | --- |
| Agent 创建完成率 | 衡量配置流程是否简单 |
| Gallery 到 chat 转化率 | 衡量场景化入口是否有效 |
| 每个 Agent 平均会话数 | 衡量 Agent 是否被复用 |
| Agent settings 保存成功率 | 衡量配置系统稳定性 |

### 2. 流式运行和历史一致性

候选人口吻：

这个项目的难点之一是流式对话不只是文本 token。一次 run 里会同时出现 full state values、message tuple、custom events、tool calls、subagent events 和 terminal status。只要有一步处理不好，就会出现 UI 重复消息、历史顺序错乱、停止后标题没保存、或者断线重连后丢事件。

后端的设计是用 RunManager 管 run 生命周期，用 StreamBridge 解耦 producer 和 SSE consumer。MemoryStreamBridge 适合单进程，RedisStreamBridge 用 Redis Streams 支持多 worker 和 `Last-Event-ID` replay。worker 通过 LangGraph 的 `astream` 读取流事件，转换成 SSE event，同时用 RunJournal 记录消息、token、生命周期和子任务事件。

前端不是简单 append，而是把三类消息合并：历史分页消息、当前 live stream state、optimistic messages。`mergeMessages` 和 transient history bridge 处理 summarization 造成的消息移动，避免用户看到上下文压缩时历史突然消失或乱序。

可背的指标：

| 指标 | 目标方向 |
| --- | --- |
| TTFT P50/P95 | 首 token 延迟越低越好 |
| SSE 断线恢复成功率 | reconnect 后不丢、不重、不乱 |
| 消息重复率 | merged message 去重是否有效 |
| run terminal event 到达率 | 避免前端一直 loading |
| stop/cancel 成功率 | 用户停止后状态要落库 |

### 3. 子 Agent 并发和复杂任务拆解

候选人口吻：

DeerFlow 的 lead agent 可以通过 `task` tool 创建 subagent。设计上我不会让子 Agent 的所有内部消息都塞回主对话，否则上下文会很快膨胀，而且主 Agent 会被局部细节干扰。子 Agent 有自己的上下文、工具和终止条件，结果以结构化状态回传给主 Agent。

工程上有几个关键控制点。第一是并发和总量限制，`SubagentLimitMiddleware` 可以限制每轮并发和每次 run 的总子任务数量，避免模型失控地派生任务。第二是 delegation ledger，ThreadState 里会记录最近的子任务状态，且 terminal status 不会被非终态覆盖。第三是可观测性，子任务的 `task_started`、`task_running`、`subagent.step`、`subagent.end` 会持久化，前端 subtask card 可以展示模型、token usage 和步骤 timeline。

可讲的优化点：

1. 子任务事件不是每条都独立写库，worker 有 buffer，达到 25 条或 terminal event 时批量 flush，减少深任务下的数据库锁竞争。
2. 前端对 late SSE frame 和历史 backfill 做 merge，避免子任务状态倒退或步骤被覆盖。
3. token usage 按 lead agent、subagent、middleware 分桶，便于分析复杂任务成本。

指标：

| 指标 | 说明 |
| --- | --- |
| 子任务平均并发数 | 衡量拆解策略 |
| 子任务成功率 | 定位失败是否集中在某些工具/模型 |
| 子任务 token 占比 | 评估复杂任务成本结构 |
| 深任务完成耗时 | 衡量并行是否真正缩短时间 |
| 子任务步骤持久化完整率 | 刷新页面后是否能复原 timeline |

### 4. 沙箱、文件和产物

候选人口吻：

DeerFlow 的差异点是 Agent 有一个实际工作区。每个 thread 会有 isolated `uploads`、`workspace`、`outputs` 目录，工具可以读写文件，最后产出 artifacts。这样用户不是只拿到一段回答，而是拿到报告、代码、图片、PPT 或网页等交付物。

这里的主要问题是安全和一致性。比如本地沙箱不是强隔离，所以 host bash 默认关闭；写文件前有 ReadBeforeWriteMiddleware，要求模型先读到当前文件 hash，再写入或替换，降低 stale write 覆盖用户改动的风险。上传文件时会先写 `.part` 临时文件，校验后原子替换，避免上传中断留下半文件。对于大文件上传，Nginx 对 upload location 配了 100M，对长文本 prompt 配了 20M。

workspace changes 是另一个体验点。每个 run 前后会 capture workspace snapshot，结束后计算 created、modified、deleted 和 text diff，前端显示“文件变化”入口。这样用户能看到 Agent 到底改了什么，而不是只能相信最终回答。

指标：

| 指标 | 说明 |
| --- | --- |
| 文件上传成功率 | 判断 upload pipeline 是否稳定 |
| artifact 生成率 | 衡量任务是否产出实际交付物 |
| workspace diff 查看率 | 衡量用户是否依赖文件变更说明 |
| write gate 拦截次数 | 衡量 stale write 风险 |
| sandbox 执行失败率 | 定位环境、权限、超时问题 |

### 5. 上下文压缩和长期记忆

候选人口吻：

长任务里上下文管理非常关键。DeerFlow 有两类机制：一类是当前会话内的 summarization，会在接近 token 限制时把早期上下文压缩成 `summary_text`，未来模型调用用 summary 加最近消息；另一类是长期 memory，把用户偏好、背景和稳定事实写入记忆，跨会话注入。

自定义 Agent 还支持 memory policy。比如某些稳定用户偏好可以写到 global memory，某个 Agent 的领域知识可以写到 agent memory。这样可以避免所有 Agent 共用一坨记忆，也避免每个 Agent 都忘掉用户基本偏好。

指标：

| 指标 | 说明 |
| --- | --- |
| summarization 触发率 | 判断上下文压力 |
| 压缩后 run 成功率 | 判断压缩是否损伤任务质量 |
| 平均 prompt token | 衡量成本控制 |
| memory 命中率 | 看长期记忆是否真正被用上 |
| 用户重复提供偏好次数 | 越低说明记忆价值越高 |

### 6. 定时任务

候选人口吻：

Scheduled Tasks 把 DeerFlow 从一个交互式 Agent 扩展成后台自动化系统。用户可以在 `/workspace/scheduled-tasks` 创建 once 或 cron 任务，选择每次新开 thread，或者复用某个 thread。后台 scheduler 按配置轮询 due tasks，然后通过正常 run lifecycle 启动任务，而不是另起一套执行系统。

这里最核心的是非交互和并发控制。定时任务不能中途问用户，所以内部调用时会标记 non-interactive，lead agent 不暴露 `ask_clarification`。并发上有 `max_concurrent_runs`，每次 poll 会先看当前 active scheduled runs，再按剩余 budget claim due tasks。重叠策略默认 skip，避免同一个定时任务上一次没跑完又启动下一次。

指标：

| 指标 | 说明 |
| --- | --- |
| due task 准时触发率 | 调度可靠性 |
| scheduled run 成功率 | 后台任务质量 |
| skip rate | 任务耗时是否超过周期 |
| stale active runs 数 | 重启恢复能力 |
| manual trigger conflict 率 | 用户是否频繁撞到运行中任务 |

### 7. 成本和 token 可观测

候选人口吻：

AI Agent 平台必须有成本视角。DeerFlow 的 RunJournal 会记录 LLM usage，并在 run completion 里落库，包括 input tokens、output tokens、total tokens、llm_call_count、lead_agent_tokens、subagent_tokens、middleware_tokens，以及按 model 的 token breakdown。前端也有 thread token usage 查询，用来在会话维度展示累计消耗。

有了这些数据后，优化不再只是换 prompt，而是可以按场景分析：某些 Agent 是 subagent token 过高，说明任务拆得太散；某些 run 是 middleware token 高，说明总结、标题、goal evaluation 太频繁；某些模型单次成功任务成本高，但成功率也高，就可以做性价比决策。

核心指标：

| 指标 | 公式 |
| --- | --- |
| 单次成功任务成本 | 成功 run 总 token / 成功 run 数 |
| 子任务成本占比 | subagent_tokens / total_tokens |
| 模型成本分布 | by_model.total_tokens |
| LLM 调用次数 | llm_call_count |
| 成本质量比 | task_success_rate / avg_total_tokens |

### 8. 安全和治理

候选人口吻：

这个项目有比较高权限的能力，包括 bash、文件写入、上传文件解析、MCP 远程工具和 IM/GitHub 入口，所以安全治理是架构的一部分。主要做了几类防护。

第一是用户和线程隔离。thread data、uploads、outputs、agent config 都按 user/thread 或 user/agent 分目录。第二是工具输出和输入清洗，InputSanitizationMiddleware 和 ToolResultSanitizationMiddleware 会防止远程网页内容伪造 system/context 标签。第三是文件写入安全，read-before-write 用 hash 标记避免 stale write。第四是鉴权和 CSRF，Gateway 有 JWT、token_version、CSRF double submit、origin 检查和内部 auth header。第五是部署安全，默认建议本地可信网络，Nginx 不默认打开跨域。

面试时可以强调：AI Agent 的安全不是一个独立网关能解决的，因为 prompt injection、tool output injection、文件写入和沙箱逃逸都发生在运行链路内部，所以需要 middleware、sandbox、auth、config 和 deployment 一起治理。

## STAR 案例

### 案例 1：从通用聊天升级为场景化 Agent Gallery

S：原来的通用聊天入口对普通用户不友好。用户要手写角色、工具、输出约束，配置不可复用。

T：需要把场景能力沉淀成可复用 Agent，同时不复制多套 runtime。

A：设计 custom agent profile，包含 gallery metadata、SOUL.md、模型、工具组、MCP、技能、记忆策略和工作区策略。前端做 Agent Gallery、new agent、settings 页面；后端提供 `/api/agents` CRUD，并让 `assistant_id=<agent-name>` 注入到同一套 `lead_agent` factory。

R：用户从“空白输入”变成“选择场景后直接开始任务”，平台也能按 Agent 维度统计活跃、成功率、成本和配置使用情况。可替换真实数据：Agent 创建完成率 `[x%]`，Gallery 到首会话转化率 `[x%]`，平均配置时间从 `[x]` 降到 `[y]`。

### 案例 2：解决流式会话历史错乱

S：AI run 是长任务，前端同时收到 live stream、history page、optimistic message 和 summarization update，容易出现重复消息、顺序错乱或压缩后历史闪烁。

T：需要保证用户刷新、断线、压缩上下文、停止 run 后，看到的消息顺序一致且不丢。

A：后端把 run events 按 thread/run/seq 持久化，StreamBridge 支持 `Last-Event-ID` replay；前端通过 message identity 去重，把 history、live 和 optimistic 三层合并；对 summarization 的 RemoveMessage 做 transient history bridge，等 run journal 落库后再自然收敛到 canonical history。

R：用户体验上不会因为压缩或重连丢历史。可替换指标：消息重复率降到 `[x%]`，SSE reconnect 成功率 `[x%]`，P95 首 token `[x]s`。

### 案例 3：子任务步骤持久化和 UI 可观测

S：子 Agent 能提高复杂任务能力，但如果只给最终结果，用户不知道子任务在做什么，刷新后进度也容易丢。

T：需要让子任务可观测、可恢复，同时不能因为深任务频繁写事件拖垮数据库。

A：后端把子任务事件分为 started、running、step、end，worker 对 step events 做 buffer，达到 25 条或 terminal event 再 batch flush。前端 subtask card live 展示状态、模型、token usage，展开时可从 `/runs/{runId}/events` backfill 详细步骤。

R：复杂任务从黑盒变成可解释执行过程。可替换指标：子任务步骤恢复完整率 `[x%]`，深任务数据库写入次数减少 `[x%]`，复杂任务成功率提升 `[x%]`。

### 案例 4：文件上传和工作区变更安全

S：Agent 需要读用户上传文件并生成产物，但上传中断、重复文件名、半文件、危险 artifact inline 渲染都会带来风险。

T：保证上传原子性、目录隔离、产物可追踪，同时降低安全风险。

A：上传文件先写 staged `.part` 文件，完成校验后原子替换；重复文件名自动加后缀；上传目录按 user/thread 隔离；workspace changes 在 run 前后做 snapshot 并生成 diff；对 HTML/SVG 等活跃内容强制 attachment 下载，减少 XSS 风险。

R：用户能可靠上传、看到 Agent 改了哪些文件，也减少了文件安全风险。可替换指标：上传成功率 `[x%]`，artifact 生成率 `[x%]`，文件 diff 查看率 `[x%]`。

### 案例 5：定时任务从交互扩展到后台自动化

S：很多 Agent 任务不是一次性问答，比如每日新闻、定期代码检查、周期性报告。

T：需要支持后台定时执行，同时复用现有 run lifecycle，并且不能在后台运行中要求用户澄清。

A：新增 scheduled task repository、run repository、scheduler service 和 `/workspace/scheduled-tasks` 页面。支持 once/cron、fresh thread/reuse thread、pause/resume/trigger/delete。调度时先按 active run 计算 budget，再 claim due tasks；non-interactive run 不暴露 `ask_clarification`；overlap_policy 默认 skip。

R：DeerFlow 从聊天工具扩展成自动化执行平台。可替换指标：定时任务准时触发率 `[x%]`，scheduled run 成功率 `[x%]`，overlap skip rate `[x%]`。

## 面试官常见追问

### 你在这个项目里最核心的技术难点是什么？

最核心的是长任务运行时的一致性。因为一个 run 不只是模型返回文本，它同时涉及流式输出、工具调用、子任务、文件系统、checkpoint、事件持久化、token 统计和取消恢复。我的思路是把 run lifecycle 独立出来，用 RunManager 管状态和并发，用 StreamBridge 管事件分发，用 RunJournal 管可观测数据，用 middleware 管工具安全和上下文，再让前端按 canonical identity 合并历史和实时流。

### 为什么不每个 Agent 都独立一套 runtime？

因为 Agent 的差异主要在配置和上下文，不在执行引擎。如果每个场景都复制一套 runtime，工具、安全、记忆、checkpoint、streaming、成本统计都会重复实现，后期很难治理。DeerFlow 的做法是 profile 驱动，一个 `lead_agent` runtime，根据 `agent_name` 注入模型、工具 allowlist、技能、SOUL.md、memory 和 workspace policy。这样既能产品化场景，又能统一治理。

### 怎么衡量 Agent 是否真的有用？

我不会只看 DAU 或消息数。Agent 平台最重要的是任务完成。核心指标是有效任务完成率，辅以用户 feedback、goal satisfied rate、artifact 生成率、workspace diff、run success rate、平均耗时和 token 成本。比如一个 Agent 消息很多但成功率低、artifact 少、token 很高，说明它可能只是在聊天，不是在交付。

### 如何控制 LLM 成本？

第一，记录 token usage，按 lead agent、subagent、middleware、model 拆分。第二，通过 summarization 和 manual `/compact` 控制上下文长度。第三，限制 subagent 并发和总数，避免任务无限拆分。第四，通过 token budget、loop detection、tool progress 防止工具循环。第五，按场景选择模型，不是所有 Agent 都用最高成本模型。

### 如果 SSE 断了怎么办？

StreamBridge 的事件有单调 event id，客户端重连时带 `Last-Event-ID`，后端从 retained buffer 或 Redis Stream 继续 replay。Memory bridge 适合单进程，Redis bridge 支持跨 worker。前端还会 refetch history 和 thread state，把 realtime stream 和 canonical history 对齐，避免只依赖临时连接状态。

### 怎么处理多用户隔离？

用户身份通过 Gateway 鉴权和 runtime user context 传递。线程数据目录、上传目录、Agent profile、memory 等都按 user/thread 或 user/agent 分桶。HTTP route 会检查 owner 权限；内部调用即使持有 internal token，也不能绕过跨用户线程访问约束。Agent config 也优先读取 per-user layout，legacy shared layout 只是兼容读取。

### 为什么需要 ReadBeforeWrite？

AI 工具写文件有一个典型风险：模型基于旧上下文直接覆盖文件，而用户或另一个工具已经改过文件。ReadBeforeWrite 要求模型写已有文件前先读文件，读工具会把当前 hash 写进 ToolMessage；写工具检查最新 mark 是否匹配当前文件 hash，不匹配就拒绝。这是一种轻量的乐观并发控制。

### 定时任务为什么要复用正常 run lifecycle？

因为 run lifecycle 已经包含鉴权上下文、checkpoint、stream events、token 统计、workspace changes、goal 状态、取消和失败处理。如果 scheduler 另起执行链路，短期看快，长期会产生两套状态和两套 bug。复用 run lifecycle 可以保证后台任务和用户手动任务的行为一致。

### 这个项目怎么做测试？

后端测试非常重，当前有 400 多个后端测试文件，覆盖 Gateway routers、runtime、client conformance、blocking IO、scheduler、sandbox、tracing、custom agent 等。特别是 blocking IO gate 会用 Blockbuster 检测 async 路径里的阻塞 IO，避免 Gateway event loop 被文件系统或同步客户端卡住。前端有 unit tests 和 Playwright E2E，重点覆盖线程流式、history merge、agents、scheduled tasks、subtask cards 等。

## 简历写法

可以按你真实负责范围挑 3 到 5 条：

1. 参与 DeerFlow 2.x AI Super Agent 平台建设，基于 FastAPI + LangGraph + Next.js 实现多 Agent 会话、工具调用、沙箱文件系统、长期记忆、MCP/Skills 扩展和流式输出。
2. 设计并落地 Agent Gallery / Custom Agent 配置体系，支持模型、工具组、MCP allowlist、技能 allowlist、SOUL.md、记忆策略和工作区策略，统一复用 `lead_agent` runtime。
3. 优化长任务 streaming 和 history merge 链路，基于 RunManager、StreamBridge、RunJournal、checkpoint 和前端 message identity 合并，解决断线重连、上下文压缩、消息去重和停止恢复问题。
4. 建设子 Agent 并发执行和可观测能力，支持子任务状态、步骤 timeline、模型和 token usage 展示，并通过批量事件持久化降低深任务写入压力。
5. 完善沙箱文件和上传安全，支持 per-thread workspace、staged upload、ReadBeforeWrite、workspace diff 和 artifact 安全下载，提升 Agent 产物可追踪性和执行安全。
6. 建设 scheduled task MVP，支持 once/cron、reuse/fresh thread、pause/resume/manual trigger、overlap skip 和 non-interactive run，使 Agent 从交互式任务扩展到后台自动化。
7. 建立 token 和 run 级可观测指标，按 lead/subagent/middleware/model 统计 token usage，为任务成功率、成本、延迟和模型选型优化提供数据基础。

## 重点代码路径

| 主题 | 路径 |
| --- | --- |
| Lead Agent | `backend/packages/harness/deerflow/agents/lead_agent/agent.py` |
| ThreadState reducer | `backend/packages/harness/deerflow/agents/thread_state.py` |
| Middleware | `backend/packages/harness/deerflow/agents/middlewares/` |
| 工具装配 | `backend/packages/harness/deerflow/tools/tools.py` |
| 子任务工具 | `backend/packages/harness/deerflow/tools/builtins/task_tool.py` |
| RunManager | `backend/packages/harness/deerflow/runtime/runs/manager.py` |
| Run worker | `backend/packages/harness/deerflow/runtime/runs/worker.py` |
| StreamBridge | `backend/packages/harness/deerflow/runtime/stream_bridge/` |
| Run events | `backend/packages/harness/deerflow/runtime/events/store/` |
| 自定义 Agent 配置 | `backend/packages/harness/deerflow/config/agents_config.py` |
| Agent API | `backend/app/gateway/routers/agents.py` |
| Scheduled tasks | `backend/app/scheduler/service.py`, `backend/app/gateway/routers/scheduled_tasks.py` |
| 前端线程流式 | `frontend/src/core/threads/hooks.ts` |
| 前端 Agent API | `frontend/src/core/agents/api.ts`, `frontend/src/core/agents/types.ts` |
| Agent settings 页面 | `frontend/src/app/workspace/agents/[agent_name]/settings/page.tsx` |
| 子任务 UI | `frontend/src/core/tasks/`, `frontend/src/components/workspace/messages/subtask-card.tsx` |

## 最后背诵口诀

面试时可以按这个顺序讲，避免散：

1. 先讲业务：从聊天框升级为能交付复杂任务的 Agent 工作台。
2. 再讲架构：Nginx + Gateway runtime + Next.js + optional Provisioner，后端 app/harness 分层。
3. 再讲链路：前端提交、Gateway 创建 run、lead_agent 装配模型工具中间件、StreamBridge 流式返回、RunJournal 落数据。
4. 再讲难点：流式一致性、子任务并发、文件安全、上下文压缩、定时任务非交互、token 成本。
5. 最后讲指标：有效任务完成率、TTFT、run success、SSE reconnect、token per success、artifact rate、scheduled on-time rate。
