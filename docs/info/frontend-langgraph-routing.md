# Frontend LangGraph Routing

## 结论

前端**默认不直接连外部 LangGraph 服务**。它构造的是同源地址 `/api/langgraph`，浏览器请求先经过 Next.js / nginx，再由 Gateway 转到它自己的 `/api/*` 路由。

只有在显式设置 `NEXT_PUBLIC_LANGGRAPH_BASE_URL` 时，前端才会改用外部 LangGraph 地址。

## 实际调用链

标准开发 / Docker 流程：

`frontend -> /api/langgraph/* -> nginx / Next.js rewrite -> Gateway /api/* -> LangGraph runtime`

对应代码：

- [frontend/src/core/config/index.ts](../../frontend/src/core/config/index.ts) 的 `getLangGraphBaseURL()` 默认返回 `window.location.origin/api/langgraph`
- [frontend/next.config.js](../../frontend/next.config.js) 在未设置 `NEXT_PUBLIC_LANGGRAPH_BASE_URL` 时，把 `/api/langgraph` 重写到 Gateway 的 `/api`
- [backend/app/gateway/langgraph_auth.py](../../backend/app/gateway/langgraph_auth.py) 和后端网关路由承接实际的 LangGraph 兼容接口

## 为什么这样设计

1. 保持浏览器同源访问，减少 CORS 和 cookie / CSRF 配置复杂度。
2. 让前端只面向一个统一入口，部署时可以通过网关和 nginx 切换内外部地址。
3. Gateway 不只是转发，它还负责认证、会话、线程、运行态和其他应用级 API，LangGraph 只是其中一部分能力。
4. 在本地开发和 Docker 场景里，默认用 `http://localhost:2026` 这一条统一入口，和 README / `AGENTS.md` 的运行方式一致。

## 相关环境变量

- `NEXT_PUBLIC_LANGGRAPH_BASE_URL`: 显式指定前端直连的 LangGraph 基址
- `DEER_FLOW_INTERNAL_GATEWAY_BASE_URL`: Next.js 内部重写目标，默认 `http://127.0.0.1:8001`
- `NEXT_PUBLIC_BACKEND_BASE_URL`: 影响其他 `/api/*` 路由是否直连 Gateway

## 维护提示

- 如果要改前端 LangGraph 的入口，先同步检查 `frontend/src/core/config/index.ts` 和 `frontend/next.config.js`。
- 如果要改统一入口行为，再检查 `docker/nginx/nginx.conf`、`docker/nginx/nginx.local.conf` 以及 Gateway 路由测试。

## 命令执行逻辑

这里的“执行”不是“先在虚拟环境跑一遍，再在宿主机跑一遍”。一条命令只会被工具层接收一次，然后按当前沙箱模式决定落到哪里执行。

### 1. 哪些命令会走执行器

- 需要读文件、写文件、更新文件、删文件、跑 shell、启动服务的操作，都会先变成对应的工具调用。
- 普通聊天不会执行命令。
- 如果当前技能或工具策略不允许 `bash`，那条命令不会进入执行阶段。

更细一点说，当前仓库里常见的文件类能力是这些：

- `read_file_tool`
- `write_file_tool`
- `glob_tool`
- `grep_tool`
- `update_file` / `write_file` 这类写入更新路径

我没有在 sandbox 工具层里看到一个通用的 `delete_file_tool`；所以你说的“删除文件命令”，通常指的是 shell 里的 `rm` 之类命令，或者更上层的业务删除接口，不是一个额外的沙箱预演步骤。

### 2. 命令是怎么跑的

调用链大致是：

`agent/tool decision -> sandbox tool -> runtime 取出 sandbox -> local sandbox 或其他 sandbox 实现 -> 真正执行一次`

在 `bash_tool()` 里会先做一轮策略与路径检查，再决定是否真正执行：

- 先看当前配置是否允许宿主机 bash
- 再检查本次命令里的绝对路径、`file://`、目录越界等问题
- 如果是本地 sandbox，就把虚拟路径映射到本地路径后执行
- 如果不是本地 sandbox，就把命令交给当前 sandbox provider 执行

所以它不是“虚拟环境预演 + 宿主机再执行”的双跑模型，而是“先判定，再单次执行”的模型。

### 3. 如何判断高风险

这个项目里没有一个“把所有命令先做语义模拟”的通用高风险引擎。高风险主要靠分层约束：

1. **工具层是否放行**：`get_available_tools()` 会根据 `is_host_bash_allowed()` 决定要不要暴露宿主机 `bash`。
2. **路径与参数检查**：`validate_local_bash_command_paths()` 会拦掉 `file://`、越界路径、未允许的绝对路径等。
3. **沙箱边界**：真正的执行后端是当前 sandbox provider，不是先模拟一遍再决定。

换句话说，系统主要判断的是“这条命令能不能执行、能在哪一层执行、允许访问哪些路径”，而不是“先把它跑一遍看结果安不安全”。

### 4. 需要特别注意的点

- `sandbox.allow_host_bash: true` 是显式开关，默认不是开放宿主机 bash。
- 本地 sandbox 下的 `bash` 会走路径重写和校验；远程 / AIO sandbox 则交给对应实现。
- 文件删除如果是 shell 命令，就只是 `bash rm ...` 这一条路；如果是线程、上传、记忆这类业务对象删除，则走各自的 Gateway/API 端点，不走 sandbox 文件执行器。
