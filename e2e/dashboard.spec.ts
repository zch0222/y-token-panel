import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mockUsageApi } from "./fixtures";

/**
 * 触发器宽度不足时 SelectValue（line-clamp-1）会把「00 时」这类短文本截断，
 * 视觉上仍是「可见」，只能靠 scrollWidth 越过 clientWidth 判断。
 */
async function expectNoTruncatedValue(page: Page, labels: string[]) {
  for (const label of labels) {
    const overflow = await page.getByLabel(label).evaluate((node) => {
      const value = node.querySelector('[data-slot="select-value"]');
      return value === null ? 0 : value.scrollWidth - value.clientWidth;
    });
    expect(overflow, `${label} 的选中值被截断`).toBeLessThanOrEqual(1);
  }
}

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

  // 自定义时间段：默认小时精度，切分钟后可选分钟，应用后才发起新查询。
  await page.getByLabel("时间范围").click();
  await page.getByRole("option", { name: "自定义时间段" }).click();
  await expect(page.getByLabel("时间精度")).toContainText("小时");
  await expect(page.getByLabel("开始分钟")).toHaveCount(0);
  await expectNoTruncatedValue(page, ["时间精度", "开始小时", "结束小时"]);
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname === "/api/usage/query" &&
          url.searchParams.get("range") === "custom" &&
          Boolean(url.searchParams.get("start")) &&
          Boolean(url.searchParams.get("end")),
      ),
    )
    .toBe(true);
  await expect(page.getByLabel("时间范围")).toContainText("自定义 ·");

  await page.getByLabel("时间精度").click();
  await page.getByRole("option", { name: "分钟" }).click();
  await expect(page.getByLabel("开始分钟")).toBeVisible();
  await expectNoTruncatedValue(page, ["时间精度", "开始小时", "开始分钟", "结束小时", "结束分钟"]);
  await page.getByLabel("开始分钟").click();
  await page.getByRole("option", { name: "15 分" }).click();

  await page.getByLabel("开始小时").click();
  await page.getByRole("option", { name: "10 时" }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.getByLabel("时间范围")).toContainText("10:15–23:00");
  await expect(page.getByLabel("结束分钟")).toContainText("00 分");

  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page.getByLabel("时间范围")).toContainText("当天");
  await expect(page.getByLabel("时间精度")).toHaveCount(0);

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

test("统计面板按日历选日/月并以图表展示用量与模型排名", async ({ page }) => {
  const requests = await mockUsageApi(page);
  await page.goto("/");

  await page.getByRole("button", { name: "统计面板", exact: true }).click();
  await expect(page.getByRole("heading", { name: "统计面板" })).toBeVisible();
  // 统计页用内置日历导航时间，统计接口始终拉全量数据。
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname === "/api/usage/stats" && url.searchParams.get("range") === "all",
      ),
    )
    .toBe(true);
  await expect(page.getByLabel("时间范围")).toHaveCount(0);

  // 默认按日模式：日历定位到最新数据月 2026-11，详情为最新日 11-10。
  await expect(page.getByRole("heading", { name: "2026年11月", exact: true })).toBeVisible();
  const dayDetail = page
    .getByRole("heading", { name: /2026-11-10/ })
    .locator("xpath=ancestor::section[1]");
  await expect(dayDetail).toContainText("25");
  await expect(dayDetail).toContainText("43.6K");

  // 当日模型条形图：默认按 Tokens，claude 第一；切到请求数后 kimi 第一。
  const modelTicks = () =>
    dayDetail.locator(".recharts-cartesian-axis-tick-value").allTextContents();
  await expect
    .poll(async () => (await modelTicks()).find((text) => text.includes("claude")))
    .toBeTruthy();
  expect((await modelTicks())[0]).toContain("claude-sonnet-e2e");
  await page.getByRole("button", { name: "请求数", exact: true }).click();
  expect((await modelTicks())[0]).toContain("kimi-k3.1-pro");
  await page.getByRole("button", { name: "Tokens", exact: true }).click();

  // 点击日历中另一天，详情切到 11-09（当日只有 kimi 一个模型）。
  await page.getByRole("button", { name: "选择 2026-11-09" }).click();
  const day9 = page
    .getByRole("heading", { name: /2026-11-09/ })
    .locator("xpath=ancestor::section[1]");
  await expect(day9).toContainText("10");
  await expect(day9).toContainText("5K");
  const ticks9 = await day9.locator(".recharts-cartesian-axis-tick-value").allTextContents();
  expect(ticks9).toHaveLength(1);
  expect(ticks9[0]).toContain("kimi-k3.1-pro");

  // 按月模式：年历选择 2026-10，展示当月每日柱状图与当月模型排名。
  await page.getByRole("button", { name: "按月", exact: true }).click();
  await expect(page.getByRole("heading", { name: "2026年", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "选择 2026-10" }).click();
  const monthDetail = page
    .getByRole("heading", { name: "2026年10月", exact: true })
    .locator("xpath=ancestor::section[1]");
  await expect(monthDetail).toContainText("5");
  await expect(monthDetail).toContainText("6K");
  // 当月只有 10-20 一天有数据 → 每日图仅一根非零高度柱子。
  const visibleBars = monthDetail.locator(".recharts-bar-rectangle:visible");
  await expect(visibleBars).toHaveCount(1);

  // 点击柱子跳回按日模式并选中当天。
  await visibleBars.first().click();
  await expect(
    page.getByRole("heading", { name: /2026-10-20/ }),
  ).toBeVisible();

  // 总览模式：全历史月度柱状图 + 模型排名（Tokens 口径 claude 第一）。
  await page.getByRole("button", { name: "总览", exact: true }).click();
  await expect(page.getByRole("heading", { name: "月度用量", exact: true })).toBeVisible();
  const ranking = page
    .getByRole("heading", { name: "模型用量排名", exact: true })
    .locator("xpath=ancestor::section[1]");
  await expect(ranking).toContainText("claude-sonnet-e2e");
  const rankingTicks = await ranking
    .locator(".recharts-cartesian-axis-tick-value")
    .allTextContents();
  expect(rankingTicks[0]).toContain("claude-sonnet-e2e");

  // 统计接口失败时明确报错，且已加载的数据保留不被清空（LIFO 注册优先于 catch-all；
  // glob 尾部无通配符匹配不到 query string，用正则放行 ?range=...）。
  await page.route(/\/api\/usage\/stats/, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' }),
  );
  await page.getByLabel("计费状态筛选").click();
  await page.getByRole("option", { name: "计费", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "读取用量统计失败" }),
  ).toBeVisible();
  await expect(ranking).toContainText("claude-sonnet-e2e");
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
