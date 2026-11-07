import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const host = process.env.PI_TEST_HOST || path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const requireHost = createRequire(path.join(host, 'package.json'));
const tuiPath = requireHost.resolve('@earendil-works/pi-tui');
const { createJiti } = await import(pathToFileURL(path.join(host, 'dist/core/extensions/jiti-loader.js')).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { '@earendil-works/pi-tui': tuiPath } });
const { ReviewSelector } = await jiti.import(fileURLToPath(new URL('./review-selector.ts', import.meta.url)));
const { visibleWidth } = await import(pathToFileURL(tuiPath).href);
const { getThemeByName } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js')).href);

function setup(options = {}) {
  const actions = [];
  const keybindings = { matches: (key, action) => ({ 'tui.select.up': '\x1b[A', 'tui.select.down': '\x1b[B', 'tui.select.confirm': '\r', 'tui.select.cancel': '\x1b' })[action] === key };
  const component = new ReviewSelector('保存配置？', options.lines ?? ['写入设置文件。', '保存后重载生效。'],
    ['取消', '确认保存'], getThemeByName(options.theme ?? 'dark'), keybindings, () => {}, (value) => actions.push(value), options.rows ?? 24);
  return { component, actions, render: (width = 80) => component.render(width).map(stripVTControlCharacters).join('\n') };
}

test('one-screen review shows both choices; arrows wrap and Enter confirms selected action', () => {
  const f = setup();
  assert.match(f.render(), /取消/); assert.match(f.render(), /确认保存/);
  assert.equal(f.component.list.getSelectedItem().value, '0');
  f.component.handleInput('\x1b[A'); assert.equal(f.component.list.getSelectedItem().value, '1');
  f.component.handleInput('\x1b[B'); assert.equal(f.component.list.getSelectedItem().value, '0');
  f.component.handleInput('\x1b[B'); f.component.handleInput('\r');
  assert.deepEqual(f.actions, ['确认保存']);
  f.component.handleInput('\r'); assert.equal(f.actions.length, 1);
});

test('long explanation scrolls independently while cancel and confirm remain visible', () => {
  const f = setup({ lines: Array.from({ length: 100 }, (_, i) => `row-${i} 中文说明`) });
  assert.match(f.render(), /row-0 /); assert.doesNotMatch(f.render(), /row-99 /);
  f.component.handleInput('\x1b[6~');
  assert.doesNotMatch(f.render(), /row-0 /); assert.match(f.render(), /确认保存/);
  assert.equal(f.component.list.getSelectedItem().value, '0');
  f.component.handleInput('\x1b[F'); assert.match(f.render(), /row-99 /);
  f.component.handleInput('\x1b[H'); assert.match(f.render(), /row-0 /);
  f.component.handleInput('\x1b[1;5B'); assert.doesNotMatch(f.render(), /row-0 /);
  f.component.handleInput('\x1b[1;5A'); assert.match(f.render(), /row-0 /);
  f.component.handleMouse({ type: 'wheel', y: 3, wheelDelta: 4 });
  assert.doesNotMatch(f.render(), /row-0 /); assert.deepEqual(f.actions, []);
});

test('review remains bounded with CJK paths, long text, both themes and terminal resizing', () => {
  let rows = 24;
  for (const theme of ['dark', 'light']) {
    const f = setup({ theme, rows: () => rows, lines: ['路径：C:/用户/项目/'.repeat(30), ...Array.from({ length: 50 }, (_, i) => `项目 ${i}：中文说明。`)] });
    for (const height of [12, 24, 40]) {
      rows = height;
      for (const width of [20, 36, 80, 120]) {
        const output = f.component.render(width);
        assert.ok(output.length <= height, `${width}x${height}: ${output.length} lines`);
        assert.ok(output.every((line) => visibleWidth(line) <= width));
        assert.match(output.map(stripVTControlCharacters).join('\n'), /确认保存/);
      }
    }
    f.component.invalidate();
  }
});

test('removed aliases do not select or close the review; Esc cancels', () => {
  const f = setup();
  for (const key of ['j', 'k', 'q', '?', '\x03']) f.component.handleInput(key);
  assert.deepEqual(f.actions, []);
  assert.equal(f.component.list.getSelectedItem().value, '0');
  f.component.handleInput('\x1b');
  assert.deepEqual(f.actions, [undefined]);
});
