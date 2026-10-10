#!/usr/bin/env node
/*
 * Render a software template with the real scaffolder, through the dry-run API of a running
 * backend, and write the result to a directory.
 *
 *   node scripts/template-dry-run.mjs <template dir> <values.json> <output dir>
 *
 * Environment: BACKSTAGE_URL (default http://localhost:7107), TEMPLATE_CI_TOKEN (the static
 * token from scripts/template-ci.app-config.yaml), DRY_RUN_VERBOSE=1 for the full scaffolder log.
 *
 * Outputs of skipped steps are the scaffolder's placeholder "<example>" (for instance the
 * commit hash that pins the first image).
 *
 * A dry run executes the steps that support it (fetch:template, catalog:write, the pull
 * request step) and skips the rest (creating the repo, registering, auto-merge), so nothing
 * leaves the machine. Same engine and same Nunjucks settings as a real run; that is the
 * point of using it instead of a home-made renderer.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [templateDir, valuesFile, outDir] = process.argv.slice(2);
if (!templateDir || !valuesFile || !outDir) {
  console.error(
    'usage: template-dry-run.mjs <template dir> <values.json> <output dir>',
  );
  process.exit(2);
}
const baseUrl = process.env.BACKSTAGE_URL ?? 'http://localhost:7107';
const token = process.env.TEMPLATE_CI_TOKEN;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

// The template entity is the first YAML document of template.yaml. The backend parses it;
// here it only has to become JSON, which the backend's own YAML library does for us.
const { parse } = await import('yaml');
const template = parse(
  fs.readFileSync(path.join(templateDir, 'template.yaml'), 'utf8'),
);
const { values, secrets } = JSON.parse(fs.readFileSync(valuesFile, 'utf8'));

const directoryContents = [...walk(templateDir)].map(file => ({
  path: path.relative(templateDir, file).split(path.sep).join('/'),
  base64Content: fs.readFileSync(file).toString('base64'),
}));

const response = await fetch(`${baseUrl}/api/scaffolder/v2/dry-run`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({ template, values, secrets, directoryContents }),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`dry-run failed: HTTP ${response.status}`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

// One line per step (completed / skipped / failed); everything with DRY_RUN_VERBOSE=1.
for (const entry of body.log ?? []) {
  const { stepId, message, status } = entry.body ?? {};
  if (
    process.env.DRY_RUN_VERBOSE ||
    ['completed', 'skipped', 'failed'].includes(status)
  ) {
    console.log(
      `[${stepId ?? 'task'}]${status ? ` (${status})` : ''} ${message ?? ''}`,
    );
  }
}
const failed = (body.log ?? []).filter(e => e.body?.status === 'failed');
if (failed.length > 0) {
  console.error(`dry-run: ${failed.length} step(s) failed`);
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
// A template that only removes things leaves an empty workspace.
fs.mkdirSync(outDir, { recursive: true });
for (const file of body.directoryContents ?? []) {
  const target = path.join(outDir, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(file.base64Content, 'base64'), {
    mode: file.executable ? 0o755 : 0o644,
  });
}
fs.writeFileSync(
  path.join(outDir, '.dry-run-output.json'),
  JSON.stringify(body.output ?? {}, null, 2),
);
console.log(
  `dry-run: wrote ${(body.directoryContents ?? []).length} files to ${outDir}`,
);
