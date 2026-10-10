/*
 * Editing a service's kustomization.yaml for day-2 templates, kept free of Backstage and
 * GitHub types so it can be unit tested.
 *
 * A golden-path service opts into a platform capability (a database, later a cache ...) by
 * listing a component in the `components:` of its base kustomization. Adding that one line is
 * the whole change, so this edits the YAML document in place and keeps every comment and the
 * order of everything else: the pull request must show one added line, not a rewritten file.
 */
import { isSeq, parseDocument, YAMLSeq } from 'yaml';

export interface AddComponentResult {
  /** The new file content (identical to the input when nothing changed). */
  content: string;
  /** False when the component was already listed. */
  changed: boolean;
}

export function addKustomizeComponent(
  kustomization: string,
  component: string,
): AddComponentResult {
  // Components are referenced by relative path from the service's base folder. Refuse
  // anything else, so a template cannot make a service load files from an arbitrary place.
  if (!/^\.\.\/\.\.\/\.\.\/components\/[a-z][a-z0-9-]*$/.test(component)) {
    throw new Error(
      `"${component}" is not a platform component path (../../../components/<name>)`,
    );
  }
  const document = parseDocument(kustomization);
  if (document.errors.length > 0) {
    throw new Error(
      `kustomization.yaml is not valid YAML: ${document.errors[0].message}`,
    );
  }
  if (document.get('kind') !== 'Kustomization') {
    throw new Error('The file is not a Kustomization');
  }
  let components = document.get('components');
  if (components === undefined || components === null) {
    components = new YAMLSeq();
    document.set('components', components);
  }
  if (!isSeq(components)) {
    throw new Error('`components` in the kustomization is not a list');
  }
  if (
    components.items.some(
      item => String((item as any).value ?? item) === component,
    )
  ) {
    return { content: kustomization, changed: false };
  }
  components.add(document.createNode(component));
  return { content: document.toString({ lineWidth: 0 }), changed: true };
}
