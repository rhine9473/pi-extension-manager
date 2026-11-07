import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { backup, clean, clone, discover, identity, packageFingerprint, describeUpdateResult, readSnapshot, runPackageCommand, saveSnapshot, toggleConfig, togglePackageConfig, isPackageDisabled, verifyPackageChange, verifySingleChange, changeSummary } from './core.ts';

const host = process.env.PI_TEST_HOST || path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const api = await import(pathToFileURL(path.join(host, 'dist/index.js')).href);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-extension-manager-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = path.join(root, 'agent'); const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.pi/extensions'), { recursive: true });
  const self = path.join(agent, 'extensions/extension-manager/index.ts');
  fs.mkdirSync(path.dirname(self), { recursive: true });
  const local = path.join(agent, 'extensions/本地工具.ts');
  fs.writeFileSync(self, 'export default () => {}');
  fs.writeFileSync(local, 'throw new Error("Inventory must never execute extensions")');
  const pkgRoot = path.join(root, 'package'); fs.mkdirSync(path.join(pkgRoot, 'extensions'), { recursive: true });
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(pkgRoot, `extensions/${name}.ts`), 'throw new Error("Must not execute")');
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'test-local', version: '1.0.0', pi: { extensions: ['./extensions'] } }));
  return { root, agent, cwd, self, local, pkgRoot };
}

test('installed update evidence comes from the manifest version and its mtime', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-manager-version-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1.1.0' }));
  const first = packageFingerprint(root);
  assert.equal(first.version, '1.1.0');
  assert.ok(first.mtimeMs > 0);
  assert.deepEqual(packageFingerprint(undefined), { version: '', mtimeMs: 0 });
  assert.equal(packageFingerprint(path.join(root, 'missing')).version, '');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  assert.equal(packageFingerprint(root).version, '', 'a manifest without a version must not invent one');
  assert.match(describeUpdateResult(first, { version: '1.2.0', mtimeMs: first.mtimeMs + 1000 }), /版本 1\.1\.0 → 1\.2\.0/);
  assert.match(describeUpdateResult(first, { version: '1.1.0', mtimeMs: first.mtimeMs + 1000 }), /版本仍为 1\.1\.0，但安装文件已改写/);
  assert.match(describeUpdateResult({ version: '1.1.0', mtimeMs: 5 }, { version: '1.1.0', mtimeMs: 5 }), /均未变化/);
  assert.match(describeUpdateResult({ version: '', mtimeMs: 5 }, { version: '', mtimeMs: 9 }), /该包不声明版本，但安装文件已改写/);
  assert.match(describeUpdateResult({ version: '', mtimeMs: 5 }, { version: '', mtimeMs: 5 }), /该包不声明版本，安装文件也没有变化/);
});

test('staged changes are described as plain actions, folding a closed package over its children', () => {
  const loose = { path: 'C:/agent/extensions/本地工具.ts', enabled: true, metadata: { source: 'auto', scope: 'user', origin: 'auto' } };
  const child = (name, enabled) => ({ path: `C:/pkg/extensions/${name}.ts`, enabled, metadata: { source: 'C:/pkg', scope: 'user', origin: 'package' } });
  const off = (list) => list.map((r) => ({ ...r, enabled: false }));
  const saved = { packages: ['C:/pkg'], extensions: ['+extensions/本地工具.ts'] };

  assert.deepEqual(changeSummary([loose], [{ ...loose, enabled: false }], saved, saved), ['禁用 本地工具.ts']);
  assert.deepEqual(changeSummary([loose], [loose], saved, saved), []);

  const closed = { packages: [{ source: 'C:/pkg', extensions: [], skills: [], prompts: [], themes: [], extensionManagerDisabled: { version: 1, filters: { extensions: ['!b.ts'] }, stringSource: true } }] };
  const summary = changeSummary([child('a', true), child('b', true)], off([child('a', true), child('b', true)]), saved, closed);
  assert.deepEqual(summary, ['关闭整包 pkg（文件保留，重开时恢复单项设置）', '  ↳ 重开后恢复：禁用 b.ts']);

  const reopened = { packages: [{ source: 'C:/pkg', extensions: ['!b.ts'] }] };
  assert.deepEqual(
    changeSummary(off([child('a', true), child('b', true)]), [child('a', true), child('b', false)], closed, reopened),
    ['开启整包 pkg（恢复关闭前的单项设置）'],
  );
  assert.deepEqual(changeSummary([child('a', true)], [], saved, saved), ['移除 a.ts']);
});

