/**
 * Matches repo paths against globs: `*` and `?` stay within one path segment,
 * `**` spans any number of segments. Everything else is literal.
 */
export function matchesGlob(path: string, glob: string): boolean {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*' && glob[i + 1] === '*') {
      const slashAfter = glob[i + 2] === '/';
      pattern += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`).test(path);
}
