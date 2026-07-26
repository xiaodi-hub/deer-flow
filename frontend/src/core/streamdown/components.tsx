"use client";

import { useMemo } from "react";

import {
  MessageResponse,
  type MessageResponseProps,
} from "@/components/ai-elements/message";
import {
  ReasoningContent,
  type ReasoningContentProps,
} from "@/components/ai-elements/reasoning";
import {
  ClipboardSafeStreamdown,
  type ClipboardSafeStreamdownProps,
} from "@/components/ai-elements/streamdown";
import { CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import {
  getSafeStreamdownMarkdown,
  useSafeStreamdownChildren,
} from "./safe-children";

const STREAMING_REASONING_PLAIN_TEXT_THRESHOLD = 400;

export function SafeStreamdown({
  children,
  ...props
}: ClipboardSafeStreamdownProps) {
  const safeChildren = useSafeStreamdownChildren(children);

  return (
    <ClipboardSafeStreamdown {...props}>{safeChildren}</ClipboardSafeStreamdown>
  );
}

export function SafeMessageResponse({
  children,
  ...props
}: MessageResponseProps) {
  const safeChildren = useSafeStreamdownChildren(children);

  return <MessageResponse {...props}>{safeChildren}</MessageResponse>;
}

type SafeReasoningContentProps = Omit<ReasoningContentProps, "children"> & {
  children?: string;
  isStreaming?: boolean;
};

export function SafeReasoningContent({
  children = "",
  className,
  isStreaming = false,
  ...props
}: SafeReasoningContentProps) {
  const renderAsStreamingPlainText =
    isStreaming && children.length > STREAMING_REASONING_PLAIN_TEXT_THRESHOLD;
  const safeChildren = useMemo(
    () =>
      renderAsStreamingPlainText
        ? children
        : getSafeStreamdownMarkdown(children),
    [children, renderAsStreamingPlainText],
  );

  if (renderAsStreamingPlainText) {
    return (
      <CollapsibleContent
        className={cn(
          "mt-4 text-sm",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground data-[state=closed]:animate-out data-[state=open]:animate-in outline-none",
          className,
        )}
        {...props}
      >
        <div className="break-words whitespace-pre-wrap">{safeChildren}</div>
      </CollapsibleContent>
    );
  }

  return (
    <ReasoningContent className={className} {...props}>
      {safeChildren}
    </ReasoningContent>
  );
}
