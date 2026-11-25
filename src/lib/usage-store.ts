import "server-only";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUILTIN_MODEL_PRICING } from "@/lib/model-pricing-seed";
import {
  calculateUsageCost,
  findModelPricing,
  validatePricingEntry,
  normalizePricingEntry,
  parseModelPricing,
  type ModelPricingInfo,
} from "@/lib/model-pricing";
import {
  deleteModelPricingInFile,
  readModelPricingFile,
  updateModelPricingInFile,
} from "@/lib/model-pricing-file";
import {
  buildRecordsPage,
  buildStatsView,
  buildUsageView,
  findAllUsageRecords,
  findUsageRecord,
  mapRecordRow,
  type RecordRow,
} from "@/lib/usage-query";
import {
  HARNESS_OPTIONS,
  type HarnessId,
  type UsageQueryFilters,
  type UsageRecord,
  type UsageRecordsPage,
  type UsageResponse,
  type UsageSnapshotResponse,
  type UsageSource,
  type UsageStatsView,
  type UsageSyncPhase,
  type UsageSyncStatus,
  type UsageView,
} from "@/lib/usage";

const SCHEMA_VERSION = 5;
const APPLICATION_ID = 0x59545031; // "YTP1"，防止误打开其他应用的 SQLite 文件。
const DEFAULT_DATABASE_PATH = path.join(".data", "usage.sqlite");
const INTERRUPTED_SYNC_ERROR = "上次同步在服务重启时中断；已保留最后成功快照。";

interface UsageStoreOptions {
  recoverInterruptedSync?: boolean;
}

interface StatusRow {
  phase: UsageSyncPhase;
  revision: number;
  has_snapshot: number;
  started_at: number | null;
  synced_at: number | null;
  duration_ms: number | null;
  error: string | null;
  record_count: number;
}

interface SnapshotRow {
  response_json: string;
  revision: number;
}

export interface UsageCommitResult {
  revision: number;
  changed: boolean;
  recordCount: number;
  syncedAt: number;
}

export interface UsageSessionLogState {
  harness: HarnessId;
  filePath: string;
  fileSize: number;
  mtimeMs: number;
  cursorOffset: number;
  parserStateJson: string | null;
  tailFingerprint: string | null;
  lastError: string | null;
  updatedAt: number;
}

/** 增量 reader 的游标必须与对应快照、记录和去重账本在同一事务提交。 */
export interface UsageIncrementalCommit {
  harness: HarnessId;
  /** 文件删除、重写或非法边界后来源级重建，清理已经失效的文件游标。 */
  resetCursors: boolean;
  /** 来源级全量重建会重新执行当轮全局去重，可安全重置该来源的历史账本。 */
  resetDedup: boolean;
  cursors: UsageSessionLogState[];
}

function toStatus(row: StatusRow): UsageSyncStatus {
  return {
    phase: row.phase,
    revision: row.revision,
    hasSnapshot: row.has_snapshot === 1,
    startedAt: row.started_at,
    syncedAt: row.synced_at,
    durationMs: row.duration_ms,
    error: row.error,
    recordCount: row.record_count,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nullableNumber(value: number | undefined): number | null {
  return value === undefined ? null : value;
}

function snapshotContent(usage: UsageResponse): string {
  const costFields = new Set([
    "pricingModel", "hasCost", "inputCostUsd", "outputCostUsd",
    "cacheReadCostUsd", "cacheCreationCostUsd", "totalCostUsd",
  ]);
  const records = usage.records.map((record) => Object.fromEntries(
    Object.entries(record).filter(([key]) => !costFields.has(key)),
  ));
  return JSON.stringify({
    records,
    sources: usage.sources,
    scannedFiles: usage.scannedFiles,
    skippedFiles: usage.skippedFiles,
  });
}

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new Error(`用量记录包含非有限数值 ${field}: ${value}`);
}

function assertSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`用量记录包含非安全整数 ${field}: ${value}`);
}

function validateUsageForStorage(usage: UsageResponse): void {
  assertSafeInteger(usage.syncedAt, "syncedAt");
  assertSafeInteger(usage.scannedFiles, "scannedFiles");
  assertSafeInteger(usage.skippedFiles, "skippedFiles");
  for (const record of usage.records) {
    for (const [field, value] of Object.entries({
      timestamp: record.timestamp,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheCreationTokens: record.cacheCreationTokens,
      cacheCreation1hTokens: record.cacheCreation1hTokens ?? 0,
      totalTokens: record.totalTokens,
    })) {
      assertSafeInteger(value, `${record.id}.${field}`);
    }
    assertFinite(record.credits, `${record.id}.credits`);
    for (const value of [
      record.reportedCredits,
      record.contextUsageRatio,
      record.estimatedDurationMs,
      record.firstTokenMs,
      record.inputCostUsd,
      record.outputCostUsd,
      record.cacheReadCostUsd,
      record.cacheCreationCostUsd,
      record.totalCostUsd,
    ]) {
      if (value !== undefined) assertFinite(value, record.id);
    }
  }
  for (const source of usage.sources) {
    assertSafeInteger(source.recordCount, `${source.harness}.recordCount`);
    assertSafeInteger(source.scannedFiles, `${source.harness}.scannedFiles`);
    assertSafeInteger(source.skippedFiles, `${source.harness}.skippedFiles`);
  }
}

