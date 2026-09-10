export type Verdict = "completed" | "failed" | "blocked" | "unknown";
export type EvidenceState = "present" | "missing" | "unavailable" | "not_requested";

export interface EvidenceSection {
  state: EvidenceState;
  detail?: string;
}

export interface TestEvidence extends EvidenceSection {
  executed: number;
  failed: number;
  expected?: number;
}

export interface Receipt {
  schema: "pi-xcode-loop.receipt.v1";
  verdict: Verdict;
  workspace: string;
  session: EvidenceSection & { path?: string; event?: string };
  git: EvidenceSection & { branch?: string; commit?: string; dirty?: boolean };
  tests: TestEvidence;
  review: EvidenceSection;
  integration: EvidenceSection;
  serving: EvidenceSection;
  diagnostics: string[];
}
