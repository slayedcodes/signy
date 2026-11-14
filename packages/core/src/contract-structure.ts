import { createHash } from 'node:crypto';
import type { FileChange, GateCommit, GateFailure, GateInput } from './types.js';
import { listAnd, shortSha } from './text.js';
import { validateContract, type ChangeContract } from './validate-contract.js';

/** The one Change Contract the Contract Commit added. */
export interface LocatedContract {
  path: string;
  commit: GateCommit;
  /** `sha256:<hex>` of the file's exact content: the Contract Version that gets approved. */
  hash: string;
  /** The parsed contract, when it passes the schema. */
  document?: ChangeContract;
}

export interface StructureCheck {
  contract?: LocatedContract;
  failures: GateFailure[];
}

const isContractFile = (path: string) => /^\.contracts\/[^/]+\.json$/.test(path);
const isAddedContract = (f: FileChange) => f.status === 'added' && isContractFile(f.path);
const CHANGE_VERB = { added: 'adds', deleted: 'deletes', modified: 'edits' } as const;

/** Step 2 of the gate: the Contract Commit, later commits, and the contract's own validity. */
export async function checkContractStructure(input: GateInput): Promise<StructureCheck> {
  const [first, ...afterContractCommit] = input.commits;
  if (!first || !input.commits.some((c) => c.files.some(isAddedContract))) {
    return {
      failures: [
        {
          rule: 'contract-missing',
          message:
            "This Agent-authored PR has no Change Contract. Run `contract init` to draft one, and make it the PR's first commit.",
        },
      ],
    };
  }

  const failures: GateFailure[] = [];
  const added = first.files.filter(isAddedContract);
  const contractCommitFailure = (rule: string, message: string) =>
    failures.push({ rule, message, commit: first.sha });

  if (added.length === 0) {
    contractCommitFailure('contract-commit-empty', `The PR's first commit ${shortSha(first.sha)} must be the Contract Commit, but it adds no Change Contract.`);
  } else {
    if (added.length > 1) {
      contractCommitFailure(
        'contract-commit-multiple',
        `The Contract Commit ${shortSha(first.sha)} adds ${added.length} Change Contracts (${added.map((f) => f.path).join(', ')}); a PR has exactly one.`,
      );
    }
    const extraFiles = first.files.filter((f) => !added.includes(f));
    if (extraFiles.length > 0) {
      contractCommitFailure(
        'contract-commit-extra-files',
        `The Contract Commit ${shortSha(first.sha)} must add only the Change Contract, but it also changes ${listAnd(extraFiles.map((f) => f.path))}.`,
      );
    }
  }

  for (const commit of afterContractCommit) {
    // Any path under .contracts/, not only contract-shaped ones, so nothing hides beside the contracts.
    const touched = commit.files.filter((f) => f.path.startsWith('.contracts/'));
    if (touched.length === 0) continue;
    failures.push({
      rule: 'contract-changed-later',
      message: `Commit ${shortSha(commit.sha)} ${listAnd(touched.map((f) => `${CHANGE_VERB[f.status]} ${f.path}`))}. After the Contract Commit no commit may add, delete or edit anything under .contracts/; a change of scope needs a new Contract Version and a fresh Contract Approval.`,
      commit: commit.sha,
    });
  }

  // Without exactly one contract in the Contract Commit there is no single Contract Version to approve.
  if (added.length !== 1) return { failures };
  const path = added[0]!.path;
  const content = (await input.git.readFile(first.sha, path)) ?? '';
  const validity = checkContractValidity(path, content, first);
  failures.push(...validity.failures);
  return { contract: { path, commit: first, hash: contractHash(content), document: validity.document }, failures };
}

function checkContractValidity(
  path: string,
  content: string,
  commit: GateCommit,
): { failures: GateFailure[]; document?: ChangeContract } {
  const invalid = (message: string): GateFailure => ({ rule: 'contract-invalid', message, commit: commit.sha });
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { failures: [invalid(`${path} is not valid JSON.`)] };
  }
  const { errors } = validateContract(parsed, { file: path });
  const failures = errors.map((e) => invalid(`${path} ${e.path || '/'} [${e.rule}] ${e.message}`));
  // Lint failures still leave a well-formed contract that Deviation detection can use.
  const schemaValid = errors.every((e) => e.rule !== 'schema');
  return schemaValid ? { failures, document: parsed as ChangeContract } : { failures };
}

export function contractHash(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}
