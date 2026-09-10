import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { relative, sep } from "node:path";
import { readGitSnapshot } from "./git.js";
const MAX_JSON_BYTES = 2_000_000;
const MAX_RECORDS = 10_000;
export function parseResultSummary(stdout) { const value = JSON.parse(stdout); const executed = value.totalTestCount; const failed = value.failedTests; if (typeof executed !== "number" || !Number.isSafeInteger(executed) || executed < 0 || typeof failed !== "number" || !Number.isSafeInteger(failed) || failed < 0 || failed > executed)
    throw new Error("invalid xcresult summary"); return { state: "present", executed, failed }; }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function integer(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
function severity(value) { const item = text(value)?.toLowerCase(); return item === "error" || item === "failure" ? "error" : item === "warning" ? "warning" : item === "notice" || item === "info" ? "notice" : "unknown"; }
function decode(value) { try {
    return decodeURIComponent(value);
}
catch {
    return value;
} }
function pathStart(value, index) { return index === 0 || /[\s([{"'=,:;]/.test(value[index - 1] ?? ""); }
function consumePath(value, start) {
    const quoted = /["']/.test(value[start - 1] ?? "");
    let end = start;
    while (end < value.length && !/[<>|;\n\r]/.test(value[end] ?? "")) {
        if (quoted && value[end] === value[start - 1])
            return end;
        end++;
    }
    const candidate = value.slice(start, end);
    const ext = candidate.search(/\.[A-Za-z0-9]{1,16}(?=$|[:\s)\]}>,!?])/);
    if (ext >= 0)
        return start + ext + candidate.slice(ext).match(/\.[A-Za-z0-9]{1,16}/)[0].length;
    return candidate.search(/\s/) >= 0 ? start + candidate.search(/\s/) : end;
}
/** Redacts path tokens while retaining surrounding human prose. */
export function sanitize(value, limit = 2000) {
    if (!value)
        return undefined;
    const input = decode(value);
    let out = "";
    let i = 0;
    while (i < input.length) {
        const rest = input.slice(i);
        const file = rest.match(/^file:\/\//i);
        const posix = rest.match(/^\/(?:[^\s/]+\/)+[^\s]*/);
        const drive = rest.match(/^[A-Za-z]:[\\/][^<>|;\n\r]*/);
        const unc = rest.match(/^\\\\[^\\/\s]+[\\/][^<>|;\n\r]*/);
        if (file && pathStart(input, i)) {
            let end = consumePath(input, i);
            if (!/[.][A-Za-z0-9]{1,16}(?=$|[:\s])/.test(input.slice(i, end))) {
                while (input[end] === " ") {
                    const next = input.slice(end + 1).match(/^[^\s<>|;\n\r"']+/);
                    if (!next)
                        break;
                    end += next[0].length + 1;
                }
            }
            while (end < input.length && !/[\s<>|;\n\r"']/.test(input[end] ?? ""))
                end++;
            out += "<redacted-path>";
            i = end;
            continue;
        }
        if ((posix || drive || unc) && pathStart(input, i)) {
            const end = consumePath(input, i);
            out += "<redacted-path>";
            i = end;
            continue;
        }
        out += input[i++];
    }
    return out.slice(0, limit);
}
function safeRelativePath(raw, workspace) { let value = raw; try {
    value = decodeURIComponent(value);
}
catch {
    return undefined;
} const root = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace; if (value.startsWith("/")) {
    if (!(value === root || value.startsWith(`${root}/`)))
        return undefined;
    value = value.slice(root.length + (value === root ? 0 : 1));
}
else if (!value.includes("/") || !/\.[A-Za-z0-9]+$/.test(value))
    return undefined; const parts = value.replaceAll("\\", "/").split("/").filter(Boolean); if (parts.includes("..") || parts.includes("."))
    return undefined; return parts.join("/") || undefined; }
function parseLocation(value, workspace) { if (!value || typeof value !== "object")
    return undefined; const object = value; const raw = text(object.url) ?? text(object.path) ?? text(object.filePath); if (!raw)
    return undefined; let path = raw; let line = integer(object.lineNumber); let column = integer(object.columnNumber); if (raw.startsWith("file:")) {
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "file:")
            return undefined;
        path = parsed.pathname + parsed.hash;
        line = integer(Number(parsed.searchParams.get("StartingLineNumber"))) ?? line;
        column = integer(Number(parsed.searchParams.get("StartingColumnNumber"))) ?? column;
    }
    catch {
        return undefined;
    }
} const fragment = path.indexOf("#"); if (fragment >= 0) {
    const query = new URLSearchParams(path.slice(fragment + 1));
    path = path.slice(0, fragment);
    line = integer(Number(query.get("StartingLineNumber"))) ?? line;
    column = integer(Number(query.get("StartingColumnNumber"))) ?? column;
} const match = path.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/); if (match?.[1]) {
    path = match[1];
    line = match[2] ? Number(match[2]) : line;
    column = match[3] ? Number(match[3]) : column;
} const safePath = safeRelativePath(path, workspace); if (!safePath)
    return undefined; return { path: safePath, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) }; }
function stableKey(record) { return createHash("sha256").update(JSON.stringify(record)).digest("hex"); }
function recordFrom(value, workspace, inheritedTarget, testFailure) { const status = (text(value.testStatus) ?? text(value.result))?.toLowerCase(); const isFailure = testFailure || status === "failure" || status === "failed"; const rawMessage = text(value.message) ?? text(value.description) ?? (isFailure && text(value.nodeType)?.toLowerCase() === "failure message" ? text(value.name) : undefined); if (!rawMessage)
    return undefined; const message = sanitize(rawMessage) ?? "<redacted>"; const type = sanitize(isFailure ? "test-failure" : text(value.issueType) ?? text(value.type) ?? "diagnostic", 256) ?? "diagnostic"; const rawTarget = text(value.target) ?? text(value.targetName) ?? inheritedTarget ?? "unknown"; const target = sanitize(rawTarget, 256) ?? "unknown"; const parsedLocation = parseLocation(value.documentLocation ?? value.sourceLocation ?? value.location ?? (text(value.sourceURL) ? { url: value.sourceURL } : undefined), workspace); return { severity: isFailure ? "error" : severity(value.severity), type, target, message, ...(parsedLocation ? { location: parsedLocation } : {}) }; }
function collect(value, workspace, records, target, testFailure = false, inheritedSeverity) { if (!value || typeof value !== "object")
    return; if (Array.isArray(value)) {
    for (const item of value)
        collect(item, workspace, records, target, testFailure, inheritedSeverity);
    return;
} const object = value; const namedTarget = text(object.target) ?? text(object.targetName) ?? text(object.testTarget) ?? ((Array.isArray(object.tests) || Array.isArray(object.testNodes) || text(object.nodeType)?.toLowerCase() === "test case") ? text(object.name) : undefined); const nextTarget = namedTarget ?? target; const status = (text(object.testStatus) ?? text(object.result))?.toLowerCase(); const nextFailure = testFailure || status === "failure" || status === "failed" || text(object.nodeType)?.toLowerCase() === "failure message"; const candidate = recordFrom({ ...object, severity: object.severity ?? inheritedSeverity }, workspace, nextTarget, nextFailure); if (candidate && (text(object.issueType) || text(object.severity) || inheritedSeverity || nextFailure || text(object.failureSummaries) || text(object.sourceURL)))
    records.push(candidate); for (const [key, child] of Object.entries(object))
    collect(child, workspace, records, nextTarget, nextFailure || key === "failureSummaries" || key === "failureSummary", key === "errors" ? "error" : key === "warnings" || key === "analyzerWarnings" ? "warning" : inheritedSeverity); }
export function parseIssues(build, tests, workspace, options = {}) { const max = Math.max(1, Math.min(options.maxRecords ?? MAX_RECORDS, MAX_RECORDS)); const candidates = []; collect(build, workspace, candidates); collect(tests, workspace, candidates); const records = []; const seen = new Set(); let truncated = false; for (const candidate of candidates) {
    const key = stableKey(candidate);
    if (seen.has(key))
        continue;
    seen.add(key);
    if (records.length >= max) {
        truncated = true;
        continue;
    }
    records.push({ key, ...candidate });
} return { schema: "pi-xcode-loop.issues.v1", records, truncated, diagnostics: truncated ? ["issue output exceeded bound"] : [] }; }
async function runCommand(file, args, signal, maxBytes = MAX_JSON_BYTES) {
    if (signal?.aborted)
        throw new Error("status cancelled");
    return await new Promise((resolve, reject) => {
        const child = spawn(file, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "", tooLarge = false;
        const append = (kind, chunk) => { const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length; if (Buffer.byteLength(kind === "stdout" ? stdout : stderr) + bytes > maxBytes) {
            tooLarge = true;
            if (child.pid) {
                try {
                    process.kill(-child.pid, "SIGTERM");
                }
                catch { }
            }
            return;
        } if (kind === "stdout")
            stdout += chunk.toString();
        else
            stderr += chunk.toString(); };
        const abort = () => { if (child.pid) {
            try {
                process.kill(-child.pid, "SIGTERM");
            }
            catch { }
        } };
        const cleanup = () => signal?.removeEventListener("abort", abort);
        child.stdout.on("data", (c) => append("stdout", c));
        child.stderr.on("data", (c) => append("stderr", c));
        child.once("error", (error) => { cleanup(); reject(error); });
        child.once("close", (code, sig) => { cleanup(); if (signal?.aborted)
            reject(new Error("status cancelled"));
        else if (tooLarge)
            reject(new Error("xcresult output exceeded bound"));
        else if (code !== 0)
            reject(new Error((stderr || `command exited ${code ?? sig}`).slice(0, 240)));
        else
            resolve({ stdout, stderr }); });
        signal?.addEventListener("abort", abort, { once: true });
    });
}
export async function readResultSummary(bundle, signal) { try {
    const { stdout } = await runCommand("xcrun", ["xcresulttool", "get", "test-results", "summary", "--schema-version", "0.4.0", "--path", bundle, "--compact"], signal, 1_000_000);
    return parseResultSummary(stdout);
}
catch (error) {
    return { state: "unavailable", detail: `result bundle unavailable: ${error instanceof Error ? error.message.slice(0, 120) : "read error"}` };
} }
async function readJSON(bundle, kind, signal) { const command = kind === "build-results" ? ["xcresulttool", "get", "build-results", "--schema-version", "0.4.0", "--path", bundle, "--compact"] : ["xcresulttool", "get", "test-results", "tests", "--schema-version", "0.4.0", "--path", bundle, "--compact"]; const { stdout } = await runCommand("xcrun", command, signal); return JSON.parse(stdout); }
function redactedBundlePath(bundle, workspace) { const root = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace; return bundle === root ? "<workspace>" : bundle.startsWith(`${root}/`) ? `<workspace>/${bundle.slice(root.length + 1)}` : "<result-bundle>"; }
function safeError(error, bundle, workspace) { const message = error instanceof Error ? error.message.slice(0, 120) : "read error"; return message.replaceAll(bundle, redactedBundlePath(bundle, workspace)).replaceAll(/\/(?:Users|private|var|tmp)\/[^\s:]*/g, "<local-path>"); }
export async function readIssues(bundle, workspace, signal) { const provenanceBase = { bundle: { path: redactedBundlePath(bundle, workspace) }, tool: { command: ["xcrun", "xcresulttool", "get"], commands: [["xcrun", "xcresulttool", "get", "build-results", "--schema-version", "0.4.0", "--path", redactedBundlePath(bundle, workspace), "--compact"], ["xcrun", "xcresulttool", "get", "test-results", "tests", "--schema-version", "0.4.0", "--path", redactedBundlePath(bundle, workspace), "--compact"]], schema: ["build-results@0.4.0", "test-results@0.4.0"] }, git: { state: "unavailable" } }; try {
    const [build, tests, digest, git] = await Promise.all([readJSON(bundle, "build-results", signal), readJSON(bundle, "test-results", signal), bundleDigest(bundle, signal), readGitSnapshot(workspace, signal)]);
    const parsed = parseIssues(build, tests, workspace);
    if (digest.state !== "present")
        parsed.diagnostics.push(`bundle digest ${digest.state}: ${digest.reason ?? "unavailable"}`);
    return { ...parsed, provenance: { ...provenanceBase, bundle: { path: redactedBundlePath(bundle, workspace), digestState: digest.state, ...(digest.digest ? { digest: digest.digest } : {}) }, git: { state: git.state, ...(git.branch ? { branch: git.branch } : {}), ...(git.commit ? { commit: git.commit } : {}) } } };
}
catch (error) {
    if (signal?.aborted)
        throw new Error("status cancelled");
    return { schema: "pi-xcode-loop.issues.v1", records: [], truncated: false, diagnostics: [`result bundle unavailable: ${safeError(error, bundle, workspace)}`], provenance: provenanceBase };
} }
export const DEFAULT_DIGEST_LIMITS = { maxEntries: 100_000, maxBytes: 512 * 1024 * 1024, maxDepth: 64, maxPathBytes: 16_384 };
export async function bundleDigest(bundle, signal, limits = {}) {
    const bound = { ...DEFAULT_DIGEST_LIMITS, ...limits };
    let count = 0;
    let bytes = 0;
    try {
        const hash = createHash("sha256");
        const check = () => { if (signal?.aborted)
            throw new Error("status cancelled"); };
        async function visit(path, depth) {
            check();
            if (depth > bound.maxDepth)
                throw new Error("result bundle digest depth exceeded");
            const item = await lstat(path);
            if (item.isSymbolicLink())
                throw new Error("result bundle symlink rejected");
            count++;
            if (count > bound.maxEntries)
                throw new Error("result bundle digest entry bound exceeded");
            if (item.isDirectory()) {
                for (const name of (await readdir(path)).sort())
                    await visit(`${path}/${name}`, depth + 1);
                return;
            }
            if (!item.isFile())
                return;
            const rel = relative(bundle, path).split(sep).join("/");
            const pathBytes = Buffer.from(rel);
            if (pathBytes.length > bound.maxPathBytes)
                throw new Error("result bundle digest path bound exceeded");
            if (item.size > bound.maxBytes - bytes)
                throw new Error("result bundle digest byte bound exceeded");
            bytes += item.size;
            const header = Buffer.alloc(1 + 4 + 8);
            header.writeUInt8(1, 0);
            header.writeUInt32BE(pathBytes.length, 1);
            header.writeBigUInt64BE(BigInt(item.size), 5);
            hash.update(header);
            hash.update(pathBytes);
            let actual = 0;
            await new Promise((resolve, reject) => { const stream = createReadStream(path); const abort = () => stream.destroy(new Error("status cancelled")); signal?.addEventListener("abort", abort, { once: true }); stream.on("data", (chunk) => { try {
                check();
                actual += Buffer.byteLength(chunk);
                hash.update(chunk);
            }
            catch (e) {
                stream.destroy(e);
            } }); stream.on("error", reject); stream.on("end", resolve); stream.on("close", () => signal?.removeEventListener("abort", abort)); });
            if (actual !== item.size)
                throw new Error("result bundle content changed during digest");
        }
        await visit(bundle, 0);
        check();
        return { state: "present", digest: hash.digest("hex"), files: count, bytes };
    }
    catch (error) {
        if (signal?.aborted)
            throw new Error("status cancelled");
        const reason = error instanceof Error ? error.message : "digest unavailable";
        return { state: reason.includes("bound") || reason.includes("depth") ? "truncated" : "unavailable", files: count, bytes, reason };
    }
}
