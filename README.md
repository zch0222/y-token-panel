# Y Token Panel

参考 CC Switch 用量统计模板实现的 CodeBuddy CLI 本地 Token 用量面板。使用 Next.js、Tailwind CSS、shadcn/ui 和 Recharts。

## 功能

- 读取本机 CodeBuddy CLI 会话 JSONL，展示真实 Token、Credits 和缓存用量
- 当天、昨天、近 7 天、近 30 天和全部时间筛选
- 按项目、供应商、模型组合筛选
- 请求数、Tokens、Credits、缓存命中率趋势图（柱状图 / 面积图）
- 请求日志、供应商、模型和项目聚合表格
- 请求详情、分页、CSV 导出、自动刷新、深色 / 浅色主题
- 余额查询面板：集中查询供应商账户余额与 GLM / Kimi 等编程套餐额度，内置限流保护（见下文）

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

可以通过 **CODEBUDDY_DATA_DIR** 直接指定另一个 CodeBuddy projects 目录，或通过 CodeBuddy 官方的 **CODEBUDDY_CONFIG_DIR** 指定整个配置根目录（其下需有 `projects`）；前者优先级更高：

~~~powershell
$env:CODEBUDDY_DATA_DIR="D:\path\to\projects"
npm run dev
~~~

WorkBuddy（CodeBuddy 衍生的桌面 / CLI agent）数据源同样是本地会话 JSONL：

~~~text
~/.workbuddy/projects/<压缩 cwd>/<会话>.jsonl（子 agent 在 <父会话>/subagents/ 下）
~~~

可以通过 **WORKBUDDY_DATA_DIR** 或 **WORKBUDDY_CONFIG_DIR**（与 WorkBuddy 自身的环境变量一致）指定另一个 `.workbuddy` 根目录（其下需有 `projects`）；前者优先级更高。注：WorkBuddy 的 `WORKBUDDY_INSTANCE_NUMBER` 仅作用于窗口名与 URI scheme，不改变配置目录；面板同进程同时读取 CodeBuddy，故不会回退读取 `CODEBUDDY_CONFIG_DIR`。字段语义按本机 WorkBuddy 2.137.1 的 CLI bundle（@genie/agent-cli 2.165.0）反查确认：用量在 `message`（assistant）/ `function_call` 条目的 `providerData`（归一化 `usage` + 提供方原始 `rawUsage`），Responses API 走独立 `model-usage` 事实条目；`usage.inputTokens` 是含缓存的总输入（total 口径），缓存读写按官方 `getCacheReadTokens` / `getCacheCreationTokens` 回退链取第一个正数（DeepSeek 的 `prompt_cache_miss_tokens` 计入缓存写入）；`rawUsage.credit` 是服务端逐请求上报的计费 Credits。同一 id 会先落无 usage 行、响应结束补全后重写，按 last-wins 去重；credits 按 `messageId` 去重后与 WorkBuddy 自身 workbuddy.db `session_usage.credit_json` 的聚合精确一致（本机实测对账相等）。项目目录直下 `agent-` 前缀的遗留文件跳过，`subagents/` 下的子 agent 用量计入。转录里没有单请求延迟，耗时沿 `parentId` 父链回溯到请求边界估算（含首字等待）。

Qoder CN 数据源是其本地会话 JSONL（递归读取项目目录）：

~~~text
~/.qoder-cn/projects/<项目>/**/*.jsonl
~~~

可以通过 **QODER_DATA_DIR** 直接覆盖 projects 目录。官方 **QODERCN_CONFIG_DIR** 指定完整配置根目录；未设置时对齐本机 Qoder CN 主进程与 SDK 规则，用 **QODERCN_CLI_HOME**（缺省用户目录）拼接 **QODERCN_CONFIG_DIR_NAME**（缺省 `.qoder-cn`）。`message.usage` 提供 Tokens 与 Credits；仅 `billable=true` 的 Credits 计入实际消耗，`billable=false` 的报告值单独保留。无上游请求 ID 时使用稳定的文件行号 ID，增量游标会持久化行号基准。

