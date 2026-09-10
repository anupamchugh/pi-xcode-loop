export interface ResultSummary {
    state: "present" | "unavailable";
    executed?: number;
    failed?: number;
    detail?: string;
}
export interface IssueLocation {
    path: string;
    line?: number;
    column?: number;
}
export interface IssueRecord {
    key: string;
    severity: "error" | "warning" | "notice" | "unknown";
    type: string;
    target: string;
    message: string;
    location?: IssueLocation;
}
export interface IssuesReceipt {
    schema: "pi-xcode-loop.issues.v1";
    records: IssueRecord[];
    truncated: boolean;
    diagnostics: string[];
    provenance?: {
        bundle: {
            path: string;
            digest?: string;
        };
        tool: {
            command: string[];
            commands: string[][];
            schema: string[];
        };
        git: {
            state: "present" | "unavailable";
            branch?: string;
            commit?: string;
        };
    };
}
export declare function parseResultSummary(stdout: string): ResultSummary;
export declare function parseIssues(build: unknown, tests: unknown, workspace: string, options?: {
    maxRecords?: number;
}): IssuesReceipt;
export declare function readResultSummary(bundle: string, signal?: AbortSignal): Promise<ResultSummary>;
export declare function readIssues(bundle: string, workspace: string, signal?: AbortSignal): Promise<IssuesReceipt>;
export declare function bundleDigest(bundle: string): Promise<string | undefined>;
