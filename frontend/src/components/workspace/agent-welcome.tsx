"use client";

import { BotIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { type Agent } from "@/core/agents";
import { cn } from "@/lib/utils";

export function AgentWelcome({
  className,
  agent,
  agentName,
}: {
  className?: string;
  agent: Agent | null | undefined;
  agentName: string;
}) {
  const displayName = agent?.display_name ?? agent?.name ?? agentName;
  const description = agent?.description;
  const tags = agent?.tags?.slice(0, 4) ?? [];

  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col items-center justify-center gap-2 px-8 py-4 text-center",
        className,
      )}
    >
      <div className="bg-primary/10 flex h-12 w-12 items-center justify-center rounded-full">
        <BotIcon className="text-primary h-6 w-6" />
      </div>
      <div className="text-2xl font-bold">{displayName}</div>
      {description && (
        <p className="text-muted-foreground max-w-sm text-sm">{description}</p>
      )}
      {tags.length > 0 && (
        <div className="flex max-w-sm flex-wrap justify-center gap-1">
          {tags.map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="max-w-full truncate"
            >
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
