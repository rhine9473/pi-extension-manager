import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const host = process.env.PI_TEST_HOST || path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const { loadExtensions } = await import(pathToFileURL(path.join(host, 'dist/core/extensions/loader.js')).href);
const { TuiBase } = await import(pathToFileURL(path.join(host, 'node_modules/@earendil-works/pi-tui/dist/tui.js')).href);
const support = path.dirname(fileURLToPath(import.meta.url));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

async function setup(t, warmOldModules = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-extension-manager-ui-'));
  const agent = path.join(root, 'agent'); const cwd = path.join(root, 'project');
  const managerDir = path.join(agent, 'extensions/extension-manager');
  fs.mkdirSync(managerDir, { recursive: true });
  fs.mkdirSync(cwd); fs.mkdirSync(path.join(cwd, '.pi/extensions'), { recursive: true });
  for (const file of ['index.ts', 'core.ts', 'wrapping-selector.ts', 'review-selector.ts', 'dashboard.ts', 'descriptions.ts', 'provenance.ts']) {
    fs.copyFileSync(path.join(support, file), path.join(managerDir, file));
  }
  fs.writeFileSync(path.join(agent, 'extensions/demo.ts'), 'export default () => {}');
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ theme: 'dark', extra: 42 }));
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (warmOldModules) {
    const coreFile = path.join(managerDir, 'core.ts'), descriptionFile = path.join(managerDir, 'descriptions.ts');
    const currentCore = fs.readFileSync(coreFile, 'utf8'), currentDescriptions = fs.readFileSync(descriptionFile, 'utf8');
    fs.writeFileSync(coreFile, currentCore.replace('export function isPackageDisabled', 'function isPackageDisabled')
      .replace('export function togglePackageConfig', 'function togglePackageConfig')
      .replace('export function verifyPackageChange', 'function verifyPackageChange'));
    fs.writeFileSync(descriptionFile, 'export function resourceDescription() { return "old descriptions"; }');
    const legacyEntry = path.join(managerDir, 'legacy.ts');
    fs.writeFileSync(legacyEntry, "import { discover } from './core.ts'; import { resourceDescription } from './descriptions.ts'; export default function(pi) { pi.registerCommand('legacy', {handler: () => [discover, resourceDescription]}); }");
    const legacy = await loadExtensions([legacyEntry], cwd);
    assert.deepEqual(legacy.errors, []);
    assert.ok(legacy.extensions[0].commands.get('legacy').handler().every((value) => typeof value === 'function'));
    fs.writeFileSync(coreFile, currentCore); fs.writeFileSync(descriptionFile, currentDescriptions); fs.unlinkSync(legacyEntry);
  }
  const result = await loadExtensions([path.join(managerDir, 'index.ts')], cwd);
  assert.deepEqual(result.errors, [], 'Pi extension loader must accept the real TS entry');
  const command = result.extensions[0].commands.get('extension-manager');
  assert.ok(command);
  return { root, agent, cwd, command };
}