ZCode 数据源是其本地用量库（SQLite，只读打开）：

~~~text
~/.zcode/cli/db/db.sqlite（model_usage 表，join session 表取项目目录）
~~~

可以通过 **ZCODE_DATA_DIR** 指定另一个 `.zcode` 根目录（其下需有 `cli/db/db.sqlite`）。未设置该面板变量时，对齐本机 ZCode CLI（`zcode.cjs`）的解析顺序：`ZCODE_SESSION_DB_PATH` / `ZCODE_SESSION_DB`（按枚举顺序后者覆盖前者，非空字符串生效），随后读取 `~/.zcode/cli/config.json` 的 `storage.sessionDbPath`，最后回退默认库；`~/` 前缀展开到用户目录，其余路径按 `path.resolve` 解析，配置文件缺失、损坏或字段类型不合法时与 `zcode.cjs` 一样静默回退默认库。读取该库使用 `node:sqlite`；应用整体最低 Node.js 版本见“启动”。注意 ZCode 自身只保留最近 30 天的用量行。

KCode（Kimi Code）数据源是其本地会话 wire 日志：

~~~text
~/.kimi-code/sessions/<workspace>/<session>/agents/<agent>/wire.jsonl
~~~

可以通过 **KIMI_CODE_HOME**（与 Kimi Code 自身的环境变量一致，空白值忽略并支持 `~`、`~/`、`~\` 展开）指定另一个 `.kimi-code` 根目录（其下需有 `sessions`）。旧版主 agent 读已提交的 assistant 消息用量，1.3.5 起主/子 agent 统一消费带用量的 `step.end`（按 `messageId` 去重、并在代理省略响应 `messageId` 时回退 `uuid` / 文件行号）及 `usageScope="session"` 压缩操作，并结合 `config.toml` 的 `[models.*]` 解析自定义模型名与第三方供应商（官方渠道归为 `"Moonshot AI"`）；输入 Tokens 已扣除缓存（新鲜输入口径），请求耗时取 wire 内的原生计时（含首字等待，不含工具执行）。wire 里没有 Credits 字段，KCode 记录不参与 Credits 统计。

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

DeepSeek Harness（DSH）数据源是其本地会话日志：

~~~text
~/.dsh/sessions/<项目>/<会话>/session.<版本>.jsonl[.zstd]
~~~

可以通过 **DSH_HOME** 指定另一个 DSH 根目录；空白值按未设置处理，`~`、`~/` 和 `~\` 按 DSH 自身规则展开。逐帧压缩日志只解压新增完整帧，普通 JSONL 只读取新增完整行；`step/start` 与未完成行字节跨轮持久化。输入 Tokens 不含缓存读写，无 Credits 字段，耗时按 `step/start` 到响应事件估算。

Antigravity 数据源是其本地会话转录：

~~~text
~/.gemini/antigravity/brain/<会话>/.system_generated/logs/transcript.jsonl（紧凑版）
~/.gemini/antigravity-cli/brain/...（agy CLI，布局相同）
~~~

可以通过 **ANTIGRAVITY_DATA_DIR** 指定另一个数据根目录（其下需有 `brain` 与 `conversation_summaries.db`）。字段语义按本机 Antigravity IDE 的 `resources/bin/language_server.exe` 与 `conversations/<id>.db` 反查确认：每行一个 step，只有 `PLANNER_RESPONSE` 与 `CHECKPOINT`（上下文压缩请求）带 `input_tokens` / `cache_read_tokens` / `output_tokens`；`input_tokens` 是不含缓存的新鲜输入（实测同一响应 input 24011、cache 117055，input 含缓存不可能成立），`output_tokens` 已包含思考（数据库里 thinking 289 + response 125 = output 414），转录里没有缓存写入与 Credits 字段；`PLANNER_RESPONSE` 的耗时取自 `conversations/<id>.db` 的首字等待 + 流式 Duration（`steps.metadata` 的 generation 索引 → `gen_metadata` 字段 11/12），`CHECKPOINT` 的原生引用指向下一条生成，不计耗时。只导入状态为 `DONE` 且用量非零的响应，按会话 ID + step 索引去重。转录没有模型字段，模型按会话内 `Model Selection` 切换事件继承，缺失时记为「未知模型」；项目名取自 `conversation_summaries.db` 的工作区 URI。

Pi Desktop（vastsa/PI-Desktop 桌面编码助手）数据源是其本地会话转录：

~~~text
~/.pi-desktop/sessions/<会话 uuid>.jsonl
~~~

可以通过 **PI_DESKTOP_DATA_DIR**（与 PI-Desktop 自身的环境变量一致）指定另一个数据根目录（其下需有 `sessions`）；未设置时跟随应用内存储位置设置（Electron userData 下的 `storage-location.json`，损坏或缺失时静默回退默认根；`PI_DESKTOP_DEV=1` 的开发安装为 `~/.pi-desktop-dev`）。字段语义按本机 PI-Desktop 0.22.0 的代码反查确认（app.asar 主进程 `usageFromPi` 归一化、host-core 的 transcript 写入口径）：用量只出现在 `role:"assistant"` 消息的 `meta.usage`，`inputTokens` 不含缓存读写（新鲜输入口径），`reasoningTokens` 是 output 子集不另行累计，`totalTokens` 为上游报告值（权威，缺失回退四项求和）；`operationId` 是单次模型请求的稳定标识，消息编辑重写后不变，按其去重（无则回退消息 id / 文件行号）；`cost` 为绝对美元，仅 `costStatus="reported"`（供应商计费）时计入 Credits，`"estimated"` 本地估算不计费、以报告值单独显示；`responseDurationMs` 为应用精确计时。失败（`status=error/aborted`）请求通常无 usage，仍按零 token 计入请求数与成功率。`*.revisions.jsonl`（消息编辑历史）与 `*.inflight.json`（流式中转瞬态）不是转录，不纳入扫描；消息编辑 / 删除 / 截断会原子重写主文件，增量按整文件重读引擎处理（未变化文件零读取）。`meta.providerId` 是应用内部行 UUID，供应商按模型名推断；转录不含项目信息，项目名只读查询同目录 `pi.sqlite`（`sessions.project_id → projects.name`，应用运行中 WAL 并发只读安全），映射命中前记「未知项目」，库不可读时保留已入库标签、不触发会话文件重读。

## 本地用量快照与同步

用量数据默认持久化到项目目录的 `.data/usage.sqlite`（该目录已被 Git 忽略），可通过 **USAGE_DB_PATH** 指定其他数据库文件。数据库保存归一化用量、来源状态、去重账本、后续增量游标和最后一次成功快照，不保存完整会话正文。当前 schema 为 v2，启动时通过事务自动迁移；未知版本、错误 application_id 或不完整 schema 会明确报错，不会删除原库重建。

- `GET /api/usage` 只读取最后成功快照，不扫描原始会话日志；数据库为空时明确返回 `snapshotAvailable: false`。这是 M6 前的 legacy 响应（仍含全部 records，约 12.7MB），保留用于兼容，页面默认不再调用。
- `GET /api/usage/query?range=&harness=&project=&provider=&model=&billing=` 在 SQLite 中聚合返回汇总卡片、趋势、各维度分组、下拉 facet 与来源状态（默认筛选约 4–50KB），带 `X-Usage-Revision` 头；非法参数返回 400。
- `GET /api/usage/records?…&page=&pageSize=` 按同一筛选分页返回请求日志，页大小服务端钳制在 1–100（默认 10）；`GET /api/usage/records/detail?harness=&recordId=` 按 ID 查询单条详情。
- `GET /api/usage/export?…` 按同一筛选导出全部命中记录的 CSV。
- `POST /api/usage/sync` 在独立 worker 中执行扫描、解析和事务写入，同进程重叠请求共享同一轮同步；只返回 revision 等小结果（约 0.2KB），不再回传全部记录，客户端按 revision 变化决定是否重查聚合视图。
- `GET /api/usage/sync` 查询导入状态、revision、最后成功时间与错误；同步失败不会清空旧快照。
- 前端刷新由 revision 驱动：设置中的“日志扫描间隔”只控制后台增量导入；数据未变化时自动同步只更新“上次同步”时间，统计视图不重复查询。滚动范围（当天等）保留按分钟失效以处理跨午夜。worker 默认最长运行 10 分钟，可通过 **USAGE_SYNC_TIMEOUT_MS** 调整（毫秒）。超时后释放本轮请求，可重新同步。

### 架构、迁移与故障恢复

- Next 主进程只处理 SQLite 查询与小结果响应；原始日志发现、解压和解析在一次性 `worker_threads` 中执行。同一进程内所有标签页和手动/自动同步共享一个 in-flight worker。
- `usage_records` 是聚合与分页的事实来源；`usage_sources` 保存各来源摘要，`usage_dedup` 持久化全局去重账本，`session_log_sync` 保存文件游标、尾部指纹与 parser state，`usage_snapshots` 保存兼容 API 的最后成功响应。
- schema v2 迁移在事务中执行，并校验 `application_id`。未知高版本、非本应用数据库或不完整 schema 会报错，不会删库重建。
- 未变化文件不读取正文；DSH/Claude/Qoder 按完整帧或完整行续读，CodeBuddy/WorkBuddy/KCode/Antigravity 对变化文件整读，Codex 额外持久化父时间线与 deferred 依赖状态。文件集变化、可检测的重写/截断或指纹失配会触发对应来源级重建。
- 单个来源失败时保留其最后成功记录与游标，其他来源仍可提交；下一轮自动重试失败来源。整轮失败不会清空快照。
- 需要强制重建单个来源时，先停止面板并备份数据库，再删除 `session_log_sync` 中该 Harness 的行，下次同步会全量重扫该来源。需要完全重置时，在停止面板后备份并移除 `.data/usage.sqlite` 及其 `-wal` / `-shm` 文件；不要直接删除无法识别版本的线上数据库来绕过迁移错误。
- 全量 reader 保留用于冷导入、来源级重建和一致性基线；legacy `GET /api/usage` 仅为外部兼容保留，页面不再调用。

应用只提取时间、项目、模型和用量元数据，不读取或返回对话正文。开发和生产启动脚本默认只监听 127.0.0.1；不要将本地用量接口直接暴露到公网。

## 余额查询

「余额查询」视图支持查询供应商账户余额与编程套餐（coding plan）额度，查询口径与限流策略参考 cc-switch（`balance.rs`、`coding_plan.rs` 与 usage 脚本模板）。支持：

- **原生供应商**：DeepSeek（多币种钱包）、StepFun、SiliconFlow（.cn 人民币 / .com 美元）、OpenRouter（剩余 = 总额度 − 已用）、Novita AI、智谱 / Z.ai（账户余额报表，Key 不带 Bearer）
- **编程套餐（coding plan）**：按 5 小时 / 周 / 月窗口展示已用百分比、剩余额度与重置倒计时
  - **Kimi For Coding**（`api.kimi.com` / `api.kimi.ai`）：`GET /usages`，5 小时与周窗口绝对额度
  - **GLM Coding Plan**（智谱个人版，国内 / 国际站）：`GET /api/monitor/usage/quota/limit`，Key 不带 Bearer；有 `TIME_LIMIT` 时额外展示 MCP 每月调用额度（不是 Token 月限额），没有则不展示；按量付费账户无套餐时自动回落查询账户余额
  - **GLM Coding Plan 团队版**：同一额度接口加 `?type=2`，需 API Key + 组织 ID + 项目 ID
  - **MiniMax Coding Plan**（`api.minimaxi.com` / `api.minimax.io`）：`coding_plan/remains`，剩余百分比反转为已用，无周限额套餐自动隐藏周窗口
  - **火山方舟 Agent Plan / Coding Plan**：控制面 OpenAPI（`GetAFPUsage` → `GetCodingPlanUsage` 双 plan 自动探测），火山签名 V4；需填写火山引擎账号 AccessKey ID / Secret（与推理 API Key 是两套凭据）
  - **OpenCode Go**：`GET /zen/go/v1/usage`，5 小时 / 周 / 月三窗口；403 表示 Key 有效但没有 Go 订阅
  - **ZenMux**：直接 GET 用户配置的用量端点，窗口可含美元金额
  - **Command Code**：`/alpha` 控制面接口（whoami → credits → subscriptions → summary），月度额度 + 5 小时 / 周窗口
- **通用模板**：new-api 中转站（`/api/user/self`，Access Token + 用户 ID，500000 配额 = $1）、Sub2API（`/v1/usage`）、通用 `/user/balance`

Base URL 命中已知供应商时自动识别模板，其余按所选模板查询。智谱 Coding Plan 与账户余额共用域名，需在预设里显式选择。供应商配置与凭据保存在本机（默认 `~/.y-token-panel/balance.json`，可用 **Y_TOKEN_PANEL_DATA_DIR** 指定其他根目录），接口只返回脱敏后的凭据（Key 前 6 后 4）。

### 限流与防风控

查询由服务端保留轻量限流与失败冷却（对齐 cc-switch：手动刷新点击即真查，无分钟级间隔限制）：

- 同一供应商两次真实查询至少间隔 **5 秒**（防连点抖动），间隔内的请求直接返回缓存
- 单次请求 15 秒超时；网络错误 / 5xx 自动重试 1 次（1.5 秒后），HTTP 429 不重试
- 瞬时失败（网络 / 5xx）后冷却 60 秒；被限流（HTTP 429）后冷却 5 分钟，期间不外呼并继续展示上次成功值
- HTTP 401 / 403 判定为 Key 失效并明确提示，不当作网络问题反复重试；零余额不判失效
- 同一供应商的并发查询在服务端合并为一次请求；「全部刷新」最多 2 路并发
- 自动刷新间隔 5 秒起步（对齐 cc-switch 用量页 5 / 10 / 30 / 60 秒档位，默认 5 分钟），且仅在余额视图可见时轮询
- 限流与冷却状态随配置持久化，重启面板后依然生效

## 统计口径

- **请求数**：包含用量字段的 CodeBuddy API 调用记录数。
- **总 Tokens**：优先使用原始 total_tokens。CodeBuddy 的输入 Tokens 已包含缓存读取，因此不会再次累加缓存 Tokens。
- **缓存命中率**：缓存读取 Tokens ÷ 输入 Tokens。
- **Credits**：原始 credit 字段的合计，不是美元金额；缺失时显示为 —。
- **成功率**：根据会话记录状态统计，不推测日志中没有的 HTTP 状态码或生成速度。
- **首字时间（TTFT）**：请求发出到上游开始输出的等待。ZCode（`time_to_first_token_ms`）、KCode（`llmFirstTokenLatencyMs`）、Antigravity（原生库首字 Duration）、DSH（stream 最早分片时刻 − `step/start`）是各自本地记录的原生计时；Claude Code（`thinkingDurationMs` 推导，仅思考开头的回复）与 Codex（`item_completed.started_at_ms`，仅新版日志）按时间戳推算，展示带 ≈（起点含客户端组装请求的时间，系统性偏高）；CodeBuddy / WorkBuddy / Qoder / Pi Desktop 的本地会话没有首字计时，显示 —。分组行取中位数，精确口径优先、没有才回落估算口径。

## 检查

~~~bash
npm run lint
npm run typecheck
npm run build
~~~
