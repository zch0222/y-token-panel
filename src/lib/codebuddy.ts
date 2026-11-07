import "server-only";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseSessionFile } from "@/lib/codebuddy-session";
import { getProjectLabel, type HarnessUsage, type UsageRecord } from "@/lib/usage";

export async function readCodeBuddyUsage(): Promise<HarnessUsage> {
  const source = process.env.CODEBUDDY_DATA_DIR
    ? path.resolve(process.env.CODEBUDDY_DATA_DIR)
    : path.join(homedir(), ".codebuddy", "projects");
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let scannedFiles = 0;
  let skippedFiles = 0;

  let projects;
  try {
    projects = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        harness: "codebuddy",
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        source,
        sourceAvailable: false,
      };
    }
    throw error;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const directory = path.join(source, project.name);
    let files;
    try {
      files = await readdir(directory, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      scannedFiles += 1;
      const filePath = path.join(directory, file.name);
      try {
        const content = await readFile(filePath, "utf8");
        for (const record of parseSessionFile(
          content,
          getProjectLabel(project.name),
          file.name,
        )) {
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          records.push(record);
        }
      } catch {
        skippedFiles += 1;
      }
    }
  }

  records.sort((a, b) => b.timestamp - a.timestamp);
  return {
    harness: "codebuddy",
    records,
    scannedFiles,
    skippedFiles,
    source,
    sourceAvailable: true,
  };
}
