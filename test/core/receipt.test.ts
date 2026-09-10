import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReceipt } from "../../src/core/receipt.js";
import { parseSessionLog, readSessionLog } from "../../src/core/parser.js";
import { parseResultSummary, parseIssues, sanitize, bundleDigest } from "../../src/core/xcresult.js";

const git = { state: "present" as const, branch: "main", commit: "abc", dirty: false };

test("completed session requires executed tests", () => {
  const session = parseSessionLog('{"event":"task_complete"}\n{"event":"test_summary","tests":{"executed":3,"failed":0}}');
  const receipt = makeReceipt("/workspace", "/session.jsonl", session, git, undefined);
  assert.equal(receipt.verdict, "completed");
  assert.equal(receipt.tests.executed, 3);
});

test("cancelled, protocol errors, malformed and bounded input remain truthful", () => {
  const cancelled = makeReceipt("/workspace", "/session", parseSessionLog('{"type":"cancelled"}'), git, undefined);
  assert.equal(cancelled.verdict, "blocked");
  const protocol = parseSessionLog('{"event":"protocol_error"}\nnot-json');
  const failed = makeReceipt("/workspace", "/session", protocol, git, undefined);
  assert.equal(failed.verdict, "failed");
  assert.equal(protocol.malformedLines, 1);
  const bounded = parseSessionLog('{"event":"task_complete"}\n{"event":"task_complete"}', 1);
  assert.equal(bounded.truncated, true);
});

test("missing and zero result tests cannot be green", () => {
  const session = parseSessionLog('{"event":"task_complete"}');
  const zero = makeReceipt("/workspace", "/session", session, git, { state: "present", executed: 0, failed: 0 });
  assert.equal(zero.tests.state, "missing");
  assert.equal(zero.verdict, "unknown");
  const missing = makeReceipt("/workspace", undefined, session, { state: "unavailable", detail: "no git" }, undefined);
  assert.equal(missing.verdict, "unknown");
  assert.equal(missing.session.state, "missing");
});

test("JSONL parser accepts common Xcode event fields without exposing payloads", () => {
  const result = parseSessionLog('{"event":"task_complete"}\n{"type":"test_summary","tests":{"totalTestCount":2,"failedTestCount":0}}');
  assert.equal(result.completed, true);
  assert.deepEqual(result.testHint, { executed: 2, failed: 0 });
});

test("latest turn resets stale completion and rejects coercion", () => {
  const result = parseSessionLog('{"event":"task_complete"}\n{"event":"test_summary","tests":{"executed":2,"failed":0}}\n{"event":"task_started"}\n{"event":"test_summary","tests":{"executed":"2","failed":0}}');
  assert.equal(result.completed, false);
  assert.equal(result.testHint, undefined);
  assert.equal(result.malformedLines, 1);
});

test("file reader enforces byte bound and rejects directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xcode-loop-"));
  const path = join(directory, "session.jsonl");
  await writeFile(path, '{"event":"task_complete"}\n{"event":"test_summary","tests":{"executed":2,"failed":0}}\n');
  const bounded = await readSessionLog(path, 30);
  assert.equal(bounded.truncated, true);
  assert.equal(makeReceipt("/workspace", path, bounded, git, undefined).verdict, "unknown");
  const rejected = await readSessionLog(directory);
  assert.match(rejected.diagnostics[0] ?? "", /regular file/);
});

test("receipt accepts the xcresult summary field names", () => {
  const summary = parseResultSummary('{"title":"All tests","totalTestCount":4,"failedTests":1}');
  assert.deepEqual(summary, { state: "present", executed: 4, failed: 1 });
  assert.throws(() => parseResultSummary('{"totalTestCount":4,"failedTests":"1"}'), /invalid xcresult/);
});