test('a Windows-style rule and a POSIX-style rule address the same target', async (t) => {
  const f = fixture(t);
  const global = { extensions: ['+extensions\\本地工具.ts'] };
  const target = (await discover(api, f.cwd, f.agent, global)).resources.find((r) => r.path === f.local);
  const disabled = toggleConfig(global, target, f.agent, f.cwd, false, f.self);
  assert.ok(!disabled.extensions.some((entry) => entry.includes('\\')), JSON.stringify(disabled.extensions));
  assert.deepEqual(disabled.extensions, ['-extensions/本地工具.ts']);
  assert.equal((await discover(api, f.cwd, f.agent, disabled)).resources.find((r) => r.path === f.local).enabled, false);
});

test('discovers local, local-package and all four builtin resources without execution', async (t) => {
  const f = fixture(t);
  const result = await discover(api, f.cwd, f.agent, { packages: [f.pkgRoot] });
  assert.equal(result.resources.length, 8);
  assert.equal(result.resources.filter((r) => r.path.startsWith('builtin:')).length, 4);
  assert.ok(result.resources.some((r) => r.path === f.local));
});

test('untrusted project resources/settings are ignored', async (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.cwd, '.pi/extensions/project.ts'), 'throw new Error("Must not run")');
  const result = await discover(api, f.cwd, f.agent, {}, { packages: [f.pkgRoot] }, false);
  assert.ok(result.resources.every((r) => r.metadata.scope === 'user'));
  assert.ok(!result.resources.some((r) => r.metadata.origin === 'package'));
});

test('exact local disable and reenable affect only target; unknown fields preserved', async (t) => {
  const f = fixture(t);
  const global = { theme: 'dark', unknown: { enabled: true }, extensions: ['+extensions\\本地工具.ts'] };
  const before = (await discover(api, f.cwd, f.agent, global)).resources;
  const target = before.find((r) => r.path === f.local);
  const disabled = toggleConfig(global, target, f.agent, f.cwd, false, f.self);
  assert.deepEqual(disabled.unknown, global.unknown);
  const after = (await discover(api, f.cwd, f.agent, disabled)).resources;
  verifySingleChange(before, after, f.local, false, f.self);
  const enabled = toggleConfig(disabled, after.find((r) => r.path === f.local), f.agent, f.cwd, true, f.self);
  verifySingleChange(after, (await discover(api, f.cwd, f.agent, enabled)).resources, f.local, true, f.self);
});

test('whole-package switch disables all resource types and restores exact filters after JSON sync', async (t) => {
  const f = fixture(t);
  for (const dir of ['skills/example', 'prompts', 'themes']) fs.mkdirSync(path.join(f.pkgRoot, dir), { recursive: true });
  fs.writeFileSync(path.join(f.pkgRoot, 'skills/example/SKILL.md'), '---\nname: example\ndescription: fixture\n---\nExample');
  fs.writeFileSync(path.join(f.pkgRoot, 'prompts/example.md'), 'Example');
  fs.writeFileSync(path.join(f.pkgRoot, 'themes/example.json'), '{}');
  fs.writeFileSync(path.join(f.pkgRoot, 'package.json'), JSON.stringify({ name: 'test-local', pi: { extensions: ['./extensions'], skills: ['./skills'], prompts: ['./prompts'], themes: ['./themes'] } }));
  const original = { theme: 'dark', packages: [{ source: f.pkgRoot, extensions: ['!**/b.ts'], skills: ['skills/**'], prompts: [], custom: 'keep' }] };
  const before = await discover(api, f.cwd, f.agent, original);
  const pkg = before.packages[0];
  const closed = togglePackageConfig(original, pkg, false, f.self);
  assert.equal(isPackageDisabled(closed.packages[0]), true);
  const after = await discover(api, f.cwd, f.agent, closed);
  const members = after.allResources.filter((r) => r.metadata.source === pkg.source);
  assert.ok(members.length >= 5, 'Extensions, skills, prompts and themes must all be enumerated');
  assert.ok(members.every((r) => !r.enabled));
  verifyPackageChange(before.allResources, after.allResources, pkg, false, f.self);
  assert.throws(() => toggleConfig(closed, after.resources.find((r) => r.metadata.source === pkg.source), f.agent, f.cwd, true, f.self), /整包已关闭/);
  const restored = togglePackageConfig(JSON.parse(JSON.stringify(closed)), pkg, true, f.self);
  assert.deepEqual(restored, original);
  const reopened = await discover(api, f.cwd, f.agent, restored);
  verifyPackageChange(after.allResources, reopened.allResources, pkg, true, f.self);
  assert.deepEqual(reopened.allResources.map((r) => [r.path, r.enabled]), before.allResources.map((r) => [r.path, r.enabled]));
});

