"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  CircleAlert,
  CircleX,
  Clock,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  BALANCE_KIND_OPTIONS,
  BALANCE_PROVIDER_PRESETS,
  detectBalanceKind,
  formatBalanceNumber,
  formatRelativeTime,
  formatResetCountdown,
  getBalanceKindLabel,
  getBalancePreset,
  isFixedBalancePreset,
  isPresetLockedBaseUrl,
  matchBalancePreset,
  resolvePresetBaseUrl,
  type BalanceCacheEntry,
  type BalanceData,
  type BalanceKind,
  type BalanceProviderView,
} from "@/lib/balance";
import { MIN_QUERY_INTERVAL_MS } from "@/lib/balance-throttle";

/**
 * 余额查询视图。查询走 /api/balance/query，服务端只保留 5 秒防连点间隔与失败
 * 冷却（对齐 cc-switch：手动点击即真查；429 冷却 5 分钟）。
 * 本组件只在挂载期间轮询，切走视图即停止外呼。
 */

// 刷新图标反馈节奏，对齐 cc-switch QuotaLines（600ms 最小旋转 / 结果图标停留 1s）。
const MIN_REFRESH_SPIN_MS = 600;
const REFRESH_RESULT_MS = 1_000;
// 「全部刷新」的并发上限，避免瞬间打满多个供应商。
const BATCH_CONCURRENCY = 2;

// 对齐 cc-switch 用量页的 5/10/30/60 秒档位，另保留 5 分钟（订阅查询口径）与 30 分钟。
const AUTO_REFRESH_OPTIONS = [
  { value: "0", label: "关闭" },
  { value: "5000", label: "每 5 秒" },
  { value: "10000", label: "每 10 秒" },
  { value: "30000", label: "每 30 秒" },
  { value: "60000", label: "每 1 分钟" },
  { value: "300000", label: "每 5 分钟" },
  { value: "1800000", label: "每 30 分钟" },
];

interface BalanceStateResponse {
  providers: BalanceProviderView[];
  cache: Record<string, BalanceCacheEntry>;
  storePath: string;
}

interface QueryOutcomeResponse {
  status: "fetched" | "throttled" | "cooldown";
  fetchedAt: number;
  result: BalanceResultView | null;
  waitMs?: number;
  reason?: string | null;
}

interface BalanceResultView {
  success: boolean;
  data?: BalanceData[] | null;
  error?: string | null;
  errorKind?: "transient" | "deterministic" | null;
}

