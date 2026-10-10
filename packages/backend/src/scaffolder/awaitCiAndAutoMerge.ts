/*
 * The logic behind the scaffolder action `idp:github:await-ci-auto-merge`, kept free of
 * Backstage and Octokit types so it can be unit tested with a fake GitHub API.
 *
 * Zero-touch first deploy (idp-infra/TEMPLATES_RESEARCH.md 4.2 and 11.6):
 *   1. wait until the new service repo's CI has built and pushed the image for its first
 *      commit. The deploy PR pins exactly that image, so merging earlier would start pods
 *      that cannot pull it;
 *   2. turn on GitHub's native auto-merge for the deploy PR in idp-gitops. GitHub merges it
 *      only when the required `validate` check is green, so this action never bypasses
 *      branch rules and never decides on its own that a change is safe;
 *   3. wait for the merge, so the task log ends with a clear result.
 * Any red or a timeout fails the task and leaves the PR open with the reason.
 */

/** The two GitHub calls this logic needs; satisfied by an Octokit client. */
export interface GitHubApi {
  request(
    route: string,
    params?: Record<string, unknown>,
  ): Promise<{ data: any }>;
  graphql(query: string, variables?: Record<string, unknown>): Promise<any>;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface AwaitCiAndAutoMergeOptions {
  /** Reads public Actions data (workflow runs) in both repos. */
  reader: GitHubApi;
  /** Acts on the deploy PR; must be able to write pull requests in the deploy repo. */
  writer: GitHubApi;
  serviceRepo: RepoRef;
  commitSha: string;
  deployRepo: RepoRef;
  pullRequestNumber: number;
  mergeMethod: 'MERGE' | 'SQUASH' | 'REBASE';
  timeoutMs: number;
  pollIntervalMs: number;
  log: (message: string) => void;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface AwaitCiAndAutoMergeResult {
  ciRunUrl: string;
  mergeCommitSha: string;
}

// A cancelled run is not a verdict: GitHub sometimes starts two runs for one push and the
// workflow's concurrency group cancels one of them (idp-infra HANDOVER, Finding 48).
const FAILED_CONCLUSIONS = [
  'failure',
  'timed_out',
  'startup_failure',
  'action_required',
];

type RunsVerdict =
  | { state: 'pending' }
  | { state: 'success'; url: string }
  | { state: 'failed'; url: string; conclusion: string };

async function runsVerdict(
  api: GitHubApi,
  repo: RepoRef,
  sha: string,
): Promise<RunsVerdict> {
  const { data } = await api.request('GET /repos/{owner}/{repo}/actions/runs', {
    ...repo,
    head_sha: sha,
    per_page: 100,
  });
  const runs: any[] = data.workflow_runs ?? [];
  const failed = runs.find(r => FAILED_CONCLUSIONS.includes(r.conclusion));
  if (failed) {
    return {
      state: 'failed',
      url: failed.html_url,
      conclusion: failed.conclusion,
    };
  }
  if (runs.length === 0 || runs.some(r => r.status !== 'completed')) {
    return { state: 'pending' };
  }
  const succeeded = runs.find(r => r.conclusion === 'success');
  if (!succeeded) {
    // Every run was cancelled or skipped: nothing built the image.
    return {
      state: 'failed',
      url: runs[0].html_url,
      conclusion: runs[0].conclusion,
    };
  }
  return { state: 'success', url: succeeded.html_url };
}

const ENABLE_AUTO_MERGE = `
  mutation ($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID!) {
    enablePullRequestAutoMerge(
      input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod, expectedHeadOid: $expectedHeadOid }
    ) {
      pullRequest { number }
    }
  }`;

export async function awaitCiAndAutoMerge(
  options: AwaitCiAndAutoMergeOptions,
): Promise<AwaitCiAndAutoMergeResult> {
  const {
    reader,
    writer,
    serviceRepo,
    commitSha,
    deployRepo,
    pullRequestNumber,
    mergeMethod,
    timeoutMs,
    pollIntervalMs,
    log,
  } = options;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const prRoute = 'GET /repos/{owner}/{repo}/pulls/{pull_number}';
  const prParams = { ...deployRepo, pull_number: pullRequestNumber };
  const prName = `${deployRepo.owner}/${deployRepo.repo}#${pullRequestNumber}`;

  // 1. The service CI run for the first commit.
  const serviceName = `${serviceRepo.owner}/${serviceRepo.repo}`;
  log(
    `Waiting for CI of ${serviceName} at ${commitSha.slice(
      0,
      7,
    )} (it builds the image this deploy pins)`,
  );
  let ciRunUrl = '';
  for (;;) {
    const verdict = await runsVerdict(reader, serviceRepo, commitSha);
    if (verdict.state === 'success') {
      ciRunUrl = verdict.url;
      log(`CI passed: ${ciRunUrl}`);
      break;
    }
    if (verdict.state === 'failed') {
      throw new Error(
        `CI of ${serviceName} ended with "${verdict.conclusion}": ${verdict.url}. ` +
          `The deploy PR ${prName} was left open; fix the build, then merge it.`,
      );
    }
    if (now() + pollIntervalMs > deadline) {
      throw new Error(
        `Timed out waiting for CI of ${serviceName} at ${commitSha}. ` +
          `The deploy PR ${prName} was left open; merge it once CI is green.`,
      );
    }
    await sleep(pollIntervalMs);
  }

  // 2. Native auto-merge on the deploy PR.
  const { data: pr } = await writer.request(prRoute, prParams);
  if (!pr.merged) {
    try {
      await writer.graphql(ENABLE_AUTO_MERGE, {
        pullRequestId: pr.node_id,
        mergeMethod,
        expectedHeadOid: pr.head.sha,
      });
      log(
        `Auto-merge enabled on ${prName}; GitHub merges it when the required checks pass`,
      );
    } catch (error) {
      // GitHub refuses auto-merge when nothing is pending ("Pull request is in clean
      // status"): the required checks already passed, so a plain merge is allowed. The
      // ruleset still applies to it, because this App is not on the bypass list.
      if (!/clean status/i.test(String((error as Error).message))) {
        throw new Error(
          `Could not enable auto-merge on ${prName}: ${
            (error as Error).message
          }`,
        );
      }
      log(`Required checks already passed on ${prName}; merging now`);
      await writer.request(
        'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge',
        {
          ...prParams,
          sha: pr.head.sha,
          merge_method: mergeMethod.toLowerCase(),
        },
      );
    }
  }

  // 3. Wait for the merge; report a failed check instead of timing out silently.
  for (;;) {
    const { data: current } = await writer.request(prRoute, prParams);
    if (current.merged) {
      log(
        `Merged ${prName} (${current.merge_commit_sha.slice(
          0,
          7,
        )}); Argo CD deploys it on its next poll`,
      );
      return { ciRunUrl, mergeCommitSha: current.merge_commit_sha };
    }
    if (current.state === 'closed') {
      throw new Error(`The deploy PR ${prName} was closed without merging.`);
    }
    const checks = await runsVerdict(reader, deployRepo, current.head.sha);
    if (checks.state === 'failed') {
      throw new Error(
        `A check on the deploy PR ${prName} ended with "${checks.conclusion}": ${checks.url}. ` +
          `The PR was left open and will merge by itself once the check passes.`,
      );
    }
    if (now() + pollIntervalMs > deadline) {
      throw new Error(
        `Timed out waiting for ${prName} to merge. Auto-merge stays enabled: it merges when its checks pass.`,
      );
    }
    await sleep(pollIntervalMs);
  }
}
