import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReceipt } from "../../src/core/receipt.js";
import { parseSessionLog, readSessionLog } from "../../src/core/parser.js";
import { parseResultSummary, parseIssues } from "../../src/core/xcresult.js";

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
