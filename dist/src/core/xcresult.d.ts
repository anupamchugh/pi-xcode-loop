export interface ResultSummary {
    state: "present" | "unavailable";
    executed?: number;
    failed?: number;
    detail?: string;
}
export declare function parseResultSummary(stdout: string): ResultSummary;
export declare function readResultSummary(bundle: string, signal?: AbortSignal): Promise<ResultSummary>;
