import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const host = process.env.PI_TEST_HOST || path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const hostRequire = createRequire(path.join(host, 'package.json'));
const tuiPath = hostRequire.resolve('@earendil-works/pi-tui');
const { createJiti } = await import(pathToFileURL(path.join(host, 'dist/core/extensions/jiti-loader.js')).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { '@earendil-works/pi-tui': tuiPath } });
const { ManagerDashboard } = await jiti.import(fileURLToPath(new URL('./dashboard.ts', import.meta.url)));
const { visibleWidth, CURSOR_MARKER } = await import(pathToFileURL(tuiPath).href);
const withoutCursorMarkers = (text) => text.replace(/\x1b_pi:(?:c|fc|\/fc)\x07/g, '');
const stripAnsi = (text) => stripVTControlCharacters(withoutCursorMarkers(text));
const { getThemeByName } = await import(pathToFileURL(path.join(host, 'dist/modes/interactive/theme/theme.js')).href);
const dark = getThemeByName('dark');
const light = getThemeByName('light');
assert.ok(dark && light, 'Use the actual installed host themes');
const defaultBindings = { 'tui.select.up': '\x1b[A', 'tui.select.down': '\x1b[B', 'tui.select.confirm': '\r', 'tui.select.cancel': '\x1b' };

function model() {
  const kinds = ['auto', 'settings', 'local', 'git', 'npm', 'builtin'];
  const rows = Array.from({ length: 36 }, (_, i) => ({
    id: `r:${i}`, type: 'resource', name: i === 0 ? 'extension-manager' : `扩展-${String(i).padStart(2, '0')}.ts`,
    source: i === 0 ? '~/.pi/agent/extensions/extension-manager/index.ts' : `${kinds[i % 6]}:来源/中文/extension-${i}.ts`,
    kind: kinds[i % 6], enabled: i % 3 !== 1, protected: i === 0,
    details: [i === 0 ? '管理器自身受保护；启停配置由父组件暂存与确认。' : `详情 ${i}：支持中文路径、组合字 e\u0301 与表情 👩‍💻。`, '来源范围：全局 · 修改保存后重载生效'],
  }));
  rows.push(
    { id: 'p:0', type: 'package', name: '@demo/productivity', source: 'npm:@demo/productivity@1.2.0', kind: 'npm', status: '已安装', enabled: true, details: ['提供 3 个扩展 · 2 个技能'] },
    { id: 'p:1', type: 'package', name: 'git-tools', source: 'git:github.com/demo/pi-tools@main', kind: 'git', status: '缺失', details: ['尚未安装，Enter 查看可用操作'] },
    { id: 'p:2', type: 'package', name: '本地主题包', source: 'C:/开发/主题', kind: 'local', status: '已安装', details: ['仅含主题，没有扩展'] },
  );
  return { scope: '全局', dirty: true, needsReload: true, rows };
}
function setup(options = {}) {
  const state = options.state ?? { view: 'extensions', query: '' };
  const actions = []; let renders = 0;
  const bindings = { ...defaultBindings, ...options.bindings };
  const component = new ManagerDashboard(options.model ?? model(), state, options.theme ?? dark,
    { matches: (data, action) => bindings[action] === data }, () => { renders++; }, (action) => actions.push(action), options.rows ?? 24);
  return { component, state, actions, get renders() { return renders; }, key: (data) => component.handleInput(data), plain: (width = 80) => component.render(width).map(stripAnsi).join('\n') };
}

function checkBounds(component, width, height) {
  const lines = component.render(width);
  assert.ok(lines.length <= height, `${lines.length} lines exceed terminal height ${height}`);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
    assert.ok(!/[\r\n\x07]/.test(withoutCursorMarkers(line)));
    assert.ok(!line.includes('undefined'));
  }
  return lines;
}

