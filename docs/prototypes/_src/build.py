# Generates A.html / B.html / C.html (each self-contained, inline CSS, minimal JS).
# Screen is chosen by URL hash: #read (default), #ask, #index
import pathlib
OUT = pathlib.Path(__file__).resolve().parent.parent

SERIF = '"Source Han Serif SC","Noto Serif SC","Noto Serif CJK SC","Songti SC","STSong","SimSun",serif'
SERIF_TC = '"Source Han Serif TC","Noto Serif TC","Noto Serif CJK TC","Songti TC","PMingLiU",serif'
SANS = '-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Noto Sans CJK SC",sans-serif'
MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace'

BASE_CSS = r"""
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1440px;height:900px;overflow:hidden}
body{font-family:var(--ui);color:var(--ink);background:var(--bg);font-size:13px;-webkit-font-smoothing:antialiased}
.win{display:flex;flex-direction:column;height:900px}
.titlebar{height:38px;display:flex;align-items:center;padding:0 14px;gap:14px;border-bottom:1px solid var(--line);background:var(--chrome);flex:none}
.lights{display:flex;gap:8px}.lights i{width:12px;height:12px;border-radius:50%;display:block;background:var(--light)}
.titlebar .ttl{flex:1;text-align:center;color:var(--muted);font-size:12.5px;letter-spacing:.04em}
.titlebar .ttl b{color:var(--ink2);font-weight:600}
.tb-right{display:flex;gap:10px;color:var(--muted);font-size:12px}
.main{flex:1;display:flex;min-height:0}
/* sidebar */
.side{width:264px;flex:none;border-right:1px solid var(--line);background:var(--side);display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:10px;padding:16px 16px 12px}
.logo{width:30px;height:30px;display:grid;place-items:center;font-family:var(--serif);font-size:17px;font-weight:700;color:var(--onacc);background:var(--acc);border-radius:var(--logo-r)}
.brand .nm{font-family:var(--brandfont);font-size:16px;font-weight:600;letter-spacing:.08em;color:var(--ink)}
.brand .lib{font-size:11px;color:var(--muted);margin-top:1px}
.search{margin:4px 14px 8px;display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:1px solid var(--line2);border-radius:var(--r);background:var(--field);color:var(--muted);font-size:12.5px}
.search .k{margin-left:auto;font-family:var(--mono);font-size:10.5px;border:1px solid var(--line2);border-radius:4px;padding:0 4px}
.chips{display:flex;gap:6px;padding:0 14px 10px}
.chip{font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--line2);color:var(--ink2);background:transparent;white-space:nowrap}
.chip.on{background:var(--accsoft);border-color:var(--accline);color:var(--acc)}
.tree{flex:1;overflow:hidden;padding:4px 8px}
.grp{font-size:11px;color:var(--muted);letter-spacing:.12em;padding:12px 8px 5px}
.it{display:flex;align-items:center;gap:7px;height:28px;padding:0 8px;border-radius:var(--r-s);color:var(--ink2);font-size:13px;white-space:nowrap;overflow:hidden}
.it .ic{width:14px;text-align:center;color:var(--muted);font-size:11px;flex:none}
.it.l2{padding-left:24px}.it.l3{padding-left:42px}
.it .ext{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--faint)}
.it.on{background:var(--sel);color:var(--ink);font-weight:500}
.it.on .ic{color:var(--acc)}
.side-foot{border-top:1px solid var(--line);padding:12px 16px 14px;font-size:11.5px;color:var(--muted)}
.bar{height:4px;border-radius:2px;background:var(--track);overflow:hidden;margin:7px 0 5px}
.bar>i{display:block;height:100%;background:var(--acc);border-radius:2px}
.ex{font-size:10px;color:var(--faint);border:1px solid var(--line2);border-radius:3px;padding:0 4px;margin-left:4px}
/* center */
.center{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--paper)}
.ctool{height:46px;flex:none;display:flex;align-items:center;gap:12px;padding:0 22px;border-bottom:1px solid var(--line)}
.crumb{color:var(--muted);font-size:12.5px;white-space:nowrap}.crumb b{color:var(--ink);font-weight:500}
.sp{flex:1}
.seg{display:inline-flex;border:1px solid var(--line2);border-radius:var(--r-s);overflow:hidden;font-size:12px}
.seg span{padding:3px 10px;color:var(--muted)}
.seg span.on{background:var(--accsoft);color:var(--acc);font-weight:500}
.seg span+span{border-left:1px solid var(--line2)}
.meta{color:var(--faint);font-size:11.5px;white-space:nowrap}
.scroll{flex:1;overflow:hidden;position:relative}
.doc{max-width:35em;margin:0 auto;padding:44px 0 80px;font-family:var(--serif);font-size:18px;line-height:1.95;color:var(--text);font-feature-settings:"palt" 0}
.doc .kicker{font-family:var(--ui);font-size:12px;color:var(--acc);letter-spacing:.2em;margin-bottom:6px}
.doc h1{font-size:30px;font-weight:700;letter-spacing:.12em;line-height:1.4;color:var(--ink)}
.doc .sub{font-family:var(--ui);font-size:12.5px;color:var(--muted);margin:8px 0 26px;letter-spacing:.04em}
.doc p{margin:0 0 .9em;text-align:justify}
.doc .n{font-family:var(--ui);font-size:11px;color:var(--faint);margin-right:.6em;vertical-align:2px}
.doc .hl{background:var(--hl);box-shadow:0 0 0 3px var(--hl);border-radius:2px}
.doc .jump{position:relative;margin-left:-18px;padding-left:15px;border-left:3px solid var(--acc)}
.doc .tc{font-family:var(--serif-tc);color:var(--ink2);border:1px solid var(--line);background:var(--tcbg);padding:14px 18px;border-radius:var(--r);margin:.4em 0 1.2em;font-size:17.5px}
.doc .tc .lab{display:block;font-family:var(--ui);font-size:11px;color:var(--muted);letter-spacing:.1em;margin-bottom:4px}
.doc .note{font-size:16px;line-height:1.85;color:var(--ink2);border-left:2px solid var(--line2);padding-left:16px;margin:.2em 0 1.2em}
.doc .note b{font-family:var(--ui);font-size:11.5px;color:var(--acc);font-weight:600;margin-right:.5em;letter-spacing:.06em}
.doc .edit{outline:1px dashed var(--accline);outline-offset:6px;border-radius:2px}
.caret{display:inline-block;width:2px;height:1.1em;background:var(--acc);vertical-align:-3px;margin-left:1px}
.anchor{border-bottom:1.5px solid var(--acc);padding-bottom:1px}
.cstatus{height:28px;flex:none;border-top:1px solid var(--line);display:flex;align-items:center;gap:16px;padding:0 22px;font-size:11.5px;color:var(--faint)}
/* right */
.right{width:388px;flex:none;border-left:1px solid var(--line);background:var(--side);display:flex;flex-direction:column}
.rtabs{height:46px;flex:none;display:flex;align-items:flex-end;gap:20px;padding:0 20px;border-bottom:1px solid var(--line)}
.rtabs span{padding-bottom:12px;font-size:13px;color:var(--muted);border-bottom:2px solid transparent;margin-bottom:-1px}
.rtabs span.on{color:var(--ink);border-color:var(--acc);font-weight:600}
.rbody{flex:1;overflow:hidden;padding:16px 18px}
.sec{font-size:11px;letter-spacing:.14em;color:var(--muted);margin:4px 2px 10px}
.ol{list-style:none;margin-bottom:22px}
.ol li{display:flex;gap:10px;padding:6px 8px;border-radius:var(--r-s);font-size:13px;color:var(--ink2)}
.ol li em{font-style:normal;font-family:var(--mono);font-size:11px;color:var(--faint);width:30px;flex:none;padding-top:1px}
.ol li.on{background:var(--sel);color:var(--ink)}
.ol li.on em{color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;margin-bottom:10px;box-shadow:var(--shadow)}
.ann .q{font-family:var(--serif);font-size:14px;color:var(--ink);border-left:2px solid var(--acc);padding-left:9px;margin-bottom:7px;line-height:1.7}
.ann .t{font-size:12.5px;line-height:1.75;color:var(--ink2)}
.ann .by{font-size:11px;color:var(--faint);margin-top:6px;display:flex;justify-content:space-between}
/* ask */
.qbox{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;box-shadow:var(--shadow)}
.qbox .lab{font-size:11px;color:var(--muted);letter-spacing:.1em;margin-bottom:5px}
.qbox .qq{font-family:var(--serif);font-size:16px;line-height:1.6;color:var(--ink);font-weight:600}
.qmeta{display:flex;align-items:center;gap:6px;margin:12px 0 10px;flex-wrap:nowrap}
.qmeta .r{margin-left:auto;font-size:11.5px;color:var(--muted);white-space:nowrap}
.res{position:relative;padding:11px 13px 9px;margin-bottom:9px}
.res .top{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.rank{font-family:var(--mono);font-size:11px;color:var(--onacc);background:var(--acc);border-radius:4px;width:18px;height:18px;display:grid;place-items:center;flex:none}
.src{font-size:12px;color:var(--ink2);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src i{font-style:normal;color:var(--faint);font-weight:400}
.score{margin-left:auto;font-size:10.5px;color:var(--muted);white-space:nowrap}
.res .txt{font-family:var(--serif);font-size:14.5px;line-height:1.8;color:var(--text)}
.res mark{background:var(--hl);color:inherit;border-radius:2px;padding:0 1px}
.res .act{display:flex;gap:14px;margin-top:6px;font-size:12px}
.res .act a{color:var(--acc);text-decoration:none;font-weight:500}
.res .act a.g{color:var(--muted);font-weight:400}
.res.cur{border-color:var(--accline);box-shadow:0 0 0 1px var(--accline),var(--shadow)}
.honest{font-size:11.5px;color:var(--muted);line-height:1.6;padding:2px 2px 0}
.ask{flex:none;border-top:1px solid var(--line);padding:12px 16px 14px}
.askin{white-space:nowrap;overflow:hidden;border:1px solid var(--line2);background:var(--field);border-radius:var(--r);padding:10px 12px;font-size:13px;color:var(--faint);display:flex;align-items:center}
.askin .send{flex:none;margin-left:auto;font-size:11.5px;color:var(--onacc);background:var(--acc);border-radius:var(--r-s);padding:3px 10px}
/* empty */
.empty{text-align:center;padding:26px 14px 10px}
.empty .glyph{width:56px;height:56px;margin:0 auto 14px;border-radius:50%;border:1.5px dashed var(--line2);display:grid;place-items:center;font-family:var(--serif);font-size:22px;color:var(--faint)}
.empty h3{font-family:var(--serif);font-size:17px;color:var(--ink);font-weight:600;margin-bottom:8px;letter-spacing:.04em}
.empty p{font-size:12.5px;color:var(--muted);line-height:1.8}
.tips{text-align:left;margin-top:16px}
.tips li{list-style:none;font-size:12.5px;color:var(--ink2);padding:8px 10px;border:1px solid var(--line);border-radius:var(--r-s);margin-bottom:6px;background:var(--card)}
.tips li b{color:var(--acc);font-weight:500}
/* index */
.idx{max-width:600px;margin:0 auto;padding:46px 0}
.idx .kicker{font-size:12px;color:var(--acc);letter-spacing:.2em;margin-bottom:8px}
.idx h1{font-family:var(--serif);font-size:28px;letter-spacing:.08em;color:var(--ink);margin-bottom:8px}
.idx .lead{font-size:13.5px;color:var(--muted);line-height:1.8;margin-bottom:24px}
.ibox{background:var(--card);border:1px solid var(--line);border-radius:calc(var(--r) + 2px);padding:22px 24px;box-shadow:var(--shadow)}
.big{display:flex;align-items:baseline;gap:10px}
.big .num{font-family:var(--numfont);font-size:40px;font-weight:600;color:var(--ink);letter-spacing:-.01em}
.big .of{font-size:14px;color:var(--muted)}
.big .pct{margin-left:auto;font-family:var(--numfont);font-size:18px;color:var(--acc);font-weight:600}
.pbar{height:8px;border-radius:4px;background:var(--track);margin:12px 0 10px;overflow:hidden}
.pbar i{display:block;height:100%;width:95%;background:var(--pfill);border-radius:4px}
.now{font-size:12px;color:var(--muted);display:flex;justify-content:space-between}
.now code{font-family:var(--mono);font-size:11.5px;color:var(--ink2)}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:20px 0 4px}
.st{border:1px solid var(--line);border-radius:var(--r-s);padding:9px 10px;font-size:12px;color:var(--muted)}
.st b{display:block;font-size:12.5px;color:var(--ink2);font-weight:500;margin-bottom:2px}
.st.done b::before{content:"✓ ";color:var(--acc)}
.st.go{border-color:var(--accline);background:var(--accsoft)}.st.go b{color:var(--acc)}
.resume{display:flex;align-items:center;gap:12px;margin-top:18px;padding:12px 14px;border-radius:var(--r-s);background:var(--tcbg);border:1px solid var(--line)}
.resume .t{font-size:13px;color:var(--ink);font-weight:500}
.resume .s{font-size:11.5px;color:var(--muted);margin-top:2px}
.btns{margin-left:auto;display:flex;gap:8px}
.btn{font-size:12.5px;padding:6px 14px;border-radius:var(--r-s);border:1px solid var(--line2);color:var(--ink2);background:var(--card);white-space:nowrap}
.btn.p{background:var(--acc);border-color:var(--acc);color:var(--onacc)}
.types{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px}
.ty{border:1px solid var(--line);border-radius:var(--r-s);padding:10px 12px;background:var(--card)}
.ty .e{font-family:var(--mono);font-size:11px;color:var(--muted)}
.ty .v{font-size:15px;color:var(--ink);font-weight:600;margin-top:2px;font-family:var(--numfont)}
.ty .v small{font-size:11px;color:var(--faint);font-weight:400;margin-left:4px;font-family:var(--ui)}
.warn{margin-top:14px;font-size:12px;color:var(--ink2);line-height:1.7;padding:10px 12px;border:1px dashed var(--line2);border-radius:var(--r-s)}
.warn b{color:var(--acc);font-weight:600}
.priv{margin-top:14px;font-size:11.5px;color:var(--faint);text-align:center}
/* cross-doc links */
.xl{color:inherit;text-decoration:none}
body.read .xl{color:var(--lk);border-bottom:var(--lkb);padding-bottom:1px;cursor:pointer}
body.read .xl.hov{background:var(--lkhov);border-radius:2px;box-shadow:0 0 0 2px var(--lkhov)}
.xlw{position:relative}
.pv{position:absolute;left:-6px;top:calc(100% + 10px);width:340px;z-index:5;display:block;font-family:var(--ui);line-height:1.6;text-align:left;
 background:var(--card);border:1px solid var(--line2);border-radius:var(--r);padding:12px 14px 10px;box-shadow:var(--pvshadow)}
body:not(.read) .pv{display:none!important}
.pv-k{display:block;font-size:11px;color:var(--muted);letter-spacing:.04em}
.pv-t{display:block;font-family:var(--serif);font-size:16px;font-weight:600;color:var(--ink);margin:3px 0 4px;letter-spacing:.06em}
.pv-b{display:block;font-family:var(--serif);font-size:13px;line-height:1.75;color:var(--ink2)}
.pv-f{display:flex;align-items:center;gap:6px;margin-top:9px;padding-top:8px;border-top:1px solid var(--line)}
.pv-tag{font-size:10.5px;color:var(--muted);border:1px solid var(--line2);border-radius:3px;padding:0 5px}
.pv-open{margin-left:auto;font-size:12px;color:var(--onacc);background:var(--acc);border-radius:var(--r-s);padding:2px 10px}
.bl{list-style:none;margin-bottom:20px}
.bl li{padding:7px 8px;border-radius:var(--r-s)}
.bl li+li{border-top:1px solid var(--line)}
.bl-h{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--ink);white-space:nowrap}
.bl-h .ic{color:var(--muted);font-size:11px}.bl-h .ext{margin-left:auto;font-size:10.5px;color:var(--faint)}
.bl-q{font-family:var(--serif);font-size:12px;color:var(--muted);margin:2px 0 0 18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bl-q b{color:var(--ink2);font-weight:500;background:var(--hl);border-radius:2px}
/* screen switching */
[data-s]{display:none}
body.read [data-s~=read],body.ask [data-s~=ask],body.index [data-s~=index]{display:revert}
body.read .flexs[data-s~=read],body.ask .flexs[data-s~=ask],body.index .flexs[data-s~=index]{display:flex}
"""

