# DeerFlow Agent 生命周期与并发控制复习笔记（p04）

> 学习目标：理解 Agent 实例何时创建、何时销毁，Bootstrap Agent 与标准 Agent 的区别，以及同一 Thread 上多 Run 并发的四种策略和 Checkpoint 回滚机制。

## 📖 目录

- [一、Agent 实例的生命周期：每次发消息都新建](#一agent-实例的生命周期每次发消息都新建)
- [二、Bootstrap Agent vs 标准 Agent](#二bootstrap-agent-vs-标准-agent)
- [三、同一 Thread 上的并发控制：四种策略](#三同一-thread-上的并发控制四种策略)
- [四、Checkpoint 回滚机制](#四checkpoint-回滚机制)
- [五、速查卡片](#五速查卡片)

---

## 一、Agent 实例的生命周期：每次发消息都新建

**核心事实：Agent 实例 ≠ Thread（会话）。每次用户发消息都会创建一个全新的 Agent 实例，run 结束后即销毁。**

```
同一个 Thread 内的多轮对话:

用户: "你好"           → run_agent() → make_lead_agent(config) → create_agent() → agent.astream() → 响应 → Agent 销毁
用户: "帮我写代码"      → run_agent() → make_lead_agent(config) → create_agent() → agent.astream() → 响应 → Agent 销毁
用户: "改一下bug"       → run_agent() → make_lead_agent(config) → create_agent() → agent.astream() → 响应 → Agent 销毁
                         ↑                ↑
                    同一个 thread_id   每次都新建 Agent 实例
```

| 概念 | 生命周期 | 数量关系 |
|---|---|---|
| **Thread（会话）** | 持久存在，直到被删除 | 一个用户可以有多个 thread |
| **Agent 实例** | 每次发消息新建（`create_agent()`），run 结束即销毁 | 每条消息对应一个新实例 |
| **对话历史** | 通过 Checkpointer 跨 run 持久化 | 同一个 thread 的所有 run 共享 |

类比：Thread 是一本笔记本（持久保存），Agent 是你每次翻开笔记本时拿的那支笔（用完就放下，下次再拿新的）。笔每次是新的，但笔记本上的内容一直保留。

### 调用链路

```
前端 POST /api/threads/{id}/runs/stream
  │
  ▼
Gateway services.py: run_stream_or_background()
  ├─ resolve_agent_factory()  → 返回 make_lead_agent 函数引用
  ├─ build_run_config()       → 把前端 context (is_bootstrap, agent_name...) 打包进 RunnableConfig
  └─ run_agent(agent_factory=make_lead_agent, config=...)
       │
       ▼
worker.py: run_agent()
  ├─ _install_runtime_context()     → 注入 thread_id, run_id
  ├─ agent = agent_factory(config)  → 调用 make_lead_agent → _make_lead_agent → create_agent()
  └─ agent.astream(input, config)   → 流式执行
```

关键文件：
- 入口注册：[langgraph.json](../../backend/langgraph.json) — `"lead_agent": "deerflow.agents:make_lead_agent"`
- 工厂函数：[agent.py#make_lead_agent](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L443)
- 运行执行：[worker.py#run_agent](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L242)

---

## 二、Bootstrap Agent vs 标准 Agent

`_make_lead_agent()` 内部通过 `is_bootstrap` 标志走两条完全不同的路径。

### 两条路径对比

```
_make_lead_agent(config)
  │
  ├─ is_bootstrap = True  ──→  Bootstrap 路径（Agent 工厂模式）
  │     • agent_config = None（不加载已有配置）
  │     • available_skills = {"bootstrap"}（只有这一个 skill）
  │     • tools = 默认工具 + setup_agent（创建新 Agent 的工具）
  │     • 立即 return，不走到后面的标准路径
  │
  └─ is_bootstrap = False ──→  标准 Agent 路径
        • agent_config = load_agent_config(agent_name)
        • available_skills = agent 配置的技能列表
        • tools = 默认工具 + update_agent（修改自身配置）
        • webhook 渠道（github）不暴露 update_agent
```

| 项目 | Bootstrap（`True`） | 标准路径（`False`） |
|---|---|---|
| `agent_config` | 强制 `None`，不加载配置 | `load_agent_config(agent_name)` |
| `available_skills` | 只有 `{"bootstrap"}` | 由 agent 配置或全局配置决定 |
| 特殊工具 | `+ [setup_agent]` — 创建新 agent | `+ [update_agent]` — 修改已有 agent |
| system_prompt | Bootstrap 专用精简 prompt | 完整 agent prompt 模板 |

### 设计意图

Bootstrap Agent 是一个"Agent 工厂"——用于引导用户创建第一个（或新的）自定义 Agent。它解决了一个**鸡生蛋问题**：自定义 Agent 的配置文件还不存在时，不能去加载它。

```text
Bootstrap Agent ──(setup_agent)──▶ 创建出自定义 Agent（SOUL.md + config.yaml）
                                       │
                                       └──(update_agent)──▶ 修改自身配置
```

### is_bootstrap 从哪里来

```python
# agent.py 第 474 行
is_bootstrap = cfg.get("is_bootstrap", False)
```

它来自前端传入的 `config["context"]`。目前仅在一个场景为 `True`：

```typescript
// frontend/src/app/workspace/agents/new/page.tsx
const { thread, sendMessage } = useThreadStream({
  context: {
    mode: "flash",
    is_bootstrap: true,   // ← 仅"新建 Agent"页面
  },
});
```

关键源码：
- [分叉点 `if is_bootstrap:`](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L545)
- [Bootstrap skill 定义](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L58)
- [_available_skill_names](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L421)

---

## 三、同一 Thread 上的并发控制：四种策略

当用户在同一个 Thread 上连续发消息，前一个 run 还没结束时后一个 run 已到达。代码中有完善的三层防护。

### 策略定义

```python
# thread_runs.py 第 88 行
multitask_strategy: Literal["reject", "rollback", "interrupt", "enqueue"]
```

| 策略 | 行为 | 前端对应操作 | 实现状态 |
|---|---|---|---|
| **`reject`**（默认） | 直接拒绝新请求，返回 409 Conflict | 正常发消息（不传策略） | ✅ 已实现 |
| **`interrupt`** | 中断前一个 run，保留 checkpoint | 点击停止按钮 | ✅ 已实现 |
| **`rollback`** | 中断 + 回滚 checkpoint 到 run 之前 | 停止并回滚（后端支持，前端暂无入口） | ✅ 已实现 |
| **`enqueue`** | 排队等待前一个 run 结束 | 暂无 | ❌ 未实现（manager 直接抛异常） |

### 并发控制的三层防护

执行顺序在 [manager.py#create_or_reject](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L925)：

1. **本地内存检查**：检查 `self._runs` 中同 thread 是否有 inflight run
2. **Store 原子插入**：通过数据库 partial unique index `(thread_id) WHERE status IN ('pending','running')` 防止跨进程竞争
3. **中断本地 inflight**：对于 interrupt/rollback，设置 `abort_event` + `task.cancel()`

```python
# manager.py 第 982 行
if multitask_strategy == "reject" and local_inflight:
    raise ConflictError(f"Thread {thread_id} already has an active run")

# manager.py 第 1066 行 — interrupt/rollback 路径
if multitask_strategy in ("interrupt", "rollback"):
    for r in local_inflight:
        r.abort_action = multitask_strategy
        r.abort_event.set()     # ← 通知流循环停止
        r.task.cancel()         # ← 取消 asyncio Task
```

### 流循环中的中断检测

```python
# worker.py 流循环中
async for chunk in agent.astream(...):
    if record.abort_event.is_set():
        logger.info("Run %s abort requested — stopping", run_id)
        break  # ← Agent 实例在这里被停掉
```

### 对应的 HTTP API

```text
正常发消息:  POST /api/threads/{id}/runs/stream           (默认 reject)
停止按钮:    POST /api/threads/{id}/runs/{run_id}/cancel?action=interrupt
停止并回滚:  POST /api/threads/{id}/runs/{run_id}/cancel?action=rollback
```

关键文件：
- [策略定义](../../backend/app/gateway/routers/thread_runs.py#L88)
- [cancel_run 端点](../../backend/app/gateway/routers/thread_runs.py#L573)
- [create_or_reject 实现](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L925)

---

## 四、Checkpoint 回滚机制

当 `multitask_strategy = "rollback"` 或 `cancel?action=rollback` 时，系统分三步完成回滚。

### 三步流程

```
时间线 →

run_A 开始
  │
  ├─ ① 快照：深拷贝 checkpoint + metadata + pending_writes
  │      （此时状态 = "你好" 完成后的状态）
  │
  ├─ ② agent.astream("帮我写代码") 开始执行 …… 还没结束
  │
  │  用户发送 "帮我改一下bug" ──▶ run_B 到达
  │                                 │
  │                           manager.create_or_reject(strategy="rollback")
  │                                 │
  │                           ┌─────┘
  │                           ▼
  │  ③ run_A.abort_event.set()   ← 通知停止
  │     run_A.task.cancel()       ← 取消协程
  │                           │
  │  ④ run_A 的 finally 块 ◄──┘
  │     action == "rollback" ?
  │       YES → _rollback_to_pre_run_checkpoint()
  │              ├─ checkpointer.aput(①的快照)      ← 恢复 checkpoint
  │              └─ checkpointer.aput_writes(...)    ← 恢复 pending_writes
  │
  ▼
run_B 开始（从 "你好" 之后的状态继续）
```

### 快照时机

```python
# worker.py 第 326 行 — 在 agent.astream() 之前拍快照
ckpt_tuple = await checkpointer.aget_tuple(config_for_check)
pre_run_snapshot = {
    "checkpoint":     copy.deepcopy(checkpoint),    # 完整 checkpoint 深拷贝
    "metadata":       copy.deepcopy(metadata),      # 元数据深拷贝
    "pending_writes": copy.deepcopy(pending_writes), # 待写入队列深拷贝
}
```

### 恢复逻辑（`_rollback_to_pre_run_checkpoint`）

```python
# worker.py 第 1050 行
async def _rollback_to_pre_run_checkpoint(...):
    # 1. 重新生成 checkpoint id（必须新 id，否则 put 报重复）
    checkpoint_to_restore = {**snapshot, "id": new_id, "ts": new_ts}

    # 2. 写回数据库
    await checkpointer.aput(config, checkpoint_to_restore, metadata, new_versions)

    # 3. 恢复 pending_writes（任务队列）
    for task_id, writes in pending_writes:
        await checkpointer.aput_writes(config, writes, task_id=task_id)
```

### 关键要点

| 要点 | 说明 |
|---|---|
| **深拷贝** | `copy.deepcopy` 确保快照不受后续 run 修改影响 |
| **新 checkpoint id** | 必须生成新 id + ts，checkpointer 的 `aput` 不接受重复 id |
| **pending_writes 也恢复** | 不仅是对话历史，任务队列也完整恢复 |
| **快照为 None** | 全新 thread → 直接 `adelete_thread` |
| **失败不阻塞** | rollback 失败只记 warning，不影响新 run 启动 |

关键文件：
- [快照捕获](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L326)
- [回滚函数](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L1050)
- [finally 块回滚触发](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L548)

---

## 五、速查卡片

| 问题 | 答案 |
|---|---|
| Agent 何时创建？ | 每次用户发消息时，`make_lead_agent(config)` → `create_agent()` |
| Agent 何时销毁？ | run 结束时（正常结束 / 中断 / 异常） |
| 对话历史如何保留？ | 通过 Checkpointer 按 `thread_id` 持久化 |
| Bootstrap 和标准 Agent 的区别？ | Bootstrap 只有 `bootstrap` skill + `setup_agent` 工具，用于创建新 Agent |
| 同一个 Thread 能同时跑两个 Agent 吗？ | 默认不能（`reject` 策略返回 409） |
| 用户点停止按钮发生了什么？ | `cancel?action=interrupt` → `abort_event.set()` → 流循环 break |
| rollback 和 interrupt 的区别？ | interrupt 保留 checkpoint；rollback 恢复到 run 开始前的 checkpoint |

### 核心文件索引

| 文件 | 职责 |
|---|---|
| [agent.py](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L443) | Agent 工厂：Bootstrap / 标准分叉、工具组装、中间件链 |
| [worker.py](../../backend/packages/harness/deerflow/runtime/runs/worker.py#L242) | 后台执行：快照、流循环、中断检测、回滚 |
| [manager.py](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L925) | Run 生命周期：create_or_reject、并发策略、cancel |
| [thread_runs.py](../../backend/app/gateway/routers/thread_runs.py#L88) | HTTP API：stream、cancel、策略定义 |
| [services.py](../../backend/app/gateway/services.py#L432) | Gateway 服务层：resolve_agent_factory、build_run_config |
| [page.tsx](../../frontend/src/app/workspace/agents/new/page.tsx) | 前端：Bootstrap 入口（`is_bootstrap: true`） |
| [hooks.ts](../../frontend/src/core/threads/hooks.ts) | 前端：sendMessage 实现、thread.submit 调用 |
