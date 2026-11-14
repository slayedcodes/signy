/**
 * Reads git trailers (`Key: value` lines) from the last paragraph of a commit message.
 * Keys are lower-cased; a key that appears more than once keeps every value in order.
 */
export function readTrailers(message: string): Map<string, string[]> {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const trailers = new Map<string, string[]>();
  if (paragraphs.length < 2) return trailers;
  for (const line of paragraphs.at(-1)!.split('\n')) {
    const match = /^([A-Za-z0-9-]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    trailers.set(key, [...(trailers.get(key) ?? []), match[2]!]);
  }
  return trailers;
}