THEMES = {
"A": dict(title="宣纸 · 书卷", vars=f"""
--bg:#efe6d3;--chrome:#e9dfca;--side:#f1e9d8;--paper:#f7f1e3;--card:#fbf7ee;--field:#fbf7ee;
--ink:#1f1a14;--ink2:#3d342a;--text:#2a231b;--muted:#857660;--faint:#a99a82;
--line:#ddd0b6;--line2:#cdbd9f;--acc:#b23a24;--onacc:#fbf4e6;--accsoft:rgba(178,58,36,.09);--accline:rgba(178,58,36,.38);
--sel:rgba(120,90,50,.10);--hl:rgba(214,128,70,.22);--tcbg:#f2e9d6;--track:#e3d6bc;--pfill:linear-gradient(90deg,#c4502f,#a8321d);
--light:#d6c7aa;--lk:#2a231b;--lkb:1px dotted rgba(178,58,36,.65);--lkhov:rgba(178,58,36,.08);--pvshadow:0 10px 30px rgba(90,60,20,.16);--shadow:0 1px 0 rgba(90,60,20,.04);
--r:6px;--r-s:4px;--logo-r:3px;
--ui:{SERIF};--serif:{SERIF};--serif-tc:{SERIF_TC};--mono:{MONO};--brandfont:{SERIF};--numfont:{SERIF};""",
extra="""
body{background:#efe6d3 radial-gradient(1200px 600px at 60% 0%,rgba(255,250,235,.55),transparent 70%)}
.center{background:#f7f1e3 linear-gradient(90deg,rgba(150,120,70,.05),transparent 3%,transparent 97%,rgba(150,120,70,.05))}
.logo{box-shadow:inset 0 0 0 2px #b23a24,inset 0 0 0 3.5px #fbf4e6;font-size:16px}
.doc h1{font-weight:700}
.doc .kicker{font-family:var(--serif)}
.grp{letter-spacing:.3em}
.rank{border-radius:2px}
.rtabs span.on{color:#b23a24}
.doc .tc{background:#f2e9d6}
"""),
"B": dict(title="现代极简", vars=f"""
--bg:#f7f7f8;--chrome:#f7f7f8;--side:#f7f7f8;--paper:#ffffff;--card:#ffffff;--field:#ffffff;
--ink:#16171b;--ink2:#3c3f47;--text:#202228;--muted:#7a7f8a;--faint:#a3a7b0;
--line:#e8e8ec;--line2:#dcdde3;--acc:#4f46e5;--onacc:#ffffff;--accsoft:#eef0ff;--accline:#c7c9fb;
--sel:#ececf1;--hl:rgba(99,102,241,.16);--tcbg:#f8f8fa;--track:#ececf1;--pfill:#4f46e5;
--light:#dcdde3;--lk:#262a52;--lkb:1px solid #c9cbf5;--lkhov:#f0f1ff;--pvshadow:0 12px 32px rgba(16,24,40,.12),0 0 0 1px rgba(16,24,40,.02);--shadow:0 1px 2px rgba(16,24,40,.04);
--r:8px;--r-s:6px;--logo-r:7px;
--ui:{SANS};--serif:{SERIF};--serif-tc:{SERIF_TC};--mono:{MONO};--brandfont:{SANS};--numfont:{SANS};""",
extra="""
.titlebar{border-bottom-color:transparent}
.side{border-right-color:#ececf0}
.brand .nm{letter-spacing:.02em;font-size:15px}
.grp{letter-spacing:.06em;font-weight:500}
.doc .kicker{letter-spacing:.12em;font-weight:500}
.doc h1{letter-spacing:.08em}
.it.on{background:#fff;box-shadow:0 0 0 1px #e6e6eb,0 1px 2px rgba(0,0,0,.04)}
.rtabs span.on{border-color:#16171b}
.sec{letter-spacing:.06em;font-weight:500}
.chip.on{font-weight:500}
.idx h1{font-family:var(--ui);font-weight:600;letter-spacing:.02em}
.empty h3{font-family:var(--ui)}
"""),
"C": dict(title="夜读", vars=f"""
--bg:#121316;--chrome:#141518;--side:#17181c;--paper:#1b1c20;--card:#212227;--field:#1d1e22;
--ink:#efe7d6;--ink2:#cfc6b4;--text:#ddd4c1;--muted:#8d8677;--faint:#6a655b;
--line:#2a2b31;--line2:#383941;--acc:#d2ad62;--onacc:#1a1712;--accsoft:rgba(210,173,98,.11);--accline:rgba(210,173,98,.42);
--sel:rgba(255,240,210,.06);--hl:rgba(210,173,98,.22);--tcbg:#1f2024;--track:#2c2d33;--pfill:linear-gradient(90deg,#b8914a,#e1bf76);
--light:#3a3b42;--lk:#ead7ab;--lkb:1px dotted rgba(210,173,98,.55);--lkhov:rgba(210,173,98,.10);--pvshadow:0 14px 36px rgba(0,0,0,.5);--shadow:none;
--r:8px;--r-s:5px;--logo-r:8px;
--ui:{SANS};--serif:{SERIF};--serif-tc:{SERIF_TC};--mono:{MONO};--brandfont:{SERIF};--numfont:{SERIF};""",
extra="""
.logo{background:transparent;color:#d2ad62;box-shadow:inset 0 0 0 1px rgba(210,173,98,.55)}
.doc{color:#d9d0bd}
.doc .hl{color:#f3e7c9}
.res mark{color:#f3e7c9}
.doc h1{color:#f1e6cc;font-weight:600}
.grp{letter-spacing:.2em}
.center{background:#1b1c20 radial-gradient(900px 500px at 50% -10%,rgba(210,173,98,.05),transparent 70%)}
"""),
}

