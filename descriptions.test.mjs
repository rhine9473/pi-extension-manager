import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageDescription, resourceDescription } from './descriptions.ts';

function fixture(t) {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-manager-descriptions-'));
  const extensions = path.join(agent, 'extensions');
  fs.mkdirSync(extensions);
  t.after(() => fs.rmSync(agent, { recursive: true, force: true }));
  const resource = (file, metadata = {}) => ({ path: file, metadata: { origin: 'top-level', source: 'auto', scope: 'user', ...metadata } });
  return { agent, extensions, resource };
}

test('new loose extension reads its leading documentation without executing code or borrowing shared README', (t) => {
  const f = fixture(t); const file = path.join(f.extensions, 'device.ts');
  fs.writeFileSync(path.join(f.extensions, 'README.md'), '# 全部扩展\n\n整个扩展集合的说明。');
  fs.writeFileSync(file, '/**\n * 查询设备状态并显示温度。\n */\nthrow new Error("must never execute");');
  assert.equal(resourceDescription(f.resource(file), f.agent), '查询设备状态并显示温度。');
  fs.writeFileSync(file, 'export default () => {}');
  assert.equal(resourceDescription(f.resource(file), f.agent), '暂无功能说明。');
});

test('directory extension reads its manifest or README, skipping headings badges and command blocks', (t) => {
  const f = fixture(t); const root = path.join(f.extensions, 'device'); fs.mkdirSync(root);
  const file = path.join(root, 'index.ts'); fs.writeFileSync(file, 'throw new Error("must never execute");');
  fs.writeFileSync(path.join(root, 'README.md'), '# Device\n\n[![badge](badge.svg)](link)\n\n```sh\npi install example\n```\n\n查看 **设备状态**，支持 [温度](https://example.test) 和电压。\n\n## 安装');
  assert.equal(resourceDescription(f.resource(file), f.agent), '查看 设备状态，支持 温度 和电压。');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ description: '显示设备温度与电压。' }));
  assert.equal(resourceDescription(f.resource(file), f.agent), '显示设备温度与电压。');
  assert.equal(packageDescription({ installedPath: root }), '显示设备温度与电压。');
});

test('known OpenPI description is specific to repository and entry; other packages retain their own docs', (t) => {
  const f = fixture(t); const root = path.join(f.agent, 'package');
  const file = path.join(root, 'extensions/bash-timeout/index.ts'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '/** 另一个包自己的功能。 */\nthrow new Error("must never execute");');
  const metadata = { origin: 'package', source: 'git:github.com/openpi-dev/openpi@v1', packageRoot: root };
  assert.match(resourceDescription(f.resource(file, metadata), f.agent), /120 秒/);
  assert.equal(resourceDescription(f.resource(file, { ...metadata, source: 'git:github.com/other/tools' }), f.agent), '另一个包自己的功能。');
});

test('upstream English text is labelled as untranslated instead of posing as ours', (t) => {
  const f = fixture(t); const root = path.join(f.extensions, 'englishish'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'index.ts');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'englishish', description: 'Does the thing with widgets.' }));
  fs.writeFileSync(file, 'export default () => {}');
  assert.equal(resourceDescription(f.resource(file), f.agent), '原文未翻译：Does the thing with widgets.');
  assert.equal(packageDescription({ installedPath: root }), '原文未翻译：Does the thing with widgets.');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'englishish', description: '把小部件整理好。' }));
  assert.equal(packageDescription({ installedPath: root }), '把小部件整理好。');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@tt-a1i/openpi' }));
  assert.match(packageDescription({ installedPath: root }), /Pi 原生的多 Agent 工作台/);
});

test('missing or malformed docs fall back honestly; license headers are not function descriptions', (t) => {
  const f = fixture(t); const root = path.join(f.extensions, 'unknown'); fs.mkdirSync(root);
  const file = path.join(root, 'index.ts');
  fs.writeFileSync(file, '/** Copyright example. @license MIT */\nexport default () => {}');
  fs.writeFileSync(path.join(root, 'package.json'), '{broken');
  assert.equal(resourceDescription(f.resource(file), f.agent), '暂无功能说明。');
  assert.equal(packageDescription({ installedPath: root }), '');
  assert.equal(packageDescription({}), '');
});
