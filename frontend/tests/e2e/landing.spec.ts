import { expect, test } from "@playwright/test";

import { mockLangGraphAPI } from "./utils/mock-api";

test.describe("Home route", () => {
  test("redirects to the agent gallery", async ({ page }) => {
    mockLangGraphAPI(page, {
      agents: [
        {
          name: "stock-analysis",
          display_name: "Stock Analyst",
          description: "Market and earnings research",
          category: "finance",
          tags: ["stocks", "earnings"],
          model: "gpt-5-thinking",
          tool_groups: ["web"],
          starter_prompts: ["Analyze NVDA earnings"],
        },
      ],
    });

    await page.goto("/");

    await page.waitForURL("**/workspace/agents");
    await expect(page.getByText("Stock Analyst")).toBeVisible();
    await expect(page.getByText("finance")).toBeVisible();
  });
});
