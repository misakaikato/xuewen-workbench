from PIL import Image, ImageDraw, ImageFont
import pathlib
D=pathlib.Path(__file__).resolve().parent.parent
F="/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
f1=ImageFont.truetype(F,26,index=2); f2=ImageFont.truetype(F,20,index=2)
names={"A":"A · 宣纸 / 书卷","B":"B · 现代极简","C":"C · 夜读"}
scr=[("1-read","阅读与编辑"),("2-ask","知识库提问"),("3-index","首次建索引 · 未找到")]
W,H,G,L,T=640,400,24,240,60
sheet=Image.new("RGB",(L+3*W+4*G,T+3*H+4*G),"#f4f4f2"); d=ImageDraw.Draw(sheet)
for j,(_,lab) in enumerate(scr): d.text((L+G+j*(W+G),18),lab,font=f2,fill="#555")
for i,k in enumerate("ABC"):
    y=T+G+i*(H+G); d.text((24,y+H//2-16),names[k],font=f1,fill="#222")
    row=Image.new("RGB",(3*720+4*20,450+70),"#f4f4f2"); rd=ImageDraw.Draw(row); rd.text((20,18),names[k],font=f1,fill="#222")
    for j,(s,lab) in enumerate(scr):
        im=Image.open(D/f"{k}-{s}.png").convert("RGB")
        sheet.paste(im.resize((W,H),Image.LANCZOS),(L+G+j*(W+G),y))
        row.paste(im.resize((720,450),Image.LANCZOS),(20+j*740,60))
    row.save(D/f"{k}-overview.png")
sheet.save(D/"contact-sheet.png"); print(sheet.size)
