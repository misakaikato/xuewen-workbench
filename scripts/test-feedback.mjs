// B2：反馈基础件测试（node 可跑，不依赖 DOM）——notify 订阅表的行为。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { makeTmpDir } from './tmpdirs.mjs';

// notify 是 TS 模块，先编译到临时目录再 import（不引新依赖，esbuild 已随 vite 存在）
const tmp = makeTmpDir('wb-feedback-');
const outfile = path.join(tmp, 'notify.mjs');
await build({
  entryPoints: [path.resolve('src/lib/notify.ts')],
  outfile,
  format: 'esm',
  bundle: true,
  platform: 'neutral',
  logLevel: 'silent',
});

const { notify, dismissToast, subscribeToasts } = await import(pathToFileURL(outfile).href);

let checks = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { checks++; console.log('PASS', name); }); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await test('订阅后收到当前快照，取消订阅后不再收', () => {
    const seen = [];
    const unsub = subscribeToasts((list) => seen.push(list));
    const id = notify('a');
    assert.ok(id, '应返回 id');
    unsub();
    const id2 = notify('b', { durationMs: 10 });
    assert.equal(seen.length, 2, '取消订阅后不应再推送');
    assert.equal(seen[0].length, 0, '首次订阅回调为空快照');
    assert.equal(seen[1][0].text, 'a');
    dismissToast(id);
    dismissToast(id2);
  });

  await test('同 id 更新而非堆叠', () => {
    const id1 = notify('第一次', { id: 'fixed' });
    assert.equal(id1, 'fixed');
    notify('第二次', { id: 'fixed', durationMs: 0 });
    const id2 = notify('另一条');
    let last = null;
    const unsub = subscribeToasts((list) => { last = list; });
    assert.equal(last.length, 2, 'fixed 只占一条 + id2');
    assert.equal(last[0].text, '第二次', '同 id 内容被更新');
    unsub();
    dismissToast('fixed');
    dismissToast(id2);
  });

  await test('超时自动移除', async () => {
    let last = [];
    const unsub = subscribeToasts((list) => { last = list; });
    const id = notify('闪一下', { durationMs: 40 });
    assert.equal(last.length, 1);
    await sleep(140);
    assert.equal(last.length, 0, '到期应自动移除');
    unsub();
  });

  await test('更新同 id 会重置计时', async () => {
    let last = [];
    const unsub = subscribeToasts((list) => { last = list; });
    notify('第一遍', { id: 'refresh', durationMs: 60 });
    await sleep(30);
    notify('第二遍', { id: 'refresh', durationMs: 60 });
    await sleep(50);
    assert.equal(last.length, 1, '重新 notify 后不应被第一遍的计时器移除');
    assert.equal(last[0].text, '第二遍');
    await sleep(100);
    assert.equal(last.length, 0, '第二遍计时到期后移除');
    unsub();
  });

  await test('durationMs:0 常驻，直到手动关闭', async () => {
    let last = [];
    const unsub = subscribeToasts((list) => { last = list; });
    const id = notify('常驻', { durationMs: 0, kind: 'error' });
    await sleep(150);
    assert.equal(last.length, 1, '常驻 toast 不应自动消失');
    assert.equal(last[0].kind, 'error');
    dismissToast(id);
    assert.equal(last.length, 0);
    unsub();
  });

  await test('action 与 kind 随快照传递', () => {
    let ran = 0;
    let last = [];
    const unsub = subscribeToasts((list) => { last = list; });
    const id = notify('带动作', { kind: 'success', action: { label: '查看', run: () => { ran++; } } });
    assert.equal(last[0].kind, 'success');
    assert.equal(last[0].action.label, '查看');
    last[0].action.run();
    assert.equal(ran, 1);
    dismissToast(id);
    unsub();
  });

  // ---------- Button loading（react-dom/server 静态渲染，不依赖 DOM） ----------
  const btnOut = path.join(tmp, 'btn.mjs');
  await build({
    stdin: {
      contents: [
        `import React from 'react';`,
        `import { renderToStaticMarkup } from 'react-dom/server';`,
        `import { Button } from '@/components/ui/button';`,
        `const Icon = () => React.createElement('svg', { 'data-ic': '1' });`,
        `export function renderSpanText() { return renderToStaticMarkup(React.createElement(Button, { loading: true }, React.createElement('span', null, '保存'))); }`,
        `export function renderIconText() { return renderToStaticMarkup(React.createElement(Button, { loading: true }, React.createElement(Icon, null), '保存')); }`,
        `export function renderPlainText() { return renderToStaticMarkup(React.createElement(Button, { loading: true }, '保存')); }`,
        `export function renderAsChild() { return renderToStaticMarkup(React.createElement(Button, { asChild: true, loading: true }, React.createElement('a', { href: '#' }, '保存'))); }`,
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    outfile: btnOut,
    format: 'esm',
    bundle: true,
    platform: 'node',
    jsx: 'automatic',
    alias: { '@': path.resolve('src') },
    // react-dom/server 是 CJS，ESM 产物里 require 内置模块需要 createRequire 补丁
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'silent',
  });
  const btn = await import(pathToFileURL(btnOut).href);
  const spins = (html) => (html.match(/animate-spin/g) || []).length;

  await test('Button loading：span 文字子节点不被吞，转圈只插入不替换', () => {
    const html = btn.renderSpanText();
    assert.ok(html.includes('保存'), '文字应保留：' + html);
    assert.equal(spins(html), 1, '转圈应有且只有一个');
    assert.ok(html.includes('aria-busy="true"'), '应有 aria-busy');
    assert.ok(html.includes('disabled'), '应被禁用');
  });

  await test('Button loading：组件类型前置图标被替换，文字保留', () => {
    const html = btn.renderIconText();
    assert.ok(html.includes('保存'), '文字应保留：' + html);
    assert.equal(spins(html), 1);
    assert.ok(!html.includes('data-ic'), '原前置图标应被转圈替换');
  });

  await test('Button loading：纯文字按钮插入转圈', () => {
    const html = btn.renderPlainText();
    assert.ok(html.includes('保存'), '文字应保留：' + html);
    assert.equal(spins(html), 1);
  });

  await test('Button asChild + loading：不改 children，只加 aria-busy', () => {
    const html = btn.renderAsChild();
    assert.ok(html.includes('保存'), '子元素应原样渲染：' + html);
    assert.equal(spins(html), 0, 'asChild 不应注入转圈');
    assert.ok(html.includes('aria-busy="true"'), '应有 aria-busy');
  });

  console.log('\n' + checks + ' checks passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
