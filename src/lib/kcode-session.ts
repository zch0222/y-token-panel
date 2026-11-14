import {
  deriveProvider,
  type UsageRecord,
} from "@/lib/usage";

/**
 * Kimi Code（kcode）会话 wire 记录（~/.kimi-code/sessions/<workspace>/<session>/
 * agents/<agent>/wire.jsonl，每行一个事件）的字段语义，全部依据本机 Kimi Code
 * Desktop 2.5.1 应用包（resources/app.asar 内 out/screenshot-C-GAu5Eh.cjs，即
 * 打包后的 agent core bundle）反查确认，并逐条对齐 cc-switch 的参考实现
 * （src-tauri/src/kimi_session.rs 与 services/session_usage_kimi.rs），不靠
 * 字段名望文生义：
 *
 * - usage 四元组 { inputOther, output, inputCacheRead, inputCacheCreation } 由
 *   各协议适配器在流结束时归一化构造：OpenAI Chat（bundle 内 wqe）与 OpenAI
 *   Responses（lJe）为 inputOther = prompt/input_tokens − cached_tokens、
 *   inputCacheRead = cached_tokens；Anthropic（CHe）为 inputOther =
 *   input_tokens 原值（Anthropic 的 input_tokens 本就不含缓存）；Gemini 为
 *   promptTokenCount − cachedContentTokenCount。即 inputOther 一律是「不含
 *   缓存的新鲜输入」，对应面板 inputTokenSemantics: "fresh"。输入总量 =
 *   inputOther + inputCacheRead + inputCacheCreation（bundle 内 hC），缓存
 *   命中率 = inputCacheRead ÷ 输入总量（wht 的 cache_hit_rate）。
 * - 主 agent（agents/main）的已提交用量在 `agent.message.appended` /
 *   `human.agent.message.appended`（message.message.role === "assistant"）的
 *   message.meta.usage 上；messageId 在 message.meta.messageId（chatcmpl-…）。
 *   meta.model 是合成占位 {provider:"agent-loop", model:"agent-loop"}，真实
 *   模型必须用 messageId 回连 llm.request（cc-switch 同款：usage importer 只
 *   信 loop 请求里的 model）。Kimi 整个 turn 的消息一次性批量提交（同一
 *   commit time），所以记录自身的 time 不能当请求时间，要用「请求起点 +
 *   请求耗时」并与 commit time 取小（cc-switch completed_ms 同款）。
 * - 子 agent（agents/agent-N 等）：回复不进人类投影层，用量直接取
 *   context.append_loop_event(event.type === "step.end") 的 event.usage；
 *   父 agent 的 subagent 汇总不含 token，不会重复计数（cc-switch 注释同款）。
 * - 请求元数据按事件流重建（cc-switch kimi_session.rs 的 RequestIndex 移植）：
 *   step.begin（uuid、turnId.step）开窗 → llm.request（agentId 归属、kind ===
 *   "loop"、turnStep 匹配时更新 model 与起点时间；重试覆盖前一次）→
 *   content.part / tool.call（对齐 stepUuid，记录响应完成时刻 / 是否含工具）→
 *   step.end（uuid 对齐）收口。native 耗时 = llmFirstTokenLatencyMs +
 *   llmStreamDurationMs（两者在 KYe 计时器里分别是「首包到达 − 请求开始」与
 *   「流结束 − 首包」，相加恰为请求起点到流完成的窗口，含首字等待、不含其
 *   后的工具执行）；缺失时回退「响应完成 − 请求起点」，且 step.end 时间仅在
 *   无工具时可用（有工具时 step.end 被工具执行推迟）。落在 100ms–1h 之外的
 *   耗时视为不可信丢弃。firstToken 只在 ≤ 耗时时保留。
 * - llm.request 的 timing 字段含义（bundle 内 KYe 计时器）：
 *   llmFirstTokenLatencyMs = 首个分片到达 − 计时开始；llmStreamDurationMs =
 *   流结束 − 首分片；llmRequestBuildMs = 请求构造；llmServerFirstTokenMs /
 *   llmServerDecodeMs / llmClientConsumeMs / llmClientBlockedMs 为发送后
 *   首包 / 服务端解码 / 客户端消费 / 客户端阻塞分量，面板只用前两个。
 *   - Kimi Code Desktop 1.3.5 起主 agent 与子 agent 都不再写 `llm.request`、
 *     `agent.message.appended` 与 `human.agent.message.appended`，模型别名改由
 *     `profile.bind` / `config.update` 的 `modelAlias` 与 `usage.record` 的 `model`
 *     记录，并可对照 `~/.kimi-code/config.toml` 的 `[models."<alias>"]` 解析
 *     真实 `model` 与第三方 `provider`（官方 `managed:kimi-code` / `kimi-code`
 *     仍走 `deriveProvider` 保持 `"Moonshot AI"`，自定义供应商保留配置名称）；
 *     主 agent 在无已提交消息时直接消费带用量的 `step.end`（并在代理省略响应
 *     `messageId` 时回退 `event.uuid` / `file:lineIndex` 保持身份与去重）。
 * - usage.record 事件：
 *   - `usageScope === "turn"`（或缺失）：与同一步 `step.end` 对齐的增量广播，仅用于
 *     补充当前步骤的 `modelAlias` 绑定，不单独产记录，避免与 `agent.message.appended`
 *     或 `step.end` 双计。
 *   - `usageScope === "session"`：full_compaction 等跨步操作不经 `step.end` 收口，
 *     按独立事件产出记录。
 * - 没有用量（inputOther+output+两缓存全为 0，如 interrupted / failed 的
 *   step.end 只带 finishReason）或没有合法 time 的事件不产出记录。
 * - wire.jsonl 里没有 Credits / 计费字段，kcode 记录恒为 hasCredit: false。
 */

