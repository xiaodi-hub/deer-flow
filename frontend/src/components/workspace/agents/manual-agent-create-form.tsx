"use client";

import {
  CheckIcon,
  FolderOpenIcon,
  SaveIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/workspace/tooltip";
import type { Agent, CreateAgentRequest } from "@/core/agents";
import {
  AgentNameCheckError,
  AgentsApiDisabledError,
  checkAgentName,
  selectWorkspaceDirectory,
  useCreateAgent,
  usePolishAgentPrompt,
} from "@/core/agents";
import { useI18n } from "@/core/i18n/hooks";
import { useMCPConfig } from "@/core/mcp/hooks";
import { useModels } from "@/core/models/hooks";
import { useSkills } from "@/core/skills/hooks";
import { cn } from "@/lib/utils";

const DEFAULT_MODEL = "__default__";
const SKILLS_ALL = "all";
const SKILLS_NONE = "none";
const SKILLS_CUSTOM = "custom";
const NAME_RE = /^[A-Za-z0-9-]+$/;

type MemoryScope = "global" | "agent";
type WorkspaceMode = NonNullable<Agent["workspace"]>["mode"];

function textToList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function textToOptionalList(value: string): string[] | null {
  const list = textToList(value);
  return list.length > 0 ? list : null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onCheckedChange(!checked)}
      className="aria-pressed:border-primary aria-pressed:bg-primary/5 hover:bg-muted/50 flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-md border px-3 py-2 text-left transition-colors"
    >
      <span
        className="border-input bg-background aria-pressed:bg-primary aria-pressed:text-primary-foreground flex h-5 w-5 shrink-0 items-center justify-center rounded border"
        aria-pressed={checked}
      >
        {checked ? <CheckIcon className="h-3.5 w-3.5" /> : null}
      </span>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        {description ? (
          <div className="text-muted-foreground line-clamp-2 text-xs">
            {description}
          </div>
        ) : null}
      </div>
    </button>
  );
}

