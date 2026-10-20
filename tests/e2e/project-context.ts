import type { Page } from "@playwright/test";
export const testProjectId = "af01aaed-aaaa-4aaa-8aaa-000000000001";
export async function mockProject(page: Page) {
  await page.route("**/api/projects", route => route.fulfill({ json: route.request().method() === "POST" ? { ok: true } : { projects: [{ id: testProjectId, title: "Test film", updatedAt: Date.now(), sceneCount: 0, clipCount: 0, completed: 0 }] } }));
}
