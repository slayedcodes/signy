import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Io } from './main.js';

const USAGE = 'Usage: contract init --issue <url|text> [--slug <slug>] [--summary <text>] [--scope <path>]...\n';
const SCHEMA_URL = 'https://raw.githubusercontent.com/slayedcodes/signy/main/schema/change-contract.schema.json';
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const slugError = (slug: string) => `--slug ${slug} isn't a slug: use lowercase words joined by hyphens, like add-retry.`;

/**
 * `contract init`: scaffolds `.contracts/<slug>.json` from a template. Anything missing is
 * asked for on a terminal; without one, init names the flags to pass. It never commits.
 */
export async function init(args: string[], io: Io): Promise<number> {
  let options;
  try {
    options = parseArgs({
      args,
      options: {
        issue: { type: 'string' },
        slug: { type: 'string' },
        summary: { type: 'string' },
        scope: { type: 'string', multiple: true, default: [] },
      },
    }).values;
  } catch (error) {
    io.stderr(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (!options.issue) {
    io.stderr(USAGE);
    return 2;
  }

  // An issue given as text is the summary's first draft; a link needs a summary of its own.
  const issueIsLink = /^https?:\/\//.test(options.issue);
  let summary = (options.summary ?? (issueIsLink ? '' : options.issue)).trim();
  let slug = options.slug;
  if (slug !== undefined && !SLUG.test(slug)) {
    io.stderr(`${slugError(slug)}\n`);
    return 2;
  }
  if (!io.prompt) {
    const missing = [summary === '' && '--summary', slug === undefined && !SLUG.test(slugFrom(summary)) && '--slug'].filter(
      (m): m is string => Boolean(m),
    );
    if (missing.length > 0) {
      io.stderr(`Missing ${missing.join(' and ')}, and there is no terminal to ask for ${missing.length > 1 ? 'them' : 'it'} on.\n`);
      return 2;
    }
  }
  while (summary === '') summary = (await io.prompt!('Summary (why this change exists, in one paragraph): ')).trim();
  const suggested = slugFrom(summary);
  while (slug === undefined || !SLUG.test(slug)) {
    if (!io.prompt) {
      slug = suggested;
      break;
    }
    if (slug !== undefined) io.stderr(`${slugError(slug)}\n`);
    const answer = (await io.prompt(SLUG.test(suggested) ? `Slug [${suggested}]: ` : 'Slug: ')).trim();
    slug = answer || (SLUG.test(suggested) ? suggested : undefined);
  }

  const path = `.contracts/${slug}.json`;
  if (existsSync(resolve(io.cwd, path))) {
    io.stderr(`${path} already exists. Choose another slug for a new Change Contract.\n`);
    return 1;
  }
  const contract = {
    $schema: SCHEMA_URL,
    version: 1,
    slug,
    issue: options.issue,
    summary,
    scope: { files: options.scope, symbols: [] },
    interface: [],
    dependencies: [],
    tests: [],
    mustNotChange: [],
    forks: [],
  };
  mkdirSync(resolve(io.cwd, '.contracts'), { recursive: true });
  writeFileSync(resolve(io.cwd, path), `${JSON.stringify(contract, null, 2)}\n`);
  io.stdout(
    `Wrote ${path}.\nNext: fill in the scope and the Clauses, run \`contract validate\`, then commit the Change Contract on its own as the first commit of the PR.\n`,
  );
  return 0;
}

/** The first six words, kebab-cased: "Retry 503s in billing." → `retry-503s-in-billing`. */
function slugFrom(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join('-');
}
