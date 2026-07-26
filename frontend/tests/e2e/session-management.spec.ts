import { expect, test } from "@playwright/test";

import {
  MOCK_THREAD_ID,
  MOCK_THREAD_ID_2,
  mockLangGraphAPI,
} from "./utils/mock-api";

test("session management page bulk deletes selected conversations", async ({
  page,
}) => {
  mockLangGraphAPI(page, {
    threads: [
      {
        thread_id: MOCK_THREAD_ID,
        title: "First conversation",
        updated_at: "2025-06-01T12:00:00Z",
      },
      {
        thread_id: MOCK_THREAD_ID_2,
        title: "Second conversation",
        updated_at: "2025-06-02T12:00:00Z",
      },
    ],
  });

  await page.goto("/workspace/chats/new");
  await page
    .locator("[data-sidebar='sidebar']")
    .getByRole("link", { name: /session management/i })
    .click();

  await page.waitForURL("**/workspace/session-management");
  await expect(
    page.getByRole("heading", { name: "Session management" }),
  ).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("checkbox", { name: "First conversation" }).check();
  await page.getByRole("checkbox", { name: "Second conversation" }).check();
  await expect(page.getByText("2 selected")).toBeVisible();

  await page.getByRole("button", { name: "Bulk delete" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("This will delete 2 conversations");
  await dialog.getByRole("button", { name: "Bulk delete" }).click();

  await expect(page.getByText("First conversation")).toHaveCount(0);
  await expect(page.getByText("Second conversation")).toHaveCount(0);
  await expect(page.getByText("No conversations to display")).toBeVisible();
});