/** 解析口径版本号：1.3.5 wire 形态与第三方供应商配置解析上线后递增触发源级重建。 */
export const KCODE_PARSER_VERSION = 2;
/** 写入 session_log_sync 作为伴随标记的虚拟文件路径。 */
export const KCODE_PARSER_MARKER = "kcode:parser-version";

/** ~/.kimi-code/config.toml 中 `[models.<alias>]` 解析结果（仅含非敏感展示字段）。 */
export interface KcodeConfiguredModel {
  alias: string;
  provider?: string;
  model?: string;
}

/** wire 事件里的 usage 四元组（数值字段，inputCacheRead 可缺失）。 */
interface KcodeUsage {
  inputOther?: number;
  output?: number;
  inputCacheRead?: number;
  inputCacheCreation?: number;
}

/** context.append_loop_event 内嵌的循环事件。 */
interface KcodeLoopEvent {
  type?: string;
  uuid?: string;
  turnId?: string;
  step?: number;
  stepUuid?: string;
  messageId?: string;
  usage?: KcodeUsage;
  llmFirstTokenLatencyMs?: number;
  llmStreamDurationMs?: number;
  [key: string]: unknown;
}

/** wire.jsonl 单行事件（声明解析用到的字段，真实事件还有大量其他字段）。 */
export interface KcodeWireRecord {
  type?: string;
  agentId?: string;
  kind?: string;
  model?: string;
  modelAlias?: string;
  usage?: KcodeUsage;
  usageScope?: string;
  turnStep?: string;
  time?: number;
  event?: KcodeLoopEvent;
  message?: {
    message?: { role?: string; [key: string]: unknown };
    meta?: {
      messageId?: string;
      model?: { provider?: string; model?: string };
      usage?: KcodeUsage;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** 耗时可信范围：低于 100ms 视为起点取晚，超过 1 小时视为脏数据。 */
const MIN_PLAUSIBLE_LATENCY_MS = 100;
const MAX_PLAUSIBLE_LATENCY_MS = 60 * 60 * 1000;

/** 与 cc-switch estimated_latency_ms 同款：范围外的差值返回 undefined。 */
function plausibleLatencyMs(start: number, end: number): number | undefined {
  const latency = end - start;
  if (!Number.isFinite(latency)) return undefined;
  return latency >= MIN_PLAUSIBLE_LATENCY_MS && latency <= MAX_PLAUSIBLE_LATENCY_MS
    ? Math.round(latency)
    : undefined;
}

/** 与 cc-switch timestamp_ms 同款：秒级（<1e12）放大到毫秒，非法值丢弃。 */
export function kcodeTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const millis = value < 1e12 ? value * 1000 : value;
  return Number.isFinite(millis) ? Math.round(millis) : undefined;
}

/** 与 cc-switch model_name 同款：空名与合成占位（agent-loop / unknown）不可用。 */
function kcodeModelName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return !name || name === "agent-loop" || name === "unknown" ? undefined : name;
}

/** step.end 上的原生计时：非负且不超过 1 小时才可信。 */
function kcodeWireDurationMs(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_PLAUSIBLE_LATENCY_MS
  ) {
    return undefined;
  }
  return Math.round(value);
}