test('host jiti loads the component; CJK/emoji/ANSI render within all target widths and heights', () => {
  const data = model();
  data.rows[1].name = '\x1b[31m中文超长扩展👩‍💻e\u0301\x1b[0m\n\t\x07.ts';
  data.rows[1].source = '\x1b]8;;https://example.test\x07路径\x1b]8;;\x1b\\';
  data.rows[1].details = ['第一行\n第二行\r\t\x1b[2J中文\x1b]0;伪标题\x07', '超长详情'.repeat(100)];
  for (const theme of [dark, light]) {
    for (const rows of [12, 24, 40]) {
      const f = setup({ model: data, theme, rows, state: { view: 'extensions', query: '', selectedId: 'r:1' } });
      for (const width of [20, 36, 80, 120]) {
        const lines = checkBounds(f.component, width, rows);
        assert.ok(!lines.join('').includes('https://example.test'));
        assert.ok(!lines.join('').includes('\x1b[2J'));
        const plain = lines.map(stripAnsi).join('\n');
        assert.match(plain, /Esc/);
        assert.match(plain, /扩展管理/);
        assert.match(plain, /扩展 36/);
        if (width === 20) assert.match(plain, /未存/);
      }
      f.key('/'); f.key('中'); f.component.focused = true;
      for (const width of [20, 36, 80, 120]) checkBounds(f.component, width, rows);
    }
  }
});

test('arrow navigation wraps, selection scrolls into view, injected bindings work', () => {
  const f = setup();
  assert.equal(f.state.selectedId, 'r:0');
  f.key('\x1b[A'); assert.equal(f.state.selectedId, 'r:35');
  assert.match(f.plain(80), /扩展-35/);
  assert.ok(!f.plain(80).includes('extension-manager'));
  f.key('\x1b[B'); assert.equal(f.state.selectedId, 'r:0');
  f.key('\x1b[A'); assert.equal(f.state.selectedId, 'r:35');
  f.key('\x1b[B'); assert.equal(f.state.selectedId, 'r:0');
  const custom = setup({ bindings: { 'tui.select.up': 'UP', 'tui.select.down': 'DOWN' } });
  custom.key('UP'); assert.equal(custom.state.selectedId, 'r:35');
  custom.key('DOWN'); assert.equal(custom.state.selectedId, 'r:0');
  assert.ok(f.renders >= 4);
});

test('search filters live, Esc leaves the box keeping the query, then clears it and only then exits', () => {
  const f = setup(); f.component.focused = true;
  assert.ok(!f.component.render(80).join('').includes(CURSOR_MARKER));
  f.key('/');
  assert.ok(f.component.render(80).join('').includes(CURSOR_MARKER));
  f.component.focused = false;
  assert.ok(!f.component.render(80).join('').includes(CURSOR_MARKER));
  f.component.focused = true;
  f.key('扩展-25'); assert.equal(f.state.selectedId, 'r:25');
  assert.match(f.plain(120), /Enter \/ Esc 完成/);
  f.key('\x1b');
  assert.equal(f.state.query, '扩展-25', 'Esc must not discard what the user typed');
  assert.equal(f.state.selectedId, 'r:25');
  assert.deepEqual(f.actions, []);
  assert.ok(!f.component.render(80).join('').includes(CURSOR_MARKER));
  assert.match(f.plain(120), /Esc 清除筛选/);
  assert.match(f.plain(20), /Esc清/);

  // Escape again drops the filter back to the full list, selecting the first row.
  f.key('\x1b');
  assert.equal(f.state.query, '');
  assert.equal(f.state.selectedId, 'r:25', 'dropping a filter keeps the cursor when the row is still visible');
  assert.deepEqual(f.actions, []);
  assert.match(f.plain(120), /Esc 退出/);
  assert.match(f.plain(20), /Esc退/);

  // Enter commits the same way, and an empty box left with Esc exits the panel.
  f.key('/'); f.key('web'); f.key('\r'); assert.equal(f.state.query, 'web');
  f.key('/'); f.key('\x15'); f.key('\x1b');
  assert.equal(f.state.query, ''); assert.match(f.plain(), /没有匹配项|extension-manager/);
  f.key('\x1b'); f.key('\x1b');
  assert.deepEqual(f.actions, [{ type: 'exit' }]);
});

