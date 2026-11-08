# `/api/usage` 性能问题与 cc-switch 方案调研报告

> 调研日期：2026-11-08<br>
> 调研对象：当前项目 `y-token-panel`，以及本机相邻目录中的 `cc-switch`（提交 `66e4362b`）<br>
> 文档状态：调研完成，方案待实施<br>
> 关联文档：[用量性能改造里程碑与进度台账](./usage-api-performance-milestones.md)

## 1. 摘要

当前页面骨架加载本身不是主要瓶颈。真正阻塞首次数据展示的是 `/api/usage`：接口每次请求都会重新遍历、读取并解析所有 Harness 的历史会话日志，再把全部归一化记录返回浏览器。

实测接口连续三次响应时间为 **74.8 秒、128.4 秒、178.3 秒**，而绕过 HTTP 直接执行一次并行全量读取约为 **9 秒**。延迟逐轮增长的关键放大因素是：当单次扫描耗时超过 60 秒自动刷新周期后，新的请求会在旧请求完成前继续启动，形成多个并发全量扫描，进一步争抢 CPU、磁盘与 Node.js 事件循环。

cc-switch 对该类问题已经形成了完整方案：

1. 用 SQLite 保存归一化用量、文件同步游标和持久去重账本。
2. 用增量导入替代每次全量重读，刷新成本主要取决于新增日志量。
3. 将“扫描日志”与“查询统计”拆开，页面只查询数据库。
4. 前端通过共享 `pendingSync` 防止同步重入，后端通过互斥锁防止并行扫描。
5. 统计查询不固定轮询；导入新记录后才触发查询失效。
6. 汇总与趋势在服务端聚合，原始请求日志分页获取，不再传输全部历史记录。

对当前项目最合适的方向不是照搬 Rust/Tauri，而是移植其数据流：

```text
原始会话日志
  → 后台增量导入
  → 本地 SQLite / 最后成功快照
  → 聚合或分页查询 API
  → 前端保留旧数据并按 revision 刷新
```

建议先实施前后端 single-flight 阻止延迟继续恶化，再建立持久化存储并优先完成 DSH 帧级增量导入，随后处理 Claude、普通 JSONL 和 Codex 的专项场景。

---

## 2. 调研范围与方法

### 2.1 当前项目实测

本次诊断使用了以下方法：

- 对正在运行的 Next.js 服务 `127.0.0.1:3001` 连续请求 `/api/usage`，记录 TTFB、总耗时与响应字节数。
- 使用临时 Vitest profiling 用例直接并行执行 8 个 reader，绕开 Next.js 路由和 HTTP，比较各数据源的墙钟耗时。
- 对比 HTTP 与直读返回的数据源、文件数和记录数，排除读取了不同数据目录的可能。
- 阅读路由、reader、parser 和前端自动刷新代码。
- 临时 profiling 文件已经删除，未修改现有业务实现。

本轮没有采集浏览器 Performance trace 或 Core Web Vitals；结论针对服务端数据生成与前端请求调度，不是完整的 Lighthouse 审计。

### 2.2 cc-switch 调研

调研范围包括：

- Rust 会话日志导入器、同步游标、去重账本、SQLite 查询与 Tauri command。
- React 用量页、React Query 查询键、自动同步 hook 和事件失效桥接。
- 官方项目文档中的增量同步设计与性能基准。
- DSH、Claude、Codex、Kimi Code 的专项测试。

cc-switch 使用 MIT 许可证。若后续直接移植其代码或实质性代码片段，应保留相应版权与许可证声明；本报告主要借鉴其架构和算法。

---

## 3. 当前实现与性能基线

### 3.1 当前调用链

