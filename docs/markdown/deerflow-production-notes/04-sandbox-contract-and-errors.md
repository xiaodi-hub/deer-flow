# Sandbox 契约、错误模型与环境变量安全

[总目录](./README.md) | [身份隔离与密钥](./03-identity-isolation-and-secrets.md) | [可观测性](./09-gateway-im-and-observability.md)

## 问题 5：多 provider 的统一错误模型

### 当前实现

抽象接口在 [sandbox.py](../../../backend/packages/harness/deerflow/sandbox/sandbox.py#L44)，已有 `SandboxError`、`SandboxNotFoundError`、`SandboxRuntimeError`、`SandboxCommandError`、文件/权限子类，见 [exceptions.py](../../../backend/packages/harness/deerflow/sandbox/exceptions.py#L1)。不过 Local、AIO、E2B、Boxlite 仍能抛出 `RuntimeError`、`OSError` 或 provider 原始异常，说明上层不能只靠异常类名推断恢复策略。

另一个不一致点是部分远程 provider 将失败编码为 `"Error: ..."` 普通输出而非异常，例如 [AIO 实现](../../../backend/packages/harness/deerflow/community/aio_sandbox/aio_sandbox.py#L203)。这会让重试性、超时、HTTP/provider request id 和安全脱敏依赖脆弱的字符串解析；改造应同时消除这种双轨返回语义。

### 推荐：稳定错误 envelope + 原因链

将所有 provider 异常在 provider adapter 边缘转换为不可变 `SandboxFailure`：

```text
kind: NOT_FOUND | PERMISSION_DENIED | INVALID_ARGUMENT | TIMEOUT |
      RESOURCE_EXHAUSTED | UNAVAILABLE | COMMAND_FAILED | IO_FAILED | INTERNAL
retryable: bool            retry_after_ms: optional
operation: acquire | execute | read | write | release
sandbox_id/provider: safe identifiers
provider_code: optional stable code
diagnostic_id: opaque reference to restricted raw detail
```

`COMMAND_FAILED` 不是系统错误，应包含 exit code、截断且净化后的 stdout/stderr；`TIMEOUT` 应说明命令是否已终止；`UNAVAILABLE` 与 `RESOURCE_EXHAUSTED` 可触发退避/重建；`PERMISSION_DENIED` 和 `INVALID_ARGUMENT` 不重试。上层 agent 只看 `kind/retryable/user_message`，SRE 才通过 `diagnostic_id` 查受控的 provider 原因链。异常转换点必须保留 `raise ... from exc` 给内部 trace，但不可把原始 `str(exc)`返回模型。

为每个 provider 跑同一契约套件：超时、失联、关闭后调用、路径逃逸、读不到文件、非零退出、容量不足。这样新 provider 不能只“能跑”，还必须满足相同的恢复语义。

## 问题 6：POSIX 环境变量名校验的意义与 shell 风险

抽象层校验键匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，并明确指出是为了保护 shell 型实现，见 [sandbox.py](../../../backend/packages/harness/deerflow/sandbox/sandbox.py#L6)。这使 `FOO=bar command`、Docker env 和远程 API 获得一致、可移植的名称集合，也防止不同 provider 对 `=`、空格、换行、控制字符有不同解释。

若某实现未来用字符串拼接，例如 `sh -c "$key=$value $command"`，攻击者可通过 key 注入 `; curl ...`、`$(...)`、重定向，或把 key 拼成 shell option。只校验 key **不足以**保护 value 和 command：value 可能带换行/引号/命令替换，command 本身也必须经过既有安全策略。

正确实现优先使用无 shell 的 exec API：`subprocess.run(argv, env=merged_env, shell=False)`，Docker/HTTP provider 用结构化 env map。确需 shell 时，以 argv 调 shell、把 env 交给进程 API，而非拼接前缀；严禁把 secret 打入命令字符串。Local 实现也在执行前再次校验，见 [local_sandbox.py](../../../backend/packages/harness/deerflow/sandbox/local/local_sandbox.py#L466)，这是合理的纵深防御。
