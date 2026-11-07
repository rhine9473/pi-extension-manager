import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from '@earendil-works/pi-tui';

export type DashboardRow = {
  id: string;
  type: 'resource' | 'package';
  name: string;
  source: string;
  kind: string;
  group?: string;
  groupOrder?: number;
  packageName?: string;
  enabled?: boolean;
  protected?: boolean;
  canToggle?: boolean;
  canUpdate?: boolean;
  canRemove?: boolean;
  status?: string;
  description?: string;
  details: string[];
};
export type DashboardModel = { scope: string; dirty: boolean; needsReload: boolean; rows: DashboardRow[] };
export type DashboardState = { view: 'extensions' | 'packages'; query: string; selectedId?: string };
export type DashboardAction = {
  type: 'open' | 'toggle' | 'save' | 'pending' | 'discard' | 'update' | 'remove' | 'blocked' | 'exit';
  id?: string;
  attempt?: 'toggle' | 'update' | 'remove';
};

import { KIND_LABELS as kindLabels } from './core.ts';
// 'auto' / 'builtin' carry no address; the package or settings source string does, so keep those.
// Same single-line boundary as core.clean; also consume unterminated terminal strings.
const clean = (text: string) => String(text ?? '')
  .replace(/\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

/** One interaction only: changes are intents; the parent owns confirmation and persistence. */
export class ManagerDashboard implements Component, Focusable {
  readonly capturesViewportInput = true;
  private readonly input = new Input({ prompt: '/ ', placeholder: '搜索名称、来源或详情' });
  private readonly rows: DashboardRow[];
  private searching = false;
  private hasFocus = false;
  private finished = false;
  private detailId?: string;
  private detailOffset = 0;
  private detailPage = 1;
  private detailMax = 0;

  constructor(
    readonly model: DashboardModel,
    readonly state: DashboardState,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly requestRender: () => void,
    private readonly done: (action: DashboardAction) => void,
    public terminalRows: number | (() => number) = 24,
  ) {
    this.rows = model.rows.map((row) => ({ ...row, name: clean(row.name), source: clean(row.source), kind: clean(row.kind), group: row.group === undefined ? undefined : clean(row.group), packageName: row.packageName === undefined ? undefined : clean(row.packageName), status: row.status === undefined ? undefined : clean(row.status), description: row.description === undefined ? undefined : clean(row.description), details: row.details.map(clean) }));
    const groups = new Map<string, { order: number; index: number }>();
    for (const row of this.rows) {
      const key = (row.group ?? '').toLocaleLowerCase();
      if (!groups.has(key)) groups.set(key, { order: row.groupOrder ?? 1, index: groups.size });
      else groups.get(key)!.order = Math.min(groups.get(key)!.order, row.groupOrder ?? 1);
    }
    this.rows.sort((a, b) => {
      const left = groups.get((a.group ?? '').toLocaleLowerCase())!, right = groups.get((b.group ?? '').toLocaleLowerCase())!;
      return left.order - right.order || left.index - right.index;
    });
    state.query = clean(state.query);
    this.input.onSubmit = () => this.endSearch(false);
    this.input.onEscape = () => this.endSearch(true);
    this.visibleRows();
  }

  get focused() { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value && this.searching;
  }

  invalidate() { this.input.invalidate(); }

  private changed() {
    this.invalidate();
    this.requestRender();
  }

  private emit(type: DashboardAction['type'], id?: string, attempt?: DashboardAction['attempt']) {
    if (this.finished) return;
    this.finished = true;
    this.input.focused = false;
    this.done(id === undefined ? { type } : attempt === undefined ? { type, id } : { type, id, attempt });
  }

  private visibleRows() {
    const query = this.state.query.toLocaleLowerCase().trim();
    const rows = this.rows.filter((row) => {
      if (row.type !== (this.state.view === 'extensions' ? 'resource' : 'package')) return false;
      return !query || [row.name, row.source, row.kind, kindLabels[row.kind] ?? '', row.group ?? '', row.packageName ?? '', row.description ?? '', ...row.details].join(' ').toLocaleLowerCase().includes(query);
    });
    if (!rows.some((row) => row.id === this.state.selectedId)) this.state.selectedId = rows[0]?.id;
    return rows;
  }

  // One escape ladder: leave the input box, then drop the filter, then close the panel.
  private finishSearch() {
    this.state.query = clean(this.input.getValue());
    this.searching = false;
    this.input.focused = false;
    this.visibleRows();
    this.changed();
  }

  handleInput(data: string) {
    if (this.finished || matchesKey(data, 'ctrl+c')) return;
    const cancel = matchesKey(data, 'escape');
    const confirm = matchesKey(data, 'enter') || data === '\n' || this.keybindings.matches(data, 'tui.select.confirm');
    if (this.searching) {
      if (cancel || confirm) this.finishSearch();
      else {
        this.input.handleInput(data);
        const query = clean(this.input.getValue());
        if (query !== this.input.getValue()) this.input.setValue(query);
        this.state.query = query;
        this.visibleRows();
        this.changed();
      }
      return;
    }
    if (cancel) {
      if (this.state.query) {
        this.state.query = '';
        this.input.setValue('');
        this.visibleRows();
        this.changed();
        return;
      }
      this.emit('exit');
      return;
    }
    const rows = this.visibleRows();
    const selected = rows.find((row) => row.id === this.state.selectedId);
    if (matchesKey(data, 'pageup') || matchesKey(data, 'pagedown')) {
      this.detailOffset = Math.max(0, Math.min(this.detailMax, this.detailOffset + (matchesKey(data, 'pageup') ? -1 : 1) * this.detailPage));
    } else if (this.keybindings.matches(data, 'tui.select.up') || this.keybindings.matches(data, 'tui.select.down')) {
      if (rows.length) {
        const up = this.keybindings.matches(data, 'tui.select.up');
        const index = rows.findIndex((row) => row.id === this.state.selectedId);
        this.state.selectedId = rows[(index + (up ? -1 : 1) + rows.length) % rows.length].id;
      }
    } else if (matchesKey(data, 'tab')) {
      this.state.view = this.state.view === 'extensions' ? 'packages' : 'extensions';
      this.visibleRows();
    } else if (matchesKey(data, '/')) {
      this.input.setValue(this.state.query);
      this.input.handleInput('\x05'); // Pi Input: position the cursor at the end of the existing query.
      this.searching = true;
      this.input.focused = this.focused;

    } else if (confirm) {
      if (selected?.type === 'package') this.emit('open', selected.id);
      return;
    } else if (matchesKey(data, 'space')) {
      const allowed = selected && !selected.protected && (selected.type === 'resource' || selected.canToggle);
      // A refused key must say why instead of looking broken; an empty list stays silent.
      if (allowed) this.emit('toggle', selected!.id);
      else if (selected) this.emit('blocked', selected.id, 'toggle');
      return;
    } else if (matchesKey(data, 'u') || matchesKey(data, 'd')) {
      const action = matchesKey(data, 'u') ? 'update' : 'remove';
      if (this.packageActionAllowed(selected, action)) this.emit(action, selected!.id);
      else if (selected?.type === 'package') this.emit('blocked', selected.id, action);
      return;
    } else {
      const shortcuts = { s: 'save', p: 'pending', x: 'discard' } as const;
      for (const key of Object.keys(shortcuts) as (keyof typeof shortcuts)[]) {
        if (matchesKey(data, key)) { this.emit(shortcuts[key]); return; }
      }
      return;
    }
    this.changed();
  }

  private packageActionAllowed(row: DashboardRow | undefined, action: 'update' | 'remove') {
    return row?.type === 'package' && !row.protected && (action === 'update'
      ? row.canUpdate !== false && row.kind !== 'local'
      : row.canRemove !== false);
  }

  private status(row: DashboardRow) {
    return row.status ?? (row.protected ? '只读' : row.type === 'package' ? '已配置' : row.enabled ? '启用' : '禁用');
  }

  private listLines(rows: DashboardRow[], width: number, height: number) {
    if (!rows.length) return (this.state.query
      ? [this.theme.fg('warning', `没有匹配「${truncateToWidth(this.state.query, Math.max(1, width - 12), '…')}」`),
         this.theme.fg('dim', 'Esc 清除筛选 · / 修改关键词')]
      : [this.theme.fg('warning', '暂无可扩展的条目'), this.theme.fg('dim', '/ 搜索 · Tab 切到包页')]).slice(0, height);
    const grouped = rows.some((row) => row.group);
    const list = new SelectList(rows.map((row) => ({
      value: row.id,
      label: `[${this.status(row)}] ${row.name} · ${row.type === 'resource' && row.packageName && row.packageName !== row.name ? row.packageName : kindLabels[row.kind] ?? row.kind}`,
    })), grouped ? rows.length : Math.max(1, height - (rows.length > height ? 1 : 0)), {
      selectedPrefix: (text) => this.theme.fg('accent', text),
      selectedText: (text) => this.theme.bg('selectedBg', this.theme.fg('accent', this.theme.bold(truncateToWidth(text, width, '…', true)))),
      description: (text) => this.theme.fg('muted', text),
      scrollInfo: (text) => this.theme.fg('dim', text),
      noMatch: (text) => this.theme.fg('warning', text),
    }, { truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, '…') });
    const selected = rows.findIndex((row) => row.id === this.state.selectedId);
    list.setSelectedIndex(selected);
    const rendered = list.render(width);
    if (!grouped) return rendered.slice(0, height);
    if (height <= 1) return [rendered[selected]];
    const key = (row: DashboardRow) => (row.group ?? '其他来源').toLocaleLowerCase();
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
    const heading = (row: DashboardRow) => this.theme.fg('accent', this.theme.bold(truncateToWidth(`── ${row.group ?? '其他来源'} · ${counts.get(key(row))} 项 ──`, width, '…')));
    const entries: { text: string; row: DashboardRow; heading: boolean }[] = [];
    rows.forEach((row, index) => {
      if (!index || key(row) !== key(rows[index - 1])) entries.push({ text: heading(row), row, heading: true });
      entries.push({ text: rendered[index], row, heading: false });
    });
    const selectedPosition = entries.findIndex((entry) => !entry.heading && entry.row.id === this.state.selectedId);
    let start = Math.max(0, Math.min(selectedPosition - Math.floor(height / 2), entries.length - height));
    const viewport = () => {
      const sticky = entries[start].heading ? [] : [{ text: heading(entries[start].row), row: entries[start].row, heading: true }];
      return [...sticky, ...entries.slice(start, start + height - sticky.length)];
    };
    let visible = viewport();
    while (!visible.some((entry) => !entry.heading && entry.row.id === this.state.selectedId)) { start++; visible = viewport(); }
    return visible.map((entry) => entry.text);
  }

  private detailLines(row: DashboardRow | undefined, width: number, height: number) {
    if (!row) return [this.theme.fg('muted', '暂无详情 · / 搜索')];
    const kindLabel = kindLabels[row.kind] ?? row.kind;
    const status = row.type === 'package'
      ? `${this.status(row)} · ${kindLabel}`
      : row.status ? `${row.enabled ? '已启用' : '已禁用'} · ${row.status} · ${kindLabel}` : `${row.enabled ? '已启用' : '已禁用'} · ${kindLabel}`;
    if (this.detailId !== row.id) { this.detailId = row.id; this.detailOffset = 0; }
    const lines = [
      ...(height > 2 ? [
        this.theme.fg('accent', this.theme.bold(truncateToWidth(row.name, width))),
        this.theme.fg(row.protected ? 'warning' : row.enabled === false ? 'muted' : 'success', truncateToWidth(status, width)),
      ] : []),
      ...(row.description ? [
        ...(height > 2 ? [this.theme.fg('accent', '功能简介')] : []),
        ...wrapTextWithAnsi(row.description, width).map((line) => this.theme.fg('text', line)),
        '',
      ] : []),
      ...[row.source === 'auto' || row.source.startsWith('builtin') ? '' : row.source, ...row.details].filter(Boolean).flatMap((text) => wrapTextWithAnsi(text, width).map((line) => this.theme.fg('muted', line))),
    ];
    const overflow = lines.length > height;
    this.detailPage = Math.max(1, height - (overflow && height > 1 ? 1 : 0));
    this.detailMax = Math.max(0, lines.length - this.detailPage);
    this.detailOffset = Math.min(this.detailOffset, this.detailMax);
    const visible = lines.slice(this.detailOffset, this.detailOffset + this.detailPage);
    if (overflow && height > 1) visible.push(this.theme.fg('dim', `${this.detailOffset + 1}–${this.detailOffset + visible.length}/${lines.length} · PgUp/PgDn 滚动详情`));
    return visible;
  }

  render(width: number): string[] {
    width = Math.max(0, Math.floor(width));
    if (!width) return [''];
    const terminalRows = typeof this.terminalRows === 'function' ? this.terminalRows() : this.terminalRows;
    const height = Math.max(1, Math.floor(terminalRows));
    const inner = Math.max(1, width - 2);
    const th = this.theme;
    const fit = (text: string, columns = inner) => truncateToWidth(text, columns, '…', true);
    const border = (left: string, right: string, title = '') => {
      const label = truncateToWidth(title, inner, '');
      return th.fg('border', left) + th.fg('accent', label) + th.fg('border', '─'.repeat(Math.max(0, inner - visibleWidth(label))) + right);
    };
    const frame = (text: string) => th.fg('border', '│') + fit(text) + th.fg('border', '│');
    const resources = this.rows.filter((row) => row.type === 'resource');
    const packages = this.rows.length - resources.length;
    const rows = this.visibleRows();
    const selected = rows.find((row) => row.id === this.state.selectedId);
    const narrow = inner < 46;
    const actions: string[] = [];
    if (selected && !selected.protected && (selected.type === 'resource' || selected.canToggle)) actions.push(selected.type === 'package'
      ? narrow ? `空格整包${selected.enabled ? '关闭' : '开启'}` : `空格 整包${selected.enabled ? '关闭' : '开启'}`
      : narrow ? `空格${selected.enabled ? '禁用' : '启用'}` : `空格 ${selected.enabled ? '禁用' : '启用'}（不删文件）`);
    if (this.model.dirty) actions.push(narrow ? 's存 p差异 x弃' : 's 保存 · p 差异 · x 放弃');
    if (this.packageActionAllowed(selected, 'update')) actions.push(narrow ? 'u更新' : 'u 更新包');
    if (this.packageActionAllowed(selected, 'remove')) actions.push(narrow ? 'd卸载' : 'd 卸载包');
    const footer = (this.searching
      ? narrow ? ['Enter Esc完成'] : ['搜索中 · 实时筛选 · Enter / Esc 完成 · Ctrl+U 删至行首']
      : narrow ? [`${selected?.type === 'package' ? '↑↓ ↵菜单 ' : '↑↓ '}Tab / Esc${this.state.query ? '清' : '退'}`, actions.join(' ')].filter(Boolean) : [
        ['↑↓ 选择', selected?.type === 'package' ? 'Enter 包菜单' : '', 'Tab 切页', '/ 搜索', this.state.query ? 'Esc 清除筛选' : 'Esc 退出'].filter(Boolean).join(' · '),
        actions.join(' · '),
      ]).filter(Boolean).flatMap((line) => wrapTextWithAnsi(line, inner));
    const scope = clean(this.model.scope);
    const changes = th.fg(this.model.dirty ? 'warning' : 'success', this.model.dirty ? '● 未保存' : '✓ 已保存');
    const meta = inner < 26
      ? `${th.fg('accent', scope)} ${th.fg(this.model.dirty ? 'warning' : 'success', this.model.dirty ? '●未存' : '✓已存')}${this.model.needsReload ? th.fg('warning', ' ↻重载') : ''}`
      : `${th.fg('accent', scope)} · ${changes}${this.model.needsReload ? th.fg('warning', ' · 待重载') : ''}`;
    const extensionTab = `扩展 ${resources.length}`;
    const packageTab = `包 ${packages}`;
    const tabs = `${this.state.view === 'extensions' ? th.fg('accent', th.bold(`[${extensionTab}]`)) : th.fg('muted', extensionTab)}  ${this.state.view === 'packages' ? th.fg('accent', th.bold(`[${packageTab}]`)) : th.fg('muted', packageTab)}${inner >= 46 ? th.fg('dim', ` · 启用 ${resources.filter((row) => row.enabled).length}/${resources.length}`) : ''}`;
    const position = `${rows.length ? rows.findIndex((row) => row.id === this.state.selectedId) + 1 : 0}/${rows.length}`;
    const search = this.searching ? this.input.render(inner)[0] : th.fg('dim', selected?.group && narrow
      ? `${selected.group} · ${position}`
      : `${position} · ${this.state.query ? `/ ${this.state.query}` : '/ 搜索'}`);
    const header = [meta, tabs, search];
    const bodyHeight = Math.max(1, height - header.length - footer.length - 4);
    const body: string[] = [];
    if (inner >= 70) {
      const left = Math.floor((inner - 3) * 0.48);
      const right = inner - left - 3;
      const list = this.listLines(rows, left, bodyHeight);
      const details = this.detailLines(selected, right, bodyHeight);
      for (let i = 0; i < bodyHeight; i++) body.push(fit(list[i] ?? '', left) + th.fg('border', ' │ ') + fit(details[i] ?? '', right));
    } else {
      const detailHeight = bodyHeight >= 6 ? Math.min(5, Math.floor(bodyHeight / 3)) : bodyHeight >= 3 && !rows.some((row) => row.group) ? 1 : 0;
      const listHeight = bodyHeight - detailHeight - (detailHeight ? 1 : 0);
      const list = this.listLines(rows, inner, listHeight);
      for (let i = 0; i < listHeight; i++) body.push(list[i] ?? '');
      if (detailHeight) body.push(th.fg('border', '─'.repeat(inner)), ...this.detailLines(selected, inner, detailHeight));
      while (body.length < bodyHeight) body.push('');
    }
    const lines = [border('╭', '╮', ' 扩展管理 '), ...header.map(frame), border('├', '┤'), ...body.map(frame), border('├', '┤'), ...footer.map((line) => frame(th.fg('dim', line))), border('╰', '╯')];
    // Tiny terminals still retain the current selection and the exit hint.
    const result = lines.length > height ? [lines[0], ...body.map(frame), ...footer.map((line) => frame(line)), lines.at(-1)!].slice(-height) : lines;
    return result.map((line) => truncateToWidth(line, width, ''));
  }
}
