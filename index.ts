import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DefaultPackageManager, SettingsManager, getAgentDir, getPackageDir,
  type ExtensionAPI, type ExtensionCommandContext, type ResolvedResource,
} from '@earendil-works/pi-coding-agent';
import { truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { WrappingSelector } from './wrapping-selector.ts';
import { createProvenanceReader } from './provenance.ts';
import { ReviewSelector } from './review-selector.ts';
import { packageDescription, resourceDescription } from './descriptions.ts';
import { ManagerDashboard, type DashboardAction, type DashboardRow, type DashboardState } from './dashboard.ts';
import {
  backup, clean, clone, discover, identity, readSnapshot, saveSnapshot,
  KIND_LABELS, runPackageCommand, sourceKind, sourceOf, toggleConfig, togglePackageConfig, isPackageDisabled, verifyPackageChange, verifySingleChange, changeSummary, packageFingerprint, describeUpdateResult,
} from './core.ts';

type Config = Record<string, any>;
const screenOptions = { overlay: true, overlayOptions: { anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 } } as const;

// Pad short menus too, so the underlying session cannot show through.
function fillScreen<T extends Component>(component: T, rows: () => number): T {
  const render = component.render.bind(component);
  component.render = (width) => {
    const lines = render(width);
    return Array.from({ length: Math.max(1, Math.floor(rows())) }, (_, i) => truncateToWidth(lines[i] ?? '', width, '', true));
  };
  return component;
}

const api = { DefaultPackageManager, SettingsManager };
const selfPath = fileURLToPath(import.meta.url);
const kindLabels = KIND_LABELS;

export default function extensionManager(pi: ExtensionAPI) {
  let open = false;
  pi.registerCommand('extension-manager', {
    description: '统一管理本地、npm/git 包及内置扩展（中文终端界面）',
    handler: async (_args, ctx) => {
      if (ctx.mode !== 'tui') { ctx.ui.notify('扩展管理器仅支持交互式终端', 'warning'); return; }
      if (open) { ctx.ui.notify('扩展管理器已打开', 'warning'); return; }
      open = true;
      let reload = false;
      try { reload = await manage(ctx); }
      catch (err) { ctx.ui.notify(`扩展管理失败：${clean(err instanceof Error ? err.message : err)}`, 'error'); }
      finally { open = false; }
      if (reload) { await ctx.reload(); return; }
    },
  });
}

async function manage(ctx: ExtensionCommandContext): Promise<boolean> {
  const agentDir = getAgentDir();
  const cwd = ctx.cwd;
  const backupDir = path.join(agentDir, 'state', 'extension-manager', 'backups');
  const scope = 'user';
  let globalSnapshot = readSnapshot(path.join(agentDir, 'settings.json'));
  let draft: Config = clone(globalSnapshot.data);
  let needsReload = false;
  let query = '';
  let page = 0;
  let resources: ResolvedResource[] = [];
  let allResources: ResolvedResource[] = [];
  let packages: any[] = [];
  const dashboardState: DashboardState = { view: 'extensions', query: '' };
  let provenance = createProvenanceReader();

  const width = () => Math.max(12, (process.stdout.columns || 80) - 8);
  const label = (text: string) => truncateToWidth(clean(text), width(), '…');
  const scopeName = () => '全局';
  const dirty = () => JSON.stringify(draft) !== JSON.stringify(snapshot().data);
  const snapshot = () => globalSnapshot;
  async function resolveDraft(candidate: Config = draft) {
    return discover(api, cwd, agentDir, candidate, {}, false);
  }
  const kind = (r: ResolvedResource) => r.metadata.origin === 'package' ? sourceKind(r.metadata.source) : r.metadata.source === 'builtin' ? 'builtin' : r.metadata.source === 'auto' ? 'auto' : 'settings';
  const protectedResource = (r: ResolvedResource) => identity(r.path) === identity(selfPath);
  const name = (r: ResolvedResource) => provenance.resource(r).name;
  const packageEntry = (source: string) => (draft.packages ?? []).find((entry: any) => sourceOf(entry) === source);
  const packageClosed = (r: ResolvedResource) => r.metadata.origin === 'package' && isPackageDisabled(packageEntry(r.metadata.source));
  const canEdit = (r: ResolvedResource) => r.metadata.scope === scope && !protectedResource(r) && !packageClosed(r);
  const resourceId = (r: ResolvedResource) => `r:${r.metadata.scope}:${r.path}`;
  const packageId = (pkg: any) => `p:${pkg.scope}:${pkg.source}`;

  async function refresh() {
    const result = await resolveDraft();
    provenance = createProvenanceReader();
    resources = result.resources.sort((a: ResolvedResource, b: ResolvedResource) => Number(protectedResource(b)) - Number(protectedResource(a)) || name(a).localeCompare(name(b)) || a.path.localeCompare(b.path));
    allResources = result.allResources;
    packages = result.packages;
  }
  async function choose(title: string, items: { id: string; text: string }[]) {
    const mapping = new Map<string, string>();
    const options = items.map((item, i) => {
      const text = label(`${i + 1}. ${item.text}`);
      mapping.set(text, item.id);
      return text;
    });
    const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
      fillScreen(new WrappingSelector(title, options, theme, keybindings, () => tui.requestRender(), done, tui.terminal.rows), () => tui.terminal.rows), screenOptions);
    return selected === undefined ? undefined : mapping.get(selected);
  }
  async function review(title: string, lines: string[], items: { id: string; text: string }[]) {
    const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
      fillScreen(new ReviewSelector(title, lines, items.map((item) => item.text), theme, keybindings,
        () => tui.requestRender(), done, () => tui.terminal.rows), () => tui.terminal.rows), screenOptions);
    return items.find((item) => item.text === selected)?.id;
  }
  async function detail(title: string, lines: string[]) {
    await review(title, lines, [{ id: 'back', text: '返回' }]);
  }
  async function confirm(title: string, text: string, action: string) {
    return await review(title, text.split('\n'), [{ id: 'cancel', text: '取消' }, { id: 'yes', text: action }]) === 'yes';
  }
  async function changeLines() {
    const [saved, staged] = await Promise.all([resolveDraft(snapshot().data), resolveDraft()]);
    return changeSummary(saved.allResources, staged.allResources, snapshot().data, draft);
  }
  async function save(): Promise<boolean> {
    if (!dirty()) return true;
    const changes = await changeLines();
    if (!await confirm('保存配置？', ['本次改动：', ...(changes.length ? changes : ['无资源状态变化']), '', `写入：${snapshot().file}`, '仅更新扩展配置；源码不删除。', `备份：${backupDir}`, '保存后需要 /reload。'].join('\n'), '确认保存')) return false;
    const saved = saveSnapshot(snapshot(), draft, backupDir);
    globalSnapshot = saved.snapshot;
    draft = clone(saved.snapshot.data);
    needsReload = true;
    ctx.ui.notify(`配置已保存并核验；需 reload。备份：${saved.backupPath}`, 'info');
    await refresh();
    return true;
  }
  async function settleDraft(): Promise<boolean> {
    if (!dirty()) return true;
    const action = await choose('有未保存改动', [
      { id: 'cancel', text: '取消操作，继续编辑' },
      { id: 'save', text: '先保存配置' },
      { id: 'discard', text: '放弃暂存后继续' },
    ]);
    if (action === 'save') return save();
    if (action !== 'discard') return false;
    draft = clone(snapshot().data); await refresh(); return true;
  }
  async function toggle(r: ResolvedResource) {
    if (!canEdit(r)) { ctx.ui.notify('继承资源请切到全局管理；管理器自身不能禁用', 'warning'); return; }
    const enabled = !r.enabled;
    const candidate = toggleConfig(draft, r, agentDir, cwd, enabled, selfPath);
    const after = await resolveDraft(candidate);
    verifySingleChange(resources, after.resources, r.path, enabled, selfPath);
    draft = candidate;
    await refresh();
    ctx.ui.notify('已暂存；保存并 reload 后生效', 'info');
  }
  async function togglePackage(pkg: any) {
    const enabled = isPackageDisabled(packageEntry(pkg.source));
    const candidate = togglePackageConfig(draft, pkg, enabled, selfPath);
    const after = await resolveDraft(candidate);
    verifyPackageChange(allResources, after.allResources, pkg, enabled, selfPath);
    draft = candidate;
    await refresh();
    ctx.ui.notify(`已暂存整包${enabled ? '开启' : '关闭'}；按 s 保存并 reload 后生效`, 'info');
  }
  const packageVersionLine = (root: string | undefined) => {
    const value = packageFingerprint(root).version;
    return value ? `版本：${value}` : '该包不声明版本号；更新结果按安装文件时间判断';
  };
  const displayPath = (file: string) => (file.startsWith(agentDir) ? `~${file.slice(agentDir.length)}` : file).split('\\').join('/');
  function resourceDetails(r: ResolvedResource): string[] {
    const builtin = r.path.startsWith('builtin:');
    // Loose files and builtins have no version at all; show the field only when a manifest really declares one.
    let version = '';
    if (r.metadata.packageRoot) {
      try { const value = JSON.parse(fs.readFileSync(path.join(r.metadata.packageRoot, 'package.json'), 'utf8')).version; if (typeof value === 'string' && value) version = value; } catch {}
    }
    const facts = [
      version ? `版本：${version}` : '',
      `作用域：${r.metadata.scope === 'user' ? '全局' : '项目'}`,
      `文件：${builtin ? 'Pi 自带' : fs.existsSync(r.path) ? '存在' : '缺失'}`,
    ].filter(Boolean).join(' · ');
    return [
      provenance.resource(r).credit, facts,
      ...(builtin ? [] : ['路径', displayPath(r.path)]),
      protectedResource(r) ? '管理器自身受保护' : packageClosed(r) ? '整包已关闭，请先在包页开启整包' : canEdit(r) ? `Space ${r.enabled ? '暂存禁用' : '暂存启用'}${builtin ? '（只改配置）' : '（不删文件）'}` : '此扩展为只读',
      '配置启用不代表加载成功；保存并 reload 后查看 Pi 报告。',
    ];
  }
  function dashboardRows(): DashboardRow[] {
    return [
      ...resources.map((r) => ({
        ...provenance.resource(r),
        id: resourceId(r), type: 'resource' as const, name: name(r), source: r.metadata.source,
        kind: kind(r), enabled: r.enabled, protected: !canEdit(r),
        description: resourceDescription(r, agentDir), details: resourceDetails(r),
        status: packageClosed(r) ? '包已关' : protectedResource(r) ? '只读' : undefined,
      })),
      ...packages.map((pkg) => {
        const children = resources.filter((r) => r.metadata.source === pkg.source && r.metadata.scope === pkg.scope);
        const members = allResources.filter((r) => r.metadata.origin === 'package' && r.metadata.source === pkg.source && r.metadata.scope === pkg.scope);
        const disabled = isPackageDisabled(packageEntry(pkg.source));
        const active = members.filter((r) => r.enabled).length;
        const installed = Boolean(pkg.installedPath && fs.existsSync(pkg.installedPath));
        const root = pkg.installedPath ? identity(pkg.installedPath) : undefined;
        const protectedPackage = pkg.scope !== scope || Boolean(root && (identity(selfPath) === root || identity(selfPath).startsWith(`${root}${path.sep}`)));
        const packageName = sourceKind(pkg.source) === 'npm' ? pkg.source.slice(4) : pkg.source.split(/[\\/]/).filter(Boolean).at(-1) ?? pkg.source;
        return {
          ...provenance.package(pkg),
          id: packageId(pkg), type: 'package' as const, name: packageName, source: pkg.source,
          kind: sourceKind(pkg.source), status: !installed ? '缺失' : disabled ? '已关闭' : active < members.length ? '部分启用' : '已开启', protected: protectedPackage,
          canToggle: !protectedPackage,
          canUpdate: !protectedPackage && scope === 'user' && sourceKind(pkg.source) !== 'local',
          canRemove: !protectedPackage,
          description: packageDescription(pkg) || '暂无功能说明。',
          enabled: !disabled,
          details: [
            provenance.package(pkg).credit,
            ...(installed ? [packageVersionLine(pkg.installedPath)] : []),
            `整包开关：${disabled ? '关闭' : '开启'}；资源 ${active}/${members.length} 项启用`,
            '开关包含扩展、技能、提示词和主题；重新开启会恢复原来的单项设置。',
            `类型：${kindLabels[sourceKind(pkg.source)]}`,
            `作用域：${pkg.scope === 'user' ? '全局' : '项目'}`, `安装：${installed ? '已安装' : '缺失'}`,
            `子扩展：${children.length} 项`, '路径', pkg.installedPath ? displayPath(pkg.installedPath) : '未知',
            'Space 暂存整包开关；Enter 打开包菜单。',
          ],
        };
      }),
    ];
  }
  async function browse(pkg: any) {
    while (true) {
      const indices = resources.map((_, i) => i).filter((i) => {
        const r = resources[i];
        return r.metadata.source === pkg.source && r.metadata.scope === pkg.scope
          && (!query || `${name(r)} ${r.path} ${r.metadata.source}`.toLowerCase().includes(query.toLowerCase()));
      });
      const size = Math.max(1, Math.min(5, (process.stdout.rows || 24) - 17));
      const pages = Math.max(1, Math.ceil(indices.length / size)); page = Math.min(page, pages - 1);
      const entries = indices.slice(page * size, (page + 1) * size).map((id) => {
        const r = resources[id];
        return { id: `r:${id}`, text: `#${id + 1} [${r.enabled ? '启用' : '禁用'}]${protectedResource(r) ? '[保护]' : ''} ${name(r)} · ${kindLabels[kind(r)]}/${r.metadata.scope === 'user' ? '全局' : '项目'}` };
      });
      const selected = await choose(`扩展｜${scopeName()}｜${indices.length} 项｜${page + 1}/${pages} 页${dirty() ? '｜待保存' : ''}\n${label(`搜索：${query || '无'}`)}`, [
        ...entries, { id: 'search', text: '搜索' },
        ...(page > 0 ? [{ id: 'prev', text: '上一页' }] : []), ...(page + 1 < pages ? [{ id: 'next', text: '下一页' }] : []),
        { id: 'back', text: '返回' },
      ]);
      if (!selected || selected === 'back') return;
      if (selected.startsWith('r:')) {
        const resource = resources[Number(selected.slice(2))];
        if (!resource) continue;
        Object.assign(dashboardState, { view: 'extensions', query: '', selectedId: resourceId(resource) });
        return true;
      }
      else if (selected === 'search') {
        const text = await ctx.ui.input('搜索扩展', '名称、路径或包来源；空字符串清空');
        if (text !== undefined) { query = clean(text).trim(); page = 0; }
      } else page += selected === 'next' ? 1 : -1;
    }
  }
  function actualManager() {
    // This manager edits global settings only; project trust does not widen its scope.
    const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const errors = manager.drainErrors();
    if (errors.length) throw errors[0].error;
    return { settings: manager, packages: new DefaultPackageManager({ cwd, agentDir, settingsManager: manager, builtinExtensions: [] }) };
  }
  async function packageOperation(action: 'remove' | 'update', pkg: any) {
    if (!await settleDraft()) return;
    let source = pkg.source;
    const actual = actualManager();
    const configBase = agentDir;
    // Package declarations are settings-relative; CLI-style mutation inputs are cwd-relative.
    if (action === 'remove' && sourceKind(source) === 'local') source = path.resolve(configBase, source);
    const installedRoot = actual.packages.getInstalledPath(source, scope);
    const declaredSource = sourceKind(source) === 'local' ? path.relative(configBase, source) || '.' : source;
    if (installedRoot && (identity(selfPath) === identity(installedRoot) || identity(selfPath).startsWith(`${identity(installedRoot)}${path.sep}`))) throw new Error('包含管理器的包受保护，不能修改');
    if (action === 'update' && sourceKind(source) === 'local') throw new Error('本地包无网络更新；修改源文件后 /reload');
    const verbs = { remove: '卸载', update: '更新' };
    const before = packageFingerprint(installedRoot ?? pkg.installedPath);
    if (!await confirm(`${verbs[action]}包？`, `来源：${source}\n作用域：${scopeName()}\n配置：${snapshot().file}\n${before.version ? `当前版本：${before.version}` : '当前包不声明版本号'}\n${action === 'remove' ? '移除包声明，受管 npm/git 目录可能删除；本地源文件不会删除。所有包资源会受影响。' : '可能联网并运行安装脚本；请仅使用可信来源。固定版本/ref 不会自动改为最新版。'}\n需 reload 后尝试加载新状态。`, `确认${verbs[action]}`)) return;
    const backupPath = backup(snapshot(), backupDir);
    ctx.ui.notify(`正在${verbs[action]} ${clean(source)}，请稍候…`, 'info');
    try {
      const hostRoot = getPackageDir();
      const hostManifest = JSON.parse(fs.readFileSync(path.join(hostRoot, 'package.json'), 'utf8'));
      const bin = typeof hostManifest.bin === 'string' ? hostManifest.bin : hostManifest.bin.pi;
      const cli = path.resolve(hostRoot, bin);
      if (!fs.existsSync(cli)) throw new Error('未找到当前 Pi 的 CLI 入口');
      const args = [action, source, '--no-approve'];
      const output = await runPackageCommand(cli, args, cwd, agentDir, ctx.signal);
      if (output.code !== 0 || output.interrupted) throw new Error(`Pi 包命令失败（${output.reason || output.code}）：${clean(output.stderr || output.stdout).slice(-1600)}`);
      const fresh = readSnapshot(snapshot().file);
      const sources = (fresh.data.packages ?? []).map(sourceOf);
      if (action === 'remove' && (sources.includes(declaredSource) || sources.some((s: string) => sourceKind(source) === 'local' && sourceKind(s) === 'local' && identity(path.resolve(configBase, s)) === identity(source)))) throw new Error('卸载后包声明仍存在');
      let result = `${verbs[action]}完成并核验；需 reload`;
      if (action !== 'remove') {
        const target = actual.packages.getInstalledPath(source, scope);
        if (!target || !fs.existsSync(target)) throw new Error('操作后安装路径核验失败');
        result = `${verbs[action]}完成：${describeUpdateResult(before, packageFingerprint(target))}；需 reload`;
      }
      globalSnapshot = fresh;
      draft = clone(fresh.data); needsReload = true; await refresh();
      ctx.ui.notify(`${result}。备份：${backupPath}`, 'info');
    } catch (err) {
      needsReload = true;
      // Surface possible partial changes; never claim rollback of install scripts.
      const fresh = readSnapshot(snapshot().file);
      globalSnapshot = fresh;
      draft = clone(fresh.data); await refresh();
      throw new Error(`${verbs[action]}失败，可能已有部分变更：${err instanceof Error ? err.message : err}；备份：${backupPath}`);
    }
  }
  /** A refused key should explain itself instead of looking dead. */
  function refusal(attempt: 'toggle' | 'update' | 'remove', r: ResolvedResource | undefined, pkg: any) {
    if (r) return protectedResource(r) ? '管理器自身受保护：禁用它就没有这个面板了。'
      : packageClosed(r) ? '整包已关闭：先在包页开启整包，才能单独启停子扩展。'
      : r.metadata.scope !== scope ? '这是项目继承的资源：请用 pi config --local 管理。'
      : '该资源当前不可启停。';
    if (pkg) {
      if (pkg.scope !== scope) return '这是项目作用域的包：请用 pi config --local 管理。';
      const root = pkg.installedPath ? identity(pkg.installedPath) : undefined;
      if (root && (identity(selfPath) === root || identity(selfPath).startsWith(`${root}${path.sep}`))) return '管理器就装在这个包里：整包开关或卸载会带走它。';
      if (attempt === 'update' && sourceKind(pkg.source) === 'local') return '本地包没有网络更新：改源文件后 /reload 即可。';
      if (!pkg.installedPath || !fs.existsSync(pkg.installedPath)) return '包目录缺失：先重新安装或修正来源声明。';
    }
    return '该项不支持这个操作。';
  }
  async function packageMenu(pkg: any) {
    while (true) {
      const selected = await choose(`包｜${label(pkg.source)}`, [
        { id: 'back', text: '返回' }, { id: 'details', text: '详情（完整路径/来源）' }, { id: 'children', text: '浏览子扩展' },
        ...(pkg.scope === scope ? [
          { id: 'toggle', text: isPackageDisabled(packageEntry(pkg.source)) ? '暂存开启整包（恢复单项设置）' : '暂存关闭整包（保留文件）' },
          ...(sourceKind(pkg.source) !== 'local' && scope === 'user' ? [{ id: 'update', text: '更新包（需确认）' }] : []),
          { id: 'remove', text: '卸载包（需确认）' },
        ] : []),
      ]);
      if (!selected || selected === 'back') return;
      if (selected === 'details') await detail('包详情', [
        `来源：${pkg.source}`, `类型：${kindLabels[sourceKind(pkg.source)]}`, `作用域：${pkg.scope === 'user' ? '全局' : '项目'}`,
        packageVersionLine(pkg.installedPath), `清单文件时间：${packageFingerprint(pkg.installedPath).mtimeMs ? new Date(packageFingerprint(pkg.installedPath).mtimeMs).toLocaleString() : '不可读'}`,
        `安装路径：${pkg.installedPath ?? '缺包/未知'}`, `子扩展数：${resources.filter((r) => r.metadata.source === pkg.source && r.metadata.scope === pkg.scope).length}`,
        '包可能同时包含 skills/prompts/themes，卸载影响整个包。',
      ]);
      else if (selected === 'toggle') { await togglePackage(pkg); return; }
      else if (selected === 'children') { page = 0; if (await browse(pkg)) return; }
      else { await packageOperation(selected as 'remove' | 'update', pkg); return; }
    }
  }
  await refresh();
  while (true) {
    const action = await ctx.ui.custom<DashboardAction>((tui, theme, keybindings, done) =>
      fillScreen(new ManagerDashboard({ scope: scopeName(), dirty: dirty(), needsReload, rows: dashboardRows() },
        dashboardState, theme, keybindings, () => tui.requestRender(), done, () => tui.terminal.rows), () => tui.terminal.rows), screenOptions);
    const selected = action?.type ?? 'exit';
    try {
      if (!selected || selected === 'exit') {
        if (!await settleDraft()) continue;
        if (needsReload) return await choose('配置已变更；reload 后尝试生效', [{ id: 'now', text: '立即 reload' }, { id: 'later', text: '稍后手动 /reload' }]) === 'now';
        return false;
      }
      const resource = resources.find((r) => resourceId(r) === action?.id);
      const pkg = packages.find((p) => packageId(p) === action?.id);
      if (selected === 'blocked') ctx.ui.notify(refusal(action?.attempt ?? 'toggle', resource, pkg), 'warning');
      else if (selected === 'open' && pkg) await packageMenu(pkg);
      else if (selected === 'toggle' && resource) await toggle(resource);
      else if (selected === 'toggle' && pkg) await togglePackage(pkg);
      else if ((selected === 'update' || selected === 'remove') && pkg) {
        if (pkg.scope !== scope) ctx.ui.notify('继承包请切到对应作用域管理', 'warning');
        else await packageOperation(selected, pkg);
      } else if (selected === 'save') await save();
      else if (selected === 'discard' && dirty()) {
        if (await confirm('放弃暂存？', '尚未写入的配置变更将丢弃；已保存配置不回滚。', '确认放弃')) { draft = clone(snapshot().data); await refresh(); }
      } else if (selected === 'pending') {
        const changes = await changeLines();
        await detail('暂存差异（相对已保存配置）', changes.length ? changes : ['无资源状态变化；配置文本可能有其他调整']);
      }
    } catch (err) { ctx.ui.notify(`未完成：${clean(err instanceof Error ? err.message : err)}`, 'error'); }
  }
}
