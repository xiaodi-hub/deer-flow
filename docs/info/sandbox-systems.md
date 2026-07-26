# 沙箱系统总览

这份笔记只讲一个问题：DeerFlow 里“沙箱”到底是什么，为什么有多种实现，它们各自负责什么。

## 先记住三层

1. `Sandbox` 是能力接口，定义了 `execute_command`、`read_file`、`write_file`、`list_dir` 等文件/命令操作。
2. `SandboxProvider` 是生命周期入口，负责 `acquire`、`get`、`release`、`reset`。
3. 具体 provider 才决定“沙箱落在哪里”：本机文件系统、Docker 容器、K8s/Provisioner、e2b 云 VM、BoxLite 微虚拟机。

换句话说，工具层只面对 `Sandbox`，中间那层 provider 决定隔离方式。

## 它们在解决什么问题

沙箱的目标不是“能跑命令”这么简单，而是把一次对话的文件、输出、技能目录和执行环境隔离开。

在这个项目里，沙箱还承担两件事：

- 把 `/mnt/user-data/...` 这套虚拟路径稳定地映射到真实存储。
- 让 lead agent、子代理、IM 渠道、文件工具都看到同一套线程级工作区语义。

## 各种沙箱的区别

### 1. `LocalSandboxProvider`

文件：`[backend/packages/harness/deerflow/sandbox/local/local_sandbox_provider.py](/G:/2026github/deer-flow/backend/packages/harness/deerflow/sandbox/local/local_sandbox_provider.py)`

作用：本机文件系统沙箱。它不是容器隔离，而是把虚拟路径映射到主机上的线程目录。

特点：

- `thread_id=None` 时保留旧的全局 `local` 单例。
- `thread_id` 存在时，会生成 `local:{user_id}:{thread_id}` 这样的线程级沙箱。
- 默认缓存线程沙箱，并做 LRU 淘汰。
- `uses_thread_data_mounts = True`，所以线程目录会直接挂进路径映射里。
- `allow_host_bash` 只对这个 provider 有意义，而且默认是危险关闭。

适合：本地开发、调试、对文件映射和路径解析做验证。

### 2. `AioSandboxProvider`

文件：`[backend/packages/harness/deerflow/community/aio_sandbox/aio_sandbox_provider.py](/G:/2026github/deer-flow/backend/packages/harness/deerflow/community/aio_sandbox/aio_sandbox_provider.py)`

作用：容器沙箱 provider。它本身不决定“容器怎么起”，而是委托给一个 backend。

它内部有两种 backend：

- `LocalContainerBackend`：在本机 Docker / Apple Container 里起容器。
- `RemoteSandboxBackend`：通过 `provisioner` 让 K8s/k3s 创建 Pod + Service。

你可以把它理解成“统一的容器沙箱入口”：同一个 provider，后面接本地容器或远程 provisioner。

特点：

- 有 warm pool，释放后不一定销毁，方便复用。
- 有 idle timeout 和 replicas 上限。
- 会做容器发现、存活检查、孤儿回收。
- 本地容器模式下，线程数据目录是 bind mount；远程模式下要通过 provisioner 暴露。
- `uses_thread_data_mounts` 取决于 backend；本地容器是 `true`，远程则不是。

适合：默认推荐的隔离模式，尤其是需要真正 shell 隔离、容器隔离、复用启动成本的时候。

### 3. `E2BSandboxProvider`

文件：`[backend/packages/harness/deerflow/community/e2b_sandbox/e2b_sandbox_provider.py](/G:/2026github/deer-flow/backend/packages/harness/deerflow/community/e2b_sandbox/e2b_sandbox_provider.py)`

作用：接 e2b cloud 的远程沙箱。

特点：

- `uses_thread_data_mounts = False`，因为它没有共享宿主机文件系统。
- 需要 `api_key`，可选 `domain`、`template`、`home_dir`。
- 释放后也有 warm pool 概念。
- 会把 DeerFlow 约定的 `/mnt/user-data/...` 目录在 VM 里 bootstrap 出来，再同步挂载内容。
- 还会在释放时把产物镜像回宿主线程目录。