test("issue parser emits build, analyzer, and test failures with stable redacted records", () => {
  const parsed = parseIssues({
    issues: [
      { severity: "error", issueType: "compile", message: "bad thing", target: "GlintApp", documentLocation: { url: "file:///Users/alice/project/Sources/App.swift:12:4" } },
      { severity: "warning", issueType: "warning", message: "bad thing", target: "GlintApp", documentLocation: { url: "file:///Users/alice/project/Sources/App.swift:12:4" } },
    ],
    analyzerIssues: [{ severity: "warning", issueType: "analyzer", message: "unused", target: "GlintApp", documentLocation: { url: "file:///Users/alice/project/Sources/Other.swift:3:2" } }],
  }, {
    testNodes: [{ name: "AppTests", tests: [{ name: "testFailure", testStatus: "Failure", failureSummaries: [{ message: "assertion failed", documentLocation: { url: "file:///Users/alice/project/Tests/AppTests.swift:8:1" } }] }] }],
  }, "/Users/alice/project");
  assert.equal(parsed.schema, "pi-xcode-loop.issues.v1");
  assert.equal(parsed.records.length, 4);
  assert.deepEqual(parsed.records.map(({ severity, type, target }) => ({ severity, type, target })), [
    { severity: "error", type: "compile", target: "GlintApp" },
    { severity: "warning", type: "warning", target: "GlintApp" },
    { severity: "warning", type: "analyzer", target: "GlintApp" },
    { severity: "error", type: "test-failure", target: "AppTests" },
  ]);
  assert.equal(parsed.records[0]?.location?.path, "Sources/App.swift");
  assert.equal(parsed.records[3]?.location?.path, "Tests/AppTests.swift");
  assert.doesNotMatch(JSON.stringify(parsed), /Users\/alice/);
  assert.equal(parsed.records[0]?.key, parsed.records[1]?.key === parsed.records[0]?.key ? "" : parsed.records[0]?.key);
});

test("issue parser tolerates additive fields and malformed URLs, dedupes, and bounds output", () => {
  const item = { severity: "warning", issueType: "warning", message: "same", target: "T", documentLocation: { url: "not-a-url" }, futureField: { secret: "/Users/alice/private" } };
  const parsed = parseIssues({ issues: [item, item, { ...item, message: "other" }], unknown: [{ source: "/Users/alice/private" }] }, undefined, "/Users/alice/project", { maxRecords: 1 });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0]?.location, undefined);
  assert.equal(parsed.truncated, true);
  assert.doesNotMatch(JSON.stringify(parsed), /Users\/alice|private/);
});

test("Xcode 27 schema fields and test failure nodes are collected", () => {
  const parsed = parseIssues({ errors: [{ issueType: "SwiftCompile", message: "error", targetName: "App", sourceURL: "file:///Users/a/project/S.swift#StartingLineNumber=7&StartingColumnNumber=2" }], warnings: [{ issueType: "warning", message: "warn", targetName: "App" }] }, { testNodes: [{ nodeType: "Test Case", name: "fails", result: "Failed", children: [{ nodeType: "Failure Message", name: "assertion", sourceLocation: { filePath: "/Users/a/project/T.swift", lineNumber: 9 } }] }] }, "/Users/a/project");
  assert.equal(parsed.records.length, 3);
  assert.equal(parsed.records[0]?.severity, "error");
  assert.equal(parsed.records[0]?.location?.line, 7);
  assert.equal(parsed.records[2]?.type, "test-failure");
});

test("all untrusted diagnostic fields redact paths and stay bounded", () => {
  const parsed = parseIssues({ errors: [{ issueType: "/opt/company/client.swift " + "x".repeat(5000), message: "file:///Users/alice/Secret%20Project/token.txt", targetName: "/Volumes/Private Disk/secret" }] }, undefined, "/Users/a/project");
  const output = JSON.stringify(parsed); assert.doesNotMatch(output, /Secret|Private Disk|company\/client|token\.txt/); assert.ok((parsed.records[0]?.type.length ?? 0) <= 256); assert.ok((parsed.records[0]?.message.length ?? 0) <= 2000);
});

test("path tokenizer redacts arbitrary roots and preserves prose", () => {
  const cases = [
    ["failed /mnt/Secret File.swift because parser stopped", "because parser stopped"],
    ["see /etc/passwd then retry", "then retry"],
    ["file:///etc/secret?x first", "first"],
    ["file:///etc/secret?x second", "second"],
    ["file:///etc/Secret%20File#fragment first", "first"],
    ["file:///Users/a/Secret%20File.swift?token=private#x next", "next"],
    ["C:\\\\Users\\A\\Secret File.swift done", "done"],
    ["\\\\server\\share\\Secret File.swift done", "done"],
  ] as const;
  for (const [input, prose] of cases) { const output = sanitize(input) ?? ""; assert.doesNotMatch(output, /Secret|passwd|token=private|Users|server\\share/); assert.match(output, new RegExp(prose)); }
  assert.notEqual(sanitize("error /mnt/a.swift:1"), sanitize("error /mnt/a.swift:2"));
});

test("root paths and spaced extensionless paths are redacted without key collapse", () => {
  const values = ["/secret", "/.env", "/private/Secret Project/cache"];
  for (const value of values) assert.doesNotMatch(sanitize(`diagnostic ${value} after`) ?? "", /secret|\.env|Secret Project|cache/);
  const first = parseIssues({ errors: [{ message: "/secret first" }] }, undefined, "/workspace").records[0];
  const second = parseIssues({ errors: [{ message: "/.env second" }] }, undefined, "/workspace").records[0];
  assert.notEqual(first?.key, second?.key);
});

