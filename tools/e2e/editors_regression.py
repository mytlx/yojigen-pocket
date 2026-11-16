#!/usr/bin/env python3
"""单独运行原有编辑器回归，避免无关平台功能中断编辑器验证。"""
from pathlib import Path
flow = Path(__file__).with_name('flow.py').read_text()
exec(flow[:flow.index('\nshow()\n# --- 计算器')])
show()
exec(flow[flow.index('def ejs('):flow.index('# ================= 第七轮')])
print('\nFAILED:', fails)
sys.exit(1 if fails else 0)