test('whole-package string source restores without losing unrelated package declarations', (t) => {
  const f = fixture(t); const pkg = { source: f.pkgRoot, scope: 'user', installedPath: f.pkgRoot };
  const original = { packages: [f.pkgRoot, 'npm:other-tools'], custom: { keep: true } };
  const closed = togglePackageConfig(original, pkg, false, f.self);
  assert.deepEqual(togglePackageConfig(closed, pkg, false, f.self), closed);
  assert.deepEqual(togglePackageConfig(closed, pkg, true, f.self), original);
  assert.equal(closed.packages[1], 'npm:other-tools');
  assert.throws(() => togglePackageConfig({ packages: ['self'] }, { source: 'self', scope: 'user', installedPath: path.dirname(f.self) }, false, f.self), /受保护/);
});

test('package restore preserves a changed version and rejects damaged or externally edited off states', (t) => {
  const f = fixture(t); const source = 'git:github.com/example/tools@v1';
  const pkg = { source, scope: 'user', installedPath: f.pkgRoot };
  const original = { packages: [{ source, extensions: ['!**/old.ts'], custom: 'before' }] };
  const closed = togglePackageConfig(original, pkg, false, f.self);
  const changed = clone(closed); changed.packages[0].source = 'git:github.com/example/tools@v2'; changed.packages[0].custom = 'after';
  const restored = togglePackageConfig(changed, { ...pkg, source: changed.packages[0].source }, true, f.self);
  assert.equal(restored.packages[0].source, changed.packages[0].source); assert.equal(restored.packages[0].custom, 'after');
  assert.deepEqual(restored.packages[0].extensions, ['!**/old.ts']);
  const damaged = clone(closed); damaged.packages[0].extensionManagerDisabled.version = 99;
  assert.throws(() => togglePackageConfig(damaged, pkg, true, f.self), /无效/);
  const edited = clone(closed); edited.packages[0].extensions = ['+extensions/a.ts'];
  assert.throws(() => togglePackageConfig(edited, pkg, true, f.self), /已变化/);
});

test('package [] remains selective when enabling exactly one child', async (t) => {
  const f = fixture(t);
  const global = { packages: [{ source: f.pkgRoot, extensions: [], skills: [], custom: 'preserve' }] };
  const before = (await discover(api, f.cwd, f.agent, global)).resources;
  const target = before.find((r) => r.path.endsWith('a.ts'));
  const next = toggleConfig(global, target, f.agent, f.cwd, true, f.self);
  const after = (await discover(api, f.cwd, f.agent, next)).resources;
  verifySingleChange(before, after, target.path, true, f.self);
  assert.equal(after.find((r) => r.path.endsWith('b.ts')).enabled, false);
  assert.deepEqual(next.packages[0].skills, []);
  assert.equal(next.packages[0].custom, 'preserve');
  const disabledAgain = toggleConfig(next, after.find((r) => r.path === target.path), f.agent, f.cwd, false, f.self);
  verifySingleChange(after, (await discover(api, f.cwd, f.agent, disabledAgain)).resources, target.path, false, f.self);
});

test('package exclusions, other resource fields and disabled siblings are preserved', async (t) => {
  const f = fixture(t);
  const global = { packages: [{ source: f.pkgRoot, extensions: ['!**/a.ts'], prompts: [] }] };
  const before = (await discover(api, f.cwd, f.agent, global)).resources;
  const target = before.find((r) => r.path.endsWith('a.ts'));
  const next = toggleConfig(global, target, f.agent, f.cwd, true, f.self);
  verifySingleChange(before, (await discover(api, f.cwd, f.agent, next)).resources, target.path, true, f.self);
  assert.equal(next.packages[0].extensions[0], '!**/a.ts');
  assert.deepEqual(next.packages[0].prompts, []);
});

test('builtin disable is configuration only, other builtins unchanged', async (t) => {
  const f = fixture(t);
  const before = (await discover(api, f.cwd, f.agent, {})).resources;
  const target = before.find((r) => r.path === 'builtin:codemode');
  const next = toggleConfig({}, target, f.agent, f.cwd, false, f.self);
  verifySingleChange(before, (await discover(api, f.cwd, f.agent, next)).resources, target.path, false, f.self);
});

