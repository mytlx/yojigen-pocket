#!/usr/bin/env python3
"""端到端测试：通过 mygo 的自动化接口驱动正在运行的应用。由 tools/e2e/run.sh 启动。

按键都是在页面里派发的合成事件，不会向系统发送真实按键。"""
import base64, json, os, socket, sys, time
os.chdir(os.environ['POCKET_E2E_DIR'])
HOME = os.path.abspath('home')
os.makedirs('shots', exist_ok=True)
def call(method, params=None, timeout=20):
    s = socket.socket(socket.AF_UNIX); s.settimeout(timeout); s.connect('app.sock')
    s.sendall((json.dumps({"id":1,"method":method,"params":params or {}})+"\n").encode())
    buf=b""
    while not buf.endswith(b"\n"):
        c=s.recv(1<<20)
        if not c: break
        buf+=c
    s.close()
    r=json.loads(buf)
    if 'error' in r: raise RuntimeError(r['error'])
    return r['result']
PANEL=None
def windows(): return call('windows')['windows']
def panel_id():
    for w in windows():
        if w['url'].rstrip('/').endswith('localhost') or 'settings' not in w['url']: return w['id']
def js(code, win=None):
    p={'script':code}
    p['window']=win or panel_id()
    return call('eval',p).get('value')
def shot(name, win=None):
    r=call('capture',{'window':win or panel_id()}); open(f'shots/{name}.png','wb').write(base64.b64decode(r['png'])); return name
def wait(t=0.35): time.sleep(t)
def show():
    js('mygo.call("Settings.PreviewPanel",true)'); wait(0.4)
def visible():
    return [w for w in windows() if w['id']==panel_id()][0]['visible']
def typed(text):
    # 停在功能页或命令输出里时，再次唤出会原样回到那里（没有搜索框）；先按 Esc 回到搜索。
    for _ in range(3):
        if js('!!document.querySelector(".pk-input")'): break
        js('(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.querySelector(".pk-panel");t.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",code:"Escape",bubbles:true,cancelable:true}));return 1})()'); time.sleep(0.3)
    js('''(()=>{const i=document.querySelector(".pk-input");const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;s.call(i,%s);i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()''' % json.dumps(text)); wait()
def press(key, code=None, **mods):
    init=dict(key=key,code=code or ('Key'+key.upper() if len(key)==1 and key.isalpha() else key),bubbles=True,cancelable=True,**mods)
    js('''(()=>{const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.querySelector(".pk-panel");t.dispatchEvent(new KeyboardEvent("keydown",%s));return 1})()''' % json.dumps(init)); wait()
def rows():
    return js('[...document.querySelectorAll(".pk-row")].map(r=>r.querySelector(".pk-row-title").innerText)')
def text_of(sel):
    return (js('(document.querySelector(%s)||{}).innerText||""' % json.dumps(sel)) or '').strip()

def fill(sel, value, win=None):
    """给输入框或文本框填值，并触发 input 事件（不发真实按键）。"""
    return js('''(()=>{const el=document.querySelector(%s);if(!el)return false;const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(el,%s);el.dispatchEvent(new Event("input",{bubbles:true}));return true})()''' % (json.dumps(sel), json.dumps(value)), win)
def texts(sel, win=None):
    return js('[...document.querySelectorAll(%s)].map(e=>e.innerText.trim())' % json.dumps(sel), win) or []
def window_by(part):
    for w in windows():
        if part in w['url']:
            return w
    return None
def open_feature(keyword, wait_s=0.6):
    typed(keyword); press('Enter'); wait(wait_s)
fails=[]
def check(name, ok, detail=""):
    print(('ok  ' if ok else 'FAIL'), name, '' if ok else detail)
    if not ok: fails.append(name)

def soft(name, ok, detail=""):
    """依赖联网或本机环境的检查：不通过只提示，不算失败。"""
    print(('ok  ' if ok else 'WARN'), name, '' if ok else detail)
def click(sel, win=None):
    return js('(()=>{const el=document.querySelector(%s);if(!el)return false;el.click();return true})()' % json.dumps(sel), win)
def wait_for(expr, timeout=4.0, win=None):
    t=time.time()
    while time.time()-t<timeout:
        if js(expr, win): return True
        time.sleep(0.15)
    return False
def close_window(w):
    js('setTimeout(()=>mygo.call("Windows.Control","close",0),30);1', w['id']); wait(0.8)

show()
# --- 计算器
typed('1+2*3'); r=rows(); check('计算器', r[:1]==['7'], r)
press('Enter'); wait(0.2); check('回车后隐藏窗口', not visible())
show()
check('再次唤出时窗口可见', visible())
clip=js('mygo.call("Launcher.Config").then(()=>1)')
typed('b64 hello'); r=rows(); check('小工具：b64', r[:1]==['aGVsbG8='], r)
typed('255 to hex'); r=rows(); check('进制换算', r[:1]==['0xff'], r)
typed('10 km to mi'); r=rows(); check('单位换算', r[:1]==['6.2137119224 mi'], r)
typed('uuid'); r=rows(); check('UUID（功能页在前，结果在后）', r[0]=='UUID 与密码' and any(len(x)==36 and x.count('-')==4 for x in r), r[:2])
# --- 拼音
typed('calc'); r=rows(); check('英文找应用', 'Calculator' in r[:3] or '计算器' in r[:3], r[:5])
typed('hdjsq'); r=rows(); check('拼音首字母找系统命令（活动监视器）', '活动监视器' in r[:2], r[:5])
typed('xtxx'); r=rows(); check('拼音找脚本（系统信息）', '系统信息' in r[:2], r[:5])
typed('qksyjl'); r=rows(); check('拼音找内置命令', '清空使用记录' in r[:2], r[:5])
# --- 动作面板
typed('打开配置'); r=rows(); check('中文搜索', r[0]=='打开配置目录', r[:3])
press('k', metaKey=True); wait(0.2)
titles=js('[...document.querySelectorAll(".pk-action span:first-child")].map(x=>x.innerText)')
check('动作面板列出动作', '执行' in titles and '固定到首页' in titles and '复制标题' in titles, titles)
shot('actions')
press('Escape'); wait(0.2); check('Esc 关闭动作面板', js('!document.querySelector(".pk-actions")'))
# --- 固定
press('p', metaKey=True, shiftKey=True); wait(0.5)
typed(''); wait(0.2)
home=js('[...document.querySelectorAll(".pk-tile")].map(t=>t.querySelector(".pk-tile-title").innerText+(t.querySelector(".pk-tile-pin")?"*":""))')
check('固定到首页', '打开配置目录*' in home, home)
# --- 作用域
typed('剪贴板'); r=rows(); check('剪贴板入口', r[0]=='剪贴板历史', r[:3])
press('Tab'); wait(0.3)
check('Tab 进入作用域', text_of('.pk-scope')=='剪贴板历史', text_of('.pk-scope'))
r=rows(); check('作用域内有历史（刚才复制的 7）', '7' in r, r[:6])
shot('clipboard')
press('Escape'); wait(0.2); check('Esc 退出作用域', not js('!!document.querySelector(".pk-scope")'))
# --- 前缀
typed('cb 7'); r=rows(); check('前缀 cb', '7' in r, r[:3])
typed('> echo 你好'); r=rows(); check('命令行前缀', r[:1]==['echo 你好'], r)
press('Enter'); wait(0.8)
check('命令输出显示在文本视图', '你好' in text_of('.pk-text'), text_of('.pk-text'))
shot('shell')
press('Escape'); wait(0.2); check('Esc 返回', not js('!!document.querySelector(".pk-text")'))
# --- 脚本
typed('系统信息')
# 系统自带的应用也叫“系统信息”，而且应用排在前面：先移到脚本那一行再回车，免得把应用打开。
idx=js('[...document.querySelectorAll(".pk-row")].findIndex(r=>((r.querySelector(".pk-row-subtitle")||{}).innerText||"").includes("text 模式"))')
check('同名时应用排在脚本前面，脚本仍然搜得到', idx is not None and idx>=0, idx)
for _ in range(max(idx or 0, 0)): press('ArrowDown')
press('Enter'); wait(1.2)
out=text_of('.pk-text'); check('text 模式脚本', 'CPU' in out, out[:80]); shot('script-text')
press('Escape'); wait(0.2)
lp=os.path.join(HOME,'commands','列表测试.sh')
open(lp,'w').write('#!/bin/bash\n# @pocket.title 列表测试\n# @pocket.icon 📚\n# @pocket.mode list\nprintf "苹果\\t水果\\tcopy:apple\\n香蕉\\t水果\\tcopy:banana\\n白菜\\t蔬菜\\tcopy:cabbage\\n"\n')
os.chmod(lp,0o755); wait(0.6)
typed('列表测试'); press('Enter'); wait(0.8)
check('list 模式进入作用域', '列表测试' in text_of('.pk-scope'), text_of('.pk-scope'))
r=rows(); check('list 模式列出结果', r==['苹果','香蕉','白菜'], r)
typed('xj'); r=rows(); check('list 模式拼音过滤', r==['香蕉'], r)
shot('script-list')
press('Escape'); press('Escape'); wait(0.2); os.remove(lp); wait(0.4)
typed('进程查询'); press('Enter'); wait(0.9)
r=rows(); check('filter 模式首屏', len(r)>0, r)
typed('launchd'); wait(0.7); r=rows(); check('filter 模式随输入重跑', r[:1]==['launchd'], r[:3])
press('Escape'); press('Escape'); wait(0.2)
# --- 热重载
p=os.path.join(HOME,'commands','热重载测试.sh')
open(p,'w').write('#!/bin/bash\n# @pocket.title 热重载测试\n# @pocket.mode detail\necho "# 标题"\necho "**粗体** 和 \\`代码\\`"\n')
os.chmod(p,0o755); t=time.time(); ok=False
while time.time()-t<1.5:
    typed('热重载测试')
    if rows()[:1]==['热重载测试']: ok=True; break
