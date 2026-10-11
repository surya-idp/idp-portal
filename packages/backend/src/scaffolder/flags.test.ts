import {
  createFlag,
  deleteServiceFlags,
  FlagApi,
  flagRequest,
  NewFlag,
  qualifiedFlagName,
} from './flags';

const flag: NewFlag = {
  service: 'orders-svc',
  name: 'new-checkout',
  type: 'boolean',
  enabled: false,
  environment: 'dev',
};

function fakeApi(status: number, body: unknown = {}) {
  const calls: { path: string; body: unknown }[] = [];
  const api: FlagApi = {
    post: async (path, requestBody) => {
      calls.push({ path, body: requestBody });
      return { status, body };
    },
  };
  return { api, calls };
}

describe('qualifiedFlagName', () => {
  it('stores a flag under its service', () => {
    expect(qualifiedFlagName('orders-svc', 'new-checkout')).toBe(
      'orders-svc.new-checkout',
    );
  });

  it.each(['', 'New', 'a b', 'x.y', '-a', 'a-', '../etc', 'a'.repeat(61)])(
    'rejects the flag name %p',
    name => {
      expect(() => qualifiedFlagName('orders-svc', name)).toThrow(/flag name/);
    },
  );

  it('rejects something that is not a service name', () => {
    expect(() => qualifiedFlagName('Orders/Svc', 'flag')).toThrow(
      /service name/,
    );
  });
});

describe('flagRequest', () => {
  it('builds the body for a boolean flag', () => {
    expect(flagRequest(flag)).toEqual({
      name: 'orders-svc.new-checkout',
      flag_type: 'boolean',
      default_value: false,
      environment: 'dev',
      description: 'Flag of service orders-svc',
    });
  });

  it('keeps a description and trims it', () => {
    expect(
      flagRequest({ ...flag, description: '  New checkout page ' }).description,
    ).toBe('New checkout page');
  });

  it('adds the percentage for a percentage flag', () => {
    expect(
      flagRequest({ ...flag, type: 'percentage', rolloutPercentage: 25 }),
    ).toMatchObject({ flag_type: 'percentage', rollout_percentage: 25 });
  });

  it.each([undefined, -1, 101, 12.5])(
    'rejects the percentage %p on a percentage flag',
    rolloutPercentage => {
      expect(() =>
        flagRequest({ ...flag, type: 'percentage', rolloutPercentage }),
      ).toThrow(/0 to 100/);
    },
  );

  it('rejects a percentage on a boolean flag', () => {
    expect(() => flagRequest({ ...flag, rolloutPercentage: 10 })).toThrow(
      /Only a percentage flag/,
    );
  });
});

describe('createFlag', () => {
  it('creates the flag', async () => {
    const { api, calls } = fakeApi(201);
    const log = jest.fn();
    await expect(createFlag({ api, flag, log })).resolves.toEqual({
      created: true,
      name: 'orders-svc.new-checkout',
    });
    expect(calls).toEqual([{ path: '/flags', body: flagRequest(flag) }]);
    expect(log).toHaveBeenCalledWith(
      'Created flag orders-svc.new-checkout (boolean) in dev',
    );
  });

  it('reports an existing flag instead of failing, so a re-run is safe', async () => {
    const { api } = fakeApi(409, { detail: 'exists' });
    await expect(createFlag({ api, flag, log: jest.fn() })).resolves.toEqual({
      created: false,
      name: 'orders-svc.new-checkout',
    });
  });

  it.each([401, 403])(
    'explains what to fix when the flag API refuses Backstage (%p)',
    async status => {
      const { api } = fakeApi(status);
      await expect(createFlag({ api, flag, log: jest.fn() })).rejects.toThrow(
        /KUBE_ADMIN_SERVICEACCOUNTS/,
      );
    },
  );

  it('shows the flag API answer on any other status', async () => {
    const { api } = fakeApi(422, { detail: 'bad environment' });
    await expect(createFlag({ api, flag, log: jest.fn() })).rejects.toThrow(
      /HTTP 422.*bad environment/,
    );
  });

  it('does not call the flag API for invalid input', async () => {
    const { api, calls } = fakeApi(201);
    await expect(
      createFlag({ api, flag: { ...flag, name: 'Bad Name' }, log: jest.fn() }),
    ).rejects.toThrow(/flag name/);
    expect(calls).toEqual([]);
  });
});

describe('deleteServiceFlags', () => {
  function fakeFlagStore(
    flags: { id: number; name: string }[],
    deleteStatus = 204,
  ) {
    const deleted: string[] = [];
    const api: FlagApi = {
      post: async () => ({ status: 500, body: {} }),
      get: async path => {
        expect(path).toBe('/flags');
        return { status: 200, body: flags };
      },
      delete: async path => {
        deleted.push(path);
        return { status: deleteStatus, body: {} };
      },
    };
    return { api, deleted };
  }

  it('deletes the flags of this service and no others', async () => {
    const { api, deleted } = fakeFlagStore([
      { id: 1, name: 'orders.new-checkout' },
      { id: 2, name: 'orders-v2.new-checkout' }, // another service with a similar name
      { id: 3, name: 'billing.orders.x' },
      { id: 4, name: 'orders.dark-mode' },
      { id: 5, name: 'orders' }, // not "<service>.<flag>"
    ]);
    const log = jest.fn();
    await expect(
      deleteServiceFlags({ api, service: 'orders', log }),
    ).resolves.toEqual(['orders.new-checkout', 'orders.dark-mode']);
    expect(deleted).toEqual(['/flags/1', '/flags/4']);
  });

  it('is fine with a service that has no flags', async () => {
    const { api, deleted } = fakeFlagStore([{ id: 1, name: 'billing.x' }]);
    const log = jest.fn();
    await expect(
      deleteServiceFlags({ api, service: 'orders', log }),
    ).resolves.toEqual([]);
    expect(deleted).toEqual([]);
    expect(log).toHaveBeenCalledWith('orders has no flags; nothing to delete');
  });

  it('treats a flag that is already gone as deleted (safe to run twice)', async () => {
    const { api } = fakeFlagStore([{ id: 1, name: 'orders.x' }], 404);
    await expect(
      deleteServiceFlags({ api, service: 'orders', log: jest.fn() }),
    ).resolves.toEqual(['orders.x']);
  });

  it('stops when the flag API refuses a delete', async () => {
    const { api } = fakeFlagStore([{ id: 1, name: 'orders.x' }], 403);
    await expect(
      deleteServiceFlags({ api, service: 'orders', log: jest.fn() }),
    ).rejects.toThrow(/Could not delete flag orders.x.*403/);
  });

  it('stops when the list cannot be read, instead of assuming there are none', async () => {
    const api: FlagApi = {
      post: async () => ({ status: 500, body: {} }),
      get: async () => ({ status: 401, body: {} }),
      delete: async () => ({ status: 204, body: {} }),
    };
    await expect(
      deleteServiceFlags({ api, service: 'orders', log: jest.fn() }),
    ).rejects.toThrow(/Could not list flags.*401/);
  });

  it('rejects something that is not a service name', async () => {
    const { api, deleted } = fakeFlagStore([{ id: 1, name: '.x' }]);
    await expect(
      deleteServiceFlags({ api, service: '', log: jest.fn() }),
    ).rejects.toThrow(/service name/);
    expect(deleted).toEqual([]);
  });
});
