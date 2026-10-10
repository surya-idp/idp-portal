import { GitHubApi } from './awaitCiAndAutoMerge';
import {
  archiveRepository,
  deleteEcrRepository,
  listFiles,
  unregisterEntity,
} from './decommission';

const repo = { owner: 'org', repo: 'gitops' };
const log = () => {};

function github(
  handler: (route: string, params?: Record<string, unknown>) => any,
) {
  const calls: string[] = [];
  const api: GitHubApi = {
    async request(route, params) {
      calls.push(route);
      return { data: handler(route, params) };
    },
    async graphql() {
      throw new Error('not used');
    },
  };
  return { api, calls };
}

const tree = (...paths: string[]) => ({
  truncated: false,
  tree: [
    { type: 'tree', path: 'apps/demo-svc' },
    ...paths.map(path => ({ type: 'blob', path })),
  ],
});

describe('listFiles', () => {
  it('returns only the files of the one service folder', async () => {
    const { api } = github(() =>
      tree(
        'apps/demo-svc/base/deployment.yaml',
        'apps/demo-svc/overlays/dev/kustomization.yaml',
        'apps/demo-svc-2/base/deployment.yaml',
        'apps/feature-flag-service/base/deployment.yaml',
        'README.md',
      ),
    );
    await expect(
      listFiles({ api, repo, branch: 'main', directory: 'apps/demo-svc' }),
    ).resolves.toEqual([
      'apps/demo-svc/base/deployment.yaml',
      'apps/demo-svc/overlays/dev/kustomization.yaml',
    ]);
  });

  it.each([
    'apps',
    'apps/',
    '.',
    '',
    'platform/cluster',
    'apps/a/b',
    'apps/../x',
    '/',
  ])('refuses "%s" before calling GitHub', async directory => {
    const { api, calls } = github(() => tree());
    await expect(
      listFiles({ api, repo, branch: 'main', directory }),
    ).rejects.toThrow(/only a single service folder/);
    expect(calls).toEqual([]);
  });

  it('fails when the folder has no files (already removed)', async () => {
    const { api } = github(() => tree('apps/other/base/deployment.yaml'));
    await expect(
      listFiles({ api, repo, branch: 'main', directory: 'apps/demo-svc' }),
    ).rejects.toThrow(/nothing to remove/);
  });

  it('fails when GitHub truncated the listing', async () => {
    const { api } = github(() => ({ truncated: true, tree: [] }));
    await expect(
      listFiles({ api, repo, branch: 'main', directory: 'apps/demo-svc' }),
    ).rejects.toThrow(/truncated/);
  });
});

describe('deleteEcrRepository', () => {
  it('deletes svc/<name> and nothing else', async () => {
    const deleted: string[] = [];
    const ecr = {
      deleteRepository: async (name: string) => void deleted.push(name),
    };
    await expect(
      deleteEcrRepository({ ecr, serviceName: 'demo-svc', log }),
    ).resolves.toBe(true);
    expect(deleted).toEqual(['svc/demo-svc']);
  });

  it('treats a missing repository as already done', async () => {
    const ecr = {
      deleteRepository: async () => {
        throw Object.assign(new Error('gone'), {
          name: 'RepositoryNotFoundException',
        });
      },
    };
    await expect(
      deleteEcrRepository({ ecr, serviceName: 'demo-svc', log }),
    ).resolves.toBe(false);
  });

  it('reports any other AWS error', async () => {
    const ecr = {
      deleteRepository: async () => {
        throw Object.assign(new Error('not allowed'), {
          name: 'AccessDeniedException',
        });
      },
    };
    await expect(
      deleteEcrRepository({ ecr, serviceName: 'demo-svc', log }),
    ).rejects.toThrow(
      /Could not delete ECR repository svc\/demo-svc: not allowed/,
    );
  });

  it.each(['', '../idp-portal', 'svc/x', 'Demo', 'a b'])(
    'refuses the name "%s"',
    async serviceName => {
      const ecr = { deleteRepository: jest.fn() };
      await expect(
        deleteEcrRepository({ ecr, serviceName, log }),
      ).rejects.toThrow(/not a valid service name/);
      expect(ecr.deleteRepository).not.toHaveBeenCalled();
    },
  );
});

describe('archiveRepository', () => {
  it('archives a live repo', async () => {
    const { api, calls } = github(() => ({ archived: false }));
    await expect(archiveRepository({ api, repo, log })).resolves.toBe(true);
    expect(calls).toEqual([
      'GET /repos/{owner}/{repo}',
      'PATCH /repos/{owner}/{repo}',
    ]);
  });

  it('does nothing when it is already archived', async () => {
    const { api, calls } = github(() => ({ archived: true }));
    await expect(archiveRepository({ api, repo, log })).resolves.toBe(false);
    expect(calls).toEqual(['GET /repos/{owner}/{repo}']);
  });
});

describe('unregisterEntity', () => {
  it('removes the location that registered the entity', async () => {
    const removed: string[] = [];
    const catalog = {
      getLocationIdByEntity: async () => 'loc-1',
      removeLocationById: async (id: string) => void removed.push(id),
    };
    await expect(
      unregisterEntity({
        catalog,
        entityRef: 'component:default/demo-svc',
        log,
      }),
    ).resolves.toBe(true);
    expect(removed).toEqual(['loc-1']);
  });

  it('does nothing when the entity has no location', async () => {
    const catalog = {
      getLocationIdByEntity: async () => undefined,
      removeLocationById: jest.fn(),
    };
    await expect(
      unregisterEntity({
        catalog,
        entityRef: 'component:default/demo-svc',
        log,
      }),
    ).resolves.toBe(false);
    expect(catalog.removeLocationById).not.toHaveBeenCalled();
  });
});
