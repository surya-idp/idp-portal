import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import { SignInPage } from '@backstage/core-components';
import { githubAuthApiRef } from '@backstage/core-plugin-api';

// Replaces the app plugin's default (guest-only) sign-in page. GitHub sign-in uses the
// idp-backstage GitHub App's OAuth client; templates that create repos need the
// user's token, because an App installation token cannot create repos in a user account.
const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
      (
        <SignInPage
          {...props}
          providers={[
            {
              id: 'github-auth-provider',
              title: 'GitHub',
              message: 'Sign in with GitHub (needed to run templates)',
              apiRef: githubAuthApiRef,
            },
            // Guest only when running locally (`yarn start`). The deployed portal has no
            // guest: who you are decides what you may do (packages/backend/src/permissions).
            ...(process.env.NODE_ENV === 'production'
              ? []
              : ['guest' as const]),
          ]}
        />
      ),
  },
});

export const signInModule = createFrontendModule({
  pluginId: 'app',
  extensions: [signInPage],
});
