import { detectAgent } from './agent-detection.js';
import { checkApproval } from './approval.js';
import { checkContractStructure } from './contract-structure.js';
import { resolveConfig, type GateConfig } from './config.js';

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
}

export interface GateFailure {
  /** The exact rule that failed. */
  rule: string;
  message: string;
  /** The commit the failure is about, when there is one. */
  commit?: string;
}

export interface GateResult {
  status: 'pass' | 'fail';
  /** False when the PR isn't an Agent-authored PR, so the gate doesn't apply. */
  applicable: boolean;
  notes: string[];
  failures: GateFailure[];
}

/** The gate pipeline (PLAN.md §5). Every check runs; failures are collected, not short-circuited. */
export async function runGate(input: GateInput): Promise<GateResult> {
  const config = resolveConfig(input.config);
  const detection = detectAgent(input, config);
  if (!detection.agentAuthored) {
    return { status: 'pass', applicable: false, notes: [detection.note], failures: [] };
  }

  const notes = [detection.note];
  const structure = await checkContractStructure(input);
  const failures: GateFailure[] = [...structure.failures];
  if (structure.contract) {
    const approval = checkApproval(input, structure.contract, config);
    if (approval.note) notes.push(approval.note);
    failures.push(...approval.failures);
  }
  return { status: failures.length > 0 ? 'fail' : 'pass', applicable: true, notes, failures };
}
