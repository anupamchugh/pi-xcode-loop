export interface GitSnapshot {
    state: "present" | "unavailable";
    branch?: string;
    commit?: string;
    dirty?: boolean;
    detail?: string;
}
export declare function readGitSnapshot(workspace: string, signal?: AbortSignal): Promise<GitSnapshot>;
