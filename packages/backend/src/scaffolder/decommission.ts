/*
 * Logic behind the scaffolder actions that the decommission-service template uses, kept free
 * of Backstage, Octokit and AWS SDK types so it can be unit tested with fakes.
 *
 * Removing a service touches several places. Which ones is not assumed here: the template
 * reads it from annotations that the service's own template wrote at creation time, so one
 * decommission template serves every golden-path template. Each function below handles one
 * kind of resource and is safe to run twice (a half-finished run can be started again):
 *   listFiles           -> which files a PR must delete from the deploy repo
 *   deleteEcrRepository -> the service's images
 *   archiveRepository   -> the source repo (archived, not deleted: it can be restored)
 *   unregisterEntity    -> the catalog entry
 *   deleteDocs          -> the documentation site in the docs bucket (TechDocs)
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

/** Deletes an ECR repository under svc/. Returns false when it did not exist. */
export async function deleteEcrRepository(options: {
  ecr: EcrApi;
  repositoryName: string;
  log: (message: string) => void;
}): Promise<boolean> {
  const { ecr, repositoryName, log } = options;
  // Golden-path images live under svc/. The name comes from a catalog annotation, so it is
  // checked here as well as by the pod's IAM role, which allows nothing outside svc/ either.
  if (!/^svc\/[a-z][a-z0-9-]*[a-z0-9]$/.test(repositoryName)) {
    throw new Error(
      `Refusing to delete "${repositoryName}": only a repository svc/<name> is allowed`,
    );
  }
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

/** The two S3 calls this needs; satisfied by a thin wrapper around the AWS SDK client. */
export interface DocsStore {
  /** Keys of every object under `prefix`. */
  list(prefix: string): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
}

/**
 * Deletes a service's documentation site from the docs bucket. The site was uploaded by the
 * service's CI under default/component/<name>/ and is not touched by anything else, so
 * without this step the pages of a removed service would stay in the permanent bucket
 * forever (seen 2026-10-11). Returns the number of objects deleted.
 */
export async function deleteDocs(options: {
  store: DocsStore;
  name: string;
  log: (message: string) => void;
}): Promise<number> {
  const { store, name, log } = options;
  // The name becomes part of a prefix that is then deleted recursively: it must be exactly
  // one service name, never empty and never a path.
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) {
    throw new Error(`Refusing to delete docs of "${name}": not a service name`);
  }
  // The trailing slash keeps "orders" from matching "orders-v2/...".
  const prefix = `default/component/${name}/`;
  const keys = await store.list(prefix);
  const outside = keys.filter(key => !key.startsWith(prefix));
  if (outside.length > 0) {
    throw new Error(
      `The docs bucket listed objects outside ${prefix}; nothing was deleted`,
    );
  }
  if (keys.length === 0) {
    log(`No documentation under ${prefix}; nothing to delete`);
    return 0;
  }
  await store.delete(keys);
  log(`Deleted ${keys.length} documentation file(s) under ${prefix}`);
  return keys.length;
}
