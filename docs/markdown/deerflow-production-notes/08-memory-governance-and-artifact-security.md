# 持久化 Memory 治理与 Artifact 安全

[总目录](./README.md) | [身份隔离](./03-identity-isolation-and-secrets.md) | [可观测性](./09-gateway-im-and-observability.md)

## 问题 15：多用户、多线程 memory 的删除、导出与审计

### 当前实现

DeerMem 存储接口已传递 `user_id`，文件缓存键也是 `(user_id, agent_name)`，见 [storage.py](../../../backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/storage.py#L46)。异步 memory queue 还保留 `thread_id`、`user_id`、`trace_id`，见 [queue.py](../../../backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/queue.py#L24)。prompt 模板对用户可编辑 memory 做边界转义，见 [prompt.py](../../../backend/packages/harness/deerflow/agents/memory/backends/deermem/deermem/core/prompt.py#L423)。

### 生产治理模型

每条 memory item 应包含：`memory_id`、tenant/owner、可选 thread scope、agent、内容/加密版本、来源 run/message、提取模型与 prompt version、置信度、敏感级别、状态（proposed/active/suppressed/deleted）、创建与失效时间。自动抽取先写入 **proposed** 或按低风险类别自动激活；用户可查看、修改、拒绝和锁定。高敏感项默认不自动写入，绝不把认证信息、上传路径、完整私密文档作为长期记忆。

删除必须是可证明的工作流：先立即 tombstone，阻止注入与读取；再从主库、向量索引、缓存、队列、备份保留策略和派生摘要中异步清除，记录完成证明。导出只能由 owner 或受委托管理员触发，使用短时下载 URL、审计并包含来源/版本；不得因为知道 thread id 就能导出。跨线程 memory 应为 user scope 且有用户可见说明，thread-private memory 不能被全局检索。

审计日志不可被 agent 改写，至少记录“谁/哪次 run 因何规则创建、更新、注入、删除了哪条 memory”，内容本身可只留 hash/受控快照。模型自动写入错误应可追溯、可撤销和可回放评估。

## 问题 19：Artifact 下载、MIME 与路径安全

当前 artifact router 位于 [artifacts.py](../../../backend/app/gateway/routers/artifacts.py#L1)，Sandbox 工具对路径逃逸和允许根目录已有多处检查，见 [tools.py](../../../backend/packages/harness/deerflow/sandbox/tools.py#L824)。这应视作基础，而不是完整的浏览器安全模型。

现有 router 已将 HTML/XHTML/SVG 强制作为 attachment 下载，并先将虚拟路径解析后约束在批准根目录，见 [artifacts.py](../../../backend/app/gateway/routers/artifacts.py#L20) 和 [path_utils.py](../../../backend/app/gateway/path_utils.py#L11)。生产改造的重点是把这一少量扩展名规则扩大为内容检测、响应头和独立预览 origin 的完整策略。

### 下载链路的安全规则

1. **对象授权优先**：artifact DB 元数据含 immutable `artifact_id, owner_id, thread_id, sandbox_id, logical_path, content_hash`。下载按 `artifact_id + owner` 查，不接受客户端任意物理路径；内部代理也必须有受信任 owner。
2. **路径解析**：logical path 只允许受限相对路径；join 后 `resolve()`，验证 `is_relative_to(approved_root)`，拒绝 symlink escape、Windows device path、NUL、重复编码和 TOCTOU。打开文件时尽可能使用文件描述符/`O_NOFOLLOW`。
3. **类型判定**：同时比较声明 MIME、magic bytes 和扩展名；默认 `application/octet-stream` 下载。所有用户/Sandbox 产生的 HTML、SVG、PDF、Office、JS 都是不可信 active content。
4. **展示隔离**：HTML/SVG/可能脚本的内容使用 attachment 下载或独立无 cookie 的 sandbox origin + CSP `sandbox`；禁止同源 inline、`Content-Disposition: inline` 与可执行 `nosniff` 缺失的组合。图片/PDF 预览也经大小、解析器和内容安全策略限制。
5. **可用性与审计**：限制体积、范围请求和下载频率，扫描恶意文件；下载和预览记入 audit。artifact URL 用短 TTL、单对象、绑定 owner/会话，撤销/删除后立即失效。

不要依据 `.html` 后缀或“来自本地 sandbox”放松规则：agent 可生成攻击性文件，Sandbox 与浏览器是不同信任域。
