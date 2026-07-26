# LangGraph 状态机制：Value / Message / Custom 三种范式

LangGraph 中所有状态字段的更新本质上都靠 **reducer**——它定义了「节点返回的新值」和「状态里已有的旧值」如何合并成最终结果。

三种范式的区别只在于 reducer 由谁定义：

| 范式 | Reducer 来源 | 行为 |
| ------ | ------------- | ------ |
| **Value** | 默认 reducer（内置） | 新值直接**覆盖**旧值 |
| **Message** | `add_messages`（内置） | 消息列表**追加**，支持去重 |
| **Custom** | 你自己写的函数 | 完全**自定义**合并逻辑 |

> 三种范式不是互斥的——同一个状态里不同字段可以混用不同范式。

---

## 一、核心概念：Reducer

### 标准形态

一个 reducer 就是普通函数，固定遵循 `(旧值, 新值) → 合并后的值` 的签名：

```python
def 自定义reducer(旧值, 节点返回的新值):
    # 在这里写合并逻辑
    return 合并后的最终值
```

通过 `Annotated[字段类型, reducer函数]` 绑定到状态字段上：

```python
llm_call_count: Annotated[int, add_counter]              # Custom：累加
tags: Annotated[Set[str], merge_tags]                     # Custom：并集去重
messages: Annotated[list[BaseMessage], add_messages]      # Message：追加
user_id: str                                              # Value：覆盖（无注解）
```

### 对比：有无自定义 Reducer 的差异

以计数字段为例——**不用**自定义 reducer（Value 模式）：

```python
llm_call_count: int  # 无注解 → 默认覆盖
```

- 初始值 `0` → 节点返回 `1` → 覆盖为 `1` → 下一个节点又返回 `1` → 仍是 `1`

**用了**自定义 reducer：

```python
llm_call_count: Annotated[int, add_counter]  # add_counter = lambda old, new: old + new
```

- 初始值 `0` → 节点返回 `1` → `add_counter(0,1)=1` → 再返回 `1` → `add_counter(1,1)=2` → …

这就是自定义 reducer 的意义：**当「直接覆盖」不满足需求时，自己定义更新规则**。

### 节点只需发「更新指令」

节点不用知道当前旧值是多少，只需返回需要更新的字段。具体怎么合并，完全由该字段绑定的 reducer 负责。未返回的字段保持原样。

---

## 二、完整可运行示例

### 前置依赖

```bash
pip install langgraph langchain_core
```

### 代码

```python
from typing import TypedDict, Annotated, Set
from langgraph.graph import StateGraph, add_messages
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage


# ── 自定义 Reducer ──────────────────────────────────
def add_counter(old: int, new: int) -> int:
    """数值累加"""
    return old + new

def merge_tags(old: Set[str], new: Set[str]) -> Set[str]:
    """集合并集去重"""
    return old | new


# ── 组合状态（三种范式混用）──────────────────────────
class CombinedState(TypedDict):
    user_id: str                                         # Value 模式
    topic: str                                           # Value 模式
    messages: Annotated[list[BaseMessage], add_messages] # Message 模式
    llm_call_count: Annotated[int, add_counter]          # Custom：累加
    tags: Annotated[Set[str], merge_tags]                # Custom：并集


# ── 节点定义 ─────────────────────────────────────────
def init_node(state: CombinedState):
    """节点1：初始化"""
    return {
        "topic": "LangGraph状态机制",
        "messages": [HumanMessage(content="LangGraph三种状态范式分别是什么？")],
        "llm_call_count": 1,
        "tags": {"入门", "状态管理"}
    }

def process_node(state: CombinedState):
    """节点2：业务处理"""
    return {
        "messages": [AIMessage(content="分别是Value覆盖、Message追加、Custom自定义Reducer三种范式。")],
        "llm_call_count": 1,
        "tags": {"核心概念", "入门"}  # "入门" 重复 → 自动去重
    }

def finish_node(state: CombinedState):
    """节点3：收尾"""
    return {
        "messages": [AIMessage(content="以上就是全部解答，还有其他问题吗？")],
        "llm_call_count": 1
    }


# ── 构建并运行 ───────────────────────────────────────
builder = StateGraph(CombinedState)
builder.add_node("init", init_node)
builder.add_node("process", process_node)
builder.add_node("finish", finish_node)
builder.set_entry_point("init")
builder.add_edge("init", "process")
builder.add_edge("process", "finish")
builder.set_finish_point("finish")

graph = builder.compile()

initial_state = {
    "user_id": "u_001",
    "topic": "未分类",
    "messages": [],
    "llm_call_count": 0,
    "tags": set()
}

final_state = graph.invoke(initial_state)

# ── 输出 ─────────────────────────────────────────────
print("=== 最终状态 ===")
print(f"user_id (Value): {final_state['user_id']}")
print(f"topic (Value):   {final_state['topic']}")
print(f"llm_call_count (Custom累加): {final_state['llm_call_count']}")
print(f"tags (Custom并集):           {final_state['tags']}")
print("messages (Message追加):")
for msg in final_state["messages"]:
    print(f"  [{msg.type}]: {msg.content}")
```

### 运行输出

```text
=== 最终状态 ===
user_id (Value): u_001
topic (Value):   LangGraph状态机制
llm_call_count (Custom累加): 3
tags (Custom并集):           {'入门', '状态管理', '核心概念'}
messages (Message追加):
  [human]: LangGraph三种状态范式分别是什么？
  [ai]: 分别是Value覆盖、Message追加、Custom自定义Reducer三种范式。
  [ai]: 以上就是全部解答，还有其他问题吗？
```

---

## 三、逐字段行为分解

| 字段 | 范式 | 初始值 | 节点1 | 节点2 | 节点3 | 最终值 |
| ------ | ------ | ------ | ------ | ------ | ------ | ------ |
| `user_id` | Value | `u_001` | 未返回 | 未返回 | 未返回 | `u_001`（不变） |
| `topic` | Value | `未分类` | 返回新值 | 未返回 | 未返回 | `LangGraph状态机制` |
| `messages` | Message | `[]` | 追加 human | 追加 ai | 追加 ai | 3条消息 |
| `llm_call_count` | Custom | `0` | `+1` | `+1` | `+1` | `3` |
| `tags` | Custom | `{}` | 加2标签 | 加2（1去重） | 未返回 | 3个标签 |

---

## 四、常见自定义 Reducer 场景

| 场景 | Reducer 逻辑 | 典型用法 |
| ------ | ------------- | --------- |
| 调用次数 / Token 统计 | `old + new` | LLM 调用计数 |
| 标签、文档ID、用户ID收集 | `old \| new` | 集合并集去重 |
| 操作日志、历史记录追加 | `old + new`（列表拼接） | 审计日志 |
| 配置项 / 元数据更新 | 字典深度合并 | 运行时配置累积 |

---

## 五、核心要点

1. **每种范式本质都是 reducer**——区别只在于谁定义了合并规则
2. **Reducer 按字段独立绑定**——同一状态不同字段可混用不同范式
3. **Message 本质是内置 Custom Reducer**——`add_messages` 就是专门处理消息列表追加/去重的 reducer
4. **节点只返回需要的增量**——不需要拼装完整状态，未返回的字段自动保留原值
