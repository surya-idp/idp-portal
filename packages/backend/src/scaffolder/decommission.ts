/*
 * Logic behind the scaffolder actions that the decommission-service template uses, kept free
 * of Backstage, Octokit and AWS SDK types so it can be unit tested with fakes.
 *
 * Removing a service touches four places. Each function below handles one of them and is
 * safe to run twice (a half-finished decommission can simply be started again):
 *   listFiles           -> which files a PR must delete from the deploy repo
 *   deleteEcrRepository -> the service's images
 *   archiveRepository   -> the source repo (archived, not deleted: it can be restored)
 *   unregisterEntity    -> the catalog entry
 */
import { GitHubApi, RepoRef } from './awaitCiAndAutoMerge';

/** Paths of every file under `directory` on `branch`. Throws if there are none. */
export async function listFiles(options: {
  api: GitHubApi;
  repo: RepoRef;
  branch: string;
  directory: string;
}): Promise<string[]> {
  const { api, repo, branch } = options;
  const directory = options.directory.replace(/^\/+|\/+$/g, '');
  // A decommission must never be able to wipe the whole deploy repo or a parent folder.
  if (!/^apps\/[a-z][a-z0-9-]*[a-z0-9]$/.test(directory)) {
    throw new Error(
      `Refusing to list "${options.directory}": only a single service folder apps/<name> is allowed`,
    );
  }
  const { data } = await api.request(
    'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
    { ...repo, tree_sha: branch, recursive: 'true' },
  );
  if (data.truncated) {
    throw new Error(
      `The file list of ${repo.owner}/${repo.repo} was truncated by GitHub; cannot be sure every file is found`,
    );
  }
  const files: string[] = (data.tree ?? [])
    .filter(
      (entry: any) =>
        entry.type === 'blob' && entry.path.startsWith(`${directory}/`),
    )
    .map((entry: any) => entry.path);
  if (files.length === 0) {
    throw new Error(
      `No files under ${directory} in ${repo.owner}/${repo.repo}@${branch}: nothing to remove`,
    );
  }
  return files;
}

/** The one ECR call this needs; satisfied by a thin wrapper around the AWS SDK client. */
export interface EcrApi {
  /** Deletes the repository with all its images. Rejects with `name` set on AWS errors. */
  deleteRepository(repositoryName: string): Promise<void>;
}

/** Deletes ECR svc/<name>. Returns false when it did not exist (already removed). */
export async function deleteEcrRepository(options: {
  ecr: EcrApi;
  serviceName: string;
  log: (message: string) => void;
}): Promise<boolean> {
  const { ecr, serviceName, log } = options;
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(serviceName)) {
    throw new Error(`"${serviceName}" is not a valid service name`);
  }
  // Template services live under svc/; the pod's IAM role allows nothing else either.
  const repositoryName = `svc/${serviceName}`;
  try {
    await ecr.deleteRepository(repositoryName);
    log(`Deleted ECR repository ${repositoryName} and its images`);
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'RepositoryNotFoundException') {
      log(`ECR repository ${repositoryName} does not exist; nothing to delete`);
      return false;
    }
    throw new Error(
      `Could not delete ECR repository ${repositoryName}: ${
        (error as Error).message
      }`,
    );
  }
}

/** Archives the repo (read-only, restorable). Returns false when it already was. */
export async function archiveRepository(options: {
  api: GitHubApi;
  repo: RepoRef;
  log: (message: string) => void;
}): Promise<boolean> {
  const { api, repo, log } = options;
  const name = `${repo.owner}/${repo.repo}`;
  const { data } = await api.request('GET /repos/{owner}/{repo}', { ...repo });
  if (data.archived) {
    log(`${name} is already archived`);
    return false;
  }
  await api.request('PATCH /repos/{owner}/{repo}', { ...repo, archived: true });
  log(
    `Archived ${name} (read-only; an owner can unarchive it in the repo settings)`,
  );
  return true;
}

/** The catalog calls this needs; satisfied by Backstage's CatalogService. */
export interface CatalogApi {
  getLocationIdByEntity(entityRef: string): Promise<string | undefined>;
  removeLocationById(id: string): Promise<void>;
}

/** Removes the Location that registered the entity (and with it the entity). */
export async function unregisterEntity(options: {
  catalog: CatalogApi;
  entityRef: string;
  log: (message: string) => void;
}): Promise<boolean> {
  const { catalog, entityRef, log } = options;
  const locationId = await catalog.getLocationIdByEntity(entityRef);
  if (!locationId) {
    log(`${entityRef} has no registered location; nothing to unregister`);
    return false;
  }
  await catalog.removeLocationById(locationId);
  log(`Unregistered ${entityRef} from the catalog`);
  return true;
}
