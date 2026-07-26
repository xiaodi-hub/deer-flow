#!/usr/bin/env python3
"""Generate DeerFlow split config directories with Chinese comments."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

import yaml

CONFIG_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("app.yaml", ("config_version", "log_level", "logging", "max_recursion_limit")),
    ("llm.yaml", ("models",)),
    ("token.yaml", ("token_usage", "token_budget")),
    ("context.yaml", ("uploads", "summarization", "memory")),
    ("prompt.yaml", ("title", "input_polish", "suggestions", "safety_finish_reason")),
    ("tool.yaml", ("tool_groups", "tools", "tool_search", "tool_output", "loop_detection", "tool_progress", "read_before_write", "guardrails")),
    ("agent.yaml", ("agents_api", "acp_agents", "subagents", "channel_connections", "channels")),
    ("skill.yaml", ("skills", "skill_scan", "skill_evolution")),
    ("runtime.yaml", ("sandbox", "database", "checkpointer", "run_events", "scheduler", "stream_bridge", "run_ownership")),
    ("security.yaml", ("auth", "authorization", "circuit_breaker")),
)

FILE_HEADERS: dict[str, str] = {
    "app.yaml": """# DeerFlow 基础配置
# 这里放全局版本、日志级别、请求 trace 关联和运行递归上限。
# config_version 用于提醒本地配置是否落后于 config.example/。
""",
    "llm.yaml": """# DeerFlow 大模型配置
# models 定义前端可选模型和 agent 实际调用的 provider 参数。
# 每个模型的 use 是 LangChain ChatModel 类路径；api_key 建议使用 $ENV_VAR 引用 .env。
""",
    "token.yaml": """# DeerFlow Token 配置
# token_usage 控制 token 使用量采集与展示。
# token_budget 控制单次 run 的 token 预算、预警和强制收尾策略。
""",
    "context.yaml": """# DeerFlow 上下文配置
# uploads 控制上传文件和文档转换。
# summarization 控制长对话压缩策略。
# memory 控制用户/agent 长期记忆的提取、存储、注入和过期审查。
""",
    "prompt.yaml": """# DeerFlow Prompt 行为配置
# 这些配置不直接存放完整 system prompt，而是控制标题生成、输入润色、后续建议和安全 finish_reason 等 prompt 周边行为。
""",
    "tool.yaml": """# DeerFlow 工具配置
# tools/tool_groups 定义可用工具及分组。
# tool_search/tool_output/tool_progress/loop_detection/read_before_write/guardrails 控制工具发现、预算、安全和防循环中间件。
""",
    "agent.yaml": """# DeerFlow Agent 配置
# agents_api 控制自定义 agent 管理 API。
# acp_agents/subagents 控制外部 agent 与子 agent。
# channel_connections/channels 控制 IM 平台连接。
""",
    "skill.yaml": """# DeerFlow Skill 配置
# skills 控制 skill 搜索路径和容器内挂载路径。
# skill_scan 控制安装/执行前的安全扫描。
# skill_evolution 控制 agent 自主创建和修改 skill 的能力。
""",
    "runtime.yaml": """# DeerFlow 运行时配置
# sandbox 控制执行沙箱。
# database/checkpointer/run_events 控制持久化。
# scheduler/run_ownership/stream_bridge 控制后台调度、多 worker 运行归属和流式事件桥。
""",
    "security.yaml": """# DeerFlow 安全配置
# auth 控制登录和 OIDC。
# authorization 控制资源访问授权。
# circuit_breaker 控制 LLM 连续失败后的熔断保护。
""",
    "mcp.yaml": """# DeerFlow MCP 与公共 Skill 状态配置
