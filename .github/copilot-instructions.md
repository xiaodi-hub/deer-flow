# Project Copilot Instructions

本项目已从 `.trae` 迁移为 VS Code Copilot 项目级自定义配置。所有通用开发、设计、规格、验证与过程留痕要求默认适用于本工作区。

# 通用规范指引 (Common Rules)

在进行项目分析、架构设计、接口设计、数据库设计及通用编码开发时，必须严格遵守以下规范文档。请通过相对路径查阅具体的规范详情：

- **[项目通用开发规范](./common/common_project_rules.md)**：包含基础的命令、代码注释、编译及数据库脚本规范。
- **[需求规格说明书 (PRD) 编写规范](./common/common_requirement_spec.md)**：用于业务需求分析与 PRD 编写。
- **[详细设计规范](./common/common_detailed_design.md)**：用于系统架构与核心业务逻辑的详细设计。
- **[API 接口设计规范](./common/common_api_design.md)**：用于前后端交互的 RESTful API 接口设计。
- **[数据库设计规范](./common/common_db_design.md)**：用于关系型数据库的物理模型与表结构设计。
- **[后端通用开发规范](./common/common_backend_rules.md)**：适用于所有后端语言的通用架构、安全与日志规范。
- **[前端通用开发规范](./common/common_frontend_rules.md)**：适用于所有前端项目的通用基础与工程化规范。
- **[UI/UX 原型设计与描述规范](./common/common_prototype_desc.md)**：用于将视觉原型拆解为结构化的前端组件与状态设计。
- **[Mermaid 绘图规范](./common/common_mermaid_master.md)**：在生成任何流程图、时序图时必须遵守的 Mermaid 语法防错规范。
- **[输出文件引用格式规范](./common/common_file_reference.md)**：AI 输出中引用文件时必须使用 `file:///` 绝对路径 markdown 链接。

## CodeGraph 使用方法论

当仓库根目录存在 `.codegraph/` 索引时，默认将 CodeGraph 作为**优先级最高的代码理解与定位手段**。

- **优先使用场景**：当需要理解某个功能如何工作、定位某个符号或文件、分析调用链、评估改动影响范围、查找某个入口如何流转到下游实现时，先使用 CodeGraph，而不是先做普通文本搜索或零散读文件。
- **推荐查询方式**：优先使用“符号名 + 文件名 + 意图关键词”的组合查询，例如 `xspec cli.ts runInitCommand init flow`，避免只查 `init`、`update` 这类高重名词。
- **大仓库收窄规则**：当工作区包含多个子项目、示例项目或测试项目时，查询时应尽量带上模块路径、包名、文件名或业务上下文，例如 `src/cli.ts`、`template writer`、`credential store`，减少跨子项目误命中。
- **结果使用原则**：若 CodeGraph 已返回相关符号的源码与调用路径，应将其视为已完成一次可靠读取，避免再用零碎方式重复读取同一段内容；仅在结果不完整或需要补充上下文时，再读取原文件。
- **编辑前要求**：在修改非显而易见的小范围代码前，先用 CodeGraph 查看目标符号及其上下游调用关系，确认影响面后再动手。
- **无索引回退**：如果目标项目没有 `.codegraph/`，再退回使用文件搜索、文本搜索和文件读取；是否建立索引由用户决定，不自动初始化。

## 前端页面设计规则

当用户要求“画前端页面”、设计 UI、生成前端界面，或评审前端视觉方案时，默认同时参考 `frontend-design-pro` 与 `ui-ux-pro-max` 这两个 skill 的规则。

### 需求不明确时

- 先询问再设计，不直接展开实现。
- 重点询问页面风格、视觉样式、目标端类型，例如 Web、小程序、手机端。
- 也可以继续追问产品类型、行业、目标用户、是否需要深色模式、偏好配色和技术栈。

### 样式已经明确时

- 直接调用这两个 skill 的设计规范进行设计与实现。
- 优先遵循可访问性、响应式、触控目标、字体与色彩系统、动效节制等要求。
- 避免常见 UI 反模式，尤其是卡片套卡片、低对比度文字、过度渐变、无意义弹性动效。

补充要求：

- 关键代码必须添加清晰注释，尤其是成员变量、静态变量以及方法。
- 方法注释应明确说明：函数用途、入参说明、返回值说明。
- 函数、方法、成员属性与字段必须尽量提供明确类型或类型注解。

## Copilot 项目级配置位置

- 语言/框架规则：`.github/instructions/*.instructions.md`
- 可复用任务提示：`.github/prompts/*.prompt.md`
- 自定义 agent：`.github/agents/*.agent.md`
- Agent Skills：`.github/skills/<skill-name>/SKILL.md`
- 通用参考文档：`.github/common/*.md`
