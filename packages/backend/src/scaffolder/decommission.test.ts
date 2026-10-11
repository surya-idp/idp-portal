import { GitHubApi } from './awaitCiAndAutoMerge';
import {
  archiveRepository,
  deleteEcrRepository,
  listFiles,
  unregisterEntity,
  deleteDocs,
  DocsStore,
  deleteRepository,
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
  it('deletes the named svc/ repository', async () => {
    const deleted: string[] = [];
    const ecr = {
      deleteRepository: async (name: string) => void deleted.push(name),
    };
    await expect(
      deleteEcrRepository({ ecr, repositoryName: 'svc/demo-svc', log }),
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
      deleteEcrRepository({ ecr, repositoryName: 'svc/demo-svc', log }),
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
      deleteEcrRepository({ ecr, repositoryName: 'svc/demo-svc', log }),
    ).rejects.toThrow(
      /Could not delete ECR repository svc\/demo-svc: not allowed/,
    );
  });

  it.each([
    '',
    'demo-svc',
    'idp-portal',
    'feature-flag-service',
    'svc/',
    'svc/../idp-portal',
    'svc/a/b',
    'SVC/demo',
  ])('refuses the repository "%s"', async repositoryName => {
    const ecr = { deleteRepository: jest.fn() };
    await expect(
      deleteEcrRepository({ ecr, repositoryName, log }),
    ).rejects.toThrow(/only a repository svc\/<name> is allowed/);
    expect(ecr.deleteRepository).not.toHaveBeenCalled();
  });
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

describe('deleteDocs', () => {
  function fakeStore(keys: string[]) {
    const calls: { listed: string[]; deleted: string[][] } = {
      listed: [],
      deleted: [],
    };
    const store: DocsStore = {
      list: async prefix => {
        calls.listed.push(prefix);
        return keys;
      },
      delete: async toDelete => {
        calls.deleted.push(toDelete);
      },
    };
    return { store, calls };
  }

  it('deletes everything under the service prefix, with the trailing slash', async () => {
    const keys = [
      'default/component/orders/index.html',
      'default/component/orders/runbook/index.html',
    ];
    const { store, calls } = fakeStore(keys);
    const log = jest.fn();
    await expect(deleteDocs({ store, name: 'orders', log })).resolves.toBe(2);
    // "orders/" so that the docs of "orders-v2" are never listed
    expect(calls.listed).toEqual(['default/component/orders/']);
    expect(calls.deleted).toEqual([keys]);
  });

  it('does nothing when the service never published docs', async () => {
    const { store, calls } = fakeStore([]);
    await expect(
      deleteDocs({ store, name: 'orders', log: jest.fn() }),
    ).resolves.toBe(0);
    expect(calls.deleted).toEqual([]);
  });

  it.each(['', '/', '..', 'orders/../billing', 'Orders', 'a/b', '*'])(
    'refuses the name %p before touching the bucket',
    async name => {
      const { store, calls } = fakeStore(['default/component/x/index.html']);
      await expect(deleteDocs({ store, name, log: jest.fn() })).rejects.toThrow(
        /not a service name/,
      );
      expect(calls.listed).toEqual([]);
      expect(calls.deleted).toEqual([]);
    },
  );

  it('deletes nothing if the listing contains a key outside the prefix', async () => {
    const { store, calls } = fakeStore([
      'default/component/orders/index.html',
      'default/component/billing/index.html',
    ]);
    await expect(
      deleteDocs({ store, name: 'orders', log: jest.fn() }),
    ).rejects.toThrow(/outside/);
    expect(calls.deleted).toEqual([]);
  });
});

describe('deleteRepository', () => {
  const protectedRepos = ['idp-gitops', 'idp-portal'];
  function fakeGitHubDelete(failWith?: { status: number; message: string }) {
    const calls: string[] = [];
    const api = {
      request: async (route: string, params: any) => {
        calls.push(`${route} ${params.owner}/${params.repo}`);
        if (failWith)
          throw Object.assign(new Error(failWith.message), failWith);
        return { data: {} };
      },
      graphql: async () => ({}),
    };
    return { api, calls };
  }
  const repo = { owner: 'surya-idp', repo: 'orders' };

  it('deletes the repository', async () => {
    const { api, calls } = fakeGitHubDelete();
    const log = jest.fn();
    await expect(
      deleteRepository({ api, repo, protectedRepos, log }),
    ).resolves.toBe(true);
    expect(calls).toEqual(['DELETE /repos/{owner}/{repo} surya-idp/orders']);
    expect(log).toHaveBeenCalledWith(
      'Deleted surya-idp/orders for good (this cannot be undone)',
    );
  });

  it.each(['idp-gitops', 'IDP-Portal'])(
    'never deletes the platform repository %p, and does not call GitHub',
    async name => {
      const { api, calls } = fakeGitHubDelete();
      await expect(
        deleteRepository({
          api,
          repo: { owner: 'surya-idp', repo: name },
          protectedRepos,
          log: jest.fn(),
        }),
      ).rejects.toThrow(/platform's own repositories/);
      expect(calls).toEqual([]);
    },
  );

  it('treats a repository that is already gone as done (safe to run twice)', async () => {
    const { api } = fakeGitHubDelete({ status: 404, message: 'Not Found' });
    await expect(
      deleteRepository({ api, repo, protectedRepos, log: jest.fn() }),
    ).resolves.toBe(false);
  });

  it('reports any other failure', async () => {
    const { api } = fakeGitHubDelete({ status: 403, message: 'Forbidden' });
    await expect(
      deleteRepository({ api, repo, protectedRepos, log: jest.fn() }),
    ).rejects.toThrow(/Could not delete surya-idp\/orders: Forbidden/);
  });
});
