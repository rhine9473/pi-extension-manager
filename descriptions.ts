import fs from 'node:fs';
import path from 'node:path';

// Summaries checked against the installed extensions' source and OpenPI USAGE.md.
const builtins = {
  'builtin:mcp': '连接 MCP 服务，把外部工具提供给 Pi，并管理服务连接与工具发现。',
  'builtin:llama.cpp': '连接已配置的 llama.cpp 服务，通过 /llama 浏览、下载、加载和卸载模型，并在 Pi 中使用。',
  'builtin:codemode': '在 JavaScript 沙箱中组合、批量调用工具，并汇总执行结果。',
  'builtin:tool-search': '搜索尚未向模型提供的工具（如 MCP 工具），并在下一次模型调用时加载匹配项。',
};
const local = {
  'extension-manager/index.ts': '集中浏览本地和 Git/npm 扩展，查看用途和状态，切换单项或整包开关，以及更新和卸载已有包。',
  'mermaid-inline/index.ts': '把回复中的 Mermaid 图表转成终端内可读的字符图，并根据终端宽度调整布局。',
  'smart-models.ts': '按实际上游来源分组选择模型，支持搜索、最近使用，以及 /models、/m 和 Alt+M 快捷入口。',
  'magpie.ts': '为 codemode 注册 Magpie 的分类器与图像模型；文件由 Magpie 自动维护，改动首行会让它不再覆盖。',
};
const knownPackages = {
  '@narumitw/pi-sync': '通过 Git、WebDAV、Cloudflare R2 或兼容 S3 的存储，在多台设备间同步选定的 Pi 配置与内容，支持快照、差异比较与恢复。',
  '@tt-a1i/openpi': 'Pi 原生的多 Agent 工作台：隔离上下文的子 Agent、可安全重放的工作流、可观察运行过程的 TUI。',
};
const HAN = /[\u4e00-\u9fff]/;
// Untranslated upstream text is labelled instead of being silently shown as if it were ours.
const localize = (text) => !text || HAN.test(text) ? text : `原文未翻译：${text}`;
const openpi = {
  'ai-providers': '通过 OAuth 接入 Cursor 和 Google Antigravity 模型，登录并选中后使用。',
  'ask-user': '让 Agent 用结构化问题收集你的选择，或等待需要你亲自完成的操作。',
  'bash-timeout': '为非交互运行中未指定超时的 Bash 命令设置 120 秒上限，避免命令一直挂起；交互会话保持原生行为。',
  browser: '在授权后读取和操作浏览器页面，支持查看页面、截图、点击和输入。',
  'clear-context': '会话空闲且输入框为空时，按 Ctrl+C 新建会话，清空当前对话上下文。',
  'code-mode': '按 OpenPI 配置启用 Pi 内置 Code Mode，便于用脚本组合工具调用。',
  'codemode-display': '精简 Code Mode 的工具执行展示，突出子调用状态，并可展开完整脚本和结果。',
  'copy-all': '用 /copy-all 将当前会话分支的用户消息和助手回复复制到剪贴板。',
  cron: '在当前会话安排一次性或重复提示，空闲时触发；退出会话后定时任务不再保留。',
  'file-mutation-display': '把文件读写、编辑、搜索和 Bash 等工具活动压缩成简洁摘要，可展开完整结果。',
  'git-info': '收集 Git 分支和工作区状态，提供文件差异浏览与当前分支 PR 信息查询。',
  'git-read': '提供只读 Git 差异、提交和日志检查，查看差异时禁用外部 diff 与 textconv。',
  'image-paste': '改善图片粘贴与附件展示，把临时图片路径显示为简洁占位，方便管理输入中的图片。',
  'model-info': '跟踪当前模型、上下文占用、用量和生成速度，为状态栏提供实时数据。',
  'plan-mode': '提供只读调研与规划模式，先形成实施计划，再由你决定是否开始修改。',
  'post-edit': '交互 TUI 中有成功 Write/Edit 操作的轮次结束后，在后台运行你配置的一条命令，例如格式化或检查；默认关闭。',
  sessions: '搜索、预览当前项目的历史会话，并通过 Pi 的会话切换流程继续对话。',
  setup: '通过 /openpi-setup 用自然语言查看和调整 OpenPI 功能、模型及界面配置。',
  subagents: '把独立任务交给具有单独上下文的子 Agent，支持并行执行、查看进度和取消。',
  suggestions: '在任务结束后提供可选的下一步输入建议，按右方向键填入；默认关闭。',
  'turn-time': '在回复下方显示本次请求耗时，包括重试和自动继续的时间。',
  'ui-customization': '定制终端标题和底部状态栏，展示模型、上下文、Git 状态与当前目录。',
  usage: '用 /usage 查询 Codex、Cursor 和 Antigravity 的订阅额度与重置时间。',
  'user-input-fold': '折叠终端里过长的用户消息和粘贴内容；模型仍会收到完整原文。',
  web: '提供 OpenPI 网页工作台入口，在浏览器中管理对话、工作区和任务。',
  'web-search': '启用当前模型支持的供应商原生联网搜索，并保留搜索结果和引用；默认关闭。',
  'windows-terminal-compat': '处理 Windows 终端内容收缩时的残影和重绘问题。',
  workflows: '编排多阶段、并行的子 Agent 工作流，查看运行状态、结果与产物。',
};

