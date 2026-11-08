import "server-only";
import { DatabaseSync } from "node:sqlite";

/**
 * 从 Antigravity 原生会话库（<root>/conversations/<id>.db）读取每次生成的精确耗时。
 *
 * 转录（transcript.jsonl）只有秒级 created_at，没有完成时刻，无法估速度；原生库
 * 里有每个 generation 的 google.protobuf.Duration：
 * - steps.metadata 字段 20 是 GenerationReference，字段 3 是 generation 索引
 *   （proto3 默认值 0 会被省略，此时对应 gen_metadata.idx = 0）；
 * - gen_metadata.data 字段 1 是响应元数据，字段 11 = 首字等待，字段 12 = 流式
 *   时长，两者相加 = 请求起点到流结束（含首字等待），与转录相邻 step 的时间差
 *   一致。
 * 本机 5 个会话 184 条 PLANNER_RESPONSE 全部能取到该耗时。
 *
 * CHECKPOINT（step_type=23）虽然也有字段 20，但实测它指向的是**下一条**
 * generation（step 88 与 step 89 同为 gen 25），不能用来给压缩请求计时；
 * 因此只为 PLANNER_RESPONSE（step_type=15）读取耗时。
 *
 * 库被占用、schema 不同或数据损坏时返回空表，不影响用量导入。
 */

const PLANNER_STEP_TYPE = 15;

/** protobuf varint；超出安全整数直接放弃，不静默截断。 */
function readVarint(buffer: Buffer, offset: number): { value: number; offset: number } | null {
  let value = 0;
  let scale = 1;
  let index = offset;
  while (index < buffer.length) {
    const byte = buffer[index]!;
    index += 1;
    value += (byte & 0x7f) * scale;
    if (!Number.isSafeInteger(value)) return null;
    if ((byte & 0x80) === 0) return { value, offset: index };
    scale *= 128;
    if (!Number.isSafeInteger(scale)) return null;
  }
  return null;
}

interface ProtoField {
  number: number;
  wireType: number;
  value: number | Buffer;
}

/** 只解析当前层，未知 wire type 立即放弃（宁可没有耗时，也不猜）。 */
function readFields(buffer: Buffer): ProtoField[] | null {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    if (!key) return null;
    offset = key.offset;
    const number = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (number <= 0) return null;
    if (wireType === 0) {
      const raw = readVarint(buffer, offset);
      if (!raw) return null;
      offset = raw.offset;
      fields.push({ number, wireType, value: raw.value });
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset);
      if (!length) return null;
      offset = length.offset;
      const size = length.value;
      if (offset + size > buffer.length) return null;
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + size) });
      offset += size;
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) return null;
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) return null;
      fields.push({ number, wireType, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      return null;
    }
  }
  return fields;
}

/** node:sqlite 的 BLOB 是 Uint8Array；统一成 Buffer 供解析器使用。 */
function asBuffer(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function firstMessage(buffer: Buffer, fieldNumber: number): Buffer | undefined {
  const fields = readFields(buffer);
  if (!fields) return undefined;
  return fields.find(
    (field) => field.number === fieldNumber && field.wireType === 2,
  )?.value as Buffer | undefined;
}

/** google.protobuf.Duration → 毫秒；负数或损坏返回 undefined。 */
function durationMillis(buffer: Buffer): number | undefined {
  const fields = readFields(buffer);
  if (!fields) return undefined;
  const seconds = fields.find(
    (field) => field.number === 1 && field.wireType === 0,
  )?.value as number | undefined;
  const nanos = fields.find(
    (field) => field.number === 2 && field.wireType === 0,
  )?.value as number | undefined;
  const totalSeconds = seconds ?? 0;
  const totalNanos = nanos ?? 0;
  if (totalSeconds < 0 || totalNanos < 0) return undefined;
  const millis = totalSeconds * 1000 + Math.floor(totalNanos / 1_000_000);
  return Number.isSafeInteger(millis) ? millis : undefined;
}

/** steps.metadata → generation 索引；字段缺失表示 proto3 默认值 0。 */
function generationIndex(metadata: Buffer): number | undefined {
  const reference = firstMessage(metadata, 20);
  if (!reference) return undefined;
  const fields = readFields(reference);
  if (!fields) return undefined;
  const field = fields.find(
    (candidate) => candidate.number === 3 && candidate.wireType === 0,
  );
  return field ? (field.value as number) : 0;
}

/** gen_metadata.data → 首字等待 + 流式时长（毫秒）。 */
function generationDuration(data: Buffer): number | undefined {
  const response = firstMessage(data, 1);
  if (!response) return undefined;
  const firstToken = firstMessage(response, 11);
  const streaming = firstMessage(response, 12);
  if (!firstToken || !streaming) return undefined;
  const first = durationMillis(firstToken);
  const rest = durationMillis(streaming);
  if (first === undefined || rest === undefined) return undefined;
  const total = first + rest;
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}

/** 单个会话库的 step 索引 → 精确耗时（毫秒）；打不开或解析失败返回空表。 */
export function readGenerationTimings(dbPath: string): Map<number, number> {
  const timings = new Map<number, number>();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return timings;
  }

  try {
    const steps = db
      .prepare("SELECT idx, metadata FROM steps WHERE step_type = ?")
      .all(PLANNER_STEP_TYPE) as unknown as Array<{ idx?: unknown; metadata?: unknown }>;
    const generations = new Map<number, number | undefined>();
    const generationQuery = db.prepare("SELECT data FROM gen_metadata WHERE idx = ?");

    for (const step of steps) {
      if (typeof step.idx !== "number" || !Number.isSafeInteger(step.idx)) continue;
      const metadata = asBuffer(step.metadata);
      if (!metadata) continue;
      const generation = generationIndex(metadata);
      if (generation === undefined) continue;

      if (!generations.has(generation)) {
        let duration: number | undefined;
        try {
          const row = generationQuery.get(generation) as { data?: unknown } | undefined;
          const data = asBuffer(row?.data);
          if (data) duration = generationDuration(data);
        } catch {
          duration = undefined;
        }
        generations.set(generation, duration);
      }
      const duration = generations.get(generation);
      if (duration !== undefined) timings.set(step.idx, duration);
    }
  } catch {
    // 库被占用、表结构不同或数据损坏：不提供耗时，用量照常。
  } finally {
    try {
      db.close();
    } catch {
      // 忽略关闭失败。
    }
  }

  return timings;
}
