import { expect, test, rs } from "@rstest/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

rs.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: string }) =>
    createElement("div", null, children),
}));

import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";

test("ReasoningTrigger default message uses phrasing content", () => {
  const html = renderToStaticMarkup(
    createElement(
      Reasoning,
      { isStreaming: false, defaultOpen: false },
      createElement(ReasoningTrigger, null),
      createElement(ReasoningContent, null, "test"),
    ),
  );

  expect(html).toContain("Thought for a few seconds");
  expect(html).not.toMatch(/<button\b[^>]*>[\s\S]*?<p\b/i);
});

test("ReasoningTrigger prefers a fixed duration over a live timer", () => {
  const html = renderToStaticMarkup(
    createElement(
      Reasoning,
      {
        isStreaming: true,
        defaultOpen: false,
        duration: 6,
        startTimeProp: Date.now() - 6000,
      },
      createElement(ReasoningTrigger, null),
      createElement(ReasoningContent, null, "test"),
    ),
  );

  expect(html).toContain("Thought for 6 seconds");
  expect(html).not.toContain("Thinking...");
});
