import {
  buildRunSummary,
  GATE_CONFIG_FILE,
  prepareApproval,
  renderSummary,
  runGate,
  type BotIdentity,
  type GateCommit,
  type GateComment,
  type GateConfig,
  type GateInput,
  type GateResult,
  type GitReader,
  type RunSummary,
} from '@change-contract/core';
import { GitHubApi, GitHubApiError, type GitHubConnection, type IssueComment, type PullRequest } from './github-api.js';

/** Git, as the Action has it: a checkout of the repo that can fetch more commits. */
export interface GitAccess {
  reader: GitReader;
  readCommits(base: string, head: string): Promise<GateCommit[]>;
  /** Makes these commits available locally. */
  fetchCommits(shas: string[], pull: PullRequest): Promise<void>;
}

export interface AdapterDeps extends GitHubConnection {
  git: GitAccess;
  now?: () => Date;
}

/** A GitHub Actions event: its name (`GITHUB_EVENT_NAME`) and payload. */
export interface GitHubEvent {
  name: string;
  payload: any;
}

export type EventOutcome =
  | { handled: false; reason: string }
  | { handled: true; head: string; result: GateResult; runSummary: RunSummary };

/** GitHub's Actions bot, which authors the commits the Action makes with GITHUB_TOKEN. */
export const GITHUB_ACTIONS_BOT: BotIdentity = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

/** Marks the gate's own summary comment, so each run updates it in place. */
export const SUMMARY_MARKER = '<!-- change-contract-summary -->';

const COMMAND_LINE = /^\s*\/(?:contract|signoff)\b/i;

/**
 * Runs the gate for one PR event and reports it on GitHub: a `change-contract` check run on
 * the head commit, and one summary comment kept up to date. A valid `/contract approve` is
 * recorded first as an Approval Commit, and the comment that triggered the run gets a reply
 * for every command the gate can't act on.
 */
export async function handleEvent(event: GitHubEvent, deps: AdapterDeps): Promise<EventOutcome> {
  if (event.name === 'pull_request') {
    return {
      handled: false,
      reason: 'The gate runs on pull_request_target, never pull_request: on pull_request the PR controls the workflow file (ADR 0005).',
    };
  }
  const number = pullNumber(event);
  if (number === undefined) return { handled: false, reason: `${event.name} isn't about a pull request.` };
  // The gate's own comments (and any other bot's) never trigger a run, so the summary comment can't loop.
  if (event.name === 'issue_comment' && event.payload.comment?.user?.type === 'Bot') {
    return { handled: false, reason: 'Comments by bots are ignored.' };
  }

  const api = new GitHubApi(deps);
  const pull = await api.pull(number);
  await deps.git.fetchCommits([pull.baseSha, pull.headSha], pull);
  const comments = await api.comments(number);
  let input = await gateInput(api, deps, pull, comments, pull.headSha);
  const triggerIndex = event.name === 'issue_comment' ? comments.findIndex((c) => c.id === event.payload.comment?.id) : -1;
  const trigger = input.comments[triggerIndex];

  input = await recordApproval(api, deps, pull, comments, input, trigger);
  const result = await runGate(input);
  if (trigger) await replyToCommands(api, number, trigger, result);
  await report(api, pull, input.pr.head, result, comments);
  const runSummary = buildRunSummary(input, result, {
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    prId: `${deps.repo}#${number}`,
  });
  return { handled: true, head: input.pr.head, result, runSummary };
}

function pullNumber(event: GitHubEvent): number | undefined {
  if (event.name === 'pull_request_target') return event.payload.pull_request?.number;
  if (event.name === 'issue_comment' && event.payload.issue?.pull_request) return event.payload.issue.number;
  return undefined;
}

/**
 * Pushes an Approval Commit for the first comment whose `/contract approve` may be recorded:
 * the triggering comment, then the others, newest first. Looking beyond the trigger means an
 * approval whose own run was dropped or failed is caught up on the next event. Only the
 * triggering comment gets replies, so other comments aren't answered again on every run.
 * Returns the gate input for the new head, or the old one if nothing was pushed.
 */
