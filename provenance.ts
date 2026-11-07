import fs from 'node:fs';
import path from 'node:path';

function authorName(author) {
  const value = typeof author === 'string' ? author : author?.name;
  return typeof value === 'string' ? value.replace(/\s*<[^>]*>/g, '').replace(/\s*\(https?:[^)]*\)\s*$/, '').trim() : '';
}
function repositoryOwner(value) {
  const url = typeof value === 'string' ? value : value?.url;
  return typeof url === 'string' ? /(?:github\.com|gitlab\.com|bitbucket\.org)[:/]([^/\s?#]+)\//i.exec(url)?.[1] ?? '' : '';
}
function sourceName(source) {
  if (source.startsWith('npm:')) return source.slice(4).replace(/@[^/]*$/, '');
  return source.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.git(?:@.*)?$|@.*$/g, '') ?? source;
}

/** Metadata only: never imports extension code or guesses authors from filenames. */
export function createProvenanceReader() {
  const manifests = new Map();
  function manifest(root) {
    if (!root) return {};
    if (!manifests.has(root)) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        manifests.set(root, data && typeof data === 'object' && !Array.isArray(data) ? data : {});
      }
      catch { manifests.set(root, {}); }
    }
    return manifests.get(root);
  }
  function info(source, root, builtin = false) {
    if (builtin) return { group: 'Pi 内置', groupOrder: 2, credit: '来源：Pi 内置', packageName: '' };
    const data = manifest(root);
    const author = authorName(data.author);
    const owner = repositoryOwner(data.repository) || repositoryOwner(data.homepage) || repositoryOwner(source);
    const namespace = /^npm:(@[^/]+)\//.exec(source)?.[1] ?? '';
    const local = !/^(?:npm:|git:|https?:|ssh:|git@)/.test(source);
    const packageName = typeof data.name === 'string' ? data.name.replace(/^@[^/]+\//, '') : local ? '' : sourceName(source);
    if (author) return { group: author, groupOrder: 1, credit: `作者：${author}`, packageName };
    if (owner) return { group: owner, groupOrder: 1, credit: `仓库归属：${owner}`, packageName };
    if (namespace) return { group: namespace, groupOrder: 1, credit: `npm 范围：${namespace}`, packageName };
    if (local) return { group: '本地扩展（作者未标注）', groupOrder: 0, credit: '作者：未标注（本地扩展）', packageName };
    return { group: `作者未标注 · ${packageName || source}`, groupOrder: 1, credit: '作者：未标注', packageName };
  }
  return {
    package(pkg) { return info(pkg.source, pkg.installedPath); },
    resource(resource) {
      const builtin = resource.path.startsWith('builtin:');
      const leaf = path.basename(resource.path);
      const root = resource.metadata.packageRoot ?? (leaf === 'index.ts' || leaf === 'index.js' ? path.dirname(resource.path) : undefined);
      const result = info(resource.metadata.source, root, builtin);
      let name = builtin ? resource.path.slice('builtin:'.length) : /^index\.[jt]s$/.test(leaf) ? path.basename(path.dirname(resource.path)) : leaf;
      if (['dist', 'src', 'lib', 'build'].includes(name) && result.packageName) name = result.packageName;
      return { ...result, name };
    },
  };
}
