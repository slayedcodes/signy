import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../../../schema/change-contract.schema.json' with { type: 'json' };

export interface ContractValidationError {
  /** Which rule failed: `schema` for JSON Schema failures, otherwise a contract-lint rule. */
  rule: string;
  /** JSON Pointer to the offending value inside the Change Contract. */
  path: string;
  message: string;
}

export interface ContractValidationResult {
  ok: boolean;
  errors: ContractValidationError[];
}

/** A Change Contract as the v1 schema defines it. */
export interface ChangeContract {
  version: 1;
  slug: string;
  issue?: string;
  summary: string;
  scope: { files: string[]; symbols: string[] };
  interface?: Array<{ symbol: string; change: 'add' | 'modify' | 'remove'; signature?: string }>;
  dependencies?: Array<{ name: string; change: 'add' | 'remove' | 'bump'; range?: string }>;
  tests?: Array<{ file: string; name: string; change: 'add' | 'modify' | 'remove' }>;
  mustNotChange?: string[];
  forks?: Array<{ id: string; question: string; options: string[]; chosen: string; rationale?: string }>;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const checkSchema = ajv.compile(schema);

export interface ValidateOptions {
  /** Where the contract lives, e.g. `.contracts/<slug>.json`; enables the slug-matches-file rule. */
  file?: string;
}

/** Schema validation plus contract lint for one Change Contract. */
export function validateContract(contract: unknown, options: ValidateOptions = {}): ContractValidationResult {
  if (!checkSchema(contract)) {
    const errors = (checkSchema.errors ?? []).map((e) => ({
      rule: 'schema',
      path: e.instancePath,
      message: e.message ?? 'is invalid',
    }));
    return { ok: false, errors };
  }
  // Lint assumes the schema's shape, so it only runs on schema-valid contracts.
  const errors = lintContract(contract as unknown as ChangeContract, options);
  return { ok: errors.length === 0, errors };
}

function lintContract(contract: ChangeContract, options: ValidateOptions): ContractValidationError[] {
  const errors: ContractValidationError[] = [];
  const expectedSlug = options.file?.split(/[\\/]/).at(-1)?.replace(/\.json$/, '');
  if (expectedSlug !== undefined && contract.slug !== expectedSlug) {
    errors.push({
      rule: 'slug-matches-file',
      path: '/slug',
      message: `slug "${contract.slug}" must match the file name; expected "${expectedSlug}".`,
    });
  }
  if (contract.scope.files.length === 0) {
    errors.push({
      rule: 'scope-empty',
      path: '/scope/files',
      message: 'The scope lists no files; a Change Contract must name at least one file it will change.',
    });
  }
  contract.scope.files.forEach((file, i) => {
    if (isWiderThanOneDirectoryLevel(file)) {
      errors.push({
        rule: 'scope-glob-too-wide',
        path: `/scope/files/${i}`,
        message: `"${file}" matches more than one directory level; list the files or use a single-level glob such as "src/billing/*".`,
      });
    }
  });
  errors.push(...findDuplicates(contract.scope.symbols.map((s, i) => [s, `/scope/symbols/${i}`])));
  errors.push(
    ...findDuplicates((contract.interface ?? []).map((c, i) => [c.symbol, `/interface/${i}/symbol`])),
  );
  return errors;
}

function findDuplicates(entries: Array<[symbol: string, path: string]>): ContractValidationError[] {
  const firstSeenAt = new Map<string, string>();
  const errors: ContractValidationError[] = [];
  for (const [symbol, path] of entries) {
    const earlier = firstSeenAt.get(symbol);
    if (earlier === undefined) {
      firstSeenAt.set(symbol, path);
    } else {
      errors.push({ rule: 'duplicate-symbol', path, message: `"${symbol}" is already listed at ${earlier}.` });
    }
  }
  return errors;
}

/** `**` anywhere, or a wildcard in a directory segment, reaches past one directory level. */
function isWiderThanOneDirectoryLevel(glob: string): boolean {
  const segments = glob.split('/');
  const directories = segments.slice(0, -1);
  return glob.includes('**') || directories.some((s) => /[*?[{]/.test(s));
}
