# 会话笔记约定 (Session Notes Convention)

> 每次会话结束后，将讨论内容整理为结构化笔记，写入 `docs/markdown/` 目录。

## 规则

### 1. 文件命名

- 技术笔记：`p{序号}-{短横线分隔的英文主题}.md`，如 `p04-agent-lifecycle-and-concurrency.md`
- 序号递增，参考已有文件（p01、p02、p03...）
- 一个文件覆盖一个主题领域，避免一个文件过长

### 2. 文件结构

每篇笔记应包含：

```markdown
# DeerFlow {主题中文描述} 复习笔记（p{序号}）

> 学习目标：一句话说明这篇笔记要解决什么问题。

---

## 一、{第一个核心概念}

### 核心事实
### 代码证据（含源码相对路径链接）
### 图示（mermaid 或 ASCII art）

## 二、{第二个核心概念}

...

## 五、速查卡片（可选）

| 问题 | 答案 |
|---|---|
| ... | ... |

### 核心文件索引（可选）

| 文件 | 职责 |
|---|---|
| ... | ... |
```

### 3. 代码引用约定

所有源码引用使用可点击的 Markdown 链接（相对路径 + 行号锚点），**不使用**反引号包裹的文件名：

```markdown
正确：[agent.py](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L443)
错误：`agent.py`
```

```markdown
- [工厂函数](../../backend/packages/harness/deerflow/agents/lead_agent/agent.py#L443)
- [前端入口](../../frontend/src/app/workspace/agents/new/page.tsx)
```

### 4. 语言与风格

- 主体使用中文
- 代码块、API 名称、文件名使用英文原文
- 关键结论用 **加粗** 标注
- 使用表格做对比，使用 ASCII 图或 mermaid 画流程

### 5. 会话结束时的操作

当用户说"整理成笔记"时：

1. 回顾本次会话讨论的所有话题
2. 按主题分类，判断是写入已有笔记还是新建笔记
3. 新建笔记时，确认序号不重复
4. 写入完整、可独立阅读的笔记（不能只写摘要）
5. 告知用户新建了哪些文件
