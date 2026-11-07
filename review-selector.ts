import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import { ScrollView, SelectList, Text, matchesKey, truncateToWidth, wrapTextWithAnsi, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { clean } from './core.ts';

/** Keep the explanation scrollable while the action choices stay visible. */
export class ReviewSelector {
  readonly list: SelectList;
  private readonly content: Text;
  private readonly scroll: ScrollView;
  private viewportHeight = 1;
  private bodyStart = 3;
  private actionStart = 0;
  private finished = false;

  constructor(
    readonly title: string,
    lines: string[],
    readonly options: string[],
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly requestRender: () => void,
    done: (result: string | undefined) => void,
    private readonly terminalRows: number | (() => number) = 24,
  ) {
    this.content = new Text(lines.map(clean).join('\n'), 0, 0);
    this.scroll = new ScrollView(this.content, { follow: 'none' });
    this.list = new SelectList(options.map((label, i) => ({ value: String(i), label })), Math.max(1, options.length), {
      selectedPrefix: (text) => theme.fg('accent', text),
      selectedText: (text) => theme.fg('accent', theme.bold(text)),
      description: (text) => theme.fg('muted', text),
      scrollInfo: (text) => theme.fg('dim', text),
      noMatch: (text) => theme.fg('warning', text),
    }, { truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, '…') });
    const finish = (value: string | undefined) => {
      if (this.finished) return;
      this.finished = true;
      done(value);
    };
    this.list.onSelect = (item) => finish(options[Number(item.value)]);
    this.list.onCancel = () => finish(undefined);
  }

  invalidate() { this.content.invalidate(); this.list.invalidate(); }

  handleInput(data: string) {
    if (this.finished) return;
    if (matchesKey(data, 'escape')) {
      this.list.onCancel?.(); return;
    }
    if (matchesKey(data, 'pageup')) this.scroll.scrollBy(-this.viewportHeight);
    else if (matchesKey(data, 'pagedown')) this.scroll.scrollBy(this.viewportHeight);
    else if (matchesKey(data, 'ctrl+up')) this.scroll.scrollBy(-1);
    else if (matchesKey(data, 'ctrl+down')) this.scroll.scrollBy(1);
    else if (matchesKey(data, 'home')) this.scroll.scrollToStart();
    else if (matchesKey(data, 'end')) this.scroll.scrollToEnd();
    else if (this.options.length && (this.keybindings.matches(data, 'tui.select.up') || this.keybindings.matches(data, 'tui.select.down'))) {
      const index = Number(this.list.getSelectedItem()?.value ?? 0);
      const up = this.keybindings.matches(data, 'tui.select.up');
      this.list.setSelectedIndex((index + (up ? -1 : 1) + this.options.length) % this.options.length);
    } else if (this.keybindings.matches(data, 'tui.select.confirm') || matchesKey(data, 'enter') || data === '\n') {
      const selected = this.list.getSelectedItem();
      if (selected) this.list.onSelect?.(selected);
      return;
    } else return;
    this.requestRender();
  }

  handleMouse(event: TuiMouseEvent) {
    if (this.finished) return;
    if (event.type === 'wheel' && event.y >= this.bodyStart && event.y < this.bodyStart + this.viewportHeight) {
      this.scroll.scrollBy(event.wheelDelta ?? 0);
      this.requestRender();
      return { handled: true, render: true };
    }
    if (event.y >= this.actionStart && event.y < this.actionStart + this.options.length) {
      return this.list.handleMouse({ ...event, y: event.y - this.actionStart });
    }
  }

  render(width: number) {
    width = Math.max(0, Math.floor(width));
    if (width < 4) return [truncateToWidth(clean(this.title), width, '')];
    const th = this.theme, inner = width - 2;
    const rows = typeof this.terminalRows === 'function' ? this.terminalRows() : this.terminalRows;
    const height = Math.max(8, rows);
    const hints = wrapTextWithAnsi(inner < 40 ? '↑↓选择 Enter确认 Esc返回' : '↑↓ 选择 · Enter 确认 · Esc 返回', inner);
    const actionLines = this.list.render(inner);
    const content = this.scroll.render(inner);
    this.viewportHeight = Math.max(1, Math.min(content.length || 1, height - actionLines.length - hints.length - 6));
    this.scroll.updateLayout(content.length, this.viewportHeight, this.requestRender);
    const top = this.scroll.scrollTop;
    const body = content.slice(top, top + this.viewportHeight);
    const overflow = content.length > this.viewportHeight;
    const position = overflow
      ? `${top + 1}–${Math.min(content.length, top + this.viewportHeight)}/${content.length} · PgUp/PgDn 滚动 · Ctrl+↑↓ 逐行`
      : '说明已全部显示';
    const frame = (text: string) => th.fg('border', '│') + truncateToWidth(text, inner, '…', true) + th.fg('border', '│');
    const border = (left: string, right: string) => th.fg('border', left + '─'.repeat(inner) + right);
    const result = [
      border('╭', '╮'), frame(th.fg('accent', th.bold(clean(this.title)))), border('├', '┤'),
      ...body.map((line) => frame(th.fg('muted', line))),
      frame(th.fg('dim', truncateToWidth(position, inner))), border('├', '┤'),
      ...actionLines.map(frame), ...hints.map((line) => frame(th.fg('dim', line))), border('╰', '╯'),
    ];
    this.actionStart = this.bodyStart + body.length + 2;
    return result.map((line) => truncateToWidth(line, width, ''));
  }
}
