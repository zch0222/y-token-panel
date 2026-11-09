import { expect, test } from "@playwright/test";
import { mockUsageApi } from "./fixtures";

test("提供完整的应用清单、安装图标与 Service Worker 响应头", async ({ page }) => {
  const response = await page.request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");

  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: "/",
    name: "Y Token · AI Harness 用量统计",
    short_name: "Y Token",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]),
  );

  for (const icon of manifest.icons) {
    const iconResponse = await page.request.get(icon.src);
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()["content-type"]).toContain("image/png");
  }

  const workerResponse = await page.request.get("/sw.js");
  expect(workerResponse.ok()).toBe(true);
  expect(workerResponse.headers()["cache-control"]).toBe("no-cache, no-store, must-revalidate");
  expect(workerResponse.headers()["service-worker-allowed"]).toBe("/");
  expect(await workerResponse.text()).toContain('request.mode !== "navigate"');
});

test("Chromium 原生安装提示完成后切换为已安装状态", async ({ page }) => {
  await mockUsageApi(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "用量统计" })).toBeVisible();

  // 先完成一次可交互操作，确保客户端 Effect 已订阅安装事件。
  await page.getByRole("button", { name: "安装应用" }).click();
  await expect(page.getByRole("dialog", { name: "安装 Y Token" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.evaluate(() => {
    const event = Object.assign(new Event("beforeinstallprompt"), {
      prompt: async () => {
        document.documentElement.dataset.installPromptCalled = "true";
      },
      userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
    });
    window.dispatchEvent(event);
  });

  await page.getByRole("button", { name: "安装应用" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-install-prompt-called", "true");
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(page.getByRole("button", { name: "已安装" })).toBeDisabled();
});

test("没有原生提示时展示手动安装步骤，取消安装后也有回退指引", async ({ page }) => {
  await mockUsageApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "安装应用" }).click();
  await expect(page.getByRole("dialog", { name: "安装 Y Token" })).toBeVisible();
  await expect(page.getByText("安装页面为应用", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    const event = Object.assign(new Event("beforeinstallprompt"), {
      prompt: async () => undefined,
      userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" }),
    });
    window.dispatchEvent(event);
  });
  await page.getByRole("button", { name: "安装应用" }).click();
  await expect(page.getByRole("status")).toContainText("已取消安装");
  await expect(page.getByRole("dialog", { name: "安装 Y Token" })).toBeVisible();
});

test("iOS 显示添加到主屏幕指引", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () =>
        "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
    });
  });
  await mockUsageApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "安装应用" }).click();
  await expect(page.getByRole("dialog", { name: "安装 Y Token" })).toBeVisible();
  await expect(page.getByText("添加到主屏幕", { exact: false })).toBeVisible();
  await expect(page.getByText("分享", { exact: false })).toBeVisible();
});
