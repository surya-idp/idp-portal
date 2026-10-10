/*
 * Scaffolder actions specific to this IDP. Registered in ../index.ts.
 */
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import {
  getOctokitClient,
  getOctokitOptions,
} from '@backstage/plugin-scaffolder-backend-module-github';
import {
  createTemplateAction,
  parseRepoUrl,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';
import { awaitCiAndAutoMerge, GitHubApi } from './awaitCiAndAutoMerge';

export const idpScaffolderModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-actions',
  register({ registerInit }) {
    registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        const integrations = ScmIntegrations.fromConfig(config);
        const credentialsProvider =
          DefaultGithubCredentialsProvider.fromIntegrations(integrations);

        scaffolder.addActions(
          createTemplateAction({
            id: 'idp:github:await-ci-auto-merge',
            description:
              "Waits for a new service repo's first CI run, then enables GitHub auto-merge on its deploy pull request and waits for the merge.",
            schema: {
              input: {
                serviceRepoUrl: z =>
                  z.string({
                    description:
                      'The new service repo, as github.com?owner=<owner>&repo=<name>',
                  }),
                commitSha: z =>
                  z.string({
                    description:
                      'Commit whose CI run builds the image the deploy PR pins',
                  }),
                deployRepoUrl: z =>
                  z.string({
                    description:
                      'The repo holding the deploy PR, as github.com?owner=<owner>&repo=<name>',
                  }),
                pullRequestNumber: z =>
                  z.number({ description: 'Number of the deploy PR' }),
                token: z =>
                  z
                    .string({
                      description:
                        'Token used to read workflow runs (the signed-in user). Defaults to the GitHub App.',
                    })
                    .optional(),
                mergeMethod: z =>
                  z.enum(['MERGE', 'SQUASH', 'REBASE']).default('SQUASH'),
                timeoutMinutes: z => z.number().default(15),
              },
              output: {
                ciRunUrl: z => z.string(),
                mergeCommitSha: z => z.string(),
              },
            },
            async handler(ctx) {
              const service = parseRepoUrl(
                ctx.input.serviceRepoUrl,
                integrations,
              );
              const deploy = parseRepoUrl(
                ctx.input.deployRepoUrl,
                integrations,
              );
              if (!service.owner || !deploy.owner) {
                throw new InputError('Both repo URLs need an owner');
              }

              const client = async (
                repo: { host: string; owner?: string; repo: string },
                token?: string,
              ): Promise<GitHubApi> => {
                const octokit = getOctokitClient(
                  await getOctokitOptions({
                    integrations,
                    credentialsProvider,
                    token,
                    host: repo.host,
                    owner: repo.owner,
                    repo: repo.repo,
                  }),
                  ctx.logger,
                );
                return {
                  request: (route, params) => octokit.request(route, params),
                  graphql: (query, variables) =>
                    octokit.graphql(query, variables),
                };
              };

              const result = await awaitCiAndAutoMerge({
                // The PR is always handled as the GitHub App, which the idp-gitops ruleset
                // does not let bypass the required checks.
                writer: await client(deploy),
                reader: await client(deploy, ctx.input.token),
                serviceRepo: { owner: service.owner, repo: service.repo },
                commitSha: ctx.input.commitSha,
                deployRepo: { owner: deploy.owner, repo: deploy.repo },
                pullRequestNumber: ctx.input.pullRequestNumber,
                mergeMethod: ctx.input.mergeMethod,
                timeoutMs: ctx.input.timeoutMinutes * 60_000,
                pollIntervalMs: 10_000,
                log: message => ctx.logger.info(message),
              });
              ctx.output('ciRunUrl', result.ciRunUrl);
              ctx.output('mergeCommitSha', result.mergeCommitSha);
            },
          }),
        );
      },
    });
  },
});
