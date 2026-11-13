import { useEffect, useState } from "preact/hooks";
import { Settings } from "../mygo";
import type { SectionProps } from "./app";
import { Button, Hotkey, NumberInput, Row, Section, Segmented, Slider, Text, Toggle } from "./ui";

export function General({ view, info, config, update }: SectionProps) {
  const [openAtLogin, setOpenAtLogin] = useState(view.openAtLogin);
  const [loginError, setLoginError] = useState("");
  useEffect(() => setOpenAtLogin(view.openAtLogin), [view.openAtLogin]);
  const [trusted, setTrusted] = useState(true);
  const [reset, setReset] = useState(false);
  useEffect(() => {
    void Settings.permissions().then((p) => setTrusted(!!p.accessibility));
  }, []);
  const mac = info.platform === "darwin";
  const selectionModes: { value: string; label: string }[] = mac
    ? [
        { value: "off", label: "关闭" },
        { value: "accessibility", label: "只读取" },
        { value: "auto", label: "读取 + 模拟复制" },
      ]
    : [
        { value: "off", label: "关闭" },
        { value: "auto", label: "开启" },
      ];

  return (
    <>
      <Section>
        <Row label="唤出快捷键" description="在任何地方按下它，打开或隐藏主窗口" error={view.hotkeyErrors?.main}>
          <Hotkey value={config.hotkey} platform={info.platform} onChange={(v) => update((c) => (c.hotkey = v))} />
        </Row>
        <Row label="开机时启动" description="登录系统后在后台运行" error={loginError}>
          <Toggle
            label="开机时启动"
            checked={openAtLogin}
            onChange={(v) => {
              setOpenAtLogin(v);
              Settings.setOpenAtLogin(v).then(
                () => setLoginError(""),
                (err: Error) => {
                  setOpenAtLogin(!v);
                  setLoginError(err.message);
                },
              );
            }}
          />
        </Row>
        <Row label="分离窗口快捷键" description="在功能页里按下，把它拆成一个独立窗口（会出现在任务栏 / 程序坞里）">
          <Hotkey value={config.keys.detach} platform={info.platform} onChange={(v) => update((c) => (c.keys.detach = v))} />
        </Row>
        <Row label="失去焦点时隐藏" description="点到别的窗口，主窗口自动收起">
          <Toggle label="失去焦点时隐藏" checked={config.hideOnBlur} onChange={(v) => update((c) => (c.hideOnBlur = v))} />
        </Row>
      </Section>

      <Section title="窗口位置" description="按住搜索框的空白处、标题栏或底栏，可以把窗口拖到任何地方。">
        <Row label="主窗口出现的位置">
          <Segmented
            value={config.panelPosition}
            options={[
              { value: "remember", label: "记住拖动后的位置" },
              { value: "center", label: "每次居中" },
            ]}
            onChange={(v) => update((c) => (c.panelPosition = v))}
          />
        </Row>
        <Row label="回到屏幕中间" description="忘掉拖动过的位置">
          <Button
            onClick={() => {
              void Settings.resetPanelPosition();
              setReset(true);
            }}
          >
            {reset ? "已复位" : "复位"}
          </Button>
        </Row>
      </Section>

      <Section title="带入内容" description="带进来的文字、图片会变成搜索框里的一个块：直接回车照常搜索，在块后面输入功能名（翻译、md5、识别……）就用那个功能处理它，按退格键把块变回文字继续编辑。">
        <Row
          label="带入选中的文字"
          description={
            mac
              ? "唤出主窗口、或按功能的快捷键时，把当前选中的文字带进来。「只读取」通过辅助功能读，不碰剪贴板，但部分应用读不到；「读取 + 模拟复制」在读不到时替你按一次 ⌘C，读完把剪贴板恢复原样"
              : "唤出主窗口、或按功能的快捷键时，替你按一次 Ctrl+C 读取选中的文字，读完把剪贴板恢复原样"
          }
          error={mac && !trusted && config.selection.mode !== "off" ? "需要辅助功能权限才能读取：在「关于 → 环境检查」里授权" : undefined}
        >
          <Segmented value={mac || config.selection.mode === "off" ? config.selection.mode : "auto"} options={selectionModes} onChange={(v) => update((c) => (c.selection.mode = v))} />
        </Row>
        <Row label="带入刚复制的内容" description="唤出时把这段时间内复制的文字、图片或文件带进来，每次复制只带一次；0 为关闭">
          <Slider value={config.autoFillSeconds} min={0} max={30} unit=" 秒" onChange={(v) => update((c) => (c.autoFillSeconds = v))} />
        </Row>
      </Section>

      <Section title="输入">
        <Row label="保留上次输入" description="隐藏后这段时间内再次唤出，输入框内容还在">
          <Slider value={config.rememberSeconds} min={0} max={60} unit=" 秒" onChange={(v) => update((c) => (c.rememberSeconds = v))} />
        </Row>
      </Section>

      <Section title="结果">
        <Row label="最多显示" description="一次查询最多列出多少条">
          <NumberInput value={config.maxResults} min={10} max={200} onChange={(v) => update((c) => (c.maxResults = v))} />
        </Row>
        <Row label="使用习惯的半衰期" description="多久没用，一个结果的排序加分就减半">
          <Slider value={config.halfLifeDays} min={1} max={90} unit=" 天" onChange={(v) => update((c) => (c.halfLifeDays = v))} />
        </Row>
      </Section>

      <Section title="编辑器">
        <Row label="打开脚本用的编辑器" description="命令行写法，例如 code 或 subl；留空用系统默认">
          <Text value={config.editor ?? ""} width={200} placeholder="系统默认" mono onChange={(v) => update((c) => (c.editor = v))} />
        </Row>
      </Section>
    </>
  );
}