function context(cwd, drive, trusted = false) {
  const notes = []; let reloads = 0;
  return {
    notes, get reloads() { return reloads; }, mode: 'tui', cwd, hasUI: true,
    isProjectTrusted: () => trusted,
    reload: async () => { reloads++; },
    ui: {
      input: async () => undefined, notify: (message, type) => notes.push({ message, type }),
      custom: async (factory, options) => {
        assert.equal(options?.overlay, true, 'Manager screens must cover the session');
        let result; let finished = false;
        const terminal = { rows: 24, columns: 120, hideCursor() {} };
        const tui = new TuiBase(terminal); tui.requestRender = () => {};
        const kb = { matches: (data, action) => ({ 'tui.select.up': '\x1b[A', 'tui.select.down': '\x1b[B', 'tui.select.confirm': '\r', 'tui.select.cancel': '\x1b' })[action] === data };
        const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text, style: (text) => text };
        const component = factory(tui, theme, kb, (value) => { result = value; finished = true; });
        const handle = tui.showOverlay(component, options.overlayOptions);
        const background = Array.from({ length: 30 }, (_, i) => `OUTSIDE_SESSION_${i}`.padEnd(terminal.columns, '.'));
        const visible = tui.compositeOverlays(background, terminal.columns, terminal.rows).slice(-terminal.rows);
        assert.ok(!visible.join('\n').includes('OUTSIDE_SESSION'), 'Session content must not leak around manager screens');
        assert.deepEqual(handle.getBounds(), { row: 0, col: 0, width: 120, height: 24 });
        try { await drive(component); } finally { handle.hide(); }
        assert.ok(finished, 'Component must resolve via done callback');
        return result;
      },
    },
  };
}
function choose(component, text) {
  const index = component.options.findIndex((o) => o.includes(text));
  assert.ok(index >= 0, `Missing option: ${text}; actual ${component.options}`);
  component.list.setSelectedIndex(index); component.handleInput('\r');
}
function selectRow(component, suffix) {
  const row = component.model.rows.find((r) => r.name.endsWith(suffix));
  assert.ok(row, `Missing dashboard row: ${suffix}`);
  component.state.selectedId = row.id;
  return row;
}
function noErrors(ctx) { assert.ok(!ctx.notes.some((n) => n.type === 'error'), JSON.stringify(ctx.notes)); }