/** usage 数值归一（对齐 cc-switch 的 as_u64 + u32 上限）：非正数与小数截断。 */
function kcodeUsageNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.trunc(value), 0xffffffff);
}

interface KcodeRequestInfo {
  model?: string;
  modelAlias?: string;
  latencyMs: number;
  firstTokenMs?: number;
  /** 该 step 最后一次请求（llm.request，或无 llm.request 时的 step.begin）起点；提交消息带的是批量 commit 时间。 */
  requestMs?: number;
}

interface KcodeStepState {
  uuid: string;
  turnStep?: string;
  model?: string;
  modelAlias?: string;
  hasLlmRequest: boolean;
  beginTime?: number;
  requestMs?: number;
  responseMs?: number;
  hasTools: boolean;
}

/**
 * 按 wire 事件流重建「messageId / stepUuid → 请求元数据」索引（cc-switch
 * kimi_session.rs 的 RequestIndex 移植，并兼容 1.3.5 无 llm.request 的新事件流）。
 * 主 agent 的 meta.model 是合成占位，真实模型与计时只能从这里查；每个 agent
 * 一份独立 wire，跨 agent 的请求不串扰。
 */
export class KcodeRequestIndex {
  private readonly agent: string | undefined;
  private step: KcodeStepState | undefined;
  private activeModelAlias: string | undefined;
  private readonly messages = new Map<string, KcodeRequestInfo>();
  private readonly stepsByUuid = new Map<string, KcodeRequestInfo>();

  constructor(agent?: string) {
    this.agent = agent;
  }

  observe(record: KcodeWireRecord): void {
    // 每个 agent 只写自己的 wire；带他人 agentId 的记录忽略。
    const own = this.agent ?? "main";
    if (typeof record.agentId === "string" && record.agentId !== own) return;

    switch (record.type) {
      case "agent.switched":
      case "agent.turn.started":
        this.step = undefined;
        return;
      case "profile.bind":
      case "config.update": {
        const alias = kcodeModelName(record.modelAlias);
        if (alias) this.activeModelAlias = alias;
        return;
      }
      case "llm.request":
        this.observeLlmRequest(record);
        return;
      case "usage.record":
        this.observeUsageRecord(record);
        return;
      case "context.append_loop_event":
        this.observeLoopEvent(record);
        return;
      default:
        return;
    }
  }

  private observeLlmRequest(record: KcodeWireRecord): void {
    // kind 缺失按 loop 处理，非 loop（如 compaction）不参与。
    if (typeof record.kind === "string" && record.kind !== "loop") return;
    const step = this.step;
    if (!step) return;
    if (
      step.turnStep !== undefined &&
      record.turnStep !== undefined &&
      step.turnStep !== record.turnStep
    ) {
      return;
    }
    // 重试覆盖失败的尝试；原生计时属于最后一次尝试（非法值同样覆盖为空）。
    step.hasLlmRequest = true;
    step.model = kcodeModelName(record.model);
    const alias = kcodeModelName(record.modelAlias);
    if (alias) {
      step.modelAlias = alias;
      this.activeModelAlias = alias;
    }
    step.requestMs = kcodeTimestampMs(record.time);
    step.responseMs = undefined;
    step.hasTools = false;
  }

  private observeUsageRecord(record: KcodeWireRecord): void {
    if (record.usageScope === "session") return;
    const step = this.step;
    if (!step) return;
    const alias = kcodeModelName(record.modelAlias) ?? kcodeModelName(record.model);
    if (!alias) return;
    step.modelAlias = alias;
    this.activeModelAlias = alias;
  }

