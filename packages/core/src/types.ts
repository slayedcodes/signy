import type { GateConfig } from './config.js';

/** Reads repository content. The core's only window onto git. */
export interface GitReader {
  /** Content of `path` at `ref`, or `undefined` if the file doesn't exist there. */
  readFile(ref: string, path: string): Promise<string | undefined>;
  /** The files `head` changes relative to its merge-base with `base`, and that merge-base. */
  diff(base: string, head: string): Promise<{ mergeBase: string; files: FileChange[] }>;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted';

export interface FileChange {
  path: string;
  status: FileChangeStatus;
}

export interface GateCommit {
  sha: string;
  /** Parent SHAs, first parent first. The list of commits is ordered parents-first. */
  parents: string[];
  author: CommitAuthor;
  message: string;
  files: FileChange[];
  /** Committer date (ISO 8601). Settable by anyone, so it feeds metrics only, never a rule. */
  committedAt?: string;
  /** Whether the code host verified the commit's signature; set only when `GateInput.hostVerifiesSignatures`. */
  signatureVerified?: boolean;
}

export type Permission = 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';

export interface GateComment {
  author: string;
  /** The author's permission on the repo, as the code host reports it. */
  permission: Permission;
  isBot: boolean;
  createdAt: string;
  url: string;
  body: string;
}

/** The identity the gate bot commits as; only it may author an Approval Commit. */
export interface BotIdentity {
  name: string;
  email: string;
}

export interface GateInput {
  pr: { author: string; labels: string[]; branch: string; base: string; head: string };
  /** The PR's commits, oldest first. */
  commits: GateCommit[];
  git: GitReader;
  comments: GateComment[];
  config: GateConfig;
  bot: BotIdentity;
  /**
   * A local run (`contract check`) has no PR thread: it treats the change as agent-authored
   * and can't verify approval comments or Sign-offs.
   */
  local?: boolean;
  /**
   * The host adapter reports `signatureVerified` on every commit. The gate then trusts only an
   * Approval Commit the host verified, since only the gate's push gets the host's signature (ADR 0003).
   */
  hostVerifiesSignatures?: boolean;
}

export interface GateFailure {
  /** The exact rule that failed. */
  rule: string;
  message: string;
  /** The commit the failure is about, when there is one. */
  commit?: string;
}

export type DeviationKind = 'unplanned-change' | 'unmet-clause';

/** Which check found the Deviation. */
export type DeviationCheck = 'scope' | 'ci-config' | 'dependencies' | 'must-not-change' | 'interface' | 'tests';

export type SignoffDecision = 'accept' | 'reject';

export interface Signoff {
  decision: SignoffDecision;
  reason: string;
  by: string;
  at: string;
  url: string;
}

export interface Deviation {
  /** Display ID: `D` plus the first 16 hex characters of the fingerprint (ADR 0004). */
  id: string;
  /** The Deviation Fingerprint: sha256 of kind, check, target and normalized content. */
  fingerprint: string;
  kind: DeviationKind;
  check: DeviationCheck;
  /** What the Deviation is about: a path, or a dependency name. */
  target: string;
  detail: string;
  status: 'accepted' | 'rejected' | 'unsigned';
  /** The Sign-off that decided the status, if any. */
  signoff?: Signoff;
}

export type CommandRule =
  | 'command-unreadable'
  | 'command-unknown'
  | 'signoff-needs-reason'
  | 'signoff-not-allowed'
  | 'signoff-lapsed';

/** A comment command the gate couldn't act on; the host adapter replies with the message. */
export interface CommandError {
  /** Which command rule the line broke. */
  rule: CommandRule;
  commentUrl: string;
  author: string;
  line: string;
  message: string;
}

export interface GateResult {
  status: 'pass' | 'fail';
  /** False when the PR isn't an Agent-authored PR, so the gate doesn't apply. */
  applicable: boolean;
  notes: string[];
  failures: GateFailure[];
  deviations: Deviation[];
  commandErrors: CommandError[];
  /** The Contract Approval the gate accepted, if any. */
  approval?: ContractApproval;
}

export interface ContractApproval {
  by: string;
  /** The Approval Commit. */
  commit: string;
  /** The `/contract approve` comment; unknown in a local run. */
  commentUrl?: string;
  approvedAt?: string;
}
