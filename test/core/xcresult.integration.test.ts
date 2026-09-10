import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readIssues } from "../../src/core/xcresult.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../../../test/fixtures/xcode27");
const fakeXcrun = join(here, "../../../test/fixtures/xcrun");

async function fixtureJSON(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(fixture, name), "utf8")) as Record<string, unknown>;
}

async function withFakeXcrun<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>, extra: NodeJS.ProcessEnv = {}): Promise<T> {
  await chmod(fakeXcrun, 0o755);
  await mkdtemp(join(tmpdir(), "pi-xcode-loop-integration-"));
  const env = { ...process.env, ...extra, PATH: `${dirname(fakeXcrun)}:${process.env.PATH ?? ""}`, XCODE_LOOP_FIXTURE: fixture };
  return fn(env);
}

async function withEnvironment<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try { return await fn(); }
  finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

test("readIssues uses the Xcode 27 fixture and redacts structured diagnostics", async () => {
  const receipt = await withFakeXcrun(async (env) => withEnvironment(env, () => readIssues(fixture, "/fixture/workspace")));
  const output = JSON.stringify(receipt);
  assert.equal(receipt.records.length, 3);
  assert.equal(receipt.records.find((record) => record.location?.path === "Sources/App.swift")?.severity, "error");
  assert.equal(receipt.records.find((record) => record.location?.path === "Tests/AppTests.swift")?.type, "test-failure");
  assert.doesNotMatch(output, /Users\/alice|Volumes\/Private|secret\.swift|private\.swift/);
  assert.equal(receipt.provenance?.tool.schema[0], "build-results@0.4.0");
});

test("committed Xcode 27 fixtures retain required schema 0.4.0 shapes", async () => {
  const build = await fixtureJSON("build-results.json");
  assert.equal(build.schemaVersion, "0.4.0");
  assert.equal(typeof build.startTime, "number");
  assert.equal(typeof build.endTime, "number");
  assert.ok(Array.isArray(build.analyzerWarnings));
  const destination = build.destination as Record<string, unknown>;
  for (const field of ["deviceId", "deviceName", "modelName", "osVersion"]) assert.equal(typeof destination[field], "string");

  const tests = await fixtureJSON("test-results.json");
  assert.equal(tests.schemaVersion, "0.4.0");
  assert.equal(typeof tests.startTime, "number");
  assert.equal(typeof tests.endTime, "number");
  assert.ok(Array.isArray(tests.devices) && tests.devices.length > 0);
  assert.ok(Array.isArray(tests.testPlanConfigurations) && tests.testPlanConfigurations.length > 0);
  const device = (tests.devices as Record<string, unknown>[])[0];
  for (const field of ["deviceId", "deviceName", "modelName", "osVersion"]) assert.equal(typeof device?.[field], "string");
  const configuration = (tests.testPlanConfigurations as Record<string, unknown>[])[0];
  assert.equal(typeof configuration?.configurationId, "string");
  assert.equal(typeof configuration?.configurationName, "string");
  assert.ok(Array.isArray(configuration?.testTargets));
  const suite = (tests.testNodes as Record<string, unknown>[])[0];
  assert.ok(Array.isArray(suite?.children));
});

test("readIssues redacts root and traversal bundle provenance", async () => {
  await withFakeXcrun(async (env) => withEnvironment(env, async () => {
    const root = await readIssues(fixture, "/");
    assert.equal(root.provenance?.bundle.path, "<result-bundle>");
    assert.ok(root.provenance?.tool.commands.every((command) => command.includes("<result-bundle>")));
    assert.doesNotMatch(JSON.stringify(root), /fixture|Users\/alice/);

    const traversal = await readIssues(fixture, "/fixture/workspace/../Users");
    assert.equal(traversal.provenance?.bundle.path, "<result-bundle>");
    assert.ok(traversal.provenance?.tool.commands.every((command) => command.includes("<result-bundle>")));
    assert.doesNotMatch(JSON.stringify(traversal), /fixture|Users\/alice/);
  }));
});

test("CLI issues reports sanitized unavailable output and exits nonzero", async () => {
  await withFakeXcrun(async (env) => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [join(here, "../../src/cli.js"), "issues", "--workspace", "/fixture/workspace", "--result-bundle", fixture], { env: { ...env, XCODE_LOOP_STUB_MODE: "fail", XCODE_LOOP_STUB_STDERR: "failed /Users/alice/private.swift /Volumes/Private Disk/x.swift C:\\Users\\alice\\secret.swift \\\\server\\share\\x.swift" } });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /unavailable:/);
    assert.doesNotMatch(result.stdout + result.stderr, /Users\/alice|Volumes\/Private|secret\.swift|server\\share/);
  });
});

test("actual issues runner kills a SIGTERM-resistant descendant process tree", async () => {
  await withFakeXcrun(async (env) => {
    const pidFile = join(await mkdtemp(join(tmpdir(), "pi-xcode-loop-pid-")), "child.pid");
    await withEnvironment({ ...env, XCODE_LOOP_STUB_MODE: "hang", XCODE_LOOP_STUB_PID_FILE: pidFile }, async () => {
      const controller = new AbortController();
      const pending = readIssues(fixture, "/fixture/workspace", controller.signal);
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await access(pidFile); break; } catch { await new Promise<void>((resolve) => setTimeout(resolve, 10)); }
      }
      controller.abort();
      await assert.rejects(pending, /status cancelled/);
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.ok(Number.isInteger(pid));
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    });
  });
});