  private observeLoopEvent(record: KcodeWireRecord): void {
    const event = record.event;
    if (!event) return;
    switch (event.type) {
      case "step.begin": {
        if (typeof event.uuid !== "string") {
          this.step = undefined;
          return;
        }
        const turnStep =
          typeof event.turnId === "string" &&
          typeof event.step === "number" &&
          Number.isInteger(event.step) &&
          event.step >= 0
            ? `${event.turnId}.${event.step}`
            : undefined;
        this.step = {
          uuid: event.uuid,
          turnStep,
          model: undefined,
          modelAlias: undefined,
          hasLlmRequest: false,
          beginTime: kcodeTimestampMs(record.time),
          requestMs: undefined,
          responseMs: undefined,
          hasTools: false,
        };
        return;
      }
      case "content.part":
      case "tool.call": {
        const step = this.step;
        if (!step || event.stepUuid !== step.uuid) return;
        if (event.type === "tool.call") {
          step.hasTools = true;
          return;
        }
        // content.part 是已完成分片，不是首字通知；取最晚的完成时刻。
        const time = kcodeTimestampMs(record.time);
        if (time !== undefined) {
          step.responseMs = Math.max(step.responseMs ?? -Infinity, time);
        }
        return;
      }
      case "step.end": {
        if (this.step && event.uuid !== this.step.uuid) return;
        const step = this.step;
        this.step = undefined;
        const messageId =
          typeof event.messageId === "string" && event.messageId !== ""
            ? event.messageId
            : undefined;
        const stepUuid =
          typeof event.uuid === "string" && event.uuid !== ""
            ? event.uuid
            : undefined;
        if (!messageId && !stepUuid) return;

        const firstTokenMs = kcodeWireDurationMs(event.llmFirstTokenLatencyMs);
        const streamMs = kcodeWireDurationMs(event.llmStreamDurationMs);
        // step.end 会被其后的工具执行推迟，优先用不含工具的原生请求时长。
        const nativeLatency =
          firstTokenMs !== undefined && streamMs !== undefined
            ? plausibleLatencyMs(0, firstTokenMs + streamMs)
            : undefined;
        const alias = step ? (step.modelAlias ?? this.activeModelAlias) : undefined;
        // 1.3.5 不写 llm.request；仅当存在模型上下文或原生计时（排除无上下文孤立 step）时以 step.begin 时刻兜底起点。
        const requestMs = step
          ? step.hasLlmRequest
            ? step.requestMs
            : alias !== undefined || nativeLatency !== undefined
              ? step.beginTime
              : undefined
          : undefined;
        const endMs =
          step?.responseMs ??
          (step?.hasTools ? undefined : kcodeTimestampMs(record.time));
        const latencyMs =
          nativeLatency ??
          (requestMs !== undefined && endMs !== undefined
            ? plausibleLatencyMs(requestMs, endMs)
            : undefined) ??
          0;

        // fork 可能重放没有原始请求事件的 step，保留已解析的元数据。
        const existing =
          (messageId ? this.messages.get(messageId) : undefined) ??
          (stepUuid ? this.stepsByUuid.get(stepUuid) : undefined);
        const info: KcodeRequestInfo = {
          ...(existing ?? {}),
          latencyMs: existing?.latencyMs ?? 0,
        };
        if (step?.model !== undefined) info.model = step.model;
        if (alias !== undefined) info.modelAlias = alias;
        if (requestMs !== undefined) info.requestMs = requestMs;
        if (latencyMs > 0) {
          info.latencyMs = latencyMs;
          info.firstTokenMs =
            firstTokenMs !== undefined && firstTokenMs <= latencyMs
              ? firstTokenMs
              : info.firstTokenMs !== undefined && info.firstTokenMs <= latencyMs
                ? info.firstTokenMs
                : undefined;
        }
        if (messageId) this.messages.set(messageId, info);
        if (stepUuid) this.stepsByUuid.set(stepUuid, info);
        return;
      }
      default:
        return;
    }
  }

  get(messageId: string | undefined): KcodeRequestInfo | undefined {
    return typeof messageId === "string" && messageId !== ""
      ? this.messages.get(messageId)
      : undefined;
  }

  getStep(stepUuid: string | undefined): KcodeRequestInfo | undefined {
    return typeof stepUuid === "string" && stepUuid !== ""
      ? this.stepsByUuid.get(stepUuid)
      : undefined;
  }

  currentModelAlias(): string | undefined {
    return this.activeModelAlias;
  }

  /** meta.model.model 里的真实模型名（旧 wire）或 modelAlias 作为兜底。 */
  model(meta: {
    messageId?: string;
    model?: { model?: string };
  }): string | undefined {
    const info = this.get(meta.messageId);
    if (info?.model) return info.model;
    if (info?.modelAlias) {
      return resolveKcodeModelAndProvider({ modelAlias: info.modelAlias }).model;
    }
    return kcodeModelName(meta.model?.model);
  }
}

/** 与 cc-switch completed_ms 同款：请求完成时刻不晚于提交时刻。 */
function kcodeCompletedMs(
  started: number,
  latencyMs: number,
  committed: number,
): number {
  return Math.min(started + latencyMs, committed);
}