test('an empty result names the keyword that found nothing and how to drop it', () => {
  const f = setup(); f.key('/'); f.key('zzz不存在');
  const text = f.plain(120);
  assert.match(text, /没有匹配「zzz不存在」/);
  assert.match(text, /Esc 清除筛选 · \/ 修改关键词/);
  checkBounds(f.component, 20, 24);
  const empty = setup({ model: { scope: '全局', dirty: false, needsReload: false, rows: [] }, rows: 12 });
  assert.match(empty.plain(120), /暂无可扩展的条目/);
  assert.match(empty.plain(120), /\/ 搜索 · Tab 切到包页/);
  empty.key(' ');
  assert.deepEqual(empty.actions, []);
  checkBounds(empty.component, 20, 12);
});

test('search owns command keys and supports CJK bracketed paste without emitting actions', () => {
  const f = setup(); f.component.focused = true; f.key('/');
  for (const key of ['s', 'p', 'x', 'c', 'r', 'i', 'u', 'd', 'l', 'q', ' ', 'j', 'k', 'f', '\t']) f.key(key);
  assert.deepEqual(f.actions, []); assert.equal(f.state.view, 'extensions');
  f.key('\x1b'); f.key('/');
  f.key('\x1b[200~中文\n路径\x1b[31m\x07\x1b[201~');
  assert.ok(!/[\x00-\x1f]/.test(f.state.query));
  checkBounds(f.component, 20, 24);
  f.key('\n'); assert.deepEqual(f.actions, []);
});

test('Tab switches extensions and packages without changing search or emitting actions', () => {
  const f = setup();
  f.key('\t'); assert.equal(f.state.view, 'packages'); assert.equal(f.state.selectedId, 'p:0');
  assert.match(f.plain(), /已安装/);
  f.key('\x1b[B'); assert.match(f.plain(), /缺失/);
  f.key('\t'); assert.equal(f.state.view, 'extensions');
  assert.deepEqual(f.actions, []);
});

test('package status distinguishes installed packages with no extension children', () => {
  const f = setup({ state: { view: 'packages', query: '本地主题' } });
  assert.match(f.plain(), /已安装/); assert.doesNotMatch(f.plain(), /已禁用|\[禁用\]/);
});

test('protected entries refuse with a reason and extensions have no duplicate Enter menu', () => {
  const f = setup(); f.key(' ');
  assert.deepEqual(f.actions, [{ type: 'blocked', id: 'r:0', attempt: 'toggle' }]);
  const enter = setup(); enter.key('\r'); assert.deepEqual(enter.actions, []);
  const editable = setup({ state: { view: 'extensions', query: '', selectedId: 'r:1' } });
  editable.key('\r'); assert.deepEqual(editable.actions, []);
  assert.doesNotMatch(editable.plain(120), /Enter|菜单/);
  const pkg = setup({ state: { view: 'packages', query: '' } });
  pkg.key(' '); assert.deepEqual(pkg.actions, [{ type: 'blocked', id: 'p:0', attempt: 'toggle' }]);
  for (const key of ['u', 'd']) { const resource = setup(); resource.key(key); assert.deepEqual(resource.actions, []); }
  const toggle = setup(); toggle.key('\x1b[B'); toggle.key(' ');
  assert.deepEqual(toggle.actions, [{ type: 'toggle', id: 'r:1' }]);
});

test('package Space toggles the whole-package switch only when permitted', () => {
  const data = model(); const row = data.rows.find((r) => r.id === 'p:0'); row.canToggle = true;
  const state = { view: 'packages', query: '', selectedId: 'p:0' };
  const f = setup({ model: data, state });
  assert.match(f.plain(120), /空格 整包关闭/);
  row.enabled = false; row.status = '已关闭';
  assert.match(setup({ model: data, state: { ...state } }).plain(120), /空格 整包开启/);
  row.enabled = true; row.status = '已安装';
  f.key(' '); assert.deepEqual(f.actions, [{ type: 'toggle', id: 'p:0' }]);
  row.protected = true;
  const guarded = setup({ model: data, state: { ...state } });
  guarded.key(' '); assert.deepEqual(guarded.actions, [{ type: 'blocked', id: 'p:0', attempt: 'toggle' }]);
  row.protected = false; row.canUpdate = false; row.canRemove = false;
  for (const [key, attempt] of [['u', 'update'], ['d', 'remove']]) {
    const refused = setup({ model: data, state: { ...state } });
    refused.key(key); assert.deepEqual(refused.actions, [{ type: 'blocked', id: 'p:0', attempt }]);
  }
});