test('same-process reload sees newly exported helpers and description updates before package toggle', async (t) => {
  const f = await setup(t, true); const root = path.join(f.root, 'reload-package');
  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extensions/example.ts'), 'export default () => {}');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'reload-package', description: '重载后的包说明', pi: { extensions: ['./extensions'] } }));
  const config = JSON.stringify({ packages: [path.relative(f.agent, root)] });
  fs.writeFileSync(path.join(f.agent, 'settings.json'), config);
  let step = 0;
  const ctx = context(f.cwd, async (component) => {
    switch (step++) {
      case 0:
        assert.match(component.model.rows.find((r) => r.name === 'extension-manager').description, /集中浏览/);
        assert.equal(component.model.rows.find((r) => r.type === 'package').description, '重载后的包说明');
        component.handleInput('\t'); selectRow(component, 'reload-package'); component.handleInput(' '); break;
      case 1: assert.equal(component.model.rows.find((r) => r.type === 'package').status, '已关闭'); component.handleInput('\x1b'); break;
      case 2: choose(component, '放弃暂存'); break;
      default: throw new Error('Unexpected UI');
    }
  });
  await f.command.handler('', ctx); noErrors(ctx); assert.equal(step, 3);
  assert.equal(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'), config);
});

test('dashboard opens directly; self remains protected and browsing is read-only', async (t) => {
  const f = await setup(t); const raw = fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8');
  let calls = 0;
  const ctx = context(f.cwd, async (component) => {
    calls++;
    assert.ok(component.render(100).join('\n').includes('扩展'));
    assert.equal(selectRow(component, 'extension-manager').protected, true);
    component.handleInput('\r');
    selectRow(component, 'demo.ts'); component.handleInput('\r');
    assert.equal(component.model.dirty, false);
    component.handleInput('\x1b');
  });
  await f.command.handler('', ctx);
  assert.equal(calls, 1); assert.deepEqual(ctx.notes, []);
  assert.equal(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'), raw);
});

test('a refused key explains itself instead of dying silently', async (t) => {
  const f = await setup(t); const raw = fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8');
  let step = 0;
  const ctx = context(f.cwd, async (component) => {
    if (step++ === 0) { selectRow(component, 'extension-manager'); component.handleInput(' '); return; }
    component.handleInput('\x1b');
  });
  await f.command.handler('', ctx); assert.equal(step, 2, JSON.stringify(ctx.notes));
  const warnings = ctx.notes.filter((n) => n.type === 'warning');
  assert.equal(warnings.length, 1, JSON.stringify(ctx.notes));
  assert.match(warnings[0].message, /管理器自身受保护/);
  assert.equal(ctx.reloads, 0);
  assert.equal(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'), raw);
});

test('Space stages disable; s confirms save; selection survives and reload happens only on exit', async (t) => {
  const f = await setup(t); let step = 0; let selectedId;
  const ctx = context(f.cwd, async (component) => {
    switch (step++) {
      case 0:
        component.handleInput('/');
        for (const key of 'demo') component.handleInput(key);
        component.handleInput('\r');
        selectedId = selectRow(component, 'demo.ts').id; component.handleInput(' '); break;
      case 1:
        assert.equal(component.state.query, 'demo');
        assert.equal(component.state.selectedId, selectedId);
        assert.equal(component.model.dirty, true);
        assert.equal(component.model.rows.find((r) => r.id === selectedId).enabled, false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).extensions, undefined);
        component.handleInput('p'); break;
      case 2: {
        const text = component.render(120).join('\n');
        assert.match(text, /暂存差异/); assert.ok(text.includes('禁用 demo.ts'), text);
        assert.ok(!text.includes('{') && !text.includes('extensions'), 'plain summary must not dump raw JSON');
        assert.deepEqual(component.options, ['返回']);
        choose(component, '返回'); break;
      }
      case 3: component.handleInput('s'); break;
      case 4: {
        const text = component.render(120).join('\n');
        assert.ok(text.includes('本次改动') && text.includes('禁用 demo.ts'), text);
        assert.ok(component.options.some((o) => o.includes('确认保存')));
        assert.ok(component.options.some((o) => o.includes('取消')));
        assert.ok(!component.options.some((o) => o === '返回'));
        assert.equal(component.list.getSelectedItem().value, '0');
        component.handleInput('\x1b[B'); component.handleInput('\r'); break;
      }
      case 5:
        assert.equal(component.model.dirty, false); assert.equal(component.model.needsReload, true);
        component.handleInput('\x1b');
        // Both keys are consumed inside the same component: the first drops the 'demo' filter, the second leaves the panel.
        assert.equal(component.state.query, '');
        assert.ok(component.model.rows.some((r) => r.name === 'extension-manager'));
        component.handleInput('\x1b'); break;
      case 6:
        assert.ok(component.list.getSelectedItem().label.includes('立即 reload'));
        component.handleInput('\r'); break;
      default: throw new Error('Unexpected UI');
    }
  });
  await f.command.handler('', ctx);
  assert.equal(step, 7, JSON.stringify(ctx.notes)); assert.equal(ctx.reloads, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.extensions, ['-extensions/demo.ts']); assert.equal(saved.extra, 42);
  assert.equal(fs.readdirSync(path.join(f.agent, 'state/extension-manager/backups')).length, 1);
  noErrors(ctx);
});

test('removed commands do not widen the global manager into project settings', async (t) => {
  const f = await setup(t); fs.writeFileSync(path.join(f.cwd, '.pi/settings.json'), 'not valid JSON; must not be read');
  const ctx = context(f.cwd, async (component) => {
    for (const key of ['c', 'r', 'l', 'f', 'i']) component.handleInput(key);
    assert.equal(component.model.scope, '全局');
    component.handleInput('\x1b');
  }, true);
  await f.command.handler('', ctx); noErrors(ctx);
  assert.equal(fs.readFileSync(path.join(f.cwd, '.pi/settings.json'), 'utf8'), 'not valid JSON; must not be read');
});

test('dashboard removes an existing local package after confirmation without deleting source', async (t) => {
  const f = await setup(t);
  const localRoot = path.join(f.root, 'local-package'); fs.mkdirSync(localRoot);
  fs.mkdirSync(path.join(localRoot, 'extensions')); fs.writeFileSync(path.join(localRoot, 'extensions/local.ts'), 'export default () => {}');
  fs.writeFileSync(path.join(localRoot, 'package.json'), '{"name":"local-package","version":"1.2.3","pi":{"extensions":["./extensions"]}}');
  fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify({ packages: [path.relative(f.agent, localRoot)] }));
  let step = 0;
  const ctx = context(f.cwd, async (component) => {
    switch (step++) {
      case 0:
        component.handleInput('\t'); selectRow(component, 'local-package');
        assert.match(component.render(120).join('\n'), /版本：1\.2\.3/);
        component.handleInput('d'); break;
      case 1:
        assert.match(component.render(120).join('\n'), /当前版本：1\.2\.3/);
        choose(component, '确认卸载'); break;
      case 2: assert.equal(component.state.view, 'packages'); component.handleInput('\x1b'); break;
      case 3: choose(component, '稍后手动'); break;
      default: throw new Error('Unexpected UI');
    }
  });
  await f.command.handler('', ctx);
  assert.equal(step, 4, JSON.stringify(ctx.notes)); noErrors(ctx);
  assert.ok(fs.existsSync(path.join(localRoot, 'extensions/local.ts')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')).packages, []);
  assert.equal(ctx.reloads, 0);
});

test('whole-package off state survives save and reopening; menu restores original child settings', async (t) => {
  const f = await setup(t); const root = path.join(f.root, 'switchable-package');
  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(root, `extensions/${name}.ts`), 'export default () => {}');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'switchable', pi: { extensions: ['./extensions'] } }));
  const source = path.relative(f.agent, root);
  const original = { theme: 'dark', packages: [{ source, extensions: ['!**/b.ts'] }] };
  fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify(original));
  let step = 0;
  const closing = context(f.cwd, async (component) => {
    switch (step++) {
      case 0: component.handleInput('\t'); selectRow(component, 'switchable-package'); component.handleInput(' '); break;
      case 1: {
        const pkg = component.model.rows.find((r) => r.type === 'package');
        assert.equal(pkg.status, '已关闭'); assert.equal(pkg.enabled, false);
        assert.ok(component.model.rows.filter((r) => r.type === 'resource' && r.source === source).every((r) => !r.enabled && r.protected));
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')), original);
        component.handleInput('s'); break;
      }
      case 2: choose(component, '确认保存'); break;
      case 3: component.handleInput('\x1b'); break;
      case 4: choose(component, '稍后手动'); break;
      default: throw new Error('Unexpected UI');
    }
  });
  await f.command.handler('', closing); noErrors(closing); assert.equal(step, 5);
  const saved = JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'));
  for (const type of ['extensions', 'skills', 'prompts', 'themes']) assert.deepEqual(saved.packages[0][type], []);
  assert.ok(fs.existsSync(path.join(root, 'extensions/a.ts')));
  step = 0;
  const opening = context(f.cwd, async (component) => {
    switch (step++) {
      case 0:
        component.handleInput('\t'); assert.equal(selectRow(component, 'switchable-package').enabled, false);
        component.handleInput('\r'); break;
      case 1: choose(component, '暂存开启整包'); break;
      case 2:
        assert.equal(component.model.rows.find((r) => r.type === 'package').status, '部分启用');
        assert.equal(component.model.rows.find((r) => r.name === 'a.ts').enabled, true);
        assert.equal(component.model.rows.find((r) => r.name === 'b.ts').enabled, false);
        component.handleInput('s'); break;
      case 3: choose(component, '确认保存'); break;
      case 4: component.handleInput('\x1b'); break;
      case 5: choose(component, '稍后手动'); break;
      default: throw new Error('Unexpected UI');
    }
  });
  await f.command.handler('', opening); noErrors(opening); assert.equal(step, 6);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8')), original);
});

