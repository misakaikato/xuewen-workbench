# 生成两套独立测试语料 + 一个千文件性能语料（与真实数据源隔离）
import json
import os
import random
import shutil
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
TD = os.path.join(ROOT, '..', 'test-data')

def w(path, text, encoding='utf-8'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding=encoding, newline='\n') as f:
        f.write(text)

# ---------- 数据源 A ----------
a = os.path.join(TD, 'ds-a')

w(os.path.join(a, '笔记', '第1章 入门.md'), '''---
title: 第1章 入门
tags: [基础]
---
# 第1章 入门

本章介绍基本概念，参见 概念总表.json 了解全部概念。

行内代码引用示例：`数据 表格.json` 也可以在代码外观中点击。

## 引用测试

- 普通文件名引用：第2章 进阶.md
- 集合引用：集合甲|同名文件
- 省略扩展名的集合引用：集合乙|同名文件.md
- 缺失引用：不存在的文件.md
- 代码围栏中的 概念总表.json 不应变成链接：

```text
概念总表.json 在围栏内，不解析
```

更长文件名不误命中：读书笔记索引.mdx 与 概念总表.json.bak 不算引用。

| 集合 | 文件 |
| --- | --- |
| 集合甲 | 同名文件.md |

- [x] 任务一
- [ ] 任务二

```python
print("hello")
```
''')

w(os.path.join(a, '笔记', '第2章 进阶.md'), '''# 第2章 进阶

这是进阶内容。回到 [第1章](第1章 入门.md)。

独有词：雪拥蓝关马不前。
''')

w(os.path.join(a, '笔记', '同名文件.md'), '# 同名文件（笔记目录）\n\n这是笔记目录下的版本。\n')
w(os.path.join(a, '笔记', '子目录', '第10章 总结.md'), '# 第10章 总结\n\n总结全文。\n')
w(os.path.join(a, '资料库', '同名文件.md'), '# 同名文件（资料库目录）\n\n这是资料库目录下的版本，内容不同。\n')
w(os.path.join(a, '资料库', '数据 表格.json'), json.dumps({'名称': '数据表格', '条目': [{'编号': 1, '说明': '星垂平野阔'}]}, ensure_ascii=False, indent=2))
w(os.path.join(a, '资料库', 'broken.json'), '{ "这是": 无效的JSON,,, ')
w(os.path.join(a, '资料库', '概念总表.json'), json.dumps({'概念': [{'名称': '本体', '释义': '存在的学问'}]}, ensure_ascii=False, indent=2))
w(os.path.join(a, '索引', 'index.json'), json.dumps({
    'items': [
        {'doc': '第1章 入门.md', '主题': ['基础', '入门'], '概念': ['本体', '方法']},
        {'doc': '第2章 进阶.md', '主题': ['进阶'], '概念': ['方法', '实践']},
    ]
}, ensure_ascii=False, indent=2))

# DOCX（python-docx）：标题、段落、表格、超链接
from docx import Document
doc = Document()
doc.add_heading('年度工作报告', level=1)
doc.add_paragraph('这是 DOCX 正文段落，包含独有词：月落乌啼霜满天。')
doc.add_paragraph('引用 Markdown 文件：第1章 入门.md')
t = doc.add_table(rows=2, cols=2)
t.cell(0, 0).text = '项目'
t.cell(0, 1).text = '数值'
t.cell(1, 0).text = '示例'
t.cell(1, 1).text = '42'
p = doc.add_paragraph('外部链接：')
p.add_run('示例网站').font.underline = True
os.makedirs(os.path.join(a, 'word'), exist_ok=True)
doc.save(os.path.join(a, 'word', '报告 2024.docx'))

# 真正的旧版二进制 DOC：用本机 Word COM 生成（wdFormatDocument=0）
ps = '''
$w = New-Object -ComObject Word.Application
$w.Visible = $false
$d = $w.Documents.Add()
$d.Content.Text = "旧文档标题`r`n这是二进制 DOC 正文，独有词：江枫渔火对愁眠。`r`n引用：第2章 进阶.md"
$d.SaveAs([ref]"PATH_DOC", [ref]0)
$d.Close()
$w.Quit()
'''.replace('PATH_DOC', os.path.join(a, 'word', '旧文档.doc').replace('\\', '\\\\'))
subprocess.run(['powershell', '-NoProfile', '-Command', ps], check=True)

# ---------- 数据源 B（结构完全不同，含与 A 同相对路径但内容不同的文件） ----------
b = os.path.join(TD, 'ds-b')
w(os.path.join(b, '笔记', '第1章 入门.md'), '# 数据源 B 的第1章\n\n与数据源 A 同路径但内容不同。独有词：夜半钟声到客船。\n')
w(os.path.join(b, '归档', '2024', '备忘录.md'), '# 备忘录\n\n数据源 B 的内容。\n')
w(os.path.join(b, '配置.json'), json.dumps({'站点': 'B', '开关': True}, ensure_ascii=False))

# ---------- 性能语料：约 1000 个文件 ----------
perf = os.path.join(TD, 'ds-perf')
if os.path.exists(perf):
    shutil.rmtree(perf)
random.seed(42)
WORDS = '学问本体概念方法实践知识系统结构历史思想文献研究分析综合归纳演绎推理逻辑语言符号意义解释理解'.split()
for i in range(1000):
    d = os.path.join(perf, f'分区{i % 20:02d}', f'组{i % 5}')
    body = f'# 性能测试文档 {i}\n\n' + '\n\n'.join(
        '段落' + str(j) + '：' + ''.join(random.choices(WORDS, k=30)) for j in range(6)
    )
    if i == 500:
        body += '\n\n性能测试独有词：蜡炬成灰泪始干。\n'
    w(os.path.join(d, f'文档{i:04d}.md'), body)

print('测试语料生成完成')
print('A =', os.path.abspath(a))
print('B =', os.path.abspath(b))
print('PERF =', os.path.abspath(perf))
