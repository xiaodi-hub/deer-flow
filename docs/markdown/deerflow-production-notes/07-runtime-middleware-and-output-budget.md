# Agent Runtime 中间件顺序与工具输出预算

[总目录](./README.md) | [Skill 治理](./05-skill-migration-secrets-and-tool-policy.md) | [Sandbox 契约](./04-sandbox-contract-and-errors.md)

## 问题 14：中间件链如何排序

当前项目将共享链集中在 [tool_error_handling_middleware.py](../../../backend/packages/harness/deerflow/agents/middlewares/tool_error_handling_middleware.py#L155)，并在后续附加 lead 专用中间件；[backend/AGENTS.md](../../../backend/AGENTS.md#middleware-chain) 还记录了实际顺序和 wrapping 语义。顺序不只是性能问题，它决定谁看到原始输入、谁可阻止副作用、谁最终将结果写给模型。

### 推荐的阶段模型

1. **入口净化与身份 context**：清理用户输入和伪造 provenance，验证 owner/内部属性；必须最外层，使所有重试都看到同一安全输入。
2. **线程数据与 memory 注入**：创建或验证 user/thread scope，读取经权限过滤、预算化、标记为不可信数据的长期记忆；然后完成 Skill 激活和它的 secret/tool policy 编译。
3. **Sandbox 绑定**：在工具真正执行前 acquire，并把 `sandbox_id` 写入 state；不应在输入净化之前启动资源。
4. **模型调用保护**：provider error normalization、token/context budget、模型重试。模型看到的工具 catalog 必须已按 Skill/授权过滤。
5. **工具执行 gate（由外到内）**：授权/guardrail -> read-before-write -> tool progress -> audit -> error normalization -> 实际 tool。所有会产生副作用的调用都必须穿过 policy 和审计；blocked 调用不应占用 progress 或造成 sandbox 副作用。
6. **工具结果处理（返回方向）**：先秘密净化/远程内容隔离，再按预算裁剪或外置，再标准化 ToolMessage 元数据，最后交回模型。
7. **收尾**：artifact 提取、memory 异步写队列、sandbox release、run terminal event。memory 写入只能消费净化后的用户内容，不能自动记录 secret/上传临时路径。

具体 wrapper 的进入/退出方向要单测。常见 bug：预算先于净化导致截断后遗漏 secret；Skill policy 在模型已拿到全量 catalog 后才装载；memory 注入在身份解析前读取错用户；Sandbox audit 在执行后才“审计”；read-before-write 在写后检查；release 在 SSE 尚需下载 artifact 前执行。

## 问题 18：工具输出预算应如何定义

当前 `ToolOutputBudgetMiddleware` 存在于共享运行时链，见 [实现](../../../backend/packages/harness/deerflow/agents/middlewares/tool_output_budget_middleware.py#L573)，并可将超大输出转为受控 artifact。预算不能只按 token：二进制、JSON、表格、图片、错误栈和网页的风险、费用与可读性完全不同。

### 多维预算策略

- **硬安全上限（字节）**：在 provider 返回/下载阶段限制单响应、单文件、累计 run 输出，先防内存与传输耗尽。
- **模型上下文上限（token）**：按模型 tokenizer 估算“可回灌文本”，为 system prompt、memory、用户消息和后续推理预留空间。
- **MIME/结构**：文本提取前限制解压比和递归；JSON 设深度/节点数；图片只传缩略图/视觉 token；未知/可执行 MIME 不直接内联。
- **工具类别**：搜索/抓取默认小摘要+引用，`read_file` 允许分页，数据库强制 LIMIT，shell 限 stdout/stderr；诊断工具可能保留更多但仍掩码。
- **配额层级**：系统硬上限不可突破；再取 tenant/用户计划/run 类型/Skill 的较小值。计划等级只能调体验阈值，不能放宽安全硬限制。

返回给模型的是“摘要 + 前 N 行 + 总大小 + artifact reference + 可分页/搜索提示”，而非静默截断。记录原始字节数、注入 token、截断原因、外置位置和 redaction 计数。对攻防测试输入 gzip bomb、百万行 JSON、secret 位于末尾、非 UTF-8、SSE 分片，验证预算先于不受控内存分配，净化覆盖完整原始流。
