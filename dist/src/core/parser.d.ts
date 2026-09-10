export declare const DEFAULT_MAX_BYTES = 1000000;
export declare const DEFAULT_MAX_LINES = 20000;
export interface SessionEvents {
    lastEvent?: string;
    completed: boolean;
    failed: boolean;
    cancelled: boolean;
    protocolError: boolean;
    malformedLines: number;
    truncated: boolean;
    diagnostics: string[];
    testHint?: {
        executed: number;
        failed: number;
    } | undefined;
}
export declare function parseSessionLog(input: string, maxLines?: number): SessionEvents;
export declare function readSessionLog(path: string, maxBytes?: number): Promise<SessionEvents>;
