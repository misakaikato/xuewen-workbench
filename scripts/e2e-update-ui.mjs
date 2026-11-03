// 更新界面 e2e（验收 B3 + U1 + U2 + U3）：
// 伪造 /api/status 与 /api/update/* 的响应（渲染进程里包装 window.fetch，产品代码无测试分支），
// 逐状态推进更新流程，断言横幅、安装遮罩、toast 与未保存确认框。
// 用法：先 npm run build，再 ./node_modules/.bin/electron scripts/e2e-update-ui.mjs
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_UPDATE_PORT) || 7497;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = makeTmpDir('wb-update-ui-');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_MAC = process.platform === 'darwin';
let server = null;
atExit(() => server?.kill('SIGKILL'));
let win = null;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail); }
};

app.on('window-all-closed', () => {}); // 窗口销毁不退出，由脚本自己收尾
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(label, js, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await exec(js)) return;
    await pause(100);
  }
  const text = (await exec('document.body.innerText')).slice(0, 1500);
  throw new Error('等待超时：' + label + '\n页面文本：' + text);
}

// 伪造更新快照的基底（镜像 electron/updater.js 的状态机字段）
const baseUpdate = {
  enabled: true, status: 'idle', currentVersion: '0.1.7',
  info: { version: '0.2.0', releaseDate: null, notes: null },
  progress: null, error: null, phase: null, canCancel: false,
  installMode: null, installModeReason: null, lastInstall: null,
};
const downloadingSnap = {
  ...baseUpdate, status: 'downloading', canCancel: true,
  progress: { percent: 42, transferred: 44040192, total: 104857600, bytesPerSecond: 5242880, etaSeconds: 12 },
};
const availableSnap = { ...baseUpdate, status: 'available' };

// 页面侧安装：可见性覆写（show:false 窗口下轮询被暂停，需要补一次 tick）+ fetch 包装。
// __WB_UPD 是 /api/status 的唯一来源；__WB_NEXT 是动作接口的返回；__WB_CALLS 记录调用。
function pageSetupJs() {
  return `(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    window.__WB_CALLS = [];
    window.__WB_UPDATE_DELAY_MS = 0;
    window.__WB_NEXT = null;
    window.__WB_UPD = ${JSON.stringify(baseUpdate)};
    const original = window.fetch.bind(window);
    const json = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/api/status')) return json({ update: window.__WB_UPD });
      if (u.includes('/api/update/')) {
        window.__WB_CALLS.push(u);
        const d = window.__WB_UPDATE_DELAY_MS;
        if (d > 0) await new Promise((r) => setTimeout(r, d));
        if (u.includes('/api/update/install') || u.includes('/api/update/open-')) return json({ ok: true });
        return json(window.__WB_NEXT || window.__WB_UPD);
      }
      return original(url, opts);
    };
    document.dispatchEvent(new Event('visibilitychange'));
    true;
  })()`;
}

// 推进伪造状态并立即补一次轮询（dispatch 触发 usePolling 的 tick）
async function drive(patch) {
  await exec(`window.__WB_UPD = Object.assign({}, window.__WB_UPD, ${JSON.stringify(patch)}); document.dispatchEvent(new Event('visibilitychange')); true`);
}

