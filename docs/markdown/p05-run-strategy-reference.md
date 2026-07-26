# DeerFlow 策略体系速查笔记

> 整理日期：2026-07-21  
> 涵盖：Run 并发策略、断连策略、取消动作、线程创建策略、完成策略

---

## 一、全景概览

DeerFlow 的 `start_run` 链路中有 **五组策略**，分别控制不同的行为维度：

```
POST /api/threads/{id}/runs/stream
  │
  ├─ multitask_strategy   ← 同一线程上有活跃 Run 时，新请求怎么处理？
  ├─ on_disconnect        ← 客户端断开 SSE 连接时，后台 Run 怎么处理？
  ├─ on_completion        ← Run 完成后，临时线程怎么处理？
  ├─ if_not_exists        ← 线程不存在时，怎么处理？
  └─ cancel?action=       ← 手动取消 Run 时，Checkpoint 怎么处理？
```

---

## 二、并发策略（multitask_strategy）

**定义位置**：[`thread_runs.py#L88`](../../backend/app/gateway/routers/thread_runs.py#L88)

```python
multitask_strategy: Literal["reject", "rollback", "interrupt", "enqueue"] = "reject"
```

### 2.1 四种策略对比

```
同一 Thread 已有 Run 正在执行中，新请求到达：

┌──────────────┬──────────────────────────────────────┬──────────┬──────────────────┐
│    策略       │               行为                    │ HTTP 码  │     实现状态      │
├──────────────┼──────────────────────────────────────┼──────────┼──────────────────┤
│  reject      │ 直接拒绝，返回 409 Conflict           │   409    │ ✅ 已实现         │
│  interrupt   │ 中断前 Run，保留 checkpoint，启动新 Run  │  200/201 │ ✅ 已实现         │
│  rollback    │ 中断前 Run，回滚 checkpoint，启动新 Run  │  200/201 │ ✅ 已实现         │
│  enqueue     │ 排队等待前 Run 结束再执行              │    —     │ ❌ 未实现(抛异常)  │
└──────────────┴──────────────────────────────────────┴──────────┴──────────────────┘
```

### 2.2 逐策略详解

#### ① reject（默认策略）

**触发时机**：用户正常发消息（前端不传特殊策略参数）

**源码路径**：[`manager.py#L982`](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L982)

```python
if multitask_strategy == "reject" and local_inflight:
    raise ConflictError(f"Thread {thread_id} already has an active run")
```

**完整流程图**：

```
请求2到达 → start_run() → goal_thread_lock(thread_id) → create_or_reject()
                                                             │
                                         检查：该线程有活跃 Run 吗？
                                            ├─ 没有 → 创建新 Run(#2) → 返回 200
                                            └─ 有   → 抛出 ConflictError → 返回 409
```

**使用场景**：正常的一问一答。用户在等待回复时又发送了消息，前端应展示"正在生成中"并禁用输入框。

**401 vs 403 vs 404 vs 409**：DeerFlow 用 409 表示"线程已有活跃运行"的冲突状态，这是 RESTful 约定（冲突而非禁止访问）。

---

#### ② interrupt（中断保留）

**触发时机**：前端点击停止按钮，或客户端显式传 `multitask_strategy="interrupt"`

**源码路径**：[`manager.py#L1066`](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L1066)

```python
if multitask_strategy in ("interrupt", "rollback"):
    for r in local_inflight:
        r.abort_action = multitask_strategy   # "interrupt"
        r.abort_event.set()                   # 通知流循环停止
        r.task.cancel()                       # 取消 asyncio Task
        r.status = RunStatus.interrupted
```

**关键链**：

```
abort_event.set() → 流循环检测到 → 停止 agent.astream()
task.cancel()     → asyncio 取消协程 → finally 块触发
action="interrupt" → 保留当前 checkpoint（不回滚）
```

**Checkpoint 状态**：保留当前快照。下次新 Run 开始时从该快照继续。

---

#### ③ rollback（中断回滚）

**触发时机**：显式传 `multitask_strategy="rollback"` 或 `cancel?action=rollback`

**与 interrupt 的关键区别**：

```
interrupt:  Run_A 停止 → checkpoint 保留在 "你好" 回复之后
rollback:   Run_A 停止 → checkpoint 回退到 "你好" 回复之前（Run 开始前的状态）
```

**回滚三步流程**（[`worker.py`](https://github.com/deer-flow/deer-flow/blob/main/backend/packages/harness/deerflow/runtime/runs/worker.py)）：

```
Run_A 开始
  │
  ├─ ① 快照: 深拷贝 checkpoint + metadata + pending_writes
  │
  ├─ ② agent.astream() 执行中…
  │    │
  │    │  请求_B 到达，strategy="rollback"
  │    │
  │    ├─ ③ abort_event.set() + task.cancel()
  │    │
  │    └─ ④ finally: _rollback_to_pre_run_checkpoint()
  │         ├─ checkpointer.aput(快照的 checkpoint)     ← 恢复到 Run 开始前
  │         └─ checkpointer.aput_writes(快照的 writes)   ← 恢复任务队列
  │
  ▼
Run_B 开始（从 Run_A 开始前的 checkpoint 继续）
```

**使用场景**：用户在 Run 执行到一半时想要从头重新开始（抛弃本次 Run 产生的所有中间状态）。

---

#### ④ enqueue（排队）—— 未实现，设计方案如下

**当前行为**：

```python
# manager.py #L947
_supported_strategies = ("reject", "interrupt", "rollback")
if multitask_strategy not in _supported_strategies:
    raise UnsupportedStrategyError(...)  # → HTTP 501
```

---

##### 🔧 enqueue 实现方案

###### 设计目标

当 `multitask_strategy="enqueue"` 时，如果线程已有活跃 Run，新请求**不拒绝、不中断**，而是进入 FIFO 队列等待前一个 Run 完成后自动执行。

```
用户请求时间线:

T0: "你好"          → Run_A 创建，立即开始执行
T1: "写一段代码"     → Run_B 创建，状态=queued，#1 排队
T2: "写一首诗"       → Run_C 创建，状态=queued，#2 排队

后台执行:
Run_A 执行中 (10s)... → 完成 → 自动触发 Run_B 开始
Run_B 执行中 (15s)... → 完成 → 自动触发 Run_C 开始
Run_C 执行中 (8s)...  → 完成 → 队列为空，线程恢复空闲
```

###### 涉及改动的文件和模块

```
改动范围:

backend/packages/harness/deerflow/runtime/runs/
├── schemas.py          ← 新增 RunStatus.queued
├── manager.py          ← 新增 _queues 字典、enqueue 分支、dequeue_next()、cancel_queued()
│                          RunRecord 新增 queue_position、enqueued_at
└── worker.py           ← finally 块中调用 dequeue_next → 启动下一个 queued run

backend/app/gateway/
└── services.py         ← start_run 中 enqueue 路径：记录立即返回，不启动后台任务
```

---

###### 第一步：新增 `RunStatus.queued`

```python
# schemas.py — 在现有枚举中新增 queued
class RunStatus(StrEnum):
    pending = "pending"
    queued = "queued"        # ← 新增：已入队等待执行
    running = "running"
    success = "success"
    error = "error"
    timeout = "timeout"
    interrupted = "interrupted"
```

状态流转：

```
queued ──(轮到你了)──▶ pending ──▶ running ──▶ success/error/timeout
  │                                               
  └──(用户取消)──▶ interrupted
```

---

###### 第二步：RunRecord 新增队列相关字段

```python
# manager.py — RunRecord dataclass 新增字段
@dataclass
class RunRecord:
    # ...existing code...
    
    # enqueue 策略专用字段
    queue_position: int = 0            # 队列中的位置（1-based）
    enqueued_at: str = ""              # 入队时间戳（ISO 8601）
    queued_input: dict | None = None   # 入队时保存的 graph_input（用于后续启动）
    queued_config: dict | None = None  # 入队时保存的 RunnableConfig（用于后续启动）
```

`queued_input` 和 `queued_config` 是关键——`run_agent()` 需要这些参数才能启动执行，而原始的 HTTP 请求体在入队时已经处理完毕，必须把它们**快照保存**到 RunRecord 上。

---

###### 第三步：RunManager 新增队列结构

```python
# manager.py — RunManager.__init__ 中新增
class RunManager:
    def __init__(self, ...):
        # ...existing code...
        
        # enqueue 策略：per-thread 的 FIFO 队列
        # key=thread_id, value=asyncio.Queue[RunRecord]
        self._queues: dict[str, asyncio.Queue[RunRecord]] = {}
```

用 `asyncio.Queue` 而非 `collections.deque` 的原因：
- 天然支持 `async for` / `await queue.get()` 阻塞等待
- 内置任务取消机制（`queue.get()` 可以被 `CancelledError` 中断）
- 不需要自己写 `asyncio.Event` + 轮询

---

###### 第四步：create_or_reject 中的 enqueue 分支

```python
# manager.py — create_or_reject 中新增 enqueue 分支
async def create_or_reject(self, thread_id, ...):
    # 1) 本地 inflight 检查（现有逻辑）
    local_inflight = [...]
    
    if multitask_strategy == "reject" and local_inflight:
        raise ConflictError(...)
    
    # ★ enqueue 分支：不抛异常，而是创建 queued 记录并入队
    if multitask_strategy == "enqueue" and local_inflight:
        queue = self._queues.setdefault(thread_id, asyncio.Queue())
        position = queue.qsize() + 1
        
        record = RunRecord(
            run_id=run_id,
            thread_id=thread_id,
            status=RunStatus.queued,           # ← 状态为 queued
            multitask_strategy="enqueue",
            queue_position=position,
            enqueued_at=now,
            queued_input=graph_input,           # ← 快照 graph_input
            queued_config=config,               # ← 快照 config
            ...
        )
        
        # 持久化到 store
        if self._store is not None:
            await self._store.put(run_id, **self._store_put_payload(record))
        
        # 注册到内存
        async with self._lock:
            self._runs[run_id] = record
            self._index_run_locked(record)
        
        # ★ 入队（注意：先放 record 再 put 到 queue，避免消费者拿到不完整的 record）
        await queue.put(record)
        
        logger.info("Run %s enqueued on thread %s (position=%d)", run_id, thread_id, position)
        return record
    
    if multitask_strategy in ("interrupt", "rollback") and local_inflight:
        # 现有逻辑...
```

---

###### 第五步：新增 RunManager.dequeue_next() 方法

```python
# manager.py — 新增方法
async def dequeue_next(self, thread_id: str) -> RunRecord | None:
    """取出线程队列中的下一个等待 Run，更新状态为 pending。
    
    由 worker.py 的 finally 块在每次 Run 完成后调用。
    返回 None 表示队列为空。
    """
    queue = self._queues.get(thread_id)
    if queue is None or queue.empty():
        # 队列已空，清理
        self._queues.pop(thread_id, None)
        return None
    
    try:
        # 非阻塞获取（此时队列中一定有元素，因为 finally 块在 set_status 之后调用）
        next_record = queue.get_nowait()
    except asyncio.QueueEmpty:
        self._queues.pop(thread_id, None)
        return None
    
    # 检查是否已被取消（用户在排队期间点了取消按钮）
    if next_record.status == RunStatus.interrupted:
        logger.info("Dequeued run %s was already cancelled; skipping", next_record.run_id)
        # 递归取下一个
        return await self.dequeue_next(thread_id)
    
    # 更新状态：queued → pending
    next_record.status = RunStatus.pending
    next_record.updated_at = _now_iso()
    
    if self._store is not None:
        await self._persist_status(next_record, RunStatus.pending)
    
    # 更新后续排队记录的位置（所有位置 -1）
    self._shift_queue_positions(thread_id)
    
    logger.info("Dequeued run %s from thread %s (was position #%d)", next_record.run_id, thread_id, next_record.queue_position)
    return next_record

def _shift_queue_positions(self, thread_id: str) -> None:
    """将队列中所有记录的 queue_position 减 1。"""
    queue = self._queues.get(thread_id)
    if queue is None:
        return
    # asyncio.Queue 内部是 _queue (deque)，直接遍历修改
    for record in queue._queue:
        if record.queue_position > 0:
            record.queue_position -= 1
```

---

###### 第六步：新增 RunManager.cancel_queued() 方法

```python
# manager.py — 新增方法
async def cancel_queued(self, run_id: str) -> CancelOutcome:
    """取消一个还在排队中的 Run。
    
    直接从队列中移除并将状态设为 interrupted。
    """
    async with self._lock:
        record = self._runs.get(run_id)
    
    if record is None:
        return CancelOutcome.unknown
    
    if record.status != RunStatus.queued:
        # 不在排队状态 → 走普通的 cancel 流程
        return await self.cancel(run_id)
    
    # queued 状态的记录不需要 abort_event 和 task.cancel()
    # 只需要标记状态，dequeue_next 会自动跳过
    async with self._lock:
        record.status = RunStatus.interrupted
        record.updated_at = _now_iso()
    
    await self._persist_status(record, RunStatus.interrupted)
    
    # 从 asyncio.Queue 中移除（重建队列，跳过已取消的记录）
    # asyncio.Queue 没有直接 remove 方法，用标记 + dequeue 时跳过的方式处理
    self._shift_queue_positions(record.thread_id)
    
    return CancelOutcome.cancelled
```

---

###### 第七步：worker.py — finally 块中触发下一个排队 Run

```python
# worker.py — run_agent() 的 finally 块末尾
# 在现有 finally 逻辑的最后添加：

    finally:
        # ...existing cleanup code...（flush journal, sync title, persist duration 等）
        
        # ★ enqueue: 检查并启动下一个排队 Run
        # 放在 finally 末尾，确保当前 Run 的所有清理工作已完成
        next_record = await run_manager.dequeue_next(thread_id)
        if next_record is not None:
            logger.info(
                "Starting enqueued run %s for thread %s",
                next_record.run_id, thread_id,
            )
            # 从 RunRecord 中恢复入队时保存的参数
            next_record.task = asyncio.create_task(
                run_agent(
                    bridge=bridge,
                    run_manager=run_manager,
                    record=next_record,
                    ctx=ctx,
                    agent_factory=agent_factory,        # 复用同一个 agent_factory
                    graph_input=next_record.queued_input,
                    config=next_record.queued_config,
                    stream_modes=stream_modes,           # 复用相同的 stream_modes
                    stream_subgraphs=stream_subgraphs,
                    interrupt_before=interrupt_before,
                    interrupt_after=interrupt_after,
                )
            )
```

注意：这里复用了当前 `run_agent` 调用中的 `bridge`、`run_manager`、`ctx` 等单例，因为它们与当前线程绑定且在进程生命周期内有效。

---

###### 第八步：gateway 层 — start_run 中的 enqueue 路径

```python
# services.py — start_run 中 enqueue 策略的处理
async def start_run(body, thread_id, request):
    # ...现有的校验逻辑（模型 allowlist、线程所有权等）...
    
    # 构建 graph_input 和 config（需要在入队前完成，以便快照保存）
    graph_input = normalize_input(body.input, trusted_internal=is_internal_caller)
    config = build_run_config(thread_id, body.config, body.metadata, assistant_id=body.assistant_id)
    
    # ...现有的 merge context、inject auth 等...
    
    async with goal_thread_lock(thread_id):
        record = await run_mgr.create_or_reject(
            thread_id,
            body.assistant_id,
            on_disconnect=disconnect,
            metadata=body.metadata or {},
            kwargs={"input": body.input, "config": redact_config_secrets(body.config)},
            multitask_strategy=body.multitask_strategy,
            model_name=model_name,
            user_id=owner_user_id,
            # ★ 传入入队快照参数
            graph_input=graph_input,
            config=config,
        )
    
    # ★ enqueue 路径：不启动后台任务，直接返回
    if record.status == RunStatus.queued:
        # 仍然做 upsert 线程元数据
        # ...existing upsert logic...
        return record
    
    # 非 enqueue 路径：启动后台任务（现有逻辑）
    stream_modes = normalize_stream_modes(body.stream_mode)
    task = asyncio.create_task(run_agent(...))
    record.task = task
    return record
```

---

###### 第九步：前端适配

enqueue 策略下，前端的 SSE 连接模型需要微调：

```
POST /threads/{id}/runs/stream { multitask_strategy: "enqueue", input: "你好" }
  │
  ├─ 场景 A: 线程空闲 → 立即返回 SSE 流（和现在一样）
  │
  └─ 场景 B: 线程忙碌 → 返回 RunRecord { status: "queued", queue_position: 1 }
       │
       客户端收到 queued 状态后:
         ├─ 立即订阅 SSE: GET /threads/{id}/runs/{run_id}/stream
         │   这个 SSE 连接会保持打开，但暂时没有事件流入
         │   当 Run 真正开始执行时，metadata 事件会首先到达
         │
         ├─ UI 展示: "排队中... 前面还有 N 个任务"
         │   通过轮询 GET /threads/{id}/runs/{run_id} 获取 queue_position 变化
         │
         └─ 用户可以取消: POST /threads/{id}/runs/{run_id}/cancel
              → run_manager.cancel_queued(run_id)
```

---

###### 关键设计决策与边界情况

| 场景 | 处理方式 |
|------|---------|
| **排队 Run 被取消** | `cancel_queued()` 标记 `status=interrupted`，`dequeue_next()` 自动跳过 |
| **当前 Run 失败(error)** | 仍然触发 `dequeue_next()`，队列中的 Run 正常启动 |
| **当前 Run 超时** | 同上，不阻塞后续排队 |
| **进程重启** | Store 中 `status=queued` 的记录在 `RunManager` 初始化时通过 `_recover_queued_runs()` 恢复到队列 |
| **队列深度限制** | 通过 AppConfig 配置 `max_queue_depth`（默认 10），超出返回 HTTP 429 |
| **排队超时** | `enqueued_at` + AppConfig 配置 `queue_ttl_seconds`（默认 300s），超时自动标记 `timeout` |
| **多 Worker** | 队列是进程内的——enqueue 策略在多 Worker 模式下退化：只有"命中"了持有队列的那个 Worker 的请求才会排队。跨 Worker 的请求仍走 Store 的 partial unique index 保护 → 返回 ConflictError。这是有意为之的简化：enqueue 优先服务单 Worker 场景 |

---

###### 改动量估算

| 文件 | 新增行数 | 修改内容 |
|------|---------|---------|
| `schemas.py` | 1 | 新增 `queued` 枚举值 |
| `manager.py` | ~120 | RunRecord 字段、`_queues` 字典、`enqueue` 分支、`dequeue_next()`、`cancel_queued()`、`_shift_queue_positions()`、`_recover_queued_runs()` |
| `worker.py` | ~20 | finally 块末尾 `dequeue_next` + 创建新 task |
| `services.py` | ~15 | `start_run` 中 enqueue 路径的条件分支 |
| `thread_runs.py` | ~5 | `_supported_strategies` 中加入 `"enqueue"` |
| **合计** | **~160** | 约 160 行净新增代码 |

---



### 2.3 并发控制的三层防护

```
┌────────────────────────────────────────────────────────────────┐
│ 第1层: 本地内存检查 (self._lock)                                │
│   _thread_records_locked(thread_id) 查找 inflight run          │
│   同一 worker 进程内保证原子性                                    │
├────────────────────────────────────────────────────────────────┤
│ 第2层: Store 原子插入 (数据库)                                   │
│   partial unique index: (thread_id) WHERE status IN            │
│   ('pending','running')                                        │
│   防止跨进程/跨 worker 竞争                                      │
├────────────────────────────────────────────────────────────────┤
│ 第3层: 中断本地 inflight (仅 interrupt/rollback)                │
│   abort_event.set() + task.cancel() + status → interrupted     │
│   确保旧 Run 优雅停止后才创建新 Run                              │
└────────────────────────────────────────────────────────────────┘
```

**为什么需要三层**：
- 第1层挡不住多 worker 场景（两个 worker 各自的内存里都没有对方创建的 run）
- 第2层是最终兜底——数据库的 partial unique index 保证同一线程最多一个活跃行
- 第3层确保旧 run 的流循环停止、资源释放，新 run 才能安全开始

---

## 三、断连策略（on_disconnect）

**定义位置**：[`schemas.py#L17`](../../backend/packages/harness/deerflow/runtime/runs/schemas.py#L17)

```python
class DisconnectMode(StrEnum):
    cancel = "cancel"
    continue_ = "continue"
```

**参数来源**：[`thread_runs.py#L87`](https://github.com/deer-flow/deer-flow/blob/main/backend/app/gateway/routers/thread_runs.py#L87)

```python
on_disconnect: Literal["cancel", "continue"] = "cancel"
```

| 策略 | 行为 | 适用场景 |
|------|------|---------|
| **cancel**（默认） | 客户端断开 SSE 连接 → 取消后台 Run | Web 页面：用户关闭标签页就不需要继续了 |
| **continue** | 客户端断开 SSE 连接 → 后台 Run 继续执行 | IM 通道、后台任务、调度器 |

**在 services.py 中的使用**：

```python
# 第631行: 解析断连模式
disconnect = DisconnectMode.cancel if body.on_disconnect == "cancel" else DisconnectMode.continue_

# sse_consumer 的 finally 块中:
if record.on_disconnect == DisconnectMode.cancel:
    await run_mgr.cancel(record.run_id)   # 客户端断开 → 取消 Run
```

**调度器固定使用 continue**：

```python
# services.py#L843 — launch_scheduled_thread_run
body = SimpleNamespace(
    ...
    on_disconnect="continue",   # 调度器任务不依赖客户端连接
)
```

---

## 四、取消动作（cancel?action=）

**定义位置**：[`manager.py#L762`](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L762)

```python
async def cancel(self, run_id: str, *, action: str = "interrupt") -> CancelOutcome:
```

**HTTP API**：

```
POST /api/threads/{id}/runs/{run_id}/cancel?action=interrupt   # 中断保留
POST /api/threads/{id}/runs/{run_id}/cancel?action=rollback    # 中断回滚
```

| action | Checkpoint 处理 | 相当于 |
|--------|----------------|--------|
| **interrupt** | 保留当前快照 | 停止但保留进度 |
| **rollback** | 回退到 Run 开始前的快照 | 停止并撤销本次所有变更 |

**cancel 的六种结果**（[`CancelOutcome`](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L1435)）：

```python
class CancelOutcome(StrEnum):
    cancelled             = "cancelled"              # 成功取消
    taken_over            = "taken_over"             # 已被其他 worker 接管
    lease_valid_elsewhere = "lease_valid_elsewhere"  # 其他 worker 租约有效
    not_cancellable       = "not_cancellable"        # Run 已是终态无法取消
    not_active_locally    = "not_active_locally"     # 单 worker 模式下不在内存中
    unknown               = "unknown"                # 找不到该 Run
```

**多 worker 场景**：如果本 worker 不持有该 Run，会先检查对端 worker 的租约。租约过期 → 接管并标记 error；租约有效 → 返回 `lease_valid_elsewhere` + HTTP 409 + `Retry-After`。

---

## 五、线程创建策略（if_not_exists）

**定义位置**：[`thread_runs.py#L90`](../../backend/app/gateway/routers/thread_runs.py#L90)

```python
if_not_exists: Literal["reject", "create"] = "create"
```

| 策略 | 行为 |
|------|------|
| **create**（默认） | 线程不存在 → 自动创建临时线程（在 start_run 的 upsert 逻辑中隐式创建） |
| **reject** | 线程不存在 → 拒绝请求（返回 404） |

**在 services.py 中的体现**：

```python
# 第732行 — 线程元数据 upsert
if existing is None:
    await run_ctx.thread_store.create(
        thread_id,
        assistant_id=body.assistant_id,
        metadata=body.metadata,
    )
```

---

## 六、完成策略（on_completion）

**定义位置**：[`thread_runs.py#L87`](../../backend/app/gateway/routers/thread_runs.py#L87)

```python
on_completion: Literal["delete", "keep"] = "keep"
```

| 策略 | 行为 |
|------|------|
| **keep**（默认） | Run 完成后，保留线程 |
| **delete** | Run 完成后，删除临时线程 |

**使用场景**：前端创建"临时聊天"（类似 ChatGPT 的临时对话），对话完成后自动清理。

---

## 七、策略速查矩阵

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DeerFlow 策略速查矩阵                               │
├────────────────────────┬──────────┬───────────┬───────────┬────────────────┤
│      策略组             │ reject   │ interrupt │ rollback  │ 其他           │
├────────────────────────┼──────────┼───────────┼───────────┼────────────────┤
│ multitask_strategy     │ HTTP 409 │ 中断保留  │ 中断回滚  │ enqueue: 未实现│
│ on_disconnect          │ —        │ cancel    │ —         │ continue       │
│ cancel?action          │ —        │ 保留 ckpt │ 回退 ckpt │ —              │
│ if_not_exists          │ 拒绝创建 │ —         │ —         │ create(默认)   │
│ on_completion          │ —        │ —         │ —         │ keep / delete  │
└────────────────────────┴──────────┴───────────┴───────────┴────────────────┘
```

## 八、关键源码索引

| 内容 | 文件 |
|------|------|
| DisconnectMode 枚举 | [`schemas.py#L17`](../../backend/packages/harness/deerflow/runtime/runs/schemas.py#L17) |
| RunRecord 数据结构 | [`manager.py#L149`](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L149) |
| create_or_reject 实现 | [`manager.py#L925`](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L925) |
| cancel 方法 | [`manager.py#L762`](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L762) |
| CancelOutcome 枚举 | [`manager.py#L1435`](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L1435) |
| ConflictError / UnsupportedStrategyError | [`manager.py#L1446-L1454`](../../backend/packages/harness/deerflow/runtime/runs/manager.py#L1446) |
| RunCreateRequest (Pydantic 模型) | [`thread_runs.py#L72`](../../backend/app/gateway/routers/thread_runs.py#L72) |
| start_run (网关层编排) | [`services.py#L610`](../../backend/app/gateway/services.py#L610) |
| sse_consumer (断连处理) | [`services.py#L880`](../../backend/app/gateway/services.py#L880) |
| launch_scheduled_thread_run | [`services.py#L820`](../../backend/app/gateway/services.py#L820) |