test('a child edit folded into a whole-package switch still appears in the staged summary', async (t) => {
  const f = await setup(t); const root = path.join(f.root, 'fold-package');
  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(root, `extensions/${name}.ts`), 'export default () => {}');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fold-package', pi: { extensions: ['./extensions'] } }));
  const raw = JSON.stringify({ packages: [path.relative(f.agent, root)] });
  fs.writeFileSync(path.join(f.agent, 'settings.json'), raw);
  let step = 0;
  const ctx = context(f.cwd, async (component) => {
    switch (step++) {
      case 0: selectRow(component, 'b.ts'); component.handleInput(' '); break;
      case 1: component.handleInput('\t'); selectRow(component, 'fold-package'); component.handleInput(' '); break;
      case 2: {
        assert.equal(component.model.rows.find((r) => r.type === 'package').status, '已关闭');
        component.handleInput('p'); break;
      }
      case 3: {
        const text = component.render(120).join('\n');
        assert.match(text, /关闭整包 fold-package/);
        assert.match(text, /↳ 重开后恢复：禁用 b\.ts/, text);
        assert.ok(!text.includes('extensionManagerDisabled'), 'restore blob must not leak into the summary');
        choose(component, '返回'); break;
      }
      case 4: component.handleInput('\x1b'); break;
      case 5: choose(component, '放弃暂存'); break;
      default: throw new Error('Unexpected UI');
    }
  });
  await f.command.handler('', ctx); noErrors(ctx); assert.equal(step, 6);
  assert.equal(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'), raw);
});

