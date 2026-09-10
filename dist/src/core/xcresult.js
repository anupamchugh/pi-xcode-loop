import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { relative, sep } from "node:path";
import { readGitSnapshot } from "./git.js";
const run = promisify(execFile);
const MAX_JSON_BYTES = 2_000_000;
const MAX_RECORDS = 10_000;
export function parseResultSummary(stdout) { const value = JSON.parse(stdout); const executed = value.totalTestCount; const failed = value.failedTests; if (typeof executed !== "number" || !Number.isSafeInteger(executed) || executed < 0 || typeof failed !== "number" || !Number.isSafeInteger(failed) || failed < 0 || failed > executed)
    throw new Error("invalid xcresult summary"); return { state: "present", executed, failed }; }
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function severity(value) { const item = text(value)?.toLowerCase(); return item === "error" || item === "failure" ? "error" : item === "warning" ? "warning" : item === "notice" || item === "info" ? "notice" : "unknown"; }
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
    return undefined; let path = raw; let line; let column; if (raw.startsWith("file:")) {
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== "file:")
            return undefined;
        path = parsed.pathname;
    }
    catch {
        return undefined;
    }
} const match = path.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/); if (match?.[1]) {
    path = match[1];
    line = match[2] ? Number(match[2]) : undefined;
    column = match[3] ? Number(match[3]) : undefined;
} const safePath = safeRelativePath(path, workspace); if (!safePath)
    return undefined; return { path: safePath, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) }; }
function stableKey(record) { return createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 32); }
function recordFrom(value, workspace, inheritedTarget, testFailure) { const rawMessage = text(value.message) ?? text(value.description); if (!rawMessage)
    return undefined; const root = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace; const message = rawMessage.replaceAll(root, "<workspace>").replaceAll(/\/(?:Users|private|var|tmp)\/[^\s:]*/g, "<local-path>"); const status = text(value.testStatus)?.toLowerCase(); const isFailure = testFailure || status === "failure" || status === "failed"; const type = isFailure ? "test-failure" : text(value.issueType) ?? text(value.type) ?? "diagnostic"; const target = text(value.target) ?? inheritedTarget ?? "unknown"; const parsedLocation = parseLocation(value.documentLocation ?? value.sourceLocation ?? value.location, workspace); return { severity: isFailure ? "error" : severity(value.severity), type, target, message, ...(parsedLocation ? { location: parsedLocation } : {}) }; }
function collect(value, workspace, records, target, testFailure = false) { if (!value || typeof value !== "object")
    return; if (Array.isArray(value)) {
    for (const item of value)
        collect(item, workspace, records, target, testFailure);
    return;
} const object = value; const namedTarget = text(object.target) ?? text(object.targetName) ?? text(object.testTarget) ?? ((Array.isArray(object.tests) || Array.isArray(object.testNodes)) ? text(object.name) : undefined); const nextTarget = namedTarget ?? target; const status = text(object.testStatus)?.toLowerCase(); const nextFailure = testFailure || status === "failure" || status === "failed"; const candidate = recordFrom(object, workspace, nextTarget, nextFailure); if (candidate && (text(object.issueType) || text(object.severity) || nextFailure || text(object.failureSummaries)))
    records.push(candidate); for (const [key, child] of Object.entries(object))
    collect(child, workspace, records, nextTarget, nextFailure || key === "failureSummaries" || key === "failureSummary"); }
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
export async function readResultSummary(bundle, signal) { try {
    const { stdout } = await run("xcrun", ["xcresulttool", "get", "test-results", "summary", "--schema-version", "0.4.0", "--path", bundle, "--compact"], { maxBuffer: 1_000_000, signal });
    return parseResultSummary(stdout);
}
catch (error) {
    return { state: "unavailable", detail: `result bundle unavailable: ${error instanceof Error ? error.message.slice(0, 120) : "read error"}` };
} }
async function readJSON(bundle, kind, signal) { const command = kind === "build-results" ? ["xcresulttool", "get", "build-results", "--schema-version", "0.4.0", "--path", bundle, "--compact"] : ["xcresulttool", "get", "test-results", "tests", "--schema-version", "0.4.0", "--path", bundle, "--compact"]; const { stdout } = await run("xcrun", command, { maxBuffer: MAX_JSON_BYTES, signal }); if (Buffer.byteLength(stdout) > MAX_JSON_BYTES)
    throw new Error("xcresult output exceeded bound"); return JSON.parse(stdout); }
function redactedBundlePath(bundle, workspace) { const root = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace; return bundle === root ? "<workspace>" : bundle.startsWith(`${root}/`) ? `<workspace>/${bundle.slice(root.length + 1)}` : "<result-bundle>"; }
function safeError(error, bundle, workspace) { const message = error instanceof Error ? error.message.slice(0, 120) : "read error"; return message.replaceAll(bundle, redactedBundlePath(bundle, workspace)).replaceAll(/\/(?:Users|private|var|tmp)\/[^\s:]*/g, "<local-path>"); }
export async function readIssues(bundle, workspace, signal) { const provenanceBase = { bundle: { path: redactedBundlePath(bundle, workspace) }, tool: { command: ["xcrun", "xcresulttool", "get"], commands: [["xcrun", "xcresulttool", "get", "build-results", "--schema-version", "0.4.0", "--path", redactedBundlePath(bundle, workspace), "--compact"], ["xcrun", "xcresulttool", "get", "test-results", "tests", "--schema-version", "0.4.0", "--path", redactedBundlePath(bundle, workspace), "--compact"]], schema: ["build-results@0.4.0", "test-results@0.4.0"] }, git: { state: "unavailable" } }; try {
    const [build, tests, digest, git] = await Promise.all([readJSON(bundle, "build-results", signal), readJSON(bundle, "test-results", signal), bundleDigest(bundle), readGitSnapshot(workspace, signal)]);
    return { ...parseIssues(build, tests, workspace), provenance: { ...provenanceBase, bundle: { path: redactedBundlePath(bundle, workspace), ...(digest ? { digest } : {}) }, git: { state: git.state, ...(git.branch ? { branch: git.branch } : {}), ...(git.commit ? { commit: git.commit } : {}) } } };
}
catch (error) {
    if (signal?.aborted)
        throw new Error("status cancelled");
    return { schema: "pi-xcode-loop.issues.v1", records: [], truncated: false, diagnostics: [`result bundle unavailable: ${safeError(error, bundle, workspace)}`], provenance: provenanceBase };
} }
export async function bundleDigest(bundle) { try {
    const info = await lstat(bundle);
    if (!info)
        return undefined;
    const hash = createHash("sha256");
    const files = [];
    async function visit(path) { const item = await lstat(path); if (item.isDirectory()) {
        for (const name of (await readdir(path)).sort())
            await visit(`${path}/${name}`);
    }
    else if (item.isFile())
        files.push(path); }
    await visit(bundle);
    for (const path of files) {
        hash.update(relative(bundle, path).split(sep).join("/"));
        hash.update(await readFile(path));
    }
    return hash.digest("hex");
}
catch {
    return undefined;
} }
