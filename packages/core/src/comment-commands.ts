export interface ApproveCommand {
  /** The Contract Version the command names; when omitted it means the current contract's hash. */
  hash?: string;
}

const APPROVE = /^\/contract\s+approve(?:\s+(sha256:[0-9a-f]{64}))?$/;

/** The `/contract approve` commands in a comment, one per line (PLAN.md §6). */
export function parseApproveCommands(body: string): ApproveCommand[] {
  return body
    .split(/\r?\n/)
    .map((line) => APPROVE.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => (match[1] ? { hash: match[1] } : {}));
}
