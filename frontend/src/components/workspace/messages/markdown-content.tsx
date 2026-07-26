"use client";

import {
  createContext,
  type ComponentProps,
  isValidElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type ClipboardSafeStreamdownProps } from "@/components/ai-elements/streamdown";
import { rehypeSplitWordsIntoSpans } from "@/core/rehype";
import {
  preprocessStreamdownMarkdown,
  streamdownPluginsWithoutRawHtml,
} from "@/core/streamdown";
import { SafeMessageResponse } from "@/core/streamdown/components";
import { cn } from "@/lib/utils";

import { createMarkdownLinkComponent } from "./markdown-link";

export type MarkdownContentProps = {
  content: string;
  isLoading: boolean;
  rehypePlugins?: ClipboardSafeStreamdownProps["rehypePlugins"];
  className?: string;
  remarkPlugins?: ClipboardSafeStreamdownProps["remarkPlugins"];
  components?: ClipboardSafeStreamdownProps["components"];
};

type StreamingCodeProps = ComponentProps<"code"> & {
  node?: unknown;
  children?: ReactNode;
};

type RehypePlugin = NonNullable<
  ClipboardSafeStreamdownProps["rehypePlugins"]
>[number];

const STREAMING_RENDER_INTERVAL_MS = 80;

const StreamingCodeBlockContext = createContext(false);

function StreamingPre({ children }: ComponentProps<"pre">) {
  const childClassName = isValidElement<{ className?: string }>(children)
    ? children.props.className
    : undefined;
  const language =
    /(?:^|\s)language-([^\s]+)/.exec(childClassName ?? "")?.[1] ?? "";

  return (
    <div
      className="my-4 w-full overflow-hidden rounded-xl border"
      data-language={language}
      data-streaming-code-block="true"
    >
      {language && (
        <div className="bg-muted/80 text-muted-foreground p-3 text-xs">
          <span className="ml-1 font-mono lowercase">{language}</span>
        </div>
      )}
      <pre className="bg-muted/40 overflow-x-auto border-t p-4 font-mono text-xs">
        <StreamingCodeBlockContext.Provider value={true}>
          {children}
        </StreamingCodeBlockContext.Provider>
      </pre>
    </div>
  );
}

function StreamingCode({
  children,
  className,
  node: _node,
  ...props
}: StreamingCodeProps) {
  const isBlock = useContext(StreamingCodeBlockContext);

  if (!isBlock) {
    return (
      <code
        {...props}
        className={cn(
          "bg-muted rounded px-1.5 py-0.5 font-mono text-sm",
          className,
        )}
        data-streaming-inline-code="true"
      >
        {children}
      </code>
    );
  }

  return (
    <code {...props} className={className}>
      {children}
    </code>
  );
}

function isWordSplitPlugin(plugin: RehypePlugin) {
  if (plugin === rehypeSplitWordsIntoSpans) {
    return true;
  }
  return Array.isArray(plugin) && plugin[0] === rehypeSplitWordsIntoSpans;
}

function useStreamingRenderContent(content: string, isLoading: boolean) {
  const [renderContent, setRenderContent] = useState(content);
  const latestContentRef = useRef(content);
  const lastFlushAtRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestContentRef.current = content;

    if (!isLoading) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      lastFlushAtRef.current = Date.now();
      setRenderContent(content);
      return;
    }

    const flush = () => {
      timeoutRef.current = null;
      lastFlushAtRef.current = Date.now();
      setRenderContent((current) =>
        current === latestContentRef.current
          ? current
          : latestContentRef.current,
      );
    };

    const now = Date.now();
    const elapsed = now - lastFlushAtRef.current;
    if (
      lastFlushAtRef.current === 0 ||
      elapsed >= STREAMING_RENDER_INTERVAL_MS
    ) {
      flush();
      return;
    }

    timeoutRef.current ??= setTimeout(
      flush,
      STREAMING_RENDER_INTERVAL_MS - elapsed,
    );
  }, [content, isLoading]);

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  return renderContent;
}

/** Renders markdown content. */
export function MarkdownContent({
  content,
  isLoading,
  rehypePlugins,
  className,
  remarkPlugins = streamdownPluginsWithoutRawHtml.remarkPlugins,
  components: componentsFromProps,
}: MarkdownContentProps) {
  const renderContent = useStreamingRenderContent(content, isLoading);
  const normalizedContent = useMemo(
    () => preprocessStreamdownMarkdown(renderContent),
    [renderContent],
  );
  const effectiveRehypePlugins = useMemo(() => {
    const base = streamdownPluginsWithoutRawHtml.rehypePlugins ?? [];
    const extra = rehypePlugins ?? [];
    const safeExtra = isLoading
      ? extra.filter((plugin) => !isWordSplitPlugin(plugin))
      : extra;
    return [
      ...base,
      ...safeExtra,
    ] as ClipboardSafeStreamdownProps["rehypePlugins"];
  }, [isLoading, rehypePlugins]);
  const components = useMemo(() => {
    const baseComponents = {
      a: createMarkdownLinkComponent(),
      ...componentsFromProps,
    };
    if (!isLoading) {
      return baseComponents;
    }
    return {
      ...baseComponents,
      code: componentsFromProps?.code ?? StreamingCode,
      pre: componentsFromProps?.pre ?? StreamingPre,
    };
  }, [componentsFromProps, isLoading]);

  if (!renderContent) return null;

  return (
    <SafeMessageResponse
      key={isLoading ? "streaming" : "complete"}
      className={className}
      remarkPlugins={remarkPlugins}
      rehypePlugins={effectiveRehypePlugins}
      components={components}
      parseIncompleteMarkdown={isLoading}
    >
      {normalizedContent}
    </SafeMessageResponse>
  );
}
