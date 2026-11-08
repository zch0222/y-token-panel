import "server-only";
import { discoverAntigravityTranscripts } from "@/lib/antigravity";
import { parseAntigravityTranscript } from "@/lib/antigravity-session";
import { readGenerationTimings } from "@/lib/antigravity-timing";
import type { IncrementalUsageResult } from "@/lib/incremental-core";
import type { UsageStore } from "@/lib/usage-store";
import { readWholeFileUsageIncremental } from "@/lib/wholefile-incremental";

/**
 * Antigravity 转录会被整体重写（RUNNING 行改写成 DONE、压缩后重排），且解析
 * 依赖同一文件里更早的 Model Selection 事件，所以走整读型增量：未变化文件
 * 零读取，变化文件整文件重读，文件集变化或截断触发来源级重建。
 */
export function readAntigravityUsageIncremental(
  store: UsageStore,
): Promise<IncrementalUsageResult> {
  return readWholeFileUsageIncremental(store, {
    harness: "antigravity",
    discover: discoverAntigravityTranscripts,
    parseFile: (file, content) =>
      parseAntigravityTranscript(content, file.conversationId, file.project, {
        timings: readGenerationTimings(file.conversationDbPath),
      }),
  });
}
