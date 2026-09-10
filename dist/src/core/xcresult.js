import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
export function parseResultSummary(stdout) {
    const value = JSON.parse(stdout);
    const executed = value.totalTestCount;
    const failed = value.failedTests;
    if (typeof executed !== "number" || !Number.isSafeInteger(executed) || executed < 0 || typeof failed !== "number" || !Number.isSafeInteger(failed) || failed < 0 || failed > executed)
        throw new Error("invalid xcresult summary");
    return { state: "present", executed, failed };
}
export async function readResultSummary(bundle, signal) {
    try {
        const { stdout } = await run("xcrun", ["xcresulttool", "get", "test-results", "summary", "--path", bundle, "--format", "json"], { maxBuffer: 1_000_000, signal });
        return parseResultSummary(stdout);
    }
    catch (error) {
        return { state: "unavailable", detail: `result bundle unavailable: ${error instanceof Error ? error.message.slice(0, 120) : "read error"}` };
    }
}
