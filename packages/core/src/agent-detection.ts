import type { ResolvedConfig } from './config.js';
import type { GateInput } from './gate.js';
import { shortSha } from './text.js';
import { readTrailers } from './trailers.js';

export interface AgentDetection {
  agentAuthored: boolean;
  /** Why the PR was (or wasn't) treated as an Agent-authored PR. */
  note: string;
}

const NOT_APPLICABLE = 'Not an Agent-authored PR; the Change Contract gate does not apply.';

/**
 * Step 1 of the gate: apply the configured agent-detection rules; any match counts.
 * Override labels win over the rules, and the "required" override wins over "exempt".
 */
export function detectAgent(input: GateInput, config: ResolvedConfig): AgentDetection {
  const rules = config.agentDetection;
  const { pr } = input;
  const agent = (reason: string): AgentDetection => ({ agentAuthored: true, note: `Agent-authored PR: ${reason}.` });

  if (pr.labels.includes(rules.requireLabel)) return agent(`the ${rules.requireLabel} label marks it as one`);
  if (pr.labels.includes(rules.exemptLabel)) {
    return {
      agentAuthored: false,
      note: `The ${rules.exemptLabel} label marks this PR as not agent-authored; the Change Contract gate does not apply.`,
    };
  }

  if (rules.agentAccounts.some((login) => login.toLowerCase() === pr.author.toLowerCase())) {
    return agent(`its author ${pr.author} is a known agent account`);
  }
  for (const commit of input.commits) {
    for (const coAuthor of readTrailers(commit.message).get('co-authored-by') ?? []) {
      if (rules.coAuthorAgents.some((name) => containsWord(coAuthor, name))) {
        return agent(`commit ${shortSha(commit.sha)} has a Co-Authored-By trailer naming a known agent (${coAuthor})`);
      }
    }
  }
  const label = rules.labels.find((l) => pr.labels.includes(l));
  if (label) return agent(`it has the ${label} label`);
  const pattern = rules.branchPatterns.find((p) => globToRegExp(p).test(pr.branch));
  if (pattern) return agent(`its branch ${pr.branch} matches the agent branch pattern ${pattern}`);

  return { agentAuthored: false, note: NOT_APPLICABLE };
}

function containsWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}($|[^a-z0-9])`, 'i').test(text);
}

/** `*` matches any run of characters, including `/`. */
function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map(escapeRegExp).join('.*')}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