/** usage 四元组 → 面板 token 字段；四项全零返回 null（不产出记录）。 */
function kcodeUsageTokens(usage: KcodeUsage) {
  const inputTokens = kcodeUsageNumber(usage.inputOther);
  const outputTokens = kcodeUsageNumber(usage.output);
  const cacheReadTokens = kcodeUsageNumber(usage.inputCacheRead);
  const cacheCreationTokens = kcodeUsageNumber(usage.inputCacheCreation);
  const totalTokens =
    inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  if (totalTokens === 0) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens };
}

/** 解析单个 wire.jsonl 需要的定位信息。 */
export interface KcodeWireContext {
  /** 项目名（workspace 目录名经 projects.json / 兜底规则解析）。 */
  project: string;
  /** 会话目录名（session_<uuid>），作为面板的 sessionId。 */
  sessionId: string;
  /** agents/ 下的 agent 目录名；"main" 为主 agent，其余为子 agent。 */
  agent: string;
  /** wire 文件显示名（无 messageId / uuid 时的兜底 id 片段）。 */
  file: string;
  /** 可选 ~/.kimi-code/config.toml `[models.*]` 映射，用于解析第三方供应商与真实模型名。 */
  models?: ReadonlyMap<string, KcodeConfiguredModel>;
}

interface PendingMessage {
  kind: "message";
  meta: NonNullable<NonNullable<KcodeWireRecord["message"]>["meta"]>;
  committedAt: number;
  lineIndex: number;
}

interface PendingStep {
  kind: "step";
  event: KcodeLoopEvent;
  eventTime: number;
  lineIndex: number;
}

interface PendingSessionUsage {
  kind: "session-usage";
  record: KcodeWireRecord;
  eventTime: number;
  modelAliasFallback?: string;
}

/**
 * 解析整个 wire.jsonl：先按行重建请求索引并收集待定用量（人类投影可能先于
 * step.end 出现，须全文件读完后再按 messageId 连接），再产出 UsageRecord。
 * 主 agent 若有已提交消息优先认之，同时消费 1.3.5 起不再写已提交消息的
 * step.end（按 messageId 去重，避免旧版或混合会话双计）与 session 级压缩记录；
 * 子 agent 认带用量的 step.end。
 */
export function parseKcodeWireFile(
  content: string,
  context: KcodeWireContext,
): UsageRecord[] {
  const index = new KcodeRequestIndex(
    context.agent === "main" ? undefined : context.agent,
  );
  const own = context.agent === "main" ? "main" : context.agent || "main";
  const pending: Array<PendingMessage | PendingStep | PendingSessionUsage> = [];
  const committedMessageIds = new Set<string>();
  const lines = content.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    let record: KcodeWireRecord;
    try {
      record = JSON.parse(line) as KcodeWireRecord;
    } catch {
      continue;
    }
    index.observe(record);

    if (
      context.agent === "main" &&
      (record.type === "agent.message.appended" ||
        record.type === "human.agent.message.appended") &&
      record.message?.message?.role === "assistant" &&
      record.message.meta?.usage
    ) {
      const committedAt = kcodeTimestampMs(record.time);
      if (committedAt === undefined) continue;
      const metaId = record.message.meta.messageId;
      if (typeof metaId === "string" && metaId !== "") {
        committedMessageIds.add(metaId);
      }
      pending.push({
        kind: "message",
        meta: record.message.meta,
        committedAt,
        lineIndex,
      });
      continue;
    }

    const event = record.event;
    if (
      record.type === "context.append_loop_event" &&
      event?.type === "step.end" &&
      event.usage
    ) {
      const eventTime = kcodeTimestampMs(record.time);
      if (eventTime === undefined) continue;
      pending.push({ kind: "step", event, eventTime, lineIndex });
      continue;
    }

    if (
      record.type === "usage.record" &&
      record.usageScope === "session" &&
      record.usage &&
      (typeof record.agentId !== "string" || record.agentId === own)
    ) {
      const eventTime = kcodeTimestampMs(record.time);
      if (eventTime === undefined) continue;
      pending.push({
        kind: "session-usage",
        record,
        eventTime,
        modelAliasFallback: index.currentModelAlias(),
      });
    }
  }

  const records: UsageRecord[] = [];
  for (const item of pending) {
    let record: UsageRecord | null;
    if (item.kind === "message") {
      record = messageRecord(item, index, context);
    } else if (item.kind === "step") {
      // 主 agent 同一步若已有 agent.message.appended（1.3.5 之前），跳过其 step.end 避免双计。
      const stepMessageId = item.event.messageId;
      if (
        context.agent === "main" &&
        typeof stepMessageId === "string" &&
        stepMessageId !== "" &&
        committedMessageIds.has(stepMessageId)
      ) {
        continue;
      }
      record = stepRecord(item, index, context);
    } else {
      record = sessionUsageRecord(item, context);
    }
    if (record) records.push(record);
  }
  return records;
}

