"""Native test of an assembled local game package (see docs/mario3.md)."""
from pathlib import Path
repo = Path.cwd()
source = Path(__file__).with_name('flow.py').read_text()
exec(source.split('\nshow()\n# --- 计算器')[0])
exec(source[source.index('def ejs('):source.index('\nedzip=')])
show()
package = str(repo / 'build/local/mario3-1.1.3.zip')
assert js('mygo.call("Extensions.Install",%s)' % json.dumps(package))['id'] == 'mario3'
def open_game():
    for _ in range(3):
        open_feature('mario3', 1)
        for _ in range(15):
            if window_by('p=mario3'):
                return
            wait(.2)
        show()
    raise AssertionError("game window did not open")
open_game()
w = window_by('p=mario3')['id']
assert ewait_for('document.querySelector("#open")?.textContent==="开始游戏"', 6, w)
# Exercise the real extension document at several content viewport sizes.
assert ewait_for('document.querySelectorAll("#guide span").length===9', 5, w)
style=js('document.querySelector("iframe").style.cssText',w)
for width,height in [(1080,760),(720,480),(460,340)]:
    js('document.querySelector("iframe").style.cssText+=";position:fixed;inset:0;width:%dpx;height:%dpx;max-width:none;max-height:none";true' % (width,height),w)
    for large in (False,True):
        if large: eclick('#large',w)
        assert ewait_for("""innerWidth===%d && innerHeight===%d &&
            document.documentElement.scrollHeight===innerHeight &&
            document.body.scrollHeight===innerHeight &&
            document.querySelector(".screen").clientHeight>0 &&
            [...document.querySelectorAll("#guide span,.toolbar button")].every(el=>{
                const r=el.getBoundingClientRect();return r.width>0 && r.left>=0 &&
                r.right<=innerWidth+0.5 && r.top>=0 && r.bottom<=innerHeight+0.5
            })""" % (width,height),4,w), (width,height,large)
        if large: eclick('#large',w)
js('document.querySelector("iframe").style.cssText=%s;true'%json.dumps(style),w)
print("PASS: keyboard guide and toolbar fit all three viewports in both display modes")
# A locked macOS session suspends WKWebView animation callbacks. In that
# environment the test driver supplies frame timestamps to the same game loop.
def setup_clock(w):
    if ejs('document.hidden',w):
        ejs('window.testNow=performance.now();window.requestAnimationFrame=cb=>(window.testFrame=cb,1);window.cancelAnimationFrame=()=>{window.testFrame=null};true',w)
def advance(w, count):
    ejs('if(window.testNow){testNow=Math.max(testNow,performance.now());for(let i=0;i<%d;i++){testNow+=1000/60;window.testFrame?.(testNow)}};true'%count,w)
setup_clock(w)
ejs('window.framesDrawn=0;window.colors=0;const ctx=document.querySelector("canvas").getContext("2d"), put=ctx.putImageData.bind(ctx);ctx.putImageData=(image,...args)=>{framesDrawn++;if(framesDrawn%10===0)window.colors=Math.max(window.colors,new Set(new Uint32Array(image.data.buffer)).size);put(image,...args)};true',w)
eclick('#open', w)
assert ewait_for('document.querySelector("#status").textContent.startsWith("运行中")', 6, w)
advance(w,330)
# The curtain intro and title screen are rendered by the assembled game itself.
assert ewait_for('window.colors>3', 18, w), (etext_of("#status",w),ejs("[framesDrawn,colors,document.hidden,document.hasFocus()]",w))
wait(4)
shot('smb3-title', w)
def key(code):
    for event in ('keydown','keyup'):
        ejs('document.querySelector(".screen").dispatchEvent(new KeyboardEvent(%s,{code:%s,bubbles:true,cancelable:true}))' % (json.dumps(event),json.dumps(code)),w)
        wait(.15)
for _ in range(3):
    key('Enter')
    wait(1.2)
assert not etext_of('#error',w)
shot('smb3-play',w)
eclick('#pause',w)
assert ewait_for('document.querySelector("#status").textContent.startsWith("已暂停")',5,w)
frame=ejs("framesDrawn",w)
wait(.2)
assert frame==ejs("framesDrawn",w)
print('PASS: assembled SMB3, offline launch, framebuffer, controller input, pause')