适合：云上远程隔离、和本机 Docker 不同的托管沙箱场景。

### 4. `BoxliteProvider`

文件：`[backend/packages/harness/deerflow/community/boxlite/provider.py](/G:/2026github/deer-flow/backend/packages/harness/deerflow/community/boxlite/provider.py)`，`[backend/packages/harness/deerflow/community/boxlite/box.py](/G:/2026github/deer-flow/backend/packages/harness/deerflow/community/boxlite/box.py)`

你现在先把它记成“社区里的微虚拟机沙箱 provider”，它也是独立隔离实现，不是 Local 也不是 AIO。

如果后面你要深入 BoxLite，我建议下一步单独读它自己的 provider 和测试，不要和 AIO 一起混着看。

## 配置是怎么选 provider 的

关键入口在：

- `[backend/packages/harness/deerflow/config/sandbox_config.py](/G:/2026github/deer-flow/backend/packages/harness/deerflow/config/sandbox_config.py)`
- `[backend/packages/harness/deerflow/sandbox/sandbox_provider.py](/G:/2026github/deer-flow/backend/packages/harness/deerflow/sandbox/sandbox_provider.py)`

最重要的字段是 `sandbox.use`：它是 provider 的类路径。

常见配置键：

- `use`：选哪个 provider。
- `allow_host_bash`：只对 Local 有意义。
- `image`、`port`、`container_prefix`、`replicas`、`idle_timeout`：AIO / 容器类 provider 常用。
- `mounts`、`environment`：给容器或远程沙箱注入目录和环境变量。
- `provisioner_api_key`：AIO 走 provisioner 时使用。
- `health_check_skip_seconds`：BoxLite 专用。

## 工具调用链

真正被 agent 用到的不是 provider 本身，而是工具层：

- `[backend/packages/harness/deerflow/sandbox/middleware.py](/G:/2026github/deer-flow/backend/packages/harness/deerflow/sandbox/middleware.py)` 负责在 agent 生命周期里 acquire / release。
- `[backend/packages/harness/deerflow/sandbox/tools.py](/G:/2026github/deer-flow/backend/packages/harness/deerflow/sandbox/tools.py)` 把 `bash`、`ls`、`read_file`、`write_file`、`str_replace` 这些工具接到当前 sandbox 上。

所以你读沙箱代码时，顺序最好是：

1. `sandbox.py` 看抽象接口。
2. `sandbox_provider.py` 看单例与生命周期。
3. `local_sandbox_provider.py` 看本机路径映射。
4. `aio_sandbox_provider.py` 看容器 / provisioner 路径。
5. `e2b_sandbox_provider.py` 看远程云 VM 路径。
6. `middleware.py` 和 `tools.py` 看它怎么被 agent 真正用起来。

## 你该特别注意的差异

- Local 重点是“路径映射正确”和“线程隔离语义稳定”。
- AIO 重点是“容器生命周期 + warm pool + backend 选择”。
- E2B 重点是“远程 VM、权限、bootstrap、回同步”。
- BoxLite 重点是“独立 VM 式隔离”，后续再单独读。





更准确地说：DeerFlow 使用 sandbox，是为了把 agent 的命令执行从“直接操作宿主机”变成“在受控工作区里执行”。命令是否安全，则需要再通过策略、权限、路径限制、网络限制、超时、审计和人工确认来共同判断。

## 下一步推荐

- 想理解“agent 为什么能读写文件”，先读 `sandbox.py` 和 `tools.py`。
- 想理解“为什么一个 thread 会复用同一个沙箱”，先读 `sandbox_provider.py`。
- 想理解“本机和 Docker 的差别”，先读 `local_sandbox_provider.py` 和 `aio_sandbox_provider.py`。
- 想理解“云沙箱怎么接进来”，再读 `e2b_sandbox_provider.py`。
