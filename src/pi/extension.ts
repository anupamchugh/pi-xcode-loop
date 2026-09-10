import { readGitSnapshot } from "../core/git.js";
import { parseSessionLog, readSessionLog } from "../core/parser.js";
import { makeReceipt } from "../core/receipt.js";
import { readResultSummary, readIssues } from "../core/xcresult.js";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi-types.js";

export const MAX_TIMEOUT_MS = 30_000; const MAX_SESSION_BYTES = 1_000_000;
const safePath = /^\/[A-Za-z0-9._+\-/ ]+$/;
function isSafePath(value: string): boolean { return value !== "/" && safePath.test(value) && !value.split("/").some((segment) => segment === "." || segment === ".."); }
interface Options { command: "status" | "issues"; workspace: string; session?: string; result?: string; expected?: number; json: boolean; piSession?: boolean; }
export function parseArguments(args: string, cwd: string): Options {
  if (!isSafePath(cwd)) throw new Error("workspace must be an absolute safe path");
  const tokens: string[] = []; let token = ""; let quote = "";
  for (const char of args.trim()) { if (quote) { if (char === quote) quote = ""; else token += char; } else if (char === "'" || char === '"') quote = char; else if (/\s/.test(char)) { if (token) { tokens.push(token); token = ""; } } else token += char; }
  if (quote) throw new Error("unterminated quoted argument"); if (token) tokens.push(token);
  if (tokens[0] !== "status" && tokens[0] !== "issues") throw new Error("usage: /xcode-loop status|issues [--workspace PATH] [--session PATH] [--result-bundle PATH] [--expect-tests N] [--json]");
  const out: Options = { command: tokens[0], workspace: cwd, json: false };
  for (let i = 1; i < tokens.length; i++) { const flag = tokens[i]; if (flag === "--json") out.json = true; else if (flag === "--workspace" || flag === "--session" || flag === "--result-bundle" || flag === "--expect-tests") { const value = tokens[++i]; if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value`); if (flag === "--expect-tests") { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error("--expect-tests must be a non-negative integer"); out.expected = n; } else { if (!isSafePath(value)) throw new Error(`${flag} must be an absolute safe path`); if (flag === "--workspace") out.workspace = value; else if (flag === "--session") out.session = value; else out.result = value; } } else throw new Error(`unknown argument: ${flag}`); }
  return out;
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("status cancelled"));
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error("status cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
function openAbortable(path: string, signal: AbortSignal, operation: () => Promise<FileHandle>): Promise<FileHandle> {
  if (signal.aborted) return Promise.reject(new Error("status cancelled"));
  return new Promise<FileHandle>((resolve, reject) => {
    let cancelled = false;
    const cancel = () => { cancelled = true; reject(new Error("status cancelled")); };
    signal.addEventListener("abort", cancel, { once: true });
    operation().then((handle) => {
      if (cancelled || signal.aborted) { void handle.close().catch(() => undefined); return; }
      resolve(handle);
    }, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
type PiSessionIO = { stat: typeof stat; open: typeof open };
export async function readPiSession(path: string, signal: AbortSignal, io: PiSessionIO = { stat, open }): Promise<ReturnType<typeof parseSessionLog>> {
  if (signal.aborted) throw new Error("status cancelled"); const info = await abortable(io.stat(path), signal); if (!info.isFile()) throw new Error("Pi session is not a regular file"); const handle = await openAbortable(path, signal, () => io.open(path, "r"));
  try {
    const buffer = Buffer.allocUnsafe(MAX_SESSION_BYTES + 1);
    const read = await abortable(handle.read(buffer, 0, MAX_SESSION_BYTES + 1, 0), signal);
    const lines = buffer.subarray(0, Math.min(read.bytesRead, MAX_SESSION_BYTES)).toString("utf8").split(/\r?\n/);
    const events: string[] = [];
    let malformedLines = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) { malformedLines++; continue; }
        const record = value as Record<string, unknown>;
        const message = record.message;
        if (!message || typeof message !== "object" || Array.isArray(message)) continue;
        const piMessage = message as Record<string, unknown>;
        const role = piMessage.role;
        if (record.type === "message" && role === "user") events.push('{"event":"task_started"}');
        if (record.type === "message" && role === "assistant") {
          const stop = piMessage.stopReason;
          if (stop === "stop" || stop === "end_turn") events.push('{"event":"task_complete"}');
          else if (stop === "aborted" || stop === "cancelled") events.push('{"event":"cancelled"}');
          else if (stop === "error") events.push('{"event":"error"}');
        }
      } catch { malformedLines++; }
    }
    const parsed = parseSessionLog(events.join("\n"));
    if (malformedLines > 0) { parsed.malformedLines += malformedLines; parsed.diagnostics.push(`${malformedLines} malformed Pi JSONL line(s)`); }
    if (read.bytesRead > MAX_SESSION_BYTES) { parsed.truncated = true; parsed.diagnostics.push("Pi session exceeded byte bound"); }
    return parsed;
  }
  finally { await handle.close(); }
}
export async function runStatus(options: Options, signal: AbortSignal): Promise<ReturnType<typeof makeReceipt>> {
  if (signal.aborted) throw new Error("status cancelled");
  const session = options.session ? (options.piSession ? await readPiSession(options.session, signal) : await readSessionLog(options.session, MAX_SESSION_BYTES)) : parseSessionLog("");
  const git = await readGitSnapshot(options.workspace, signal);
  const result = options.result ? await readResultSummary(options.result, signal) : undefined;
  if (signal.aborted) throw new Error("status cancelled");
  return makeReceipt(options.workspace, options.session, session, git, result, options.expected);
}
export async function runIssues(options: Options, signal: AbortSignal) { if (!options.result) throw new Error("--result-bundle is required for issues"); return readIssues(options.result, options.workspace, signal); }
export async function withTimeout<T>(task: Promise<T>, timeoutMs: number, signal: AbortSignal, onTimeout: () => void): Promise<T> { if (signal.aborted) throw new Error("status cancelled"); let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([task, new Promise<T>((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new Error("status timed out")); }, timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
function publicJson(receipt: ReturnType<typeof makeReceipt>): string { return JSON.stringify({ ...receipt, workspace: "<workspace>", session: { ...receipt.session, path: receipt.session.path ? "<session>" : undefined }, git: { ...receipt.git, detail: receipt.git.detail ? "git unavailable" : undefined }, diagnostics: receipt.diagnostics.map((item) => item.includes("unavailable") ? "evidence unavailable" : item.includes("bound") ? "input exceeded bound" : "evidence warning") }); }
export default function xcodeLoopExtension(pi: ExtensionAPI): void {
  pi.registerCommand("xcode-loop", { description: "Read-only Xcode loop evidence status", handler: async (args: string, ctx: ExtensionCommandContext) => {
    try { const hostSignal = ctx.signal; if (hostSignal?.aborted) { ctx.ui.notify("status cancelled", "error"); return; } const options = parseArguments(args, ctx.cwd); const session = options.session ?? ctx.sessionManager?.getSessionFile(); const effective = session ? { ...options, session, piSession: options.session === undefined } : options; const controller = new AbortController(); const cancel = () => controller.abort(); hostSignal?.addEventListener("abort", cancel, { once: true });
      try { if (effective.command === "issues") { const issues = await withTimeout(runIssues(effective, controller.signal), MAX_TIMEOUT_MS, controller.signal, () => controller.abort()); ctx.ui.notify(effective.json ? JSON.stringify(issues) : (issues.diagnostics.length ? `unavailable: ${issues.diagnostics[0]}` : `issues: ${issues.records.length}${issues.truncated ? " (truncated)" : ""}`), issues.diagnostics.length ? "error" : "info"); } else { const receipt = await withTimeout(runStatus(effective, controller.signal), MAX_TIMEOUT_MS, controller.signal, () => controller.abort()); ctx.ui.notify(effective.json ? publicJson(receipt) : `${receipt.verdict}: session=${receipt.session.state} git=${receipt.git.state} tests=${receipt.tests.state} (${receipt.tests.executed} executed)`, receipt.verdict === "failed" ? "error" : "info"); } }
      finally { hostSignal?.removeEventListener("abort", cancel); }
    } catch (error) { const message = error instanceof Error ? error.message : ""; const safe = message === "status cancelled" || message === "status timed out" || message.startsWith("usage:") || message.startsWith("unknown argument") || message.startsWith("--"); ctx.ui.notify(safe ? message : "xcode-loop status unavailable", "error"); }
  } });
}