test('state text stays single, labels avoid repeats, and Space says the concrete action', () => {
  const row = (id, extra) => ({ id, type: 'resource', name: id, source: `git:demo/${id}`, kind: 'git', enabled: true, details: [], ...extra });
  const rows = [
    row('mermaid-inline', { name: 'mermaid-inline', packageName: 'mermaid-inline', kind: 'auto' }),
    row('inner', { packageName: 'openpi', enabled: false, protected: true, status: '包已关' }),
    row('demo.ts'),
    { id: 'p:0', type: 'package', name: 'openpi', source: 'git:github.com/demo/openpi', kind: 'git', status: '已开启', enabled: true, canToggle: true, details: [] },
  ];
  const model = { scope: '全局', dirty: true, needsReload: false, rows };
  const open = (selectedId, view = 'extensions') => setup({ model, state: { view, query: '', selectedId } });

  const list = open('mermaid-inline').plain(120);
  assert.match(list, /\[启用\] mermaid-inline · 自动发现/);
  assert.doesNotMatch(list, /mermaid-inline · mermaid-inline/);
  assert.match(list, /\[包已关\] inner · openpi/);
  assert.doesNotMatch(list, /\[只读\] inner/);
  assert.match(list, /\[启用\] demo\.ts · Git/);

  const detail = (id) => open(id).plain(120);
  assert.match(detail('demo.ts'), /已启用 · Git/);
  assert.doesNotMatch(detail('demo.ts'), /启用 · 启用|已启用 · 启用/);
  assert.match(detail('inner'), /已禁用 · 包已关 · Git/);
  assert.match(open('p:0', 'packages').plain(120), /已开启 · Git/);
  assert.doesNotMatch(open('p:0', 'packages').plain(120), /已启用 · 已开启/);

  assert.match(open('demo.ts').plain(120), /空格 禁用（不删文件）/);
  assert.match(open('mermaid-inline', 'extensions').plain(120), /空格 禁用（不删文件）/);
  assert.doesNotMatch(open('inner').plain(120), /空格/);
  assert.match(open('p:0', 'packages').plain(120), /空格 整包关闭/);
  rows[3] = { ...rows[3], status: '已关闭', enabled: false };
  const closedPkg = open('p:0', 'packages').plain(120);
  assert.match(closedPkg, /空格 整包开启/);
  assert.match(closedPkg, /\[已关闭\] openpi/);
  rows[3] = { ...rows[3], status: '已开启', enabled: true };
  for (const width of [20, 36, 80, 120]) for (const id of ['mermaid-inline', 'inner', 'demo.ts']) checkBounds(open(id).component, width, 24);
  checkBounds(setup({ model, state: { view: 'packages', query: '', selectedId: 'p:0' }, rows: 12 }).component, 20, 12);
});

test('all global shortcuts return their intent exactly once', () => {
  for (const [key, type] of Object.entries({ s: 'save', p: 'pending', x: 'discard', '\x1b': 'exit' })) {
    const f = setup(); f.key(key); f.key(key);
    assert.deepEqual(f.actions, [{ type }], JSON.stringify(key));
  }
  for (const [key, type] of [['u', 'update'], ['d', 'remove'], ['\r', 'open']]) {
    const f = setup({ state: { view: 'packages', query: '', selectedId: 'p:1' } });
    f.key(key); assert.deepEqual(f.actions, [{ type, id: 'p:1' }]);
  }
  const search = setup(); search.key('/'); search.key('\x03');
  assert.deepEqual(search.actions, []);
  search.key('\x1b'); assert.deepEqual(search.actions, []);
  search.key('\x1b'); assert.deepEqual(search.actions, [{ type: 'exit' }]);
});

