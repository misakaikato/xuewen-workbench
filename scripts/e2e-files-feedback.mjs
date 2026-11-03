// 文件操作与其余入口的反馈 e2e（验收 G7，反馈第 4 批·下）：
// - 创建副本：/api/file/duplicate 延迟 2 秒，1.5 秒后出现「正在更新索引」，完成后出现完成 toast；
// - 悬停卡片「加入屏蔽词表」失败：出现错误 toast；
// - 设置页诊断导出：进行中按钮 aria-busy；
// - 切换知识库：/api/tree 延迟期间内容区为骨架、不显示旧库数据，库名旁转圈；
// - 概览页：/api/stats 延迟期间显示骨架，不出现「暂无数据」。
// 延迟与失败在页面内包装 window.fetch 注入，不改后端。
// 用法：先 npm run build，再 ./node_modules/.bin/electron scripts/e2e-files-feedback.mjs
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmpDir, atExit } from './tmpdirs.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_FILES_PORT) || 7591;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = makeTmpDir('wb-files-fb-');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail); }
};

let server = null;
let win = null;
atExit(() => server?.kill('SIGKILL'));
app.on('window-all-closed', () => {});
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(label, js, timeoutMs = 10000) {
  const t0 = Date.now();
  for (;;) {
    if (await exec(js)) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) {
      const text = (await exec('document.body.innerText')).slice(0, 1500);
      throw new Error('等待超时：' + label + '\n页面文本：' + text);
    }
    await pause(50);
  }
}

// ---------- 夹具：两个库 ----------
const corpusA = path.join(tmp, '甲库');
const corpusB = path.join(tmp, '乙库');
fs.mkdirSync(path.join(corpusA, 'docs'), { recursive: true });
fs.mkdirSync(corpusB, { recursive: true });
fs.writeFileSync(path.join(corpusA, '甲.md'), '# 甲文\n\n不亦说乎。有朋自远方来。\n');
fs.writeFileSync(path.join(corpusA, '乙.md'), '# 乙文\n\n这里提到甲文，作为自动链接的来源。\n');
fs.writeFileSync(path.join(corpusA, 'docs', '丙.md'), '# 丙文\n\n目录里的文档。\n');
fs.writeFileSync(path.join(corpusB, '库乙文件.md'), '# 库乙文件\n\n只在乙库里。\n');

async function seedConfig() {
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.WORKBENCH_DATA_DIR = dataDir; // 先定数据目录再 import store，绝不碰用户数据目录
  const { dsIdFor } = await import(path.join(ROOT, 'server', 'store.js'));
  const idA = dsIdFor(corpusA);
  const idB = dsIdFor(corpusB);
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    version: 2,
    libraries: [
      { id: idA, baseDir: corpusA, name: '甲库', addedAt: new Date().toISOString() },
      { id: idB, baseDir: corpusB, name: '乙库', addedAt: new Date().toISOString() },
    ],
    activeId: idA,
  }));
  return { dataDir, idA, idB };
}

function spawnServer(dataDir) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', WORKBENCH_PORT: String(PORT), WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: dataDir, WORKBENCH_STATIC_DIR: path.join(ROOT, 'dist'), WORKBENCH_RAG_EMBED: 'mock',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  return proc;
}

async function waitIndexed() {
  for (let i = 0; i < 300; i++) {
    try {
      const s = await (await fetch(BASE + '/api/status')).json();
      if (s.linksReady && s.indexing?.phase == null && !s.scanning) return;
    } catch { /* 启动中 */ }
    await pause(100);
  }
  throw new Error('索引 30 秒内未就绪');
}

// ---------- 页面侧工具 ----------

// 可见性覆写（show:false 窗口下轮询会暂停）+ window.fetch 包装：
// window.__wbStub 里的规则按 URL 子串与方法匹配，可延迟、可直接返回伪造响应
function pageSetupJs() {
  return `(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    if (!window.__wbStubInstalled) {
      window.__wbStubInstalled = true;
      window.__wbStub = [];
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const method = ((init && init.method) || 'GET').toUpperCase();
        const rule = window.__wbStub.find((r) => url.includes(r.url) && (!r.method || r.method === method));
        if (rule) {
          if (rule.delayMs) await new Promise((r) => setTimeout(r, rule.delayMs));
          if (rule.respond) {
            return new Response(JSON.stringify(rule.respond.body), { status: rule.respond.status, headers: { 'Content-Type': 'application/json' } });
          }
        }
        return real(input, init);
      };
    }
    return true;
  })()`;
}
const setStub = (rules) => exec(`window.__wbStub = ${JSON.stringify(rules)}; true`);
const bodyHas = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
// 最新一条 toast 的文字 / 种类 / 是否进行中
const toastJs = (pred) => `[...document.querySelectorAll('[data-toast-kind]')].some((t) => ${pred})`;
const clickButton = (text, scope = 'document') => exec(`(() => {
  const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)}));
  if (!b) return false;
  b.click();
  return true;
})()`);

