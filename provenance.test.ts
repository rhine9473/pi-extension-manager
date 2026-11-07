import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProvenanceReader } from './provenance.ts';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-manager-authors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function pkg(root, name, metadata) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(metadata));
  return { source: `npm:${metadata?.name ?? name}`, installedPath: dir };
}

test('author metadata groups different packages together without exposing author email', (t) => {
  const root = fixture(t), reader = createProvenanceReader();
  const a = pkg(root, 'a', { name: '@example/a', author: { name: 'Alice', email: 'private@example.test' }, repository: 'https://github.com/team/a' });
  const b = pkg(root, 'b', { name: '@example/b', author: 'Alice <private@example.test> (https://example.test)' });
  assert.equal(reader.package(a).group, 'Alice'); assert.equal(reader.package(b).group, 'Alice');
  assert.equal(reader.package(a).packageName, 'a'); assert.equal(reader.package(a).credit, '作者：Alice');
  assert.ok(!JSON.stringify(reader.package(b)).includes('private@'));
});

test('repository and npm scope fallbacks are labelled as ownership rather than an invented author', (t) => {
  const root = fixture(t), reader = createProvenanceReader();
  const a = pkg(root, 'sync', { name: '@narumitw/pi-sync', repository: { url: 'git+https://github.com/narumiruna/pi-extensions.git' } });
  assert.equal(reader.package(a).group, 'narumiruna'); assert.equal(reader.package(a).credit, '仓库归属：narumiruna');
  assert.equal(reader.package({ source: 'npm:@example/tools' }).group, '@example');
  assert.equal(reader.package({ source: 'git:github.com/team/tools@v1' }).group, 'team');
});

test('generic dist entry uses package identity; local files and builtins keep honest separate groups', (t) => {
  const root = fixture(t), reader = createProvenanceReader();
  const a = pkg(root, 'sync', { name: '@narumitw/pi-sync', repository: 'https://github.com/narumiruna/pi-extensions' });
  const resource = { path: path.join(a.installedPath, 'dist/index.ts'), metadata: { origin: 'package', source: a.source, packageRoot: a.installedPath } };
  assert.equal(reader.resource(resource).name, 'pi-sync'); assert.equal(reader.resource(resource).group, 'narumiruna');
  const extensions = path.join(root, 'extensions'); fs.mkdirSync(extensions);
  fs.writeFileSync(path.join(extensions, 'package.json'), JSON.stringify({ author: 'Collection owner' }));
  const local = reader.resource({ path: path.join(extensions, 'loose.ts'), metadata: { source: 'auto' } });
  assert.equal(local.group, '本地扩展（作者未标注）'); assert.equal(local.groupOrder, 0);
  const builtin = reader.resource({ path: 'builtin:mcp', metadata: { source: 'builtin' } });
  assert.equal(builtin.group, 'Pi 内置'); assert.equal(builtin.groupOrder, 2);
  assert.equal(builtin.name, 'mcp', 'builtins should not show the raw builtin: id');
});

test('malformed manifests are tolerated and a new reader sees updated metadata', (t) => {
  const root = fixture(t); const item = pkg(root, 'bad', null);
  const reader = createProvenanceReader();
  assert.equal(reader.package(item).credit, '作者：未标注');
  fs.writeFileSync(path.join(item.installedPath, 'package.json'), JSON.stringify({ author: 'New author' }));
  assert.equal(createProvenanceReader().package(item).group, 'New author');
});
