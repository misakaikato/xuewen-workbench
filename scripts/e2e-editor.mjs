// Electron 端到端测试：真实编辑器里的字节往返、实时预览冒烟、重命名/移动期间输入不丢、主题外观。
// 用法：npm run test:e2e（先构建 dist），或 ./node_modules/.bin/electron scripts/e2e-editor.mjs [--screenshot <png>] [--screenshot-wrap <png>]
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 7496;
const BASE = `http://127.0.0.1:${PORT}`;
const shotIdx = process.argv.indexOf('--screenshot');
const SHOT = shotIdx > -1 ? process.argv[shotIdx + 1] : null;
const shotWrapIdx = process.argv.indexOf('--screenshot-wrap');
const SHOT_WRAP = shotWrapIdx > -1 ? process.argv[shotWrapIdx + 1] : null;

app.on('window-all-closed', () => {}); // 窗口销毁不退出，由脚本自己收尾

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log('  ✓', name);
  } else {
    fail++;
    console.log('  ✗', name, detail);
  }
};

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rrggbb 亮度（WCAG 近似），用于断言深浅色
function luminance(color) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color || '');
  if (!m) return -1;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function listMd(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.md')) out.push(f);
    }
  };
  walk(dir);
  return out.sort();
}

let win = null;
let server = null;
const tmpObj = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-e2e-editor-'));
const tmpData = path.join(tmpObj, 'data');
const tmpCorpus = path.join(tmpObj, 'test-data');

const j = async (url, init) => {
  const r = await fetch(BASE + url, init);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (url, body) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (url, body) => j(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function waitApi() {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(BASE + '/api/config');
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 30000) throw new Error('服务等待超时');
    await sleep(200);
  }
}

const exec = async (js) => win.webContents.executeJavaScript(js, true);

async function waitFor(js, label, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try {
      v = await exec(js);
    } catch { /* 页面切换瞬间可失败 */ }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('等待超时: ' + label);
    await sleep(120);
  }
}

async function openEditor(rel) {
  await win.loadURL(BASE + '/edit/' + rel.split('/').map(encodeURIComponent).join('/'));
  await waitFor('!!(window.__wb && __wb.editor())', '编辑器就绪 ' + rel);
}

// 取某文档行对应的 .cm-line DOM 文本
const lineDomText = (lineNo) => `(() => {
  const v = window.__wb.editor();
  const { node } = v.domAtPos(v.state.doc.line(${lineNo}).from);
  const el = node.nodeType === 1 ? node : node.parentElement;
  return (el && (el.closest('.cm-line') || el)).textContent;
})()`;

