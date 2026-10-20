import { expect, test, type Page } from "@playwright/test";
import { mockProject } from "./project-context";
const connected = { connected: true, imageGeneration: true, models: [{ slug: "codex:test-model", displayName: "Test model · Codex" }, { slug: "codex:other-model", displayName: "Other model · Codex" }], skills: ["imagegen"] };
const disconnected = { connected: false, imageGeneration: false, models: [], skills: [] };
async function mockWorkspace(page: Page, ready: boolean) {
  await mockProject(page);
  await page.route("**/api/storage", route => route.fulfill({json:{folder:"C:/Videos",previousFolders:[]}}));
  await page.route("**/api/agent/codex", route => route.fulfill({ json: ready ? connected : disconnected }));
  await page.route("**/api/agent/projects", route => route.fulfill({ json: { projects: [], folder: "C:/Videos/AI Video Agent" } }));
  await page.route("**/api/video/settings", route => route.fulfill({ json: { configured: true, endpoint: "test-endpoint" } }));
}

test("Codex connection replaces old sign-in and usage UI in the dark responsive workspace", async ({ page }, info) => {
  await mockWorkspace(page, false);
  await page.addInitScript(() => localStorage.setItem("video-workspace-project", ""));
  const legacyRequests: string[] = [];
  page.on("request", request => { if (/\/api\/(session|models|auth|chat)(\/|$)/.test(new URL(request.url()).pathname)) legacyRequests.push(request.url()); });
  await page.goto("/?workspace=chat");
  await expect(page.getByRole("heading", { name: "Scene or script" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Active project" }).locator("option", { hasText: "Unassigned assets" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Analyze scene", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Continue with ChatGPT|Conversations|Connection & usage|Sign out/ })).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("complementary").getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", {name: "Settings", exact:true})).toBeVisible();
  await expect(page.locator(".workspace-settings")).toContainText("codex login");
  await expect(page.getByRole("link", { name: "Manage usage" })).toHaveCount(0);
  await page.route("**/api/agent/codex", route => route.fulfill({ json: connected }));
  await page.getByRole("button", { name: "Refresh connection" }).click();
  await expect(page.locator(".workspace-settings")).toContainText("Connected and ready.");
  await expect(page.locator(".workspace-settings")).toContainText("2 models · 1 skills available");
  if (info.project.name === "mobile") await page.getByRole("button", {name: "Open navigation"}).click();
  await page.getByRole("button", {name:"AI Video Agent",exact:true}).click();
  await expect(page.getByRole("combobox", { name: "Scene planning model" })).toHaveValue("codex:test-model");
  expect(legacyRequests).toEqual([]);
  await page.screenshot({ path: "test-results/" + info.project.name + "-codex-workspace.png", fullPage: true });
});

test("Codex models enable planning without a plan-consent dialog and retain selection on refresh", async ({ page }, info) => {
  await mockWorkspace(page, true);
  await page.goto("/");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Scene planning model" })).toHaveValue("codex:test-model");
  await expect(page.getByText("Codex connected", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Scene planning model" }).selectOption("codex:other-model");
  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("complementary").getByRole("button", { name: "Settings", exact: true }).click();
  } else await page.getByRole("button", { name: "Connection settings", exact: true }).click();
  await page.getByRole("button", { name: "Refresh connection" }).click();
  await expect(page.getByRole("button", { name: "Refresh connection" })).toBeEnabled();
  if (info.project.name === "mobile") await page.getByRole("button", {name: "Open navigation"}).click();
  await page.getByRole("button", {name:"AI Video Agent",exact:true}).click();
  await expect(page.getByRole("combobox", { name: "Scene planning model" })).toHaveValue("codex:other-model");
  await page.getByRole("textbox", { name: "Your scene" }).fill("A traveler arrives at a station.");
  await expect(page.getByRole("button", { name: "Analyze scene", exact: true })).toBeEnabled();
});

test("connection errors remain visible in both workspaces and can retry", async ({ page }, info) => {
  await mockWorkspace(page, true);
  await page.route("**/api/agent/codex", route => route.fulfill({ status: 503, json: { error: "Codex is temporarily unavailable." } }));
  await page.goto("/");
  await expect(page.getByRole("alert").filter({ hasText: "Codex is temporarily" })).toBeVisible();
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Video Studio", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Codex is temporarily" })).toBeVisible();
  await page.route("**/api/agent/codex", route => route.fulfill({ json: connected }));
  await page.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Codex is temporarily" })).toHaveCount(0);
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "AI Video Agent", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Scene planning model" })).toHaveValue("codex:test-model");
});

test("removed sign-in, session, chat and model routes are unavailable", async ({ request }) => {
  for (const path of ["/api/session", "/api/models", "/auth/callback"]) expect((await request.get(path)).status()).toBe(404);
  for (const path of ["/api/auth/start", "/api/auth/signout", "/api/chat"]) expect((await request.post(path, { data: {} })).status()).toBe(404);
  const crossSite = await request.post("/api/agent/analyze", { headers: { Origin: "https://attacker.example" }, data: {} });
  expect(crossSite.status()).toBe(400); expect((await crossSite.json()).code).toBe("invalid_request_origin");
});