async function loadPage(url) {
  await win.loadURL(BASE + url);
  await exec(pageSetupJs());
}

// 应用内导航（不整页重载，fetch 包装保持生效）：点顶栏链接
const clickLink = (href) => exec(`(() => {
  const a = document.querySelector('header a[href=${JSON.stringify(href)}]');
  if (!a) return false;
  a.click();
  return true;
})()`);

// ---------- 场景 ----------

// 概览页：stats 延迟期间是骨架，不出现「暂无数据」；到达后显示统计
async function dashboardLoading() {
  console.log('== 概览页加载中 ==');
  await loadPage('/settings');
  await until('设置页就绪', bodyHas('外观主题'));
  await setStub([{ url: '/api/stats', method: 'GET', delayMs: 1500 }]);
  await clickLink('/');
  await until('进入概览页', bodyHas('知识库概览') + ` && !!document.querySelector('main [aria-label="加载中"]')`, 3000);
  let sawEmpty = false;
  for (let i = 0; i < 10; i++) {
    if (await exec(`document.querySelector('main').innerText.includes('暂无数据')`)) sawEmpty = true;
    await pause(100);
  }
  check('加载中显示骨架', await exec(`!!document.querySelector('main [aria-label="加载中"] .animate-pulse, main .animate-pulse')`));
  check('加载中不显示「暂无数据」', !sawEmpty);
  await until('统计到达后骨架消失', `!document.querySelector('main [aria-label="加载中"]')`, 6000);
  check('统计到达后显示文档数', await exec(`[...document.querySelectorAll('main a')].some((a) => a.textContent.includes('全部文档') && /\\d/.test(a.textContent))`));
  await setStub([]);
}

// 设置页诊断导出：进行中 aria-busy，完成后 toast 给出路径（伪造导出响应，不在磁盘生成文件、不打开 Finder）
async function diagnosticsBusy() {
  console.log('== 诊断导出忙碌态 ==');
  await clickLink('/settings');
  await until('设置页就绪', bodyHas('外观主题'));
  await clickButton('关于');
  await until('关于页出现导出按钮', `[...document.querySelectorAll('button')].some((b) => b.textContent.includes('导出诊断信息'))`);
  await setStub([{ url: '/api/diagnostics/export', method: 'POST', delayMs: 1500, respond: { status: 200, body: { ok: true, file: '/tmp/假的诊断包.zip' } } }]);
  const btn = `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('导出诊断信息'))`;
  await exec(`${btn}.click(); true`);
  await until('点击后按钮 aria-busy', `${btn}.getAttribute('aria-busy') === 'true'`, 500);
  check('导出进行中按钮 aria-busy=true 且禁用', await exec(`${btn}.getAttribute('aria-busy') === 'true' && ${btn}.disabled`));
  check('导出进行中按钮带转圈', await exec(`!!${btn}.querySelector('svg.animate-spin')`));
  await until('完成 toast 给出路径', toastJs(`t.dataset.toastKind === 'success' && t.innerText.includes('/tmp/假的诊断包.zip')`), 5000);
  check('完成后按钮恢复', await exec(`${btn}.getAttribute('aria-busy') !== 'true' && !${btn}.disabled`));
  await setStub([]);
}