check(f'新脚本 {time.time()-t:.2f}s 内可搜到', ok)
press('Enter'); wait(1.0)
html=js('(document.querySelector(".pk-markdown")||{}).innerHTML||""')
check('detail 模式渲染 Markdown', '<h1>' in html and '<strong>' in html and '<code>' in html, html)
shot('script-detail')
press('Escape'); wait(0.2); os.remove(p)
# --- 表单参数
p=os.path.join(HOME,'commands','参数测试.sh')
open(p,'w').write('#!/bin/bash\n# @pocket.title 参数测试\n# @pocket.keywords cs\n# @pocket.mode text\n# @pocket.arg1 {"name":"名字","placeholder":"输入名字"}\n# @pocket.arg2 {"name":"语气","type":"dropdown","options":["开心","平静"],"optional":true}\necho "$1/$2"\n')
os.chmod(p,0o755); wait(0.6)
typed('参数测试'); press('Enter'); wait(0.4)
check('缺参数时显示表单', js('document.querySelectorAll(".pk-field").length')==2)
shot('form')
press('Escape'); wait(0.2)
typed('cs 小明'); r=rows(); check('关键词 + 参数', r[:1]==['参数测试'], r[:3])
press('Enter'); wait(0.7); check('内联参数传给脚本', text_of('.pk-text').startswith('小明/'), text_of('.pk-text'))
press('Escape'); wait(0.2); os.remove(p); wait(0.5)
# --- 配置写错
cfgp=os.path.join(HOME,'config.json'); good=open(cfgp).read()
open(cfgp,'w').write('{\n  "hotkey": \n}'); wait(0.6)
typed('z'); check('配置写错时显示错误', '配置文件有误' in text_of('.pk-banner'), text_of('.pk-banner'))
open(cfgp,'w').write(good); wait(0.6)
typed('zz'); check('修好后错误消失', not js('!!document.querySelector(".pk-banner")'))
# --- 插件
typed('颜色工具'); r=rows(); check('插件可搜到', r[:1]==['颜色工具'], r[:3])
press('Enter'); wait(1.6)
check('插件在 iframe 中打开', js('!!document.querySelector(".pk-frame")'))
shot('plugin')
store=os.path.join(HOME,'data','plugins','color-tool.json')
check('插件脚本运行并通过 window.pocket 写入存储', os.path.exists(store) and 'color' in open(store).read())
check('视图标题图标是插件图标', js('document.querySelector(".pk-view-title .glyph")?.innerText')=='🎨')
press('Escape'); wait(0.2)
# --- 插件无法调用 Go
pr=js('''new Promise(res=>{const f=document.createElement("iframe");f.sandbox="allow-scripts";f.srcdoc=`<script>parent.postMessage(typeof window.mygo==="undefined"?"nomygo":"hasmygo:"+(typeof window.mygo.call),"*")<\\/script>`;const h=e=>{if(e.source===f.contentWindow){removeEventListener("message",h);f.remove();res(e.data)}};addEventListener("message",h);document.body.append(f);setTimeout(()=>res("timeout"),1500)})''')
print('    iframe 内的 mygo:', pr)
# --- 图片预览（用剪贴板里的图片条目，没有就跳过）
typed('cb '); 
idx=js('[...document.querySelectorAll(".pk-row-title")].findIndex(x=>x.innerText==="图片")')
if idx is not None and idx>=0:
    for _ in range(idx): press('ArrowDown')
    wait(0.5)
    ok=js('(()=>{const i=document.querySelector(".pk-preview-image img");return i&&i.complete&&i.naturalWidth>0})()')
    check('图片预览通过 pocketicon 协议加载', bool(ok))
    shot('image-preview')
typed('')


# ================= 功能页 =================
show()
# md5 + 内容：回车复制保留；Ctrl/⌘+回车 打开哈希面板并带上内容
typed('md5 hello'); r=rows()
check('md5 + 内容 的第一项是结果', r[:1]==['5d41402abc4b2a76b9719d911017c592'], r[:2])
press('Enter', metaKey=True); wait(0.6)
check('⌘+回车 打开哈希面板', js('!!document.querySelector(".pk-feature .fx-kv")'))
check('面板带上了输入', js('document.querySelector(".pk-feature textarea")?.value')=='hello')
vals=texts('.pk-feature .fx-kv-val'); check('面板里算出 MD5', '5d41402abc4b2a76b9719d911017c592' in vals, vals)
check('MD5 行被选中', 'MD5' in js('document.querySelector(".fx-kv.is-focus")?.innerText||""'))
shot('feature-hash')
press('Escape'); wait(0.3); check('Esc 从功能页返回搜索', not js('!!document.querySelector(".pk-feature")'))
# 只输入 md5：回车打开功能页
typed('md5'); r=rows(); check('只输入 md5 时第一项是哈希计算', r[:1]==['哈希计算'], r[:3])
press('Enter'); wait(0.5); check('回车打开哈希面板', js('!!document.querySelector(".pk-feature")'))
press('Escape'); wait(0.3)

