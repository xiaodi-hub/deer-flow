# DeerFlow 的 LangGraph 状态与运行时复习笔记（p02）

> 学习目标：把 LangGraph 看成 DeerFlow 的**状态协调协议和执行底座**，而不是一个“调用 LLM 的循环”。本篇按字幕讲解的推进顺序整理；代码事实以当前仓库为准，字幕中的 `land graph`、`line graph` 等识别错误统一为 **LangGraph**。
## 📖 目录

- [一、先建立问题意识：为什么 Agent 不能只靠 while 循环](#一先建立问题意识为什么-agent-不能只靠-while-循环)
- [二、状态不是普通上下文：它是图的共享数据契约](#二状态不是普通上下文它是图的共享数据契约)
- [三、Reducer 是状态字段的业务语义，不是并发补丁](#三reducer-是状态字段的业务语义不是并发补丁)
- [四、Agent 图如何运转：模型决策、工具执行与工厂创建](#四agent-图如何运转模型决策工具执行与工厂创建)
- [五、Checkpointer：线程连续性与恢复的基础设施](#五checkpointer线程连续性与恢复的基础设施)
- [六、把状态演变和人工澄清放在一起理解](#六把状态演变和人工澄清放在一起理解)
- [七、当前 Gateway 如何流式运行，而非"LangGraph Server 套一层"](#七当前-gateway-如何流式运行而非langgraph-server-套一层)
- [八、复习地图：从状态定义走到一次实际运行](#八复习地图从状态定义走到一次实际运行)

---
## 一、先建立问题意识：为什么 Agent 不能只靠 `while` 循环

**对应字幕：1-43**

一次模型调用本身不会替应用保存对话、工具结果或任务进度。一个能持续工作的 Agent 至少要协调四件事：

1. **状态**：多轮消息、工具结果、产物、待办、子智能体进度等不能只存在某个函数局部变量里。
2. **执行**：模型可以回答，也可以要求执行工具；工具结果回来后还要继续推理。
3. **更新语义**：多个步骤写同一份状态时，必须明确是覆盖、追加、去重，还是报冲突。
4. **服务运行时**：HTTP 请求、SSE 客户端和后台 Agent 的生命周期不同，需要持久化、流桥接和运行记录来协调。

LangGraph 提供的是图、状态通道、检查点等通用机制；DeerFlow 再把它接到 Gateway 的 `RunManager`、`StreamBridge`、持久化和线程 API 上。换句话说，图解决"如何执行与更新"，Gateway 解决"如何作为服务稳定运行"。运行时的装配入口在 [langgraph_runtime](../../backend/app/gateway/deps.py#L249)，后台执行入口在 [run_agent](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L242)。

```text
用户请求 / 续接输入
        |
        v
Gateway 创建 RunRecord ──> 后台 run_agent
                                |
                                v
                    LangGraph Agent 图（状态 + 工具循环）
                     |                  |
             Checkpointer           StreamBridge -> SSE
```

**要记住的判断题**：手写循环并非不能实现工具调用；真正昂贵的是后来补上的并发更新、断线恢复、线程隔离、事件流、取消与持久化边界。

## 二、状态不是普通上下文：它是图的共享数据契约

**对应字幕：44-120**

可以用四个概念读 LangGraph：

| 概念 | 在 DeerFlow 中的含义 | 复习时的问题 |
| --- | --- | --- |
| State | 当前线程可被图读取和更新的通道集合 | 这个字段应该覆盖还是累积？ |
| Node | 一次可观察的执行步骤 | 它只返回哪些局部更新？ |
| Edge / 路由 | 根据步骤结果继续、调用工具或结束 | 谁决定下一步，模型还是系统策略？ |
| Checkpointer | 按 `thread_id` 保存、读取图执行状态 | 重启或下一轮请求从哪里继续？ |

DeerFlow 的具体状态类型是 [ThreadState](../../backend/packages/harness/deerflow/agents/thread_state.py#L239)，它继承 LangChain 的 `AgentState`，因此已有 `messages` 消息通道；项目字段再补充沙箱、产物、待办、目标、图片、任务委派等业务状态。模型不会"天然记住"上一轮，而是每次图运行从状态中的消息和其他通道获得上下文。

不要把字幕里的"节点就是一个手写 Python 函数、边就是本项目的 `add_edge`"当成当前实现。DeerFlow 的主 Agent 使用 LangChain 的 `create_agent(...)` 生成 Agent/工具循环，项目传入模型、工具、中间件、系统提示词和 `ThreadState`；图内部的节点与条件路由主要由上游库构造。见 [_make_lead_agent](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L450) 和 [create_agent(..., state_schema=ThreadState)](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L636)。

**容易混淆**：`StateGraph` 是 LangGraph 的通用建图 API，不等于仓库里一定有一段手写的“添加节点、添加边、compile”代码。这里的业务重点是状态 schema 和 Middleware，图骨架交给 `create_agent`。

## 三、Reducer 是状态字段的业务语义，不是并发补丁

**对应字幕：121-233**

`ThreadState` 用 `TypedDict` 形式声明状态键，并用 `Annotated[类型, reducer]` 为需要特殊合并的通道声明规则。它带来可读的字段契约和类型检查，但**不会自动完成数据库 schema 迁移**；检查点如何序列化、旧数据如何兼容，仍由 LangGraph Saver 与应用升级策略共同决定。

最重要的设计问题不是"会不会并发"，而是：**两份更新同时到达时，业务希望最终值是什么？** 当前源码给出了很好的范例：

| 字段 | 规则 | 为什么这样设计 |
| --- | --- | --- |
| `artifacts` | 合并并按首次出现顺序去重 | 多个工具或子任务产出的文件都应保留。见 [merge_artifacts](../../backend/packages/harness/deerflow/agents/thread_state.py#L58)。 |
| `viewed_images` | 字典合并；传入 `{}` 明确清空 | 区分"没有更新"与"要求清空"。见 [merge_viewed_images](../../backend/packages/harness/deerflow/agents/thread_state.py#L68)。 |
| `sandbox` | 同一 `sandbox_id` 可幂等写入；不同 ID 直接失败 | 线程隔离错误不能靠"最后一次写入"掩盖。见 [merge_sandbox](../../backend/packages/harness/deerflow/agents/thread_state.py#L34)。 |
| `todos`、`goal` | 新值非 `None` 时覆盖；`None` 表示未触碰 | 空列表可以是有意更新，不能被误当成无更新。见 [merge_todos](../../backend/packages/harness/deerflow/agents/thread_state.py#L85) 与 [merge_goal](../../backend/packages/harness/deerflow/agents/thread_state.py#L98)。 |
| `delegations` | 按任务 ID 合并，终态不被非终态覆盖，并限制账本长度 | 子智能体状态要单调、可恢复。见 [merge_delegations](../../backend/packages/harness/deerflow/agents/thread_state.py#L151)。 |

`messages` 不在 `ThreadState` 中重新声明，而是来自父类 `AgentState` 的 `add_messages` 通道。复习时把它理解为"追加新消息，并可依消息 ID 更新已有消息"，而非简单的 Python `list.extend`。这解释了为什么流式/重试场景不能靠原地 `append` 改共享状态：节点和工具应返回局部更新（或 `Command(update=...)`），让图按 channel 规则吸收。

**一句话复盘**：Reducer 不是"把数据拼起来"的通用技巧，而是每个状态键的写入合同。需要保留全部结果就合并；只允许一个值就覆盖；不允许冲突就显式报错。

## 四、Agent 图如何运转：模型决策、工具执行与工厂创建

**对应字幕：234-317**

把一次 Agent 回合抽象成下面的循环即可：

```text
messages / state
      |
      v
模型推理 ── 无工具调用 ──> 最终答复 / 收尾 ──> END
   |
   └── 有合法工具调用 ──> 工具执行 ──> ToolMessage / Command 更新状态 ──> 回到模型
```

模型提出工具意图，图再依据工具定义、中间件、安全策略和运行限制调度执行；模型并不因此拥有任意执行权限。`get_available_tools(...)` 组装工具集，`create_agent(...)` 将模型、工具、中间件和状态 schema 组合为可执行图，相关调用位于 [lead_agent/agent.py](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L636)。

字幕将"编译一次、所有请求复用一个 graph"说得过满。当前 DeerFlow 的 `make_lead_agent(config)` 是一个**工厂函数**，Gateway 在每次运行中把本次 `RunnableConfig` 交给工厂，以解析模型、思考模式、智能体配置、工具和中间件；随后得到本次运行使用的图。见 [make_lead_agent](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L443)、[run_agent 创建 Agent](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L389)。`create_agent` 内部的图构造/编译是上游实现细节，因此不应从本仓库断言它"预计算全部执行路径"。

**容易混淆**：条件路由的基础确实是"是否有工具调用"，但不是字幕中的 `should_continue` 函数在 DeerFlow 业务代码里手写检查 `tool_calls`。当前项目使用上游 Agent 图；项目把控制重点放在工具集和 Middleware 的策略上。

## 五、Checkpointer：线程连续性与恢复的基础设施

**对应字幕：318-366**

Checkpointer 的价值不只是"把一份 state 存进数据库"：它让同一 `thread_id` 的后续运行能读取既有状态，也为中断、回放、分支、重试等能力提供状态锚点。Gateway 强制将 URL 中的 `thread_id` 写进 `configurable`，因为检查点以它划分状态空间，见 [build_run_config](../../backend/app/gateway/services.py#L433)。后台 worker 在运行前读取同一线程的最新检查点，并将 checkpointer 附到 Agent，见 [run_agent 的快照和注入逻辑](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L313)。

当前项目**不是固定使用 `AsyncSqliteSaver`**：`make_checkpointer()` 按配置选择 `InMemorySaver`、`AsyncSqliteSaver` 或 `AsyncPostgresSaver`；未配置时默认内存 Saver。见 [async_provider.py](../../backend/packages/harness/deerflow/runtime/checkpointer/async_provider.py#L80) 与 [make_checkpointer](../../backend/packages/harness/deerflow/runtime/checkpointer/async_provider.py#L147)。示例配置的默认数据库是单机 SQLite，而生产多节点部署应使用 PostgreSQL，见 [config.example.yaml](../../config.example.yaml#L1592)。

因此应这样理解部署结论：

- 使用内存后端，进程重启后线程状态会消失。
- 使用 SQLite，持久化文件必须落在可持久化目录；它适合单节点模式。
- Gateway 在多 worker 场景显式拒绝 SQLite，避免多进程写锁问题，见 [_enforce_postgres_for_multi_worker 调用点](../../backend/app/gateway/deps.py#L255)。
- "崩溃只损失最后一步"不是无条件保证，实际恢复点取决于最后成功写入的检查点和运行中外部副作用是否可重试。

## 六、把状态演变和人工澄清放在一起理解

**对应字幕：367-422**

一次典型任务会沿着 `messages` 通道累积：用户消息 -> 带工具调用的 AI 消息 -> 工具消息 -> 下一次 AI 消息；当工具生成可呈现文件时，`artifacts` 则由自己的 reducer 累积路径。标题并非图的天然字段，而是 `TitleMiddleware` 对状态的业务写入。所有字段及 reducer 定义集中在 [ThreadState](../../backend/packages/harness/deerflow/agents/thread_state.py#L239)。

`Command` 是"更新状态并改变控制流"的载体，适合工具或节点必须直接表达下一步的情形。当前的 `ClarificationMiddleware` 拦截 `ask_clarification`：它构造带结构化 `human_input` artifact 的 `ToolMessage`，然后返回 `Command(update={"messages": [...]}, goto=END)`。见 [_handle_clarification](../../backend/packages/harness/deerflow/agents/middlewares/clarification_middleware.py#L185)。这不是普通工具得到结果后再回模型的路径，而是把图本轮停在可等待人类输入的状态。

字幕"澄清中间件最后一个，所以后面的中间件永远不执行"的表述应修正为：**源码明确要求它在中间件列表最后注册**，目的是在模型调用之后拦截澄清工具请求，并避免打断本应先完成的处理中间件。见 [build_middlewares 的顺序说明](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L398)。恢复时，Gateway 支持将 `Command(resume=...)` 作为图输入；它不是靠某个全局内存变量继续执行。见 [start_run 的 resume 分支](../../backend/app/gateway/services.py#L724)。

**容易混淆**：非交互渠道会设置 `disable_clarification`。此时中间件返回普通 `ToolMessage` 让 Agent 依据假设继续，而不是结束图，见 [_handle_disabled_clarification](../../backend/packages/harness/deerflow/agents/middlewares/clarification_middleware.py#L143)。

## 七、当前 Gateway 如何流式运行，而非"LangGraph Server 套一层"

**对应字幕：423-500**

字幕所说的 `langgraph.json`、独立 LangGraph Server、`langgraph dev` 和其 REST 端点属于另一种部署形态，并不是当前 DeerFlow 的主服务路径。现在由 FastAPI Gateway 内嵌运行时：启动时创建 `StreamBridge`、Checkpointer、Store、RunManager；请求创建 run，后台 `run_agent` 调用 `agent.astream(...)`，再把事件发布给 SSE 消费者。装配代码见 [Gateway lifespan](../../backend/app/gateway/deps.py#L249)，流循环见 [run_agent 的 astream](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L440)。

流模式应按当前实现理解：

| 模式 | 含义 | 在 Gateway 中的用途 |
| --- | --- | --- |
| `values` | 完整状态快照 | 同步标题、产物和其他状态；包含 `messages`，但不应与增量渲染混为一谈。 |
| `messages` / `messages-tuple` | 模型消息块及其元数据 | 支持逐步渲染；分块粒度由模型与上游流实现决定，不承诺"一 token 一事件"。 |
| `custom` | 节点/工具写出的定制事件 | DeerFlow 用它接收、缓冲子智能体步骤事件。 |

Gateway 会把客户端的 `messages-tuple` 映射为 LangGraph 的 `messages`，过滤不兼容的 `events` 模式，并可一次请求多个模式；具体映射见 [run_agent](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L440)。因此 `values` 和 `messages` 在内容上可能都触及消息，但职责不同：前者是状态观察，后者是低延迟内容呈现。前端或客户端必须按事件类型处理，而不是把两者都直接追加到同一消息列表。

## 八、复习地图：从状态定义走到一次实际运行

**对应字幕：501-534**

### 五句复盘

1. LangGraph 让 Agent 的“消息、工具结果与业务状态”成为可声明、可协调的图状态，而不是散落在循环变量中。
2. Reducer 定义的是字段写入合同：`artifacts` 要保留并去重，`sandbox` 的冲突要失败，`viewed_images={}` 要清空。
3. Checkpointer 以 `thread_id` 为状态边界；持久化级别由 memory / SQLite / PostgreSQL 后端决定。
4. DeerFlow 通过 `create_agent` 构造 Agent 图，通过 Middleware 实施标题、记忆、工具策略和澄清等产品行为。
5. Gateway 的后台 `run_agent` 将图的 `astream` 连接到 `StreamBridge` 与 SSE，线程状态和实时事件是两条相关但不同的链路。

### 推荐源码阅读顺序

1. 从 [ThreadState](../../backend/packages/harness/deerflow/agents/thread_state.py#L239) 逐个读 reducer，先回答每个字段的更新语义。
2. 阅读 [make_lead_agent](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L443) 与两处 [create_agent](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L569)，确认模型、工具和中间件如何进入图。
3. 阅读 [ClarificationMiddleware](../../backend/packages/harness/deerflow/agents/middlewares/clarification_middleware.py#L185)，理解 `Command(update, goto=END)` 的实际用途。
4. 阅读 [make_checkpointer](../../backend/packages/harness/deerflow/runtime/checkpointer/async_provider.py#L147)，再看 [Gateway 运行时装配](../../backend/app/gateway/deps.py#L249)。
5. 最后沿 [run_agent](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L242) 跟一次请求：构造 Agent -> 注入 checkpointer -> `astream` -> 发布 SSE。

### 自测题

- 为什么 `artifacts` 不能用普通覆盖字段？如果两个更新出现相同路径，最终顺序是什么？
- 为什么 `{}` 对 `viewed_images` 是“清空”，而 `None` 是“没有更新”？
- 哪个组件把 `thread_id` 放进检查点配置？为什么不能相信客户端随便传的配置？
- `ask_clarification` 被调用时，系统为什么不把它当作普通工具结果继续跑？
- `values` 与 `messages` 都携带消息相关信息时，客户端分别该用来做什么？