test('shared state survives remount and stale ids recover; empty models are safe', () => {
  const state = { view: 'packages', query: 'git', selectedId: 'p:1' };
  const first = setup({ state }); const next = setup({ state });
  assert.equal(next.component.state, state); assert.equal(next.component.model.rows.length, first.component.model.rows.length);
  assert.deepEqual(state, { view: 'packages', query: 'git', selectedId: 'p:1' });
  state.selectedId = 'removed'; next.component.render(80); assert.equal(state.selectedId, 'p:1');
  const empty = setup({ model: { scope: '项目', dirty: false, needsReload: false, rows: [] } });
  for (const key of ['j', 'k', '\r', ' ', 'u', 'd', '\t', 'f']) empty.key(key);
  assert.deepEqual(empty.actions, []);
  assert.match(empty.plain(), /暂无可扩展的条目/);
  checkBounds(empty.component, 20, 24);
});

test('resize provider is evaluated on every render and invalidate picks up theme changes', () => {
  let rows = 40;
  let activeTheme = dark;
  const theme = { fg: (...args) => activeTheme.fg(...args), bg: (...args) => activeTheme.bg(...args), bold: (text) => activeTheme.bold(text) };
  const f = setup({ rows: () => rows, theme });
  assert.equal(checkBounds(f.component, 120, rows).length, 40);
  rows = 12; checkBounds(f.component, 20, rows);
  rows = 24; assert.equal(checkBounds(f.component, 80, rows).length, 24);
  const before = f.component.render(80).join('\n');
  activeTheme = light;
  f.component.invalidate();
  assert.notEqual(f.component.render(80).join('\n'), before);
  checkBounds(f.component, 36, rows);
  for (const width of [0, 1, 2, 3, 8]) checkBounds(f.component, width, rows);
});

test('function description appears before technical metadata and can be searched', () => {
  const data = model();
  data.rows[1].description = '自动查询设备温度，并在会话中显示采样结果。';
  data.rows[1].details = ['路径：' + '很长的路径/'.repeat(30)];
  const f = setup({ model: data, state: { view: 'extensions', query: '', selectedId: 'r:1' } });
  const preview = f.plain(120);
  assert.match(preview, /功能简介/);
  assert.match(preview, /自动查询设备温度/);
  assert.ok(preview.indexOf('自动查询设备温度') < preview.indexOf('很长的路径'));
  f.key('/'); f.key('设备温度'); f.key('\r');
  assert.equal(f.state.selectedId, 'r:1');
  checkBounds(f.component, 36, 24);
});

test('long details scroll in place without changing selection and reset for the next extension', () => {
  const data = model();
  data.rows[1].description = '完整的扩展说明';
  data.rows[1].details = Array.from({ length: 30 }, (_, i) => `详情标记${String(i).padStart(2, '0')}`);
  const f = setup({ model: data, state: { view: 'extensions', query: '', selectedId: 'r:1' } });
  const top = f.plain(120);
  assert.match(top, /完整的扩展说明/); assert.match(top, /PgUp\/PgDn/);
  assert.doesNotMatch(top, /详情标记29|Enter/);
  for (let i = 0; i < 10; i++) f.key('\x1b[6~');
  assert.match(f.plain(120), /详情标记29/);
  assert.equal(f.state.selectedId, 'r:1'); assert.deepEqual(f.actions, []);
  for (let i = 0; i < 10; i++) f.key('\x1b[5~');
  assert.equal(f.plain(120), top);
  for (let i = 0; i < 10; i++) f.key('\x1b[6~');
  f.key('\x1b[B'); f.plain(120);
  f.key('\x1b[A'); assert.equal(f.plain(120), top);
  for (const width of [20, 36, 80, 120]) checkBounds(f.component, width, 24);
});

test('footer advertises only actions available for the selected row and unsaved state', () => {
  const data = model(); data.dirty = false;
  const footer = (f) => { const text = f.plain(120); return text.slice(text.lastIndexOf('├')); };
  const protectedRow = setup({ model: data });
  assert.doesNotMatch(footer(protectedRow), /空格|u 更新|d 卸载|s 保存|x 放弃|p 差异/);
  assert.match(footer(protectedRow), /Esc 退出/);
  assert.doesNotMatch(footer(protectedRow), /j[k/]|帮助|q\/Esc|Ctrl\+C/);
  const editable = setup({ model: model(), state: { view: 'extensions', query: '', selectedId: 'r:1' } });
  assert.match(footer(editable), /空格/); assert.match(footer(editable), /s 保存/);
  assert.doesNotMatch(footer(editable), /u 更新|d 卸载/);
  const pkg = setup({ model: data, state: { view: 'packages', query: '', selectedId: 'p:0' } });
  assert.match(footer(pkg), /u 更新/); assert.match(footer(pkg), /d 卸载/);
  assert.doesNotMatch(footer(pkg), /空格|s 保存|x 放弃/);
  editable.key('/');
  assert.match(footer(editable), /搜索中/);
  assert.doesNotMatch(footer(editable), /s 保存|空格|i 安装|u 更新/);
});

