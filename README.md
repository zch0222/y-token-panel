# Y Token Panel

参考 CC Switch 用量统计模板实现的 CodeBuddy CLI 本地 Token 用量面板。使用 Next.js、Tailwind CSS、shadcn/ui 和 Recharts。

## 功能

- 读取本机 CodeBuddy CLI 会话 JSONL，展示真实 Token、Credits 和缓存用量
- 当天、昨天、近 7 天、近 30 天和全部时间筛选
- 按项目、供应商、模型组合筛选
- 请求数、Tokens、Credits、缓存命中率趋势图（柱状图 / 面积图）
- 请求日志、供应商、模型和项目聚合表格
- 请求详情、分页、CSV 导出、自动刷新、深色 / 浅色主题
- 余额查询面板：集中查询供应商账户余额，内置限流保护（见下文）

## 启动

要求 Node.js 22.18 或更高版本（本地 SQLite 快照与独立 TypeScript worker 均使用该运行时能力）。

~~~bash
npm install
npm run dev
~~~

打开 <http://127.0.0.1:3000>。

## 数据源

默认读取：

~~~text
~/.codebuddy/projects/<project>/*.jsonl
~~~

可以通过 **CODEBUDDY_DATA_DIR** 指定另一个 CodeBuddy projects 目录：

~~~powershell
$env:CODEBUDDY_DATA_DIR="D:\path\to\projects"
npm run dev
~~~

WorkBuddy（CodeBuddy 衍生的桌面 / CLI agent）数据源同样是本地会话 JSONL：

~~~text
~/.workbuddy/projects/<压缩 cwd>/<会话>.jsonl（子 agent 在 <父会话>/subagents/ 下）
~~~

可以通过 **WORKBUDDY_CONFIG_DIR**（与 WorkBuddy 自身的环境变量一致）指定另一个 `.workbuddy` 根目录（其下需有 `projects`），或用 **WORKBUDDY_DATA_DIR** 覆盖。字段语义按本机 WorkBuddy 2.137.1 的 CLI bundle（@genie/agent-cli 2.165.0）反查确认：用量在 `message`（assistant）/ `function_call` 条目的 `providerData`（归一化 `usage` + 提供方原始 `rawUsage`），Responses API 走独立 `model-usage` 事实条目；`usage.inputTokens` 是含缓存的总输入（total 口径），缓存读写按官方 `getCacheReadTokens` / `getCacheCreationTokens` 回退链取第一个正数（DeepSeek 的 `prompt_cache_miss_tokens` 计入缓存写入）；`rawUsage.credit` 是服务端逐请求上报的计费 Credits。同一 id 会先落无 usage 行、响应结束补全后重写，按 last-wins 去重；credits 按 `messageId` 去重后与 WorkBuddy 自身 workbuddy.db `session_usage.credit_json` 的聚合精确一致（本机实测对账相等）。项目目录直下 `agent-` 前缀的遗留文件跳过，`subagents/` 下的子 agent 用量计入。转录里没有单请求延迟，耗时沿 `parentId` 父链回溯到请求边界估算（含首字等待）。

ZCode 数据源是其本地用量库（SQLite，只读打开）：

~~~text
~/.zcode/cli/db/db.sqlite（model_usage 表，join session 表取项目目录）
~~~

可以通过 **ZCODE_DATA_DIR** 指定另一个 `.zcode` 根目录（其下需有 `cli/db/db.sqlite`）。读取该库使用 `node:sqlite`；应用整体最低 Node.js 版本见“启动”。注意 ZCode 自身只保留最近 30 天的用量行。

KCode（Kimi Code）数据源是其本地会话 wire 日志：

~~~text
~/.kimi-code/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl
~~~

可以通过 **KIMI_CODE_HOME**（与 Kimi Code 自身的环境变量一致）指定另一个 `.kimi-code` 根目录（其下需有 `sessions`）。主 agent 读已提交的 assistant 消息用量，子 agent 读 `step.end` 用量；输入 Tokens 已扣除缓存（新鲜输入口径），请求耗时取 wire 内的原生计时（含首字等待，不含工具执行）。wire 里没有 Credits 字段，KCode 记录不参与 Credits 统计。

Claude Code 数据源是其本地会话转录：

~~~text
~/.claude/projects/<项目>/<会话>.jsonl（子 agent 在 <会话>/subagents/ 下）
~~~

可以通过 **CLAUDE_CONFIG_DIR**（与 Claude Code 自身的环境变量一致）指定另一个 `.claude` 根目录（其下需有 `projects`）。字段语义按本机 Claude Code 2.1.317 的代码反查确认：`message.usage` 是 Anthropic Messages API 的原始用量，同一响应按内容块落多行、按响应 message ID 去重；输入 Tokens 不含缓存读写（新鲜输入口径）。转录里没有单请求延迟，耗时按时间戳沿 `parentUuid` 父链估算（含首字等待）；`cost-state` 是会话级累计、无法归因到单请求，因此 Claude Code 记录不参与 Credits 统计。统计基于当前转录内容，与 Claude 自身 /cost 的全程累计相比可能略低（失败重试等场景的行会被清理），属数据源口径差异。

Codex / ChatGPT（Codex CLI 与 Codex Desktop）数据源是其本地 rollout 会话：

~~~text
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（7 天不动会压成 .jsonl.zst）
~/.codex/archived_sessions/*.jsonl[.zst]
~~~

可以通过 **CODEX_HOME**（与 Codex 自身的环境变量一致）指定另一个 `.codex` 根目录（其下需有 `sessions`）。字段语义按本机 Codex 的二进制与真实 rollout 反查确认，解析口径对齐 cc-switch 的会话导入：优先取每次请求的精确 `last_token_usage`，缺失时按 `total_token_usage` 累计差推；限额刷新重发的相同快照按来源去重；缓存读 / 写是 `input_tokens` 的不相交组成部分，输入 Tokens 按扣除缓存后的新鲜输入统计；子代理 fork 复制的父历史事件按签名序列剔除重放，翻页续写页恢复前序分段的累计基线（bounded 引用走字节区间校验）。读取压缩形态需要 Node.js 22.15+（`zlib.zstdDecompressSync`）；版本过低时压缩文件跳过，普通 `.jsonl` 照常。rollout 里没有单请求费用，Codex 记录不参与 Credits 统计；耗时按各行时间戳估算（含首字等待）。

## 本地用量快照与同步

用量数据默认持久化到项目目录的 `.data/usage.sqlite`（该目录已被 Git 忽略），可通过 **USAGE_DB_PATH** 指定其他数据库文件。数据库保存归一化用量、来源状态、去重账本、后续增量游标和最后一次成功快照，不保存完整会话正文。当前 schema 为 v2，启动时通过事务自动迁移；未知版本、错误 application_id 或不完整 schema 会明确报错，不会删除原库重建。

- `GET /api/usage` 只读取最后成功快照，不扫描原始会话日志；数据库为空时明确返回 `snapshotAvailable: false`。这是 M6 前的 legacy 响应（仍含全部 records，约 12.7MB），保留用于兼容，页面默认不再调用。
- `GET /api/usage/query?range=&harness=&project=&provider=&model=&billing=` 在 SQLite 中聚合返回汇总卡片、趋势、各维度分组、下拉 facet 与来源状态（默认筛选约 4–50KB），带 `X-Usage-Revision` 头；非法参数返回 400。
- `GET /api/usage/records?…&page=&pageSize=` 按同一筛选分页返回请求日志，页大小服务端钳制在 1–100（默认 10）；`GET /api/usage/records/detail?harness=&recordId=` 按 ID 查询单条详情。
- `GET /api/usage/export?…` 按同一筛选导出全部命中记录的 CSV。
- `POST /api/usage/sync` 在独立 worker 中执行扫描、解析和事务写入，同进程重叠请求共享同一轮同步；只返回 revision 等小结果（约 0.2KB），不再回传全部记录，客户端按 revision 变化决定是否重查聚合视图。
- `GET /api/usage/sync` 查询导入状态、revision、最后成功时间与错误；同步失败不会清空旧快照。
- 前端刷新由 revision 驱动：数据未变化时自动同步只更新“上次同步”时间；滚动范围（当天等）保留按分钟失效以处理跨午夜。worker 默认最长运行 10 分钟，可通过 **USAGE_SYNC_TIMEOUT_MS** 调整（毫秒）。超时后释放本轮请求，可重新同步。

应用只提取时间、项目、模型和用量元数据，不读取或返回对话正文。开发和生产启动脚本默认只监听 127.0.0.1；不要将本地用量接口直接暴露到公网。

## 余额查询

「余额查询」视图支持查询供应商账户余额，查询口径与限流策略参考 cc-switch（`balance.rs` 与 usage 脚本模板）。支持：

- **原生供应商**：DeepSeek（多币种钱包）、StepFun、SiliconFlow（.cn 人民币 / .com 美元）、OpenRouter（剩余 = 总额度 − 已用）、Novita AI、智谱 / Z.ai（账户余额报表，Key 不带 Bearer）
- **通用模板**：new-api 中转站（`/api/user/self`，Access Token + 用户 ID，500000 配额 = $1）、Sub2API（`/v1/usage`）、通用 `/user/balance`

Base URL 命中已知供应商时自动识别模板，其余按所选模板查询。供应商配置与 Key 保存在本机（默认 `~/.y-token-panel/balance.json`，可用 **Y_TOKEN_PANEL_DATA_DIR** 指定其他根目录），接口只返回脱敏后的 Key（前 6 后 4）。

### 限流与防风控

为避免高频查询触发供应商风控，查询由服务端强制限流（手动刷新同样受限）：

- 同一供应商两次真实查询至少间隔 **60 秒**，间隔内的请求直接返回缓存
- 单次请求 15 秒超时；网络错误 / 5xx 自动重试 1 次（1.5 秒后），HTTP 429 不重试
- 瞬时失败（网络 / 5xx）后冷却 60 秒；被限流（HTTP 429）后冷却 5 分钟，期间不外呼并继续展示上次成功值
- HTTP 401 / 403 判定为 Key 失效并明确提示，不当作网络问题反复重试；零余额不判失效
- 同一供应商的并发查询在服务端合并为一次请求；「全部刷新」最多 2 路并发
- 自动刷新间隔最小 1 分钟（默认 5 分钟），且仅在余额视图可见时轮询
- 限流与冷却状态随配置持久化，重启面板后依然生效

## 统计口径

- **请求数**：包含用量字段的 CodeBuddy API 调用记录数。
- **总 Tokens**：优先使用原始 total_tokens。CodeBuddy 的输入 Tokens 已包含缓存读取，因此不会再次累加缓存 Tokens。
- **缓存命中率**：缓存读取 Tokens ÷ 输入 Tokens。
- **Credits**：原始 credit 字段的合计，不是美元金额；缺失时显示为 —。
- **成功率**：根据会话记录状态统计，不推测日志中没有的 HTTP 状态码、首字时间或生成速度。

## 检查

~~~bash
npm run lint
npm run typecheck
npm run build
~~~
