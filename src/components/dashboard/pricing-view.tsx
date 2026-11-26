"use client";

import { useEffect, useMemo, useState } from "react";
import { CircleAlert, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatTime, formatCompact } from "@/lib/usage";
import type { ModelPricingInfo, ModelsDevSyncConfig } from "@/lib/model-pricing";

interface PricingResponse {
  models: ModelPricingInfo[];
  sync: ModelsDevSyncConfig;
  configPath: string;
}

interface EditorState {
  originalId: string | null;
  modelId: string;
  displayName: string;
  inputCostPerMillion: string;
  outputCostPerMillion: string;
  cacheReadCostPerMillion: string;
  cacheCreationCostPerMillion: string;
}

const emptyEditor: EditorState = {
  originalId: null,
  modelId: "",
  displayName: "",
  inputCostPerMillion: "",
  outputCostPerMillion: "",
  cacheReadCostPerMillion: "0",
  cacheCreationCostPerMillion: "0",
};

function priceText(value: string): string {
  const number = Number(value);
  return Number.isFinite(number) ? `$${number}` : value;
}

export function PricingView() {
  const [data, setData] = useState<PricingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const response = await fetch("/api/pricing", { cache: "no-store" });
      if (!response.ok) throw new Error("读取模型价格失败");
      setData((await response.json()) as PricingResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const rows = data?.models ?? [];
    if (!keyword) return rows;
    return rows.filter((row) =>
      row.modelId.toLowerCase().includes(keyword) || row.displayName.toLowerCase().includes(keyword)
    );
  }, [data, search]);

  const saveConfig = async (patch: Partial<ModelsDevSyncConfig>) => {
    if (!data) return;
    const previous = data.sync;
    setData({ ...data, sync: { ...data.sync, ...patch } });
    try {
      const response = await fetch("/api/pricing/models-dev", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "保存同步设置失败");
      const payload = await response.json() as { config: ModelsDevSyncConfig };
      setData((current) => current ? { ...current, sync: payload.config } : current);
    } catch (cause) {
      setData((current) => current ? { ...current, sync: previous } : current);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const syncNow = async (force: boolean) => {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/pricing/models-dev", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "models.dev 同步失败");
      setNotice(payload.skipped
        ? "已跳过：自动同步关闭或距上次同步不足 6 小时"
        : `已同步 ${payload.imported} 个模型价格，${payload.changed} 条发生变化`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSyncing(false);
    }
  };

  const saveEditor = async () => {
    if (!editor) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/pricing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(editor),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "保存模型价格失败");
      if (editor.originalId && editor.originalId !== editor.modelId) {
        await fetch(`/api/pricing?modelId=${encodeURIComponent(editor.originalId)}`, { method: "DELETE" });
      }
      setEditor(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (modelId: string) => {
    if (!window.confirm(`删除 ${modelId} 的价格覆盖/表项？历史已计算成本不会重算。`)) return;
    const response = await fetch(`/api/pricing?modelId=${encodeURIComponent(modelId)}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setError(payload?.error ?? "删除模型价格失败");
      return;
    }
    await load();
  };

  const inputClass = "h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary";
  const sync = data?.sync;

  return (
    <section className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">模型价格目录</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            内置 236 条 cc-switch 价格 seed；models.dev 与用户覆盖写入本地 model-pricing.json。成本是估算，不是供应商账单。
          </p>
        </div>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索模型 ID / 名称"
          className={cn(inputClass, "max-w-[260px]")}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => setEditor(emptyEditor)}>
          <Plus /> 新增价格
        </Button>
        <Button type="button" size="sm" disabled={syncing} onClick={() => void syncNow(true)}>
          <RefreshCw className={cn(syncing && "animate-spin")} /> 同步 models.dev
        </Button>
      </div>

      <div className="grid gap-3 border-b border-border/70 px-5 py-4 text-xs text-muted-foreground lg:grid-cols-[1fr_auto]">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sync?.autoSyncEnabled !== false}
              onChange={(event) => void saveConfig({ autoSyncEnabled: event.target.checked })}
            />
            自动同步（最多 6 小时一次）
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sync?.includeCommonModels !== false}
              onChange={(event) => void saveConfig({ includeCommonModels: event.target.checked })}
            />
            包含常用文本模型
          </label>
          <span>
            上次同步：{sync?.lastSyncAt ? formatTime(sync.lastSyncAt) : "从未同步"}
          </span>
          {sync?.lastSyncError && <span className="text-red-400">最近错误：{sync.lastSyncError}</span>}
        </div>
        <div className="truncate" title={data?.configPath}>覆盖文件：{data?.configPath ?? "—"}</div>
      </div>

      {error && (
        <div className="mx-5 mt-4 flex items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <CircleAlert className="size-3.5" /> {error}
        </div>
      )}
      {notice && <div className="mx-5 mt-4 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">{notice}</div>}

      <Table className="min-w-[980px]">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-5">模型</TableHead>
            <TableHead className="text-right">输入 / 1M</TableHead>
            <TableHead className="text-right">输出 / 1M</TableHead>
            <TableHead className="text-right">缓存读 / 1M</TableHead>
            <TableHead className="text-right">缓存写 / 1M</TableHead>
            <TableHead className="pr-5 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow><TableCell colSpan={6} className="h-40 text-center text-muted-foreground">正在加载价格目录…</TableCell></TableRow>
          ) : filtered.length === 0 ? (
            <TableRow><TableCell colSpan={6} className="h-40 text-center text-muted-foreground">没有匹配的模型价格</TableCell></TableRow>
          ) : filtered.slice(0, 300).map((row) => (
            <TableRow key={row.modelId}>
              <TableCell className="pl-5">
                <div className="font-medium">{row.displayName}</div>
                <div className="mt-0.5 font-mono text-xs text-muted-foreground">{row.modelId}</div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{priceText(row.inputCostPerMillion)}</TableCell>
              <TableCell className="text-right tabular-nums">{priceText(row.outputCostPerMillion)}</TableCell>
              <TableCell className="text-right tabular-nums">{priceText(row.cacheReadCostPerMillion)}</TableCell>
              <TableCell className="text-right tabular-nums">{priceText(row.cacheCreationCostPerMillion)}</TableCell>
              <TableCell className="pr-5 text-right">
                <Button type="button" variant="ghost" size="icon-sm" aria-label="编辑" onClick={() => setEditor({ originalId: row.modelId, ...row })}>
                  <Pencil />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="删除" onClick={() => void remove(row.modelId)}>
                  <Trash2 />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {filtered.length > 300 && (
        <div className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
          仅显示前 300 / {formatCompact(filtered.length)} 条，请用搜索缩小范围。
        </div>
      )}
      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editor?.originalId ? "编辑模型价格" : "新增模型价格"}</DialogTitle>
            <DialogDescription>单位均为美元 / 1M tokens；缓存写价格按 5 分钟 TTL 档填写，1 小时写入自动按 1.6 倍估算。</DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 text-xs text-muted-foreground">模型 ID
                <input className={cn(inputClass, "mt-1 font-mono")} value={editor.modelId} onChange={(e) => setEditor({ ...editor, modelId: e.target.value })} />
              </label>
              <label className="col-span-2 text-xs text-muted-foreground">显示名称
                <input className={cn(inputClass, "mt-1")} value={editor.displayName} onChange={(e) => setEditor({ ...editor, displayName: e.target.value })} />
              </label>
              {([
                ["inputCostPerMillion", "输入价格"],
                ["outputCostPerMillion", "输出价格"],
                ["cacheReadCostPerMillion", "缓存读取价格"],
                ["cacheCreationCostPerMillion", "缓存写入价格"],
              ] as const).map(([key, label]) => (
                <label key={key} className="text-xs text-muted-foreground">{label}
                  <input className={cn(inputClass, "mt-1")} value={editor[key]} onChange={(e) => setEditor({ ...editor, [key]: e.target.value })} />
                </label>
              ))}
              <div className="col-span-2 flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setEditor(null)}>取消</Button>
                <Button type="button" disabled={saving} onClick={() => void saveEditor()}>{saving ? "保存中…" : "保存"}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
