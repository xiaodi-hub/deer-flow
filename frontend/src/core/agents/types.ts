export interface Agent {
  name: string;
  display_name?: string | null;
  description: string;
  category?: string | null;
  icon?: string | null;
  tags: string[];
  model: string | null;
  tool_groups: string[] | null;
  mcp_servers?: string[] | null;
  mcp_tools?: string[] | null;
  skills: string[] | null;
  memory?: {
    read: Array<"global" | "agent">;
    write: {
      default: "global" | "agent";
      stable_user_preferences: "global" | "agent";
    };
  };
  workspace?: {
    mode: "thread" | "agent" | "custom";
    path?: string | null;
    isolate_threads: boolean;
    allowed_paths: string[];
  };
  starter_prompts: string[];
  enabled: boolean;
  soul?: string | null;
}

export interface CreateAgentRequest {
  name: string;
  display_name?: string | null;
  description?: string;
  category?: string | null;
  icon?: string | null;
  tags?: string[];
  model?: string | null;
  tool_groups?: string[] | null;
  mcp_servers?: string[] | null;
  mcp_tools?: string[] | null;
  skills?: string[] | null;
  memory?: Agent["memory"] | null;
  workspace?: Agent["workspace"] | null;
  starter_prompts?: string[];
  enabled?: boolean;
  soul?: string;
}

export interface UpdateAgentRequest {
  display_name?: string | null;
  description?: string | null;
  category?: string | null;
  icon?: string | null;
  tags?: string[] | null;
  model?: string | null;
  tool_groups?: string[] | null;
  mcp_servers?: string[] | null;
  mcp_tools?: string[] | null;
  skills?: string[] | null;
  memory?: Agent["memory"] | null;
  workspace?: Agent["workspace"] | null;
  starter_prompts?: string[] | null;
  enabled?: boolean | null;
  soul?: string | null;
}

export interface PolishAgentPromptRequest {
  soul: string;
  locale?: string | null;
  agent_name?: string | null;
  display_name?: string | null;
  description?: string | null;
}

export interface PolishAgentPromptResponse {
  soul: string;
  changed: boolean;
}
