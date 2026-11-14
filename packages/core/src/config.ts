import type { Permission } from './gate.js';

/** Rules that mark a PR as an Agent-authored PR. Any match counts. */
export interface AgentDetectionConfig {
  /** PR author logins of known agent accounts (case-insensitive). */
  agentAccounts?: string[];
  /** Case-insensitive words; a `Co-Authored-By` trailer containing one marks the PR as agent-authored. */
  coAuthorAgents?: string[];
  /** Labels that mark the PR as agent-authored. */
  labels?: string[];
  /** Branch-name globs; `*` matches anything, including `/`. */
  branchPatterns?: string[];
  /** Override label: the PR needs a Change Contract whatever the rules say. Wins over `exemptLabel`. */
  requireLabel?: string;
  /** Override label: the PR is not agent-authored whatever the rules say. */
  exemptLabel?: string;
}

/** Who may give Contract Approvals and Sign-offs. Bots never may. */
export interface SignoffPolicyConfig {
  /** Repo permissions that qualify. Default: admin, maintain, write. */
  permissions?: Permission[];
  /** Whether the PR author may approve or sign off their own PR. Default: false. */
  allowPrAuthor?: boolean;
}

export interface GateConfig {
  agentDetection?: AgentDetectionConfig;
  signoffPolicy?: SignoffPolicyConfig;
}

export interface ResolvedConfig {
  agentDetection: Required<AgentDetectionConfig>;
  signoffPolicy: Required<SignoffPolicyConfig>;
}

const DEFAULTS: ResolvedConfig = {
  agentDetection: {
    agentAccounts: ['copilot-swe-agent[bot]', 'devin-ai-integration[bot]', 'cursor[bot]', 'claude[bot]', 'codex[bot]'],
    coAuthorAgents: ['claude', 'copilot', 'cursor', 'devin', 'codex', 'aider', 'gemini', 'jules'],
    labels: ['agent-authored'],
    branchPatterns: ['claude/*', 'copilot/*', 'cursor/*', 'codex/*', 'devin/*'],
    requireLabel: 'contract:required',
    exemptLabel: 'contract:exempt',
  },
  signoffPolicy: {
    permissions: ['admin', 'maintain', 'write'],
    allowPrAuthor: false,
  },
};

/** Fills every setting the team's config leaves out with its default. Lists replace, not merge. */
export function resolveConfig(config: GateConfig): ResolvedConfig {
  return {
    agentDetection: { ...DEFAULTS.agentDetection, ...config.agentDetection },
    signoffPolicy: { ...DEFAULTS.signoffPolicy, ...config.signoffPolicy },
  };
}
