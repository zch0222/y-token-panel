import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravityRoots } from "@/lib/antigravity";
import { claudeSource } from "@/lib/claude";
import { codeBuddySource } from "@/lib/codebuddy";
import { codexRoot } from "@/lib/codex";
import { dshSource } from "@/lib/dsh";
import { kcodeRoot } from "@/lib/kcode";
import { resolvePiDesktopSessionsDir } from "@/lib/pi-desktop";
import { qoderSource } from "@/lib/qoder";
import { workBuddySource } from "@/lib/workbuddy";
import { resolveDevinDatabasePath } from "@/lib/devin";
import { resolveZcodeDatabasePath } from "@/lib/zcode";

const ENV_KEYS = [
  "CODEBUDDY_DATA_DIR",
  "CODEBUDDY_CONFIG_DIR",
  "WORKBUDDY_DATA_DIR",
  "WORKBUDDY_CONFIG_DIR",
  "WORKBUDDY_INSTANCE_NUMBER",
  "QODER_DATA_DIR",
  "QODERCN_CONFIG_DIR",
  "QODERCN_CLI_HOME",
  "QODERCN_CONFIG_DIR_NAME",
  "DSH_HOME",
  "ZCODE_DATA_DIR",
  "ZCODE_SESSION_DB_PATH",
  "ZCODE_SESSION_DB",
  "KIMI_CODE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "ANTIGRAVITY_DATA_DIR",
  "PI_DESKTOP_DATA_DIR",
  "PI_DESKTOP_DEV",
  "DEVIN_DATA_DIR",
  "DEVIN_SESSIONS_DIR",
  "DEVIN_CONFIG_HOME",
  "DEVIN_SESSION_STORE",
] as const;
const original = new Map<string, string | undefined>();
const temporaryRoots: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    if (!original.has(key)) original.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "y-token-harness-paths-"));
  temporaryRoots.push(root);
  return root;
}

