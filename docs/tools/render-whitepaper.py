#!/usr/bin/env python3
"""Render the Markdown paper to PDF. Optional documentation tooling, not a protocol dependency.
Requires ReportLab and pypdf; WUJI_PDF_FONT selects an embeddable TTF with Chinese/Greek glyphs.
"""
import hashlib, io
import html
import os
from pathlib import Path
import re
import sys
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'docs/WHITEPAPER.md'
OUTPUT = Path(sys.argv[1]) if len(sys.argv)>1 else ROOT / 'docs/WHITEPAPER.pdf'
font_path = Path(os.environ.get('WUJI_PDF_FONT', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))
if not font_path.is_file():
    raise SystemExit('Set WUJI_PDF_FONT to an embeddable TrueType font with Chinese coverage.')
pdfmetrics.registerFont(TTFont('Wuji', str(font_path)))
pdfmetrics.registerFontFamily('Wuji',normal='Wuji',bold='Wuji',italic='Wuji',boldItalic='Wuji')
source = SOURCE.read_text()
pages = source.split('<!-- pagebreak -->')
# `<!-- pagebreak -->` comments start a new page; there is no fixed page count (owner decision, 2026-10-02).
ink=colors.HexColor('#182838');muted=colors.HexColor('#5C6975');accent=colors.HexColor('#906423');line=colors.HexColor('#CCD5DD')
body=ParagraphStyle('body',fontName='Wuji',fontSize=10.3,leading=16,wordWrap='CJK',textColor=ink,spaceAfter=8)
styles={
 'body':body,
 'title':ParagraphStyle('title',parent=body,fontSize=27,leading=34,spaceAfter=8),
 'h2':ParagraphStyle('h2',parent=body,fontSize=15,leading=23,spaceBefore=10,spaceAfter=9,keepWithNext=True),
 'h3':ParagraphStyle('h3',parent=body,fontSize=11,leading=17,textColor=accent,spaceBefore=7,keepWithNext=True),
 'code':ParagraphStyle('code',parent=body,fontSize=9,leading=14,spaceAfter=0),
 'cell':ParagraphStyle('cell',parent=body,fontSize=9.5,leading=14,spaceAfter=0),
 'list':ParagraphStyle('list',parent=body,leftIndent=12,firstLineIndent=-12,spaceAfter=8),
 'meta':ParagraphStyle('meta',parent=body,fontSize=8.5,leading=13,textColor=muted),
}
# This intentionally supports only the limited Markdown constructs used by WHITEPAPER.md.
def inline(s):
    s=html.escape(s,quote=True)
    s=re.sub(r'`([^`]+)`',r'<font color="#31536B">\1</font>',s)
    s=re.sub(r'\*\*([^*]+)\*\*',r'<b><font color="#101F2D">\1</font></b>',s)
    s=re.sub(r'\[([^\]]+)\]\(([^)]+)\)',r'<link href="\2" color="#31536B"><u>\1</u></link>',s)
    return s

def paragraph(s,style='body'):
    return Paragraph(inline(s),styles[style])

def render_page(text):
    result=[];lines=text.strip().splitlines();i=0
    while i<len(lines):
        row=lines[i].strip()
        if not row:i+=1;continue
        if row.startswith('```'):
            block=[];i+=1
            while i<len(lines) and not lines[i].strip().startswith('```'):
                block.append(lines[i]);i+=1
            i+=1
            p=Paragraph('<br/>'.join(html.escape(s).replace(' ','&#160;') for s in block),styles['code'])
            box=Table([[p]],colWidths=[A4[0]-88])
            box.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#F0F4F6')),('BOX',(0,0),(-1,-1),.4,line),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8)]))
            result.extend([box,Spacer(1,9)]);continue
        if row.startswith('|'):
            table=[]
            while i<len(lines) and lines[i].strip().startswith('|'):
                cells=[s.strip() for s in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?',s) for s in cells):table.append([paragraph(c,'cell') for c in cells])
                i+=1
            box=Table(table,colWidths=[104,A4[0]-192],hAlign='LEFT')
            box.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#E6EDF1')),('VALIGN',(0,0),(-1,-1),'TOP'),('LINEBELOW',(0,0),(-1,-1),.4,line),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
            result.extend([box,Spacer(1,9)]);continue
        if row.startswith('# '):result.append(paragraph(row[2:],'title'));i+=1;continue
        if row.startswith('## '):result.append(paragraph(row[3:],'h2'));i+=1;continue
        if row.startswith('### '):result.append(paragraph(row[4:],'h3'));i+=1;continue
        group=[row];i+=1
        while i<len(lines) and lines[i].strip() and not re.match(r'^(#|\||```|\d+\.)',lines[i].strip()):
            group.append(lines[i].strip());i+=1
        text=' '.join(group)
        style='list' if re.match(r'^\d+\.',row) else 'meta' if row.startswith('技术白皮书') else 'body'
        result.append(paragraph(text,style))
    return result

def make_story():
    # Built afresh for every pass: ReportLab splits and mutates flowables while laying them out.
    story=[]
    for n,page in enumerate(pages):
        if n:story.append(PageBreak())
        story.extend(render_page(page))
    return story
source_hash=hashlib.sha256(source.encode()).hexdigest()[:12]
total_pages=0
def frame(canvas,doc):
    canvas.saveState();w,h=A4
    canvas.setFillColor(muted);canvas.setFont('Wuji',8)
    canvas.drawString(44,h-27,'WUJI / 可验证的随机结算指数')
    canvas.drawRightString(w-44,h-27,'v0.2 · TESTNET RESEARCH')
    canvas.setStrokeColor(line);canvas.line(44,37,w-44,37)
    canvas.drawString(44,24,'2026-10-03 · MD SHA256 '+source_hash)
    canvas.drawRightString(w-44,24,f'{doc.page} / {total_pages}' if total_pages else f'{doc.page}')
    canvas.restoreState()
OUTPUT.parent.mkdir(parents=True,exist_ok=True)
def build(target):
    SimpleDocTemplate(target,pagesize=A4,leftMargin=44,rightMargin=44,topMargin=47,bottomMargin=50,
     title='WUJI · 无极 — 可验证的随机结算指数与公开市场基准',author='WUJI',subject='Technical whitepaper v0.2; testnet research',invariant=1).build(make_story(),onFirstPage=frame,onLaterPages=frame)
# First pass counts the pages so every footer can say "n / total"; the second writes the file.
probe=io.BytesIO();build(probe);total_pages=len(PdfReader(probe).pages)
build(str(OUTPUT))
pdf=PdfReader(OUTPUT)
# Catch broken CJK font mapping or accidentally omitted sections before announcing an artifact.
text='\n'.join(p.extract_text() for p in pdf.pages)
for term in ['无极生太极','972145','0.50165','公开基准','独立核对','R_h','Deriv']:
    if term not in text:raise SystemExit('Missing rendered text: '+term)
fonts=set()
for page in pdf.pages:
    for obj in page['/Resources']['/Font'].values():
        f=obj.get_object();descriptor=f.get('/FontDescriptor')
        if descriptor and '/FontFile2' in descriptor.get_object():fonts.add(str(f['/BaseFont']))
if not fonts:raise SystemExit('Chinese font was not embedded')
print(f'{OUTPUT}: {len(pdf.pages)} pages; embedded {len(fonts)} TrueType font subset(s); source {source_hash}')