BODY = r"""
<div class="win">
 <div class="titlebar"><div class="lights"><i></i><i></i><i></i></div>
  <div class="ttl"><b>学问工作台</b> — 国学讲义资料库</div>
  <div class="tb-right"><span>⌘K 搜索</span><span>⌘J 问答</span></div></div>
 <div class="main">
  <aside class="side">
   <div class="brand"><div class="logo">学</div><div><div class="nm">学问工作台</div><div class="lib">~/文稿/国学讲义 · 360 份</div></div></div>
   <div class="search">⌕ 搜索全部资料…<span class="k">⌘K</span></div>
   <div class="chips"><span class="chip on">精确</span><span class="chip">语义</span><span class="chip">混合</span><span class="chip" style="margin-left:auto">简 / 繁</span></div>
   <div class="tree">
    <div class="grp">经 部</div>
    <div class="it"><span class="ic">▾</span>论语<span class="ext">20 篇</span></div>
    <div class="it l2"><span class="ic">▤</span>学而第一<span class="ext">md</span></div>
    <div class="it l2"><span class="ic">▤</span>八佾第三<span class="ext">md</span></div>
    <div class="it l2"><span class="ic">▤</span>里仁第四<span class="ext">md</span></div>
    <div class="it l2 on"><span class="ic">▤</span>颜渊第十二<span class="ext">docx</span></div>
    <div class="it"><span class="ic">▸</span>孟子<span class="ext">14 篇</span></div>
    <div class="it"><span class="ic">▤</span>大学 · 中庸<span class="ext">docx</span></div>
    <div class="grp">讲 义</div>
    <div class="it"><span class="ic">▤</span>第七讲　仁与礼<span class="ext">md</span></div>
    <div class="it"><span class="ic">▤</span>第八讲　君子之道<span class="ext">docx</span></div>
    <div class="it"><span class="ic">▤</span>第九讲　孝悌与家风<span class="ext">doc</span></div>
    <div class="grp">札 记</div>
    <div class="it"><span class="ic">◇</span>读书札记 2026<span class="ext">json</span></div>
    <div class="it"><span class="ic">◇</span>典故卡片<span class="ext">json</span></div>
   </div>
   <div class="side-foot">
    <div style="display:flex;justify-content:space-between"><span>知识库索引</span><span>已索引 342 / 360 份文档<span class="ex">示例</span></span></div>
    <div class="bar"><i style="width:95%"></i></div>
    <div data-s="read ask">本地运行 · 资料不上传</div><div data-s="index">正在建立中 · 可中途关闭</div>
   </div>
  </aside>

  <section class="center">
   <div class="ctool">
    <div class="crumb" data-s="read ask">经部 / 论语 / <b>颜渊第十二</b></div>
    <div class="crumb" data-s="index">设置 / <b>知识库</b></div>
    <div class="sp"></div>
    <span data-s="read ask" class="seg"><span class="on">简</span><span>繁</span></span>
    <span data-s="read ask" class="seg"><span class="on" data-s="ask">阅读</span><span data-s="read">阅读</span><span class="on" data-s="read">编辑</span><span data-s="ask">编辑</span></span>
    <span class="meta" data-s="read ask">2,418 字</span>
   </div>
   <div class="scroll">
    <article class="doc" data-s="read ask">
     <div class="kicker">论语 · 卷第六</div>
     <h1>颜渊第十二</h1>
     <div class="sub">凡二十四章 · 底本：通行本 · 讲者批注 6 处</div>
     <p class="JUMP"><span class="n">12.1</span><a class="xl" title="人物 · 颜回">颜渊</a>问仁。子曰：“<span class="HL"><span class="xlw"><a class="xl hov">克己复礼</a><span class="pv" data-s="read"><span class="pv-k">札记 · 读书札记 2026.json · 条目 14</span><span class="pv-t">克己复礼</span><span class="pv-b">出《论语·颜渊》首章。朱子训“克”为胜、“己”为身之私欲；马融训“克己”为约身。课上可两说并举，再引“非礼勿视”四目落到日用……</span><span class="pv-f"><span class="pv-tag">概念</span><span class="pv-tag">别名：克己、复礼</span><span class="pv-open">打开 ↗</span></span></span></span>为仁</span>。一日克己复礼，天下归仁焉。为仁由己，而由人乎哉？”颜渊曰：“请问其目。”子曰：“<span class="HL2">非礼勿视，非礼勿听，非礼勿言，非礼勿动。</span>”颜渊曰：“回虽不敏，请事斯语矣。”</p>
     <div class="tc" lang="zh-Hant"><span class="lab">繁體對照</span>顏淵問仁。子曰：「克己復禮為仁。一日克己復禮，天下歸仁焉。為仁由己，而由人乎哉？」顏淵曰：「請問其目。」子曰：「非禮勿視，非禮勿聽，非禮勿言，非禮勿動。」</div>
     <div class="note"><b>朱熹集注</b>仁者，本心之全德。克，胜也。己，谓身之私欲也。复，反也。礼者，天理之节文也。</div>
     <p class="EDIT"><span class="n">按</span>此章可与<a class="xl">《论语·八佾》</a>“人而不仁，如礼何”对读：<a class="xl" title="人物 · 孔子（仲尼、夫子）">夫子</a>以仁为礼之本，礼是仁的外在节文，仁是礼的内在根据，二者不可偏废。课上先问学生：“克己”克的是什么<span class="CARET"></span></p>
     <p><span class="n">12.2</span><a class="xl" title="人物 · 冉雍">仲弓</a>问仁。子曰：“出门如见大宾，使民如承大祭。己所不欲，勿施于人。在邦无怨，在家无怨。”仲弓曰：“雍虽不敏，请事斯语矣。”</p>
     <p><span class="n">12.3</span>司马牛问仁。子曰：“仁者其言也讱。”曰：“其言也讱，斯谓之仁已乎？”子曰：“为之难，言之得无讱乎？”</p>
    </article>
    <div class="idx" data-s="index">
     <div class="kicker">首 次 使 用</div>
     <h1>正在建立本地知识库</h1>
     <div class="lead">工作台正在逐篇阅读「国学讲义」文件夹，按书名、篇名、段落切分并建立关键词与语义索引。<br>完成后即可用日常语言提问，结果均为资料原文。</div>
     <div class="ibox">
      <div class="big"><span class="num">342</span><span class="of">/ 360 份文档已索引<span class="ex">示例</span></span><span class="pct">95%</span></div>
      <div class="pbar"><i></i></div>
      <div class="now"><span>正在处理：<code>讲义/第九讲 孝悌与家风.doc</code></span><span>预计剩余 约 2 分钟</span></div>
      <div class="steps">
       <div class="st done"><b>扫描文件</b>360 份</div>
       <div class="st done"><b>解析切分</b>按章节 / 段落</div>
       <div class="st go"><b>生成向量</b>进行中…</div>
       <div class="st"><b>完成</b>可以提问</div>
      </div>
      <div class="resume">
       <div><div class="t">可中途关闭，下次继续</div><div class="s">进度已自动保存 · 上次中断于 2026-10-16 22:41，已从第 287 份续建</div></div>
       <div class="btns"><span class="btn">暂停</span><span class="btn p">后台继续</span></div>
      </div>
      <div class="types">
       <div class="ty"><div class="e">.md　讲义 · 笔记</div><div class="v">178<small>/ 186</small></div></div>
       <div class="ty"><div class="e">.docx / .doc　讲稿</div><div class="v">118<small>/ 128</small></div></div>
       <div class="ty"><div class="e">.json　札记条目</div><div class="v">46<small>/ 46</small></div></div>
      </div>
      <div class="warn"><b>2 份旧版 .doc</b> 需先转换格式才能索引：《孝经讲记》《弟子规讲稿》。<span style="color:var(--acc)">一键转换 →</span></div>
     </div>
     <div class="priv">全部在本机完成，不上传任何资料 · 本地向量模型 bge-m3（示例）</div>
    </div>
   </div>
   <div class="cstatus"><span data-s="read">编辑中 · 已自动保存</span><span data-s="read">自动链接 5 处 · 每节首次出现</span><span data-s="ask">已跳转至 12.1 · 高亮匹配原文</span><span data-s="index">索引任务 · 后台运行</span><span class="sp"></span><span data-s="read ask">第 1 / 24 章</span><span>UTF-8</span></div>
  </section>

  <aside class="right">
   <div class="rtabs"><span class="RT1">大纲</span><span class="RT2">批注</span><span class="RT3">知识库问答</span></div>
   <div class="rbody" data-s="read">
    <div class="sec">本篇大纲</div>
    <ul class="ol">
     <li class="on"><em>12.1</em>颜渊问仁 · 克己复礼</li>
     <li><em>12.2</em>仲弓问仁 · 己所不欲</li>
     <li><em>12.3</em>司马牛问仁 · 其言也讱</li>
     <li><em>12.7</em>子贡问政 · 民无信不立</li>
     <li><em>12.22</em>樊迟问仁 · 爱人</li>
    </ul>
    <div class="sec">反向链接 · 提到本篇的文档　3</div>
    <ul class="bl">
     <li><div class="bl-h"><span class="ic">▤</span>第七讲　仁与礼<span class="ext">md · 3 处</span></div><div class="bl-q">……先读<b>《颜渊》首章</b>，再对读《八佾》“人而不仁”……</div></li>
     <li><div class="bl-h"><span class="ic">◇</span>读书札记 2026 · 克己复礼<span class="ext">json · 1 处</span></div><div class="bl-q">出<b>《论语·颜渊》</b>首章。朱子训“克”为胜……</div></li>
     <li><div class="bl-h"><span class="ic">▤</span>八佾第三<span class="ext">md · 1 处</span></div><div class="bl-q">3.3 讲者按：参见<b>《颜渊》12.1</b>“克己复礼为仁”。</div></li>
    </ul>
    <div class="sec">本章批注 · 1</div>
    <div class="card ann"><div class="q">克己复礼为仁</div><div class="t">第七讲重点。“克己”与“复礼”是一体两面：向内约束私欲，向外合乎礼的节文。引朱注“礼者，天理之节文也”。</div><div class="by"><span>讲者批注</span><span>10 月 12 日</span></div></div>
    
   </div>
   <div class="rbody" data-s="ask">
    <div class="qbox"><div class="lab">我的问题</div><div class="qq">孔子如何论述“仁”与“礼”的关系？</div></div>
    <div class="qmeta"><span class="chip">精确</span><span class="chip">语义</span><span class="chip on">混合</span><span class="r">找到 4 段原文 · 按相关度</span></div>
    <div class="card res cur"><div class="top"><span class="rank">1</span><span class="src">《论语》<i>·</i> 颜渊第十二 <i>· 第 1 章</i></span><span class="score">关键词 + 语义</span></div>
     <div class="txt">颜渊问仁。子曰：“<mark>克己复礼为仁</mark>。一日克己复礼，天下归仁焉。为仁由己，而由人乎哉？”</div>
     <div class="act"><a>跳转原文 ↗</a><a class="g">复制引用</a></div></div>
    <div class="card res"><div class="top"><span class="rank">2</span><span class="src">《论语》<i>·</i> 八佾第三 <i>· 第 3 章</i></span><span class="score">关键词 + 语义</span></div>
     <div class="txt">子曰：“<mark>人而不仁，如礼何</mark>？人而不仁，如乐何？”</div>
     <div class="act"><a>跳转原文 ↗</a><a class="g">复制引用</a></div></div>
    <div class="card res"><div class="top"><span class="rank">3</span><span class="src">《论语》<i>·</i> 学而第一 <i>· 第 12 章</i></span><span class="score">语义</span></div>
     <div class="txt">有子曰：“<mark>礼之用，和为贵</mark>。先王之道，斯为美，小大由之。有所不行，知和而和，不以礼节之，亦不可行也。”</div>
     <div class="act"><a>跳转原文 ↗</a><a class="g">复制引用</a></div></div>
    <div class="card res"><div class="top"><span class="rank">4</span><span class="src">《论语》<i>·</i> 八佾第三 <i>· 第 4 章</i></span><span class="score">语义</span></div>
     <div class="txt">林放问<mark>礼之本</mark>。子曰：“大哉问！礼，与其奢也，宁俭；丧，与其易也，宁戚。”</div>
     <div class="act"><a>跳转原文 ↗</a><a class="g">复制引用</a></div></div>
    <div class="honest">以上均为资料原文，未经改写。</div>
   </div>
   <div class="rbody" data-s="index">
    <div class="qbox"><div class="lab">我的问题</div><div class="qq">王阳明如何解释“知行合一”？</div></div>
    <div class="qmeta"><span class="chip">精确</span><span class="chip">语义</span><span class="chip on">混合</span><span class="r">0 段原文</span></div>
    <div class="empty">
     <div class="glyph">无</div>
     <h3>资料中没有找到相关内容</h3>
     <p>在已索引的 342 份文档里，没有与“知行合一”<br>相关的原文。工作台不会凭空编写答案。</p>
     <ul class="tips">
      <li><b>换个说法</b>　如“王守仁　知行”“传习录”</li>
      <li><b>仍有 18 份未索引</b>　索引完成后再试一次</li>
      <li><b>添加资料</b>　把《传习录》放入资料文件夹</li>
     </ul>
    </div>
   </div>
   <div class="ask"><div class="askin"><span style="overflow:hidden;text-overflow:ellipsis">用日常语言提问，如“孟子怎么讲性善”</span><span class="send">提问 ⏎</span></div></div>
  </aside>
 </div>
</div>
"""

