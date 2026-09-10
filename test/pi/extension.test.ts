import test from "node:test";
import assert from "node:assert/strict";
import extension, { parseArguments, withTimeout } from "../../src/pi/extension.js";

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
