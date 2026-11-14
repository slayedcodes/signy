/** Reads repository content at a given ref. The core's only window onto git. */
export interface GitReader {
  /** Content of `path` at `ref`, or `undefined` if the file doesn't exist there. */
  readFile(ref: string, path: string): Promise<string | undefined>;
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
  author: CommitAuthor;
  message: string;
  files: FileChange[];
}

export interface GateComment {
  author: string;
  /** The author's permission on the repo, as the code host reports it. */
  permission: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none';
  isBot: boolean;
  createdAt: string;
  url: string;
  body: string;
}

/** Agent detection rules and the Sign-off Policy arrive in milestone 2. */
export type GateConfig = Record<string, unknown>;

/** The identity the gate bot commits as; only it may author an Approval Commit. */
export interface BotIdentity {
  name: string;
  email: string;
}

export interface GateInput {
  pr: { author: string; base: string; head: string };
  /** The PR's commits, oldest first. */
  commits: GateCommit[];
  git: GitReader;
  comments: GateComment[];
  config: GateConfig;
  bot: BotIdentity;
}

export interface GateResult {
  status: 'pass' | 'fail';
  /** False when the PR isn't an Agent-authored PR, so the gate doesn't apply. */
  applicable: boolean;
  notes: string[];
}

/** The gate pipeline (PLAN.md §5). Milestone 1: every PR is treated as not agent-authored. */
export async function runGate(_input: GateInput): Promise<GateResult> {
  return {
    status: 'pass',
    applicable: false,
    notes: ['Not an Agent-authored PR; the Change Contract gate does not apply.'],
  };
}