async function recordApproval(
  api: GitHubApi,
  deps: AdapterDeps,
  pull: PullRequest,
  comments: IssueComment[],
  input: GateInput,
  trigger: GateComment | undefined,
): Promise<GateInput> {
  const candidates = [...(trigger ? [trigger] : []), ...[...input.comments].reverse().filter((c) => c !== trigger)];
  for (const comment of candidates) {
    const answer = (message: string) => (comment === trigger ? api.createComment(pull.number, reply(comment, [], message)) : undefined);
    const decision = await prepareApproval(input, comment);
    if (decision.action === 'already-approved') return input;
    if (decision.action === 'none') continue;
    if (decision.action === 'refuse') {
      await answer(decision.reason);
      continue;
    }
    if (pull.headRepo !== deps.repo) {
      await answer("The gate can't push an Approval Commit to a branch in a fork. Open the PR from a branch in this repository.");
      return input;
    }
    const tree = await api.commitTree(decision.parent);
    const approval = await api.createCommit(decision.message, tree, [decision.parent]);
    try {
      await api.fastForward(pull.headRef, approval.sha);
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 422)) throw error;
      await answer('The PR branch changed while the gate was recording the approval. Comment `/contract approve` again.');
      return input;
    }
    await deps.git.fetchCommits([approval.sha], pull);
    // Pushes made with GITHUB_TOKEN start no workflow, so the gate runs on the new head right here.
    return gateInput(api, deps, pull, comments, approval.sha, approval.verified ? [approval.sha] : []);
  }
  return input;
}

/** Replies to every command in the triggering comment that the gate couldn't act on (PLAN.md §6). */
async function replyToCommands(api: GitHubApi, number: number, trigger: GateComment, result: GateResult) {
  if (!result.applicable) {
    if (trigger.body.split(/\r?\n/).some((l) => COMMAND_LINE.test(l))) {
      const message = "This PR isn't an Agent-authored PR, so the Change Contract gate doesn't apply and ignores commands.";
      await api.createComment(number, reply(trigger, [], message));
    }
    return;
  }
  const errors = result.commandErrors.filter((e) => e.commentUrl === trigger.url);
  if (errors.length === 0) return;
  await api.createComment(number, errors.map((e) => reply(trigger, [e.line], e.message)).join('\n\n'));
}

/** A reply to a comment: the command lines it is about (by default all of them), then the gate's answer. */
function reply(comment: GateComment, lines: string[], message: string): string {
  const quoted = lines.length > 0 ? lines : comment.body.split(/\r?\n/).filter((l) => COMMAND_LINE.test(l));
  return `${quoted.map((l) => `> ${l.trim()}`).join('\n')}\n\n@${comment.author} ${message}`;
}

async function gateInput(
  api: GitHubApi,
  deps: AdapterDeps,
  pull: PullRequest,
  comments: IssueComment[],
  head: string,
  /** Commits the host verified that its commit list may not show yet, such as one just created. */
  alsoVerified: string[] = [],
): Promise<GateInput> {
  // The gate config comes from the base branch, so a PR can't loosen the rules it is checked by.
  const configText = await deps.git.reader.readFile(pull.baseSha, GATE_CONFIG_FILE);
  const config = (configText ? JSON.parse(configText) : {}) as GateConfig;
  const [commits, verified] = await Promise.all([deps.git.readCommits(pull.baseSha, head), api.verifiedCommits(pull.number)]);
  alsoVerified.forEach((sha) => verified.add(sha));
  const gateComments: GateComment[] = await Promise.all(
    comments.map(async (c) => ({
      author: c.author,
      permission: c.isBot ? 'none' : await api.permission(c.author),
      isBot: c.isBot,
      createdAt: c.createdAt,
      url: c.url,
      body: c.body,
    })),
  );
  return {
    pr: { author: pull.author, labels: pull.labels, branch: pull.headRef, base: pull.baseSha, head },
    commits: commits.map((c) => ({ ...c, signatureVerified: verified.has(c.sha) })),
    git: deps.git.reader,
    comments: gateComments,
    config,
    bot: config.bot ?? GITHUB_ACTIONS_BOT,
    hostVerifiesSignatures: true,
  };
}

async function report(api: GitHubApi, pull: PullRequest, head: string, result: GateResult, comments: IssueComment[]) {
  const summary = renderSummary(result);
  const verdict = !result.applicable ? 'not applicable' : result.status;
  await api.createCheckRun(head, {
    conclusion: result.status === 'pass' ? 'success' : 'failure',
    title: `Change Contract gate: ${verdict}`,
    summary,
  });
  const body = `${SUMMARY_MARKER}\n${summary}`;
  const existing = comments.find((c) => c.isBot && c.body.startsWith(SUMMARY_MARKER));
  if (existing) await api.updateComment(existing.id, body);
  // A PR the gate doesn't apply to gets a check but no comment, unless it had one before.
  else if (result.applicable) await api.createComment(pull.number, body);
}
