import { createHash } from 'node:crypto';
import type { ResolvedConfig } from './config.js';
import {
  clauseAllows,
  describeDependencyChange,
  describeDependencyClause,
  diffManifest,
  isLockfile,
  isManifest,
  type DependencyChange,
} from './dependencies.js';
import { matchesGlob } from './glob.js';
import type { Deviation, DeviationCheck, DeviationKind, FileChange, GateInput } from './types.js';
import type { ChangeContract } from './validate-contract.js';

/** The facts that identify one Deviation, before an ID or Sign-off status is attached. */
interface Finding {
  kind: DeviationKind;
  check: DeviationCheck;
  target: string;
  detail: string;
  /** What the Deviation consists of; any change to it gives a new Deviation Fingerprint. */
  content: string;
}

/** Step 4 of the gate: compare the change (head vs its merge-base) with the Change Contract. */
export async function detectDeviations(
  input: GateInput,
  contract: ChangeContract,
  config: ResolvedConfig,
): Promise<Deviation[]> {
  const { mergeBase, files } = await input.git.diff(input.pr.base, input.pr.head);
  // The structure rules govern .contracts/; Deviations are about everything else.
  const changes = files.filter((f) => !f.path.startsWith('.contracts/'));
  const fileFindings: Finding[] = [];
  const dependencyChanges: DependencyChange[] = [];
  const lockfileFindings: Finding[] = [];

  for (const change of changes) {
    const before = await input.git.readFile(mergeBase, change.path);
    const after = await input.git.readFile(input.pr.head, change.path);
    const content = `${change.status}\n${before ?? ''}\n\0\n${after ?? ''}`;

    const protectedBy = mustNotChangeFinding(change, contract);
    if (protectedBy) {
      fileFindings.push({ ...protectedBy, content });
      continue;
    }
    if (isManifest(change.path)) {
      const manifest = diffManifest(change, before, after);
      dependencyChanges.push(...manifest.dependencyChanges);
      if (!manifest.otherFieldsChanged) continue;
    }
    if (isLockfile(change.path)) {
      lockfileFindings.push({
        kind: 'unplanned-change',
        check: 'dependencies',
        target: change.path,
        detail: `${change.path} changes, but the change neither declares nor makes a dependency change.`,
        content,
      });
      continue;
    }
    const outOfScope = scopeFinding(change, contract, config);
    if (outOfScope) fileFindings.push({ ...outOfScope, content });
  }

  const clauses = contract.dependencies ?? [];
  const dependencyFindings: Finding[] = dependencyChanges
    .filter((dc) => !clauses.some((clause) => clauseAllows(clause, dc)))
    .map((dc) => ({
      kind: 'unplanned-change',
      check: 'dependencies',
      target: dc.name,
      detail: `${describeDependencyChange(dc)}, but no dependencies Clause allows it.`,
      // The lockfiles are part of what a reviewer accepts: changing one afterwards lapses the Sign-off.
      content: [dc.manifest, dc.field, dc.change, dc.from ?? '', dc.to ?? '', ...lockfileFindings.map((l) => l.content)].join('\n'),
    }));
  // A lockfile may change freely alongside a dependency change that is declared or made.
  const lockfilesExplained = clauses.length > 0 || dependencyChanges.length > 0;
  const unmetFindings: Finding[] = clauses
    .filter((clause) => !dependencyChanges.some((dc) => clauseAllows(clause, dc)))
    .map((clause) => ({
      kind: 'unmet-clause',
      check: 'dependencies',
      target: clause.name,
      detail: `The Change Contract declares ${describeDependencyClause(clause)}, but the change doesn't.`,
      content: JSON.stringify(clause),
    }));

  return [...fileFindings, ...dependencyFindings, ...(lockfilesExplained ? [] : lockfileFindings), ...unmetFindings].map(
    toDeviation,
  );
}

function mustNotChangeFinding(change: FileChange, contract: ChangeContract): Omit<Finding, 'content'> | undefined {
  const protectedBy = (contract.mustNotChange ?? []).find((entry) => mustNotChangeCovers(entry, change.path));
  if (!protectedBy) return undefined;
  return {
    kind: 'unplanned-change',
    check: 'must-not-change',
    target: change.path,
    detail: `${change.path} is ${change.status}, but the Change Contract says ${protectedBy} must not change.`,
  };
}

/** An out-of-scope file is a scope Deviation, or a ci-config one if it's a CI or config file. */
function scopeFinding(
  change: FileChange,
  contract: ChangeContract,
  config: ResolvedConfig,
): Omit<Finding, 'content'> | undefined {
  if (contract.scope.files.some((glob) => matchesGlob(change.path, glob))) return undefined;
  if (config.ciConfigFiles.some((glob) => matchesGlob(change.path, glob))) {
    return {
      kind: 'unplanned-change',
      check: 'ci-config',
      target: change.path,
      detail: `${change.path} is a CI or config file and is ${change.status}, but no scope Clause covers it.`,
    };
  }
  return {
    kind: 'unplanned-change',
    check: 'scope',
    target: change.path,
    detail: `${change.path} is ${change.status}, but no scope Clause covers it.`,
  };
}

/**
 * A path glob, or `path#*` for every symbol in a file, covers whole files. A single symbol
 * (`path#Name`) needs symbol-level detection, which arrives with milestone 4.
 */
function mustNotChangeCovers(entry: string, path: string): boolean {
  const [glob, symbol] = entry.split('#');
  if (symbol !== undefined && symbol !== '*') return false;
  return matchesGlob(path, glob!);
}

function toDeviation(finding: Finding): Deviation {
  const fingerprint = deviationFingerprint(finding);
  const { kind, check, target, detail } = finding;
  return { id: `D${fingerprint.slice(0, 16)}`, fingerprint, kind, check, target, detail, status: 'unsigned' };
}

/** sha256 of kind, check, target and normalized content (ADR 0004). Changing this lapses every Sign-off. */
export function deviationFingerprint(finding: Pick<Finding, 'kind' | 'check' | 'target' | 'content'>): string {
  const content = finding.content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
  return createHash('sha256').update(`${finding.kind}/${finding.check}\n${finding.target}\n${content}`, 'utf8').digest('hex');
}
