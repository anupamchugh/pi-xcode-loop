import test from "node:test";
import assert from "node:assert/strict";
import extension, { parseArguments, readPiSession, withTimeout } from "../../src/pi/extension.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("registers one fixed command and defaults workspace to cwd", () => {
  let registered: { name: string; handler: (args: string, ctx: any) => Promise<void> } | undefined;
  extension({ registerCommand(name, options) { registered = { name, handler: options.handler }; } });
  assert.equal(registered?.name, "xcode-loop");
  assert.equal(parseArguments("status", "/owned/project").workspace, "/owned/project");
});

test("accepts only safe explicit flags and rejects injection-like arguments", () => {
  const options = parseArguments("status --workspace /owned/project --session /owned/session.jsonl --result-bundle /owned/Tests.xcresult --expect-tests 4 --json", "/tmp");
  assert.equal(options.expected, 4); assert.equal(options.json, true);
  assert.throws(() => parseArguments("status --workspace /owned/project;touch", "/tmp"), /absolute safe path/);
  assert.throws(() => parseArguments("status --shell 'git status'", "/tmp"), /unknown argument/);
  assert.equal(parseArguments('status --workspace "/owned/project folder"', "/tmp").workspace, "/owned/project folder");
  assert.throws(() => parseArguments("status --session /owned/./session.jsonl", "/tmp"), /absolute safe path/);
  assert.throws(() => parseArguments("status --session /owned/logs/../session.jsonl", "/tmp"), /absolute safe path/);
});

test("Pi JSONL counts malformed nonblank records and stays unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xcode-loop-pi-"));
  const path = join(directory, "session.jsonl");
  await writeFile(path, '{"type":"message","message":{"role":"user"}}\nnot-json\n{"type":"message","message":{"role":"assistant","stopReason":"stop"}}\n');
  const parsed = await readPiSession(path, new AbortController().signal);
  assert.equal(parsed.completed, true);
  assert.equal(parsed.malformedLines, 1);
  assert.match(parsed.diagnostics.join(" "), /malformed Pi JSONL/);
});

test("Pi session read observes cancellation after I/O starts", async () => {
  const controller = new AbortController();
  let started = false;
  const read = readPiSession("/owned/session.jsonl", controller.signal, {
    stat: (async () => ({ isFile: () => true })) as any,
    open: (async () => ({
      read: async () => { started = true; return await new Promise<{ bytesRead: number }>(() => {}); },
      close: async () => undefined,
    })) as any,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  controller.abort();
  await assert.rejects(read, /status cancelled/);
});

test("late Pi open closes its handle once after cancellation", async () => {
  const controller = new AbortController();
  let resolveOpen!: (handle: any) => void;
  let closeCount = 0;
  let unhandledRejections = 0;
  const onUnhandledRejection = () => { unhandledRejections++; };
  let openStarted!: () => void;
  const openStartedPromise = new Promise<void>((resolve) => { openStarted = resolve; });
  const read = readPiSession("/owned/session.jsonl", controller.signal, {
    stat: (async () => ({ isFile: () => true })) as any,
    open: (() => { openStarted(); return new Promise((resolve) => { resolveOpen = resolve; }); }) as any,
  });
  await openStartedPromise;
  process.on("unhandledRejection", onUnhandledRejection);
  controller.abort();
  resolveOpen({ close: async () => { closeCount++; throw new Error("close failed"); } });
  await assert.rejects(read, /status cancelled/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", onUnhandledRejection);
  assert.equal(closeCount, 1);
  assert.equal(unhandledRejections, 0);
});

test("timeout abort callback runs and returns promptly", async () => {
  const controller = new AbortController(); let aborted = false;
  await assert.rejects(withTimeout(new Promise<string>(() => {}), 5, controller.signal, () => { aborted = true; controller.abort(); }), /timed out/);
  assert.equal(aborted, true); assert.equal(controller.signal.aborted, true);
});

test("handler emits concise private-safe output and honors cancellation", async () => {
  let handler!: (args: string, ctx: any) => Promise<void>; const messages: string[] = [];
  extension({ registerCommand(_name, options) { handler = options.handler; } });
  const controller = new AbortController(); controller.abort();
  await handler("status --json", { cwd: "/private/project", signal: controller.signal, sessionManager: { getSessionFile: () => undefined }, ui: { notify(message: string) { messages.push(message); } } });
  assert.equal(messages.length, 1); assert.equal(messages[0], "status cancelled"); assert.doesNotMatch(messages[0] ?? "", /private\/project|prompt|tool/);
});

test("session I/O errors never disclose workspace or session paths", async () => {
  let handler!: (args: string, ctx: any) => Promise<void>; const messages: string[] = [];
  extension({ registerCommand(_name, options) { handler = options.handler; } });
  const secret = "/private/secret-user/sessions/current.jsonl";
  await handler("status", { cwd: "/private/secret-user/project", sessionManager: { getSessionFile: () => secret }, ui: { notify(message: string) { messages.push(message); } } });
  assert.equal(messages.length, 1); assert.equal(messages[0], "xcode-loop status unavailable"); assert.doesNotMatch(messages[0] ?? "", /secret-user|current\.jsonl|project/);
});