function baseRecord(
  tokens: NonNullable<ReturnType<typeof kcodeUsageTokens>>,
  model: string,
  provider: string,
  id: string,
  requestId: string,
  timestamp: number,
  latencyMs: number,
  firstTokenMs: number | undefined,
  context: KcodeWireContext,
): UsageRecord {
  return {
    id,
    requestId,
    sessionId: context.sessionId,
    harness: "kcode",
    project: context.project,
    model,
    provider,
    timestamp,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheCreationTokens: tokens.cacheCreationTokens,
    totalTokens: tokens.totalTokens,
    // inputOther 已是扣除缓存后的新鲜输入（见文件头）。
    inputTokenSemantics: "fresh",
    hasTokenUsage: true,
    credits: 0,
    hasCredit: false,
    estimatedDurationMs: latencyMs > 0 ? latencyMs : undefined,
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    status: "success",
  };
}

function messageRecord(
  item: PendingMessage,
  index: KcodeRequestIndex,
  context: KcodeWireContext,
): UsageRecord | null {
  const tokens = kcodeUsageTokens(item.meta.usage ?? {});
  if (!tokens) return null;
  const info = index.get(item.meta.messageId);
  const { model, provider } = resolveKcodeModelAndProvider({
    stepModel: info?.model,
    modelAlias: info?.modelAlias,
    metaModel: item.meta.model,
    configuredModels: context.models,
  });
  const messageId = item.meta.messageId || `${context.file}:${item.lineIndex}`;
  const providerKey = item.meta.model?.provider ?? "unknown";
  const latencyMs = info?.latencyMs ?? 0;
  const timestamp =
    info?.requestMs !== undefined
      ? kcodeCompletedMs(info.requestMs, latencyMs, item.committedAt)
      : item.committedAt;
  return baseRecord(
    tokens,
    model,
    provider,
    `kcode:${providerKey}:${messageId}`,
    messageId,
    timestamp,
    latencyMs,
    info?.firstTokenMs,
    context,
  );
}

function stepRecord(
  item: PendingStep,
  index: KcodeRequestIndex,
  context: KcodeWireContext,
): UsageRecord | null {
  const messageId =
    typeof item.event.messageId === "string" && item.event.messageId !== ""
      ? item.event.messageId
      : undefined;
  const stepUuid =
    typeof item.event.uuid === "string" && item.event.uuid !== ""
      ? item.event.uuid
      : undefined;
  const isMain = context.agent === "main";
  // 子 agent 的记录身份仍以 messageId 为准；主 agent 在部分第三方 OpenAI 代理省略响应 id 时回退 uuid / 文件:行号。
  if (!isMain && !messageId) return null;

  const tokens = kcodeUsageTokens(item.event.usage ?? {});
  if (!tokens) return null;

  const info =
    (messageId ? index.get(messageId) : undefined) ??
    (stepUuid ? index.getStep(stepUuid) : undefined);
  const { model, provider } = resolveKcodeModelAndProvider({
    stepModel: info?.model,
    modelAlias: info?.modelAlias,
    configuredModels: context.models,
  });
  const stableId = messageId ?? stepUuid ?? `${context.file}:${item.lineIndex}`;
  const prefix = isMain ? "main" : "subagent";
  const latencyMs = info?.latencyMs ?? 0;
  const timestamp =
    info?.requestMs !== undefined
      ? kcodeCompletedMs(info.requestMs, latencyMs, item.eventTime)
      : item.eventTime;
  return baseRecord(
    tokens,
    model,
    provider,
    `kcode:${prefix}:${stableId}`,
    stableId,
    timestamp,
    latencyMs,
    info?.firstTokenMs,
    context,
  );
}

