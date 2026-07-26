import type { CSSProperties } from "react";

export type ChatWidth = "compact" | "default" | "wide" | "full";

export const DEFAULT_CHAT_WIDTH: ChatWidth = "default";

const CHAT_WIDTH_VALUES: Record<ChatWidth, string> = {
  compact: "720px",
  default: "var(--container-width-md)",
  wide: "1120px",
  full: "min(100%, 1440px)",
};

export type ChatContainerStyle = CSSProperties & {
  "--chat-container-width": string;
};

export function normalizeChatWidth(value: unknown): ChatWidth {
  if (
    value === "compact" ||
    value === "default" ||
    value === "wide" ||
    value === "full"
  ) {
    return value;
  }
  return DEFAULT_CHAT_WIDTH;
}

export function getChatContainerStyle(width: ChatWidth): ChatContainerStyle {
  return {
    "--chat-container-width": CHAT_WIDTH_VALUES[normalizeChatWidth(width)],
  };
}