# mcpServers 定义 MCP server。
# skills 记录公共 skill 的启用/禁用状态。
# 这里使用 YAML 是为了保留中文注释；UI/API 写回也会写到本文件。
""",
}

KEY_COMMENTS: dict[str, str] = {
    "config_version": "配置版本号；升级模板时用于提示本地配置是否需要补字段。",
    "log_level": "DeerFlow 自身日志级别：debug/info/warning/error。",
    "logging": "请求 trace 关联日志配置，影响 X-Trace-Id、日志字段和 Langfuse deerflow_trace_id。",
    "max_recursion_limit": "服务端允许客户端传入的 LangGraph recursion_limit 上限，防止 runaway run。",
    "models": "可用大模型列表；至少需要一个有效模型才能正常聊天。",
    "token_usage": "是否采集并展示模型返回的 token usage。",
    "token_budget": "单次 run 的 token 预算和超限处理策略。",
    "uploads": "上传文件、文档转换和上传上下文注入相关配置。",
    "summarization": "长上下文自动/手动摘要压缩配置。",
    "memory": "长期记忆存储、提取、注入和陈旧记忆审查配置。",
    "title": "自动生成会话标题的配置。",
    "input_polish": "发送前输入润色配置。",
    "suggestions": "后续问题建议配置。",
    "safety_finish_reason": "provider 安全过滤 finish_reason 的拦截和提示策略。",
    "tool_groups": "工具分组，agent 可按组启用工具。",
    "tools": "动态工具配置，use 指向工具变量或工厂路径。",
    "tool_search": "延迟工具发现配置，用于 MCP 工具较多时降低 prompt token。",
    "tool_output": "工具输出预算配置，避免大结果撑爆上下文。",
    "loop_detection": "模型/工具重复循环检测配置。",
    "tool_progress": "工具进展状态机配置，用于识别无效重试和停滞。",
    "read_before_write": "读后写保护配置，避免基于过期上下文覆盖文件。",
    "guardrails": "工具调用前授权/策略拦截配置。",
    "agents_api": "自定义 agent 管理 API 配置。",
    "acp_agents": "ACP 兼容外部 agent 配置。",
    "subagents": "子 agent 委派、并发、超时和 token 预算配置。",
    "channel_connections": "用户自助绑定 IM 账号的连接配置。",
    "channels": "Slack/Telegram/Feishu/DingTalk 等 IM channel 运行配置。",
    "skills": "skill 路径、容器路径和延迟发现配置。",
    "skill_scan": "skill 安全扫描配置。",
    "skill_evolution": "agent 创建/修改 skill 的能力开关和限制。",
    "sandbox": "沙箱 provider、镜像、路径挂载和安全策略配置。",
    "database": "统一数据库配置；控制 checkpointer、run、thread、user 等持久化后端。",
    "checkpointer": "可选 legacy checkpointer 配置；存在时优先于 database。",
    "run_events": "run 事件存储配置，控制执行轨迹和消息事件持久化。",
    "scheduler": "计划任务后台调度器配置，Gateway 启动时读取。",
    "stream_bridge": "SSE 流事件桥配置，单进程用 memory，多 worker/Docker 推荐 redis。",
    "run_ownership": "多 worker run 租约、心跳和孤儿恢复配置。",
    "auth": "登录、本地账号和 OIDC SSO 配置。",
    "authorization": "细粒度资源授权配置。",
    "circuit_breaker": "LLM 连续失败熔断配置。",
    "mcpServers": "MCP server 配置表，key 是 server 名称。",
}


def _yaml_dump(data: dict[str, Any]) -> str:
    return yaml.safe_dump(data, default_flow_style=False, allow_unicode=True, sort_keys=False)


def _render_file(name: str, data: dict[str, Any]) -> str:
    lines = [FILE_HEADERS[name].rstrip(), ""]
    for key, value in data.items():
        comment = KEY_COMMENTS.get(key)
        if comment:
            lines.append(f"# {comment}")
        dumped = _yaml_dump({key: value}).rstrip()
        lines.append(dumped)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a YAML mapping")
    return data


def load_extensions(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"mcpServers": {}, "skills": {}}
    if path.suffix.lower() in {".yaml", ".yml"}:
        return load_yaml(path)
    with path.open(encoding="utf-8") as f:
        data = json.load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def split_config(source: Path, target_dir: Path, *, overwrite: bool = False) -> None:
    source_data = load_yaml(source)
    if target_dir.exists() and overwrite:
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    consumed: set[str] = set()
    for file_name, keys in CONFIG_GROUPS:
        group_data = {key: source_data[key] for key in keys if key in source_data}
        consumed.update(group_data)
        if group_data:
            (target_dir / file_name).write_text(_render_file(file_name, group_data), encoding="utf-8")

    extra_data = {key: value for key, value in source_data.items() if key not in consumed}
    if extra_data:
        (target_dir / "extra.yaml").write_text(_render_file("app.yaml", extra_data), encoding="utf-8")


def write_mcp_config(source: Path, target_dir: Path) -> None:
    data = load_extensions(source)
    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / "mcp.yaml").write_text(_render_file("mcp.yaml", data), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("config.yaml"), help="完整 YAML 配置源文件")
    parser.add_argument("--extensions-source", type=Path, default=Path("extensions_config.json"), help="MCP/skill 状态源文件，可为 JSON 或 YAML")
    parser.add_argument("--target-dir", type=Path, default=Path("config"), help="输出的配置目录")
    parser.add_argument("--overwrite", action="store_true", help="覆盖已存在的目标目录")
    args = parser.parse_args()

    split_config(args.source, args.target_dir, overwrite=args.overwrite)
    write_mcp_config(args.extensions_source, args.target_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
