# Skill 治理：迁移、密钥资格与工具授权

[总目录](./README.md) | [身份隔离与密钥](./03-identity-isolation-and-secrets.md) | [运行时中间件](./07-runtime-middleware-and-output-budget.md)

## 问题 7：从全局 custom skills 迁移到用户隔离 custom skills

### 当前实现

Skill 有 `public/custom/legacy` 分类；router 对 custom skill 提供编辑、版本历史、回滚与安全扫描，见 [skills router](../../../backend/app/gateway/routers/skills.py#L258)。现有 storage 相关测试覆盖 user scope，见 [test_user_scoped_skill_storage.py](../../../backend/tests/test_user_scoped_skill_storage.py)。legacy 的关键定位应是“发现与兼容可读，但不可修改”，而不是和新 custom 共享写路径。

仓库还提供了 [migrate_user_isolation.py](../../../backend/scripts/migrate_user_isolation.py#L133) 作为单机迁移基线，支持 dry-run、按用户迁移和将冲突移入审查目录。多副本环境仍应在它之外加维护锁/manifest，不能让多个实例同时移动同一目录。

### 分阶段迁移

1. **盘点与冻结**：为旧全局目录建立 manifest（skill 名、hash、来源、扫描结果、最后修改时间），在 UI/API 标记 legacy、只读，写审计事件。
2. **建立新命名空间**：`users/{safe_user_id}/skills/{skill_id}/{revision}`，元数据表有 owner、revision、content hash、状态和迁移来源。名字不是主键，避免同名覆盖。
3. **惰性复制而非隐式共享**：用户第一次“采用”某 legacy skill 时，做服务器端 copy-on-write，重新静态扫描，创建用户私有 revision；未采用时只读展示。绝不能因一个用户编辑而修改全局文件。
4. **冲突与回滚**：同名 legacy/custom 明确优先级或强制改名；每次内容变更新建 revision，运行中的 run 固定使用开始时的 hash。保留旧 revision 一段可配置期限。
5. **权限与退场**：管理员只管理 public/全局策略；普通用户仅管理自己的 custom；删除用户时删除其私有 content、索引、缓存和历史，legacy 保留只读直到迁移窗口结束。

迁移正确性测试必须覆盖：A 用户不可列出/读取/覆盖 B 的 skill，legacy 写入被拒绝，迁移重试幂等，旧 run 可复现原 revision，恶意 zip/markdown 仍经扫描。

## 问题 8：`secrets_autonomous` 的判定标准

当前激活中间件在自动上下文要求 secret 时检查 `secrets_autonomous`，而显式 slash activation 可以不同，见 [skill_activation_middleware.py](../../../backend/packages/harness/deerflow/agents/middlewares/skill_activation_middleware.py#L495)；相关回归测试在 [test_skill_request_scoped_secrets.py](../../../backend/tests/test_skill_request_scoped_secrets.py#L756)。

注意当前 frontmatter 语义中该字段默认可为 true，解析失败才 fail-closed 为 false，见 [types.py](../../../backend/packages/harness/deerflow/skills/types.py#L25)。下文的“默认 false”是生产部署的更保守 policy 建议：可通过全局策略覆盖或在安装审核时强制，而非宣称当前行为已经如此。

默认应为 **false（显式授权）**。只有满足全部条件才允许 true：

- 用户已对该 skill + secret scope 做过可撤销的持久同意，且 identity 已解析；
- Skill publisher/revision 被信任，静态扫描和工具 allowlist 通过；
- secret 是最小权限、可轮转、短 TTL，不是人类登录密码/高权限通用 API key；
- 自动激活可由确定性意图规则解释，且不会因普通文本或远程网页内容被 prompt injection 触发；
- 绑定前再检查 tenant、用户计划、网络目的地和当前 policy，且审计记录 reason、skill hash、secret handle，不记录值。

“模型认为相关”绝不是授权依据。敏感金融、生产写入、个人数据、跨域 OAuth scope 一律要求显式 slash/确认，或将工具设计成先生成计划、再由用户确认。

## 问题 9：`allowed_tools` 在哪里 enforce

采用多层但单一权威：

| 层 | 应承担的责任 | 不能作为唯一防线的原因 |
| --- | --- | --- |
| Prompt | 告知模型激活 skill 的目标与可用工具 | 模型可忽略或被注入 |
| Tool registry/factory | 在 run 起始从允许集构建可见 tool list，减少误调用 | 动态 tool/MCP 或旧引用仍可能绕过 |
| Middleware | 每次 `ToolCallRequest` 用 active-skill policy、owner、run context 拒绝并审计 | 必须在所有 agent/subagent 链中安装 |
| Sandbox/外部服务 | 对 shell 路径、网络、secret、文件挂载实施不可绕过的资源能力 | 不知道高层 skill 意图 |

当前有专门的 [SkillToolPolicyMiddleware](../../../backend/packages/harness/deerflow/agents/middlewares/skill_tool_policy_middleware.py#L1)，subagent 也会过滤工具，见 [executor.py](../../../backend/packages/harness/deerflow/subagents/executor.py#L590)。推荐将 policy 编译为不可变 `EffectiveToolPolicy`，绑定 `run_id + skill_revision + identity + catalog_version`；所有普通工具、MCP 和 subagent tool call 都在 middleware 复核。拒绝结果应是模型可恢复的安全 ToolMessage，不泄露被禁工具的内部细节。