test('package menu retains wrapping arrows and ignores removed aliases', async (t) => {
  const f = await setup(t); let step = 0;
  const root = path.join(f.root, 'menu-package'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'menu-package', pi: { extensions: [] } }));
  fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify({ packages: [path.relative(f.agent, root)] }));
  const ctx = context(f.cwd, async (component) => {
    switch (step++) {
      case 0: component.handleInput('\t'); selectRow(component, 'menu-package'); component.handleInput('\r'); break;
      case 1: {
        const last = String(component.options.length - 1);
        component.handleInput('\x1b[A'); assert.equal(component.list.getSelectedItem().value, last);
        component.handleInput('\x1b[B'); assert.equal(component.list.getSelectedItem().value, '0');
        component.handleInput('k'); assert.equal(component.list.getSelectedItem().value, '0');
        component.handleInput('j'); assert.equal(component.list.getSelectedItem().value, '0');
        choose(component, '返回'); break;
      }
      case 2: component.handleInput('\x1b'); break;
      default: throw new Error('Unexpected UI');
    }
  });
  await f.command.handler('', ctx); assert.equal(step, 3); noErrors(ctx);
});

test('selecting a package child focuses it in the main list and Space still stages its switch', async (t) => {
  const f = await setup(t); const root = path.join(f.root, 'child-package');
  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  for (const name of ['a', 'b']) fs.writeFileSync(path.join(root, `extensions/${name}.ts`), 'export default () => {}');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'child-package', pi: { extensions: ['./extensions'] } }));
  const raw = JSON.stringify({ packages: [{ source: path.relative(f.agent, root), extensions: ['!**/b.ts'] }] });
  fs.writeFileSync(path.join(f.agent, 'settings.json'), raw);
  let step = 0;
  const ctx = context(f.cwd, async (component) => {
    switch (step++) {
      case 0: component.handleInput('\t'); selectRow(component, 'child-package'); component.handleInput('\r'); break;
      case 1: choose(component, '浏览子扩展'); break;
      case 2: choose(component, 'a.ts'); break;
      case 3:
        assert.equal(component.state.view, 'extensions');
        assert.equal(component.model.rows.find((r) => r.id === component.state.selectedId).name, 'a.ts');
        component.handleInput(' '); break;
      case 4:
        assert.equal(component.model.rows.find((r) => r.name === 'a.ts').enabled, false);
        assert.equal(component.model.rows.find((r) => r.name === 'b.ts').enabled, false);
        component.handleInput('\x1b'); break;
      case 5: choose(component, '放弃暂存'); break;
      default: throw new Error('Unexpected UI');
    }
  });
  await f.command.handler('', ctx); noErrors(ctx); assert.equal(step, 6);
  assert.equal(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'), raw);
});

