import { readSessionLog } from "./core/parser.js";
import { readGitSnapshot } from "./core/git.js";
import { readResultSummary } from "./core/xcresult.js";
import { readIssues } from "./core/xcresult.js";
import { makeReceipt } from "./core/receipt.js";

function help(): string { return "Usage: xcode-loop status --workspace <path> [--session <path>] [--result-bundle <path>] [--expect-tests <n>] [--json]\n       xcode-loop issues --workspace <path> --result-bundle <path> [--json]"; }
const safePath = /^\/[A-Za-z0-9._\-/ ]+$/;
function isSafePath(value: string): boolean { return safePath.test(value) && !value.split("/").some((segment) => segment === "." || segment === ".."); }
function parse(args: string[]) {
  const out: { workspace?: string; session?: string; result?: string; expected?: number; json: boolean } = { json: false };
  for (let i = 0; i < args.length; i++) { const arg = args[i]; if (arg === "--json") out.json = true; else if (["--workspace", "--session", "--result-bundle", "--expect-tests"].includes(arg ?? "")) { const value = args[++i]; if (!value) throw new Error(`${arg} requires a value`); if (arg === "--workspace" || arg === "--session" || arg === "--result-bundle") { if (!isSafePath(value)) throw new Error(`${arg} must be an absolute safe path`); if (arg === "--workspace") out.workspace = value; else if (arg === "--session") out.session = value; else out.result = value; } else { out.expected = Number(value); if (!Number.isInteger(out.expected) || out.expected < 0) throw new Error("--expect-tests must be a non-negative integer"); } } else throw new Error(`unknown option: ${arg}`); }
  if (!out.workspace) throw new Error("--workspace is required");
  return out;
}
async function main() {
  try {
    const [command, ...args] = process.argv.slice(2); if ((command !== "status" && command !== "issues") || args.includes("--help") || args.includes("-h")) { if (args.includes("--help") || args.includes("-h")) { console.log(help()); return; } throw new Error("expected: status or issues"); }
    const options = parse(args); if (options.workspace === undefined) throw new Error("--workspace is required"); const workspace = options.workspace;
    if (command === "issues") { if (!options.result) throw new Error("--result-bundle is required for issues"); const receipt = await readIssues(options.result, workspace); if (options.json) console.log(JSON.stringify(receipt)); else console.log(receipt.diagnostics.length ? `unavailable: ${receipt.diagnostics[0]}` : `issues: ${receipt.records.length}${receipt.truncated ? " (truncated)" : ""}`); if (receipt.diagnostics.length) process.exitCode = 1; return; }
    const [session, git, result] = await Promise.all([options.session ? readSessionLog(options.session) : Promise.resolve({ completed: false, failed: false, cancelled: false, protocolError: false, malformedLines: 0, truncated: false, diagnostics: ["session log not provided"] }), readGitSnapshot(workspace), options.result ? readResultSummary(options.result) : Promise.resolve(undefined)]);
    const receipt = makeReceipt(workspace, options.session, session, git, result, options.expected);
    if (options.json) console.log(JSON.stringify(receipt)); else console.log(`${receipt.verdict}: session=${receipt.session.state} git=${receipt.git.state} tests=${receipt.tests.state} (${receipt.tests.executed} executed)`);
    process.exitCode = receipt.verdict === "failed" ? 1 : 0;
  } catch (error) { console.error(error instanceof Error ? error.message : "error"); console.error(help()); process.exitCode = 2; }
}
void main();
