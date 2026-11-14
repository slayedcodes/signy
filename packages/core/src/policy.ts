import type { ResolvedConfig } from './config.js';
import type { GateComment } from './gate.js';
import { listOr, sameLogin } from './text.js';

/**
 * Applies the Sign-off Policy to the author of a comment. It governs both Contract
 * Approvals and Sign-offs. Returns why the author is refused, or undefined if allowed.
 */
export function refusalUnderPolicy(
  comment: GateComment,
  prAuthor: string,
  config: ResolvedConfig,
): string | undefined {
  const policy = config.signoffPolicy;
  if (comment.isBot) return 'they are a bot account.';
  if (!policy.allowPrAuthor && sameLogin(comment.author, prAuthor)) return 'they are the PR author.';
  if (!policy.permissions.includes(comment.permission)) {
    return `their permission is ${comment.permission}; the policy requires ${listOr(policy.permissions)}.`;
  }
  return undefined;
}