eclick('#settings',w)
eclick('#bindings button',w)
key('KeyJ')
assert ewait_for('document.querySelector("#bindings button").textContent.endsWith("J")',4,w)
eclick('#close',w)
assert ewait_for('document.querySelector("#status").textContent.startsWith("运行中")',5,w)
eclick('#pause',w)
old=ejs('document.querySelector(".screen").clientHeight',w)
eclick('#large',w)
assert ejs('document.querySelector(".screen").clientHeight',w)>old
eclick('#save',w)
assert ewait_for('document.querySelector("#save").textContent.includes("已保存")',15,w), etext_of('#saved',w)
slot=ejs('pocket.fs.tree("").then(a=>a.find(f=>f.path.startsWith("progress-")).path)',w)
read='pocket.fs.read("",%s).then(s=>JSON.parse(s).state.cpu)'%json.dumps(slot)
cpu=ejs(read,w)
assert cpu
# Upgrade using the very same tested game payload and a higher test-only manifest version.
import zipfile
upgrade=os.path.abspath('upgrade.zip')
with zipfile.ZipFile(package) as src, zipfile.ZipFile(upgrade,'w',zipfile.ZIP_DEFLATED) as out:
    for entry in src.namelist():
        raw=src.read(entry)
        if entry=='plugin.json':
            manifest=json.loads(raw);manifest['version']='1.1.4';raw=json.dumps(manifest).encode()
        out.writestr(entry,raw)
assert js('mygo.call("Extensions.Install",%s)'%json.dumps(upgrade))['version']=='1.1.4'
show();open_game()
w=window_by('p=mario3')['id']
assert ewait_for('document.querySelector("#guide")?.textContent.includes("J 跳跃")',5,w)
assert ejs(read,w)==cpu
# Reproduce a 1.1.0 save that was opened and saved again with an identity
# PPU lookup table. The next checkpoint should contain repaired aliases.
ejs('pocket.fs.read("",%s).then(raw=>{const s=JSON.parse(raw);s.state.ppu.vramMirrorTable=Array.from({length:32768},(_,i)=>i);return pocket.fs.write("",%s,JSON.stringify(s))})' % (json.dumps(slot),json.dumps(slot)),w)
setup_clock(w)
eclick('#open',w)
assert ewait_for('document.querySelector("#saved").textContent.includes("已恢复上次进度")',8,w), etext_of('#error',w)
wait(.4)
assert not etext_of('#error',w)
print('PASS: remap, large screen, saved CPU state preserved and restored across upgrade')
# Feed standard Web Gamepad readings and inspect the actual NES controller state.
ejs('window.testPad={id:"Virtual standard controller",connected:true,mapping:"standard",axes:[0.9,0],buttons:Array.from({length:16},(_,i)=>({pressed:i===0||i===12}))};Object.defineProperty(navigator,"getGamepads",{configurable:true,value:()=>window.testPad?[window.testPad]:[]});true',w)
advance(w,4)
wait(.3)
eclick('#save',w)
padread='pocket.fs.read("",%s).then(s=>JSON.parse(s).state.controllers[1].state)'%json.dumps(slot)
assert ewait_for(padread+'.then(b=>b[0]===65&&b[4]===65&&b[7]===65)',5,w)
assert ejs('pocket.fs.read("",%s).then(raw=>JSON.parse(raw).state.ppu.vramMirrorTable[0x3000]===0x2000)' % json.dumps(slot),w)
ejs('window.testPad=null;true',w)
advance(w,2)
assert ewait_for('document.querySelector("#status").textContent.startsWith("已暂停")',5,w)
eclick('#save',w)
assert ewait_for(padread+'.then(b=>b.every(v=>v===64))',5,w)
print("PASS: gamepad A, d-pad, left stick, disconnect releases input")

# Close the native window while playing and confirm the reopened game starts
# from a checkpoint newer than the preceding manual save.
def saved_time():
    return ejs('pocket.fs.read("",%s).then(s=>JSON.parse(s).time)' % json.dumps(slot),w)
previous=saved_time()
eclick('#pause',w)
advance(w,45)
wait(11)
assert saved_time()==previous, "unexpected periodic save"
eclick('#exit',w)
wait(.8)
show();open_game()
w=window_by('p=mario3')['id']
assert ewait_for('document.querySelector("#open")?.textContent==="开始游戏"',6,w)
eclick('#open',w)
assert ewait_for('document.querySelector("#saved").textContent.includes("已恢复")',8,w)
assert saved_time()>previous, "closing lost the final checkpoint"
print("PASS: no timer-based saves; final checkpoint restored after closing")
eclick('#restart',w)
assert ewait_for('document.querySelector("#restartDialog").open',3,w)
eclick('#restartDialog [value="cancel"]',w)
assert ewait_for('document.querySelector("#status").textContent.startsWith("运行中")',3,w)
eclick('#restart',w)
eclick('#restartDialog [value="restart"]',w)
assert ewait_for('document.querySelector("#saved").textContent==="已重新开始"',5,w), etext_of('#error',w)
assert ejs(read+'.then(cpu=>cpu.cycles===0)',w)
assert 'J 跳跃' in etext_of('#guide',w)
print("PASS: restart can be cancelled, confirmed restart replaces the private save with boot state and retains key bindings")
