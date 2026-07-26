import { expect, test } from "@rstest/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Reasoning } from "@/components/ai-elements/reasoning";
import { artifactMarkdownPlugins } from "@/components/workspace/artifacts/markdown-preview-plugins";
import { ArtifactLink } from "@/components/workspace/citations/artifact-link";
import {
  SafeReasoningContent,
  SafeStreamdown,
  streamdownPlugins,
} from "@/core/streamdown";

function renderArtifactMarkdown(content: string) {
  return renderToStaticMarkup(
    createElement(
      SafeStreamdown,
      { ...artifactMarkdownPlugins, components: { a: ArtifactLink } },
      content,
    ),
  );
}

function renderSharedMarkdown(content: string) {
  return renderToStaticMarkup(
    createElement(SafeStreamdown, streamdownPlugins, content),
  );
}

test("adds GitHub-style heading anchors to artifact markdown previews", () => {
  const html = renderArtifactMarkdown(
    ["[概述](#概述)", "", "## 概述"].join("\n"),
  );

  expect(html).toContain('href="#%E6%A6%82%E8%BF%B0"');
  expect(html).toContain('id="概述"');
  expect(html).not.toContain("target=");
});

test("does not add heading anchors to the shared streamdown plugin config", () => {
  const html = [
    renderSharedMarkdown("## Summary"),
    renderSharedMarkdown("## Summary"),
  ].join("");

  expect(html).not.toContain('id="summary"');
});

test("renders large streaming reasoning as lightweight plain text", () => {
  const content = [
    "Formula stays literal while streaming: \\(x^2\\).",
    "**thinking** ".repeat(80),
    "",
    "```python",
    "print('x')",
    "```",
  ].join("\n");
  const html = renderToStaticMarkup(
    createElement(
      Reasoning,
      { isStreaming: true },
      createElement(SafeReasoningContent, { isStreaming: true }, content),
    ),
  );

  expect(html).toContain("whitespace-pre-wrap");
  expect(html).toContain("\\(x^2\\)");
  expect(html).not.toContain("$x^2$");
  expect(html).toContain("**thinking**");
  expect(html).not.toContain("<strong>");
});
