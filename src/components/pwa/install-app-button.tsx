"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Download, LoaderCircle, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}

type BrowserPlatform = "chromium" | "firefox" | "ios" | "other" | "safari";

function getBrowserPlatform(): BrowserPlatform {
  const userAgent = navigator.userAgent;
  const isIPad =
    /Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1;

  if (/iPad|iPhone|iPod/.test(userAgent) || isIPad) return "ios";
  if (/Firefox\//.test(userAgent)) return "firefox";
  if (/Safari\//.test(userAgent) && !/Chrome|Chromium|Edg\//.test(userAgent)) {
    return "safari";
  }
  if (/Chrome|Chromium|CriOS|Edg\//.test(userAgent)) return "chromium";
  return "other";
}

function isInstalled() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function subscribeToInstalledState(onStoreChange: () => void) {
  const displayMode = window.matchMedia("(display-mode: standalone)");
  displayMode.addEventListener("change", onStoreChange);
  window.addEventListener("appinstalled", onStoreChange);
  return () => {
    displayMode.removeEventListener("change", onStoreChange);
    window.removeEventListener("appinstalled", onStoreChange);
  };
}

function emptySubscription() {
  return () => undefined;
}

function getServerPlatform(): BrowserPlatform {
  return "other";
}

const manualSteps: Record<BrowserPlatform, string[]> = {
  chromium: [
    "点击地址栏右侧的“安装”图标；如果没有显示，请打开浏览器菜单。",
    "在菜单中选择“安装 Y Token”“安装页面为应用”或“安装此站点为应用”。",
    "确认安装后，即可从桌面、开始菜单或应用列表独立打开。",
  ],
  firefox: [
    "Firefox 桌面版暂不支持安装 PWA，请改用 Chrome、Edge 或 Safari。",
    "Android 版 Firefox 可打开浏览器菜单，选择“添加到主屏幕”。",
  ],
  ios: [
    "点击浏览器工具栏中的“分享”按钮。",
    "向下滚动并选择“添加到主屏幕”。",
    "点击右上角“添加”，之后可从主屏幕独立打开 Y Token。",
  ],
  safari: [
    "使用 Safari 17 或更高版本，打开菜单栏中的“文件”。",
    "选择“添加到程序坞”，然后确认添加。",
    "之后可从程序坞或启动台独立打开 Y Token。",
  ],
  other: [
    "打开浏览器菜单，查找“安装应用”“安装此站点为应用”或“添加到主屏幕”。",
    "如果当前浏览器没有安装入口，请使用最新版 Chrome、Edge 或 Safari。",
  ],
};

export function InstallAppButton() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const standaloneInstalled = useSyncExternalStore(
    subscribeToInstalledState,
    isInstalled,
    () => false,
  );
  const [installedThisSession, setInstalledThisSession] = useState(false);
  const installed = standaloneInstalled || installedThisSession;
  const platform = useSyncExternalStore(
    emptySubscription,
    getBrowserPlatform,
    getServerPlatform,
  );
  const secureContext = useSyncExternalStore(
    emptySubscription,
    () => window.isSecureContext,
    () => true,
  );
  const [installing, setInstalling] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | null>(null);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setInstalledThisSession(true);
      setInstructionsOpen(false);
      setInstallMessage(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (installed || installing) return;

    if (!deferredPrompt) {
      setInstallMessage(null);
      setInstructionsOpen(true);
      return;
    }

    setInstalling(true);
    setInstallMessage(null);
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      // beforeinstallprompt 只能调用一次；取消后改用手动安装指引。
      setDeferredPrompt(null);
      if (choice.outcome === "dismissed") {
        setInstallMessage("已取消安装。你也可以稍后通过浏览器菜单完成安装。");
        setInstructionsOpen(true);
      }
    } catch {
      setDeferredPrompt(null);
      setInstallMessage("浏览器未能打开安装窗口，请使用下方手动安装方式。");
      setInstructionsOpen(true);
    } finally {
      setInstalling(false);
    }
  };

  const label = installed ? "已安装" : installing ? "正在安装" : "安装应用";

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={label}
        title={installed ? "Y Token 已作为独立应用运行" : "将 Y Token 安装到这台设备"}
        disabled={installed || installing}
        onClick={() => void install()}
        className="h-8 bg-card px-3 text-xs text-muted-foreground hover:text-foreground"
      >
        {installed ? (
          <Check />
        ) : installing ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <Download />
        )}
        <span className="hidden sm:inline">{label}</span>
      </Button>

      <Dialog open={instructionsOpen} onOpenChange={setInstructionsOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-300 via-orange-400 to-rose-500 text-white">
              {platform === "ios" ? <Share className="size-5" /> : <Download className="size-5" />}
            </div>
            <DialogTitle>安装 Y Token</DialogTitle>
            <DialogDescription>
              安装后可从系统应用列表启动，并在独立窗口中使用。
            </DialogDescription>
          </DialogHeader>

          {installMessage && (
            <div role="status" className="rounded-lg bg-muted/50 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
              {installMessage}
            </div>
          )}

          <ol className="space-y-3">
            {manualSteps[platform].map((step, index) => (
              <li key={step} className="flex gap-3 text-sm leading-6">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
                  {index + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>

          <div className="rounded-lg border border-border/70 bg-muted/20 px-3.5 py-3 text-xs leading-5 text-muted-foreground">
            {secureContext
              ? "如果没有安装入口，请确认浏览器已升级至最新版本，并重新打开本页面。"
              : "浏览器安装应用需要 HTTPS 安全连接（localhost 与 127.0.0.1 本地访问除外）。"}
            <br />
            用量与余额接口始终实时请求，不会写入离线缓存。
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