describe("Harness 配置路径与本机实现一致", () => {
  it("CodeBuddy CONFIG_DIR 是配置根且空白按未设置，DATA_DIR 才是 projects 直接覆盖", () => {
    process.env.CODEBUDDY_CONFIG_DIR = "   ";
    expect(codeBuddySource()).toBe(path.join(homedir(), ".codebuddy", "projects"));
    process.env.CODEBUDDY_CONFIG_DIR = path.join("D:", "codebuddy-home");
    expect(codeBuddySource()).toBe(path.join("D:", "codebuddy-home", "projects"));
    process.env.CODEBUDDY_DATA_DIR = path.join("D:", "projects-only");
    expect(codeBuddySource()).toBe(path.join("D:", "projects-only"));
  });

  it("WorkBuddy 只认 WORKBUDDY_DATA_DIR / WORKBUDDY_CONFIG_DIR，不把 INSTANCE_NUMBER 当目录后缀，也不串读 CODEBUDDY_CONFIG_DIR", () => {
    process.env.WORKBUDDY_INSTANCE_NUMBER = "2";
    process.env.CODEBUDDY_CONFIG_DIR = path.join("D:", "codebuddy-home");
    expect(workBuddySource()).toBe(path.join(homedir(), ".workbuddy", "projects"));
    process.env.WORKBUDDY_CONFIG_DIR = "  D:\\workbuddy-custom  ";
    expect(workBuddySource()).toBe(path.join("D:\\workbuddy-custom", "projects"));
    process.env.WORKBUDDY_DATA_DIR = "  D:\\workbuddy-data  ";
    expect(workBuddySource()).toBe(path.join("D:\\workbuddy-data", "projects"));
  });

  it("Qoder CN 对齐 WV/pxt 与 SDK Na/Te：CONFIG_DIR 是完整根，CLI_HOME 拼接 CONFIG_DIR_NAME", () => {
    process.env.QODERCN_CLI_HOME = path.join("D:", "qoder-cli");
    expect(qoderSource()).toBe(path.join("D:", "qoder-cli", ".qoder-cn", "projects"));
    process.env.QODERCN_CONFIG_DIR_NAME = ".qoder-enterprise";
    expect(qoderSource()).toBe(path.join("D:", "qoder-cli", ".qoder-enterprise", "projects"));
    process.env.QODERCN_CONFIG_DIR_NAME = "../bad";
    expect(() => qoderSource()).toThrow(/QODERCN_CONFIG_DIR_NAME/);
    process.env.QODERCN_CONFIG_DIR = path.join("D:", "qoder-config");
    expect(qoderSource()).toBe(path.join("D:", "qoder-config", "projects"));
    process.env.QODER_DATA_DIR = path.join("D:", "qoder-projects");
    expect(qoderSource()).toBe(path.join("D:", "qoder-projects"));
  });

  it("DSH 忽略空白 HOME，并按官方范围展开波浪号", () => {
    process.env.DSH_HOME = "   ";
    expect(dshSource()).toBe(path.join(homedir(), ".dsh", "sessions"));
    process.env.DSH_HOME = "~/dsh-custom";
    expect(dshSource()).toBe(path.join(homedir(), "dsh-custom", "sessions"));
    process.env.DSH_HOME = "~other/dsh";
    expect(dshSource()).toBe(path.resolve("~other/dsh", "sessions"));
  });

  it("KCode、Claude 与 Codex 共享根目录解析并覆盖各自环境变量", () => {
    process.env.KIMI_CODE_HOME = "   ";
    expect(kcodeRoot()).toBe(path.join(homedir(), ".kimi-code"));
    process.env.KIMI_CODE_HOME = "~/kimi-custom";
    expect(kcodeRoot()).toBe(path.join(homedir(), "kimi-custom"));

    expect(claudeSource()).toBe(path.join(homedir(), ".claude", "projects"));
    process.env.CLAUDE_CONFIG_DIR = path.join("D:", "claude-acc");
    expect(claudeSource()).toBe(path.join("D:", "claude-acc", "projects"));

    expect(codexRoot()).toBe(path.join(homedir(), ".codex"));
    process.env.CODEX_HOME = path.join("D:", "codex-custom");
    expect(codexRoot()).toBe(path.join("D:", "codex-custom"));
  });

  it("Antigravity 默认同时尝试 IDE 与 CLI 根，面板 DATA_DIR 覆盖为单一根", () => {
    expect(antigravityRoots()).toEqual([
      path.join(homedir(), ".gemini", "antigravity"),
      path.join(homedir(), ".gemini", "antigravity-cli"),
    ]);
    process.env.ANTIGRAVITY_DATA_DIR = "  D:\\antigravity-data  ";
    expect(antigravityRoots()).toEqual([path.resolve("D:\\antigravity-data")]);
    process.env.ANTIGRAVITY_DATA_DIR = "   ";
    expect(antigravityRoots()).toEqual([
      path.join(homedir(), ".gemini", "antigravity"),
      path.join(homedir(), ".gemini", "antigravity-cli"),
    ]);
  });

  it("ZCode 面板 DATA_DIR 优先于官方会话库配置", async () => {
    process.env.ZCODE_DATA_DIR = path.join("D:", "zcode-root");
    process.env.ZCODE_SESSION_DB_PATH = path.join("D:", "elsewhere.sqlite");
    await expect(resolveZcodeDatabasePath()).resolves.toBe(
      path.join("D:", "zcode-root", "cli", "db", "db.sqlite"),
    );
  });

  it("ZCode 对齐 zcode.cjs：支持 ~/、绝对路径与相对路径，后出现变量覆盖前一个，空串回退", async () => {
    process.env.ZCODE_SESSION_DB_PATH = "~/zcode-custom/db.sqlite";
    await expect(resolveZcodeDatabasePath()).resolves.toBe(
      path.join(homedir(), "zcode-custom", "db.sqlite"),
    );
    process.env.ZCODE_SESSION_DB_PATH = "relative/db.sqlite";
    await expect(resolveZcodeDatabasePath()).resolves.toBe(
      path.resolve("relative/db.sqlite"),
    );
    await expect(
      resolveZcodeDatabasePath({
        env: {
          ZCODE_SESSION_DB_PATH: "D:\\primary.sqlite",
          ZCODE_SESSION_DB: "D:\\legacy-override.sqlite",
        },
      }),
    ).resolves.toBe("D:\\legacy-override.sqlite");
  });

  it("ZCode 从 cli/config.json 读取 storage.sessionDbPath，损坏或类型非法时静默回退默认库", async () => {
    const home = await temporaryHome();
    const configDir = path.join(home, ".zcode", "cli");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ storage: { sessionDbPath: "~/custom-zcode/db.sqlite" } }),
    );
    await expect(resolveZcodeDatabasePath({ homeDir: home, env: {} })).resolves.toBe(
      path.join(home, "custom-zcode", "db.sqlite"),
    );

    // Env 为空串时不覆盖 User 层（对齐 zcode.cjs ConfigStore 仅在非空时 set）。
    await expect(
      resolveZcodeDatabasePath({
        homeDir: home,
        env: { ZCODE_SESSION_DB_PATH: "" },
      }),
    ).resolves.toBe(path.join(home, "custom-zcode", "db.sqlite"));

    // JSON 损坏或 schema 不合法时对齐 loadFileConfig（Zve），捕获并回退默认库而不抛错。
    await writeFile(path.join(configDir, "config.json"), "{ invalid json");
    await expect(resolveZcodeDatabasePath({ homeDir: home, env: {} })).resolves.toBe(
      path.join(home, ".zcode", "cli", "db", "db.sqlite"),
    );

    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ storage: { sessionDbPath: 123 } }),
    );
    await expect(resolveZcodeDatabasePath({ homeDir: home, env: {} })).resolves.toBe(
      path.join(home, ".zcode", "cli", "db", "db.sqlite"),
    );
  });

  it("ZCode 缺少配置文件或空配置时使用默认库", async () => {
    const home = await temporaryHome();
    await expect(resolveZcodeDatabasePath({ homeDir: home, env: {} })).resolves.toBe(
      path.join(home, ".zcode", "cli", "db", "db.sqlite"),
    );
    const configDir = path.join(home, ".zcode", "cli");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "config.json"), JSON.stringify({ storage: {} }));
    await expect(resolveZcodeDatabasePath({ homeDir: home, env: {} })).resolves.toBe(
      path.join(home, ".zcode", "cli", "db", "db.sqlite"),
    );
  });

  it("Devin 对齐 devin.exe：配置根下 cli/sessions.db，面板 DATA_DIR 优先于官方变量", () => {
    // 默认：appData 注入的配置根（Windows 实机为 %APPDATA%\devin）。
    expect(
      resolveDevinDatabasePath({
        env: {},
        homeDir: "C:\\Users\\tester",
        appDataDir: "C:\\Users\\tester\\AppData\\Roaming",
      }),
    ).toBe(path.join("C:\\Users\\tester\\AppData\\Roaming", "devin", "cli", "sessions.db"));

    // 官方 DEVIN_SESSIONS_DIR 直接指向含 sessions.db 的目录。
    process.env.DEVIN_SESSIONS_DIR = "  D:\\devin-sessions  ";
    expect(resolveDevinDatabasePath()).toBe(path.join("D:", "devin-sessions", "sessions.db"));
    delete process.env.DEVIN_SESSIONS_DIR;

    // 官方 DEVIN_CONFIG_HOME 覆盖配置根。
    process.env.DEVIN_CONFIG_HOME = "D:\\devin-config";
    expect(resolveDevinDatabasePath()).toBe(
      path.join("D:", "devin-config", "cli", "sessions.db"),
    );

    // 面板专用 DEVIN_DATA_DIR 优先级最高（对齐 ZCODE_DATA_DIR 约定）。
    process.env.DEVIN_DATA_DIR = "D:\\devin-root";
    expect(resolveDevinDatabasePath()).toBe(
      path.join("D:", "devin-root", "cli", "sessions.db"),
    );
  });

  it("Pi Desktop 对齐 app resolveDataDir：env 覆盖、开发目录与默认根", async () => {
    await expect(resolvePiDesktopSessionsDir()).resolves.toBe(
      path.join(homedir(), ".pi-desktop", "sessions"),
    );
    process.env.PI_DESKTOP_DATA_DIR = "  D:\\pi-data  ";
    await expect(resolvePiDesktopSessionsDir()).resolves.toBe(
      path.join("D:", "pi-data", "sessions"),
    );
    delete process.env.PI_DESKTOP_DATA_DIR;

    process.env.PI_DESKTOP_DEV = "1";
    await expect(resolvePiDesktopSessionsDir()).resolves.toBe(
      path.join(homedir(), ".pi-desktop-dev", "sessions"),
    );
    delete process.env.PI_DESKTOP_DEV;
  });

  it("Pi Desktop 跟随应用内迁移 storage-location.json，损坏 / 版本不符 / 相对路径时静默回退", async () => {
    const home = await temporaryHome();
    const appData = path.join(home, "appdata");
    const preferenceDir = path.join(appData, "PI-Desktop");
    await mkdir(preferenceDir, { recursive: true });
    const relocated = path.join(home, "relocated");
    const preference = path.join(preferenceDir, "storage-location.json");

    await writeFile(
      preference,
      JSON.stringify({ version: 1, roots: { data: relocated, browser: appData }, backups: [] }),
    );
    await expect(
      resolvePiDesktopSessionsDir({ env: {}, homeDir: home, appDataDir: appData }),
    ).resolves.toBe(path.join(relocated, "sessions"));

    // env 覆盖时忽略迁移偏好（对齐 app 的 overridden 分支）。
    await expect(
      resolvePiDesktopSessionsDir({
        env: { PI_DESKTOP_DATA_DIR: "D:\\pi-override" },
        homeDir: home,
        appDataDir: appData,
      }),
    ).resolves.toBe(path.join("D:", "pi-override", "sessions"));

    await writeFile(preference, "{ invalid");
    await expect(
      resolvePiDesktopSessionsDir({ env: {}, homeDir: home, appDataDir: appData }),
    ).resolves.toBe(path.join(home, ".pi-desktop", "sessions"));

    await writeFile(preference, JSON.stringify({ version: 2, roots: { data: relocated } }));
    await expect(
      resolvePiDesktopSessionsDir({ env: {}, homeDir: home, appDataDir: appData }),
    ).resolves.toBe(path.join(home, ".pi-desktop", "sessions"));

    await writeFile(preference, JSON.stringify({ version: 1, roots: { data: "relative/data" } }));
    await expect(
      resolvePiDesktopSessionsDir({ env: {}, homeDir: home, appDataDir: appData }),
    ).resolves.toBe(path.join(home, ".pi-desktop", "sessions"));
  });
});
