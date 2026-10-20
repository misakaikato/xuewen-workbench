// 固定语料 + 真实嵌入，写逐题 JSON；只读复用已安装的模型和 Python。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1];};
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wb-retrieval-quality-'));
process.env.WORKBENCH_DATA_DIR=path.join(tmp,'data');
const { RagManager }=await import('../server/rag/manager.js');
const { Indexer }=await import('../server/indexer.js');
const { EmbedService }=await import('../server/rag/embed.js');
const { fileURLToPath }=await import('node:url');
const root=fileURLToPath(new URL('..',import.meta.url));
const source=arg('model-data',path.join(os.homedir(),'.xuewen-workbench'));
const output=path.resolve(arg('output','/tmp/wb-retrieval-quality.json'));
const corpus=path.join(root,'test-data/retrieval');
const files=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const abs=path.join(dir,e.name);if(e.isDirectory()){walk(abs);continue;}const st=fs.statSync(abs),ext=path.extname(e.name),p=path.relative(corpus,abs).split(path.sep).join('/');files.push({path:p,name:e.name,ext,base:path.basename(e.name,ext),dir:path.posix.dirname(p),size:st.size,mtimeMs:st.mtimeMs});}}
walk(corpus);
const indexer=new Indexer();indexer.reset('quality',corpus);await indexer.build({files});
const lib={snapshot:{files},getText:p=>indexer.texts.get(p),whenIndexed:()=>Promise.resolve()};
const manager=new RagManager({dataDir:tmp,knowledgeDir:path.join(tmp,'knowledge'),getLib:()=>lib});
manager.embed=new EmbedService(source);
const cases=JSON.parse(fs.readFileSync(path.join(root,'scripts/retrieval-fixture-cases.json'),'utf8'));
const results=[];
try{
  await manager.build('quality',{rebuild:true});
  for(const c of cases){
    const r=await manager.search('quality',c.q,5);
    const paths=r.hits.map(h=>h.path);
    const rank=c.expect.length?paths.findIndex(p=>c.expect.includes(p))+1:0;
    const pass=c.expect.length?rank>0&&(!c.first||paths[0]===c.first):paths.length===0;
    results.push({...c,pass,rank,paths,hits:r.hits.map(h=>({path:h.path,bm25:h.bm25,cos:h.cos,score:h.score})),took:r.took});
    console.log(pass?'PASS':'FAIL',c.id,paths.join(' / '));
  }
  const report={at:new Date().toISOString(),model:manager.embed.status(),config:manager.index('quality').cfg,passed:results.filter(r=>r.pass).length,total:results.length,results};
  fs.writeFileSync(output,JSON.stringify(report,null,2));console.log('report',output,report.passed+'/'+report.total);
  process.exitCode=report.passed===report.total?0:1;
}finally{manager.embed._runtime?.dispose?.();for(const ix of manager.indices.values())ix.store?.close();fs.rmSync(tmp,{recursive:true,force:true});}
