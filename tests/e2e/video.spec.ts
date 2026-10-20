import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mockProject, testProjectId } from "./project-context";

async function videoWorkspace(page: Page, mobile: boolean, configured = true) {
  await mockProject(page);
  await page.route("**/api/agent/codex", route => route.fulfill({ json: { connected: false, imageGeneration: false, models: [], skills: [] } }));
  await page.route("**/api/video/settings", route => route.fulfill({ json: { endpoint: "xnnd4qobofshqz", configured } }));
  await page.route("**/api/video/jobs*", route => route.fulfill({ json: { jobs: [] } }));
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Active project" })).toHaveValue(testProjectId);
  if (mobile) await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Video Studio", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bring a scene to life." })).toBeVisible();
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBXkAAAAASUVORK5CYII=", "base64");
function wav() {
  const bytes = Buffer.alloc(44 + 16000); bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(16000, 40); return bytes;
}
test("H3 controls, image and audio refs, submission, recovery and playable output", async ({ page }, info) => {
  await videoWorkspace(page, info.project.name === "mobile");
  const video = readFileSync(new URL("../fixtures/h3-preview.mp4", import.meta.url));
  await page.route("**/h3-test.mp4", route => route.fulfill({ contentType: "video/mp4", body: video }));
  const job = { localId: "c9e1dcd8-0a00-4900-a000-000000000000", id: "test-job", endpoint: "xnnd4qobofshqz", prompt: "Test scene", createdAt: Date.now(), status: "IN_QUEUE" };
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/video/run", route => { submitted = route.request().postDataJSON(); return route.fulfill({ json: { job } }); });
  await page.route("**/api/video/status", route => route.fulfill({ json: { job: { ...job, status: "COMPLETED", delayTime: 2000, executionTime: 6000, output: { video: "http://127.0.0.1:3000/h3-test.mp4" } } } }));
  await page.getByRole("textbox", { name: "Video prompt" }).fill("<Picture 1> speaks with <Audio 1> beside a river.");
  await page.getByLabel("Upload reference images").setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: png });
  await expect(page.getByAltText("Picture 1 preview")).toBeVisible();
  await page.getByLabel("Upload voice references").setInputFiles({ name: "voice.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(page.getByLabel("Preview Audio 1")).toBeVisible();
  await page.getByLabel("Duration (seconds)").fill("7.5");
  await page.getByLabel("Megapixels", { exact: true }).fill("2");
  await page.getByText("Advanced settings", { exact: true }).click();
  await page.getByLabel("Seed (−1 = random)").fill("42");
  await page.getByLabel("Steps", { exact: true }).fill("8");
  await page.getByRole("button", { name: "Generate video", exact: true }).click();
  await expect(page.getByLabel("Job ID", { exact: true })).toHaveValue("test-job");
  await expect(page).toHaveTitle(/Queued video · Studio/);
  expect(submitted?.settings).toMatchObject({ duration: 7.5, megapixels: 2, steps: 8, seed: "42" });
  expect(submitted?.images).toMatchObject([{ name: "portrait.png" }]); expect(submitted?.audios).toMatchObject([{ name: "voice.wav" }]);
  expect(JSON.stringify(submitted)).not.toContain("preview");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByText("COMPLETED", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle(/Video complete · Studio/);
  const player = page.locator(".h3-video video"); await expect(player).toBeVisible();
  await expect.poll(() => player.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThan(0);
  await player.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => player.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: "Download video 1" })).toHaveAttribute("download", "h3-output-1.mp4");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/${info.project.name}-video-studio.png`, fullPage: true });
  // References stay intact when switching between the two workspaces.
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "AI Video Agent", exact: true }).click();
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Video Studio", exact: true }).click();
  await expect(page.getByAltText("Picture 1 preview")).toBeVisible();
  await page.route("**/api/video/jobs*", route => route.fulfill({ json: { jobs: [{ ...job, status: "COMPLETED", output: { video: "http://127.0.0.1:3000/h3-test.mp4" } }] } }));
  await page.reload();
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Video Studio", exact: true }).click();
  await expect(page.getByLabel("Job ID", { exact: true })).toHaveValue("test-job");
  await expect(page.getByRole("link", { name: "Download video 1" })).toBeVisible();
});
test("missing connection opens secure settings and handles upload limits", async ({ page }, info) => {
  await videoWorkspace(page, info.project.name === "mobile", false);
  await page.getByRole("textbox", { name: "Video prompt" }).fill("A scene");
  await page.getByRole("button", { name: "Generate video", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("RunPod API key", { exact: true })).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Close RunPod connection" }).click();
  await page.getByLabel("Upload reference images").setInputFiles(Array.from({ length: 10 }, (_, index) => ({ name: `${index}.png`, mimeType: "image/png", buffer: png })));
  await expect(page.getByRole("alert").filter({ hasText: "Use up to 9 images." })).toBeVisible();
});
test("an uncertain submission blocks generating again and can recover its ID", async ({ page }, info) => {
  await videoWorkspace(page, info.project.name === "mobile");
  const job = { localId: "c9e1dcd8-0a00-4900-a000-000000000000", endpoint: "xnnd4qobofshqz", prompt: "An uncertain scene", createdAt: Date.now(), status: "SUBMISSION_UNKNOWN", error: "Response lost; check RunPod." };
  await page.route("**/api/video/run", route => route.fulfill({ json: { job } }));
  await page.route("**/api/video/status", route => route.fulfill({ json: { job: { ...job, id: "recovered-id", status: "IN_PROGRESS", error: undefined } } }));
  await page.getByRole("textbox", { name: "Video prompt" }).fill("Scene");
  await page.getByLabel("Upload reference images").setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Generate video", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generate video", exact: true })).toBeDisabled();
  await expect(page.getByText("Check this submission before trying again.")).toBeVisible();
  await page.getByLabel("Job ID", { exact: true }).fill("recovered-id");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByText("IN PROGRESS", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate video", exact: true })).toBeEnabled();
});
test("video routes enforce local origin and reject invalid payloads before contacting RunPod", async ({ request }) => {
  const response = await request.post("/api/video/run", { headers: { Origin: "https://attacker.example" }, data: {} });
  expect((await response.json()).code).toBe("invalid_request_origin");
  const invalid = await request.post("/api/video/run", { headers: { Origin: "http://127.0.0.1:3000" }, data: {} });
  expect((await invalid.json()).code).toBe("invalid_video_request");
  const config = await request.get("/api/video/settings");
  expect(config.status()).toBe(200); expect(await config.json()).not.toHaveProperty("apiKey");
});

