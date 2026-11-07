import { DynamicBorder, type Theme, type KeybindingsManager } from '@earendil-works/pi-coding-agent';
import { Container, SelectList, Spacer, Text, matchesKey, type TuiMouseEvent } from '@earendil-works/pi-tui';

/** Manager-local selector. Uses Pi's wrapping SelectList without changing Pi globally. */
export class WrappingSelector {
  readonly list: SelectList;
  private readonly container = new Container();

  constructor(
    readonly title: string,
    readonly options: string[],
    theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly requestRender: () => void,
    done: (result: string | undefined) => void,
    terminalRows = 24,
  ) {
    this.list = new SelectList(options.map((text, index) => ({ value: String(index), label: text })),
      Math.max(1, Math.min(options.length, terminalRows - title.split('\n').length - 8)), {
        selectedPrefix: (text) => theme.fg('accent', text),
        selectedText: (text) => theme.fg('accent', text),
        description: (text) => theme.fg('muted', text),
        scrollInfo: (text) => theme.fg('dim', text),
        noMatch: (text) => theme.fg('warning', text),
      });
    this.list.onSelect = (item) => done(options[Number(item.value)]);
    this.list.onCancel = () => done(undefined);
    this.container.addChild(new DynamicBorder((text) => theme.fg('accent', text)));
    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(theme.fg('accent', theme.bold(title)), 1, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.list);
    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(theme.fg('dim', '↑↓ 选择 · Enter 确认 · Esc 返回'), 1, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(new DynamicBorder((text) => theme.fg('accent', text)));
  }

  render(width: number) { return this.container.render(width); }
  invalidate() { this.container.invalidate(); }
  handleInput(data: string) {
    if (this.options.length && this.keybindings.matches(data, 'tui.select.up')) {
      const current = Number(this.list.getSelectedItem()?.value ?? 0);
      this.list.setSelectedIndex((current - 1 + this.options.length) % this.options.length);
    } else if (this.options.length && this.keybindings.matches(data, 'tui.select.down')) {
      const current = Number(this.list.getSelectedItem()?.value ?? 0);
      this.list.setSelectedIndex((current + 1) % this.options.length);
    } else if (this.keybindings.matches(data, 'tui.select.confirm') || data === '\n') {
      const selected = this.list.getSelectedItem();
      if (selected) this.list.onSelect?.(selected);
    } else if (matchesKey(data, 'escape')) {
      this.list.onCancel?.();
    } else return;
    this.requestRender();
  }
  handleMouse(event: TuiMouseEvent) {
    // SelectList's mouse row offsets are local to the list, not this container.
    // Let the container route them so title/spacer rows cannot select wrong items.
    return this.container.handleMouse(event);
  }
}