interface ProviderFormPayload {
  name: string;
  baseUrl: string;
  apiKey: string;
  kind: string;
  accessToken: string;
  userId: string;
  accessKeyId: string;
  secretAccessKey: string;
  organizationId: string;
  projectId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const inputClass =
  "h-9 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40";

// ── 供应商卡片 ────────────────────────────────────────────────

function BalanceDataRows({ rows, now }: { rows: BalanceData[]; now: number }) {
  return (
    <div className="space-y-3">
      {rows.map((row, index) => {
        const invalid = row.isValid === false;
        const usedRatio =
          row.total && row.total > 0 && row.used !== null && row.used !== undefined
            ? Math.min(1, Math.max(0, row.used / row.total))
            : null;
        const resetCountdown =
          !invalid && row.resetsAt ? formatResetCountdown(row.resetsAt, now) : null;
        return (
          <div key={`${row.planName ?? "balance"}-${index}`}>
            {row.planName && (
              <div className="mb-1 flex min-w-0 items-baseline gap-2">
                <span className="text-[11px] text-muted-foreground">{row.planName}</span>
                {resetCountdown && (
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/80">
                    {resetCountdown}
                  </span>
                )}
              </div>
            )}
            <div className="flex min-w-0 items-baseline gap-2">
              {invalid ? (
                <span className="truncate text-[15px] font-medium text-red-400">
                  {row.invalidMessage ?? "Key 已失效"}
                </span>
              ) : (
                <>
                  <span
                    className={cn(
                      "text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums",
                      row.remaining !== null && row.remaining !== undefined && row.remaining <= 0 && "text-red-400",
                    )}
                  >
                    {row.remaining !== null && row.remaining !== undefined
                      ? formatBalanceNumber(row.remaining)
                      : "—"}
                  </span>
                  {row.unit && (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {row.unit}
                    </span>
                  )}
                </>
              )}
              {usedRatio !== null && (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  已用 {formatBalanceNumber(row.used ?? 0)} / {formatBalanceNumber(row.total ?? 0)}
                </span>
              )}
            </div>
            {usedRatio !== null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    usedRatio >= 0.9 ? "bg-red-500" : usedRatio >= 0.75 ? "bg-amber-400" : "bg-primary",
                  )}
                  style={{ width: `${Math.round(usedRatio * 100)}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ProviderCard({
  provider,
  entry,
  refreshing,
  feedback,
  throttleRemainMs,
  now,
  onRefresh,
  onEdit,
  onDelete,
}: {
  provider: BalanceProviderView;
  entry: BalanceCacheEntry | undefined;
  refreshing: boolean;
  feedback: "ok" | "fail" | null;
  throttleRemainMs: number;
  now: number;
  onRefresh: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const lastResult = entry?.lastResult ?? null;
  const failed = lastResult !== null && !lastResult.success;
  const keyInvalid =
    failed && lastResult.data?.some((row) => row.isValid === false) === true;
  const transient = failed && lastResult.errorKind === "transient";
  const rows = lastResult?.data ?? entry?.lastSuccess?.data ?? null;
  const fromSnapshot = failed && entry?.lastSuccess !== null && entry?.lastSuccess !== undefined;
  const cooldownActive = (entry?.cooldownUntil ?? 0) > now;

  return (
    <div className="panel flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{provider.name}</span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {provider.kindLabel}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="刷新余额"
            disabled={refreshing}
            onClick={onRefresh}
            className="text-muted-foreground hover:text-foreground"
          >
            {refreshing ? (
              <RefreshCw className="animate-spin" />
            ) : feedback === "ok" ? (
              <Check className="text-emerald-500" />
            ) : feedback === "fail" ? (
              <CircleX className="text-red-400" />
            ) : (
              <RefreshCw />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="编辑供应商"
            onClick={onEdit}
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="删除供应商"
            onClick={onDelete}
            className="text-muted-foreground hover:text-red-400"
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="mt-1.5 min-w-0 space-y-0.5 font-mono text-[11px] leading-4 text-muted-foreground">
        <div className="truncate">{provider.baseUrl}</div>
        <div className="truncate">
          {provider.kind === "newapi"
            ? `${provider.accessTokenMasked ?? "未设置 Token"} · 用户 ${provider.userId || "未设置"}`
            : provider.kind === "volcengine"
              ? `${provider.accessKeyId || "未设置 AK"} · ${provider.secretAccessKeyMasked ?? "未设置 SK"}`
              : provider.kind === "zhipu_team"
                ? `${provider.apiKeyMasked || "未设置 Key"} · 组织 ${provider.organizationId || "未设置"} · 项目 ${provider.projectId || "未设置"}`
                : provider.apiKeyMasked || "未设置 Key"}
        </div>
      </div>

      <div className="mt-4 flex-1">
        {!lastResult && !rows && (
          <div className="flex h-[52px] items-center text-xs text-muted-foreground">
            尚未查询，点击右上角刷新获取余额
          </div>
        )}
        {rows && rows.length > 0 && <BalanceDataRows rows={rows} now={now} />}
        {failed && (
          <div className="mt-2 text-xs leading-5">
            {!keyInvalid && rows && rows.length > 0 && <div className="h-1" />}
            <div
              className={cn(
                "flex items-start gap-1.5",
                transient ? "text-amber-500" : "text-red-400",
              )}
            >
              {transient ? (
                <Clock className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span className="min-w-0 break-all">
                {transient ? "网络波动或服务暂不可用，已暂停查询避免触发风控" : lastResult.error}
              </span>
            </div>
            {keyInvalid && lastResult.data?.some((row) => row.invalidMessage) && (
              <div className="mt-1 text-red-400">
                {lastResult.data.find((row) => row.invalidMessage)?.invalidMessage}
              </div>
            )}
            {fromSnapshot && entry?.lastSuccess && (
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                上次成功查询 {formatRelativeTime(entry.lastSuccess.fetchedAt, now)}
                {entry.lastSuccess.data.length > 0 &&
                  ` · ${entry.lastSuccess.data
                    .map((row) => `${formatBalanceNumber(row.remaining ?? 0)} ${row.unit ?? ""}`)
                    .join(" / ")}`}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
        <span>
          {entry?.lastFetchedAt ? `${formatRelativeTime(entry.lastFetchedAt, now)}查询` : "未查询"}
          {fromSnapshot && "（展示上次成功值）"}
        </span>
        {cooldownActive ? (
          <span className="inline-flex items-center gap-1 text-amber-500" title={entry?.cooldownReason ?? undefined}>
            <Clock className="size-3" />
            冷却中
          </span>
        ) : throttleRemainMs > 0 ? (
          <span className="tabular-nums" title="服务端限流：两次真实查询至少间隔 5 秒（防连点）">
            {Math.ceil(throttleRemainMs / 1000)}s 后可刷新
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ── 添加 / 编辑弹窗（两步式，对齐 cc-switch：先选预设，再按预设出表单）────────

function PresetAvatar({ label, custom = false }: { label: string; custom?: boolean }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-xs font-semibold text-muted-foreground">
      {custom ? <SlidersHorizontal className="size-3.5" /> : label.slice(0, 1).toUpperCase()}
    </span>
  );
}

function PresetRow({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-start transition-colors hover:border-ring/50 hover:bg-muted/50"
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{label}</span>
        <span className="block truncate text-[11px] leading-4 text-muted-foreground" title={detail}>
          {detail}
        </span>
      </span>
    </button>
  );
}

function ProviderDialog({
  open,
  editing,
  onClose,
  onSubmit,
}: {
  open: boolean;
  editing: BalanceProviderView | null;
  onClose: () => void;
  /** 返回 null 表示成功（弹窗由父组件关闭），返回字符串为错误信息。 */
  onSubmit: (payload: ProviderFormPayload) => Promise<string | null>;
}) {
  // 编辑按已存配置反查预设后直接进表单；新增先选预设（null = 自定义）。
  const initialMatch = editing ? matchBalancePreset(editing.kind, editing.baseUrl) : null;
  const [step, setStep] = useState<"pick" | "form">(editing ? "form" : "pick");
  const [presetId, setPresetId] = useState<string | null>(initialMatch?.presetId ?? null);
  const [variantId, setVariantId] = useState<string>(initialMatch?.variantId ?? "");
  const [name, setName] = useState(editing?.name ?? "");
  // 名称没手动改过时跟随预设切换自动填。
  const [nameTouched, setNameTouched] = useState(Boolean(editing));
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  // 自定义模式的查询模板；编辑通用模板供应商时回填它的 kind。
  const [templateKind, setTemplateKind] = useState<string>(
    editing && !initialMatch ? editing.kind : "auto",
  );
  const [apiKey, setApiKey] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [userId, setUserId] = useState(editing?.userId ?? "");
  const [accessKeyId, setAccessKeyId] = useState(editing?.accessKeyId ?? "");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [organizationId, setOrganizationId] = useState(editing?.organizationId ?? "");
  const [projectId, setProjectId] = useState(editing?.projectId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const preset = presetId ? getBalancePreset(presetId) : undefined;
  // 固定厂商：地址由预设（或站点变体）决定并锁定；可编辑预设返回 null。
  const lockedBaseUrl = preset ? resolvePresetBaseUrl(preset, variantId) : null;

  const detected = detectBalanceKind(baseUrl);
  const resolvedKind: BalanceKind = preset
    ? preset.kind
    : templateKind !== "auto"
      ? (templateKind as BalanceKind)
      : (detected ?? "general");
  // 凭据表单按 kind 分流：newapi（Token+用户 ID）、volcengine（AK/SK）、
  // zhipu_team（Key+组织/项目 ID），其余为单 API Key。
  const credentialMode =
    resolvedKind === "newapi"
      ? "newapi"
      : resolvedKind === "volcengine"
        ? "volcengine"
        : resolvedKind === "zhipu_team"
          ? "zhipu_team"
          : "apiKey";

  const selectPreset = (nextId: string | null) => {
    const next = nextId ? getBalancePreset(nextId) : undefined;
    const nextLocked = next
      ? next.variants
        ? next.variants[0].baseUrl
        : next.baseUrl
      : null;
    setPresetId(nextId);
    setError(null);
    setVariantId(next?.variants?.[0].id ?? nextId ?? "");
    // 固定预设覆盖地址；切到可编辑预设 / 自定义时，预设填充过的地址清掉、手输的保留。
    setBaseUrl(nextLocked ?? (isPresetLockedBaseUrl(baseUrl) ? "" : baseUrl));
    if (!nameTouched) setName(next?.label ?? "");
    setStep("form");
  };

  const switchVariant = (nextVariantId: string) => {
    const variant = preset?.variants?.find((item) => item.id === nextVariantId);
    if (!variant || nextVariantId === variantId) return;
    setVariantId(nextVariantId);
    setBaseUrl(variant.baseUrl);
    setError(null);
  };

  const submit = async () => {
    if (submitting) return;
    const trimmedName = name.trim();
    const trimmedBaseUrl = (lockedBaseUrl ?? baseUrl).trim();
    // 本地先校验完整性；编辑时空凭据 = 保持不变（已有脱敏值时放行）。
    if (!trimmedName) {
      setError("请填写供应商名称");
      return;
    }
    if (!trimmedBaseUrl) {
      setError("请填写供应商地址（Base URL）");
      return;
    }
    if (credentialMode === "newapi") {
      if (!accessToken.trim() && !editing?.accessTokenMasked) {
        setError("new-api 中转站需要填写 Access Token");
        return;
      }
    } else if (credentialMode === "volcengine") {
      if (!accessKeyId.trim() && !editing?.accessKeyId) {
        setError("请填写火山引擎 AccessKey ID");
        return;
      }
      if (!secretAccessKey.trim() && !editing?.secretAccessKeyMasked) {
        setError("请填写火山引擎 AccessKey Secret");
        return;
      }
    } else if (credentialMode === "zhipu_team") {
      if (!apiKey.trim() && !editing?.apiKeyMasked) {
        setError("请填写 API Key");
        return;
      }
      if (!organizationId.trim() || !projectId.trim()) {
        setError("GLM 团队版需要填写组织 ID 与项目 ID");
        return;
      }
    } else if (!apiKey.trim() && !editing?.apiKeyMasked) {
      setError("请填写 API Key");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const message = await onSubmit({
        name: trimmedName,
        baseUrl: trimmedBaseUrl,
        apiKey,
        kind: preset ? preset.kind : templateKind,
        accessToken,
        userId,
        accessKeyId,
        secretAccessKey,
        organizationId,
        projectId,
      });
      if (message) setError(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  const fixedPresets = BALANCE_PROVIDER_PRESETS.filter((item) => isFixedBalancePreset(item));
  const selfHostedPresets = BALANCE_PROVIDER_PRESETS.filter((item) => !isFixedBalancePreset(item));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {step === "pick" ? "选择供应商" : editing ? "编辑供应商" : "添加供应商"}
          </DialogTitle>
          <DialogDescription>
            {step === "pick"
              ? "选择供应商预设：固定厂商的地址自动填充，也可选自定义填写任意地址。"
              : editing
                ? "修改供应商信息；凭据留空表示保持不变。"
                : "配置余额查询的供应商，Key 只保存在本机，不会上传。"}
          </DialogDescription>
        </DialogHeader>

        {step === "pick" ? (
          <div className="space-y-4 py-1">
            <div>
              <div className="mb-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">自定义</div>
              <div className="grid grid-cols-2 gap-2">
                <PresetRow
                  icon={<PresetAvatar label="自定义供应商" custom />}
                  label="自定义供应商"
                  detail="填写任意地址，自动识别或选模板"
                  onClick={() => selectPreset(null)}
                />
              </div>
            </div>
            <div>
              <div className="mb-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
                官方供应商 · 地址固定
              </div>
              <div className="grid grid-cols-2 gap-2">
                {fixedPresets.map((item) => (
                  <PresetRow
                    key={item.id}
                    icon={<PresetAvatar label={item.label} />}
                    label={item.label}
                    detail={item.domain}
                    onClick={() => selectPreset(item.id)}
                  />
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
                自建站点 · 地址自定义
              </div>
              <div className="grid grid-cols-2 gap-2">
                {selfHostedPresets.map((item) => (
                  <PresetRow
                    key={item.id}
                    icon={<PresetAvatar label={item.label} />}
                    label={item.label}
                    detail={item.domain}
                    onClick={() => selectPreset(item.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-1">
            {/* 预设条：图标 + 名称 + 域名，可「更换」回到选择列表（对齐 cc-switch PresetBar）。 */}
            <div className="rounded-lg border border-border/70 bg-muted/50 px-3 py-2.5">
              <div className="flex items-center gap-2.5">
                <PresetAvatar label={preset?.label ?? "自定义供应商"} custom={!preset} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {preset?.label ?? "自定义供应商"}
                  </div>
                  <div className="truncate font-mono text-[11px] leading-4 text-muted-foreground">
                    {preset ? lockedBaseUrl ?? "地址自定义" : "填写任意 Base URL"}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => setStep("pick")}
                >
                  更换
                </Button>
              </div>
              {preset?.variants && preset.variants.length > 1 && (
                <div
                  role="group"
                  aria-label="站点"
                  className="mt-2.5 flex rounded-lg border border-border bg-card p-0.5"
                >
                  {preset.variants.map((variant) => (
                    <button
                      key={variant.id}
                      type="button"
                      aria-pressed={variant.id === variantId}
                      onClick={() => switchVariant(variant.id)}
                      className={cn(
                        "h-7 flex-1 rounded-md text-xs transition-colors",
                        variant.id === variantId
                          ? "bg-primary/10 font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {variant.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">名称</span>
              <input
                className={inputClass}
                value={name}
                maxLength={40}
                placeholder="如 DeepSeek 主号"
                onChange={(event) => {
                  setName(event.target.value);
                  setNameTouched(true);
                }}
              />
            </label>

            {lockedBaseUrl ? (
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Base URL（固定供应商，已自动填充）
                </span>
                <div className="flex h-9 w-full items-center gap-2 rounded-lg border border-border/70 bg-muted/50 px-3 font-mono text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{lockedBaseUrl}</span>
                  <Lock className="size-3.5 shrink-0" aria-label="地址由模板固定" />
                </div>
                <p className="text-[11px] leading-4 text-muted-foreground/80">{preset?.hint}</p>
              </div>
            ) : (
              <>
                <label className="block space-y-1.5">
                  <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    Base URL
                    {!preset && baseUrl && (
                      <Badge variant={detected ? "default" : "outline"} className="text-[10px]">
                        {detected ? `已识别 ${getBalanceKindLabel(detected)}` : "未识别，按所选模板查询"}
                      </Badge>
                    )}
                  </span>
                  <input
                    className={cn(inputClass, "font-mono text-xs")}
                    value={baseUrl}
                    placeholder={
                      preset?.id === "newapi"
                        ? "https://你的中转站地址"
                        : preset?.id === "sub2api"
                          ? "https://你的站点地址（可带 /v1）"
                          : "https://api.example.com"
                    }
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </label>
                {preset ? (
                  <p className="text-[11px] leading-4 text-muted-foreground/80">{preset.hint}</p>
                ) : (
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">查询模板</span>
                    <Select value={templateKind} onValueChange={(value) => setTemplateKind(value ?? "auto")}>
                      <SelectTrigger className="h-9 w-full border-border bg-card text-xs" aria-label="查询模板">
                        <SelectValue>
                          {BALANCE_KIND_OPTIONS.find((option) => option.value === templateKind)?.label
                            ?? "自动检测"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {BALANCE_KIND_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] leading-4 text-muted-foreground/80">
                      {BALANCE_KIND_OPTIONS.find((option) => option.value === resolvedKind)?.hint}
                    </p>
                  </div>
                )}
              </>
            )}

            {credentialMode === "newapi" ? (
              <>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Access Token{editing?.accessTokenMasked ? "（留空保持不变）" : "（必填）"}
                  </span>
                  <input
                    className={cn(inputClass, "font-mono text-xs")}
                    value={accessToken}
                    placeholder={editing ? "留空表示保持不变" : "new-api 系统访问令牌"}
                    onChange={(event) => setAccessToken(event.target.value)}
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">用户 ID</span>
                  <input
                    className={cn(inputClass, "font-mono text-xs")}
                    value={userId}
                    placeholder="请求头 New-Api-User 的值"
                    onChange={(event) => setUserId(event.target.value)}
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">API Key（可选）</span>
                  <input
                    className={cn(inputClass, "font-mono text-xs")}
                    value={apiKey}
                    placeholder={editing ? "留空表示保持不变" : "推理用 Key，仅作记录"}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </label>
              </>
            ) : credentialMode === "volcengine" ? (
              <>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">AccessKey ID</span>
                  <input
                    className={cn(inputClass, "font-mono text-xs")}
                    value={accessKeyId}
                    placeholder="火山引擎账号 AK（如 AKLT...）"
                    onChange={(event) => setAccessKeyId(event.target.value)}
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    AccessKey Secret{editing?.secretAccessKeyMasked ? "（留空保持不变）" : ""}
                  </span>
                  <input
                    className={cn(inputClass, "font-mono text-xs")}
                    value={secretAccessKey}
                    type="password"
                    autoComplete="off"
                    placeholder={editing?.secretAccessKeyMasked ? "••••••（不修改）" : "火山引擎账号 SK"}
                    onChange={(event) => setSecretAccessKey(event.target.value)}
                  />
                </label>
                <p className="text-[11px] leading-4 text-muted-foreground/80">
                  用量查询走控制面 OpenAPI，需要火山引擎账号的 AccessKey（与推理 API Key 是两套凭据）。
                </p>
              </>
            ) : credentialMode === "zhipu_team" ? (
              <>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    API Key{editing?.apiKeyMasked ? "（留空保持不变）" : ""}
                  </span>
                  <input
                    className={cn(inputClass, "font-mono text-xs")}
                    value={apiKey}
                    type="password"
                    autoComplete="off"
                    placeholder={editing?.apiKeyMasked ? "••••••（不修改）" : "团队 API Key"}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">组织 ID</span>
                  <input
                    className={cn(inputClass, "font-mono text-xs")}
                    value={organizationId}
                    placeholder="请求头 bigmodel-organization 的值"
                    onChange={(event) => setOrganizationId(event.target.value)}
                  />
                </label>
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">项目 ID</span>
                  <input
                    className={cn(inputClass, "font-mono text-xs")}
                    value={projectId}
                    placeholder="请求头 bigmodel-project 的值"
                    onChange={(event) => setProjectId(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  API Key{editing?.apiKeyMasked ? "（留空保持不变）" : ""}
                </span>
                <input
                  className={cn(inputClass, "font-mono text-xs")}
                  value={apiKey}
                  type="password"
                  autoComplete="off"
                  placeholder={editing?.apiKeyMasked ? "••••••（不修改）" : "sk-..."}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
            )}
            {error && (
              <div className="flex items-start gap-1.5 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-400">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          {step === "form" && (
            <Button type="button" size="sm" disabled={submitting} onClick={() => void submit()}>
              {submitting && <RefreshCw className="animate-spin" />}
              {editing ? "保存" : "添加"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 主视图 ───────────────────────────────────────────────────

export function BalanceView() {
  const [providers, setProviders] = useState<BalanceProviderView[]>([]);
  const [cache, setCache] = useState<Record<string, BalanceCacheEntry>>({});
  const [storePath, setStorePath] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const [feedbacks, setFeedbacks] = useState<Record<string, "ok" | "fail">>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(300_000);
  const [now, setNow] = useState(() => Date.now());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BalanceProviderView | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BalanceProviderView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // id → 下一次允许真实外呼的时间戳（由服务端响应推算，仅用于展示）。
  const [throttleUntil, setThrottleUntil] = useState<Record<string, number>>({});
  const refreshingAllRef = useRef(false);

  const loadProviders = useCallback(async () => {
    try {
      const response = await fetch("/api/balance/providers", { cache: "no-store" });
      if (!response.ok) throw new Error("读取供应商配置失败");
      const payload = (await response.json()) as BalanceStateResponse;
      setProviders(payload.providers);
      setCache(payload.cache);
      setStorePath(payload.storePath);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "读取供应商配置失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProviders(), 0);
    return () => window.clearTimeout(timer);
  }, [loadProviders]);

  // 相对时间每 30s 重算（对齐 cc-switch QuotaLines useNow 的粒度）。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const applyOutcome = useCallback((id: string, outcome: QueryOutcomeResponse) => {
    setCache((previous) => {
      const entry: BalanceCacheEntry = previous[id] ?? {
        lastResult: null,
        lastFetchedAt: 0,
        lastSuccess: null,
        nextEligibleAt: 0,
        cooldownUntil: 0,
        cooldownReason: null,
      };
      return {
        ...previous,
        [id]: {
          ...entry,
          lastResult: outcome.result ?? entry.lastResult,
          lastFetchedAt: outcome.fetchedAt || entry.lastFetchedAt,
        },
      };
    });
    const remain =
      outcome.status === "fetched"
        ? MIN_QUERY_INTERVAL_MS - (Date.now() - outcome.fetchedAt)
        : (outcome.waitMs ?? 0);
    setThrottleUntil((previous) => ({
      ...previous,
      [id]: Date.now() + Math.max(0, remain),
    }));
    return outcome.status === "fetched" && (outcome.result?.success ?? false);
  }, []);

  const postQuery = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await fetch("/api/balance/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId: id }),
        });
        if (!response.ok) throw new Error("查询请求失败");
        const outcome = (await response.json()) as QueryOutcomeResponse;
        return applyOutcome(id, outcome);
      } catch {
        return false;
      }
    },
    [applyOutcome],
  );

  /** 单卡刷新：600ms 最小旋转 + 结果图标停留 1s（对齐 cc-switch 刷新反馈）。 */
  const refreshOne = useCallback(
    async (id: string) => {
      if (refreshingIds.has(id)) return;
      const start = Date.now();
      setRefreshingIds((previous) => new Set(previous).add(id));
      const ok = await postQuery(id);
      const elapsed = Date.now() - start;
      if (elapsed < MIN_REFRESH_SPIN_MS) await sleep(MIN_REFRESH_SPIN_MS - elapsed);
      setRefreshingIds((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
      setFeedbacks((previous) => ({ ...previous, [id]: ok ? "ok" : "fail" }));
      window.setTimeout(() => {
        setFeedbacks((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }, REFRESH_RESULT_MS);
    },
    [postQuery, refreshingIds],
  );

  /** 全部刷新：并发上限 2 依次查询；silent 时不转卡片图标（自动轮询用）。 */
  const refreshAll = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (refreshingAllRef.current) return;
      refreshingAllRef.current = true;
      if (!options.silent) setRefreshingAll(true);
      try {
        const queue = providers.map((provider) => provider.id);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, async () => {
          while (cursor < queue.length) {
            const index = cursor++;
            await postQuery(queue[index]);
          }
        });
        await Promise.all(workers);
      } finally {
        refreshingAllRef.current = false;
        setRefreshingAll(false);
      }
    },
    [postQuery, providers],
  );

  // 自动刷新只在挂载期间运行（切走视图即停止），服务端节流兜底。
  useEffect(() => {
    if (autoRefresh === 0 || providers.length === 0) return;
    const timer = window.setInterval(() => void refreshAll({ silent: true }), autoRefresh);
    return () => window.clearInterval(timer);
  }, [autoRefresh, providers.length, refreshAll]);

  const submitProvider = useCallback(
    async (payload: ProviderFormPayload): Promise<string | null> => {
      try {
        const editingId = editing?.id;
        const response = await fetch(
          editingId ? `/api/balance/providers/${editingId}` : "/api/balance/providers",
          {
            method: editingId ? "PATCH" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: payload.name,
              baseUrl: payload.baseUrl,
              apiKey: payload.apiKey,
              kind: payload.kind,
              accessToken: payload.accessToken,
              userId: payload.userId,
              accessKeyId: payload.accessKeyId,
              secretAccessKey: payload.secretAccessKey,
              organizationId: payload.organizationId,
              projectId: payload.projectId,
            }),
          },
        );
        const body = (await response.json()) as { provider?: BalanceProviderView; error?: string };
        if (!response.ok || !body.provider) {
          return body.error ?? "保存失败";
        }
        setDialogOpen(false);
        setEditing(null);
        await loadProviders();
        if (!editingId) {
          // 新供应商立即查询一次（首次不受最小间隔限制）。
          void postQuery(body.provider.id);
        }
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : "保存失败";
      }
    },
    [editing, loadProviders, postQuery],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`/api/balance/providers/${id}`, { method: "DELETE" });
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          throw new Error(body.error ?? "删除失败");
        }
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : "删除失败");
      } finally {
        setConfirmDelete(null);
        await loadProviders();
      }
    },
    [loadProviders],
  );

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (provider: BalanceProviderView) => {
    setEditing(provider);
    setDialogOpen(true);
  };

  const hasProviders = providers.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={openCreate} className="h-9 px-3 text-xs">
          <Plus /> 添加供应商
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasProviders || refreshingAll}
          onClick={() => void refreshAll()}
          className="h-9 bg-card px-3 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={cn(refreshingAll && "animate-spin")} />
          全部刷新
        </Button>
        <Select
          value={String(autoRefresh)}
          onValueChange={(value) => setAutoRefresh(Number(value ?? "0"))}
        >
          <SelectTrigger className="h-9 border-border bg-card text-xs" aria-label="自动刷新间隔">
            <SelectValue>
              {autoRefresh === 0
                ? "自动刷新关闭"
                : `自动刷新 ${AUTO_REFRESH_OPTIONS.find((option) => Number(option.value) === autoRefresh)?.label ?? ""}`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {AUTO_REFRESH_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto hidden items-center gap-1.5 text-[11px] text-muted-foreground/75 sm:flex">
          <ShieldCheck className="size-3.5" />
          内置限流：两次查询至少间隔 5 秒，失败自动冷却
        </div>
      </div>

      {actionError && (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <CircleAlert className="size-4 shrink-0" />
          <span className="flex-1">{actionError}</span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setActionError(null)}>
            知道了
          </Button>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="panel space-y-3 p-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
              <Skeleton className="mt-4 h-8 w-28" />
              <Skeleton className="mt-4 h-3 w-full" />
            </div>
          ))}
        </div>
      ) : !hasProviders ? (
        <div className="panel flex flex-col items-center justify-center px-6 py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-secondary">
            <Wallet className="size-6 text-muted-foreground" />
          </div>
          <div className="mt-4 text-sm font-medium">还没有配置供应商</div>
          <p className="mt-1.5 max-w-md text-xs leading-5 text-muted-foreground">
            添加 DeepSeek、SiliconFlow、OpenRouter、智谱、new-api 中转站等供应商的查询配置，
            即可在这里集中查看余额。API Key 只保存在本机，查询内置限流保护。
          </p>
          <Button type="button" size="sm" onClick={openCreate} className="mt-5">
            <Plus /> 添加第一个供应商
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              entry={cache[provider.id]}
              refreshing={refreshingIds.has(provider.id)}
              feedback={feedbacks[provider.id] ?? null}
              throttleRemainMs={(throttleUntil[provider.id] ?? 0) - now}
              now={now}
              onRefresh={() => void refreshOne(provider.id)}
              onEdit={() => openEdit(provider)}
              onDelete={() => setConfirmDelete(provider)}
            />
          ))}
        </div>
      )}

      {hasProviders && (
        <div className="px-1 text-[11px] leading-5 text-muted-foreground/75">
          为避免触发供应商风控：同一供应商两次真实查询至少间隔 {MIN_QUERY_INTERVAL_MS / 1000} 秒（含手动刷新），
          网络波动暂停 1 分钟，被限流（HTTP 429）时暂停 5 分钟并继续展示上次成功值。配置与 Key 仅保存在
          <code className="mx-1 break-all">{storePath || "~/.y-token-panel/balance.json"}</code>
          。
        </div>
      )}

      <ProviderDialog
        key={dialogOpen ? editing?.id ?? "new" : "closed"}
        open={dialogOpen}
        editing={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSubmit={submitProvider}
      />

      <Dialog open={confirmDelete !== null} onOpenChange={(next) => !next && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>删除供应商</DialogTitle>
            <DialogDescription>
              确认删除「{confirmDelete?.name}」？仅移除本面板的查询配置与缓存，不影响供应商账户。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => confirmDelete && void deleteProvider(confirmDelete.id)}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
