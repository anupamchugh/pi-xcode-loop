import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
const roots = ["src", "test", "bin"]; let files = ["package.json", "tsconfig.json"];
async function walk(root) { for (const name of await readdir(root)) { const path = `${root}/${name}`; if ((await stat(path)).isDirectory()) await walk(path); else files.push(path); } }
for (const root of roots) await walk(root);
for (const file of files) { const code = await new Promise(resolve => { const p = spawn("git", ["diff", "--no-index", "--check", "/dev/null", file], { stdio: ["ignore", "pipe", "pipe"] }); let output = ""; p.stdout.on("data", d => output += d); p.stderr.on("data", d => output += d); p.on("close", c => resolve(c === 1 && /trailing whitespace|space before tab/.test(output) ? 1 : c > 1 ? c : 0)); }); if (code !== 0) process.exitCode = 1; }