function sessionUsageRecord(
  item: PendingSessionUsage,
  context: KcodeWireContext,
): UsageRecord | null {
  const tokens = kcodeUsageTokens(item.record.usage ?? {});
  if (!tokens) return null;
  const alias =
    kcodeModelName(item.record.modelAlias) ??
    kcodeModelName(item.record.model) ??
    item.modelAliasFallback;
  const { model, provider } = resolveKcodeModelAndProvider({
    modelAlias: alias,
    configuredModels: context.models,
  });
  const requestId = `session:${context.agent}:${item.eventTime}:${alias ?? model}:${tokens.inputTokens}:${tokens.outputTokens}:${tokens.totalTokens}`;
  return baseRecord(
    tokens,
    model,
    provider,
    `kcode:${requestId}`,
    requestId,
    item.eventTime,
    0,
    undefined,
    context,
  );
}

/** `managed:*` 与 `kimi-code` 属于 Kimi Code 官方渠道，统一归入 deriveProvider。 */
function isBuiltinOfficialProvider(provider: string | undefined): boolean {
  if (!provider) return false;
  return (
    provider === "kimi-code" ||
    provider.startsWith("managed:") ||
    provider === "agent-loop" ||
    provider === "unknown"
  );
}

function parseModelAlias(alias: string | undefined): {
  provider?: string;
  model?: string;
} {
  if (!alias) return {};
  const slashIndex = alias.indexOf("/");
  if (slashIndex > 0 && slashIndex < alias.length - 1) {
    return {
      provider: alias.slice(0, slashIndex).trim() || undefined,
      model: alias.slice(slashIndex + 1).trim() || undefined,
    };
  }
  return { model: alias };
}

/**
 * 解析最终展示的 `(model, provider)`：
 * - `model` 优先级：请求实名（`llm.request.model`）→ `config.toml` `[models.<alias>].model` → `modelAlias` 后缀 → 旧 wire `meta.model.model` → `"未知模型"`
 * - `provider`：若 `config.toml` 或 `modelAlias` 前缀指定了非官方的第三方供应商（如 `"Kimi For Coding"`、`"openrouter"`），直接保留该名称；否则沿用 `deriveProvider(model, "KCode")`（官方模型归为 `"Moonshot AI"`）。
 */
export function resolveKcodeModelAndProvider(options: {
  stepModel?: string;
  modelAlias?: string;
  metaModel?: { provider?: string; model?: string };
  configuredModels?: ReadonlyMap<string, KcodeConfiguredModel>;
}): { model: string; provider: string } {
  const alias = kcodeModelName(options.modelAlias);
  const configured = alias ? options.configuredModels?.get(alias) : undefined;
  const aliasParts = parseModelAlias(alias);

  const model =
    kcodeModelName(options.stepModel) ??
    kcodeModelName(configured?.model) ??
    kcodeModelName(aliasParts.model) ??
    kcodeModelName(options.metaModel?.model) ??
    "未知模型";

  const explicitProvider =
    kcodeModelName(configured?.provider) ?? aliasParts.provider;
  const provider =
    explicitProvider && !isBuiltinOfficialProvider(explicitProvider)
      ? explicitProvider
      : deriveProvider(model, "KCode");

  return { model, provider };
}

function parseTomlQuoted(
  line: string,
  start: number,
): { value: string; next: number } | undefined {
  const quote = line[start];
  if (quote !== '"' && quote !== "'") return undefined;
  let value = "";
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i];
    if (quote === '"' && ch === "\\" && i + 1 < line.length) {
      const esc = line[i + 1];
      if (esc === "n") value += "\n";
      else if (esc === "r") value += "\r";
      else if (esc === "t") value += "\t";
      else value += esc;
      i += 2;
      continue;
    }
    if (ch === quote) return { value, next: i + 1 };
    value += ch;
    i += 1;
  }
  return undefined;
}

function parseTomlTableSegments(line: string): string[] | undefined {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  if (line[i] !== "[" || line[i + 1] === "[") return undefined;
  i += 1;
  const segments: string[] = [];
  while (i < line.length) {
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
    if (i >= line.length) return undefined;
    if (line[i] === '"' || line[i] === "'") {
      const parsed = parseTomlQuoted(line, i);
      if (!parsed) return undefined;
      segments.push(parsed.value);
      i = parsed.next;
    } else {
      const start = i;
      while (i < line.length && /[A-Za-z0-9_-]/.test(line[i])) i += 1;
      if (i === start) return undefined;
      segments.push(line.slice(start, i));
    }
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
    if (line[i] === ".") {
      i += 1;
      continue;
    }
    if (line[i] === "]") {
      const tail = line.slice(i + 1).trim();
      return tail === "" || tail.startsWith("#") ? segments : undefined;
    }
    return undefined;
  }
  return undefined;
}

