import { makeReceipt, parseSessionLog } from "pi-xcode-loop";
const receipt = makeReceipt("workspace", undefined, parseSessionLog(""), { state: "unavailable" }, undefined);
const verdict: "completed" | "failed" | "blocked" | "unknown" = receipt.verdict;
void verdict;
