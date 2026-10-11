/*
 * Who may do what in this portal.
 *
 * Until now every signed-in user (and the guest) could do everything, including running
 * "Decommission a service" on somebody else's service. The rule set is deliberately small:
 *
 *   1. Signed-in users may read everything and create things (services, flags, databases).
 *   2. Destructive scaffolder actions run only for members of group `platform-admins`.
 *   3. A catalog entity may be deleted by its owner or an admin; a catalog location (which
 *      removes everything registered through it) only by an admin.
 *
 * Why "allow unless listed" and not "deny unless listed": Backstage asks this policy about
 * dozens of permissions from every plugin. A deny-by-default policy must classify each of
 * them and silently breaks a feature whenever a plugin adds one. Here the dangerous
 * operations are few and named, so they are what is listed.
 *
 * The rules are plain data + one function so they can be unit tested without a backend.
 */
import { BackstageUserInfo } from '@backstage/backend-plugin-api';
import {
  catalogEntityDeletePermission,
  catalogLocationDeletePermission,
} from '@backstage/plugin-catalog-common/alpha';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';
import {
  AuthorizeResult,
  isPermission,
  PolicyDecision,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import {
  createScaffolderActionConditionalDecision,
  scaffolderActionConditions,
} from '@backstage/plugin-scaffolder-backend/alpha';
import { actionExecutePermission } from '@backstage/plugin-scaffolder-common/alpha';

/** Members may run destructive actions and delete any catalog entry (examples/org.yaml). */
export const ADMIN_GROUP = 'group:default/platform-admins';

/**
 * Scaffolder actions that destroy something. `idp:guard:platform-admin` destroys nothing: it
 * is the FIRST step of a destructive template, so a user who is not allowed is stopped before
 * anything happened instead of halfway through (a template checks each action when its step
 * starts, not all of them up front).
 */
export const ADMIN_ONLY_ACTIONS = [
  'idp:guard:platform-admin',
  'idp:aws:ecr:delete-repository',
  'idp:aws:s3:delete-docs',
  'idp:flags:delete-for-service',
  'idp:github:archive-repo',
  'idp:github:delete-repo',
  'idp:catalog:unregister',
  'github:repo:delete',
];

export function isAdmin(user: BackstageUserInfo | undefined): boolean {
  return Boolean(user?.ownershipEntityRefs.includes(ADMIN_GROUP));
}

export class IdpPermissionPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    const info = user?.info;
    if (isAdmin(info)) {
      return { result: AuthorizeResult.ALLOW };
    }

    if (isPermission(request.permission, actionExecutePermission)) {
      // Allowed for every action EXCEPT the listed ones. The scaffolder evaluates this
      // against the action id of each step.
      return createScaffolderActionConditionalDecision(request.permission, {
        not: {
          anyOf: ADMIN_ONLY_ACTIONS.map(actionId =>
            scaffolderActionConditions.hasActionId({ actionId }),
          ) as [any, ...any[]],
        },
      });
    }

    if (isPermission(request.permission, catalogEntityDeletePermission)) {
      // Only what you (or a group you are in) own.
      return createCatalogConditionalDecision(
        request.permission,
        catalogConditions.isEntityOwner({
          claims: info?.ownershipEntityRefs ?? [],
        }),
      );
    }

    if (isPermission(request.permission, catalogLocationDeletePermission)) {
      // Not tied to one entity, so it cannot be "owner only": admins only.
      return { result: AuthorizeResult.DENY };
    }

    return { result: AuthorizeResult.ALLOW };
  }
}