test('explicit external local-file declaration can be disabled and restored', async (t) => {
  const f = fixture(t); const external = path.join(f.root, 'external.ts'); fs.writeFileSync(external, 'throw new Error("no import")');
  const config = { extensions: [external] };
  const before = (await discover(api, f.cwd, f.agent, config)).resources;
  const target = before.find((r) => r.path === external);
  const next = toggleConfig(config, target, f.agent, f.cwd, false, f.self);
  const after = (await discover(api, f.cwd, f.agent, next)).resources;
  verifySingleChange(before, after, external, false, f.self);
  const restore = toggleConfig(next, after.find((r) => r.path === external), f.agent, f.cwd, true, f.self);
  verifySingleChange(after, (await discover(api, f.cwd, f.agent, restore)).resources, external, true, f.self);
});

test('cannot disable own realpath or symlink alias', async (t) => {
  const f = fixture(t);
  const resource = { path: f.self, enabled: true, metadata: { origin: 'top-level', source: 'auto', scope: 'user' } };
  assert.throws(() => toggleConfig({}, resource, f.agent, f.cwd, false, f.self), /自身/);
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(path.dirname(f.self), alias, 'junction');
  assert.equal(identity(path.join(alias, path.basename(f.self))), identity(f.self));
  assert.throws(() => toggleConfig({}, { ...resource, path: path.join(alias, path.basename(f.self)) }, f.agent, f.cwd, false, f.self), /自身/);
});

test('backup stores original bytes, save roundtrips unrelated fields', (t) => {
  const f = fixture(t); const file = path.join(f.agent, 'settings.json');
  const raw = '\uFEFF{ "theme": "dark", "custom": {"x": 1} }\r\n'; fs.writeFileSync(file, raw);
  const saved = saveSnapshot(readSnapshot(file), { theme: 'dark', custom: { x: 1 }, extensions: ['-builtin:codemode'] }, path.join(f.root, 'backups'));
  assert.deepEqual(saved.snapshot.data.custom, { x: 1 });
  assert.equal(JSON.parse(fs.readFileSync(saved.backupPath, 'utf8')).originalText, raw);
});

test('concurrent settings modification is not overwritten', (t) => {
  const f = fixture(t); const file = path.join(f.agent, 'settings.json'); fs.writeFileSync(file, '{}');
  const old = readSnapshot(file); fs.writeFileSync(file, '{"theme":"light"}');
  assert.throws(() => saveSnapshot(old, { extensions: [] }, path.join(f.root, 'backups')), /其他操作/);
  assert.deepEqual(readSnapshot(file).data, { theme: 'light' });
});

test('missing original config is recorded as absent, not empty', (t) => {
  const f = fixture(t); const missing = readSnapshot(path.join(f.agent, 'settings.json'));
  const saved = saveSnapshot(missing, { extensions: [] }, path.join(f.root, 'backups'));
  const record = JSON.parse(fs.readFileSync(saved.backupPath, 'utf8'));
  assert.equal(record.existed, false); assert.equal(record.originalText, null);
});

test('package child process uses argv without a shell and captures UTF-8 output', async (t) => {
  const f = fixture(t); const script = path.join(f.root, 'probe.mjs');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2))); console.error("中文日志");');
  const output = await runPackageCommand(script, ['a && must-not-run', '路径 包'], f.cwd, f.agent);
  assert.equal(output.code, 0); assert.equal(output.interrupted, false);
  assert.deepEqual(JSON.parse(output.stdout), ['a && must-not-run', '路径 包']);
  assert.ok(output.stderr.includes('中文日志'));
});

test('package child failures keep exit code and bounded diagnostic output', async (t) => {
  const f = fixture(t); const script = path.join(f.root, 'fail.mjs');
  fs.writeFileSync(script, 'console.error("x".repeat(40000)); process.exitCode=7;');
  const output = await runPackageCommand(script, [], f.cwd, f.agent);
  assert.equal(output.code, 7); assert.ok(output.stderr.length <= 32768);
});

test('invalid config fails closed; terminal controls are sanitized', (t) => {
  const f = fixture(t); const file = path.join(f.agent, 'settings.json'); fs.writeFileSync(file, 'not json');
  assert.throws(() => readSnapshot(file));
  assert.equal(clean('\x1b[31mRed\x1b[0m\n'), 'Red ');
});