// 创建副本：请求延迟 2 秒；1.5 秒前只显示进行中，1.5 秒后追加「正在更新索引」，完成后成功 toast
async function duplicateSlow() {
  console.log('== 创建副本：慢提示与完成提示 ==');
  await until('目录树出现乙.md', `!!document.querySelector('[data-tpath="乙.md"]')`);
  await setStub([{ url: '/api/file/duplicate', method: 'POST', delayMs: 2000 }]);
  await exec(`document.querySelector('[data-tpath="乙.md"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); true`);
  await until('右键菜单含「创建副本」', `[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes('创建副本'))`);
  await exec(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes('创建副本')).click(); true`);
  const t0 = Date.now();
  await until('出现进行中 toast', toastJs(`t.getAttribute('aria-busy') === 'true' && t.innerText.includes('正在创建副本')`), 1000);
  await pause(Math.max(0, 1000 - (Date.now() - t0)));
  check('1 秒时尚未出现「正在更新索引」', !(await exec(toastJs(`t.innerText.includes('正在更新索引')`))));
  await until('出现「正在更新索引」', toastJs(`t.getAttribute('aria-busy') === 'true' && t.innerText.includes('正在更新索引')`), 3000);
  const slowAt = Date.now() - t0;
  check('「正在更新索引」在约 1.5 秒后出现', slowAt >= 1400 && slowAt < 2600, `${slowAt}ms`);
  await until('完成 toast', toastJs(`t.dataset.toastKind === 'success' && t.innerText.includes('已创建副本')`), 15000);
  check('完成后不再显示进行中', !(await exec(toastJs(`t.getAttribute('aria-busy') === 'true'`))));
  await until('副本行出现', `!!document.querySelector('[data-tpath="乙 - 副本.md"]')`, 5000);
  check('副本出现在目录树', await exec(`!!document.querySelector('[data-tpath="乙 - 副本.md"]')`));
  await setStub([]);
}

// 悬停卡片「加入屏蔽词表」失败：伪造保存词表返回 500，出现错误 toast，词表未被改动
async function hoverBlocklistFails() {
  console.log('== 悬停卡片加入屏蔽词表：失败路径 ==');
  await loadPage('/read/' + encodeURIComponent('乙.md'));
  const mark = `document.querySelector('.cm-editor [data-al-term="甲文"]')`;
  await until('乙.md 中「甲文」的自动链接标记', `!!${mark}`, 15000);
  await setStub([{ url: '/api/links/blocklist', method: 'PUT', respond: { status: 500, body: { error: '模拟写入失败' } } }]);
  await exec(`(() => {
    const el = ${mark};
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return true;
  })()`);
  await until('悬停卡片出现', `!!document.querySelector('.cm-al-tip')`, 5000);
  check('悬停卡片含「加入屏蔽词表」', await clickButton('加入屏蔽词表', `document.querySelector('.cm-al-tip')`));
  await until('出现错误 toast', toastJs(`t.dataset.toastKind === 'error' && t.getAttribute('role') === 'alert' && t.innerText.includes('加入屏蔽词表失败')`), 5000);
  check('错误 toast 带后端原因', await exec(toastJs(`t.dataset.toastKind === 'error' && t.innerText.includes('模拟写入失败')`)));
  const bl = await (await fetch(BASE + '/api/links/blocklist')).json();
  check('屏蔽词表未被改动', Array.isArray(bl.terms) && !bl.terms.includes('甲文'), JSON.stringify(bl.terms));
  await setStub([]);
}

// 切换知识库：新库目录树延迟到达期间，内容区是骨架、侧栏不露旧库目录，库名旁转圈；到达后显示新库
async function switchLibrary() {
  console.log('== 切换知识库 ==');
  await loadPage('/');
  await until('甲库概览就绪', `!!document.querySelector('[data-tpath="甲.md"]') && document.querySelector('main').innerText.includes(${JSON.stringify(corpusA)})`, 10000);
  await setStub([{ url: '/api/tree', method: 'GET', delayMs: 1500 }]);
  await exec(`(() => {
    const t = document.querySelector('header button[title=${JSON.stringify(corpusA)}]');
    t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }));
    return true;
  })()`);
  await until('库菜单展开', `[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes('乙库'))`, 3000);
  await exec(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.includes('乙库')).click(); true`);
  await until('切换中骨架出现', `!!document.querySelector('main [role="status"][aria-label="加载中"]')`, 1000);
  let leaked = false;
  let spinner = false;
  for (let i = 0; i < 8; i++) {
    const st = await exec(`({
      oldTree: !!document.querySelector('[data-tpath="甲.md"]'),
      oldMain: document.querySelector('main').innerText.includes(${JSON.stringify(corpusA)}),
      spin: !!document.querySelector('header [aria-label="正在切换知识库"]'),
      skel: !!document.querySelector('main [role="status"][aria-label="加载中"]'),
    })`);
    if (st.oldTree || st.oldMain) leaked = true;
    if (st.spin) spinner = true;
    if (!st.skel) break;
    await pause(100);
  }
  check('切换期间不显示旧库的目录与概览', !leaked);
  check('切换期间库名旁转圈', spinner);
  await until('新库目录树到位', `!!document.querySelector('[data-tpath="库乙文件.md"]')`, 8000);
  await until('新库概览就绪', `document.querySelector('main').innerText.includes(${JSON.stringify(corpusB)})`, 8000);
  check('切换完成后骨架与转圈消失', await exec(`!document.querySelector('header [aria-label="正在切换知识库"]') && !document.querySelector('main [role="status"][aria-label="加载中"]')`));
  await setStub([]);
}

// ---------- 主流程 ----------

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('缺少 dist/index.html，先 npm run build');
  const { dataDir } = await seedConfig();
  server = spawnServer(dataDir);
  let up = false;
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(BASE + '/api/config')).ok) { up = true; break; } } catch { /* 启动中 */ }
    await pause(100);
  }
  if (!up) throw new Error('后端 30 秒内未就绪');
  await waitIndexed();

  await app.whenReady();
  // 计时断言依赖页面定时器：关掉后台节流，隐藏窗口里 setTimeout 不被对齐到 1 秒
  win = new BrowserWindow({
    width: 1280, height: 860, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, _lvl, msg) => {
    if (/Uncaught|TypeError|ReferenceError/.test(msg)) console.log('[renderer]', String(msg).slice(0, 300));
  });

  await dashboardLoading();
  await diagnosticsBusy();
  await duplicateSlow();
  await hoverBlocklistFails();
  await switchLibrary();
}

async function finish(code) {
  console.log(`结果：${pass} 通过，${fail} 失败`);
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => server.once('exit', resolve));
  }
  win?.destroy();
  app.exit(code);
}

main().then(
  () => finish(fail ? 1 : 0),
  async (e) => { console.error(e); fail++; await finish(1); }
);
