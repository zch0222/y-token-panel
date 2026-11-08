import { describe, expect, it } from "vitest";
import { mapBounded } from "@/lib/incremental-core";

describe("mapBounded", () => {
  it("保持结果顺序并与输入一一对应", async () => {
    const items = Array.from({ length: 50 }, (_, index) => index);
    const results = await mapBounded(items, 4, async (item) => {
      // 用不定长延迟打乱完成顺序，验证结果仍按输入序返回。
      await new Promise((resolve) => setTimeout(resolve, (item * 7) % 13));
      return item * 2;
    });
    expect(results).toEqual(items.map((item) => item * 2));
  });

  it("并发度不超过限制", async () => {
    let running = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, index) => index);
    await mapBounded(items, 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("单个任务抛错时整体拒绝（有界并发不吞错）", async () => {
    await expect(
      mapBounded([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error("boom");
        return item;
      }),
    ).rejects.toThrow("boom");
  });

  it("空输入与 limit 大于长度时正常工作", async () => {
    expect(await mapBounded([], 8, async (item) => item)).toEqual([]);
    expect(await mapBounded([1, 2], 100, async (item) => item + 1)).toEqual([2, 3]);
  });
});
