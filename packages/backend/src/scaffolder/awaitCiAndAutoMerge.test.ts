import {
  awaitCiAndAutoMerge,
  AwaitCiAndAutoMergeOptions,
  GitHubApi,
} from './awaitCiAndAutoMerge';

const RUNS = 'GET /repos/{owner}/{repo}/actions/runs';
const PR = 'GET /repos/{owner}/{repo}/pulls/{pull_number}';
const MERGE = 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge';

const run = (status: string, conclusion: string | null) => ({
  status,
  conclusion,
  html_url: `https://github.test/run/${status}-${conclusion}`,
});
const pr = (over: object = {}) => ({
  node_id: 'PR_1',
  state: 'open',
  merged: false,
  merge_commit_sha: null,
  head: { sha: 'prhead' },
  ...over,
});

/**
 * A fake GitHub: each route answers from a queue, and the last answer repeats.
 * Workflow runs are queued per repo.
 */
function fakeGitHub(answers: {
  serviceRuns: object[][];
  deployRuns?: object[][];
  prs: object[];
  graphqlError?: string;
}) {
  const calls: string[] = [];
  const next = <T>(queue: T[]): T =>
    queue.length > 1 ? queue.shift()! : queue[0];
  const api: GitHubApi = {
    async request(route, params) {
      calls.push(`${route} ${params?.repo}`);
      if (route === RUNS) {
        const queue =
          params?.repo === 'svc'
            ? answers.serviceRuns
            : answers.deployRuns ?? [[]];
        return { data: { workflow_runs: next(queue) } };
      }
      if (route === PR) return { data: next(answers.prs) };
      if (route === MERGE) return { data: { merged: true } };
      throw new Error(`unexpected route ${route}`);
    },
    async graphql() {
      calls.push('graphql enablePullRequestAutoMerge');
      if (answers.graphqlError) throw new Error(answers.graphqlError);
      return {};
    },
  };
  return { api, calls };
}

function options(api: GitHubApi): AwaitCiAndAutoMergeOptions {
  let clock = 0;
  return {
    reader: api,
    writer: api,
    serviceRepo: { owner: 'org', repo: 'svc' },
    commitSha: 'a'.repeat(40),
    deployRepo: { owner: 'org', repo: 'gitops' },
    pullRequestNumber: 7,
    mergeMethod: 'SQUASH',
    timeoutMs: 60_000,
    pollIntervalMs: 10_000,
    log: () => {},
    sleep: async ms => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe('awaitCiAndAutoMerge', () => {
  it('waits for CI, enables auto-merge, then reports the merge', async () => {
    const { api, calls } = fakeGitHub({
      serviceRuns: [
        [],
        [run('in_progress', null)],
        [run('completed', 'success')],
      ],
      prs: [
        pr(),
        pr(),
        pr({ merged: true, state: 'closed', merge_commit_sha: 'merged1' }),
      ],
    });

    const result = await awaitCiAndAutoMerge(options(api));

    expect(result).toEqual({
      ciRunUrl: 'https://github.test/run/completed-success',
      mergeCommitSha: 'merged1',
    });
    // auto-merge is only requested after CI succeeded
    expect(calls.indexOf('graphql enablePullRequestAutoMerge')).toBeGreaterThan(
      calls.lastIndexOf(`${RUNS} svc`),
    );
    expect(calls).not.toContain(`${MERGE} gitops`);
  });

  it('ignores a cancelled duplicate run when another run succeeded', async () => {
    const { api } = fakeGitHub({
      serviceRuns: [
        [run('completed', 'cancelled'), run('completed', 'success')],
      ],
      prs: [
        pr(),
        pr({ merged: true, state: 'closed', merge_commit_sha: 'merged2' }),
      ],
    });
    await expect(awaitCiAndAutoMerge(options(api))).resolves.toMatchObject({
      mergeCommitSha: 'merged2',
    });
  });

  it('fails and never touches the PR when CI fails', async () => {
    const { api, calls } = fakeGitHub({
      serviceRuns: [[run('completed', 'failure')]],
      prs: [pr()],
    });
    await expect(awaitCiAndAutoMerge(options(api))).rejects.toThrow(
      /ended with "failure".*left open/,
    );
    expect(calls).toEqual([`${RUNS} svc`]);
  });

  it('fails when every CI run was cancelled (no image was built)', async () => {
    const { api } = fakeGitHub({
      serviceRuns: [[run('completed', 'cancelled')]],
      prs: [pr()],
    });
    await expect(awaitCiAndAutoMerge(options(api))).rejects.toThrow(
      /cancelled/,
    );
  });

  it('times out when CI never finishes', async () => {
    const { api, calls } = fakeGitHub({
      serviceRuns: [[run('in_progress', null)]],
      prs: [pr()],
    });
    await expect(awaitCiAndAutoMerge(options(api))).rejects.toThrow(
      /Timed out waiting for CI/,
    );
    expect(calls).not.toContain('graphql enablePullRequestAutoMerge');
  });

  it('merges directly when the checks already passed ("clean status")', async () => {
    const { api, calls } = fakeGitHub({
      serviceRuns: [[run('completed', 'success')]],
      prs: [
        pr(),
        pr({ merged: true, state: 'closed', merge_commit_sha: 'merged3' }),
      ],
      graphqlError: 'Pull request Pull request is in clean status',
    });
    await expect(awaitCiAndAutoMerge(options(api))).resolves.toMatchObject({
      mergeCommitSha: 'merged3',
    });
    expect(calls).toContain(`${MERGE} gitops`);
  });

  it('reports any other auto-merge error instead of merging', async () => {
    const { api, calls } = fakeGitHub({
      serviceRuns: [[run('completed', 'success')]],
      prs: [pr()],
      graphqlError: 'Auto merge is not allowed for this repository',
    });
    await expect(awaitCiAndAutoMerge(options(api))).rejects.toThrow(
      /Could not enable auto-merge.*not allowed/,
    );
    expect(calls).not.toContain(`${MERGE} gitops`);
  });

  it('fails with the check link when validation of the deploy PR fails', async () => {
    const { api } = fakeGitHub({
      serviceRuns: [[run('completed', 'success')]],
      deployRuns: [[run('completed', 'failure')]],
      prs: [pr()],
    });
    await expect(awaitCiAndAutoMerge(options(api))).rejects.toThrow(
      /check on the deploy PR.*"failure"/,
    );
  });

  it('skips auto-merge when the PR is already merged', async () => {
    const { api, calls } = fakeGitHub({
      serviceRuns: [[run('completed', 'success')]],
      prs: [pr({ merged: true, state: 'closed', merge_commit_sha: 'merged4' })],
    });
    await expect(awaitCiAndAutoMerge(options(api))).resolves.toMatchObject({
      mergeCommitSha: 'merged4',
    });
    expect(calls).not.toContain('graphql enablePullRequestAutoMerge');
  });
});