function findUnquotedEquals(line: string): number {
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return -1;
    } else if (ch === "=") {
      return i;
    }
  }
  return -1;
}

function parseTomlKey(rawKey: string): string | undefined {
  const trimmed = rawKey.trim();
  if (!trimmed) return undefined;
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const parsed = parseTomlQuoted(trimmed, 0);
    return parsed && trimmed.slice(parsed.next).trim() === "" ? parsed.value : undefined;
  }
  return trimmed;
}

function parseTomlStringScalar(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed || (trimmed[0] !== '"' && trimmed[0] !== "'")) return undefined;
  const parsed = parseTomlQuoted(trimmed, 0);
  if (!parsed) return undefined;
  const tail = trimmed.slice(parsed.next).trim();
  if (tail !== "" && !tail.startsWith("#")) return undefined;
  return parsed.value.trim() || undefined;
}

/**
 * 解析 ~/.kimi-code/config.toml 中的 `[models.<alias>]` 映射（只读取 `provider` 与
 * `model`，不读取也不保存 `[providers.*]` 内的凭证字段）。
 */
export function parseKcodeConfigFile(
  content: string,
): Map<string, KcodeConfiguredModel> {
  const models = new Map<string, KcodeConfiguredModel>();
  let currentAlias: string | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("[")) {
      const segments = parseTomlTableSegments(trimmed);
      if (segments && segments[0] === "models" && segments.length >= 2) {
        currentAlias = segments.slice(1).join(".");
        if (currentAlias && !models.has(currentAlias)) {
          models.set(currentAlias, { alias: currentAlias });
        }
      } else {
        currentAlias = undefined;
      }
      continue;
    }

    if (!currentAlias) continue;
    const eqIndex = findUnquotedEquals(rawLine);
    if (eqIndex <= 0) continue;
    const key = parseTomlKey(rawLine.slice(0, eqIndex));
    if (key !== "provider" && key !== "model") continue;
    const value = parseTomlStringScalar(rawLine.slice(eqIndex + 1));
    if (!value) continue;
    const entry = models.get(currentAlias) ?? { alias: currentAlias };
    entry[key] = value;
    models.set(currentAlias, entry);
  }

  return models;
}

/**
 * workspace 目录名 → 项目名兜底。目录 id 由 kcode 按
 * `wd_<root 目录 slug>_<sha256 前 12 位>` 构造（bundle 内正则
 * ^wd_[a-z0-9._-]+_[0-9a-f]{12}$），手动 workspace 是 wm_<uuid>，解析不出
 * 名称时返回 undefined（交由上层兜底“未知项目”）。
 */
export function kcodeWorkspaceLabel(directory: string): string | undefined {
  const match = /^wd_(.+)_[0-9a-f]{12}$/.exec(directory);
  const slug = match?.[1]?.trim();
  return slug ? slug : undefined;
}

interface KcodeProjectsFile {
  projects?: Record<string, { root?: string; name?: string } | undefined>;
}

/**
 * projects.json（schema_version 2）是 kcode 的 workspace 注册表，projects[id]
 * 的 name / root 是它自己展示的项目名与目录。name 缺失时用 root 的目录叶子。
 */
export function parseKcodeProjectsFile(content: string): Map<string, string> {
  const names = new Map<string, string>();
  let parsed: KcodeProjectsFile;
  try {
    parsed = JSON.parse(content) as KcodeProjectsFile;
  } catch {
    return names;
  }
  for (const [id, project] of Object.entries(parsed.projects ?? {})) {
    const name =
      typeof project?.name === "string" && project.name.trim() !== ""
        ? project.name.trim()
        : directoryLeaf(project?.root ?? "");
    if (name) names.set(id, name);
  }
  return names;
}

function directoryLeaf(directory: string): string {
  const segments = directory.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1]?.trim() ?? "";
}

/** 项目名：projects.json 的 name → wd_ 目录名解析 → 未知项目。 */
export function resolveKcodeProjectName(
  workspaceId: string,
  projectNames: Map<string, string>,
): string {
  return (
    projectNames.get(workspaceId) ??
    kcodeWorkspaceLabel(workspaceId) ??
    "未知项目"
  );
}
