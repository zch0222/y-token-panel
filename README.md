# Y Token Panel

参考 CC Switch 用量统计模板实现的 CodeBuddy CLI 本地 Token 用量面板。使用 Next.js、Tailwind CSS、shadcn/ui 和 Recharts。

## 功能

- 读取本机 CodeBuddy CLI 会话 JSONL，展示真实 Token、Credits 和缓存用量
- 当天、昨天、近 7 天、近 30 天和全部时间筛选
- 按项目、供应商、模型组合筛选
- 请求数、Tokens、Credits、缓存命中率趋势图（柱状图 / 面积图）
- 请求日志、供应商、模型和项目聚合表格
- 请求详情、分页、CSV 导出、自动刷新、深色 / 浅色主题

## 启动

要求 Node.js 20.9 或更高版本。

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

可以通过 **ZCODE_DATA_DIR** 指定另一个 `.zcode` 根目录（其下需有 `cli/db/db.sqlite`）。读取该库需要 Node.js 22.5+（`node:sqlite`）；版本过低时仅跳过 ZCode 统计，其余 Harness 不受影响。注意 ZCode 自身只保留最近 30 天的用量行。

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

应用只提取时间、项目、模型和用量元数据，不读取或返回对话正文。开发和生产启动脚本默认只监听 127.0.0.1；不要将本地用量接口直接暴露到公网。

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
