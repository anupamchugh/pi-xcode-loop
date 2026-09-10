import { parseSessionLog } from "../core/parser.js";
import { makeReceipt } from "../core/receipt.js";
import { open, stat } from "node:fs/promises";
import type { ExtensionAPI } from "./pi-types.js";
export declare const MAX_TIMEOUT_MS = 30000;
interface Options {
    workspace: string;
    session?: string;
    result?: string;
    expected?: number;
    json: boolean;
    piSession?: boolean;
}
export declare function parseArguments(args: string, cwd: string): Options;
type PiSessionIO = {
    stat: typeof stat;
    open: typeof open;
};
export declare function readPiSession(path: string, signal: AbortSignal, io?: PiSessionIO): Promise<ReturnType<typeof parseSessionLog>>;
export declare function runStatus(options: Options, signal: AbortSignal): Promise<ReturnType<typeof makeReceipt>>;
export declare function withTimeout<T>(task: Promise<T>, timeoutMs: number, signal: AbortSignal, onTimeout: () => void): Promise<T>;
export default function xcodeLoopExtension(pi: ExtensionAPI): void;
export {};