test('package shortcuts respect update/remove eligibility', () => {
  const data = model(); data.rows.find((row) => row.id === 'p:1').canUpdate = false;
  data.rows.find((row) => row.id === 'p:1').canRemove = false;
  const refuse = (key) => { const fresh = setup({ model: data, state: { view: 'packages', query: '', selectedId: 'p:1' } }); fresh.key(key); return fresh.actions; };
  assert.deepEqual(refuse('u'), [{ type: 'blocked', id: 'p:1', attempt: 'update' }]);
  assert.deepEqual(refuse('d'), [{ type: 'blocked', id: 'p:1', attempt: 'remove' }]);
  assert.deepEqual(refuse('?'), []);
});

test('removed controls, vim navigation, help and alternate quit keys have no action or visible hints', () => {
  const f = setup(); const selected = f.state.selectedId;
  for (const key of ['c', 'r', 'l', 'f', 'i', 'j', 'k', 'q', '?', '\x03']) f.key(key);
  assert.deepEqual(f.actions, []); assert.equal(f.state.selectedId, selected);
  const text = f.plain(120);
  assert.doesNotMatch(text, /筛选|刷新|日志|c 范围|i 安装|帮助|jk|q\/Esc|Ctrl\+C/);
});

test('same-author rows form contiguous labelled sections and navigation skips headings', () => {
  const item = (id, group, groupOrder = 1) => ({ id, type: 'resource', name: id, source: 'fixture', kind: 'auto', group, groupOrder, enabled: true, details: [] });
  const data = { scope: '全局', dirty: false, needsReload: false, rows: [
    item('alpha', 'Alice'), item('bravo', 'Bob'), item('charlie', 'Alice'),
    item('local', '本地扩展（作者未标注）', 0), item('builtin', 'Pi 内置', 2),
  ] };
  const f = setup({ model: data });
  const preview = f.plain(120);
  assert.match(preview, /── Alice · 2 项/); assert.match(preview, /── Bob · 1 项/);
  assert.ok(preview.indexOf('charlie') < preview.indexOf('── Bob'));
  assert.equal(f.state.selectedId, 'local');
  for (const id of ['alpha', 'charlie', 'bravo', 'builtin', 'local']) { f.key('\x1b[B'); assert.equal(f.state.selectedId, id); }
  f.key('\x1b[A'); assert.equal(f.state.selectedId, 'builtin');
  assert.deepEqual(f.actions, []);
  f.key('/'); f.key('Bob'); f.key('\r');
  assert.equal(f.state.selectedId, 'bravo'); assert.match(f.plain(120), /── Bob · 1 项/);
  assert.doesNotMatch(f.plain(120), /── Alice/);
});

test('long author groups keep a heading and the selected extension visible during scrolling', () => {
  const data = model();
  data.rows = data.rows.filter((r) => r.type === 'resource').map((row, index) => ({ ...row, name: `T${index}`, group: '同一作者', packageName: '工具包' }));
  for (const height of [12, 24, 40]) {
    const f = setup({ model: data, rows: height });
    for (let i = 0; i < data.rows.length; i++) {
      f.key('\x1b[B');
      for (const width of [20, 36, 80, 120]) {
        const lines = checkBounds(f.component, width, height).map(stripAnsi).join('\n');
        assert.ok(lines.includes('同一作者'), `Missing group at ${width}x${height}, selected ${f.state.selectedId}:\n${lines}`);
        assert.ok(lines.includes(data.rows.find((r) => r.id === f.state.selectedId).name));
      }
    }
  }
});

if (process.env.PI_DASHBOARD_PREVIEW) {
  const f = setup();
  for (const width of [80, 120]) console.log(`\n${width} columns / 24 terminal rows\n${f.plain(width)}`);
}
