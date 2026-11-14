export const shortSha = (sha: string): string => sha.slice(0, 7);

/** "a", "a and b", "a, b and c". */
export const listAnd = (items: readonly string[]): string => joinWith(items, 'and');

/** "a", "a or b", "a, b or c". */
export const listOr = (items: readonly string[]): string => joinWith(items, 'or');

function joinWith(items: readonly string[], word: string): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`;
}

/** Code-host logins are case-insensitive. */
export const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