test('exit with unsaved changes requires an explicit decision; discard leaves settings unchanged', async (t) => {
  const f = await setup(t); const raw = fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'); let step = 0;
  const ctx = context(f.cwd, async (component) => {
    switch (step++) {
      case 0: selectRow(component, 'demo.ts'); component.handleInput(' '); break;
      case 1: component.handleInput('\x1b'); break;
      case 2: choose(component, '取消操作'); break;
      case 3: assert.equal(component.model.dirty, true); component.handleInput('\x1b'); break;
      case 4: choose(component, '放弃暂存'); break;
      default: throw new Error('Unexpected UI');
    }
  });
  await f.command.handler('', ctx); assert.equal(step, 5); noErrors(ctx);
  assert.equal(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'), raw); assert.equal(ctx.reloads, 0);
});

test('reopening automatically discovers new extensions and their descriptions', async (t) => {
  const f = await setup(t);
  const first = context(f.cwd, async (component) => {
    assert.ok(!component.model.rows.some((r) => r.name === 'aaa.ts'));
    component.handleInput('\x1b');
  });
  await f.command.handler('', first); noErrors(first);
  fs.writeFileSync(path.join(f.agent, 'extensions/aaa.ts'), '/** 自动发现的新扩展，用于检查设备状态。 */\nexport default () => {}');
  const reopened = context(f.cwd, async (component) => {
    assert.equal(component.model.rows.find((r) => r.name === 'aaa.ts').description, '自动发现的新扩展，用于检查设备状态。');
    component.handleInput('\x1b');
  });
  await f.command.handler('', reopened); noErrors(reopened);
});

test('global package counts and children exclude a project package with the same relative source', async (t) => {
  const f = await setup(t);
  for (const [base, name] of [[f.agent, 'global-only'], [path.join(f.cwd, '.pi'), 'project-only']]) {
    const root = path.join(base, 'local-package');
    fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extensions', `${name}.ts`), 'export default () => {}');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, pi: { extensions: ['./extensions'] } }));
  }
  fs.writeFileSync(path.join(f.agent, 'settings.json'), JSON.stringify({ packages: ['./local-package'] }));
  fs.writeFileSync(path.join(f.cwd, '.pi/settings.json'), JSON.stringify({ packages: [{ source: './local-package', extensions: [] }] }));
  let step = 0;
  const ctx = context(f.cwd, async (component) => {
    switch (step++) {
      case 0: {
        const rows = component.model.rows.filter((r) => r.type === 'package');
        assert.equal(rows.length, 1);
        const global = rows[0];
        assert.equal(global.enabled, true); assert.equal(global.canUpdate, false); assert.equal(global.canRemove, true);
        assert.ok(global.details.includes('子扩展：1 项'));
        component.handleInput('\t'); component.state.selectedId = global.id; component.handleInput('\r'); break;
      }
      case 1: choose(component, '浏览子扩展'); break;
      case 2:
        assert.ok(component.options.some((o) => o.includes('global-only.ts')));
        assert.ok(!component.options.some((o) => o.includes('project-only.ts')));
        assert.ok(!component.options.some((o) => o.includes('筛选')));
        choose(component, '返回'); break;
      case 3: choose(component, '返回'); break;
      case 4: component.handleInput('\x1b'); break;
      default: throw new Error('Unexpected UI');
    }
  }, true);
  await f.command.handler('', ctx); noErrors(ctx); assert.equal(step, 5);
});

test('removed help, vim and quit aliases leave the manager open until Esc', async (t) => {
  const f = await setup(t); const raw = fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'); let calls = 0;
  const ctx = context(f.cwd, async (component) => {
    calls++;
    const before = component.state.selectedId;
    for (const key of ['?', 'j', 'k', 'q', '\x03']) component.handleInput(key);
    assert.equal(component.state.selectedId, before);
    assert.doesNotMatch(component.render(120).join('\n'), /帮助|jk|q\/Esc|Ctrl\+C/);
    component.handleInput('\x1b');
  });
  await f.command.handler('', ctx); noErrors(ctx); assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(f.agent, 'settings.json'), 'utf8'), raw);
});

test('RPC/print mode does not open terminal components or modify config', async (t) => {
  const f = await setup(t);
  const ctx = context(f.cwd, async () => { throw new Error('Should not show UI'); }); ctx.mode = 'rpc';
  await f.command.handler('', ctx);
  assert.ok(ctx.notes.some((n) => n.message.includes('仅支持')));
});
