# DeerFlow ThreadState：把 Agent 状态当作可演进的数据总线

> 本笔记按视频讲解线索重组，但以当前 DeerFlow 源码为准。重点不是背字段，而是能判断：一个状态该由谁写、为什么要 reducer、它如何跨模型调用和上下文压缩继续有效。

## 📖 目录

- [1. 先建立正确模型：ThreadState 是图运行的状态契约](#1-先建立正确模型threadstate-是图运行的状态契约)
- [2. Reducer 决定"更新"是什么意思](#2-reducer-决定更新是什么意思)
- [3. 具有特殊协议的状态：冲突、清空与有界累积](#3-具有特殊协议的状态冲突清空与有界累积)
- [4. 状态是数据总线，但每个键都应有明确所有者](#4-状态是数据总线但每个键都应有明确所有者)
- [5. 可选字段、单值快照与完整字段地图](#5-可选字段单值快照与完整字段地图)
- [6. 扩展一个字段：从业务不变量反推 reducer](#6-扩展一个字段从业务不变量反推-reducer)
- [7. 复习总结：状态为何能跨越上下文压缩](#7-复习总结状态为何能跨越上下文压缩)
- [8. 阅读路径与自测题](#8-阅读路径与自测题)

---

## 1. 先建立正确模型：ThreadState 是图运行的状态契约

**对应字幕：1-47**

`ThreadState` 是主 Agent 图的 `state_schema`：工厂创建 Agent 时将它传给 LangChain/LangGraph 的 `create_agent`。它继承 `AgentState`，因此除了 DeerFlow 自己声明的字段，还继承了以 `messages` 为核心的对话状态。图节点和中间件不应原地共享、随意改一个全局字典；它们返回“本次更新了哪些键”，运行时依状态 schema 的规则将更新并入当前状态。

源码入口：[ThreadState 定义](../../backend/packages/harness/deerflow/agents/thread_state.py#L239)；[主 Agent 绑定 schema](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L661)。

这样设计的实际价值是：

- **契约明确**：字段、可选性与合并规则集中在一个地方，读写方不必猜测某个临时键是否存在。
- **为持久化留出边界**：状态会进入 LangGraph 的 checkpoint 流程，所以字段应保持为可序列化、可恢复的数据。`TypedDict` 是类型/schema 声明，并不会在运行时“强制只允许可序列化对象”；真正的约束仍来自写入者和 checkpointer。
- **并发更新可定义**：同一图步骤可能产生多个更新。需要保留、去重、拒绝冲突或表达清空意图的键，必须把规则写成 reducer，而不是依赖“谁最后写入谁赢”。

不要把它理解为普通 Python 全局状态。更准确的心智模型是：**`ThreadState` 是一次线程运行及其 checkpoint 的共享数据模型，`Runtime.state` 是工具读取该模型的窗口。**例如 `present_files` 从 `runtime.state["thread_data"]` 找输出目录，而非反向调用创建目录的中间件。[工具读取位置](../../backend/packages/harness/deerflow/tools/builtins/present_file_tool.py#L58)

## 2. Reducer 决定“更新”是什么意思

**对应字幕：48-122**

字段没有 `Annotated[..., reducer]` 时，通常是单值覆盖语义；带 reducer 的字段则把 `(existing, new)` 显式变成下一个值。当前代码不是字幕所说的“只有 `artifacts` 和 `viewed_images` 有 reducer”，而是至少有 `sandbox`、`artifacts`、`todos`、`goal`、`viewed_images`、`promoted`、`delegations`、`skill_context` 八个自定义合并点。[字段总表](../../backend/packages/harness/deerflow/agents/thread_state.py#L239)

最适合先读的两个例子：

- `messages` 来自 `AgentState`。不要把它误解为简单 append：底层消息 reducer 支持按 message id 更新/删除，这才使流式消息更新和上下文压缩可行；DeerFlow 的摘要中间件会以 `RemoveMessage(REMOVE_ALL_MESSAGES)` 加保留消息的方式重建消息窗口。[压缩更新](../../backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py#L344)
- `artifacts` 是 `list[str]`，不是字幕中说的“以路径为 key 的字典”。`merge_artifacts` 将旧值与新值拼接，再用 `dict.fromkeys` **保序去重**；同一路径只展示一次，但其余路径不会因并发更新而丢失。[reducer](../../backend/packages/harness/deerflow/agents/thread_state.py#L58) [写入工具](../../backend/packages/harness/deerflow/tools/builtins/present_file_tool.py#L115)

因此，选择 reducer 时先问的不是“字段是列表还是字典”，而是：**多份合法更新到达时，业务上希望保留、替换、合并还是报错？**

## 3. 具有特殊协议的状态：冲突、清空与有界累积

**对应字幕：123-191**

Reducer 是 DeerFlow 把状态约束编码为业务协议的地方，当前实现中有几种值得复习的模式：

| 状态 | 更新协议 | 为什么这样做 |
| --- | --- | --- |
| `sandbox` | 允许 `None` 或相同 `sandbox_id` 的幂等写入；同线程出现不同 id 立即抛错 | 静默选一个 sandbox 会掩盖隔离/生命周期错误。|
| `viewed_images` | 普通非空更新按路径合并，后值覆盖同路径；`{}` 是清空信号 | 允许显式重置图片元数据，而不增设控制字段。|
| `todos`、`goal` | `new is None` 表示本节点未更新；否则新值整体取代旧值 | 两者都是“当前快照”，不能把旧待办与新待办做列表拼接。|
| `promoted` | catalog hash 变更时整体替换；相同 hash 下合并工具名 | 防止目录变化后，旧名称误指向不同工具。|
| `delegations`、`skill_context` | 按标识去重更新并限制保留数量 | checkpoint 不能无限膨胀，且要保留最近且仍有意义的上下文。|

源码：[sandbox 冲突保护](../../backend/packages/harness/deerflow/agents/thread_state.py#L34)；[图片、待办、目标](../../backend/packages/harness/deerflow/agents/thread_state.py#L68)；[延迟工具提升](../../backend/packages/harness/deerflow/agents/thread_state.py#L110)；[子智能体账本](../../backend/packages/harness/deerflow/agents/thread_state.py#L151)；[技能上下文](../../backend/packages/harness/deerflow/agents/thread_state.py#L205)。

### 需要纠正的图片流程

字幕描述“把 Base64 放进 `viewed_images`，注入后立刻返回 `{}` 清空”。当前源码已经改为更节省 checkpoint 的方案：`view_image` 工具只写入 `mime_type`、`size`、`actual_path` 三项元数据；`ViewImageMiddleware` 在模型调用前从已验证的磁盘路径按需读取并编码成 data URL，再生成隐藏的 `HumanMessage`。[工具写入](../../backend/packages/harness/deerflow/tools/builtins/view_image_tool.py#L159) [按需注入](../../backend/packages/harness/deerflow/agents/middlewares/view_image_middleware.py#L126)

`merge_viewed_images` **仍然**保留 `{}` 代表清空的带内信令，但当前 `ViewImageMiddleware` 的注入结果只更新 `messages`，不会在该处清空 `viewed_images`；它通过检查上一次工具调用后是否已有图片提示消息，避免重复注入。[去重判断](../../backend/packages/harness/deerflow/agents/middlewares/view_image_middleware.py#L170) [reducer 的清空分支](../../backend/packages/harness/deerflow/agents/thread_state.py#L59)

这是一条重要的源码阅读纪律：**先看 reducer，再全局搜索写入点，不能只按字段名推测完整生命周期。**

## 4. 状态是数据总线，但每个键都应有明确所有者

**对应字幕：192-230**

把 `ThreadState` 看成“数据总线”是有用的：中间件、工具与模型调用通过它交换数据，而非直接相互依赖。但“总线”不等于任何模块都能随意写。一个较稳定的阅读方式是对每个键记下 **生产者 → 消费者 → 生命周期**：

| 键 | 主要生产者 | 主要消费者/效果 |
| --- | --- | --- |
| `thread_data` | `ThreadDataMiddleware.before_agent` | sandbox 工具和文件工具获取 workspace/uploads/outputs 的线程隔离路径。|
| `uploaded_files` | `UploadsMiddleware.before_agent` | 同一中间件将文件清单与文档提纲注入最后一条用户消息，供模型定位文件。|
| `sandbox` | `SandboxMiddleware` | sandbox 工具复用线程对应的 sandbox id；释放由 `after_agent` 处理。|
| `artifacts` | `present_files` | 前端/运行时可获得已声明的输出文件路径；reducer 合并去重。|
| `viewed_images` | `view_image` | `ViewImageMiddleware` 在满足工具调用完成条件时构造仅供模型可见的图片消息。|
| `todos` | LangChain 的 `write_todos` 工具与 `TodoMiddleware` | 待办在原始工具调用被压缩后仍可由中间件重述，防止模型失去计划。|

源码：[线程路径写入](../../backend/packages/harness/deerflow/agents/middlewares/thread_data_middleware.py#L81)；[上传文件写入/注入](../../backend/packages/harness/deerflow/agents/middlewares/uploads_middleware.py#L292)；[sandbox 生命周期](../../backend/packages/harness/deerflow/sandbox/middleware.py#L29)；[图片注入](../../backend/packages/harness/deerflow/agents/middlewares/view_image_middleware.py#L204)；[待办恢复](../../backend/packages/harness/deerflow/agents/middlewares/todo_middleware.py#L118)。

注意字幕的时序图只能当概念图，不能视为固定执行顺序。`build_middlewares()` 根据配置、模型是否支持视觉、是否 plan mode 等条件动态装配中间件；因此“谁先写”必须回到实际构建链确认。[中间件组装](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L269)

## 5. 可选字段、单值快照与完整字段地图

**对应字幕：231-290**

`NotRequired` 的意义是 TypedDict 的键可以缺失，适合在某个生命周期阶段才出现的状态；它不是“该字段的值必须是 `None`”。需要同时区分三件事：键不存在、键存在且值为 `None`、本次更新没有提交这个键。Reducer 中对 `new is None` 的处理是各键自己的协议，不应从类型标注一概推导。

当前 `ThreadState` 可按用途分成四组：

1. **线程资源与展示**：`sandbox`、`thread_data`、`title`、`uploaded_files`、`viewed_images`、`artifacts`。标题由 `TitleMiddleware.after_model` 在首个真实用户消息后生成，避免把动态上下文提醒当成用户问题。[标题逻辑](../../backend/packages/harness/deerflow/agents/middlewares/title_middleware.py#L25)
2. **任务推进**：`todos` 与 `goal`。前者是可替换的计划快照，后者由 `GoalState` 表示当前目标，也采用“未更新则保留”的 reducer。[定义](../../backend/packages/harness/deerflow/agents/thread_state.py#L70)
3. **工具与协作**：`promoted` 记录与工具目录 hash 绑定的延迟工具提升；`delegations` 是子智能体任务账本，终态不允许被后续非终态倒退，并且最多保留 50 条。[定义与上限](../../backend/packages/harness/deerflow/agents/thread_state.py#L112)
4. **抗上下文遗忘**：`skill_context` 只保存技能的 name/path/description 引用，不保存整份 `SKILL.md`，最多 8 条；`summary_text` 保存摘要正文，而非把摘要伪装成一条普通 `messages` 项。[技能条目规范化](../../backend/packages/harness/deerflow/agents/thread_state.py#L159) [摘要写入](../../backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py#L344)

字幕中的“字段只有七个”“只有两个 reducer”均已过时。学习时请以 [ThreadState](../../backend/packages/harness/deerflow/agents/thread_state.py#L197) 为清单起点，再分别跟踪每个字段的写入/读取点。

## 6. 扩展一个字段：从业务不变量反推 reducer

**对应字幕：291-310**

给 `ThreadState` 增加字段时，不要先复制 `Annotated` 模板。按下面四步做设计审查：

1. **定义数据与生命周期**：它是当前快照、历史集合，还是一次性信号？谁写，谁读，何时应过期？
2. **判断竞争关系**：是否可能有多个工具/节点在同一图步骤提交更新？若会，默认覆盖可能丢失信息，需要 reducer。
3. **写出代数语义**：新值 `None` 是“不更新”还是“清除”？空列表/空字典是合法值、清空命令，还是应当忽略？冲突要合并、最新胜出，还是 fail closed？
4. **实现消费与测试**：把生产者与消费者都接上，并为 reducer 的初始化、空值、并发合并、上限/冲突写单元测试。

例如“用户情绪”若只保留本轮最新判断且仅由一个中间件写，可用 `NotRequired[Sentiment | None]` 的单值字段；若要保留可检索的情绪历史，则应声明列表/映射的容量、去重键和 reducer。关键不是 `TypedDict` 的语法，而是业务不变量是否写进了状态合并规则。

可仿照的测试对象：[ThreadState reducers 测试](../../backend/tests/test_thread_state_reducers.py)；可仿照的生产者：[view_image 的 `Command(update=...)`](../../backend/packages/harness/deerflow/tools/builtins/view_image_tool.py#L171)。

## 7. 复习总结：状态为何能跨越上下文压缩

**对应字幕：311-335**

本集应带走的不是“某字段必须用某种容器”，而是五条判断：

1. `ThreadState` 是 Agent 图的状态 schema；更新由运行时合并，而非全局可变字典直接修改。
2. reducer 是业务规则：`artifacts` 保序去重、`sandbox` 冲突即失败、`delegations` 防止终态倒退、`viewed_images` 支持带内清空。
3. state 是松耦合的数据总线，但必须为每个键指定主要生产者和消费者。
4. 可选键、空值与“不更新”不是同一件事；具体语义由每个 reducer 和写入点定义。
5. `summary_text`、`delegations`、`skill_context` 把压缩后仍需保留的信息放进独立状态通道，再由 `DurableContextMiddleware` 作为隐藏上下文投影给模型，而不是依赖旧消息永远留在窗口中。[持久上下文投影](../../backend/packages/harness/deerflow/agents/middlewares/durable_context_middleware.py#L197)

## 8. 阅读路径与自测题

**对应字幕：336-356**

建议按下面顺序复习源码，能把“字段定义”与“真实使用”连起来：

1. 从 [thread_state.py](../../backend/packages/harness/deerflow/agents/thread_state.py) 读完所有 reducer 和字段声明，先写出每个键的更新规则。
2. 跟踪 [lead_agent/agent.py](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L269) 的中间件装配，确认当前配置下哪些生产者会实际启用。
3. 对照 [view_image_tool.py](../../backend/packages/harness/deerflow/tools/builtins/view_image_tool.py) 与 [view_image_middleware.py](../../backend/packages/harness/deerflow/agents/middlewares/view_image_middleware.py)，练习区分“持久元数据”和“临时模型消息”。
4. 最后读 [durable_context_middleware.py](../../backend/packages/harness/deerflow/agents/middlewares/durable_context_middleware.py#L197) 与 [summarization_middleware.py](../../backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py#L344)，理解为什么待办、技能、子任务和摘要不应只依赖 `messages`。

自测：

- 为什么 `merge_artifacts` 用列表加保序去重，而非字幕所述的字典？如果改为普通覆盖，会损失什么？
- `{}` 在 `merge_viewed_images` 中代表什么？当前图片注入为什么没有靠“注入后清空”防重？
- 新增一个“最近使用的外部数据源”字段时，如何决定它需要 reducer、容量上限和清空协议？

能用源码回答这三个问题，才算真正掌握 ThreadState 的设计。