async function main() {
  fs.cpSync(path.join(ROOT, 'test-data'), tmpCorpus, { recursive: true });
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WORKBENCH_PORT: String(PORT),
      WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_DATA_DIR: tmpData,
      WORKBENCH_STATIC_DIR: path.join(ROOT, 'dist'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
  await waitApi();
  await app.whenReady();
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // 先加载一次以设置 localStorage 测试开关（同源持久，后续页面都带着）
  await win.loadURL(BASE + '/');
  await exec("localStorage.setItem('wb:e2e','1'); true");

  // ---------- A. 真实编辑器往返字节一致 ----------
  console.log('== A. 真实编辑器往返字节一致 ==');
  for (const [ds, limit] of [['ds-fmt', Infinity], ['ds-a', Infinity], ['ds-b', Infinity], ['ds-perf', 20]]) {
    const cr = await post('/api/config', { baseDir: path.join(tmpCorpus, ds) });
    if (!cr.body.ok) throw new Error('配置 ' + ds + ' 失败: ' + JSON.stringify(cr.body));
    for (const abs of listMd(path.join(tmpCorpus, ds)).slice(0, limit)) {
      const rel = path.relative(path.join(tmpCorpus, ds), abs).split(path.sep).join('/');
      const before = sha256(abs);
      await openEditor(rel);
      const disk = (await j('/api/file?path=' + encodeURIComponent(rel))).body.content;
      const doc = await exec('window.__wb.editor().state.sliceDoc(0)');
      check(`编辑器缓冲区与文件逐字一致: ${ds}/${rel}`, doc === disk, `doc=${doc.length} disk=${(disk || '').length}`);
      await exec('window.__wb.save()');
      await sleep(60);
      check(`强制保存后字节不变: ${ds}/${rel}`, sha256(abs) === before);
    }
  }

  // ---------- B. 实时预览冒烟（rich.md） ----------
  console.log('== B. 实时预览冒烟 ==');
  await post('/api/config', { baseDir: path.join(tmpCorpus, 'ds-fmt') });
  await openEditor('rich.md');
  await exec('window.__wb.editor().dispatch({selection: {anchor: 0}})');
  await sleep(300);
  const l1 = await exec(lineDomText(1));
  check('活动标题行显示 # 源码', l1.includes('# '), JSON.stringify(l1));
  const h2Line = await exec(`(() => {
    const doc = window.__wb.editor().state.doc;
    for (let i = 1; i <= doc.lines; i++) if (doc.line(i).text.startsWith('## ')) return i;
    return 0;
  })()`);
  const l2 = await exec(lineDomText(h2Line));
  check('非活动标题行不显示 #', !l2.includes('#'), JSON.stringify(l2));
  check('表格渲染为 HTML 部件', await exec(`!!window.__wb.editor().dom.querySelector('.cm-lp-table table')`));
  check('图片部件存在', await exec(`!!window.__wb.editor().dom.querySelector('img.cm-lp-img')`));
  check('代码块行带 cm-lp-code', await exec(`!!window.__wb.editor().dom.querySelector('.cm-lp-code')`));
  check('非活动行不显示 ** 标记', !(await exec(`window.__wb.editor().dom.textContent.includes('**')`)));
  await exec(`(() => {
    const v = window.__wb.editor();
    const doc = v.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      if (doc.line(i).text.startsWith('| 表头甲')) { v.dispatch({selection: {anchor: doc.line(i).from + 2}}); return true; }
    }
    return false;
  })()`);
  await sleep(300);
  check('光标进入表格显示 | 源码', await exec(`window.__wb.editor().dom.textContent.includes('| 表头甲 |')`));

  // ---------- C. 重命名/移动期间输入不丢 + 重绑后脏状态/草稿 ----------
  console.log('== C. 重命名/移动期间输入不丢 ==');
  const crA = await post('/api/config', { baseDir: path.join(tmpCorpus, 'ds-a') });
  const dsIdA = crA.body.dsId;
  const draftKey = (p) => 'wb:draft:' + dsIdA + ':' + p;
  const srcRel = '笔记/第1章 入门.md';
  const oldAbs = path.join(tmpCorpus, 'ds-a', ...srcRel.split('/'));
  const original = fs.readFileSync(oldAbs, 'utf8');
  await openEditor(srcRel);
  await exec('window.__wb.editor().focus()');
  await exec('window.__wb.editor().dispatch({selection: {anchor: window.__wb.editor().state.doc.length}})');
  win.webContents.insertText('AAA甲'); // 立即发起重命名，不等待输入落定
  await exec(`window.__wb.entryAction({type:'rename', path: ${JSON.stringify(srcRel)}, name: '第1章 入门.md', isDir: false, newName: '改名后'})`);
  await waitFor(`window.__wb.path() === ${JSON.stringify('笔记/改名后.md')}`, '重命名跟随');
  // 重命名重绑后：输入仍要触发脏状态（reconfigure 不得丢文档变化监听）
  await exec('window.__wb.editor().focus()');
  win.webContents.insertText('BBB乙');
  await waitFor('window.__wb.isDirty() === true', '重命名后输入变脏');
  check('重命名后输入标记页面为未保存', await waitFor(`document.body.textContent.includes('未保存')`, '未保存徽标（重命名后）', 4000) === true);
  check('重命名后新路径草稿已写入（防抖后）',
    await waitFor(`!!localStorage.getItem(${JSON.stringify(draftKey('笔记/改名后.md'))})`, '草稿键（重命名后）', 5000) === true &&
    (await exec(`localStorage.getItem(${JSON.stringify(draftKey('笔记/改名后.md'))})`)).includes('BBB乙'));
  await exec(`window.__wb.entryAction({type:'move', path: ${JSON.stringify('笔记/改名后.md')}, name: '改名后.md', isDir: false, targetDir: '资料库'})`);
  await waitFor(`window.__wb.path() === ${JSON.stringify('资料库/改名后.md')}`, '移动跟随');
  // 移动重绑后：两步验证 + 最终非强制保存按钮保存
  await exec('window.__wb.editor().focus()');
  await win.webContents.insertText('CCC丙');
  await waitFor('window.__wb.isDirty() === true', '移动后输入变脏');
  check('移动后输入标记页面为未保存', await waitFor(`document.body.textContent.includes('未保存')`, '未保存徽标（移动后）', 4000) === true);
  check('移动后新路径草稿已写入（防抖后）',
    await waitFor(`!!localStorage.getItem(${JSON.stringify(draftKey('资料库/改名后.md'))})`, '草稿键（移动后）', 5000) === true);
  await exec(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().endsWith('保存'));
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  })()`);
  await waitFor('window.__wb.isDirty() === false', '保存后变干净');
  await sleep(150);
  check('保存后新路径草稿已清除', !(await exec(`!!localStorage.getItem(${JSON.stringify(draftKey('资料库/改名后.md'))})`)));
  const finalAbs = path.join(tmpCorpus, 'ds-a', '资料库', '改名后.md');
  check('旧路径已消失', !fs.existsSync(oldAbs) && !fs.existsSync(path.join(tmpCorpus, 'ds-a', '笔记', '改名后.md')));
  const finalText = fs.existsSync(finalAbs) ? fs.readFileSync(finalAbs, 'utf8') : '';
  check('最终文件包含三次输入且各恰好一次', ['AAA甲', 'BBB乙', 'CCC丙'].every((t) => finalText.split(t).length === 2), finalText.slice(-60));
  check('原内容前缀完整保留', finalText.startsWith(original));
  check('旧旁注不存在', !fs.existsSync(oldAbs + '.meta.json') && !fs.existsSync(path.join(tmpCorpus, 'ds-a', '笔记', '改名后.md.meta.json')));

  // ---------- C2. 模式切换后输入与非强制保存 ----------
  console.log('== C2. 模式切换后输入与非强制保存 ==');
  await post('/api/config', { baseDir: path.join(tmpCorpus, 'ds-fmt') });
  await openEditor('rich.md');
  const richAbs = path.join(tmpCorpus, 'ds-fmt', 'rich.md');
  const richOriginal = fs.readFileSync(richAbs, 'utf8');
  const clickModeBtn = (label) => exec(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().endsWith(${JSON.stringify(label)}));
    if (b) { b.click(); return true; }
    return false;
  })()`);
  check('切到源码模式', (await clickModeBtn('源码')) === true);
  await sleep(300);
  check('源码模式显示行号槽', await exec(`!!window.__wb.editor().dom.querySelector('.cm-lineNumbers')`));
  await exec('window.__wb.editor().focus()');
  await exec('window.__wb.editor().dispatch({selection: {anchor: window.__wb.editor().state.doc.length}})');
  await win.webContents.insertText('甲源码模式输入');
  await waitFor('window.__wb.isDirty() === true', '源码模式输入变脏');
  check('源码模式输入标记未保存', await waitFor(`document.body.textContent.includes('未保存')`, '未保存徽标（源码）', 4000) === true);
  check('保存按钮可点击并保存', (await exec(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().endsWith('保存'));
    if (b && !b.disabled) { b.click(); return true; }
    return false;
  })()`)) === true);
  await waitFor('window.__wb.isDirty() === false', '源码模式保存完成');
  check('源码模式输入经保存按钮落盘', fs.readFileSync(richAbs, 'utf8').includes('甲源码模式输入'));
  check('切回实时预览', (await clickModeBtn('实时预览')) === true);
  await sleep(300);
  check('实时预览恢复渲染（无行号槽且有表格部件）',
    !(await exec(`!!window.__wb.editor().dom.querySelector('.cm-lineNumbers')`)) &&
    (await exec(`!!window.__wb.editor().dom.querySelector('.cm-lp-table table')`)));
  await exec('window.__wb.editor().focus()');
  await exec('window.__wb.editor().dispatch({selection: {anchor: window.__wb.editor().state.doc.length}})');
  await win.webContents.insertText('乙实时模式输入');
  await waitFor('window.__wb.isDirty() === true', '实时模式输入变脏');
  await exec(`window.dispatchEvent(new KeyboardEvent('keydown', {key: 's', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true})); true`);
  await waitFor('window.__wb.isDirty() === false', 'Ctrl+S 保存完成');
  const richAfter = fs.readFileSync(richAbs, 'utf8');
  check('实时模式输入经 Ctrl+S 落盘且前缀完整', richAfter.includes('乙实时模式输入') && richAfter.startsWith(richOriginal));

  // ---------- D. 主题（C 夜读）下的编辑器外观 ----------
  console.log('== D. 主题外观 ==');
  await post('/api/config', { baseDir: path.join(tmpCorpus, 'ds-fmt') });
  await put('/api/ui-settings', { theme: 'C' });
  await openEditor('rich.md');
  // 光标移入正文段（让标题行处于非活动状态，应用 cm-lp-h1 样式）
  await exec(`(() => {
    const v = window.__wb.editor();
    const doc = v.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const t = doc.line(i).text;
      if (t.startsWith('这是')) { v.dispatch({selection: {anchor: doc.line(i).from}}); return true; }
    }
    return false;
  })()`);
  await sleep(400);
  const bg = await exec(`getComputedStyle(document.querySelector('.cm-editor')).backgroundColor`);
  check('主题 C 编辑器底色为深色（亮度 < 0.2）', luminance(bg) >= 0 && luminance(bg) < 0.2, bg);
  const hColor = await exec(`(() => {
    const el = document.querySelector('.cm-lp-h1') || document.querySelector('.cm-lp-h2') || document.querySelector('.cm-lp-h3');
    return el ? getComputedStyle(el).color : '';
  })()`);
  check('主题 C 标题文字为浅色（亮度 > 0.5）', luminance(hColor) > 0.5, hColor);
  await put('/api/ui-settings', { theme: 'A' });

  // ---------- E. 长行折行：编辑器无横向溢出，实时预览排版与阅读页一致 ----------
  console.log('== E. 长行折行与排版一致 ==');
  await post('/api/config', { baseDir: path.join(tmpCorpus, 'ds-fmt') });

  const overflowInfo = `(() => {
    const sc = document.querySelector('.cm-scroller');
    const de = document.documentElement;
    return sc ? JSON.stringify({ sw: sc.scrollWidth, cw: sc.clientWidth, dsw: de.scrollWidth, iw: window.innerWidth }) : null;
  })()`;
  const colInfoOf = (sel) => `(() => {
    const c = document.querySelector(${JSON.stringify(sel)});
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    const m = document.querySelector('main');
    const mr = m ? m.getBoundingClientRect() : null;
    return JSON.stringify({ width: r.width, fs: cs.fontSize, lh: cs.lineHeight,
      gapL: mr ? r.left - mr.left : null, gapR: mr ? mr.right - r.right : null });
  })()`;

  for (const [w, h] of [[1440, 900], [900, 700]]) {
    win.setSize(w, h);
    await sleep(300);
    for (const label of ['实时预览', '源码', '分栏']) {
      await openEditor('long-line.md');
      await exec(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().endsWith(${JSON.stringify(label)}));
        if (b) { b.click(); return true; }
        return false;
      })()`);
      await sleep(400);
      const info = JSON.parse((await exec(overflowInfo)) || 'null');
      check(`长行 ${label}@${w}x${h} 编辑器无横向溢出`, !!info && info.sw <= info.cw + 1, JSON.stringify(info));
      check(`长行 ${label}@${w}x${h} 页面无横向溢出`, !!info && info.dsw <= info.iw, JSON.stringify(info));
    }
  }

  // 实时预览与阅读页同一文档直接对比：列宽 ±40px、居中、字号与行高相等
  for (const [w, h] of [[1440, 900], [900, 700]]) {
    win.setSize(w, h);
    await sleep(300);
    await openEditor('long-line.md');
    await sleep(400);
    const live = JSON.parse((await exec(colInfoOf('.cm-content'))) || 'null');
    await win.loadURL(BASE + '/read/' + encodeURIComponent('long-line.md'));
    await waitFor('!!document.querySelector(".reader")', '阅读页就绪');
    await sleep(400);
    const read = JSON.parse((await exec(colInfoOf('.reader'))) || 'null');
    check(`live@${w} 正文列宽与阅读页一致（±40px）`, !!live && !!read && Math.abs(live.width - read.width) <= 40,
      `live=${live && live.width} read=${read && read.width}`);
    // 居中：列在其所在视区（main）内左右留白相等；阅读页带目录侧栏，不比对绝对中心
    check(`live@${w} 正文列在编辑区居中（左右留白差 ≤ 4px）`,
      !!live && live.gapL !== null && Math.abs(live.gapL - live.gapR) <= 4,
      `gapL=${live && live.gapL} gapR=${live && live.gapR}`);
    check(`live@${w} 字号与阅读页相等`, !!live && !!read && live.fs === read.fs, `live=${live && live.fs} read=${read && read.fs}`);
    check(`live@${w} 行高与阅读页相等`, !!live && !!read && live.lh === read.lh, `live=${live && live.lh} read=${read && read.lh}`);
  }
  win.setSize(1440, 900);

  // ds-perf 长文档（副本）：同样不允许横向溢出
  await post('/api/config', { baseDir: path.join(tmpCorpus, 'ds-perf') });
  await openEditor('分区00/组0/文档0000.md');
  await sleep(600);
  const perfInfo = JSON.parse((await exec(overflowInfo)) || 'null');
  check('ds-perf 文档0000 编辑器无横向溢出', !!perfInfo && perfInfo.sw <= perfInfo.cw + 1, JSON.stringify(perfInfo));
  check('ds-perf 文档0000 页面无横向溢出', !!perfInfo && perfInfo.dsw <= perfInfo.iw, JSON.stringify(perfInfo));

  // ---------- F. 可选截图 ----------
  if (SHOT || SHOT_WRAP) {
    await post('/api/config', { baseDir: path.join(tmpCorpus, 'ds-fmt') });
    await put('/api/ui-settings', { theme: 'A' });
  }
  if (SHOT) {
    await openEditor('rich.md');
    await exec('window.__wb.editor().dispatch({selection: {anchor: 0}})');
    await sleep(800);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(SHOT, img.toPNG());
    console.log('截图已写入:', path.resolve(SHOT));
  }
  if (SHOT_WRAP) {
    win.setSize(1440, 900);
    await sleep(250);
    await openEditor('long-line.md'); // 实时预览默认模式
    await exec('window.__wb.editor().dispatch({selection: {anchor: 0}})'); // 光标置于首行标题
    await sleep(800);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(SHOT_WRAP, img.toPNG());
    console.log('折行截图已写入:', path.resolve(SHOT_WRAP));
  }
}

main()
  .catch((e) => {
    fail++;
    console.error('E2E 执行异常:', (e && e.stack) || e);
  })
  .finally(() => {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch { /* ignore */ }
    try {
      if (server && !server.killed) server.kill('SIGKILL');
    } catch { /* ignore */ }
    try {
      fs.rmSync(tmpObj, { recursive: true, force: true });
    } catch { /* ignore */ }
    console.log(`\n结果：${pass} 通过，${fail} 失败`);
    app.exit(fail ? 1 : 0);
  });
