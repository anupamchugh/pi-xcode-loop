export function makeReceipt(workspace, sessionPath, session, git, result, expected) {
    const tests = result?.state === "present"
        ? { state: result.executed && result.executed > 0 ? "present" : "missing", executed: result.executed ?? 0, failed: result.failed ?? 0, ...(expected === undefined ? {} : { expected }) }
        : result?.state === "unavailable" ? { state: "unavailable", executed: 0, failed: 0, ...(expected === undefined ? {} : { expected }) }
            : session.testHint
                ? { state: session.testHint.executed > 0 ? "present" : "missing", executed: session.testHint.executed, failed: session.testHint.failed, ...(expected === undefined ? {} : { expected }) }
                : { state: result ? "unavailable" : "missing", executed: 0, failed: 0, ...(expected === undefined ? {} : { expected }) };
    const sessionEvidence = { state: session.diagnostics.some(d => d.includes("unavailable")) ? "unavailable" : sessionPath ? "present" : "missing", ...(sessionPath === undefined ? {} : { path: sessionPath }), ...(session.lastEvent === undefined ? {} : { event: session.lastEvent }) };
    const gitEvidence = { state: git.state, ...(git.branch === undefined ? {} : { branch: git.branch }), ...(git.commit === undefined ? {} : { commit: git.commit }), ...(git.dirty === undefined ? {} : { dirty: git.dirty }), ...(git.detail === undefined ? {} : { detail: git.detail }) };
    const diagnostics = [...session.diagnostics, ...(git.detail ? [git.detail] : []), ...(result?.detail ? [result.detail] : [])];
    let verdict = "unknown";
    if (session.cancelled || session.failed || tests.failed > 0)
        verdict = session.cancelled ? "blocked" : "failed";
    else if (session.completed && !session.truncated && session.malformedLines === 0 && tests.state === "present" && tests.executed > 0 && (expected === undefined || tests.executed >= expected))
        verdict = "completed";
    else if (session.completed || sessionEvidence.state === "unavailable")
        verdict = "unknown";
    const section = (state) => ({ state });
    return { schema: "pi-xcode-loop.receipt.v1", verdict, workspace, session: sessionEvidence, git: gitEvidence, tests, review: section("not_requested"), integration: section("not_requested"), serving: section("not_requested"), diagnostics };
}
