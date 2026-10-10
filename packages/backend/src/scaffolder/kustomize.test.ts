import { addKustomizeComponent } from './kustomize';

const BASE = `# demo-svc - created by the idp python-service golden path.
#
# A comment that must survive.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - serviceaccount.yaml
  - deployment.yaml
components:
  - ../../../components/golden-path
  - ../../../components/public-route
labels:
  # On every resource, pod template and selector.
  - pairs:
      app.kubernetes.io/name: demo-svc
    includeSelectors: true
`;
const POSTGRES = '../../../components/postgres';

describe('addKustomizeComponent', () => {
  it('adds exactly one line and keeps comments and order', () => {
    const { content, changed } = addKustomizeComponent(BASE, POSTGRES);
    expect(changed).toBe(true);
    const before = BASE.split('\n');
    const after = content.split('\n');
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter(line => !before.includes(line))).toEqual([
      `  - ${POSTGRES}`,
    ]);
    // the new line sits at the end of the components list
    expect(after.indexOf(`  - ${POSTGRES}`)).toBe(
      after.indexOf('  - ../../../components/public-route') + 1,
    );
    expect(content).toContain('# A comment that must survive.');
    expect(content).toContain(
      '# On every resource, pod template and selector.',
    );
  });

  it('does nothing when the component is already listed', () => {
    const once = addKustomizeComponent(BASE, POSTGRES).content;
    expect(addKustomizeComponent(once, POSTGRES)).toEqual({
      content: once,
      changed: false,
    });
  });

  it('creates the components list when the file has none', () => {
    const withoutList = BASE.replace(/components:\n {2}- .*\n {2}- .*\n/, '');
    const { content, changed } = addKustomizeComponent(withoutList, POSTGRES);
    expect(changed).toBe(true);
    expect(content).toMatch(
      /components:\n\s+- \.\.\/\.\.\/\.\.\/components\/postgres/,
    );
  });

  it.each([
    'components/postgres',
    '../../../components/../../secrets',
    '../../../apps/other-service/base',
    'https://example.com/evil',
    '../../../components/Postgres',
    '',
  ])('refuses the path "%s"', component => {
    expect(() => addKustomizeComponent(BASE, component)).toThrow(
      /not a platform component path/,
    );
  });

  it('refuses a file that is not a Kustomization', () => {
    expect(() =>
      addKustomizeComponent(
        'kind: Deployment\nmetadata: {name: x}\n',
        POSTGRES,
      ),
    ).toThrow(/not a Kustomization/);
  });

  it('refuses invalid YAML', () => {
    expect(() => addKustomizeComponent('kind: [unclosed', POSTGRES)).toThrow(
      /not valid YAML/,
    );
  });
});