/**
 * 本地用量数据库。扫描结果由 worker 按一个明确批次原子提交；查询连接只读取
 * 已提交快照，因此失败或进行中的同步不会破坏最后成功数据。
 */
export class UsageStore {
  private readonly db: DatabaseSync;
  readonly databasePath: string;

  constructor(
    databasePath: string,
    { recoverInterruptedSync = true }: UsageStoreOptions = {},
  ) {
    this.databasePath = databasePath;
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }

    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath);
      this.db = database;
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      this.migrate();
      // 先验证/迁移再切换持久 journal mode，拒绝未知库时不产生 WAL 副作用。
      if (databasePath !== ":memory:") {
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      }
      if (recoverInterruptedSync) this.recoverInterruptedSync();
      this.initializeModelPricing();
    } catch (error) {
      database?.close();
      throw new Error(`无法初始化用量数据库 ${databasePath}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const existing = this.db
      .prepare("SELECT 1 AS found FROM pragma_table_info(?) WHERE name = ?")
      .get(table, column) as { found: number } | undefined;
    if (existing === undefined) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private createModelPricingTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_pricing (
        model_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        input_cost_per_million TEXT NOT NULL,
        output_cost_per_million TEXT NOT NULL,
        cache_read_cost_per_million TEXT NOT NULL,
        cache_creation_cost_per_million TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  private migrate(): void {
    let { user_version: version } = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version > SCHEMA_VERSION) {
      throw new Error(`数据库 schema 版本 ${version} 高于当前支持版本 ${SCHEMA_VERSION}`);
    }
    const { application_id: applicationId } = this.db
      .prepare("PRAGMA application_id")
      .get() as { application_id: number };
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
      throw new Error(`数据库 application_id ${applicationId} 不属于 Y Token Panel`);
    }
    if (version === SCHEMA_VERSION) {
      if (applicationId !== APPLICATION_ID) throw new Error("用量数据库缺少 application_id");
      this.validateSchema();
      return;
    }
    if (applicationId === 0) {
      const existing = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
        .get();
      if (existing) throw new Error("拒绝在未标记的既有 SQLite 数据库上执行用量迁移");
    }

    // v1/v2 → v3：v1 先补 v2 的外键索引；usage_records 增加 first_token_ms。
    // 增量 reader 只有在重扫文件时才会填充该列，清空全部文件游标触发一次
    // 来源级重建（下一轮 sync 全量重读）。
    if (version === 1 || version === 2) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (version === 1) {
          this.db.exec(
            "CREATE INDEX IF NOT EXISTS idx_usage_dedup_record_row_id ON usage_dedup(record_row_id)",
          );
        }
        // 降级复测等场景下列可能已存在；重复 ALTER 会报错，先查再补。
        const hasFirstTokenColumn = this.db
          .prepare("SELECT 1 FROM pragma_table_info('usage_records') WHERE name = 'first_token_ms'")
          .get();
        if (hasFirstTokenColumn === undefined) {
          this.db.exec("ALTER TABLE usage_records ADD COLUMN first_token_ms REAL");
        }
        this.db.exec("DELETE FROM session_log_sync");
        this.db.exec(
          `INSERT INTO usage_schema_migrations (version, applied_at)
           VALUES (3, ${Date.now()})
           ON CONFLICT(version) DO NOTHING`,
        );
        this.db.exec("PRAGMA user_version = 3");
        this.db.exec("COMMIT");
        version = 3;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw new Error(`用量数据库迁移到 v3 失败，已回滚: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    }

    // v3 → v4：KCode 解析新增第三方 provider 归属（llm.request.modelAlias 前缀
    // 区分 managed 与第三方，model/provider 标签随之改变）。增量 reader 只在
    // 重扫 wire 文件时才产出新标签，清空 kcode 文件游标触发一次 kcode 来源级
    // 重建，其他 harness 的游标原样保留。
    if (version === 3) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("DELETE FROM session_log_sync WHERE harness = 'kcode'");
        this.db.exec(
          `INSERT INTO usage_schema_migrations (version, applied_at)
           VALUES (4, ${Date.now()})
           ON CONFLICT(version) DO NOTHING`,
        );
        this.db.exec("PRAGMA user_version = 4");
        this.db.exec("COMMIT");
        version = 4;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw new Error(`用量数据库迁移到 v4 失败，已回滚: ${errorMessage(error)}`, {
          cause: error,
        });
      }
    }

    // v4 → v5：新增本地模型价格表、请求成本列与 Claude 1 小时缓存写入子集。
    // Claude / Devin 需要重扫才能补出 1h 缓存字段；其余 Harness 的成本可直接
    // 由已有 Token 列回填，不需要重读原始日志。
    if (version === 4) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.addColumnIfMissing("usage_records", "cache_creation_1h_tokens", "INTEGER NOT NULL DEFAULT 0");
        this.addColumnIfMissing("usage_records", "pricing_model", "TEXT");
        this.addColumnIfMissing("usage_records", "input_cost_usd", "REAL");
        this.addColumnIfMissing("usage_records", "output_cost_usd", "REAL");
        this.addColumnIfMissing("usage_records", "cache_read_cost_usd", "REAL");
        this.addColumnIfMissing("usage_records", "cache_creation_cost_usd", "REAL");
        this.addColumnIfMissing("usage_records", "total_cost_usd", "REAL");
        this.createModelPricingTable();
        this.db.exec("DELETE FROM session_log_sync WHERE harness IN ('claude', 'devin')");
        this.db.exec(
          `INSERT INTO usage_schema_migrations (version, applied_at)
           VALUES (5, ${Date.now()})
           ON CONFLICT(version) DO NOTHING`,
        );
        this.db.exec("PRAGMA user_version = 5");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw new Error(`用量数据库迁移到 v5 失败，已回滚: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      this.validateSchema();
      return;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS usage_schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS usage_records (
          id INTEGER PRIMARY KEY,
          record_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          harness TEXT NOT NULL,
          project TEXT NOT NULL,
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          timestamp_ms INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          cache_creation_tokens INTEGER NOT NULL,
          cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL,
          input_token_semantics TEXT NOT NULL
            CHECK (input_token_semantics IN ('fresh', 'total')),
          has_token_usage INTEGER NOT NULL CHECK (has_token_usage IN (0, 1)),
          credits REAL NOT NULL,
          has_credit INTEGER NOT NULL CHECK (has_credit IN (0, 1)),
          reported_credits REAL,
          billable INTEGER CHECK (billable IN (0, 1) OR billable IS NULL),
          context_usage_ratio REAL,
          estimated_duration_ms REAL,
          first_token_ms REAL,
          pricing_model TEXT,
          input_cost_usd REAL,
          output_cost_usd REAL,
          cache_read_cost_usd REAL,
          cache_creation_cost_usd REAL,
          total_cost_usd REAL,
          status TEXT NOT NULL CHECK (status IN ('success', 'error')),
          UNIQUE (harness, record_id)
        );

        CREATE INDEX IF NOT EXISTS idx_usage_records_timestamp
          ON usage_records(timestamp_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_records_harness_timestamp
          ON usage_records(harness, timestamp_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_usage_records_project
          ON usage_records(project);
        CREATE INDEX IF NOT EXISTS idx_usage_records_provider_model
          ON usage_records(provider, model);
        CREATE INDEX IF NOT EXISTS idx_usage_records_record_id
          ON usage_records(harness, record_id);

        CREATE TABLE IF NOT EXISTS model_pricing (
          model_id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          input_cost_per_million TEXT NOT NULL,
          output_cost_per_million TEXT NOT NULL,
          cache_read_cost_per_million TEXT NOT NULL,
          cache_creation_cost_per_million TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS usage_sources (
          harness TEXT PRIMARY KEY,
          record_count INTEGER NOT NULL,
          scanned_files INTEGER NOT NULL,
          skipped_files INTEGER NOT NULL,
          source TEXT NOT NULL,
          source_available INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session_log_sync (
          harness TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          mtime_ms REAL,
          cursor_offset INTEGER,
          parser_state_json TEXT,
          tail_fingerprint TEXT,
          last_error TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (harness, file_path)
        );

        CREATE TABLE IF NOT EXISTS usage_dedup (
          harness TEXT NOT NULL,
          dedup_key TEXT NOT NULL,
          record_row_id INTEGER,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (harness, dedup_key),
          FOREIGN KEY (record_row_id) REFERENCES usage_records(id) ON DELETE SET NULL
        );

        -- v2：ON DELETE SET NULL 必须按 record_row_id 定位，避免全量替换退化为 O(n²)。
        CREATE INDEX IF NOT EXISTS idx_usage_dedup_record_row_id
          ON usage_dedup(record_row_id);

        CREATE TABLE IF NOT EXISTS usage_snapshots (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS usage_sync_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          phase TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          has_snapshot INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER,
          synced_at INTEGER,
          duration_ms INTEGER,
          error TEXT,
          record_count INTEGER NOT NULL DEFAULT 0
        );

        INSERT INTO usage_sync_state (
          id, phase, revision, has_snapshot, record_count
        ) VALUES (1, 'empty', 0, 0, 0)
        ON CONFLICT(id) DO NOTHING;

        INSERT INTO usage_schema_migrations (version, applied_at)
        VALUES (${SCHEMA_VERSION}, ${Date.now()})
        ON CONFLICT(version) DO NOTHING;
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      this.validateSchema();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw new Error(`用量数据库迁移失败，已回滚: ${errorMessage(error)}`, { cause: error });
    }
  }

  private validateSchema(): void {
    const requiredColumns: Record<string, string[]> = {
      usage_schema_migrations: ["version", "applied_at"],
      usage_records: [
        "id", "record_id", "request_id", "session_id", "harness", "project",
        "model", "provider", "timestamp_ms", "input_tokens", "output_tokens",
        "cache_read_tokens", "cache_creation_tokens", "cache_creation_1h_tokens", "total_tokens",
        "input_token_semantics", "has_token_usage", "credits", "has_credit",
        "reported_credits", "billable", "context_usage_ratio", "estimated_duration_ms",
        "first_token_ms", "pricing_model", "input_cost_usd", "output_cost_usd",
        "cache_read_cost_usd", "cache_creation_cost_usd", "total_cost_usd", "status",
      ],
      model_pricing: [
        "model_id", "display_name", "input_cost_per_million", "output_cost_per_million",
        "cache_read_cost_per_million", "cache_creation_cost_per_million", "updated_at",
      ],
      usage_sources: [
        "harness", "record_count", "scanned_files", "skipped_files", "source",
        "source_available",
      ],
      session_log_sync: [
        "harness", "file_path", "file_size", "mtime_ms", "cursor_offset",
        "parser_state_json", "tail_fingerprint", "last_error", "updated_at",
      ],
      usage_dedup: ["harness", "dedup_key", "record_row_id", "created_at"],
      usage_snapshots: ["id", "revision", "content_hash", "response_json", "updated_at"],
      usage_sync_state: [
        "id", "phase", "revision", "has_snapshot", "started_at", "synced_at",
        "duration_ms", "error", "record_count",
      ],
    };
    for (const [table, required] of Object.entries(requiredColumns)) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
        name: string;
      }>;
      const names = new Set(columns.map((column) => column.name));
      if (required.some((column) => !names.has(column))) {
        throw new Error(`用量数据库 schema 不完整（${table}），请保留原库并检查迁移日志`);
      }
    }

    const dedupIndex = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_dedup_record_row_id'")
      .get();
    if (!dedupIndex) throw new Error("用量数据库缺少 dedup 外键索引（schema v2）");

    const state = this.db
      .prepare("SELECT revision, has_snapshot FROM usage_sync_state WHERE id = 1")
      .get() as unknown as { revision: number; has_snapshot: number } | undefined;
    const snapshot = this.db
      .prepare("SELECT revision FROM usage_snapshots WHERE id = 1")
      .get() as unknown as { revision: number } | undefined;
    if (!state || Boolean(state.has_snapshot) !== Boolean(snapshot)) {
      throw new Error("用量数据库快照状态不一致，请保留原库并检查迁移日志");
    }
    if (snapshot && state.revision !== snapshot.revision) {
      throw new Error("用量数据库快照 revision 不一致，请保留原库并检查迁移日志");
    }
  }

  private recoverInterruptedSync(): void {
    this.db
      .prepare(
        `UPDATE usage_sync_state
         SET phase = 'error', error = ?, duration_ms = NULL
         WHERE phase = 'importing'`,
      )
      .run(INTERRUPTED_SYNC_ERROR);
  }

  private static toPricingInfo(row: {
    model_id: string;
    display_name: string;
    input_cost_per_million: string;
    output_cost_per_million: string;
    cache_read_cost_per_million: string;
    cache_creation_cost_per_million: string;
  }): ModelPricingInfo {
    return {
      modelId: row.model_id,
      displayName: row.display_name,
      inputCostPerMillion: row.input_cost_per_million,
      outputCostPerMillion: row.output_cost_per_million,
      cacheReadCostPerMillion: row.cache_read_cost_per_million,
      cacheCreationCostPerMillion: row.cache_creation_cost_per_million,
    };
  }

  private pricingRows(): ModelPricingInfo[] {
    const rows = this.db
      .prepare("SELECT * FROM model_pricing ORDER BY model_id")
      .all() as unknown as Array<Parameters<typeof UsageStore.toPricingInfo>[0]>;
    return rows.map((row) => UsageStore.toPricingInfo(row));
  }

  private upsertPricingRow(entry: ModelPricingInfo, now = Date.now()): number {
    const result = this.db
      .prepare(
        `INSERT INTO model_pricing (
          model_id, display_name, input_cost_per_million, output_cost_per_million,
          cache_read_cost_per_million, cache_creation_cost_per_million, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(model_id) DO UPDATE SET
          display_name = excluded.display_name,
          input_cost_per_million = excluded.input_cost_per_million,
          output_cost_per_million = excluded.output_cost_per_million,
          cache_read_cost_per_million = excluded.cache_read_cost_per_million,
          cache_creation_cost_per_million = excluded.cache_creation_cost_per_million,
          updated_at = excluded.updated_at
        WHERE display_name <> excluded.display_name
           OR input_cost_per_million <> excluded.input_cost_per_million
           OR output_cost_per_million <> excluded.output_cost_per_million
           OR cache_read_cost_per_million <> excluded.cache_read_cost_per_million
           OR cache_creation_cost_per_million <> excluded.cache_creation_cost_per_million`,
      )
      .run(
        entry.modelId,
        entry.displayName,
        entry.inputCostPerMillion,
        entry.outputCostPerMillion,
        entry.cacheReadCostPerMillion,
        entry.cacheCreationCostPerMillion,
        now,
      );
    return Number(result.changes);
  }

  /** 启动时 seed 内置价目并应用本地覆盖；覆盖文件只存用户/models.dev 显式覆盖与删除 tombstone。 */
  private initializeModelPricing(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const seed = this.db.prepare(
        `INSERT OR IGNORE INTO model_pricing (
          model_id, display_name, input_cost_per_million, output_cost_per_million,
          cache_read_cost_per_million, cache_creation_cost_per_million, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      );
      for (const entry of BUILTIN_MODEL_PRICING) {
        seed.run(
          entry.modelId,
          entry.displayName,
          entry.inputCostPerMillion,
          entry.outputCostPerMillion,
          entry.cacheReadCostPerMillion,
          entry.cacheCreationCostPerMillion,
        );
      }

      const file = readModelPricingFile();
      for (const entry of file.models) this.upsertPricingRow(entry);
      for (const modelId of file.deletedModelIds) {
        this.db.prepare("DELETE FROM model_pricing WHERE model_id = ?").run(modelId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.backfillMissingUsageCosts();
  }

  /** 只回填尚未定价的历史记录；已有非空成本不随价格修改重算（cc-switch 口径）。 */
  backfillMissingUsageCosts(): number {
    const rows = this.db
      .prepare(
        `SELECT id, model, input_tokens, output_tokens, cache_read_tokens,
          cache_creation_tokens, cache_creation_1h_tokens, input_token_semantics
         FROM usage_records
         WHERE total_cost_usd IS NULL`,
      )
      .all() as unknown as Array<{
      id: number;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cache_creation_1h_tokens: number;
      input_token_semantics: "fresh" | "total";
    }>;
    if (rows.length === 0) return 0;
    const pricing = this.pricingRows();
    if (pricing.length === 0) return 0;

    let updated = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(
        `UPDATE usage_records SET
          pricing_model = ?, input_cost_usd = ?, output_cost_usd = ?,
          cache_read_cost_usd = ?, cache_creation_cost_usd = ?, total_cost_usd = ?
         WHERE id = ?`,
      );
      for (const row of rows) {
        const match = findModelPricing(pricing, row.model);
        if (!match) continue;
        const parsed = parseModelPricing(match.pricing);
        if (!parsed) continue;
        const cost = calculateUsageCost({
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          cacheReadTokens: row.cache_read_tokens,
          cacheCreationTokens: row.cache_creation_tokens,
          cacheCreation1hTokens: row.cache_creation_1h_tokens,
          inputTokenSemantics: row.input_token_semantics,
        }, parsed);
        update.run(
          match.matchedModelId,
          cost.inputCostUsd,
          cost.outputCostUsd,
          cost.cacheReadCostUsd,
          cost.cacheCreationCostUsd,
          cost.totalCostUsd,
          row.id,
        );
        updated += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return updated;
  }

  /** 应用用户覆盖文件的新外部修改；不重建文件，也不把完整内置表导出为覆盖。 */
  syncLocalModelPricing(): { upserted: number; deleted: number } {
    const file = readModelPricingFile();
    let upserted = 0;
    let deleted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of file.models) upserted += this.upsertPricingRow(entry);
      for (const modelId of file.deletedModelIds) {
        deleted += Number(
          this.db.prepare("DELETE FROM model_pricing WHERE model_id = ?").run(modelId).changes,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (upserted > 0) this.backfillMissingUsageCosts();
    return { upserted, deleted };
  }

  listModelPricing(): ModelPricingInfo[] {
    this.syncLocalModelPricing();
    return this.pricingRows();
  }

  updateModelPricing(entryInput: ModelPricingInfo): number {
    return this.updateModelPricingBatch([entryInput]);
  }

  /** 批量 upsert（用户编辑与 models.dev 同步共用）；返回数据库中实际发生变化的行数。 */
  updateModelPricingBatch(entriesInput: ModelPricingInfo[]): number {
    const entries = new Map<string, ModelPricingInfo>();
    for (const input of entriesInput) {
      const entry = normalizePricingEntry(input);
      const error = validatePricingEntry(entry);
      if (error) throw new Error(error);
      entries.set(entry.modelId, entry);
    }
    if (entries.size === 0) return 0;
    const values = Array.from(entries.values());

    this.syncLocalModelPricing();
    let changed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of values) changed += this.upsertPricingRow(entry);
      // 覆盖文件只写显式导入/编辑的模型，并清除对应删除 tombstone。
      updateModelPricingInFile(values);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (changed > 0) this.backfillMissingUsageCosts();
    return changed;
  }

  deleteModelPricing(modelId: string): void {
    const trimmed = modelId.trim();
    if (!trimmed) throw new Error("模型 ID 不能为空");
    this.syncLocalModelPricing();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM model_pricing WHERE model_id = ?").run(trimmed);
      deleteModelPricingInFile(trimmed);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 扫描输出写入快照前计算成本；价格缺失时保留 undefined，后续同步价格可回填。 */
  private enrichUsageWithCosts(usage: UsageResponse): UsageResponse {
    const pricing = this.pricingRows();
    if (pricing.length === 0) return usage;
    return {
      ...usage,
      records: usage.records.map((record) => {
        const match = findModelPricing(pricing, record.model);
        if (!match) return record;
        const parsed = parseModelPricing(match.pricing);
        if (!parsed) return record;
        const cost = calculateUsageCost(record, parsed);
        return {
          ...record,
          pricingModel: match.matchedModelId,
          inputCostUsd: cost.inputCostUsd,
          outputCostUsd: cost.outputCostUsd,
          cacheReadCostUsd: cost.cacheReadCostUsd,
          cacheCreationCostUsd: cost.cacheCreationCostUsd,
          totalCostUsd: cost.totalCostUsd,
          hasCost: true,
        };
      }),
    };
  }

  private statusRow(): StatusRow {
    return this.db
      .prepare("SELECT * FROM usage_sync_state WHERE id = 1")
      .get() as unknown as StatusRow;
  }

  getStatus(): UsageSyncStatus {
    return toStatus(this.statusRow());
  }

  getSnapshotDocument(): { json: string; revision: number } | null {
    const row = this.db
      .prepare("SELECT response_json, revision FROM usage_snapshots WHERE id = 1")
      .get() as unknown as SnapshotRow | undefined;
    return row ? { json: row.response_json, revision: row.revision } : null;
  }

  getSnapshotJson(): string | null {
    return this.getSnapshotDocument()?.json ?? null;
  }

  getSnapshot(): UsageSnapshotResponse | null {
    const json = this.getSnapshotJson();
    return json === null ? null : (JSON.parse(json) as UsageSnapshotResponse);
  }

  getEmptySnapshot(): UsageSnapshotResponse {
    const sync = this.getStatus();
    return {
      records: [],
      sources: [],
      scannedFiles: 0,
      skippedFiles: 0,
      syncedAt: sync.syncedAt ?? 0,
      revision: sync.revision,
      snapshotAvailable: false,
      sync,
    };
  }

  markSyncStarted(now = Date.now()): UsageSyncStatus {
    this.db
      .prepare(
        `UPDATE usage_sync_state
         SET phase = 'importing', started_at = ?, duration_ms = NULL, error = NULL
         WHERE id = 1`,
      )
      .run(now);
    return this.getStatus();
  }

  markSyncFailed(error: unknown, now = Date.now()): UsageSyncStatus {
    const current = this.statusRow();
    const durationMs = current.started_at === null ? null : Math.max(0, now - current.started_at);
    this.db
      .prepare(
        `UPDATE usage_sync_state
         SET phase = 'error', duration_ms = ?, error = ?
         WHERE id = 1`,
      )
      .run(durationMs, errorMessage(error));
    return this.getStatus();
  }

  getSessionLogStates(harness: HarnessId): UsageSessionLogState[] {
    const rows = this.db
      .prepare("SELECT * FROM session_log_sync WHERE harness = ? ORDER BY file_path")
      .all(harness) as unknown as Array<{
      harness: HarnessId;
      file_path: string;
      file_size: number;
      mtime_ms: number;
      cursor_offset: number;
      parser_state_json: string | null;
      tail_fingerprint: string | null;
      last_error: string | null;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      harness: row.harness,
      filePath: row.file_path,
      fileSize: row.file_size,
      mtimeMs: row.mtime_ms,
      cursorOffset: row.cursor_offset,
      parserStateJson: row.parser_state_json,
      tailFingerprint: row.tail_fingerprint,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    }));
  }

  /** 上次成功提交的各来源摘要；单来源同步失败时用于保留其最后成功数据（M5）。 */
  getSourceRows(): Map<HarnessId, {
    recordCount: number;
    scannedFiles: number;
    skippedFiles: number;
    source: string;
    sourceAvailable: boolean;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM usage_sources")
      .all() as unknown as Array<{
      harness: HarnessId;
      record_count: number;
      scanned_files: number;
      skipped_files: number;
      source: string;
      source_available: number;
    }>;
    return new Map(
      rows.map((row) => [
        row.harness,
        {
          recordCount: row.record_count,
          scannedFiles: row.scanned_files,
          skippedFiles: row.skipped_files,
          source: row.source,
          sourceAvailable: row.source_available === 1,
        },
      ]),
    );
  }

  getDedupKeys(harness: HarnessId): string[] {
    return (
      this.db
        .prepare("SELECT dedup_key FROM usage_dedup WHERE harness = ?")
        .all(harness) as unknown as Array<{ dedup_key: string }>
    ).map((row) => row.dedup_key);
  }

  commitSnapshot(
    usage: UsageResponse,
    now = Date.now(),
    incrementals: UsageIncrementalCommit[] = [],
  ): UsageCommitResult {
    validateUsageForStorage(usage);
    // 内容代次只代表扫描器采集到的用量本身；价格目录变化不能伪装成用量变化。
    const contentHash = createHash("sha256").update(snapshotContent(usage)).digest("hex");
    usage = this.enrichUsageWithCosts(usage);
    validateUsageForStorage(usage);
    if (new Set(incrementals.map((incremental) => incremental.harness)).size !== incrementals.length) {
      throw new Error("同一来源出现多个增量事务批次");
    }

    // hash 在事务外计算；代次判定、响应构造和全部写入必须在同一写事务内，
    // 防止另一个连接在两条语句之间提交不同代数据。
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 来源级重建的 resetDedup 只有在该来源确有记录或账本行时才需要强制
      // 重写；来源长期不可用（如未安装）时的空 reset 不能让每轮 no-op 提交
      // 都重写全部归一化记录。
      const resetDedupHarnesses = incrementals
        .filter((incremental) => incremental.resetDedup)
        .filter((incremental) =>
          (
            this.db
              .prepare(
                `SELECT (EXISTS (SELECT 1 FROM usage_dedup WHERE harness = ?)
                        OR EXISTS (SELECT 1 FROM usage_records WHERE harness = ?)) AS has_rows`,
              )
              .get(incremental.harness, incremental.harness) as { has_rows: number }
          ).has_rows === 1,
        )
        .map((incremental) => incremental.harness);
      const previous = this.db
        .prepare("SELECT revision, content_hash FROM usage_snapshots WHERE id = 1")
        .get() as unknown as { revision: number; content_hash: string } | undefined;
      const current = this.statusRow();
      const changed = previous?.content_hash !== contentHash;
      const revision = changed ? (previous?.revision ?? 0) + 1 : (previous?.revision ?? 0);
      const durationMs = current.started_at === null ? null : Math.max(0, now - current.started_at);
      const sync: UsageSyncStatus = {
        phase: "ready",
        revision,
        hasSnapshot: true,
        startedAt: current.started_at,
        syncedAt: usage.syncedAt,
        durationMs,
        error: null,
        recordCount: usage.records.length,
      };
      const response: UsageSnapshotResponse = {
        ...usage,
        revision,
        snapshotAvailable: true,
        sync,
      };
      const responseJson = JSON.stringify(response);

      if (changed || resetDedupHarnesses.length > 0) {
        // 全量候选不经过 dedup 过滤；普通提交保留历史账本。来源级重建则明确
        // 重置该来源账本，因为被截断/重写文件中的旧键可能已不再是有效历史。
        this.db.prepare("DELETE FROM usage_records").run();
        this.db.prepare("DELETE FROM usage_sources").run();
        for (const harness of resetDedupHarnesses) {
          this.db.prepare("DELETE FROM usage_dedup WHERE harness = ?").run(harness);
        }

        const insertRecord = this.db.prepare(`
          INSERT INTO usage_records (
            record_id, request_id, session_id, harness, project, model, provider,
            timestamp_ms, input_tokens, output_tokens, cache_read_tokens,
            cache_creation_tokens, cache_creation_1h_tokens, total_tokens, input_token_semantics,
            has_token_usage, credits, has_credit, reported_credits, billable,
            context_usage_ratio, estimated_duration_ms, first_token_ms,
            pricing_model, input_cost_usd, output_cost_usd, cache_read_cost_usd,
            cache_creation_cost_usd, total_cost_usd, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertDedup = this.db.prepare(`
          INSERT INTO usage_dedup (harness, dedup_key, record_row_id, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(harness, dedup_key) DO UPDATE SET
            record_row_id = excluded.record_row_id
        `);
        for (const record of usage.records) {
          const result = insertRecord.run(
            record.id,
            record.requestId,
            record.sessionId,
            record.harness,
            record.project,
            record.model,
            record.provider,
            record.timestamp,
            record.inputTokens,
            record.outputTokens,
            record.cacheReadTokens,
            record.cacheCreationTokens,
            record.cacheCreation1hTokens ?? 0,
            record.totalTokens,
            record.inputTokenSemantics,
            record.hasTokenUsage ? 1 : 0,
            record.credits,
            record.hasCredit ? 1 : 0,
            nullableNumber(record.reportedCredits),
            record.billable === undefined ? null : record.billable ? 1 : 0,
            nullableNumber(record.contextUsageRatio),
            nullableNumber(record.estimatedDurationMs),
            nullableNumber(record.firstTokenMs),
            record.hasCost === true ? record.pricingModel ?? null : null,
            nullableNumber(record.inputCostUsd),
            nullableNumber(record.outputCostUsd),
            nullableNumber(record.cacheReadCostUsd),
            nullableNumber(record.cacheCreationCostUsd),
            nullableNumber(record.totalCostUsd),
            record.status,
          );
          insertDedup.run(record.harness, record.id, result.lastInsertRowid, now);
        }

        const insertSource = this.db.prepare(`
          INSERT INTO usage_sources (
            harness, record_count, scanned_files, skipped_files, source, source_available
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const source of usage.sources) {
          insertSource.run(
            source.harness,
            source.recordCount,
            source.scannedFiles,
            source.skippedFiles,
            source.source,
            source.sourceAvailable ? 1 : 0,
          );
        }
      }

      for (const incremental of incrementals) {
        if (incremental.resetCursors) {
          this.db.prepare("DELETE FROM session_log_sync WHERE harness = ?").run(incremental.harness);
        }
        const upsertCursor = this.db.prepare(`
          INSERT INTO session_log_sync (
            harness, file_path, file_size, mtime_ms, cursor_offset,
            parser_state_json, tail_fingerprint, last_error, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(harness, file_path) DO UPDATE SET
            file_size = excluded.file_size,
            mtime_ms = excluded.mtime_ms,
            cursor_offset = excluded.cursor_offset,
            parser_state_json = excluded.parser_state_json,
            tail_fingerprint = excluded.tail_fingerprint,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `);
        for (const cursor of incremental.cursors) {
          if (cursor.harness !== incremental.harness) {
            throw new Error("增量游标 Harness 与提交批次不一致");
          }
          for (const [field, value] of Object.entries({
            fileSize: cursor.fileSize,
            cursorOffset: cursor.cursorOffset,
          })) {
            assertSafeInteger(value, `${cursor.filePath}.${field}`);
          }
          if (cursor.fileSize < 0 || cursor.cursorOffset < 0 || cursor.cursorOffset > cursor.fileSize) {
            throw new Error(`增量游标范围非法: ${cursor.filePath}`);
          }
          upsertCursor.run(
            cursor.harness,
            cursor.filePath,
            cursor.fileSize,
            cursor.mtimeMs,
            cursor.cursorOffset,
            cursor.parserStateJson,
            cursor.tailFingerprint,
            cursor.lastError,
            now,
          );
        }
      }

      this.db
        .prepare(
          `INSERT INTO usage_snapshots (id, revision, content_hash, response_json, updated_at)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             revision = excluded.revision,
             content_hash = excluded.content_hash,
             response_json = excluded.response_json,
             updated_at = excluded.updated_at`,
        )
        .run(revision, contentHash, responseJson, now);
      this.db
        .prepare(
          `UPDATE usage_sync_state
           SET phase = 'ready', revision = ?, has_snapshot = 1, synced_at = ?,
               duration_ms = ?, error = NULL, record_count = ?
           WHERE id = 1`,
        )
        .run(revision, usage.syncedAt, durationMs, usage.records.length);
      this.db.exec("COMMIT");
      return { revision, changed, recordCount: usage.records.length, syncedAt: usage.syncedAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 供一致性与迁移测试及增量 reader 使用；GET 热路径直接读取预序列化快照。 */
  readNormalizedRecords(harness?: HarnessId): UsageRecord[] {
    const rows = (harness
      ? this.db
          .prepare("SELECT * FROM usage_records WHERE harness = ? ORDER BY timestamp_ms DESC, id ASC")
          .all(harness)
      : this.db.prepare("SELECT * FROM usage_records ORDER BY timestamp_ms DESC, id ASC").all()) as unknown as RecordRow[];
    return rows.map((row) => mapRecordRow(row));
  }

  /**
   * 服务端聚合视图（M6）。只读事务保证同轮查询读到同一提交代次，不会在两次
   * SELECT 之间混入 worker 刚提交的新 revision。
   */
  queryView(filters: UsageQueryFilters, now = new Date()): UsageView {
    return this.readTransaction(() => {
      const sources = this.sourceList();
      return buildUsageView(this.db, filters, now, {
        status: this.getStatus(),
        sources,
      });
    });
  }

  /** 统计面板聚合：按日/月桶与日×模型分桶（与视图查询同一份筛选）。 */
  queryStats(filters: UsageQueryFilters, now = new Date()): UsageStatsView {
    return this.readTransaction(() =>
      buildStatsView(this.db, filters, now, this.getStatus()),
    );
  }

  /** 请求日志分页；页大小由调用方（路由）钳制。 */
  queryRecordsPage(
    filters: UsageQueryFilters,
    page: number,
    pageSize: number,
    now = new Date(),
  ): UsageRecordsPage {
    return this.readTransaction(() =>
      buildRecordsPage(this.db, filters, page, pageSize, now, this.statusRow().revision),
    );
  }

  /** 单条请求详情按 (harness, record_id) 查询。 */
  queryRecordDetail(harness: HarnessId, recordId: string): UsageRecord | null {
    return this.readTransaction(() => findUsageRecord(this.db, harness, recordId));
  }

  /** CSV 导出用：同筛选的全部记录（仅导出路由调用，不受分页限制）。 */
  queryRecordsForExport(filters: UsageQueryFilters, now = new Date()): UsageRecord[] {
    return this.readTransaction(() => findAllUsageRecords(this.db, filters, now));
  }

  private readTransaction<T>(run: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** usage_sources 表按 HARNESS_OPTIONS 顺序输出，供视图与设置弹窗展示。 */
  private sourceList(): UsageSource[] {
    const rows = Array.from(this.getSourceRows().entries());
    const order = new Map(HARNESS_OPTIONS.map((option, index) => [option.id, index]));
    return rows
      .sort((a, b) => (order.get(a[0]) ?? order.size) - (order.get(b[0]) ?? order.size))
      .map(([harness, row]) => ({ harness, ...row }));
  }

  close(): void {
    this.db.close();
  }
}

export function getUsageDatabasePath(): string {
  return process.env.USAGE_DB_PATH
    ? path.resolve(process.env.USAGE_DB_PATH)
    : path.resolve(process.cwd(), DEFAULT_DATABASE_PATH);
}

const STORE_KEY = Symbol.for("y-token-panel.usage-store");
const globalStores = globalThis as typeof globalThis & {
  [STORE_KEY]?: UsageStore;
};

export function getUsageStore(): UsageStore {
  const existing = globalStores[STORE_KEY];
  if (existing) return existing;
  const store = new UsageStore(getUsageDatabasePath());
  globalStores[STORE_KEY] = store;
  return store;
}