async function clickButton(text) {
  await exec(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click(); true`);
}
const buttonJs = (text) => `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const callsInclude = (frag) => exec(`window.__WB_CALLS.some((u) => u.includes(${JSON.stringify(frag)}))`);

// B3 探针：把 useDelayedFlag 连同 React 打成 iife 注入页面，直接驱动真实 hook 的时序
async function bundleProbe() {
  const entry = path.join(tmp, 'probe.jsx');
  fs.writeFileSync(entry, `
    import React, { useEffect, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { useDelayedFlag } from ${JSON.stringify(path.join(ROOT, 'src/hooks/useDelayedFlag.ts'))};
    function Probe() {
      const [active, setActive] = useState(false);
      const shown = useDelayedFlag(active, 150);
      useEffect(() => { if (shown) window.__probeSeen = (window.__probeSeen || 0) + 1; }, [shown]);
      window.__probePulse = (ms) => { window.__probeSeen = 0; setActive(true); setTimeout(() => setActive(false), ms); };
      return shown ? React.createElement('div', { id: 'wb-probe-flag' }, '指示') : null;
    }
    const rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
    createRoot(rootEl).render(React.createElement(Probe));
  `);
  const outfile = path.join(tmp, 'probe.js');
  await build({
    entryPoints: [entry], outfile, bundle: true, format: 'iife', jsx: 'automatic',
    nodePaths: [path.join(ROOT, 'node_modules')], logLevel: 'silent',
  });
  return fs.readFileSync(outfile, 'utf8');
}

async function runB3Probe() {
  console.log('== B3. useDelayedFlag 时序 ==');
  await exec(await bundleProbe());
  await pause(200);
  // 100ms 内结束的操作：指示器从不出现
  await exec('window.__probePulse(100); true');
  let seenFast = false;
  for (let i = 0; i < 20; i++) {
    if (await exec('!!document.querySelector("#wb-probe-flag")')) seenFast = true;
    await pause(25);
  }
  check('100ms 内结束不显示指示器', !seenFast && (await exec('window.__probeSeen || 0')) === 0);
  // 400ms 的操作：指示器出现，结束后消失
  await exec('window.__probePulse(400); true');
  let seenSlow = false;
  try {
    await until('400ms 操作出现指示器', '!!document.querySelector("#wb-probe-flag")', 40);
    seenSlow = true;
  } catch { /* 下面统一记 */ }
  check('400ms 的操作显示指示器', seenSlow && (await exec('window.__probeSeen || 0')) >= 1);
  await until('指示器随操作结束消失', '!document.querySelector("#wb-probe-flag")', 40);
  console.log('  ✓ 指示器随操作结束消失');
  pass++;
}

async function runU1() {
  console.log('== U1. 状态推进：available → downloading → ready → installing ==');
  await drive({ status: 'available' });
  await until('出现「立即更新」', buttonJs('立即更新'));

  // 点击后按钮立即 loading（响应故意延迟 2000ms，loading 必须早于状态推进出现）
  await exec(`window.__WB_UPDATE_DELAY_MS = 2000; window.__WB_NEXT = ${JSON.stringify(downloadingSnap)}; true`);
  await clickButton('立即更新');
  await until(
    '点击后按钮立即 loading（aria-busy + disabled）',
    `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '立即更新' && b.getAttribute('aria-busy') === 'true' && b.disabled)`,
    15
  );
  // 响应落地前后把轮询快照对齐到 downloading，避免下一拍轮询把状态拉回
  await exec(`window.__WB_UPD = ${JSON.stringify(downloadingSnap)}; true`);
  await until('下载中显示速度与进度', `document.body.textContent.includes('MB/s') && document.body.textContent.includes('42')`);
  check('下载中显示剩余时间', await exec(`document.body.textContent.includes('约剩 12 秒')`));
  check('下载中显示已下/总量（stat-num）', await exec(`!!document.querySelector('.stat-num') && document.body.textContent.includes('42.0 / 100.0')`));
  check('下载中有进度条', await exec(`!!document.querySelector('[data-slot="progress"]')`));
  await until('下载中有「取消」', buttonJs('取消'));

  // 取消：回到 available，半截状态复位
  await exec(`window.__WB_UPDATE_DELAY_MS = 0; window.__WB_NEXT = ${JSON.stringify(availableSnap)}; window.__WB_UPD = ${JSON.stringify(availableSnap)}; true`);
  await clickButton('取消');
  await until('取消后回到「立即更新」', buttonJs('立即更新'));
  check('取消调用了 /api/update/cancel', await callsInclude('/api/update/cancel'));
  await drive({ status: 'available' });

  // ready：auto 文案
  await drive({ status: 'ready', progress: null, canCancel: false, installMode: 'auto' });
  await until('ready 出现「重启并安装」', buttonJs('重启并安装'));
  if (IS_MAC) {
    check('ready(auto) 文案（mac 不提安装进度窗口）', await exec(`document.body.textContent.includes('v0.2.0 已下载，安装完成后会自动重新打开')`));
  } else {
    check('ready(auto) 文案（Windows 提到安装进度窗口）', await exec(`document.body.textContent.includes('安装时会显示安装进度，完成后自动重新打开')`));
  }

  if (IS_MAC) {
    // ready：manual + prepare-failed 文案（原因人话 + 手动步骤）
    await drive({ installMode: 'manual', installModeReason: 'prepare-failed', error: '挂载安装包失败' });
    await until('manual(prepare-failed) 出现「打开安装包并退出」', buttonJs('打开安装包并退出'));
    check('manual(prepare-failed) 显示失败原因', await exec(`document.body.textContent.includes('自动安装没有完成：挂载安装包失败')`));
    check('manual 显示手动步骤', await exec(`document.body.textContent.includes('拖到 Applications 并选择替换')`));
    // ready：manual + 预检原因枚举的人话
    await drive({ installModeReason: 'dir-not-writable', error: null });
    await until('预检原因翻译成人话', `document.body.textContent.includes('应用所在目录没有写入权限')`);
    await drive({ installMode: 'auto', installModeReason: null, error: null });
    await until('回到「重启并安装」', buttonJs('重启并安装'));
  }

  // 点击安装 → installing 各阶段的遮罩
  await clickButton('重启并安装');
  check('点击安装调用了 /api/update/install', await callsInclude('/api/update/install'));
  const phases = [
    ['preparing', '正在打开安装包…', null],
    ['copying', '正在复制新版本… 35%', { percent: 35, transferred: 35, total: 100, bytesPerSecond: 0, etaSeconds: null }],
    ['verifying', '正在校验…', null],
    ['restarting', '即将关闭并重新打开…', null],
    ['launching-installer', '正在启动安装程序…', null],
  ];
  for (const [phase, text, progress] of phases) {
    await drive({ status: 'installing', phase, progress, error: null });
    await until('遮罩阶段文案：' + text, `document.body.textContent.includes(${JSON.stringify(text)})`);
    check(phase + ' 显示遮罩（role=alert）与标题', await exec(
      `!!document.querySelector('[role="alert"]') && document.body.textContent.includes('正在安装 v0.2.0')`));
    if (phase === 'copying') check('copying 显示进度条', await exec(`!!document.querySelector('[role="alert"] [data-slot="progress"]')`));
    if (phase === 'preparing') {
      check('安装中横幅让位（没有「重启并安装」）', !(await exec(buttonJs('重启并安装'))));
      check('遮罩底部说明（mac）', !IS_MAC || await exec(`document.body.textContent.includes('完成后会自动重新打开，请勿手动打开应用')`));
    }
  }
  await drive({ status: 'idle', phase: null, progress: null });
  await until('安装结束遮罩卸载', `!document.querySelector('[role="alert"]')`);
}

async function runU2() {
  console.log('== U2. 跨重启的安装结果提示 ==');
  await drive({ status: 'idle', lastInstall: { result: 'updated', fromVersion: '0.1.7', toVersion: '0.2.0' } });
  await until('出现「已更新到 v0.2.0」toast', `document.body.textContent.includes('已更新到 v0.2.0')`);
  check('成功 toast 带「查看更新内容」', await exec(buttonJs('查看更新内容')));
  // B3：toast 出现在右下角
  const rect = await exec(`(() => {
    const el = document.querySelector('div.fixed.bottom-4.right-4');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { right: r.right, bottom: r.bottom, w: innerWidth, h: innerHeight };
  })()`);
  check('toast 位于右下角', !!rect && Math.abs(rect.right - (rect.w - 16)) <= 4 && Math.abs(rect.bottom - (rect.h - 16)) <= 4, JSON.stringify(rect));
  await clickButton('查看更新内容');
  check('「查看更新内容」调用了 open-release', await callsInclude('/api/update/open-release'));

  // 重载后同一版本不再重复提示（sessionStorage 记录）
  await win.loadURL(BASE + '/');
  await exec(pageSetupJs());
  await drive({ status: 'idle', lastInstall: { result: 'updated', fromVersion: '0.1.7', toVersion: '0.2.0' } });
  await pause(1500);
  check('重载后不再重复提示', !(await exec(`document.body.textContent.includes('已更新到 v0.2.0')`)));

  // 失败：常驻错误 toast，带「打开安装包」
  await drive({ status: 'idle', lastInstall: { result: 'failed', fromVersion: '0.1.7', toVersion: '0.3.0', error: '系统阻止了替换应用', dmgPath: '/tmp/fake.dmg' } });
  await until('出现失败 toast', `document.body.textContent.includes('自动安装没有完成：系统阻止了替换应用')`);
  check('失败 toast 是 alert', await exec(`!!document.querySelector('[role="alert"]')`));
  check('失败 toast 带「打开安装包」', await exec(buttonJs('打开安装包')));
  await pause(9000); // 常驻：超过 error 默认 8 秒仍在
  check('失败 toast 常驻（9 秒后仍在）', await exec(`document.body.textContent.includes('自动安装没有完成：系统阻止了替换应用')`));
  await clickButton('打开安装包');
  check('「打开安装包」调用了 open-installer', await callsInclude('/api/update/open-installer'));
}

async function runU3() {
  console.log('== U3. 未保存改动时安装需确认 ==');
  await win.loadURL(BASE + '/edit/' + encodeURIComponent('编辑测试.md'));
  await exec(pageSetupJs());
  await until('编辑器就绪', `!!document.querySelector('.cm-content')`);
  await exec(`document.querySelector('.cm-content').focus(); true`);
  await win.webContents.insertText('改动二字');
  await until('编辑页进入未保存状态', `document.body.textContent.includes('未保存')`);

  await drive({ status: 'ready', installMode: 'auto' });
  await until('ready 出现「重启并安装」', buttonJs('重启并安装'));
  await clickButton('重启并安装');
  await until('出现未保存确认框', `document.body.textContent.includes('有未保存的修改，安装会关闭应用。先保存再安装？')`);
  check('确认框提供「仍然安装」', await exec(buttonJs('仍然安装')));
  await clickButton('取消');
  await until('取消后确认框关闭', `!document.body.textContent.includes('仍然安装')`);
  check('点「取消」后不调用 /api/update/install', !(await callsInclude('/api/update/install')));

  // 确认后放行：点「仍然安装」应真正调用安装
  await clickButton('重启并安装');
  await until('再次出现确认框', buttonJs('仍然安装'));
  await clickButton('仍然安装');
  await until('「仍然安装」调用了 /api/update/install', `window.__WB_CALLS.some((u) => u.includes('/api/update/install'))`);
  await drive({ status: 'idle' });
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('缺少 dist/index.html，先 npm run build');
  const corpus = path.join(tmp, 'corpus');
  fs.mkdirSync(corpus, { recursive: true });
  fs.writeFileSync(path.join(corpus, '编辑测试.md'), '# 编辑测试\n\n正文。\n');
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(PORT), WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: path.join(tmp, 'data'), WORKBENCH_STATIC_DIR: path.join(ROOT, 'dist'), WORKBENCH_RAG_EMBED: 'mock',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  let up = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(BASE + '/api/config')).ok) { up = true; break; } } catch { /* 启动中 */ }
    await pause(100);
  }
  if (!up) throw new Error('后端 15 秒内未就绪');
  const cr = await fetch(BASE + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseDir: corpus }),
  });
  if (!cr.ok) throw new Error('配置语料失败：' + (await cr.text()));

  await app.whenReady();
  win = new BrowserWindow({
    width: 1280, height: 860, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  await win.loadURL(BASE + '/');
  await exec(pageSetupJs());
  await until('应用就绪', `document.body.textContent.length > 0`);

  await runU1();
  await runB3Probe();
  await runU2();
  await runU3();
}

main().then(
  () => finish(fail ? 1 : 0),
  async (e) => { console.error(e); await finish(1); }
);

async function finish(code) {
  console.log(`结果：${pass} 通过，${fail} 失败`);
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  win?.destroy();
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(code);
}