test("unquoted spaced paths preserve trailing prose and quoted paths retain spaces", () => {
  const first = sanitize("/mnt/Secret Directory/token first");
  const second = sanitize("/mnt/Secret Directory/token second");
  assert.equal(first, "<redacted-path> first");
  assert.equal(second, "<redacted-path> second");
  assert.notEqual(first, second);
  assert.equal(sanitize('"/mnt/Secret Directory/token" then retry'), '"<redacted-path>" then retry');
  const records = parseIssues({ errors: [{ message: "/mnt/Secret Directory/token first" }, { message: "/mnt/Secret Directory/token second" }] }, undefined, "/workspace").records;
  assert.notEqual(records[0]?.key, records[1]?.key);
});

test("error text sanitizer covers volume and home paths", () => {
  const output = sanitize("failed /Volumes/Secret Disk/customer/token.txt and /home/alice/key then retry") ?? "";
  assert.doesNotMatch(output, /Volumes|Secret Disk|customer|token\.txt|home|alice|key/);
  assert.match(output, /then retry/);
});

test("location coordinates require positive present values", () => {
  const parsed = parseIssues({ errors: [
    { message: "zero", sourceURL: "file:///workspace/App.swift#StartingLineNumber=0&StartingColumnNumber=0" },
    { message: "positive", sourceURL: "file:///workspace/App.swift#StartingLineNumber=4&StartingColumnNumber=2" },
  ] }, undefined, "/workspace");
  assert.deepEqual(parsed.records[0]?.location, { path: "App.swift" });
  assert.deepEqual(parsed.records[1]?.location, { path: "App.swift", line: 4, column: 2 });
});

test("root workspace never turns an absolute source URL into a relative private path", () => {
  const parsed = parseIssues({ errors: [{ message: "private", sourceURL: "file:///Users/alice/private.swift:4:2" }] }, undefined, "/");
  assert.equal(parsed.records[0]?.location, undefined);
  assert.doesNotMatch(JSON.stringify(parsed), /Users\/alice|private\.swift/);
});

test("digest framing distinguishes ambiguous path and content boundaries", async () => {
  const first = await mkdtemp(join(tmpdir(), "xcode-loop-frame-a-")); const second = await mkdtemp(join(tmpdir(), "xcode-loop-frame-b-"));
  await writeFile(join(first, "a"), "bc"); await writeFile(join(second, "ab"), "c");
  const a = await bundleDigest(first); const b = await bundleDigest(second); assert.equal(a.state, "present"); assert.equal(b.state, "present"); assert.notEqual(a.digest, b.digest);
});

test("digest counts directories and exposes bounded typed outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "xcode-loop-digest-"));
  await mkdir(join(root, "nested")); await writeFile(join(root, "nested", "one"), "one");
  const present = await bundleDigest(root); assert.equal(present.state, "present"); assert.equal(present.files, 3); assert.equal(present.bytes, 3); assert.match(present.digest ?? "", /^[0-9a-f]{64}$/);
  const breadth = await bundleDigest(root, undefined, { maxEntries: 2 }); assert.equal(breadth.state, "truncated");
  const bytes = await bundleDigest(root, undefined, { maxBytes: 2 }); assert.equal(bytes.state, "truncated"); assert.match(bytes.reason ?? "", /byte bound/);
  const depth = await bundleDigest(root, undefined, { maxDepth: 0 }); assert.equal(depth.state, "truncated");
  const longPathRoot = await mkdtemp(join(tmpdir(), "xcode-loop-path-")); await writeFile(join(longPathRoot, "x".repeat(20)), "x");
  const longPath = await bundleDigest(longPathRoot, undefined, { maxPathBytes: 4 }); assert.equal(longPath.state, "truncated");
  const linkRoot = await mkdtemp(join(tmpdir(), "xcode-loop-link-")); await symlink(join(root, "nested", "one"), join(linkRoot, "link"));
  const rejected = await bundleDigest(linkRoot); assert.equal(rejected.state, "unavailable"); assert.match(rejected.reason ?? "", /symlink/);
});

test("mid-stream digest cancellation stops the read", async () => {
  const root = await mkdtemp(join(tmpdir(), "xcode-loop-cancel-")); await writeFile(join(root, "large"), Buffer.alloc(32 * 1024 * 1024, 7));
  const controller = new AbortController(); const pending = bundleDigest(root, controller.signal); setImmediate(() => controller.abort());
  await assert.rejects(pending, /status cancelled/);
});