function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(16 * 1024);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
  } catch { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function brief(text) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
}

function manifestField(root, field) {
  if (!root) return '';
  try {
    const manifest = JSON.parse(readHead(path.join(root, 'package.json')));
    return typeof manifest[field] === 'string' ? manifest[field] : '';
  } catch { return ''; }
}

const manifestDescription = (root) => brief(manifestField(root, 'description'));

export function packageDescription(pkg) {
  const name = manifestField(pkg.installedPath, 'name');
  return knownPackages[name] ? knownPackages[name] : localize(manifestDescription(pkg.installedPath));
}

function documentedDescription(file) {
  const root = path.dirname(file);
  // The shared extensions/ directory's README describes the collection, not each loose file.
  if (path.basename(root) !== 'extensions') {
    const description = manifestDescription(root);
    if (description) return description;
    for (const name of ['README.zh-CN.md', 'README.md', 'readme.md']) {
      const text = readHead(path.join(root, name)).replace(/```[^\n]*\n[\s\S]*?(?:\n```|$)/g, '');
      const paragraph = text.split(/\r?\n\s*\r?\n/).find((block) => {
        const value = block.trim();
        return value && !/^[#<!>|\[\-*`]/.test(value) && !/^\s*\d+[.)]\s/.test(value);
      });
      if (paragraph) return brief(paragraph.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, ''));
    }
  }
  const comment = /^\s*(?:#![^\n]*\n\s*)?\/\*\*([\s\S]*?)\*\//.exec(readHead(file));
  if (!comment || /@license|copyright|SPDX-License-Identifier/i.test(comment[1])) return '';
  return brief(comment[1].split(/\r?\n/).map((line) => line.replace(/^\s*\* ?/, '').trim()).filter((line) => !line.startsWith('@')).join(' '));
}

export function resourceDescription(resource, agentDir) {
  if (builtins[resource.path]) return builtins[resource.path];
  if (resource.metadata.origin !== 'package') {
    const relative = path.relative(path.join(agentDir, 'extensions'), resource.path).split(path.sep).join('/').toLowerCase();
    if (local[relative]) return local[relative];
  }
  if (/^(?:git:github\.com\/|https:\/\/github\.com\/)openpi-dev\/openpi(?:\.git)?(?:@[^\s]+)?$/.test(resource.metadata.source)) {
    const relative = path.relative(resource.metadata.packageRoot ?? resource.metadata.baseDir ?? '', resource.path).split(path.sep).join('/');
    const match = /^extensions\/([^/]+)\/index\.[jt]s$/.exec(relative);
    if (match && openpi[match[1]]) return openpi[match[1]];
  }
  const documented = documentedDescription(resource.path);
  if (documented) return localize(documented);
  const description = packageDescription({ installedPath: resource.metadata.packageRoot });
  return description ? `所属包说明：${description}` : '暂无功能说明。';
}
