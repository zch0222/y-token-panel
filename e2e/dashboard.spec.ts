import { expect, test } from "@playwright/test";
import { mockUsageApi } from "./fixtures";

test("桌面端核心用量流程：筛选、图表、分页、详情、导出与设置", async ({ page }) => {
  const requests = await mockUsageApi(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "用量统计" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^总请求数/ })).toContainText("25");

  await page.getByRole("button", { name: /^总请求数/ }).click();
  await expect(page.getByRole("button", { name: /^总请求数/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "面积图" }).click();
  await expect(page.getByRole("button", { name: "面积图" })).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("时间范围").click();
  await page.getByRole("option", { name: "近 7 天" }).click();
  await expect.poll(() => requests.some((url) => url.pathname === "/api/usage/query" && url.searchParams.get("range") === "7d")).toBe(true);
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.getByLabel("时间范围")).toContainText("当天");

  await page.getByRole("button", { name: "请求日志", exact: true }).click();
  await expect(page.getByRole("heading", { name: "请求日志" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(10);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.getByText("2 / 3", { exact: true })).toBeVisible();
  await expect.poll(() => requests.some((url) => url.pathname === "/api/usage/records" && url.searchParams.get("page") === "1")).toBe(true);

  await page.getByLabel("每页条数").click();
  await page.getByRole("option", { name: "20 条/页" }).click();
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(20);

  const firstRow = page.locator("tbody tr").first();
  await firstRow.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("request-1", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const logsTab = page.getByRole("tab", { name: /请求日志/ });
  await logsTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Harness/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "usage-tab-harnesses");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("usage-e2e.csv");

  await page.getByRole("button", { name: "切换到浅色模式" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: "切换到深色模式" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.getByRole("button", { name: "用量设置" }).click();
  await expect(page.getByRole("dialog", { name: "用量设置" })).toBeVisible();
  await page.getByLabel("日志扫描间隔").click();
  await page.getByRole("option", { name: "关闭", exact: true }).click();
  await expect(page.getByLabel("日志扫描间隔")).toContainText("关闭");
  await page.keyboard.press("Escape");

  // 移除 Next 开发模式左下角指示器，避免它覆盖应用侧栏按钮。
  await page.locator("nextjs-portal").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
  await expect(page.getByRole("button", { name: "同步数据" })).toBeVisible();
});

test("移动端可进入所有主视图，标签与导出不会挤出屏幕", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockUsageApi(page);
  await page.route("**/api/balance/providers", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ providers: [], cache: {}, storePath: "/tmp/e2e-balance.json" }),
    }),
  );
  await page.goto("/");

  await page.getByRole("button", { name: "打开主导航" }).click();
  await expect(page.getByRole("dialog", { name: "Y TOKEN" })).toBeVisible();
  await page.getByRole("button", { name: "余额查询", exact: true }).click();
  await expect(page.getByRole("heading", { name: "余额查询" })).toBeVisible();
  await expect(page.getByRole("button", { name: "添加第一个供应商" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "打开主导航" }).click();
  await page.getByRole("button", { name: "请求日志", exact: true }).click();
  await expect(page.getByRole("heading", { name: "请求日志" })).toBeVisible();

  const tabList = page.getByRole("tablist", { name: "用量明细" });
  const dimensions = await tabList.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  expect(dimensions.documentWidth).toBe(dimensions.viewportWidth);

  await page.getByRole("tab", { name: /供应商/ }).click();
  await expect(page.getByRole("tab", { name: /供应商/ })).toHaveAttribute("aria-selected", "true");
  const exportBounds = await page.getByRole("button", { name: "导出 CSV" }).boundingBox();
  expect(exportBounds).not.toBeNull();
  expect(exportBounds!.x).toBeGreaterThanOrEqual(0);
  expect(exportBounds!.x + exportBounds!.width).toBeLessThanOrEqual(390);
});

test("日志查询失败明确报错，重试成功后恢复真实记录", async ({ page }) => {
  let failRecords = true;
  await mockUsageApi(page, { failRecords: () => failRecords });
  await page.goto("/");
  await page.getByRole("button", { name: "请求日志", exact: true }).click();

  const errorAlert = page.getByRole("alert").filter({ hasText: "读取请求日志失败" });
  await expect(errorAlert).toBeVisible();
  await expect(page.getByText("请求日志加载失败", { exact: true })).toBeVisible();
  await expect(page.getByText("当前筛选范围暂无用量", { exact: true })).toHaveCount(0);

  failRecords = false;
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(10);
  await expect(errorAlert).toHaveCount(0);
});

test("快速关闭并重开详情时，旧的慢响应不会覆盖新记录", async ({ page }) => {
  await mockUsageApi(page, { detailDelay: (id) => (id === "record-1" ? 500 : 20) });
  await page.goto("/");
  await page.getByRole("button", { name: "请求日志", exact: true }).click();

  await page.locator("tbody tr").first().click();
  await expect(page.getByText("request-1", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator("tbody tr").nth(1).click();
  await expect(page.getByText("request-2", { exact: true })).toBeVisible();
  await page.waitForTimeout(650);
  await expect(page.getByText("request-2", { exact: true })).toBeVisible();
  await expect(page.getByText("request-1", { exact: true })).toHaveCount(0);
});
