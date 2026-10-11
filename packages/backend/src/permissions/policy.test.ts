import {
  catalogEntityDeletePermission,
  catalogEntityReadPermission,
  catalogLocationDeletePermission,
} from '@backstage/plugin-catalog-common/alpha';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { PolicyQueryUser } from '@backstage/plugin-permission-node';
import {
  actionExecutePermission,
  taskCreatePermission,
} from '@backstage/plugin-scaffolder-common/alpha';
import { ADMIN_GROUP, ADMIN_ONLY_ACTIONS, IdpPermissionPolicy } from './policy';

const policy = new IdpPermissionPolicy();

function user(...groups: string[]): PolicyQueryUser {
  const userEntityRef = 'user:default/someone';
  return {
    info: { userEntityRef, ownershipEntityRefs: [userEntityRef, ...groups] },
    credentials: {} as PolicyQueryUser['credentials'],
  } as PolicyQueryUser;
}
const admin = user(ADMIN_GROUP);
const developer = user('group:default/team-orders');

/** Evaluates a conditional scaffolder decision for one action id. */
function allowsAction(decision: any, actionId: string): boolean {
  const evaluate = (criteria: any): boolean => {
    if (criteria.not) return !evaluate(criteria.not);
    if (criteria.anyOf) return criteria.anyOf.some(evaluate);
    if (criteria.allOf) return criteria.allOf.every(evaluate);
    expect(criteria.rule).toBe('HAS_ACTION_ID');
    return criteria.params.actionId === actionId;
  };
  return evaluate(decision.conditions);
}

describe('IdpPermissionPolicy', () => {
  it('lets an admin do everything', async () => {
    for (const permission of [
      actionExecutePermission,
      catalogEntityDeletePermission,
      catalogLocationDeletePermission,
      catalogEntityReadPermission,
    ]) {
      expect(await policy.handle({ permission }, admin)).toEqual({
        result: AuthorizeResult.ALLOW,
      });
    }
  });

  it('lets a developer read the catalog and start templates', async () => {
    for (const permission of [
      catalogEntityReadPermission,
      taskCreatePermission,
    ]) {
      expect(await policy.handle({ permission }, developer)).toEqual({
        result: AuthorizeResult.ALLOW,
      });
    }
  });

  it('lets a developer run ordinary actions but none of the destructive ones', async () => {
    const decision = await policy.handle(
      { permission: actionExecutePermission },
      developer,
    );
    expect(decision.result).toBe(AuthorizeResult.CONDITIONAL);
    for (const id of [
      'fetch:template',
      'publish:github',
      'publish:github:pull-request',
      'idp:github:await-ci-auto-merge',
      'idp:gitops:add-component',
      'idp:flags:create',
      'catalog:register',
    ]) {
      expect(allowsAction(decision, id)).toBe(true);
    }
    for (const id of ADMIN_ONLY_ACTIONS) {
      expect(allowsAction(decision, id)).toBe(false);
    }
  });

  it('covers every action that destroys something', () => {
    // A new destructive action must be added to the list; this pins today's set.
    expect(ADMIN_ONLY_ACTIONS).toEqual(
      expect.arrayContaining([
        'idp:guard:platform-admin',
        'idp:aws:ecr:delete-repository',
        'idp:aws:s3:delete-docs',
        'idp:flags:delete-for-service',
        'idp:github:archive-repo',
        'idp:github:delete-repo',
        'idp:catalog:unregister',
      ]),
    );
  });

  it('lets a developer delete only catalog entries they own', async () => {
    const decision: any = await policy.handle(
      { permission: catalogEntityDeletePermission },
      developer,
    );
    expect(decision.result).toBe(AuthorizeResult.CONDITIONAL);
    expect(decision.conditions).toMatchObject({
      rule: 'IS_ENTITY_OWNER',
      params: {
        claims: ['user:default/someone', 'group:default/team-orders'],
      },
    });
  });

  it('does not let a developer remove a catalog location', async () => {
    expect(
      await policy.handle(
        { permission: catalogLocationDeletePermission },
        developer,
      ),
    ).toEqual({ result: AuthorizeResult.DENY });
  });

  it('treats a caller without a user (no groups) like a developer, not an admin', async () => {
    const decision = await policy.handle(
      { permission: actionExecutePermission },
      undefined,
    );
    expect(decision.result).toBe(AuthorizeResult.CONDITIONAL);
    expect(allowsAction(decision, 'idp:github:archive-repo')).toBe(false);
  });

  it('does not make someone an admin for a group with a similar name', async () => {
    const decision = await policy.handle(
      { permission: catalogLocationDeletePermission },
      user(
        'group:default/platform-admins-wannabe',
        'group:other/platform-admins',
      ),
    );
    expect(decision).toEqual({ result: AuthorizeResult.DENY });
  });
});