JS = """<script>
(function(){var s=(location.hash||'#read').slice(1);if(['read','ask','index'].indexOf(s)<0)s='read';document.body.className=s;
window.addEventListener('hashchange',function(){location.reload()});})();
</script>"""

def render(key, t):
    body = BODY
    # screen-specific classes are handled by small CSS rules rather than templating
    body = (body.replace('class="JUMP"', 'class="jumpable"')
                .replace('class="HL"', 'class="hlx"').replace('class="HL2"', 'class="hlx2"')
                .replace('class="EDIT"', 'class="editable"').replace('<span class="CARET"></span>', '<span class="caret"></span>')
                .replace('class="RT1"', 'class="rt1"').replace('class="RT2"', 'class="rt2"').replace('class="RT3"', 'class="rt3"'))
    screen_css = """
body.ask .jumpable{position:relative;margin-left:-18px;padding-left:15px;border-left:3px solid var(--acc)}
body.ask .hlx{background:var(--hl);box-shadow:0 0 0 3px var(--hl);border-radius:2px}

body.read .editable{outline:1px dashed var(--accline);outline-offset:8px;border-radius:2px}
body:not(.read) .caret{display:none}
body.read .rt1,body.ask .rt3,body.index .rt3{color:var(--ink);border-color:var(--acc);font-weight:600}
"""
    html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>学问工作台 · 原型 {key}（{t['title']}）</title>
<!-- 原型 {key}：{t['title']}。屏幕切换：#read 阅读与编辑 / #ask 知识库提问 / #index 首次建索引 -->
<style>
:root{{{t['vars']}}}
{BASE_CSS}
{screen_css}
{t['extra']}
</style></head>
<body class="read">{body}{JS}</body></html>"""
    (OUT / f"{key}.html").write_text(html, encoding="utf-8")

for k, t in THEMES.items():
    render(k, t)
print("ok")
