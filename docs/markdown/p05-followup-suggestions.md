# 2DeerFlow 追问功能实现复习笔记（p05）

> 学习目标：理解 AI 回答完成后，"追问建议"功能从触发到渲染的完整链路，包括提示词设计。

## 📖 目录

- [一、功能概述](#一功能概述)
- [二、完整触发链路](#二完整触发链路)
- [三、后端提示词设计](#三后端提示词设计)
- [四、前端渲染与动画](#四前端渲染与动画)
- [五、速查卡片](#五速查卡片)
- [六、核心文件索引](#六核心文件索引)

---

## 一、功能概述

追问功能的目标是：**当 AI 完成一轮回答后，自动根据对话上下文生成几个用户可能接着问的问题，并以"飘入"动画的形式展示在输入框上方**。

### 核心事实

- 触发时机：AI 回答 **streaming 完成时**（从 `"streaming"` → 非 `"streaming"` 的瞬间）
- 数据流：前端 `useEffect` 检测状态变化 → `POST /api/threads/{id}/suggestions` → 后端 LLM 生成追问 → 前端渲染
- 去重保护：对同一条 AI 消息只会生成一次追问
- 功能开关：`GET /api/suggestions/config` 返回全局开关状态，受 `config.yaml -> suggestions.enabled` 控制
- 交互：点击追问自动填入输入框并提交；输入框有内容时弹出追加/替换确认框；点击 X 隐藏

## 二、完整触发链路

### 前端触发 — useEffect 检测 streaming 结束

代码位于 [input-box.tsx](../../frontend/src/components/workspace/input-box.tsx#L1678) 的 `useEffect` 中：

```
useEffect 监听 status 变化
  ├─ wasStreamingRef 记录上一次 status
  ├─ 只有 wasStreaming===true 且 当前 streaming===false 才继续
  ├─ 跳过 disabled/isMock 状态
  ├─ 检查 lastAiId 去重（跳过已生成过的消息）
  ├─ 等待 suggestionsConfigLoaded（确保 config 已加载）
  ├─ 收集最近 ≤6 条 human/ai 消息作为上下文
  └─ 发起 fetch -> POST /api/threads/{id}/suggestions
```

### 请求体

```typescript
{
  messages: [{ role: "user"|"assistant", content: string }, ...],  // 最近6条
  n: 3,        // 期望生成3个追问
  model_name: context.model_name ?? undefined
}
```

### 状态管理

- `followups: string[]` — 追问列表
- `followupsLoading: boolean` — 加载中状态，显示"正在生成可能的后续问题..."
- `followupsHidden: boolean` — 用户点击 X 后隐藏追问

## 三、后端提示词设计

提示词位于 [suggestions.py](../../backend/app/gateway/routers/suggestions.py#L118-L133)。

### System Instruction（系统指令）

```python
system_instruction = (
    "You are generating follow-up questions to help the user continue the conversation.\n"
    f"Based on the conversation below, produce EXACTLY {n} short questions the user might ask next.\n"
    "Requirements:\n"
    "- Questions must be relevant to the preceding conversation.\n"
    "- Questions must be written in the same language as the user.\n"
    "- Keep each question concise (ideally <= 20 words / <= 40 Chinese characters).\n"
    "- Do NOT include numbering, markdown, or any extra text.\n"
    "- Output MUST be a JSON array of strings only.\n"
)

```

**逐条要求分析**：

**逐条要求分析**：

| 要求 | 目的 |
|---|---|
| 相关性 | 追问不能跑题 |
| 语言一致 | 用户说中文就生成中文追问 |
| 简洁（≤20词/≤40汉字） | 适合按钮展示 |
| 禁止编号/Markdown | 保证纯文本 JSON 可解析 |
| 固定 JSON 数组格式 | 结构化输出方便解析 |

### User Content（用户上下文）

```python
user_content = f"Conversation Context:\n{conversation}\n\nGenerate {n} follow-up questions"
```

其中 `conversation` 是 `_format_conversation()` 生成的格式化文本：

```
User: 用户的问题
Assistant: AI的回答
User: 用户的追问
```

### 输出解析

1. `_strip_think_blocks()` — 去除推理模型的 `<think>...</think>` 思维链（兼容 MiniMax-M3 等模型）
2. `_strip_markdown_code_fence()` — 去除代码块标记（部分模型会包裹 ```json）
3. `_parse_json_string_list()` — 从清理后的文本中提取 JSON 数组并解析

## 四、前端渲染与动画

动画代码位于 [suggestion.tsx](../../frontend/src/components/ai-elements/suggestion.tsx#L34-L50)。

### 交错动画实现

```typescript
const STAGGER_DELAY_MS = 60;        // 每个按钮间隔
const STAGGER_DELAY_MS_OFFSET = 250; // 整体偏移

<span
  className="animate-fade-in-up max-w-full opacity-0"
  style={{
    animationDelay: `${STAGGER_DELAY_MS_OFFSET + index * STAGGER_DELAY_MS}ms`,
  }}
>
```

- `animate-fade-in-up` — CSS 动画：从下方淡入升起
- 延迟计算公式：`250ms + 序号 × 60ms`，实现**依次错开飘出**

### 用户交互

- **输入框为空**：直接填入追问并 `setTimeout(0)` 自动提交表单
- **输入框有内容**：弹出确认对话框（`追加并发送` / `替换并发送`）
- **点击 X 按钮**：`setFollowupsHidden(true)` 隐藏追问栏
- **重新提交消息**：`setFollowups([])` 清空，`setFollowupsHidden(false)` 恢复

## 五、速查卡片

| 问题 | 答案 |
|---|---|
| 什么时候触发追问生成？ | streaming 结束瞬间（`wasStreaming && !streaming`） |
| 后端提示词要求用什么格式输出？ | JSON 字符串数组 |
| 追问上限几个？ | 前端最多展示 5 个，后端默认请求 3 个 |
| 追问用什么语言生成？ | 与用户消息语言一致 |
| 如何控制全局开关？ | `config.yaml -> suggestions.enabled` |
| 什么情况下不生成追问？ | 功能禁用 / disabled / isMock / 去重命中 / 无上下文 |
| 动画效果如何实现？ | `animate-fade-in-up` + 递增 `animationDelay` |

## 六、核心文件索引

| 文件 | 职责 |
|---|---|
| [input-box.tsx](../../frontend/src/components/workspace/input-box.tsx#L1678) | 追问触发 useEffect、状态管理、交互逻辑 |
| [suggestion.tsx](../../frontend/src/components/ai-elements/suggestion.tsx#L34) | Suggestions/Suggestion 组件、交错动画 |
| [api.ts](../../frontend/src/core/suggestions/api.ts) | 加载 suggestions config 的 API 封装 |
| [hooks.ts](../../frontend/src/core/suggestions/hooks.ts) | `useSuggestionsConfig` React Query hook |
| [suggestions.py](../../backend/app/gateway/routers/suggestions.py#L118) | 后端路由、提示词模板、输出解析 |
| [app.py](../../backend/app/gateway/app.py#L502) | 注册 suggestions 路由 |
