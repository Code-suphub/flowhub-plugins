#!/usr/bin/env python3
"""Capture actual browser renderings and errors. Requires playwright + Chromium.
Run: python scripts/capture.py --url http://127.0.0.1:5188 --out screenshots
"""
import argparse
import json
import base64
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

SIZES = [
    ('overview-1168', 'index.html?view=overview', 1168, 940),
    ('overview-800', 'index.html?view=overview&embedded=1', 800, 900),
    ('overview-520', 'index.html?view=overview&embedded=1', 520, 960),
    ('bluetooth-1168', 'index.html?view=bluetooth', 1168, 780),
    ('usb-1168', 'index.html?view=usb', 1168, 780),
    ('display-1168', 'index.html?view=display', 1168, 780),
    ('power-1168', 'index.html?view=power', 1168, 780),
    ('events-1168', 'index.html?view=events', 1168, 780),
    ('widget-320', 'widget-card.html', 320, 570),
]

def run():
    parser=argparse.ArgumentParser()
    parser.add_argument('--url',default='http://127.0.0.1:5188/')
    parser.add_argument('--out',default='screenshots')
    parser.add_argument('--chrome',default=None)
    parser.add_argument('--strict',action='store_true')
    parser.add_argument('--inline',action='store_true',help='Render from local sources without network requests')
    args=parser.parse_args()
    out=Path(args.out)
    out.mkdir(parents=True,exist_ok=True)
    report={'screenshots':[], 'errors':[]}
    def display(page, relative):
        if not args.inline:
            return page.goto(args.url.rstrip('/')+'/'+relative,wait_until='networkidle',timeout=30000)
        ui=Path(__file__).resolve().parent.parent/'ui'
        name,_,query=relative.partition('?')
        html=(ui/name).read_text(encoding='utf-8')
        css=(ui/'style.css').read_text(encoding='utf-8')
        js=(ui/'app.js').read_text(encoding='utf-8')
        assets={}
        for file in (ui/'assets').iterdir():
            if file.suffix not in ('.png','.webp','.svg'):continue
            mime={'.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'}[file.suffix]
            assets[file.name]='data:'+mime+';base64,'+base64.b64encode(file.read_bytes()).decode()
        js=js.replace("const node=document.getElementById('app');",
          "const assetMap="+json.dumps(assets)+";\nconst asset=(file)=>assetMap[file]||'';\nconst node=document.getElementById('app');")
        js=js.replace('assets/${key}.png', "${asset(key+'.png')}")
        js=js.replace('assets/${fallback}.svg', "${asset(fallback+'.svg')}")
        js=js.replace("assets/${imgKey(d)||'monitor'}.${imgKey(d)?'png':'svg'}", "${asset((imgKey(d)||'monitor')+'.'+(imgKey(d)?'png':'svg'))}")
        js=js.replace('location.search',json.dumps('?'+query))
        html=re.sub(r'<link rel="stylesheet" href="style.css"\s*/>',lambda m:'<style>'+css+'</style>',html)
        html=html.replace('<script src="app.js"></script>','<script>'+js+'</script>')
        return page.set_content(html,wait_until='load')
    with sync_playwright() as pw:
        options={'headless':True}
        if args.chrome: options['executable_path']=args.chrome
        browser=pw.chromium.launch(**options)
        for name,relative,width,height in SIZES:
            context=browser.new_context(viewport={'width':width,'height':height},device_scale_factor=1,locale='zh-CN',reduced_motion='reduce')
            page=context.new_page()
            errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.on('console',lambda msg:errors.append('console: '+msg.text) if msg.type=='error' else None)
            page.on('response',lambda response:errors.append('HTTP '+str(response.status)+' '+response.url) if response.status>=400 else None)
            full=args.url.rstrip('/')+'/'+relative
            display(page,relative)
            page.locator('#app .app-layout, #app .widget').first.wait_for(timeout=10000)
            page.screenshot(path=str(out/(name+'.png')),full_page=True,animations='disabled')
            record={'name':name,'path':name+'.png','viewport':[width,height],'bodyHeight':page.locator('body').evaluate('(el)=>el.scrollHeight'),'errors':errors}
            report['screenshots'].append(record)
            report['errors'] += [{'page':name,'error':x} for x in errors]
            context.close()
        context=browser.new_context(viewport={'width':1168,'height':940})
        page=context.new_page()
        display(page,'index.html')
        page.get_by_role('button',name='AirPods Pro 2').first.click()
        page.get_by_text('设备详情',exact=True).first.wait_for()
        page.screenshot(path=str(out/'device-detail.png'),full_page=True)
        report['screenshots'].append({'name':'device-detail','path':'device-detail.png','viewport':[1168,940],'errors':[]})
        # Explicit offline gallery demonstration: real remote searches never run in preview.
        display(page,'index.html?imageDemo=1')
        page.get_by_role('button',name='AirPods Pro 2').first.click()
        page.get_by_text('图片选择器 · 视觉演示',exact=False).first.wait_for()
        page.screenshot(path=str(out/'device-image-picker.png'),full_page=True,animations='disabled')
        report['screenshots'].append({'name':'device-image-picker','path':'device-image-picker.png','viewport':[1168,940],'errors':[]})
        browser.close()
    (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'captures':len(report['screenshots']),'errors':report['errors'],'output':str(out)},ensure_ascii=False))
    if args.strict and report['errors']:raise SystemExit(1)

if __name__=='__main__':run()
