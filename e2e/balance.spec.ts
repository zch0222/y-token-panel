import { expect, test, type Page } from "@playwright/test";
import { mockUsageApi } from "./fixtures";

function providerView(name = "E2E Provider") {
  return {
    id: "provider-1",
    name,
    baseUrl: "https://api.example.com",
    kind: "general",
    kindLabel: "通用",
    apiKeyMasked: "sk-e2e…cret",
    createdAt: 1,
    updatedAt: 1,
  };
}

async function openBalance(page: Page) {
  await page.getByRole("button", { name: "余额查询", exact: true }).click();
  await expect(page.getByRole("heading", { name: "余额查询" })).toBeVisible();
}

test("供应商新增支持 Enter 提交，编辑保留凭据，删除需要确认", async ({ page }) => {
  await mockUsageApi(page);
  let providers: Array<ReturnType<typeof providerView>> = [];
  let createPayload: Record<string, unknown> | null = null;
  let updatePayload: Record<string, unknown> | null = null;
  let queryCount = 0;

  await page.route("**/api/balance/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname === "/api/balance/providers" && request.method() === "GET") {
      return json({ providers, cache: {}, storePath: "/tmp/e2e-balance.json" });
    }
    if (url.pathname === "/api/balance/providers" && request.method() === "POST") {
      createPayload = request.postDataJSON();
      providers = [providerView(String(createPayload!.name))];
      return json({ provider: providers[0] }, 201);
    }
    if (url.pathname === "/api/balance/providers/provider-1" && request.method() === "PATCH") {
      updatePayload = request.postDataJSON();
      providers = [{ ...providers[0], name: String(updatePayload!.name) }];
      return json({ provider: providers[0] });
    }
    if (url.pathname === "/api/balance/providers/provider-1" && request.method() === "DELETE") {
      providers = [];
      return json({ ok: true });
    }
    if (url.pathname === "/api/balance/query" && request.method() === "POST") {
      queryCount += 1;
      return json({
        status: "fetched",
        fetchedAt: Date.now(),
        result: {
          success: true,
          data: [{ remaining: 88, unit: "USD", isValid: true }],
          error: null,
          errorKind: null,
        },
      });
    }
    return json({ error: `Unhandled ${request.method()} ${url.pathname}` }, 404);
  });

  await page.goto("/");
  await openBalance(page);
  await page.getByRole("button", { name: "添加第一个供应商" }).click();
  await page.getByRole("button", { name: "自定义供应商", exact: true }).click();

  await page.getByLabel("名称", { exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("请填写供应商名称");
  await page.getByLabel("名称", { exact: true }).fill("E2E Provider");
  await page.getByPlaceholder("https://api.example.com").fill("https://api.example.com");
  await page.getByLabel("API Key", { exact: true }).fill("sk-e2e-secret");
  await page.getByLabel("API Key", { exact: true }).press("Enter");

  await expect(page.getByText("E2E Provider", { exact: true })).toBeVisible();
  await expect(page.getByText("88", { exact: true })).toBeVisible();
  expect(createPayload).toMatchObject({
    name: "E2E Provider",
    baseUrl: "https://api.example.com",
    apiKey: "sk-e2e-secret",
    kind: "auto",
  });
  expect(queryCount).toBe(1);

  await page.getByRole("button", { name: "编辑供应商" }).click();
  await page.getByLabel("名称", { exact: true }).fill("E2E Provider Updated");
  await page.getByLabel("名称", { exact: true }).press("Enter");
  await expect(page.getByText("E2E Provider Updated", { exact: true })).toBeVisible();
  expect(updatePayload).toMatchObject({ name: "E2E Provider Updated", apiKey: "" });

  await page.getByRole("button", { name: "删除供应商" }).click();
  await expect(page.getByRole("dialog", { name: "删除供应商" })).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByText("E2E Provider Updated", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "删除供应商" }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByText("还没有配置供应商", { exact: true })).toBeVisible();
});

test("余额防连点不显示失败红叉，秒级倒计时结束后自动消失", async ({ page }) => {
  await mockUsageApi(page);
  let queryCount = 0;
  const result = {
    success: true,
    data: [{ remaining: 88, unit: "USD", isValid: true }],
    error: null,
    errorKind: null,
  };
  await page.route("**/api/balance/**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/balance/providers") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ providers: [providerView()], cache: {}, storePath: "/tmp/e2e-balance.json" }),
      });
    }
    if (url.pathname === "/api/balance/query") {
      queryCount += 1;
      const throttled = queryCount > 1;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: throttled ? "throttled" : "fetched",
          fetchedAt: Date.now(),
          result,
          waitMs: throttled ? 5_000 : undefined,
        }),
      });
    }
    return route.fulfill({ status: 404, body: "Not found" });
  });

  await page.goto("/");
  await openBalance(page);
  const refresh = page.getByRole("button", { name: "刷新余额" });
  await refresh.click();
  await expect(page.getByText("88", { exact: true })).toBeVisible();
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.getByText(/\ds 后可刷新/)).toBeVisible();
  await expect(refresh).toBeEnabled();
  await page.waitForTimeout(700);
  await expect(refresh.locator(".text-red-400")).toHaveCount(0);
  await expect(page.getByText(/\ds 后可刷新/)).toHaveCount(0, { timeout: 7_000 });
});
