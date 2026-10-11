/*
 * Scaffolder actions specific to this IDP. Registered in ../index.ts.
 *
 *   idp:github:await-ci-auto-merge   python-service (first deploy) and decommission-service
 *   idp:github:list-files            decommission-service
 *   idp:aws:ecr:delete-repository    decommission-service
 *   idp:github:archive-repo          decommission-service
 *   idp:catalog:unregister           decommission-service
 *   idp:gitops:add-component         add-postgres-database (and any later opt-in component)
 *   idp:flags:create                 add-feature-flag
 *
 * Each handler is thin wiring; the behaviour lives in awaitCiAndAutoMerge.ts,
 * decommission.ts, kustomize.ts and flags.ts, which have unit tests.
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
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { DeleteRepositoryCommand, ECRClient } from '@aws-sdk/client-ecr';
import { awaitCiAndAutoMerge, GitHubApi } from './awaitCiAndAutoMerge';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { addKustomizeComponent } from './kustomize';
import { createFlag, flagRequest } from './flags';
import {
  archiveRepository,
  deleteEcrRepository,
  listFiles,
  unregisterEntity,
} from './decommission';

export const idpScaffolderModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-actions',
  register({ registerInit }) {
    registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
        catalog: catalogServiceRef,
      },
      async init({ scaffolder, config, catalog }) {
        const integrations = ScmIntegrations.fromConfig(config);
        const credentialsProvider =
          DefaultGithubCredentialsProvider.fromIntegrations(integrations);

        // An Octokit client reduced to the two calls the logic files use. Without a token
        // it authenticates as the GitHub App installed on the repo's owner.
        const githubClient = async (
          repo: { host: string; owner?: string; repo: string },
          logger: Parameters<typeof getOctokitClient>[1],
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
            logger,
          );
          return {
            request: (route, params) => octokit.request(route, params),
            graphql: (query, variables) => octokit.graphql(query, variables),
          };
        };

        scaffolder.addActions(
          createTemplateAction({
            id: 'idp:github:await-ci-auto-merge',
            description:
              "Waits for a new service repo's first CI run, then enables GitHub auto-merge on its deploy pull request and waits for the merge.",
            schema: {
              input: {
                serviceRepoUrl: z =>
                  z
                    .string({
                      description:
                        'The new service repo, as github.com?owner=<owner>&repo=<name>. Leave out (with commitSha) when the PR pins no image, for example a removal PR.',
                    })
                    .optional(),
                commitSha: z =>
                  z
                    .string({
                      description:
                        'Commit whose CI run builds the image the deploy PR pins',
                    })
                    .optional(),
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
                  z
                    .enum(['MERGE', 'SQUASH', 'REBASE'])
                    .describe('Default: SQUASH')
                    .optional(),
                timeoutMinutes: z =>
                  z.number().describe('Default: 15').optional(),
              },
              output: {
                ciRunUrl: z => z.string(),
                mergeCommitSha: z => z.string(),
              },
            },
            async handler(ctx) {
              const deploy = parseRepoUrl(
                ctx.input.deployRepoUrl,
                integrations,
              );
              if (!deploy.owner) {
                throw new InputError('deployRepoUrl needs an owner');
              }
              // Both or neither: a repo without a commit (or the reverse) is a template bug.
              if (
                Boolean(ctx.input.serviceRepoUrl) !==
                Boolean(ctx.input.commitSha)
              ) {
                throw new InputError(
                  'serviceRepoUrl and commitSha must be given together, or both left out',
                );
              }
              const service = ctx.input.serviceRepoUrl
                ? parseRepoUrl(ctx.input.serviceRepoUrl, integrations)
                : undefined;
              if (service && !service.owner) {
                throw new InputError('serviceRepoUrl needs an owner');
              }

              const result = await awaitCiAndAutoMerge({
                // The PR is always handled as the GitHub App, which the idp-gitops ruleset
                // does not let bypass the required checks.
                writer: await githubClient(deploy, ctx.logger),
                reader: await githubClient(deploy, ctx.logger, ctx.input.token),
                serviceRepo: service && {
                  owner: service.owner!,
                  repo: service.repo,
                },
                commitSha: ctx.input.commitSha,
                deployRepo: { owner: deploy.owner, repo: deploy.repo },
                pullRequestNumber: ctx.input.pullRequestNumber,
                // Defaults are applied here: the scaffolder validates the input against the
                // schema but does not fill in schema defaults (first live run, 2026-10-10:
                // an undefined merge method reached GitHub).
                mergeMethod: ctx.input.mergeMethod ?? 'SQUASH',
                timeoutMs: (ctx.input.timeoutMinutes ?? 15) * 60_000,
                pollIntervalMs: 10_000,
                log: message => ctx.logger.info(message),
              });
              ctx.output('ciRunUrl', result.ciRunUrl);
              ctx.output('mergeCommitSha', result.mergeCommitSha);
            },
          }),

          createTemplateAction({
            id: 'idp:github:list-files',
            description:
              'Lists every file under one service folder (apps/<name>) of a repo, for a pull request that removes it.',
            supportsDryRun: true,
            schema: {
              input: {
                repoUrl: z =>
                  z.string({
                    description: 'github.com?owner=<owner>&repo=<name>',
                  }),
                directory: z =>
                  z.string({ description: 'The folder, as apps/<name>' }),
                branch: z =>
                  z.string({ description: 'Default: main' }).optional(),
              },
              output: {
                files: z => z.array(z.string()),
              },
            },
            async handler(ctx) {
              const repo = parseRepoUrl(ctx.input.repoUrl, integrations);
              if (!repo.owner) {
                throw new InputError('repoUrl needs an owner');
              }
              // A dry run must not call GitHub; the folder name is still validated by the
              // same rule, through a fake listing.
              const api: GitHubApi = ctx.isDryRun
                ? {
                    request: async () => ({
                      data: {
                        truncated: false,
                        tree: [
                          {
                            type: 'blob',
                            path: `${ctx.input.directory}/dry-run-placeholder.yaml`,
                          },
                        ],
                      },
                    }),
                    graphql: async () => ({}),
                  }
                : await githubClient(repo, ctx.logger);
              const files = await listFiles({
                api,
                repo: { owner: repo.owner, repo: repo.repo },
                branch: ctx.input.branch ?? 'main',
                directory: ctx.input.directory,
              });
              ctx.logger.info(
                `${files.length} file(s) under ${ctx.input.directory}`,
              );
              ctx.output('files', files);
            },
          }),

          createTemplateAction({
            id: 'idp:gitops:add-component',
            description:
              "Adds a platform component (for example postgres) to a service's base kustomization, as a file in the workspace for a pull request.",
            supportsDryRun: true,
            schema: {
              input: {
                repoUrl: z =>
                  z.string({
                    description: 'github.com?owner=<owner>&repo=<name>',
                  }),
                directory: z =>
                  z.string({
                    description: "The service's folder, as apps/<name>",
                  }),
                component: z =>
                  z.string({
                    description:
                      'Component name under components/, for example postgres',
                  }),
                branch: z =>
                  z.string({ description: 'Default: main' }).optional(),
              },
              output: {
                changed: z => z.boolean(),
                path: z => z.string(),
              },
            },
            async handler(ctx) {
              const repo = parseRepoUrl(ctx.input.repoUrl, integrations);
              if (!repo.owner) {
                throw new InputError('repoUrl needs an owner');
              }
              const directory = ctx.input.directory.replace(/^\/+|\/+$/g, '');
              if (!/^apps\/[a-z][a-z0-9-]*[a-z0-9]$/.test(directory)) {
                throw new InputError(
                  `"${ctx.input.directory}" is not a service folder apps/<name>`,
                );
              }
              const path = `${directory}/base/kustomization.yaml`;
              // A dry run must not call GitHub: edit a minimal stand-in file instead.
              let current =
                'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - deployment.yaml\ncomponents:\n  - ../../../components/golden-path\n';
              if (!ctx.isDryRun) {
                const api = await githubClient(repo, ctx.logger);
                const { data } = await api.request(
                  'GET /repos/{owner}/{repo}/contents/{path}',
                  {
                    owner: repo.owner,
                    repo: repo.repo,
                    path,
                    ref: ctx.input.branch ?? 'main',
                  },
                );
                current = Buffer.from(data.content, 'base64').toString('utf8');
              }
              const result = addKustomizeComponent(
                current,
                `../../../components/${ctx.input.component}`,
              );
              if (result.changed) {
                // Same relative path as in the repo, so the pull-request step changes
                // exactly this one file.
                const target = resolveSafeChildPath(ctx.workspacePath, path);
                await mkdir(nodePath.dirname(target), { recursive: true });
                await writeFile(target, result.content);
                ctx.logger.info(
                  `Added component ${ctx.input.component} to ${path}`,
                );
              } else {
                ctx.logger.info(
                  `${path} already uses component ${ctx.input.component}; nothing to change`,
                );
              }
              ctx.output('changed', result.changed);
              ctx.output('path', path);
            },
          }),

          createTemplateAction({
            id: 'idp:flags:create',
            description:
              "Creates a feature flag for a service in the platform's flag API, as Backstage's own Kubernetes ServiceAccount. A flag that already exists is left unchanged.",
            supportsDryRun: true,
            schema: {
              input: {
                service: z =>
                  z.string({ description: 'The service that owns the flag' }),
                name: z =>
                  z.string({
                    description:
                      'Short flag name, for example new-checkout. Stored as <service>.<name>',
                  }),
                type: z => z.enum(['boolean', 'percentage']),
                enabled: z =>
                  z
                    .boolean()
                    .describe(
                      'boolean: on or off for everyone. percentage: the answer outside the rollout. Default: false',
                    )
                    .optional(),
                rolloutPercentage: z =>
                  z
                    .number()
                    .describe('percentage flags only: 0 to 100')
                    .optional(),
                description: z => z.string().optional(),
                environment: z =>
                  z.string().describe('Default: dev').optional(),
              },
              output: {
                created: z => z.boolean(),
                flagName: z => z.string(),
              },
            },
            async handler(ctx) {
              const flag = {
                service: ctx.input.service,
                name: ctx.input.name,
                type: ctx.input.type,
                // Defaults are applied here, not in the schema (see await-ci-auto-merge).
                enabled: ctx.input.enabled ?? false,
                // The form sends a percentage even for a boolean flag; it means nothing there.
                rolloutPercentage:
                  ctx.input.type === 'percentage'
                    ? ctx.input.rolloutPercentage
                    : undefined,
                description: ctx.input.description,
                environment: ctx.input.environment ?? 'dev',
              };
              if (ctx.isDryRun) {
                // Validate the input the same way, but do not call the flag API.
                const body = flagRequest(flag);
                ctx.logger.info(`Dry run: would create flag ${body.name}`);
                ctx.output('created', false);
                ctx.output('flagName', body.name as string);
                return;
              }
              // Set by the platform on the Backstage pod (idp-gitops apps/idp-portal): the
              // flag API's address and a ServiceAccount token that is valid for it only.
              const url = process.env.FLAG_API_URL;
              const tokenFile = process.env.FLAG_API_TOKEN_FILE;
              if (!url || !tokenFile) {
                throw new InputError(
                  'FLAG_API_URL and FLAG_API_TOKEN_FILE are not set: this action works only inside the cluster',
                );
              }
              const result = await createFlag({
                api: {
                  post: async (path, body) => {
                    // Read on every call: Kubernetes replaces the file before it expires.
                    const token = (await readFile(tokenFile, 'utf8')).trim();
                    const response = await fetch(
                      `${url.replace(/\/+$/, '')}${path}`,
                      {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${token}`,
                        },
                        body: JSON.stringify(body),
                        signal: AbortSignal.timeout(10_000),
                      },
                    );
                    return {
                      status: response.status,
                      body: await response.json().catch(() => ({})),
                    };
                  },
                },
                flag,
                log: message => ctx.logger.info(message),
              });
              ctx.output('created', result.created);
              ctx.output('flagName', result.name);
            },
          }),

          createTemplateAction({
            id: 'idp:aws:ecr:delete-repository',
            description:
              "Deletes an ECR repository under svc/ with its images. Uses the pod's IAM role, which may only delete under svc/.",
            schema: {
              input: {
                repositoryName: z =>
                  z.string({ description: 'The repository, as svc/<name>' }),
              },
              output: {
                deleted: z => z.boolean(),
              },
            },
            async handler(ctx) {
              // Region and credentials come from the pod (IRSA sets AWS_REGION and the
              // web identity token); nothing is configured here.
              const client = new ECRClient({});
              const deleted = await deleteEcrRepository({
                ecr: {
                  deleteRepository: async repositoryName => {
                    await client.send(
                      new DeleteRepositoryCommand({
                        repositoryName,
                        force: true,
                      }),
                    );
                  },
                },
                repositoryName: ctx.input.repositoryName,
                log: message => ctx.logger.info(message),
              });
              ctx.output('deleted', deleted);
            },
          }),

          createTemplateAction({
            id: 'idp:github:archive-repo',
            description:
              'Archives a repository (read-only, restorable) as the GitHub App.',
            schema: {
              input: {
                projectSlug: z =>
                  z.string({
                    description:
                      'The repository as <owner>/<name>, the value of the catalog annotation github.com/project-slug',
                  }),
              },
              output: {
                archived: z => z.boolean(),
              },
            },
            async handler(ctx) {
              const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(
                ctx.input.projectSlug,
              );
              if (!match) {
                throw new InputError(
                  `"${ctx.input.projectSlug}" is not an <owner>/<name> repository`,
                );
              }
              const repo = {
                host: 'github.com',
                owner: match[1],
                repo: match[2],
              };
              const archived = await archiveRepository({
                api: await githubClient(repo, ctx.logger),
                repo: { owner: repo.owner, repo: repo.repo },
                log: message => ctx.logger.info(message),
              });
              ctx.output('archived', archived);
            },
          }),

          createTemplateAction({
            id: 'idp:catalog:unregister',
            description:
              'Removes the catalog location that registered an entity, and with it the entity.',
            schema: {
              input: {
                entityRef: z =>
                  z.string({
                    description: 'For example component:default/my-svc',
                  }),
              },
              output: {
                unregistered: z => z.boolean(),
              },
            },
            async handler(ctx) {
              // Acts as the person who started the task, so catalog permissions apply to them.
              const credentials = await ctx.getInitiatorCredentials();
              const unregistered = await unregisterEntity({
                catalog: {
                  getLocationIdByEntity: async entityRef =>
                    (
                      await catalog.getLocationByEntity(entityRef, {
                        credentials,
                      })
                    )?.id,
                  removeLocationById: id =>
                    catalog.removeLocationById(id, { credentials }),
                },
                entityRef: ctx.input.entityRef,
                log: message => ctx.logger.info(message),
              });
              ctx.output('unregistered', unregistered);
            },
          }),
        );
      },
    });
  },
});
