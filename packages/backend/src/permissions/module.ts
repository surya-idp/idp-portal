/* Installs IdpPermissionPolicy (policy.ts) as the portal's permission policy. */
import { createBackendModule } from '@backstage/backend-plugin-api';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import { IdpPermissionPolicy } from './policy';

export const idpPermissionPolicyModule = createBackendModule({
  pluginId: 'permission',
  moduleId: 'idp-policy',
  register({ registerInit }) {
    registerInit({
      deps: { policy: policyExtensionPoint },
      async init({ policy }) {
        policy.setPolicy(new IdpPermissionPolicy());
      },
    });
  },
});