[用量路由](../src/app/api/usage/route.ts#L12-L38) 每次收到 GET 请求后：

1. 并行执行 8 个 `read*Usage()`。
2. 等待全部 reader 完成。
3. `flatMap` 合并所有历史记录。
4. 按时间排序。
5. 将全部记录通过 JSON 返回。

[前端加载逻辑](../src/components/dashboard/usage-dashboard.tsx#L213-L243) 则：

1. 首次挂载时请求 `/api/usage`。
2. 每 60 秒通过固定 `setInterval` 再请求一次。
3. 没有 in-flight 防重入。
4. 手动刷新与自动刷新没有共享请求。
5. 请求完成后才结束首次 loading。

### 3.2 HTTP 实测

| 次序 | TTFB | 总耗时 | 响应大小 |
| --- | ---: | ---: | ---: |
| 第一次 | 74.771s | 74.815s | 12,310,893 B |
| 第二次 | 128.341s | 128.422s | 12,313,938 B |
| 第三次 | 178.234s | 178.280s | 12,323,174 B |

TTFB 与总耗时只差约 44–82ms，说明主要时间消耗在响应头返回之前的文件读取、解压、解析、争用和服务端序列化阶段，而不是 localhost 网络下载。

第三次响应包含：

- 350 个扫描文件。
- 23,425 条归一化记录。
- 0 个跳过文件。

### 3.3 绕过 HTTP 的 reader 并行直读

| 数据源 | 墙钟耗时 | 记录数 | 扫描文件数 |
| --- | ---: | ---: | ---: |
| DSH | 8.998s | 10,424 | 126 |
| Claude | 8.208s | 4,527 | 43 |
| Qoder | 7.129s | 3,497 | 49 |
| Codex | 6.202s | 1,230 | 89 |
| KCode | 1.066s | 476 | 7 |
| WorkBuddy | 0.935s | 501 | 5 |
| CodeBuddy | 0.516s | 377 | 5 |
| ZCode | 0.031s | 2,384 | 26 个会话 |
| **总计** | **约 9.006s** | **23,416** | **350** |

这些 reader 是并行执行的，单项时间包含彼此之间的 CPU 争用，不能相加。DSH 是活跃数据源，后续 HTTP 请求的记录数略有增长属于预期现象。

直读与 HTTP 的数据源和扫描规模一致，说明 Next.js 没有读取另一份更大的数据目录。HTTP 时间远高于单次直读，且逐轮增加，与自动刷新造成的扫描叠加和服务拥塞一致。

---

## 4. 根因分析

### 4.1 每次请求都全量扫描历史

[路由实现](../src/app/api/usage/route.ts#L15-L38) 没有持久快照、文件游标、请求合并或统计数据库。虽然 8 个数据源使用了 `Promise.all`，接口仍必须等待最慢的数据源完成。

这意味着刷新成本随全部历史增长，而不是随新增日志增长。

### 4.2 reader 内部逐文件串行读取并全文解析

典型实现包括：

- [DSH reader](../src/lib/dsh.ts#L79-L99)：完整读取文件，同步解压 Zstd 帧，再逐行解析。
- [Claude reader](../src/lib/claude.ts#L44-L53)：完整读取转录并调用全文 parser。
- [Qoder reader](../src/lib/qoder.ts#L164-L193)：递归遍历并逐文件读取全部 JSONL。
- [Codex reader](../src/lib/codex.ts#L165-L174)：先读取并保存全部 rollout 内容，再进行跨文件解析。

`readFile` 只将磁盘等待变为异步。以下工作仍占用 Node.js 主线程：

- 同步 Zstd 解压。
- 大字符串拆分。
- 逐行 `JSON.parse`。
- 记录归一化、排序与跨文件依赖处理。
- 大响应的 JSON 序列化。

因此，简单增加文件级并发可能进一步提高 CPU 和内存压力，并不能可靠缩短总耗时。

### 4.3 自动刷新周期短于请求耗时，且没有防重入

[前端定时器](../src/components/dashboard/usage-dashboard.tsx#L234-L243) 每 60 秒直接调用 `loadUsage()`，不会判断上一次请求是否仍在执行。

当接口耗时超过 60 秒后：

```text
第 1 次扫描仍未完成
  → 第 2 次扫描开始
  → CPU / IO / 事件循环争用加剧
  → 两次扫描都变得更慢
  → 后续刷新继续叠加
```

手动刷新与自动刷新之间也存在同类问题。多个重叠请求的 `finally` 还会分别清除 `loading` / `refreshing`，使状态提示提前结束；旧响应也存在覆盖新响应的风险。

### 4.4 全量响应是次要但真实存在的成本

每次返回约 12.3MB 全量记录，会增加：

- 服务端对象保留与 JSON 序列化成本。
- 浏览器 JSON 解析和内存占用。
- 自动刷新时的数据替换与 React 计算成本。

但当前网络传输只占几十毫秒，所以压缩响应或拆分页不能替代扫描与并发修复。

### 4.5 `connection()` 不是瓶颈

路由中的 `connection()` 只用于声明请求时执行，不承担日志读取或扫描工作。当前没有证据将其视为耗时来源。

---

## 5. cc-switch 的解决方案

### 5.1 总体数据流

[cc-switch 会话用量模块](../../cc-switch/src-tauri/src/services/session_usage.rs#L1-L9) 明确采用：

```text
会话 JSONL
  → 增量解析
  → 去重与费用计算
  → proxy_request_logs 表
```

其关键不是“Rust 比 Node.js 快”，而是：

- 扫描结果持久化。
- 后续同步只处理变化。
- 页面读取数据库，不直接读取原始日志。
- 导入和查询使用不同的触发机制。

### 5.2 持久游标与去重账本

[cc-switch 数据库结构](../../cc-switch/src-tauri/src/database/schema.rs#L309-L350) 包含：

- `session_log_sync`
  - 文件路径。
  - 最后修改时间。
  - 字节偏移。
  - 尾部指纹。
  - parser state。
- `session_usage_dedup`
  - 数据来源。
  - 请求 ID。
  - 语义 ID。
  - 是否存在明细入口。
- `usage_daily_rollups`
  - 历史日聚合，供明细清理后继续查询。

持久去重账本独立于明细行保留周期，防止文件重扫、分叉或明细清理后重复累计历史。

当前项目第一版不一定需要日聚合表，但**同步游标与持久去重是增量导入的基础**。

### 5.3 DSH：完整帧游标与 parser state

[cc-switch DSH 单文件同步](../../cc-switch/src-tauri/src/services/session_usage_dsh.rs#L165-L229) 实现了：

1. 文件未变化且游标已在 EOF 时直接跳过。
2. 从上次字节位置续读。
3. 续读点不是合法帧头时从头重扫。
4. 只把游标推进到最后一个完整帧。
5. 持久化尚未完成的 `step/start` 状态。
6. 记录写入、去重和游标推进在一个事务中提交。

[cc-switch DSH 读取与边界处理](../../cc-switch/src-tauri/src/services/session_usage_dsh.rs#L333-L387) 分别处理：

- Zstd：只解压完整帧，残缺尾帧等待下一轮。
- 普通 JSONL：只提交完整行，未换行尾部等待追加。

当前项目已经有等价的 [Zstd 帧扫描与解码基础](../src/lib/dsh-session.ts#L88-L160)，因此 DSH 是移植成本最低、预期收益最高的数据源。

### 5.4 Claude：普通 JSONL 字节游标与上下文恢复

[cc-switch Claude 增量读取](../../cc-switch/src-tauri/src/services/session_usage.rs#L625-L770) 的关键机制包括：

- 字节游标只推进到最后完整行。
- 尾部指纹检测同尺寸或更大范围的文件重写。
- 续读前恢复对话链和计时上下文。
- 中途读取失败时保留已经提交的进度。
- 不让未完成的半行导致永久漏记。

[cc-switch Claude 事务提交](../../cc-switch/src-tauri/src/services/session_usage.rs#L867-L954) 将记录写入和游标推进放在同一事务中。

当前 Claude parser 同样维护对话链、消息计时和候选消息，因此不能只把文件尾部交给现有 parser。建议先跳过未变化文件，再实现带上下文恢复的字节增量。

### 5.5 Codex：父时间线与 deferred 依赖缓存

[cc-switch Codex 解析结果说明](../../cc-switch/src-tauri/src/services/session_usage_codex.rs#L458-L477) 明确指出：文件字节位置只用于变化检测，不能简单作为续读位置，因为解析涉及父线程、fork、续写和重放剔除。

[cc-switch Codex 缓存结构](../../cc-switch/src-tauri/src/services/session_usage_codex.rs#L480-L513) 保存：

- 父 rollout 时间线。
- replay prefix。
- deferred 原因。
- 子文件与父文件依赖状态。

[cc-switch Codex 文件身份戳](../../cc-switch/src-tauri/src/services/session_usage_codex.rs#L90-L147) 不仅包含 mtime 和大小，还使用 Unix device/inode 或 Windows 卷序列号与文件 ID，降低同尺寸替换误判风险。

因此，Codex 不适合直接套用普通 JSONL 的字节续读，也不适合只根据子文件 mtime 做永久 deferred 缓存。

### 5.6 Kimi Code：未变化跳过，变化时重读

[cc-switch Kimi 扫描入口](../../cc-switch/src-tauri/src/services/session_usage_kimi.rs#L47-L67) 在未变化时跳过 wire 文件；变化后仍重新读取，并依靠持久账本去重和补充记录。

这证明不同 reader 可以采用不同增量级别，无需为了统一抽象而一次完成所有复杂字节游标。

### 5.7 前后端两层防重入

[cc-switch 前端自动同步 hook](../../cc-switch/src/hooks/useUsageAutoRefresh.ts#L32-L50) 使用共享 `pendingSync`：

- 自动 tick 遇到 pending 直接跳过。
- 手动同步复用正在进行的自动任务。
- 调用方共享同一个 Promise。
- 窗口隐藏时跳过，重新显示时补扫。

[cc-switch 手动同步 command](../../cc-switch/src-tauri/src/commands/usage.rs#L349-L363) 在后端再使用全局互斥锁，并通过 `spawn_blocking` 执行阻塞工作。

需要区分：

- 前端 `pendingSync` 是 single-flight，合并调用并共享结果。
- 后端 Mutex 是互斥排队，保证不并行，但等待者获得锁后仍可能再执行一轮。

当前 Next.js 项目应同时实现前端和服务端的共享 in-flight Promise，避免锁后排队的重复扫描。

### 5.8 扫描间隔不等于统计查询间隔

[cc-switch 用量页](../../cc-switch/src/components/usage/UsageDashboard.tsx#L453-L469) 对主要统计查询设置了 `refetchInterval: false`。

用户配置的扫描间隔只控制会话日志导入。后台兜底扫描为每 10 分钟一次，见 [cc-switch 后台任务](../../cc-switch/src-tauri/src/lib.rs#L1473-L1517)。

[cc-switch 新记录事件桥接](../../cc-switch/src/hooks/useUsageEventBridge.ts#L5-L24) 在导入新记录后才让 usage 查询失效；没有新数据时只更新最近同步时间。

统计查询还有以下特征：

- 汇总、趋势和分组请求都携带时间及筛选参数。
- 请求日志按筛选条件分页，见 [cc-switch 日志查询](../../cc-switch/src-tauri/src/services/usage_stats.rs#L2143-L2261)。
- 详情按 ID 单独查询。
- 切换筛选和翻页时通过 `keepPreviousData` 保留旧内容，见 [cc-switch 查询 hooks](../../cc-switch/src/lib/query/usage.ts#L177-L205)。

---

## 6. 对当前项目的可移植性判断

| 方案 | 可移植性 | 建议 |
| --- | --- | --- |
| 前后端 single-flight | 高，不依赖 Rust/Tauri | 第一阶段直接实施 |
| 可见性暂停与回前台补扫 | 高 | 与 single-flight 一起实施 |
| SQLite 归一化记录与游标 | 高 | 复用项目已有 `node:sqlite` 运行条件 |
| DSH 帧级增量 | 高 | 优先实施，现有帧扫描代码可直接扩展 |
| Claude 字节游标 | 中高 | 先处理上下文与消息补全，再实施 |
| Qoder 普通 JSONL 字节游标 | 中高 | parser 状态较少，可排在 DSH 后 |
| CodeBuddy / WorkBuddy 增量 | 中 | 先分析 parser 上下文，变化文件可先整读 |
| Codex 字节续读 | 低，不适合 | 改为父时间线和依赖失效缓存 |
| React Query | 可选 | 不是修复前提，现有 React 状态也能实现 |
| Tauri 事件机制 | 不可直接使用 | 用扫描完成回调、revision 轮询或 SSE 替代 |
| `spawn_blocking` | 不可直接使用 | 用 worker 或有界后台任务隔离主线程 |
| 日聚合与明细清理 | 当前非必需 | 数据规模增长后再增加 |

在 cc-switch 会话用量 importer 中没有可直接对应的 Qoder、CodeBuddy、WorkBuddy、ZCode 实现，因此这些数据源只能复用通用游标和去重思想，不能声称可以直接拷贝专用 parser。

---

## 7. 建议目标架构

### 7.1 过渡期：保持前端响应结构，先拆分扫描

```text
GET /api/usage
  → 读取最后成功快照 / SQLite
  → 立即返回，不触发全量扫描

POST /api/usage/sync
  → 若已有任务则共享 inFlight
  → 否则后台扫描并增量导入
  → 返回 imported、filesScanned、errors、lastSync、revision

GET /api/usage/status
  → 返回 syncing、lastSync、revision、lastError
```

为了降低第一阶段前端改动，GET 可以暂时继续返回现有 `UsageResponse` 结构，但数据应来自快照或数据库，而不是现场扫描全部原始日志。

### 7.2 最终读模型

按页面需要拆分：

- 汇总卡片查询。
- 趋势查询。
- 项目、供应商、模型和 Harness 分组查询。
- 请求日志分页查询。
- 单条请求详情查询。
- 轻量 revision/status 查询。

只有导入结果或 revision 变化时才刷新统计。滚动“今天”等时间范围可另外按分钟失效，以处理跨午夜问题。

### 7.3 建议持久化结构

第一版最少包括：

- `usage_records`：归一化请求记录，以及时间、Harness、项目、供应商和模型索引。
- `session_log_sync`：文件身份、mtime、字节游标、尾部指纹、parser state。
- `usage_dedup`：数据来源与请求 ID 的持久去重记录。

`usage_daily_rollups`、明细清理和跨设备同步不在第一阶段范围内。

---

## 8. 正确性风险与约束

### 8.1 首次导入仍然是全量成本

增量机制只能降低后续同步成本，不能消除第一次历史导入。cc-switch 同样需要进行首次全量回填。

因此，首次导入应：

- 在后台执行，不阻塞页面查询和其他 API。
- 提供“首次导入中”的明确状态。
- 尽可能按文件事务提交，避免一次失败导致全部重来。
- 有旧快照时优先展示旧快照。

### 8.2 半行、半帧与文件重写

必须覆盖：

- 普通 JSONL 半行在后续补全。
- Zstd 半帧在后续补全。
- 文件截断。
- 同尺寸重写。
- 文件替换与轮转。
- 游标超过 EOF。
- 读取中途失败。

不同数据源可以根据持久去重能力选择“从头重扫并去重”或“跳过被改写区间”，不能把某一种策略机械套用到全部 reader。

### 8.3 parser 上下文

以下信息不能因只读新增内容而丢失：

- DSH 的 `step/start`。
- Claude 的对话链、首块和消息补全状态。
- Kimi 的请求索引与模型关联。
- Codex 的父线程、续写基线与 fork 重放信息。

### 8.4 去重与更新不是同一操作

部分记录只需要 `INSERT OR IGNORE`，但 Claude/Kimi 等记录可能在后续日志中补齐模型、耗时或首字时间，需要更新保留明细。

如果未来引入明细清理，去重账本必须独立保留，不能依赖明细行是否存在。

### 8.5 本地服务与隐私

数据库和快照仍应只保存在本机，不改变“会话内容不上传”的产品承诺。优先存归一化用量，不保存完整会话正文。

---

## 9. 性能证据的解释边界

cc-switch 项目文档记录了两组基准：

- [DSH 集成文档](../../cc-switch/docs/deepseek-harness-integration-zh.md#L102-L107)：追加帧同步在其测试环境中达到微秒级。
- [Claude 增量发布说明](../../cc-switch/docs/release-notes/v3.20.1-zh.md#L126-L134)：12MB 活跃文件从整读 6.04 秒降为增量 9.3ms，并对 1,017 个文件、409MB 冻结快照做一致性回放。

这些是 cc-switch 在其环境和 Rust 实现中的结果，本次没有重新运行，也不能直接作为 Node.js 移植后的性能承诺。

当前项目应在每个里程碑完成后记录自己的：

- 冷导入耗时。
- 未变化刷新耗时。
- 追加一个小事件后的增量耗时。
- API TTFB 与总耗时。
- 响应字节数。
- 并发请求时实际扫描次数。
- 记录数与抽样 ID 的一致性。

---

## 10. 推荐实施顺序

1. **前后端 single-flight、可见性暂停、过期响应保护**：先阻止延迟持续累积。
2. **SQLite / 最后成功快照与扫描查询分离**：让 GET 不再承担现场扫描。
3. **DSH 帧级增量**：优先解决当前最慢且已有良好基础的数据源。
4. **Claude 与普通 JSONL 增量**：逐步加入字节游标和 parser 上下文。
5. **Codex 父时间线与 deferred 依赖缓存**：单独处理，不做朴素字节缓存。
6. **聚合、分页和 revision 驱动刷新**：消除 12MB 全量响应。
7. **全量一致性与并发回归**：确认性能优化没有改变统计口径。

详细任务、状态和验收记录见[里程碑与进度台账](./usage-api-performance-milestones.md)。
