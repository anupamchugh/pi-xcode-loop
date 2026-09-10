import { open, stat } from "node:fs/promises";
export const DEFAULT_MAX_BYTES = 1_000_000;
export const DEFAULT_MAX_LINES = 20_000;
const recognized = new Set(["turn_started", "task_started", "task_complete", "completed", "success", "cancelled", "aborted", "error", "protocol_error", "protocol_failure", "test_summary", "test_results"]);
export interface SessionEvents { lastEvent?: string; completed: boolean; failed: boolean; cancelled: boolean; protocolError: boolean; malformedLines: number; truncated: boolean; diagnostics: string[]; testHint?: { executed: number; failed: number } | undefined; }
function count(value: unknown): number | undefined { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function initial(): SessionEvents { return { completed: false, failed: false, cancelled: false, protocolError: false, malformedLines: 0, truncated: false, diagnostics: [] }; }
export function parseSessionLog(input: string, maxLines = DEFAULT_MAX_LINES): SessionEvents {
  const result = initial(); let lines = 0; let offset = 0;
  while (offset <= input.length && lines < maxLines) {
    const end = input.indexOf("\n", offset); const raw = input.slice(offset, end < 0 ? input.length : end); offset = end < 0 ? input.length + 1 : end + 1; lines++;
    const line = (raw.endsWith("\r") ? raw.slice(0, -1) : raw).trim(); if (!line) continue;
    let value: unknown; try { value = JSON.parse(line); } catch { result.malformedLines++; continue; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { result.malformedLines++; continue; }
    const record = value as Record<string, unknown>; const eventValue = record.event ?? record.type ?? record.kind;
    if (typeof eventValue !== "string") continue; const event = eventValue.toLowerCase(); if (!recognized.has(event)) continue;
    result.lastEvent = event;
    if (event === "turn_started" || event === "task_started") { result.completed = false; result.failed = false; result.cancelled = false; result.protocolError = false; result.testHint = undefined; continue; }
    if (event === "task_complete" || event === "completed" || event === "success") result.completed = true;
    if (event === "cancelled" || event === "aborted") result.cancelled = true;
    if (event === "error" || event === "protocol_error" || event === "protocol_failure") { result.failed = true; result.protocolError = event !== "error"; }
    if (event === "test_summary" || event === "test_results") {
      const tests = record.tests && typeof record.tests === "object" && !Array.isArray(record.tests) ? record.tests as Record<string, unknown> : record;
      const executed = count(tests.executed ?? tests.totalTestCount ?? tests.testCount); const failed = count(tests.failed ?? tests.failedTestCount ?? tests.failureCount);
      if (executed !== undefined && failed !== undefined && failed <= executed) result.testHint = { executed, failed }; else result.malformedLines++;
    }
  }
  if (offset <= input.length) result.truncated = true;
  if (result.malformedLines) result.diagnostics.push(`${result.malformedLines} malformed log line(s)`);
  if (result.truncated) result.diagnostics.push("session log exceeded bound");
  return result;
}
export async function readSessionLog(path: string, maxBytes = DEFAULT_MAX_BYTES): Promise<SessionEvents> {
  try { const info = await stat(path); if (!info.isFile()) throw new Error("session path is not a regular file"); const handle = await open(path, "r"); try { const buffer = Buffer.allocUnsafe(maxBytes + 1); const read = await handle.read(buffer, 0, maxBytes + 1, 0); const parsed = parseSessionLog(buffer.subarray(0, Math.min(read.bytesRead, maxBytes)).toString("utf8")); if (read.bytesRead > maxBytes) { parsed.truncated = true; parsed.diagnostics.push("session log exceeded byte bound"); } return parsed; } finally { await handle.close(); } }
  catch (error) { return { ...initial(), diagnostics: [`session log unavailable: ${error instanceof Error ? error.message.slice(0, 120) : "read error"}`] }; }
}
