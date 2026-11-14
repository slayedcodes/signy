import type { FileChange } from './types.js';
import type { ChangeContract } from './validate-contract.js';

type DependencyClause = NonNullable<ChangeContract['dependencies']>[number];

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

export interface DependencyChange {
  name: string;
  change: 'add' | 'remove' | 'bump';
  from?: string;
  to?: string;
  /** The package.json it happened in, and which dependency field. */
  manifest: string;
  field: DependencyField;
}

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']);

export const isManifest = (path: string) => path === 'package.json' || path.endsWith('/package.json');
export const isLockfile = (path: string) => LOCKFILES.has(path.split('/').at(-1)!);

type Manifest = Record<string, unknown>;

function parseManifest(text: string | undefined): Manifest | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

/** Every declared dependency, keyed by field and name, so the same name in two fields is two entries. */
function dependencyRanges(manifest: Manifest): Map<string, { field: DependencyField; name: string; range: string }> {
  const ranges = new Map<string, { field: DependencyField; name: string; range: string }>();
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (deps && typeof deps === 'object') {
      for (const [name, range] of Object.entries(deps)) ranges.set(`${field}\0${name}`, { field, name, range: String(range) });
    }
  }
  return ranges;
}

function withoutDependencies(manifest: Manifest): string {
  const rest = { ...manifest };
  for (const field of DEPENDENCY_FIELDS) delete rest[field];
  return JSON.stringify(rest);
}

/**
 * Diffs one package.json. An added or deleted manifest counts as empty on its missing side.
 * `otherFieldsChanged` says whether anything besides the dependency fields changed, in which
 * case the file is also an ordinary scope matter. A manifest that can't be parsed is only that.
 */
export function diffManifest(
  change: FileChange,
  before: string | undefined,
  after: string | undefined,
): { dependencyChanges: DependencyChange[]; otherFieldsChanged: boolean } {
  const previous = change.status === 'added' ? {} : parseManifest(before);
  const current = change.status === 'deleted' ? {} : parseManifest(after);
  if (!previous || !current) return { dependencyChanges: [], otherFieldsChanged: true };

  const [previousRanges, currentRanges] = [dependencyRanges(previous), dependencyRanges(current)];
  const dependencyChanges: DependencyChange[] = [];
  const manifest = change.path;
  for (const [key, { field, name, range: to }] of currentRanges) {
    const from = previousRanges.get(key)?.range;
    if (from === undefined) dependencyChanges.push({ name, change: 'add', to, manifest, field });
    else if (from !== to) dependencyChanges.push({ name, change: 'bump', from, to, manifest, field });
  }
  for (const [key, { field, name, range: from }] of previousRanges) {
    if (!currentRanges.has(key)) dependencyChanges.push({ name, change: 'remove', from, manifest, field });
  }
  dependencyChanges.sort((a, b) => a.name.localeCompare(b.name) || a.field.localeCompare(b.field));
  const otherFieldsChanged = change.status !== 'modified' || withoutDependencies(previous) !== withoutDependencies(current);
  return { dependencyChanges, otherFieldsChanged };
}

/** A Clause allows a change when name and kind match, and its range (if any) is the new range. */
export function clauseAllows(clause: DependencyClause, change: DependencyChange): boolean {
  if (clause.name !== change.name || clause.change !== change.change) return false;
  return clause.range === undefined || change.change === 'remove' || clause.range === change.to;
}

export function describeDependencyChange(c: DependencyChange): string {
  const where = `${c.manifest} ${c.field}`;
  if (c.change === 'add') return `${c.name} ${c.to} is added to ${where}`;
  if (c.change === 'remove') return `${c.name} is removed from ${where}`;
  return `${c.name} is bumped from ${c.from} to ${c.to} in ${where}`;
}

const GERUND = { add: 'adding', remove: 'removing', bump: 'bumping' } as const;

export function describeDependencyClause(clause: DependencyClause): string {
  return `${GERUND[clause.change]} ${clause.name}${clause.range ? ` ${clause.range}` : ''}`;
}