export function ManualAgentCreateForm({
  onCreated,
}: {
  onCreated: (agent: Agent) => void;
}) {
  const { locale, t } = useI18n();
  const createAgent = useCreateAgent();
  const polishPrompt = usePolishAgentPrompt();
  const { models } = useModels();
  const { config: mcpConfig } = useMCPConfig();
  const { skills } = useSkills();

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [icon, setIcon] = useState("");
  const [tags, setTags] = useState("");
  const [starterPrompts, setStarterPrompts] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [soul, setSoul] = useState("");
  const [soulError, setSoulError] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [toolGroups, setToolGroups] = useState("");
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [mcpTools, setMcpTools] = useState("");
  const [skillsMode, setSkillsMode] = useState(SKILLS_ALL);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [memoryRead, setMemoryRead] = useState<MemoryScope[]>([
    "global",
    "agent",
  ]);
  const [memoryDefaultWrite, setMemoryDefaultWrite] =
    useState<MemoryScope>("agent");
  const [memoryPreferenceWrite, setMemoryPreferenceWrite] =
    useState<MemoryScope>("global");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("thread");
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceIsolateThreads, setWorkspaceIsolateThreads] = useState(false);
  const [workspaceAllowedPaths, setWorkspaceAllowedPaths] = useState("");
  const [isCheckingName, setIsCheckingName] = useState(false);
  const [isSelectingWorkspacePath, setIsSelectingWorkspacePath] =
    useState(false);

  const mcpServerNames = useMemo(
    () => Object.keys(mcpConfig?.mcp_servers ?? {}).sort(),
    [mcpConfig],
  );

  function toggleValue(values: string[], value: string): string[] {
    return values.includes(value)
      ? values.filter((item) => item !== value)
      : [...values, value];
  }

  function toggleMemoryRead(scope: MemoryScope, checked: boolean) {
    setMemoryRead((current) => {
      const next = checked
        ? Array.from(new Set([...current, scope]))
        : current.filter((item) => item !== scope);
      return next.length > 0 ? next : [scope];
    });
  }

  async function validateName(trimmed: string): Promise<boolean> {
    if (!trimmed) {
      setNameError(t.agents.nameStepInvalidError);
      return false;
    }
    if (!NAME_RE.test(trimmed)) {
      setNameError(t.agents.nameStepInvalidError);
      return false;
    }

    setIsCheckingName(true);
    try {
      const result = await checkAgentName(trimmed);
      if (!result.available) {
        setNameError(t.agents.nameStepAlreadyExistsError);
        return false;
      }
      return true;
    } catch (err) {
      if (err instanceof AgentsApiDisabledError) {
        setNameError(t.agents.nameStepApiDisabledError);
      } else if (
        err instanceof AgentNameCheckError &&
        err.reason === "backend_unreachable"
      ) {
        setNameError(t.agents.nameStepNetworkError);
      } else if (
        err instanceof AgentNameCheckError &&
        err.reason === "request_failed"
      ) {
        setNameError(
          err.detail
            ? t.agents.nameStepCheckErrorWithDetail.replace(
                "{detail}",
                err.detail,
              )
            : t.agents.nameStepCheckError,
        );
      } else {
        setNameError(t.agents.nameStepCheckError);
      }
      return false;
    } finally {
      setIsCheckingName(false);
    }
  }

  async function handlePolishPrompt() {
    const trimmedSoul = soul.trim();
    if (!trimmedSoul || polishPrompt.isPending) return;

    try {
      const result = await polishPrompt.mutateAsync({
        soul: trimmedSoul,
        locale,
        agent_name: name.trim() || null,
        display_name: displayName.trim() || null,
        description: description.trim() || null,
      });
      setSoul(result.soul);
      setSoulError("");
      toast.success(
        result.changed
          ? t.agents.promptPolishSuccess
          : t.agents.promptPolishNoChange,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSelectWorkspacePath() {
    setIsSelectingWorkspacePath(true);
    try {
      const result = await selectWorkspaceDirectory(workspacePath);
      if (result.path) {
        setWorkspacePath(result.path);
        setWorkspaceMode("custom");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSelectingWorkspacePath(false);
    }
  }

  async function handleCreate() {
    const trimmedName = name.trim();
    const trimmedSoul = soul.trim();
    setNameError("");
    setSoulError("");

    if (!(await validateName(trimmedName))) {
      return;
    }
    if (!trimmedSoul) {
      setSoulError(t.agents.promptRequiredError);
      return;
    }

    const request: CreateAgentRequest = {
      name: trimmedName,
      display_name: displayName.trim() || null,
      description: description.trim(),
      category: category.trim() || null,
      icon: icon.trim() || null,
      tags: textToList(tags),
      starter_prompts: textToList(starterPrompts),
      enabled,
      soul: trimmedSoul,
      model: model === DEFAULT_MODEL ? null : model,
      tool_groups: textToOptionalList(toolGroups),
      mcp_servers: mcpServers,
      mcp_tools: textToOptionalList(mcpTools),
      skills:
        skillsMode === SKILLS_ALL
          ? null
          : skillsMode === SKILLS_NONE
            ? []
            : selectedSkills,
      memory: {
        read: memoryRead,
        write: {
          default: memoryDefaultWrite,
          stable_user_preferences: memoryPreferenceWrite,
        },
      },
      workspace: {
        mode: workspaceMode,
        path: workspacePath.trim() || null,
        isolate_threads: workspaceIsolateThreads,
        allowed_paths: textToList(workspaceAllowedPaths),
      },
    };

    try {
      const created = await createAgent.mutateAsync(request);
      toast.success(t.agents.agentCreated);
      onCreated(created);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  const isBusy = createAgent.isPending || isCheckingName;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pt-5 pb-0">
      <div className="grid gap-4 border-b pb-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Field label={t.agents.fieldName}>
          <Input
            autoFocus
            placeholder={t.agents.nameStepPlaceholder}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError("");
            }}
            className={cn(nameError && "border-destructive")}
          />
          {nameError ? (
            <p className="text-destructive text-sm">{nameError}</p>
          ) : null}
        </Field>
        <Field label={t.agents.fieldDisplayName}>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label={t.agents.fieldDescription}>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-24"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.agents.fieldCategory}>
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </Field>
          <Field label={t.agents.fieldIcon}>
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} />
          </Field>
          <Field label={t.agents.fieldEnabled}>
            <div className="flex h-9 items-center">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </Field>
        </div>
      </div>

      <Tabs defaultValue="prompt" className="min-h-0 flex-1 gap-5 pt-5">
        <TabsList className="flex-wrap">
          <TabsTrigger value="prompt">{t.agents.settingsPrompt}</TabsTrigger>
          <TabsTrigger value="tools">{t.agents.settingsTools}</TabsTrigger>
          <TabsTrigger value="memory">{t.agents.settingsMemory}</TabsTrigger>
          <TabsTrigger value="workspace">
            {t.agents.settingsWorkspace}
          </TabsTrigger>
          <TabsTrigger value="gallery">{t.agents.settingsProfile}</TabsTrigger>
        </TabsList>

        <TabsContent value="prompt">
          <div className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{t.agents.fieldSoul}</span>
              <Tooltip content={t.agents.promptPolishTooltip}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handlePolishPrompt()}
                  disabled={!soul.trim() || polishPrompt.isPending}
                  aria-label={t.agents.promptPolish}
                >
                  <WandSparklesIcon className="h-4 w-4" />
                  {polishPrompt.isPending
                    ? t.agents.promptPolishing
                    : t.agents.promptPolish}
                </Button>
              </Tooltip>
            </div>
            <Textarea
              value={soul}
              onChange={(e) => {
                setSoul(e.target.value);
                setSoulError("");
              }}
              className={cn(
                "min-h-[460px] font-mono text-sm",
                soulError && "border-destructive",
              )}
            />
            {soulError ? (
              <p className="text-destructive text-sm">{soulError}</p>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent
          value="tools"
          className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        >
          <div className="min-w-0 space-y-4">
            <Field label={t.agents.fieldModel}>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_MODEL}>
                    {t.agents.modelDefault}
                  </SelectItem>
                  {models.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.display_name || item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t.agents.fieldToolGroups}>
              <Textarea
                value={toolGroups}
                onChange={(e) => setToolGroups(e.target.value)}
                className="min-h-28 font-mono text-sm"
              />
            </Field>
            <Field label={t.agents.fieldMcpTools}>
              <Textarea
                value={mcpTools}
                onChange={(e) => setMcpTools(e.target.value)}
                className="min-h-28 font-mono text-sm"
              />
            </Field>
          </div>

          <div className="min-w-0 space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-medium">
                {t.agents.fieldMcpServers}
              </div>
              <div className="grid gap-2">
                {mcpServerNames.length > 0 ? (
                  mcpServerNames.map((serverName) => (
                    <ToggleRow
                      key={serverName}
                      label={serverName}
                      checked={mcpServers.includes(serverName)}
                      onCheckedChange={() =>
                        setMcpServers((current) =>
                          toggleValue(current, serverName),
                        )
                      }
                    />
                  ))
                ) : (
                  <p className="text-muted-foreground text-sm">
                    {t.agents.emptyMcpServers}
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium">{t.agents.fieldSkills}</div>
              <Select value={skillsMode} onValueChange={setSkillsMode}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SKILLS_ALL}>
                    {t.agents.skillsAll}
                  </SelectItem>
                  <SelectItem value={SKILLS_NONE}>
                    {t.agents.skillsNone}
                  </SelectItem>
                  <SelectItem value={SKILLS_CUSTOM}>
                    {t.agents.skillsCustom}
                  </SelectItem>
                </SelectContent>
              </Select>
              {skillsMode === SKILLS_CUSTOM ? (
                <div className="grid min-w-0 gap-2 pt-2">
                  <div className="text-muted-foreground text-xs">
                    {t.agents.selectedSkillsCount(selectedSkills.length)}
                  </div>
                  {skills.map((skill) => (
                    <ToggleRow
                      key={skill.name}
                      label={skill.name}
                      description={skill.description}
                      checked={selectedSkills.includes(skill.name)}
                      onCheckedChange={() =>
                        setSelectedSkills((current) =>
                          toggleValue(current, skill.name),
                        )
                      }
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="memory" className="grid gap-4 md:grid-cols-2">
          <ToggleRow
            label={t.agents.memoryReadGlobal}
            checked={memoryRead.includes("global")}
            onCheckedChange={(checked) => toggleMemoryRead("global", checked)}
          />
          <ToggleRow
            label={t.agents.memoryReadAgent}
            checked={memoryRead.includes("agent")}
            onCheckedChange={(checked) => toggleMemoryRead("agent", checked)}
          />
          <Field label={t.agents.memoryDefaultWrite}>
            <Select
              value={memoryDefaultWrite}
              onValueChange={(value) =>
                setMemoryDefaultWrite(value as MemoryScope)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">
                  {t.agents.memoryScopeAgent}
                </SelectItem>
                <SelectItem value="global">
                  {t.agents.memoryScopeGlobal}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t.agents.memoryPreferenceWrite}>
            <Select
              value={memoryPreferenceWrite}
              onValueChange={(value) =>
                setMemoryPreferenceWrite(value as MemoryScope)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">
                  {t.agents.memoryScopeGlobal}
                </SelectItem>
                <SelectItem value="agent">
                  {t.agents.memoryScopeAgent}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </TabsContent>

        <TabsContent value="workspace" className="grid gap-4 md:grid-cols-2">
          <Field label={t.agents.workspaceMode}>
            <Select
              value={workspaceMode}
              onValueChange={(value) =>
                setWorkspaceMode(value as WorkspaceMode)
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="thread">
                  {t.agents.workspaceThread}
                </SelectItem>
                <SelectItem value="agent">{t.agents.workspaceAgent}</SelectItem>
                <SelectItem value="custom">
                  {t.agents.workspaceCustom}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t.agents.workspaceIsolateThreads}>
            <div className="flex h-9 items-center">
              <Switch
                checked={workspaceIsolateThreads}
                onCheckedChange={setWorkspaceIsolateThreads}
              />
            </div>
          </Field>
          <Field label={t.agents.workspacePath}>
            <div className="flex gap-2">
              <Input
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder="G:\\"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleSelectWorkspacePath()}
                disabled={isSelectingWorkspacePath}
              >
                <FolderOpenIcon className="h-4 w-4" />
                {isSelectingWorkspacePath
                  ? t.common.loading
                  : t.agents.workspaceChoosePath}
              </Button>
            </div>
          </Field>
          <Field label={t.agents.workspaceAllowedPaths}>
            <Textarea
              value={workspaceAllowedPaths}
              onChange={(e) => setWorkspaceAllowedPaths(e.target.value)}
              className="min-h-28 font-mono text-sm"
            />
          </Field>
          <div className="text-muted-foreground text-xs md:col-span-2">
            /mnt/user-data/workspace
          </div>
        </TabsContent>

        <TabsContent value="gallery" className="grid gap-4 md:grid-cols-2">
          <Field label={t.agents.fieldTags}>
            <Textarea
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              className="min-h-28"
            />
          </Field>
          <Field label={t.agents.fieldStarterPrompts}>
            <Textarea
              value={starterPrompts}
              onChange={(e) => setStarterPrompts(e.target.value)}
              className="min-h-28"
            />
          </Field>
        </TabsContent>
      </Tabs>

      <div className="bg-background/95 sticky bottom-0 mt-6 border-t py-3 backdrop-blur">
        <div className="flex justify-end">
          <Button onClick={() => void handleCreate()} disabled={isBusy}>
            <SaveIcon className="h-4 w-4" />
            {isBusy ? t.common.loading : t.agents.createFromConfig}
          </Button>
        </div>
      </div>
    </div>
  );
}
