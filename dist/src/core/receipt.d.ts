import type { Receipt } from "./types.js";
import type { SessionEvents } from "./parser.js";
import type { GitSnapshot } from "./git.js";
import type { ResultSummary } from "./xcresult.js";
export declare function makeReceipt(workspace: string, sessionPath: string | undefined, session: SessionEvents, git: GitSnapshot, result: ResultSummary | undefined, expected?: number): Receipt;
