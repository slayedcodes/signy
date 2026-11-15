import type { BotIdentity, Permission } from './types.js';

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
  /** Globs for CI and config files; changing one outside the scope is a ci-config Deviation. */
  ciConfigFiles?: string[];
  /** Globs for test files. Their exports are not public interface; their tests are checked for Test Weakening. */
  testFiles?: string[];
  /** The gate bot's git identity. Read by the CLI and host adapters to fill `GateInput.bot`. */
  bot?: BotIdentity;
}

export interface ResolvedConfig {
  agentDetection: Required<AgentDetectionConfig>;
  signoffPolicy: Required<SignoffPolicyConfig>;
  ciConfigFiles: string[];
  testFiles: string[];
}

/** Where a repo keeps its gate config. The gate reads it from the base branch, never from the PR. */
export const GATE_CONFIG_FILE = '.change-contract.json';

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
  ciConfigFiles: [
    '.github/**',
    '.gitlab-ci.yml',
    '**/tsconfig*.json',
    '**/.eslintrc*',
    '**/eslint.config.*',
    '**/.prettierrc*',
    '**/prettier.config.*',
    '**/biome.json',
    '**/jest.config.*',
    '**/vitest.config.*',
    '.npmrc',
    GATE_CONFIG_FILE,
  ],
  testFiles: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
};

/** Fills every setting the team's config leaves out with its default. Lists replace, not merge. */
export function resolveConfig(config: GateConfig): ResolvedConfig {
  return {
    agentDetection: { ...DEFAULTS.agentDetection, ...config.agentDetection },
    signoffPolicy: { ...DEFAULTS.signoffPolicy, ...config.signoffPolicy },
    ciConfigFiles: config.ciConfigFiles ?? DEFAULTS.ciConfigFiles,
    testFiles: config.testFiles ?? DEFAULTS.testFiles,
  };
}
