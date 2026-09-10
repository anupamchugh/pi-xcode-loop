import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

export interface GitSnapshot { state: "present" | "unavailable"; branch?: string; commit?: string; dirty?: boolean; detail?: string; }
export async function readGitSnapshot(workspace: string, signal?: AbortSignal): Promise<GitSnapshot> {
  try {
    const [branch, commit, status] = await Promise.all([
      run("git", ["-C", workspace, "rev-parse", "--abbrev-ref", "HEAD"], { maxBuffer: 32_000, signal }),
      run("git", ["-C", workspace, "rev-parse", "HEAD"], { maxBuffer: 32_000, signal }),
      run("git", ["-C", workspace, "status", "--porcelain=v2"], { maxBuffer: 128_000, signal })
    ]);
    const name = branch.stdout.trim(); return { state: "present", ...(name === "HEAD" ? {} : { branch: name.slice(0, 200) }), commit: commit.stdout.trim().slice(0, 80), dirty: status.stdout.length > 0 };
  } catch (error) { return { state: "unavailable", detail: `git unavailable: ${error instanceof Error ? error.message.slice(0, 120) : "read error"}` }; }
}