# 各开发工具
open_feature('json'); fill('.pk-feature textarea', '{"b":1,"a":[true,null]}'); wait(0.3)
out=js('document.querySelector(".pk-feature .fx-out-text")?.innerText||""'); check('JSON 格式化', '"a": [' in out and '\n' in out, out[:80])
fill('.pk-feature textarea', '{"a":1,}'); wait(0.3)
err=js('document.querySelector(".fx-out-text.is-error")?.innerText||""'); check('JSON 错误指出行列', '第 1 行' in err, err)
shot('feature-json'); press('Escape'); wait(0.2)
open_feature('b64'); fill('.pk-feature textarea', '你好'); wait(0.2)
check('Base64 编码中文', js('document.querySelector(".pk-feature .fx-out-text")?.innerText')=='5L2g5aW9')
press('Escape'); wait(0.2)
open_feature('ts'); fill('.pk-feature input', '1700000000'); wait(0.3)
vals=texts('.pk-feature .fx-kv-val'); check('时间戳转换', any(v.startswith('2023-11-1') for v in vals), vals[:3])
shot('feature-timestamp'); press('Escape'); wait(0.2)
open_feature('regex'); fill('.pk-feature .fx-regex-bar input', r'\d+'); fill('.pk-feature textarea', 'a1 b22 c333'); wait(0.3)
check('正则高亮匹配', js('document.querySelectorAll(".fx-mark").length')==3)
press('Escape'); wait(0.2)
open_feature('jwt'); fill('.pk-feature textarea', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJleHAiOjEwMDAwMDAwMDB9.x'); wait(0.3)
check('JWT 解码并提示已过期', '已过期' in js('document.querySelector(".fx-jwt")?.innerText||""'))
press('Escape'); wait(0.2)
open_feature('uuid'); wait(0.2)
vals=texts('.pk-feature .fx-kv-val'); check('批量生成 UUID', len(vals)==5 and all(len(v)==36 for v in vals), vals[:1])
press('Escape'); wait(0.2)
open_feature('color'); fill('.pk-feature input:not([type=color])', 'rgb(255, 0, 0)'); wait(0.3)
check('颜色转换', '#ff0000' in texts('.pk-feature .fx-kv-val'))
shot('feature-color'); press('Escape'); wait(0.2)
open_feature('urlp'); fill('.pk-feature input', 'https://a.com/p?q=%E5%8F%A3%E8%A2%8B&n=2'); wait(0.3)
check('URL 解析查询参数', '口袋' in texts('.pk-feature .fx-kv-val'))
press('Escape'); wait(0.2)
open_feature('upper'); fill('.pk-feature textarea', 'hello world'); wait(0.2)
js('[...document.querySelectorAll(".fx-chip")].find(b=>b.innerText==="camelCase").click();1'); wait(0.2)
check('文本处理', js('document.querySelector(".pk-feature textarea").value')=='helloWorld')
press('Escape'); wait(0.2)

# 翻译：没有配置密钥时，提示去设置（翻译接口本身由 Go 单元测试覆盖）
open_feature('fy hello world', 1.2)
check('fy + 内容 进入翻译并带上原文', js('document.querySelector(".fx-translate-src")?.value')=='hello world')
err=js('document.querySelector(".fx-translate-error")?.innerText||""')
check('未配置时提示去设置', '设置' in err, err[:60])
shot('feature-translate'); press('Escape'); wait(0.2)

# 文字识别：用主窗口的截图当测试图片，走系统离线识别
cap=call('capture',{'window':panel_id()}); img=os.path.abspath('shots/ocr-input.png'); open(img,'wb').write(base64.b64decode(cap['png']))
res=js('mygo.call("OCR.Recognize",%s).then(r=>r.text)' % json.dumps(img))
check('系统离线识别出界面上的文字', bool(res) and ('Esc' in res or '返回' in res or '搜索' in res or 'Pocket' in res), (res or '')[:80])
open_feature('tpsb'); check('图片识别页面', js('!!document.querySelector(".fx-ocr-actions")')); shot('feature-ocr'); press('Escape'); wait(0.2)

# 摸鱼阅读：导入 GBK 编码的 txt，读章节，翻章
book=os.path.abspath('测试小说.txt')
open(book,'wb').write(('第一章 开端\n' + '这是第一章的内容。\n'*40 + '第二章 继续\n' + '这是第二章的内容。\n'*40).encode('gbk'))
r=js('mygo.call("Library.ImportPaths",[%s]).then(b=>b.map(x=>x.title+"/"+x.chapters).join(","))' % json.dumps(book))
check('导入 GBK 小说', r=='测试小说/2', r)
typed('my'); first=rows()[:2]; press('Enter')
for _ in range(30):
    if js('!!document.querySelector(".rd-book")'): break
    wait(0.1)
check('书库列出这本书', '测试小说' in (js('document.querySelector(".rd-books")?.innerText||""') or ''), (first, text_of('.pk-view-title'), (js('document.querySelector(".pk-body")?.innerText||""') or '')[:80]))
js('document.querySelector(".rd-book").click();1'); wait(0.8)
check('打开后显示第一章', js('document.querySelector(".rd-content h2")?.innerText')=='第一章 开端')
shot('feature-reader')
press(']', code='BracketRight', metaKey=True); wait(0.6)
check('⌘] 翻到下一章', js('document.querySelector(".rd-content h2")?.innerText')=='第二章 继续')
press('Escape'); wait(0.2)
r=js('mygo.call("Library.Books").then(b=>b[0].chapter)'); check('记住阅读进度', r==1, r)

# ================= 分离成独立窗口 =================
before=len(windows())
open_feature('json'); fill('.pk-feature textarea', '[1,2]'); wait(0.2)
press('d', metaKey=True); wait(1.4)
w=window_by('feature.html'); check('⌘D 分离成独立窗口', w is not None and len(windows())==before+1)
check('分离后主窗口收起', not visible())
if w:
    wait(0.4)
    check('独立窗口里是 JSON 工具', (js('document.querySelector(".dt-title")?.innerText', w['id']) or '').strip()=='JSON 工具')
    check('分离时带上已经输入的内容', js('document.querySelector(".pk-feature textarea")?.value', w['id'])=='[1,2]')
    check('独立窗口里功能可用', js('!!document.querySelector(".fx-page")', w['id']))
    shot('detached-json', w['id'])
    show(); typed('JSON'); r=rows()
    check('搜索里能切换到已分离的窗口', 'JSON 工具' in r and js('[...document.querySelectorAll(".pk-row-subtitle")].some(e=>e.innerText.includes("切换到"))'), r[:4])
    open_feature('json'); wait(0.6)
    check('再次打开同一个功能时切过去，不重复开窗', len(windows())==before+1)
    lst=js('mygo.call("Windows.List").then(l=>l.map(x=>x.title))', panel_id()); check('窗口列表', 'JSON 工具' in (lst or []), lst)
    js('setTimeout(()=>mygo.call("Windows.Control","close",0),30);1', w['id']); wait(0.8)
    check('关闭独立窗口', window_by('feature.html') is None)

# 摸鱼小窗 + 老板键
show()
js('mygo.call("Windows.Detach",{feature:"reader",mode:"stealth",title:"摸鱼阅读",icon:"svg:book-open"})', panel_id()); wait(1.6)
sw=window_by('m=stealth'); check('打开摸鱼小窗', sw is not None)
if sw:
    check('小窗显示正文', '这是第二章' in (js('document.querySelector(".rd-stealth-text")?.innerText||""', sw['id']) or ''))
    shot('stealth', sw['id'])
    js('mygo.call("Library.ToggleBoss")', panel_id()); wait(0.6)
    check('老板键隐藏阅读窗口', not [x for x in windows() if x['id']==sw['id']][0]['visible'])
    js('mygo.call("Library.ToggleBoss")', panel_id()); wait(0.6)
    check('再按一次显示回来', [x for x in windows() if x['id']==sw['id']][0]['visible'])
    js('setTimeout(()=>mygo.call("Windows.Control","close",0),30);1', sw['id']); wait(0.6)

# ================= 拖动和位置 =================
show(); typed('')
region=lambda sel: (js('getComputedStyle(document.querySelector(%s)).getPropertyValue("--app-region").trim()' % json.dumps(sel)) or '')
check('标题栏和底栏是拖动区域', region('.pk-header')=='drag' and region('.pk-footer')=='drag', (region('.pk-header'), region('.pk-footer')))
pos0=js('mygo.call("E2E.PanelPosition")')
# 在输入框的空白处按住拖动（合成的鼠标事件，不动真实的鼠标）
js('''(()=>{const i=document.querySelector(".pk-input");const r=i.getBoundingClientRect();
 i.dispatchEvent(new MouseEvent("mousedown",{button:0,bubbles:true,clientX:r.right-30,clientY:r.top+10,screenX:500,screenY:300}));
 window.dispatchEvent(new MouseEvent("mousemove",{screenX:540,screenY:325}));return 1})()'''); wait(0.5)
js('window.dispatchEvent(new MouseEvent("mouseup",{}));1'); wait(0.3)
pos1=js('mygo.call("E2E.PanelPosition")')
check('拖动输入框空白处能移动窗口', pos1==[pos0[0]+40, pos0[1]+25], (pos0,pos1))
js('mygo.call("Launcher.Hide")'); wait(0.6); show()
check('再次唤出时回到拖动后的位置', js('mygo.call("E2E.PanelPosition")')==pos1, pos1)
open_feature('json'); check('功能页里标题栏也能拖动', region('.pk-header')=='drag' and region('.pk-view-title')=='drag'); press('Escape'); wait(0.2)
js('mygo.call("Settings.ResetPanelPosition")'); wait(0.3)
js('mygo.call("Launcher.Hide")'); wait(0.4); show()
check('复位后回到居中', js('mygo.call("E2E.PanelPosition")')==pos0, (pos0, js('mygo.call("E2E.PanelPosition")')))

# ================= 带入选中的文字、文字块 =================
chip=lambda: (js('document.querySelector(".pk-chip")?.innerText||""') or '').strip()
js('mygo.call("E2E.Summon","report-final.pdf")'); wait(0.9)
check('选中的文字变成搜索框里的一个块', chip()=='report-final.pdf' and js('document.querySelector(".pk-input").value')=='', chip())
r=rows(); check('块后面没输入时，列出能处理它的功能', '翻译' in r and '文本处理' in r and any('搜索' in x for x in r), r[:8])
check('底栏说明带入了什么', '选中的文字' in text_of('.pk-footer-left'), text_of('.pk-footer-left'))
shot('payload-text')
typed('wbcl'); r=rows(); check('块后面输入功能名（拼音首字母）', r[:1]==['文本处理'], r[:3])
press('Enter'); wait(0.6)
check('进入功能后，带入的文字自动填进去', js('document.querySelector(".pk-feature textarea")?.value')=='report-final.pdf')
press('Escape'); wait(0.3); check('返回后块还在', chip()=='report-final.pdf')
typed('md5'); r=rows(); check('块后面输入 md5：直接算出结果，其次是哈希面板', len(r)>=2 and len(r[0])==32 and r[1]=='哈希计算', r[:3])
typed('gh'); r=rows(); check('块后面输入搜索引擎关键词', any('GitHub' in x and 'report-final.pdf' in x for x in r), r[:3])
typed(''); wait(0.3); press('Backspace'); wait(0.5)
check('退格把块变回可以编辑的文字', chip()=='' and js('document.querySelector(".pk-input").value')=='report-final.pdf', (chip(), js('document.querySelector(".pk-input").value')))
# 带入的文字照常参与识别：是应用名时能直接找到应用
js('mygo.call("E2E.Summon","Calculator")'); wait(1.0)
r=rows(); check('带入的文字照常匹配应用', r[0] in ('Calculator','计算器') and '翻译' in r, r[:6])
# 多行长文字：不去匹配应用和文件
js('mygo.call("E2E.Summon","第一行文字\\n第二行文字")'); wait(0.9)
r=rows(); check('多行文字只给功能和网页搜索', r[0]=='翻译' and chip().startswith('第一行文字 第二行文字'), (chip(), r[:4]))

# ================= 粘贴 =================
def paste(text=None):
    js('''(()=>{const dt=new DataTransfer();%s;const i=document.querySelector(".pk-input");
      const ev=new ClipboardEvent("paste",{clipboardData:dt,bubbles:true,cancelable:true});i.dispatchEvent(ev);return ev.defaultPrevented})()''' % ('dt.setData("text/plain",%s)' % json.dumps(text) if text else '1'))
    wait(0.7)
show(); typed('')
js('mygo.call("Launcher.CopyText","粘贴进来的文字")'); wait(0.2); paste('粘贴进来的文字')
check('输入框空着时粘贴文字，变成块', chip()=='粘贴进来的文字', chip())
press('Backspace'); wait(0.4); check('退格后可以继续编辑', js('document.querySelector(".pk-input").value')=='粘贴进来的文字')
paste('粘贴进来的文字'); check('已经有输入时，粘贴照常进文字里（不变成块）', chip()=='', chip())
# 图片
show(); typed('')
js('mygo.call("E2E.CopyImage",%s)' % json.dumps(os.path.abspath('shots/feature-hash.png'))); wait(0.4); paste()
check('粘贴图片变成带缩略图的块', js('!!document.querySelector(".pk-chip.is-image img")') and chip()=='图片', chip())
r=rows(); check('图片的操作', r[0]=='识别图片里的文字' and '识别文字并复制' in r and '保存图片到文件…' in r and any(x.startswith('以图搜图') for x in r), r)
check('图片操作带预览', js('!!document.querySelector(".pk-preview-image img")'))
shot('payload-image')
typed('sbfz'); r=rows(); check('块后面输入功能名过滤图片操作', r[:1]==['识别文字并复制'], r[:3])
press('Enter')
tip=''
for _ in range(30):
    tip=text_of('.pk-footer-left')
    if '已复制识别结果' in tip: break
    wait(0.1)
check('识别后给出提示', '已复制识别结果' in tip, tip)
clip=js('mygo.call("Launcher.PluginCall","color-tool","readClipboard",[])') or ''
check('识别并复制：结果进了剪贴板', '哈希计算' in clip and 'SHA-256' in clip, clip[:80])
typed(''); wait(0.3); press('Enter'); wait(2.5)
got=js('document.querySelector(".fx-ocr-text")?.value||""') or ''
check('图片块 → 识别页，直接出结果', 'SHA-256' in got and 'hello' in got, got[:120])
shot('payload-ocr')
press('Escape'); wait(0.3); press('Backspace'); wait(0.3); check('退格移除图片块', chip()=='')

# ================= 截图识别的后续流程 =================
img=os.path.abspath('shots/feature-hash.png')
js('mygo.call("Launcher.Hide")'); wait(0.4)
js('mygo.call("E2E.ShowOCR",{image:%s})' % json.dumps(img)); wait(2.5)
check('截图命令结束后：主窗口回来并进入识别页', visible() and js('!!document.querySelector(".fx-ocr")'))
check('截到的图自动识别', 'MD5' in (js('document.querySelector(".fx-ocr-text")?.value||""') or ''))
js('mygo.call("E2E.Resume")'); wait(0.8)
check('页面里点截图：窗口收起再回来，识别页还在', visible() and js('!!document.querySelector(".fx-ocr")') and 'MD5' in (js('document.querySelector(".fx-ocr-text")?.value||""') or ''))
js('mygo.call("Launcher.Hide")'); wait(0.4)
js('mygo.call("E2E.ShowOCR",{error:"截图失败：测试用的错误"})'); wait(1.0)
check('截图失败时把原因显示出来', '测试用的错误' in (js('document.querySelector(".pk-feature")?.innerText||""') or ''))
press('Escape'); wait(0.3)

# ================= 功能快捷键带入选中的文字 =================
js('mygo.call("Launcher.Hide")'); wait(0.4)
js('mygo.call("E2E.SetSelection","selected words")'); js('mygo.call("E2E.Hotkey","features:translate")'); wait(1.4)
check('按翻译的快捷键：选中的文字直接填进翻译框', visible() and js('document.querySelector(".fx-translate-src")?.value')=='selected words', js('document.querySelector(".fx-translate-src")?.value'))
press('Escape'); wait(0.3)
js('mygo.call("E2E.SetSelection","")')
ax=js('mygo.call("E2E.Selection")'); print('    辅助功能读取（只读，结果取决于当前前台应用和授权）:', {k:(v if k!='text' else len(v)) for k,v in (ax or {}).items()})

# ================= 第四轮：右键菜单、排序、新页面、预览、发音 =================
# --- 右键菜单：打开后鼠标划过别的图标，菜单不变
js('mygo.call("E2E.Resume")'); wait(0.3); show(); typed(''); wait(0.4)
tiles=texts('.pk-tile-title')
if len(tiles)>=3:
    js('(()=>{const t=document.querySelectorAll(".pk-tile")[0];const r=t.getBoundingClientRect();t.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+20}));return 1})()'); wait(0.4)
    check('右键打开动作菜单', text_of('.pk-actions-title')==tiles[0], text_of('.pk-actions-title'))
    js('(()=>{const t=document.querySelectorAll(".pk-tile")[2];for(const x of [300,320,340]) t.dispatchEvent(new MouseEvent("mousemove",{bubbles:true,screenX:x,screenY:200,clientX:x,clientY:60}));return 1})()'); wait(0.3)
    check('鼠标划过别的图标，菜单还是原来那一项的', text_of('.pk-actions-title')==tiles[0], text_of('.pk-actions-title'))
    box=js('(()=>{const m=document.querySelector(".pk-actions").getBoundingClientRect(),t=document.querySelectorAll(".pk-tile")[0].getBoundingClientRect(),b=document.querySelector(".pk-body").getBoundingClientRect();return {near:Math.abs(m.left-(t.left+22))<60, inside:m.left>=b.left&&m.right<=b.right+1&&m.bottom<=b.bottom+1&&m.top>=b.top-1}})()')
    check('菜单在鼠标旁边弹出，并且没有超出窗口', box and box['near'] and box['inside'], box)
    shot('context-menu')
    js('document.querySelector(".pk-actions-backdrop").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}));1'); wait(0.3)
    check('点菜单外面只关闭菜单', js('!document.querySelector(".pk-actions")') and visible())
else:
    check('首页有足够的图标来测右键菜单', False, tiles)

# --- 排序和中文应用名
if os.path.exists('/Applications/WeChat.app'):
    typed('weixin'); wait(0.5); r=rows(); check('weixin 第一个是微信', r[:1] in (['微信'],['WeChat']), r[:4])
    typed('微信'); wait(0.5); r=rows(); check('中文名找微信', r[:1] in (['微信'],['WeChat']), r[:4])
typed('时钟'); wait(0.5); r=rows(); check('中文名找系统应用（时钟）', r[:1] in (['时钟'],['Clock']), r[:4])
typed('shizhong'); wait(0.5); r=rows(); check('拼音找时钟', r[:1] in (['时钟'],['Clock']), r[:4])
typed('clock'); wait(0.5); r=rows(); check('英文名找时钟', r[:1] in (['时钟'],['Clock']), r[:4])
typed('备忘录'); wait(0.5); r=rows(); check('中文名找备忘录', r[:1] in (['备忘录'],['Notes']), r[:4])
typed('jsq'); wait(0.5); r=rows(); check('jsq 找到计算器', '计算器' in r[:2], r[:4])

# --- 颜色：透明度
COLOR_IN='.pk-feature input:not([type=color]):not([type=range]):not([type=number])'
open_feature('color'); fill(COLOR_IN, '#2f6bff80'); wait(0.3)
vals=texts('.pk-feature .fx-kv-val')
check('颜色：8 位 HEX 带透明度', '#2f6bff80' in vals and 'rgba(47, 107, 255, 0.502)' in vals and '#802F6BFF' in vals, vals)
fill(COLOR_IN, 'rgb(255 0 0 / 50%)'); wait(0.3)
vals=texts('.pk-feature .fx-kv-val')
check('颜色：新写法的透明度，并给出叠在白底上的颜色', '#ff000080' in vals and 'hsla(0, 100%, 50%, 0.5)' in vals and '#ff8080' in vals, vals)
fill(COLOR_IN, '#00ff00'); wait(0.3)
vals=texts('.pk-feature .fx-kv-val'); check('颜色：没写透明度时保留滑块上的值', '#00ff0080' in vals, vals)
shot('feature-color-alpha'); press('Escape'); wait(0.2)

# --- 计算器
typed('2*21'); r=rows(); check('算式结果', r[:1]==['42'], r)
press('Enter'); wait(0.4); show()
h=js('mygo.call("Calc.History")') or []
check('搜索框里回车复制的结果记进历史', any(x['expr']=='2*21' and x['result']=='42' for x in h), h[:2])
typed('3+4'); press('Enter', metaKey=True); wait(0.7)
check('Ctrl/⌘+回车带着算式打开计算器页', js('(document.querySelector(".fx-calc-input")||{}).value')=='3+4', js('(document.querySelector(".fx-calc-input")||{}).value'))
fill('.fx-calc-input', 'a = 5\na * 3  # 注释\n\n10 km to mi\nsum'); wait(0.5)
vals=[v.replace('\n',' ') for v in texts('.fx-calc-result')]
check('多行计算、变量和合计', len(vals)==5 and vals[0].endswith('5') and vals[1]=='15' and vals[2]=='' and vals[3]=='6.2137119224 mi' and vals[4]=='20', vals)
n0=len(texts('.fx-calc-entry'))
check('计算器页显示历史', n0>=1 and any('2*21' in t for t in texts('.fx-calc-expr')), texts('.fx-calc-expr'))
shot('feature-calc')
click('.fx-calc-entry .ui-btn[title="删除这条"]'); wait(0.4)
check('历史可以删除', len(texts('.fx-calc-entry'))==n0-1, (n0, len(texts('.fx-calc-entry'))))
check('历史保存在文件里', os.path.exists(os.path.join(HOME,'data','calc-history.json')))
press('Escape'); wait(0.2)
open_feature('calc'); check('输入 calc 打开计算器页', js('!!document.querySelector(".fx-calc")')); press('Escape'); wait(0.2)

# --- 剪贴板页
typed('剪贴板'); r=rows(); check('剪贴板历史只有一条入口', r.count('剪贴板历史')==1 and r[0]=='剪贴板历史', r[:4])
press('Enter'); wait(0.7)
check('回车打开剪贴板页面', js('!!document.querySelector(".fx-clip")') and len(texts('.fx-clip-row'))>0, texts('.fx-clip-label')[:3])
fill('.fx-clip .fx-search-input', '42'); wait(0.5)
check('剪贴板页里搜索', '42' in texts('.fx-clip-label'), texts('.fx-clip-label')[:4])
shot('feature-clipboard'); press('Escape'); wait(0.2)

# --- Windows 工具（测试构建里在 macOS 上也显示）
open_feature('wintools'); check('Windows 工具页', js('!!document.querySelector(".fx-wintools")'))
n_all=len(texts('.fx-tool'))
fill('.fx-wintools .fx-search-input', 'services'); wait(0.4)
check('按原名搜索', texts('.fx-tool-title code')[:1]==['services.msc'] and n_all>60, texts('.fx-tool-title code')[:3])
fill('.fx-wintools .fx-search-input', '环境变量'); wait(0.4)
check('按说明搜索', texts('.fx-tool-title b')[:1]==['环境变量'], texts('.fx-tool-title b')[:3])
fill('.fx-wintools .fx-search-input', 'cpgl'); wait(0.4)
check('拼音首字母搜索（磁盘管理）', '磁盘管理' in texts('.fx-tool-title b')[:2], texts('.fx-tool-title b')[:3])
shot('feature-wintools'); press('Escape'); wait(0.2)
typed('compmgmt'); wait(0.4); r=rows(); check('搜索框里直接搜到 Windows 工具', '计算机管理' in r[:3], r[:4])

# --- 文件预览和属性（搜索框）
doc=os.path.join(HOME,'预览测试.md'); open(doc,'w').write('# 预览标题\n\n正文第一段\n')
binf=os.path.join(HOME,'数据.bin'); open(binf,'wb').write(bytes(range(256))*4)
import wave, struct, math
wav=os.path.join(HOME,'提示音.wav')
with wave.open(wav,'wb') as wf:
    wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(8000)
    wf.writeframes(b''.join(struct.pack('<h', int(8000*math.sin(i/8000*2*math.pi*440))) for i in range(8000)))
typed(HOME+'/预览'); wait(0.9)
check('选中 Markdown 文件：渲染预览', '预览标题' in text_of('.pk-preview .fp-doc'), text_of('.pk-preview')[:80])
attrs=texts('.pk-preview .fp-attrs dt'); check('属性区列出名称、类型、大小、时间', all(k in attrs for k in ['名称','类型','大小','位置','修改时间','编码']), attrs)
check('底栏有预览和属性的开关', texts('.pk-panes button')==['预览','属性'], texts('.pk-panes button'))
js('document.querySelectorAll(".pk-panes button")[1].click();1'); wait(0.6)
check('关掉属性区', js('!document.querySelector(".pk-preview .fp-attrs")') and js('!!document.querySelector(".pk-preview .fp-doc")'))
js('document.querySelectorAll(".pk-panes button")[0].click();1'); wait(0.6)
check('预览和属性都关掉后右侧收起', js('!document.querySelector(".pk-preview")'))
js('document.querySelectorAll(".pk-panes button")[0].click();1'); wait(0.5); js('document.querySelectorAll(".pk-panes button")[1].click();1'); wait(0.6)
check('开关可以再打开', js('!!document.querySelector(".pk-preview .fp-attrs")') and js('!!document.querySelector(".pk-preview .fp-doc")'))
typed(HOME+'/数据'); wait(0.9)
check('没法预览的文件：不留空白，图标加属性铺满', js('!!document.querySelector(".pk-preview .fp.is-bare .fp-card")') and len(texts('.pk-preview .fp-attrs dt'))>=5, text_of('.pk-preview')[:120])
shot('preview-bare')
typed(HOME+'/提示音'); wait(0.6)
ok=wait_for('(()=>{const a=document.querySelector(".pk-preview audio");return !!(a&&a.readyState>=1&&a.duration>0.5)})()', 5)
check('音频文件可以直接播放（读出了时长）', ok, js('(()=>{const a=document.querySelector(".pk-preview audio");return a?[a.readyState,a.error&&a.error.code,a.src.slice(0,40)]:null})()'))
check('时长写进了属性', '时长' in texts('.pk-preview .fp-attrs dt'), texts('.pk-preview .fp-attrs dt'))
mov='/System/Library/CoreServices/NotificationCenter.app/Contents/Resources/mac_widgets-edu_small.mov'
if os.path.exists(mov):
    typed(mov); wait(0.8)
    ok=wait_for('(()=>{const v=document.querySelector(".pk-preview video");return !!(v&&v.readyState>=1&&v.videoWidth>0)})()', 6)
    check('视频文件可以直接播放（读出了分辨率）', ok, js('(()=>{const v=document.querySelector(".pk-preview video");return v?[v.readyState,v.error&&v.error.code]:null})()'))
    shot('preview-video')
d=js('mygo.call("Finder.Detail",%s)' % json.dumps(os.path.join(HOME,'commands'))) or {}
check('文件夹：列出内容', d.get('kind')=='folder' and d.get('total',0)>=1, d.get('kind'))

# --- 高级搜索
typed(''); open_feature('find', 0.9); check('find 打开高级搜索', js('!!document.querySelector(".fx-find")'))
kinds=texts('.fx-find-kind'); check('左侧有类型筛选', kinds[:4]==['全部','文件夹','文档','图片'] and '视频' in kinds, kinds)
info=js('mygo.call("Finder.Info")') or {}
check('报告当前的搜索引擎', info.get('engine') in ('spotlight','everything','index') and bool(info.get('note')), info.get('engine'))
fill('.fx-find .fx-search-input', 'yojigen-pocket'); js('[...document.querySelectorAll(".fx-find-kind")].find(b=>b.innerText.trim()=="文件夹").click();1')
found=wait_for('[...document.querySelectorAll(".fx-find-name")].some(n=>n.innerText=="yojigen-pocket")', 8)
soft('按类型搜到文件夹（依赖系统索引）', found, texts('.fx-find-name')[:5])
if found:
    js('[...document.querySelectorAll(".fx-find-row")].find(r=>r.querySelector(".fx-find-name").innerText=="yojigen-pocket").click();1'); wait(0.9)
    check('右侧显示预览和属性', js('!!document.querySelector(".fx-find-pane .fp-entries")') and '包含' in texts('.fx-find-pane .fp-attrs dt'), text_of('.fx-find-pane')[:100])
    shot('feature-find')
    click('.fx-find .ui-btn[title="隐藏属性区"]'); wait(0.5)
    check('高级搜索里关掉属性区', js('!document.querySelector(".fx-find-pane .fp-attrs")') and js('!!document.querySelector(".fx-find-pane .fp-entries")'))
    click('.fx-find .ui-btn[title="隐藏预览区"]'); wait(0.5)
    check('两个都关掉后右侧收起', js('!document.querySelector(".fx-find-pane")'))
    click('.fx-find .ui-btn[title="显示预览区"]'); click('.fx-find .ui-btn[title="显示属性区"]'); wait(0.5)
r=js('mygo.call("Finder.Search",{query:"*.icns icon",kind:"all",scope:"home",limit:20})') or {}
soft('通配符搜索（依赖系统索引）', any(x['name'].endswith('.icns') for x in (r.get('items') or [])), [x['name'] for x in (r.get('items') or [])][:4])
press('Escape'); wait(0.2)

# --- 内置模块：快捷键和独立窗口
items={x['id']:x for x in (js('mygo.call("Catalog.Items")') or [])}
check('计算器、剪贴板、文件搜索可以开独立窗口和绑快捷键', all(items.get('module:'+m,{}).get('canDetach') and items.get('module:'+m,{}).get('canHotkey') for m in ['calc','clipboard','files']), [k for k in items if k.startswith('module:')])
check('有前缀的模块能绑快捷键，没有入口的不能', items['module:shell'].get('canHotkey') and not items['module:apps'].get('canHotkey'))
js('mygo.call("Launcher.Hide")'); wait(0.3)
js('mygo.call("E2E.Hotkey","module:calc")'); wait(1.2)
check('按模块的快捷键打开计算器页', visible() and js('!!document.querySelector(".fx-calc")'))
press('Escape'); wait(0.2)
js('mygo.call("E2E.Hotkey","module:shell")'); wait(1.0)
check('没有页面的模块：快捷键带着前缀打开搜索框', (js('document.querySelector(".pk-input").value') or '').startswith('>'), js('document.querySelector(".pk-input").value'))
typed('')
js('mygo.call("Catalog.Detach","module:clipboard")'); wait(1.6)
w=window_by('f=clipboard'); check('剪贴板历史可以开成独立窗口', w is not None)
if w:
    check('独立窗口里是剪贴板页', wait_for('!!document.querySelector(".fx-clip")', 4, w['id']))
    close_window(w)
js('mygo.call("Catalog.Detach","module:files")'); wait(1.6)
w=window_by('f=find'); check('文件搜索可以开成独立窗口', w is not None)
if w:
    size=js('[innerWidth,innerHeight]', w['id']); check('高级搜索的独立窗口更宽', size and size[0]>=1000, size)
    shot('find-detached', w['id'])
    close_window(w)
show()

# --- 发音
plan=js('mygo.call("Speech.Plan",%s,"en")' % json.dumps('First sentence here. '*60)) or {}
check('长文本切成多段朗读', len(plan.get('segments') or [])>=3 and all(len(x)<=420 for x in plan['segments']), len(plan.get('segments') or []))
plan=js('mygo.call("Speech.Plan","make it work","en")') or {}
check('短句不切，整句朗读（不会读到空格就停）', plan.get('segments')==['make it work'], plan)
st=js('mygo.call("Speech.Status")') or {}
check('Edge 语音的连接参数可以查看', st.get('gec')=='v2' and st.get('chromium') and not st.get('profileCustom'), st)
def audio_ok(url):
    return js('new Promise(r=>{const a=new Audio(%s);a.onloadedmetadata=()=>r(a.duration>0.2);a.onerror=()=>r(false);setTimeout(()=>r(false),6000)})' % json.dumps(url))
try:
    r=js('mygo.call("Speech.Synthesize","pocket","en")') or {}
    soft('单词用词典发音（联网）', r.get('engine') in ('youdao','google') and r.get('url') and audio_ok(r['url']), r)
    r=js('mygo.call("Speech.Synthesize","It keeps reading after the space.","en")') or {}
    soft('句子用 Edge 语音（联网）', r.get('engine')=='edge' and r.get('url') and audio_ok(r['url']), r)
except Exception as e:
    soft('发音合成（联网）', False, e)

# ================= 第五轮：唤出速度、滚动、图标、命令行优先级 =================
# --- 读选中文字慢的时候，窗口也立刻出现，内容随后补上
js('mygo.call("E2E.SlowSummon","迟到的选中文字",500)'); t0=time.time()
shown=wait_for_py=None
while time.time()-t0<0.45:
    if visible(): shown=time.time()-t0; break
    time.sleep(0.02)
check('唤出不等读选中文字：窗口先出现', shown is not None and shown<0.3, shown)
check('这时还没有带入的内容', js('!document.querySelector(".pk-chip")'))
ok=wait_for('!!document.querySelector(".pk-chip")', 2.0)
check('读到之后补进搜索框', ok and '迟到的选中文字' in text_of('.pk-chip'), text_of('.pk-chip'))
press('Backspace'); wait(0.3); typed(''); wait(0.2)  # 把带入的内容块退掉，后面的检查从空的搜索框开始
check('内容块可以退掉', js('!document.querySelector(".pk-chip")'))
js('mygo.call("Launcher.Hide")'); wait(0.5); show(); typed('')
t=js('mygo.call("E2E.TimeSummon")') or {}
check('直接能读到时不绕路（读取 + 显示在 60 毫秒内）', t.get('capture',999)+t.get('show',999)<60, t)

# --- 搜索条的图标是彩色的应用标志
typed(''); wait(0.3)
check('搜索条左侧是应用标志', js('!!document.querySelector(".pk-logo svg clipPath")') and js('[...document.querySelectorAll(".pk-logo svg [fill]")].some(e=>e.getAttribute("fill")=="#e5342f")'))
shot('home')

# --- 列表能用滚轮滚动
open_feature('wintools'); wait(0.3)
st_=js('(()=>{const l=document.querySelector(".fx-tool-list");const s=getComputedStyle(l);return {o:s.overflowY,more:l.scrollHeight>l.clientHeight+50}})()')
check('Windows 工具的列表可以滚动', st_ and st_['o']=='auto' and st_['more'], st_)
press('Escape'); wait(0.2)
typed('剪贴板'); press('Enter'); wait(0.6)
check('剪贴板的列表可以滚动', js('getComputedStyle(document.querySelector(".fx-clip-list")).overflowY')=='auto')
press('Escape'); wait(0.2)

# --- 命令行打开全局搜索后，也不能压在应用前面
cfgp=os.path.join(HOME,'config.json'); cfg=json.load(open(cfgp)); cfg['modules']['shell']['global']=True
json.dump(cfg, open(cfgp,'w'), ensure_ascii=False, indent=2); wait(1.2)
typed('clock'); wait(0.5); r=rows(); check('命令行全局搜索：不是程序的输入没有“执行命令”这一条', r[:1] in (['时钟'],['Clock']) and 'clock' not in r, r[:4])
typed('say hello'); wait(0.5); r=rows(); src=js('[...document.querySelectorAll(".pk-row")].map(r=>(r.querySelector(".pk-row-subtitle")||{}).innerText||"")')
check('命令行全局搜索：是程序时给出一条', 'say hello' in r and '执行并查看输出' in (src or []), r[:4])
typed('python3'); wait(0.6); r=rows()
if 'python3' in r:
    check('命令行那一条排在对得上名字的结果后面', r.index('python3')>0 or len(r)==1, r[:4])
cfg['modules']['shell']['global']=False; json.dump(cfg, open(cfgp,'w'), ensure_ascii=False, indent=2); wait(1.0)
typed('')

# ================= 第六轮：笔记、对比、草稿 =================
def cm_type(index, text, win=None, replace=True):
    """往第 index 个代码编辑器里输入文字（走浏览器的 insertText，不发真实按键）。"""
    return js('(()=>{const el=document.querySelectorAll(".cm-content")[%d];if(!el)return false;el.focus();%sreturn document.execCommand("insertText",false,%s)})()' % (index, 'document.execCommand("selectAll");' if replace else '', json.dumps(text)), win)
def cm_text(index, win=None):
    return js('(()=>{const el=document.querySelectorAll(".cm-content")[%d];return el?[...el.querySelectorAll(".cm-line")].map(l=>l.innerText.replace(/\\n$/,"")).join("\\n"):null})()' % index, win)
def click_text(sel, text, win=None):
    return js('(()=>{const el=[...document.querySelectorAll(%s)].find(b=>b.innerText.trim()==%s);if(!el)return false;el.click();return true})()' % (json.dumps(sel), json.dumps(text)), win)

# --- Markdown 笔记
import datetime
today=datetime.date.today().isoformat()
show(); open_feature('md', 1.0)
check('md 打开笔记页', wait_for('!!document.querySelector(".fx-notes")', 6))
check('没有笔记时给出新建入口', wait_for('!!document.querySelector(".fx-scratch-empty .ui-btn")', 3))
click('.fx-scratch-empty .ui-btn'); wait(0.9)
note=os.path.join(HOME,'notes',today+' 笔记.md')
check('新建的笔记文件名带日期', os.path.exists(note) and js('document.querySelector(".fx-notes-title").value')==today+' 笔记', os.listdir(os.path.join(HOME,'notes')) if os.path.isdir(os.path.join(HOME,'notes')) else None)
check('所见即所得编辑器加载出来', wait_for('!!document.querySelector(".fx-notes-rich .ProseMirror")', 10), text_of('.fx-notes-body')[:120])
shot('feature-notes-rich')
click_text('.fx-notes-head .ui-seg button, .fx-notes-head [role=radio], .fx-notes-head .ui-seg *', '源码'); wait(0.6)
check('切到源码模式', wait_for('!!document.querySelector(".fx-notes-body .cm-content")', 4))
cm_type(0, '# 周会记录\n\n- 讨论 hello world 计划\n- [ ] 写文档\n'); wait(1.3)
body=open(note,encoding='utf-8').read() if os.path.exists(note) else ''
check('源码模式里写的内容自动保存到文件', '# 周会记录' in body and '- [ ] 写文档' in body, body[:80])
st=text_of('.fx-notes-status'); check('底部有字数统计和保存状态', '字' in st and '行' in st and ('已保存' in st or '自动保存' in st), st)
click_text('.fx-notes-head .ui-seg button, .fx-notes-head .ui-seg *', '所见即所得'); wait(0.4)
check('切回所见即所得，内容渲染成标题和待办', wait_for('(()=>{const p=document.querySelector(".fx-notes-rich .ProseMirror");return !!p&&!!p.querySelector("h1")&&p.innerText.includes("周会记录")})()', 8), text_of('.fx-notes-rich')[:100])
shot('feature-notes')
fill('.fx-notes-title', '周会记录'); js('document.querySelector(".fx-notes-title").dispatchEvent(new FocusEvent("blur"));1'); wait(0.9)
check('点标题改名，文件跟着改', os.path.exists(os.path.join(HOME,'notes','周会记录.md')) and not os.path.exists(note), os.listdir(os.path.join(HOME,'notes')))
click('.fx-side-head .ui-btn[title="新建文件夹"]'); wait(0.8)
js('(()=>{const i=document.querySelector(".fx-side-rename");if(i){i.value="工作";i.dispatchEvent(new FocusEvent("blur"))}return 1})()'); wait(0.8)
check('新建文件夹并改名', os.path.isdir(os.path.join(HOME,'notes','工作')), os.listdir(os.path.join(HOME,'notes')))
moved=js('mygo.call("Notes.Move","周会记录.md","工作")'); wait(0.3)
check('笔记可以移进文件夹', moved=='工作/周会记录.md' and os.path.exists(os.path.join(HOME,'notes','工作','周会记录.md')), moved)
bad=None
try: js('mygo.call("Notes.Write","../逃出去.md","x")')
except RuntimeError as e: bad=str(e)
check('笔记接口拒绝目录外的路径', bad is not None and not os.path.exists(os.path.join(HOME,'逃出去.md')), bad)
press('Escape'); wait(0.3)

# --- 文本对比
typed(''); open_feature('diff', 1.0)
check('对比页是左右两个编辑器', wait_for('document.querySelectorAll(".fx-diff-merge .cm-content").length==2', 8))
cm_type(0, '{"name":"pocket","tags":["a","b"],"n":1}'); cm_type(1, '{"name":"pocket","tags":["a","c"],"n":2}'); wait(0.6)
st=text_of('.fx-diff-status'); check('实时标出差异并统计', '处差异' in st and js('document.querySelectorAll(".fx-diff-merge .cm-changedText").length')>0, st)
check('粘进内容后自动认出语言', text_of('.fx-diff2 .lang-pick-btn')=='JSON', text_of('.fx-diff2 .lang-pick-btn'))
click_text('.fx-diff2 .fx-toolbar .ui-btn', '格式化'); wait(1.5)
a=cm_text(0); b=cm_text(1)
check('格式化两边后逐行对比', a and '"name": "pocket"' in a and b and '"n": 2' in b and '2 处差异' in text_of('.fx-diff-status'), (a, text_of('.fx-diff-status')))
shot('feature-diff')
js('(()=>{const s=document.querySelector(".fx-diff2 select.ui-select");s.value="upper";s.dispatchEvent(new Event("change",{bubbles:true}));return 1})()'); wait(0.5)
check('文本处理：转大写', '"NAME": "POCKET"' in (cm_text(0) or ''), cm_text(0))
cm_type(1, cm_text(0) or ''); wait(0.6)
check('两边一样时提示完全相同', '完全相同' in text_of('.fx-diff-status'), text_of('.fx-diff-status'))
press('Escape'); wait(0.3)

# --- 代码草稿
typed(''); open_feature('scratch', 1.0)
check('scratch 打开代码草稿页', wait_for('!!document.querySelector(".fx-scratch")', 6))
langs={l['id']:l for l in (js('mygo.call("Scratch.Languages")') or [])}
check('列出语言和本机能运行的环境', 'python' in langs and 'go' in langs and langs['sql'].get('tool','')=='' and langs['go'].get('formatter')=='gofmt', {k:v.get('tool') for k,v in langs.items()})
click_text('.fx-scratch-quick .ui-btn', 'Python'); wait(1.0)
check('新建草稿带示例代码', os.path.exists(os.path.join(HOME,'scratches','scratch.py')) and '你好，Pocket' in (cm_text(0) or ''), cm_text(0))
if langs.get('python',{}).get('tool'):
    click_text('.fx-scratch-main .fx-toolbar .ui-btn', '运行')
    ok=wait_for('!!document.querySelector(".fx-scratch-exit")', 15)
    check('直接运行并显示输出', ok and '你好，Pocket' in text_of('.fx-scratch-log') and '运行完成' in text_of('.fx-scratch-exit'), (text_of('.fx-scratch-log'), text_of('.fx-scratch-exit')))
    cm_type(0, 'import sys\nprint("in:", sys.stdin.readline().strip())\nsys.exit(3)\n'); wait(0.3)
    click_text('.fx-scratch-out .ui-btn', '输入'); wait(0.3); fill('.fx-scratch-stdin', 'abc\n')
    click_text('.fx-scratch-main .fx-toolbar .ui-btn', '运行')
    ok=wait_for('(document.querySelector(".fx-scratch-exit")||{}).innerText?.includes("退出码")', 15)
    check('标准输入和退出码', ok and 'in: abc' in text_of('.fx-scratch-log') and '退出码 3' in text_of('.fx-scratch-exit'), (text_of('.fx-scratch-log'), text_of('.fx-scratch-exit')))
    shot('feature-scratch')
else:
    soft('这台电脑上没有 Python，跳过运行检查', False)
p=js('mygo.call("Scratch.New","go")'); js('mygo.call("Scratch.Write",%s,%s)' % (json.dumps(p), json.dumps('package main\nfunc main(){\nprintln( 1 )}\n')))
r=js('mygo.call("Scratch.Format","go",%s)' % json.dumps('package main\nfunc main(){\nprintln( 1 )}\n'))
check('后端格式化 Go', r and '\tprintln(1)' in r, r)
cm_type(0, '{"a":1,"b":[1,2]}'); wait(0.2)
js('mygo.call("Scratch.Rename","scratch.py","data.json")'); wait(0.2)
press('Escape'); wait(0.3); typed(''); open_feature('scratch', 1.2)
files=texts('.fx-scratch .fx-side-name'); check('草稿一直留着，重新打开还在', 'data.json' in files and 'scratch.go' in files, files)
click_text('.fx-scratch .fx-side-name', 'data.json'); wait(0.8)
cm_type(0, '{"a":1,"b":[1,2]}'); wait(0.3)
click_text('.fx-scratch-main .fx-toolbar .ui-btn', '格式化'); wait(1.5)
check('按语言格式化（JSON）', '"a": 1' in (cm_text(0) or ''), cm_text(0))
press('Escape'); wait(0.3); typed('')

# ================= 第七轮：连点器、键盘宏、按键测试 =================
def key_event(kind, code, k='', win=None, **mods):
    return js('(()=>{const e=new KeyboardEvent(%s,%s);window.dispatchEvent(e);return e.defaultPrevented})()' % (json.dumps(kind), json.dumps(dict(key=k or code, code=code, bubbles=True, cancelable=True, **mods))), win)

# 先把输入换成只记录的假实现；没换上就不测，绝不发真实的点击和按键。
fake=js('mygo.call("E2E.FakeInput")')
check('连点器和宏在测试里用假输入', fake is True, fake)
if fake is True:
    # --- 鼠标连点器
    show(); open_feature('连点器', 0.8)
    check('打开连点器页面', wait_for('!!document.querySelector(".fx-auto")', 5))
    st=js('mygo.call("Auto.State")') or {}
    check('默认不占用任何全局快捷键', st.get('clicker',{}).get('hotkey','')=='' and st.get('clicker',{}).get('failsafe') is True, st.get('clicker'))
    js('mygo.call("Auto.SaveClicker",%s)' % json.dumps(dict(st['clicker'], button='right', kind='double', intervalMs=3, intervalMaxMs=9, stopMode='count', count=6, position='fixed', x=200, y=300, jitter=4, startDelaySec=0, failsafe=True)))
    press('Escape'); wait(0.3); open_feature('连点器', 0.8)
    check('设置保存后重新打开还在', '右键' in text_of('.fx-auto .ui-seg .is-active, .fx-auto .ui-seg [aria-checked=true], .fx-auto .ui-seg [aria-pressed=true]') or js('mygo.call("Auto.State").then(s=>s.clicker.button)')=='right')
    js('mygo.call("E2E.InputLog")')
    click_text('.fx-auto-bar .ui-btn', '开始')
    ok=wait_for('document.querySelector(".fx-auto-status").innerText.includes("点完了 6 次")', 6)
    log=js('mygo.call("E2E.InputLog")') or []
    check('点够次数后自动停下', ok, text_of('.fx-auto-status'))
    check('双击 6 次：12 下按下、12 下松开，都先移到固定位置附近', sum(1 for x in log if x.startswith('right true'))==12 and sum(1 for x in log if x.startswith('right false'))==12 and sum(1 for x in log if x.startswith('move '))==6 and all(196<=int(x[5:].split(',')[0])<=204 for x in log if x.startswith('move ')), log[:6])
    js('mygo.call("Auto.SaveClicker",%s)' % json.dumps(dict(st['clicker'], kind='single', intervalMs=20, stopMode='manual', startDelaySec=0, failsafe=False)))
    js('mygo.call("Auto.StartClicker")'); wait(0.5)
    check('运行时显示次数和停止按钮', wait_for('!!document.querySelector(".fx-auto-status.is-running")', 2) and '停止' in text_of('.fx-auto-bar .ui-btn'), text_of('.fx-auto-bar'))
    shot('feature-clicker')
    click_text('.fx-auto-bar .ui-btn', '停止'); wait(0.5)
    st2=js('mygo.call("Auto.State")') or {}
    log=js('mygo.call("E2E.InputLog")') or []
    check('手动停止，按下和松开成对', not st2['status']['running'] and st2['status'].get('note')=='已停止' and len(log)>4 and sum(1 for x in log if 'true' in x)==sum(1 for x in log if 'false' in x), st2.get('status'))
    press('Escape'); wait(0.3)

    # --- 键盘宏
    typed(''); open_feature('键盘宏', 0.8)
    check('打开键盘宏页面', wait_for('!!document.querySelector(".fx-macro")', 5))
    click('.fx-scratch-empty .ui-btn'); wait(0.9)
    check('新建宏', js('(document.querySelector(".fx-notes-title")||{}).value')=='新的宏', text_of('.fx-macro')[:60])
    click_text('.fx-macro .fx-toolbar .ui-btn', '按键 / 组合键'); wait(0.4)
    click('.fx-keycap'); wait(0.4)
    key_event('keydown','ControlLeft','Control',ctrlKey=True); key_event('keydown','KeyK','k',ctrlKey=True); wait(0.5)
    check('选按键：按着 Ctrl 再按 K 就是组合键', text_of('.fx-keycap')=='Ctrl + K', text_of('.fx-keycap'))
    click_text('.fx-macro .fx-toolbar .ui-btn', '录制'); wait(0.4)
    for c in ['KeyH','KeyI']:
        key_event('keydown',c,c[-1].lower()); wait(0.06); key_event('keyup',c,c[-1].lower()); wait(0.08)
    click_text('.fx-macro .fx-toolbar .ui-btn', '结束录制'); wait(0.9)
    kinds=texts('.fx-step-type'); caps=texts('.fx-keycap')
    check('录制：按过的键变成步骤，中间的停顿变成等待', caps[:3]==['Ctrl + K','H','I'] and '等待' in kinds, (kinds, caps))
    click_text('.fx-macro .fx-toolbar .ui-btn', '文字'); wait(0.3)
    fill('.fx-step-text', '你好 pocket'); wait(0.6)
    mid=js('mygo.call("Auto.State").then(s=>s.macros[0])') or {}
    check('宏自动保存', mid.get('id') and [s['type'] for s in mid.get('steps',[])][0]=='key' and mid['steps'][0]['keys']==['ControlLeft','KeyK'] and mid['steps'][-1].get('text')=='你好 pocket', mid.get('steps'))
    js('mygo.call("Auto.SaveMacro",%s)' % json.dumps(dict(mid, loops=2, startDelaySec=0, speed=10))); wait(0.3)
    js('mygo.call("E2E.InputLog")')
    js('mygo.call("Auto.RunMacro",%s)' % json.dumps(mid.get('id')))
    done=wait_for('mygo.call("Auto.State").then(s=>!s.status.running&&(s.status.note||"").includes("执行完了 2 遍"))', 8)
    log=js('mygo.call("E2E.InputLog")') or []
    check('运行宏：组合键按顺序按下、倒序松开，文字原样输入，跑两遍', done and log[:4]==['key ControlLeft true','key KeyK true','key KeyK false','key ControlLeft false'] and log.count('text 你好 pocket')==2 and log.count('key KeyH true')==2, log[:8])
    shot('feature-macro')
    bad=None
    try: js('mygo.call("Auto.SaveMacro",{"name":"坏的","steps":[{"type":"key","keys":[]}]})')
    except RuntimeError as e: bad=str(e)
    check('没选按键的步骤保存不了', bad is not None and '还没有选按键' in bad, bad)
    press('Escape'); wait(0.3)

# --- 按键测试
typed(''); open_feature('按键测试', 0.8)
check('打开按键测试页面', wait_for('document.querySelectorAll(".fx-key").length>=100', 5), js('document.querySelectorAll(".fx-key").length'))
p=key_event('keydown','KeyA','a'); p2=key_event('keydown','ShiftLeft','Shift',shiftKey=True); wait(0.3)
check('按下时图上对应的键亮起来', p and p2 and js('document.querySelectorAll(".fx-key.is-down").length')==2 and js('[...document.querySelectorAll(".fx-key.is-down span")].map(s=>s.innerText).sort().join()')=='A,Shift')
shot('feature-keytest')
key_event('keyup','KeyA','a'); key_event('keyup','ShiftLeft','Shift'); wait(0.2)
key_event('keydown','KeyA','a'); key_event('keyup','KeyA','a'); wait(0.3)
stats=texts('.fx-test-stats b')
check('松开后保留“测过”的标记，并统计次数', js('document.querySelectorAll(".fx-key.is-down").length')==0 and js('document.querySelectorAll(".fx-key.is-tested").length')==2 and stats[0]=='3' and stats[1].startswith('2 /') and stats[3]=='2', stats)
esc=key_event('keydown','Escape','Escape'); key_event('keyup','Escape','Escape'); wait(0.3)
check('测试时 Esc 也算按键，不会把页面关掉', esc and js('!!document.querySelector(".fx-inputtest")') and js('document.querySelectorAll(".fx-key.is-tested").length')==3)
click_text('.fx-inputtest .ui-seg button, .fx-inputtest .ui-seg *', '鼠标'); wait(0.5)
js('(()=>{const p=document.querySelector(".fx-mouse-pad");for(const b of [0,2]){p.dispatchEvent(new MouseEvent("mousedown",{button:b,bubbles:true,cancelable:true}));p.dispatchEvent(new MouseEvent("mouseup",{button:b,bubbles:true,cancelable:true}))}p.dispatchEvent(new MouseEvent("mousedown",{button:0,bubbles:true,cancelable:true}));p.dispatchEvent(new WheelEvent("wheel",{deltaY:-120,bubbles:true,cancelable:true}));return 1})()'); wait(0.4)
stats=texts('.fx-test-stats b')
check('鼠标：按键次数、滚轮和图上的按下状态', stats[0]=='2' and stats[2]=='1' and stats[5].startswith('1 /') and js('document.querySelectorAll(".fx-mouse-part.is-down").length')==1, stats)
check('两次按下间隔太短会提示疑似连击', '疑似连击' in text_of('.fx-test-notes'), text_of('.fx-test-notes'))
shot('feature-mousetest')
press('Escape'); wait(0.4)
check('切到鼠标页后 Esc 恢复正常', js('!document.querySelector(".fx-inputtest")'))
typed('')

# ================= 第八轮：扩展平台 =================
EXT=os.environ.get('POCKET_E2E_EXT','')
def ext_eval(code, win=None, timeout=8):
    """在扩展页面里面执行一段代码（只有测试构建允许）。"""
    return js('window.__pluginEval(%s)' % json.dumps(code), win)
def ext_error(code, win=None):
    try:
        ext_eval(code, win); return None
    except RuntimeError as e:
        return str(e)
def installed(): return {p['id']:p for p in (js('mygo.call("Extensions.List")') or [])}

# --- 自己写一个最小的扩展：一个页面、一份清单、一个后端脚本
demo=os.path.join(HOME,'ext-src','demo'); os.makedirs(demo, exist_ok=True)
json.dump({"id":"demo","name":"演示扩展","version":"0.3.0","api":1,
  "tools":[{"id":"demo","title":"演示工具","keywords":["demo"],"height":240,"matches":[{"type":"text","regex":"^ORD-\\d+$","label":"查这个订单"}]},
           {"id":"second","title":"第二个工具","keywords":["demo2"],"entry":"index.html#second"}],
  "permissions":{"dirs":["demo-notes"],"fetch":["example.com"]},
  "backend":{"command":["python3","backend.py"],"mode":"on-demand","idle":1}}, open(os.path.join(demo,'plugin.json'),'w'), ensure_ascii=False)
open(os.path.join(demo,'index.html'),'w').write('<!doctype html><meta charset="utf-8"><script src="/__pocket.js"></script><body><h1 id="t">demo</h1><script>pocket.onEnter(c=>{document.getElementById("t").textContent=c.tool+":"+c.input})</script>')
open(os.path.join(demo,'backend.py'),'w').write('import sys, json, os\nfor line in sys.stdin:\n    req = json.loads(line)\n    if req["method"] == "fail":\n        print(json.dumps({"id": req["id"], "error": "故意失败"}), flush=True)\n    else:\n        print(json.dumps({"id": req["id"], "result": {"echo": req["params"], "pid": os.getpid(), "plugin": os.environ.get("POCKET_PLUGIN_ID")}}), flush=True)\n')
import shutil, zipfile
zpath=os.path.join(HOME,'demo-0.3.0.zip')
with zipfile.ZipFile(zpath,'w') as z:
    for n in os.listdir(demo): z.write(os.path.join(demo,n), 'demo/'+n)   # 包里多套一层文件夹，也要能装

check('一开始没有装任何扩展包', 'demo' not in installed() and 'pet' not in installed())
info=js('mygo.call("Extensions.Install",%s)' % json.dumps(zpath)) or {}
check('从 zip 安装扩展', info.get('id')=='demo' and info.get('version')=='0.3.0' and info.get('tools')==['演示工具','第二个工具'] and info.get('backend') is True and os.path.exists(os.path.join(HOME,'plugins','demo','plugin.json')), info)
bad=os.path.join(HOME,'evil.zip')
with zipfile.ZipFile(bad,'w') as z: z.writestr('../../escaped.txt','x'); z.writestr('plugin.json','{}')
err=None
try: js('mygo.call("Extensions.Install",%s)' % json.dumps(bad))
except RuntimeError as e: err=str(e)
check('路径不安全的包装不上', err is not None and '不安全' in err and not os.path.exists(os.path.join(HOME,'escaped.txt')), err)

show(); typed('demo 带进来的字'); wait(0.4); r=rows(); check('扩展的工具出现在搜索里', r[:1]==['演示工具'], r[:3])
press('Enter'); wait(0.8)
ok=wait_for('!!window.__pluginEval', 5) and wait_for('window.__pluginEval("!!(window.pocket&&pocket.context)")', 8)
check('打开扩展页面，宿主接口就绪', ok)
c=ext_eval('pocket.context') or {}
check('进入时带上了工具名和输入的内容', c.get('tool')=='demo' and c.get('input')=='带进来的字' and c.get('plugin')=='demo' and c.get('platform')=='darwin', c)
check('页面的进入回调被调用', ext_eval('document.getElementById("t").textContent')=='demo:带进来的字')
check('外观属性传给了扩展页面', ext_eval('document.documentElement.getAttribute("data-theme")') in ('light','dark'))
# 文件：私有目录不用声明，声明过的用户目录可以用，其余的拒绝
p=ext_eval('pocket.fs.createFile("", "", "a.txt", "你好")')
check('私有目录读写', p=='a.txt' and ext_eval('pocket.fs.read("", "a.txt")')=='你好' and os.path.exists(os.path.join(HOME,'data','plugins','demo-files','a.txt')), p)
ext_eval('pocket.fs.write("demo-notes", "x.md", "# hi")')
check('声明过的用户目录可以读写', open(os.path.join(HOME,'demo-notes','x.md')).read()=='# hi')
e1=ext_error('pocket.fs.tree("notes")'); e2=ext_error('pocket.fs.read("", "../../config.json")'); e3=ext_error('pocket.fs.write("commands", "x.sh", "rm -rf")')
check('没声明的目录、跳出目录的路径、应用自己的目录都被拒绝', all(x is not None for x in (e1,e2,e3)) and '没有声明' in e1, (e1,e2,e3))
e4=ext_error('pocket.fetch("https://not-declared.example.org/")'); e5=ext_error('pocket.fetch("http://127.0.0.1:1/")'); e6=ext_error('pocket.runner.languages()')
check('没声明的域名、本机地址、没声明的代码运行权限都被拒绝', all(x is not None and '没有声明' in x for x in (e4,e5,e6)), (e4,e5,e6))
ext_eval('pocket.storage.set("k", {"n": 1})'); check('扩展自己的存储', ext_eval('pocket.storage.get("k")')=={'n':1})
# 后端进程：按需拉起、闲置自动关、再调用重新拉起
check('没调用过后端时进程没有启动', js('mygo.call("E2E.BackendRunning","demo")') is False)
b1=ext_eval('pocket.backend.call("echo", "hi", 2)') or {}
check('调用后端程序', b1.get('echo')==['hi',2] and b1.get('plugin')=='demo' and js('mygo.call("E2E.BackendRunning","demo")') is True, b1)
b2=ext_eval('pocket.backend.call("echo")') or {}
check('接着调用用的是同一个进程', b2.get('pid')==b1.get('pid'), (b1.get('pid'), b2.get('pid')))
check('后端报的错原样传回页面', '故意失败' in (ext_error('pocket.backend.call("fail")') or ''))
wait(2.4)
check('闲置后进程自动关掉，不占资源', js('mygo.call("E2E.BackendRunning","demo")') is False)
b3=ext_eval('pocket.backend.call("echo")') or {}
check('再调用时重新拉起', b3.get('pid') and b3.get('pid')!=b1.get('pid') and js('mygo.call("E2E.BackendRunning","demo")') is True, b3)
press('Escape'); wait(0.3)
# 带入内容匹配
js('mygo.call("E2E.Summon","ORD-12345")'); wait(0.9)
r=rows(); subs=js('[...document.querySelectorAll(".pk-row")].map(r=>(r.querySelector(".pk-row-subtitle")||{}).innerText||"")') or []
check('选中的文字符合规则时，扩展出现在候选里', '演示工具' in r and '查这个订单' in subs, (r[:5], subs[:5]))
press('Backspace'); wait(0.3); typed('')
# 停用：搜不到，后端被结束；卸载：文件夹没了
js('mygo.call("Extensions.SetEnabled","demo",false)'); wait(0.6)
typed('demo'); wait(0.4); r=rows()
check('停用后搜不到，后端进程被结束', '演示工具' not in r and js('mygo.call("E2E.BackendRunning","demo")') is False and installed()['demo']['enabled'] is False, r[:3])
js('mygo.call("Extensions.SetEnabled","demo",true)'); wait(0.6); typed('demo2'); wait(0.4); r=rows()
check('启用后回来了，一个扩展可以有多个工具', r[:1]==['第二个工具'], r[:3])
js('mygo.call("Extensions.Uninstall","demo",false)'); wait(0.6); typed('demo'); wait(0.4); r=rows()
check('卸载后文件夹删掉，存的设置按选择保留', '演示工具' not in r and not os.path.exists(os.path.join(HOME,'plugins','demo')) and os.path.exists(os.path.join(HOME,'data','plugins','demo.json')) and os.path.exists(os.path.join(HOME,'demo-notes','x.md')), r[:3])
typed('')

# --- 桌面宠物：现在是一个扩展包
petzip=os.path.join(EXT,'pet-1.0.0.zip')
if not os.path.exists(petzip):
    check('找到宠物扩展包', False, petzip)
else:
    info=js('mygo.call("Extensions.Install",%s)' % json.dumps(petzip)) or {}
    check('安装宠物扩展', info.get('id')=='pet' and info.get('backend') is False and window_by('float.html') is None, info)
    typed('宠物'); wait(0.4); r=rows(); check('搜索框里能找到它', '桌面宠物' in r[:2], r[:3])
    press('Enter'); wait(2.5)
    pw=window_by('float.html'); check('回车后出现悬浮窗', pw is not None and not visible())
    if pw:
        pid=pw['id']
        ok=wait_for('!!window.__pluginEval', 6, pid) and wait_for('window.__pluginEval("!!(window.__pet&&window.__pet.game())")', 12, pid)
        check('3D 场景和存档加载出来', ok)
        g=ext_eval('window.__pet.game()', pid) or {}
        check('新领养：四项状态、等级、金币，当天签到领了见面礼', g.get('level')==1 and g.get('days')==1 and g.get('coins',0)>=45 and all(0<g.get(k,0)<=100 for k in ['hunger','mood','energy','clean']), g)
        wait(1.0); shot('pet', pid)
        h0=g['hunger']; ext_eval('window.__pet.feed("riceball");1', pid); wait(0.6)
        g=ext_eval('window.__pet.game()', pid); act=ext_eval('window.__pet.pose().action', pid)
        check('喂食：饱腹上升、背包减少、做出吃东西的动作', g['hunger']>h0 and g['food'].get('riceball')==0 and act=='eat', (g['hunger'], act))
        ext_eval('window.__pet.play("pet");1', pid); wait(0.4)
        check('抚摸：开心地跳', ext_eval('window.__pet.pose().action', pid)=='happy')
        s0=js('[innerWidth,innerHeight]', pid)
        ext_eval('document.querySelector(".pet-root").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}));1', pid); wait(0.9)
        s1=js('[innerWidth,innerHeight]', pid)
        check('右键打开面板，窗口变大', ext_eval('!!document.querySelector(".pet-panel")', pid) and s1[1]>s0[1]+150, (s0,s1))
        shot('pet-panel', pid)
        ext_eval('[...document.querySelectorAll(".pet-tabs button")].find(b=>b.innerText=="商店").click();1', pid); wait(0.4)
        c0=ext_eval('window.__pet.game().coins', pid)
        ext_eval('[...document.querySelectorAll(".pet-shop > div")].find(d=>d.innerText.includes("苹果")).querySelector("button").click();1', pid); wait(0.4)
        g=ext_eval('window.__pet.game()', pid)
        check('商店：买苹果扣金币、进背包', g['coins']==c0-3 and g['food']['apple']==3, (c0, g['coins']))
        ext_eval('document.querySelector(".pet-close").click();1', pid); wait(0.8)
        check('收起面板，窗口变回去', js('[innerWidth,innerHeight]', pid)[1]<s1[1])
        m1=ext_eval('pocket.window.move(40,0)', pid); m2=ext_eval('pocket.window.move(-40,0)', pid)
        check('可以在屏幕范围里走动', m1 and m2 and m1['x']-m2['x']==40, (m1,m2))
        wait(0.4)
        saved=os.path.join(HOME,'data','plugins','pet.json')
        check('存档在扩展自己的存储里', os.path.exists(saved) and json.load(open(saved)).get('state',{}).get('stats',{}).get('fed')==1)
        ext_eval('pocket.window.close();1', pid); wait(1.0)
        check('收起来：窗口关闭', window_by('float.html') is None)
        show(); typed('宠物'); press('Enter'); wait(2.5)
        pw=window_by('float.html')
        ok=pw and wait_for('!!window.__pluginEval', 6, pw['id']) and wait_for('window.__pluginEval("!!(window.__pet&&window.__pet.game())")', 12, pw['id'])
        g=ext_eval('window.__pet.game()', pw['id']) if ok else {}
        check('再叫出来接着养：存档还在，当天不重复签到', ok and g.get('stats',{}).get('fed')==1 and g.get('days')==1 and g['food'].get('apple')==3, g)
        js('mygo.call("Extensions.SetEnabled","pet",false)'); wait(1.0)
        check('停用扩展：悬浮窗跟着关掉', window_by('float.html') is None)
        js('mygo.call("Extensions.SetEnabled","pet",true)'); wait(2.2)
        check('重新启用：上次开着的悬浮窗回来了', window_by('float.html') is not None)
        js('mygo.call("Extensions.Uninstall","pet",true)'); wait(1.0)
        show(); typed('宠物'); wait(0.4); r=rows()
        check('卸载：窗口、文件夹、存档都没了，搜索里也没有', window_by('float.html') is None and not os.path.exists(os.path.join(HOME,'plugins','pet')) and not os.path.exists(saved) and '桌面宠物' not in r, r[:3])
        typed('')

# ================= 道具库 =================
js('mygo.call("Settings.OpenCatalog")', panel_id()); wait(1.6)
cw=window_by('catalog.html'); check('打开道具库窗口', cw is not None)
if cw:
    n=js('document.querySelectorAll(".ct-card").length', cw['id']); check('道具库列出全部功能', n and n>40, n)
    op=js('getComputedStyle(document.querySelector(".ct-card")).opacity', cw['id']); check('道具库的卡片是可见的', op=='1', op)
    cats=texts('.ct-nav .st-nav span', cw['id']); check('按分类展示', '效率工具' in cats and '开发工具' in cats and '脚本命令' in cats and '网页插件' in cats, cats)
    shot('catalog', cw['id'])
    fill('.ct-search input', 'md5', cw['id']); wait(0.3)
    found=texts('.ct-card b', cw['id']); check('道具库按关键词搜索', '哈希计算' in found, found)
    js('[...document.querySelectorAll(".st-nav")].find(b=>b.innerText.includes("开发工具")).click();1', cw['id']); wait(0.3)
    fill('.ct-search input', '', cw['id']); wait(0.3)
    check('按分类筛选', all(c=='开发工具' for c in texts('.ct-section h2', cw['id'])))
    js('mygo.call("Catalog.SetEnabled","features:regex",false)', cw['id']); wait(0.4)
    show(); typed('regex'); check('停用后搜不到', '正则测试' not in rows())
    js('mygo.call("Catalog.SetEnabled","features:regex",true)', cw['id']); wait(0.4)
    typed('regex'); check('重新启用', '正则测试' in rows())
    js('setTimeout(()=>mygo.call("Windows.Control","close",0),30);1', cw['id']); wait(0.4)

# 设置：翻译与识别分区
js('mygo.call("Launcher.OpenSettings","translate")', panel_id()); wait(1.4)
st=window_by('settings.html')
if st:
    check('设置里有翻译与识别', '翻译服务' in (js('document.querySelector(".st-content")?.innerText||""', st['id']) or ''))
    # 在自己的设置窗口里选中一段文字，用辅助功能接口读回来（只读，不发按键）
    js('(()=>{const i=[...document.querySelectorAll(".st-input.is-mono")].find(x=>x.value);i.focus();i.select();return i.value})()', st['id']); wait(0.5)
    ax=js('mygo.call("E2E.Selection")', st['id']) or {}
    if ax.get('trusted'):
        check('通过辅助功能读到选中的文字', ax.get('ok') and ax.get('text')=='claude-opus-5-5', ax)
    else:
        print('    没有辅助功能权限，跳过读取选中文字的检查')
    js('mygo.call("Launcher.OpenSettings","general")', panel_id()); wait(0.6)
    # --- 录快捷键：按 Alt 不会被打断，录的时候全局热键暂停，还可以手动输入
    def key(kind, code, k, win, **mods):
        return js('(()=>{const e=new KeyboardEvent(%s,%s);window.dispatchEvent(e);return e.defaultPrevented})()' % (json.dumps(kind), json.dumps(dict(key=k, code=code, bubbles=True, cancelable=True, **mods))), win)
    sid=st['id']
    js('document.querySelector(".st-hotkey").click();1', sid); wait(0.4)
    check('开始录制时暂停全局热键', js('mygo.call("E2E.HotkeysSuspended")', sid)==True)
    p1=key('keydown','AltLeft','Alt',sid,altKey=True); p2=key('keyup','AltLeft','Alt',sid)
    check('单按 Alt：按下和松开都被拦住，还在录', p1 and p2 and '按下快捷键' in (js('document.querySelector(".st-hotkey").innerText', sid) or ''), (p1,p2))
    key('keydown','AltLeft','Alt',sid,altKey=True); key('keydown','KeyJ','j',sid,altKey=True); wait(0.9)
    hk=js('mygo.call("Settings.Get").then(v=>v.config.hotkey)', sid)
    check('录下 Alt+J', hk=='Alt+J', hk)
    check('录完恢复全局热键', js('mygo.call("E2E.HotkeysSuspended")', sid)==False)
    js('[...document.querySelectorAll(".st-hotkey-wrap .st-link")].find(b=>b.innerText.trim()=="手动输入").click();1', sid); wait(0.3)
    fill('.st-hotkey-text', 'space + alt', sid)
    js('document.querySelector(".st-hotkey-text").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));1', sid); wait(0.9)
    hk=js('mygo.call("Settings.Get").then(v=>v.config.hotkey)', sid)
    check('手动输入 space + alt，整理成 Alt+Space', hk=='Alt+Space', hk)
    js('[...document.querySelectorAll(".st-hotkey-wrap .st-link")].find(b=>b.innerText.trim()=="手动输入").click();1', sid); wait(0.3)
    fill('.st-hotkey-text', 'j', sid)
    js('document.querySelector(".st-hotkey-text").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));1', sid); wait(0.4)
    check('没有修饰键的写法被拒绝', js('!!document.querySelector(".st-hotkey-text.is-invalid")', sid))
    js('[...document.querySelectorAll(".st-hotkey-wrap .st-link")].find(b=>b.innerText.trim()=="取消").click();1', sid); wait(0.3)
    shot('settings-general', st['id'])
    shot('settings-translate', st['id'])
    js('setTimeout(()=>mygo.call("Windows.Control","close",0),30);1', st['id']); wait(0.4)

# --- 退出：主窗口平时拦截关闭（隐藏而不是销毁），但不能挡住退出
typed('退出 Yojigen Pocket'); r=rows(); check('退出命令可搜到', r[:1]==['退出 Yojigen Pocket'], r[:3])
try:
    press('Enter')
except (RuntimeError, OSError, ValueError):
    pass  # 应用已经在退出，连接断开是正常的
gone=False; t=time.time()
while time.time()-t<5:
    try:
        windows()
    except (RuntimeError, OSError, ValueError):
        gone=True; break
    time.sleep(0.2)
check(f'退出命令真的让应用退出（{time.time()-t:.1f}s）', gone)

print('\nFAILED:' if fails else '\nALL OK', fails or '')
sys.exit(1 if fails else 0)
