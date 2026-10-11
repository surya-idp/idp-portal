/*
 * Logic behind idp:flags:create (template add-feature-flag), free of Backstage types so it can
 * be unit tested with a fake flag API.
 *
 * A flag belongs to a service: it is stored as "<service>.<flag>", and the service's helper
 * (templates/python-service/skeleton/app/flags.py) adds the same prefix when it asks. Two
 * services can therefore both have a flag called "new-checkout".
 *
 * Safe to run twice: a flag that already exists is reported, not an error, and is left as it
 * is (changing a live flag from a "create" form would be a surprise).
 */

export interface FlagApi {
  /** POSTs JSON to the flag API. Resolves for every HTTP status; rejects only on network errors. */
  post(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
}

export type FlagType = 'boolean' | 'percentage';

export interface NewFlag {
  service: string;
  name: string;
  type: FlagType;
  /** What the flag answers: for boolean, for everyone; for percentage, outside the rollout. */
  enabled: boolean;
  rolloutPercentage?: number;
  description?: string;
  environment: string;
}

const NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/** The name under which the flag is stored: "<service>.<flag>". */
export function qualifiedFlagName(service: string, name: string): string {
  if (!NAME.test(service)) {
    throw new Error(`"${service}" is not a service name`);
  }
  if (!NAME.test(name) || name.length > 60) {
    throw new Error(
      `"${name}" is not a valid flag name: lower-case letters, digits and dashes, starting with a letter, at most 60 characters`,
    );
  }
  return `${service}.${name}`;
}

/** The request body for POST /flags. Throws on input the flag API would reject anyway. */
export function flagRequest(flag: NewFlag): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: qualifiedFlagName(flag.service, flag.name),
    flag_type: flag.type,
    default_value: flag.enabled,
    environment: flag.environment,
    description: flag.description?.trim() || `Flag of service ${flag.service}`,
  };
  if (flag.type === 'percentage') {
    const percentage = flag.rolloutPercentage;
    if (
      percentage === undefined ||
      !Number.isInteger(percentage) ||
      percentage < 0 ||
      percentage > 100
    ) {
      throw new Error(
        'A percentage flag needs a rollout percentage: a whole number from 0 to 100',
      );
    }
    body.rollout_percentage = percentage;
  } else if (flag.rolloutPercentage !== undefined) {
    throw new Error('Only a percentage flag has a rollout percentage');
  }
  return body;
}

/** Creates the flag. Returns false when it already existed. */
export async function createFlag(options: {
  api: FlagApi;
  flag: NewFlag;
  log: (message: string) => void;
}): Promise<{ created: boolean; name: string }> {
  const { api, flag, log } = options;
  const body = flagRequest(flag);
  const name = body.name as string;
  const response = await api.post('/flags', body);
  if (response.status === 201) {
    log(`Created flag ${name} (${flag.type}) in ${flag.environment}`);
    return { created: true, name };
  }
  if (response.status === 409) {
    log(`Flag ${name} already exists in ${flag.environment}; left unchanged`);
    return { created: false, name };
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `The flag API refused Backstage (HTTP ${response.status}). Its ServiceAccount must be listed in the flag API's KUBE_ADMIN_SERVICEACCOUNTS (idp-gitops apps/feature-flag-service/base/deployment.yaml)`,
    );
  }
  throw new Error(
    `The flag API answered HTTP ${response.status}: ${JSON.stringify(
      response.body,
    ).slice(0, 300)}`,
  );
}
