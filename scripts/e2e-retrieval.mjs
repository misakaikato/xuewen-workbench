// 隔离 Electron 浏览器回归；构建后运行，临时复制语料，mock 仅用于管线测试。
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-retrieval-ui-'));
const corpus = path.join(tmp, 'corpus');
fs.cpSync(path.join(root, 'test-data/retrieval'), corpus, { recursive: true });
const port = Number(process.env.E2E_RETRIEVAL_PORT) || 7493;
const base = `http://127.0.0.1:${port}`;
let server, win, passed = 0;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('window-all-closed', () => {});
const exec = (js) => win.webContents.executeJavaScript(js, true);
async function until(js) {
  for (let i = 0; i < 100; i++) { if (await exec(js)) return; await pause(60); }
  throw new Error('等待超时 ' + js);
}
const check = (name, ok, detail) => { assert.ok(ok, name + ': ' + JSON.stringify(detail)); console.log('PASS', name); passed++; };
async function api(url, body) {
  const r = await fetch(base + url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); assert.ok(r.ok, JSON.stringify(j)); return j;
}
async function open(file, query = '') {
  await win.loadURL(base + '/read/' + file.split('/').map(encodeURIComponent).join('/') + query);
  await until('!!document.querySelector("[data-wb-content-card]")');
  await pause(450);
}
async function find(text) {
  await exec(`document.querySelector('[title="文内查找 (Ctrl+F)"]').click()`);
  await until('!!document.querySelector(\'input[placeholder^="文内查找"]\')');
  await exec(`(() => { const el=document.querySelector('input[placeholder^="文内查找"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(text)});
    el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await pause(250);
}
async function main() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const paragraphs = Array.from({length:30},(_,i)=>`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Word第${i+1}章</w:t></w:r></w:p><w:p><w:r><w:t>${'正文填充。'.repeat(70)}</w:t></w:r><w:r><w:t>跨节点</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>哨兵词</w:t></w:r></w:p>`).join('');
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>');
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+paragraphs+'</w:body></w:document>');
  fs.writeFileSync(path.join(corpus,'03-类型/标题测试.docx'),await zip.generateAsync({type:'nodebuffer'}));
  server=spawn(process.execPath,[path.join(root,'server/index.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',WORKBENCH_PORT:String(port),WORKBENCH_DATA_DIR:path.join(tmp,'data'),WORKBENCH_STATIC_DIR:path.join(root,'dist'),WORKBENCH_RAG_EMBED:'mock'},stdio:'ignore'});
  let ready=false;
  for(let i=0;i<150;i++){try{await api('/api/config');ready=true;break;}catch{}await pause(100);}
  assert.ok(ready,'server ready');
  await api('/api/config',{baseDir:corpus});
  await pause(400);
  await api('/api/rag/index/build',{rebuild:true});
  for(let i=0;i<150;i++){const s=await api('/api/rag/status');if(s.index.state==='ready')break;await pause(100);}
  await app.whenReady();
  win=new BrowserWindow({width:1400,height:900,show:false,webPreferences:{sandbox:true,contextIsolation:true}});
  const errors=[];
  win.webContents.on('console-message',(event)=>{if(event.level==='error')errors.push(event.message);});
  await open('05-结构/长文档.md');
  await exec(`localStorage.setItem('wb:e2e','1')`);
  await win.reload();await pause(700);
  for(const title of ['第30章','第3章','第40章']){
    await exec(`(()=>{ const b=[...document.querySelectorAll('aside button')].find(b=>b.textContent.trim()===${JSON.stringify(title)});if(!b)throw Error('no heading');b.click();})()`);
    await pause(400);
    const state=await exec(`(()=>{const v=window.__wbr.editor(),s=document.querySelector('.wb-paper');const doc=v.state.doc;let pos=-1;for(let i=1;i<=doc.lines;i++){const l=doc.line(i);if(l.text==='## '+${JSON.stringify(title)})pos=l.from;}const c=v.coordsAtPos(pos),r=s.getBoundingClientRect();return {top:c?.top,visible:!!c&&c.top>=r.top&&c.top<r.bottom,scroll:s.scrollTop};})()`);
    check('MD目录 '+title,state.visible,state);
  }
  await open('05-结构/长文档.md','?hit='+encodeURIComponent('第二十七章的独有词：麒麟踏云。')+'&occ=0&h='+encodeURIComponent('不存在的查询'));
  await pause(400);
  const located=await exec(`(()=>{const v=window.__wbr.editor();const pos=v.state.doc.toString().indexOf('第二十七章的独有词');const c=v.coordsAtPos(pos);return !!c&&c.top>48&&c.top<850;})()`);
  check('MD纯语义结果定位',located);
  await find('麒麟踏云');
  check('MD当前命中可见高亮',await exec('!!document.querySelector(".cm-rd-find-current")'));
  await exec(`document.querySelector('input[placeholder^="文内查找"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await pause(100);
  check('关闭查找清理高亮',await exec('!document.querySelector(".cm-rd-find-current,.cm-rd-find")'));
  for(const [file,term,count] of [['03-类型/纯文本.txt','鲸落',2],['03-类型/数据表.json','靛蓝萃取',2],['03-类型/标题测试.docx','跨节点哨兵词',30]]){
    await open(file);await find(term);await pause(200);
    const state=await exec(`(()=>{const m=[...document.querySelectorAll('mark.wb-find-hl')];return {count:new Set(m.map(x=>x.dataset.findIndex)).size,visible:m.some(x=>{const r=x.getBoundingClientRect();return r.top>48&&r.bottom<900;}),sample:document.querySelector('[data-wb-content-card]')?.textContent.slice(0,500)};})()`);
    check('文内高亮 '+file,state.count===count&&state.visible,state);
    await exec(`document.querySelector('input[placeholder^="文内查找"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);await pause(100);
    check('下一个命中 '+file,await exec(`!!document.querySelector('mark.wb-find-current[data-find-index="1"]')`));
  }
  await open('03-类型/标题测试.docx');
  const toc=await exec(`(()=>{const b=[...document.querySelectorAll('aside button')].find(b=>b.textContent.trim()==='Word第25章');if(!b)return false;b.click();return true;})()`);
  await pause(200);
  const wordVisible=await exec(`(()=>{const h=[...document.querySelectorAll('[data-wb-content-card] h1')].find(h=>h.textContent==='Word第25章');if(!h)return false;const r=h.getBoundingClientRect();return r.top>48&&r.top<800;})()`);
  check('Word目录定位',toc&&wordVisible,await exec(`({toc:${JSON.stringify(toc)}, visible:${JSON.stringify(wordVisible)},headings:[...document.querySelectorAll('[data-wb-content-card] h1')].slice(23,26).map(h=>({text:h.textContent,id:h.id,top:h.getBoundingClientRect().top})), buttons:[...document.querySelectorAll('aside button')].map(b=>b.textContent.trim()).slice(-35)})`));
  const search=await api('/api/rag/search',{q:'靛蓝萃取',limit:100});
  const hit=search.hits.find(h=>h.path.endsWith('数据表.json'));assert.ok(hit);
  await open(hit.path,'?hit='+encodeURIComponent(hit.location.text)+'&occ='+hit.location.occurrence);
  check('JSON语义结果源码可定位',await exec('!!document.querySelector("[data-wb-content-card] pre")'));
  check('渲染期间无代码异常',errors.filter(e=>!e.includes('Failed to load resource')).length===0,errors);
  console.log(`${passed} browser checks passed (mock pipeline only).`);
}
main().then(()=>finish(0),e=>{console.error(e);return finish(1);});
async function finish(code){
  if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}
  win?.destroy();fs.rmSync(tmp,{recursive:true,force:true});app.exit(code);
}
