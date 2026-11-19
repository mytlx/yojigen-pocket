import { pocket } from "../../sdk/pocket";
import {
  actions,
  bindings,
  bind,
  resetKeys,
  loadBindings,
  keyLabel,
  webPad,
  padKeys,
  type Pad,
} from "./controls";
import {
  persist,
  restore,
  replaceProgress,
  slot,
  flushed,
  type SnapshotMachine,
} from "./progress";
import "./style.css";

interface Machine extends SnapshotMachine {
  loadROM(data: Uint8Array): void;
  frame(): void;
  buttonDown(player: number, key: number): void;
  buttonUp(player: number, key: number): void;
}
declare const jsnes: {
  NES: new (options: {
    onFrame: (frame: Uint32Array) => void;
    onAudioSample: (l: number, r: number) => void;
    sampleRate: number;
  }) => Machine;
};
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const canvas = document.querySelector("canvas")!,
  screen = document.querySelector<HTMLElement>(".screen")!;
const ctx = canvas.getContext("2d", { alpha: false })!,
  pixels = ctx.createImageData(256, 240),
  rgba = new Uint32Array(pixels.data.buffer);
const load = el<HTMLButtonElement>("open"),
  pauseButton = el<HTMLButtonElement>("pause"),
  sound = el<HTMLButtonElement>("sound");
const cover = el("cover"),
  status = el("status"),
  error = el("error");
const keyboard = new Set<number>();
let sent = new Set<number>(),
  slotName = "",
  dirty = false,
  saveSequence = 0;
let lastPad = "",
  padAttached = false;
const dialog = el<HTMLDialogElement>("controls"),
  save = el<HTMLButtonElement>("save");
let capture = -1,
  changing = false;
function note(msg: string) {
  el("saved").textContent = msg;
}
async function checkpoint(force = false) {
  if (!machine || !slotName || (!force && !dirty)) return flushed();
  dirty = false;
  const sequence = ++saveSequence;
  note("正在保存…");
  try {
    await persist(slotName, machine);
    if (sequence === saveSequence)
      note("已保存 · " + new Date().toLocaleTimeString());
  } catch (err) {
    if (sequence === saveSequence) {
      dirty = true;
      note("存档失败，请重试");
    }
    throw err;
  }
}
function inputs(pad: Pad | null) {
  const next = padKeys(pad);
  for (const k of keyboard) next.add(k);
  for (const k of next) if (!sent.has(k)) machine?.buttonDown(1, k);
  for (const k of sent) if (!next.has(k)) machine?.buttonUp(1, k);
  sent = next;
}
function padStatus(pad: Pad | null) {
  const name = pad?.name ?? "";
  if (lastPad !== name) {
    lastPad = name;
    el("padInfo").textContent = name
      ? "已连接：" + name
      : "连接后按一下手柄按钮。若系统未识别，可使用手柄的键盘映射模式。";
  }
}
function renderKeys() {
  const grid = el("bindings");
  grid.replaceChildren();
  actions.forEach((a, i) => {
    const btn = document.createElement("button"),
      label = document.createElement("small");
    label.textContent = a;
    btn.append(
      label,
      document.createTextNode(
        i === capture ? "按一个键…" : keyLabel(bindings[i]!),
      ),
    );
    btn.onclick = () => {
      if (!changing) {
        capture = i;
        renderKeys();
      }
    };
    grid.append(btn);
  });
  el("guide").replaceChildren(
    ...actions.map((action, i) => {
      const item = document.createElement("span");
      item.textContent = keyLabel(bindings[i]!) + " " + action;
      return item;
    }),
  );
}
const initialized = loadBindings()
  .catch(() => {
    error.textContent = "未能读取按键设置，使用默认键位。";
  })
  .then(renderKeys);
let machine: Machine | null = null,
  frame: (() => void) | null = null,
  running = false,
  title = "",
  raf = 0,
  muted = false,
  loading = false;
let audio: AudioContext | null = null,
  queued = 0,
  used = 0;
const rate = 44100,
  samples = new Float32Array(1024);
function wakeAudio() {
  if (muted) return;
  try {
    audio ??= new AudioContext();
    void audio.resume().catch(() => {});
  } catch {
    /* Silent playback is still available. */
  }
}
function sample(l: number, r: number) {
  if (!audio || muted || audio.state !== "running") return;
  samples[used++] = (l + r) * 0.35;
  if (used !== samples.length) return;
  used = 0;
  if (queued > audio.currentTime + 0.12) return;
  const buffer = audio.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  const node = audio.createBufferSource();
  node.buffer = buffer;
  node.connect(audio.destination);
  queued = Math.max(queued, audio.currentTime + 0.012);
  node.start(queued);
  queued += buffer.duration;
}
function silence() {
  used = 0;
  queued = 0;
  if (audio) {
    void audio.close().catch(() => {});
    audio = null;
  }
}
function release() {
  keyboard.clear();
  inputs(null);
  padAttached = false;
}
function stop() {
  running = false;
  cancelAnimationFrame(raf);
  release();
  silence();
  pauseButton.textContent = "继续";
  if (frame) status.textContent = "已暂停 · " + title;
  const result = checkpoint();
  // Most callers are pause events. The status line reports their write failures.
  void result.catch(() => {});
  return result;
}
function start() {
  if (!frame || running || restartDialog.open) return;
  wakeAudio();
  running = true;
  cover.hidden = true;
  pauseButton.disabled = false;
  pauseButton.textContent = "暂停";
  status.textContent = "运行中 · " + title;
  screen.focus();
  let last = performance.now(),
    debt = 1000 / 60;
  function loop(now: number) {
    if (!running || !frame) return;
    debt += Math.min(50, now - last);
    last = now;
    try {
      const pad = webPad();
      padStatus(pad);
      if (padAttached && !pad) {
        stop();
        return;
      }
      padAttached = !!pad;
      inputs(pad);
      while (debt >= 1000 / 60) {
        frame();
        dirty = true;
        debt -= 1000 / 60;
      }
    } catch {
      stop();
      frame = null;
      machine = null;
      pauseButton.disabled = true;
      status.textContent = "卡带已停止";
      error.textContent = "模拟器无法继续运行，请重新选择兼容的 NES 卡带。";
      return;
    }
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
}
function checkROM(bytes: Uint8Array) {
  if (
    bytes.length < 16 ||
    bytes[0] !== 78 ||
    bytes[1] !== 69 ||
    bytes[2] !== 83 ||
    bytes[3] !== 26
  )
    throw Error("不是有效的 .nes 文件。压缩包请先解压。");
  if ((bytes[7]! & 12) === 8) throw Error("请选择 iNES 1.0 格式的卡带。");
  const size =
    16 + (bytes[6]! & 4 ? 512 : 0) + bytes[4]! * 16384 + bytes[5]! * 8192;
  if (!bytes[4] || size > bytes.length)
    throw Error("卡带数据不完整，请重新选择文件。");
}
const bundled = (window as Window & { POCKET_SMB3?: string }).POCKET_SMB3;
if (bundled) {
  load.textContent = "开始游戏";
  el("hint").textContent = "美版 PRG1 · 按 Enter 进入标题菜单";
}
const restart = el<HTMLButtonElement>("restart");
const restartDialog = el<HTMLDialogElement>("restartDialog");
let restartRom: Uint8Array | null = null;
let resumeOnCancel = false;
async function launch(data: Uint8Array, fresh: boolean) {
  checkROM(data);
  await initialized;
  if (!fresh) await flushed();
  const file = slot(data);
  const next = new jsnes.NES({
    sampleRate: rate,
    onAudioSample: sample,
    onFrame(buf) {
      for (let i = 0; i < rgba.length; i++) rgba[i] = 0xff000000 | buf[i]!;
      ctx.putImageData(pixels, 0, 0);
    },
  });
  next.loadROM(data);
  restartRom = data;
  restart.disabled = false;
  const resumed = fresh ? false : await restore(file, next);
  if (fresh) await replaceProgress(file, next);
  machine = next;
  slotName = file;
  dirty = false;
  el<HTMLButtonElement>("exit").disabled = false;
  save.disabled = false;
  save.textContent = "保存进度";
  note(fresh ? "已重新开始" : resumed ? "已恢复上次进度" : "暂停或退出时存档");
  title = "超级马力欧兄弟 3";
  frame = () => next.frame();
  start();
  if (bundled) {
    load.hidden = true;
  }
}

restart.onclick = () => {
  if (loading || !restartRom) return;
  resumeOnCancel = running;
  stop();
  restartDialog.returnValue = "";
  restartDialog.showModal();
};
restartDialog.onclose = async () => {
  if (restartDialog.returnValue !== "restart") {
    if (resumeOnCancel) start();
    screen.focus();
    return;
  }
  if (!restartRom || loading) return;
  loading = true;
  const toolbar = document.querySelector<HTMLElement>(".toolbar")!;
  toolbar.inert = true;
  try {
    error.textContent = "";
    await launch(restartRom, true);
  } catch (err) {
    error.textContent =
      "重新开始失败：" + (err instanceof Error ? err.message : String(err));
  } finally {
    toolbar.inert = false;
    loading = false;
  }
};
load.onclick = async () => {
  if (loading) return;
  loading = true;
  load.disabled = true;
  stop();
  error.textContent = "";
  try {
    let data: Uint8Array;
    if (bundled) {
      data = Uint8Array.from(atob(bundled), (c) => c.charCodeAt(0));
    } else {
      const f = await pocket.fs.pick(["nes"]);
      if (!f) return;
      data = f.base64
        ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(f.text ?? "");
    }
    await launch(data, false);
  } catch (e) {
    error.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    loading = false;
    load.disabled = false;
  }
};
pauseButton.onclick = () => (running ? stop() : start());
sound.onclick = () => {
  muted = !muted;
  sound.textContent = muted ? "声音：关" : "声音：开";
  sound.setAttribute("aria-pressed", String(!muted));
  if (muted) silence();
  else if (running) wakeAudio();
  screen.focus();
};
save.onclick = async () => {
  save.disabled = true;
  save.textContent = "正在保存…";
  screen.focus();
  try {
    await checkpoint(true);
    save.textContent = "已保存 ✓";
  } catch {
    save.textContent = "保存失败 · 重试";
  } finally {
    save.disabled = false;
  }
};
el("exit").onclick = async () => {
  try {
    await stop();
    await pocket.ui.close();
  } catch {
    note("保存或关闭失败，请重试");
  }
};
el("large").onclick = () => {
  const on = document.body.classList.toggle("large");
  el("large").textContent = on ? "退出大画面" : "大画面";
  el("large").setAttribute("aria-pressed", String(on));
  screen.focus();
};
el("settings").onclick = async () => {
  stop();
  await initialized;
  capture = -1;
  renderKeys();
  padStatus(webPad());
  dialog.returnValue = "";
  dialog.showModal();
};
el("close").onclick = () => {
  if (!changing) dialog.close("done");
};
dialog.onclose = () => {
  capture = -1;
  if (dialog.returnValue === "done") start();
  screen.focus();
};
el("reset").onclick = async () => {
  if (changing) return;
  changing = true;
  try {
    await resetKeys();
    capture = -1;
    renderKeys();
  } catch {
    error.textContent = "无法保存键位。";
  } finally {
    changing = false;
  }
};
document.addEventListener("keydown", async (e) => {
  if (dialog.open) {
    if (capture < 0 || changing) return;
    e.preventDefault();
    if (e.repeat) return;
    if (e.code === "Escape") {
      capture = -1;
      renderKeys();
      return;
    }
    if (
      !e.code ||
      e.metaKey ||
      e.altKey ||
      e.ctrlKey ||
      [
        "Tab",
        "MetaLeft",
        "MetaRight",
        "AltLeft",
        "AltRight",
        "ControlLeft",
        "ControlRight",
      ].includes(e.code)
    )
      return;
    changing = true;
    try {
      await bind(capture, e.code);
      capture = -1;
      renderKeys();
    } catch {
      error.textContent = "无法保存键位。";
    } finally {
      changing = false;
    }
    return;
  }
  if (e.code === "Escape" && document.body.classList.contains("large")) {
    el("large").click();
    return;
  }
  if (
    e.metaKey ||
    e.ctrlKey ||
    e.altKey ||
    loading ||
    (!screen.contains(document.activeElement) &&
      document.activeElement !== document.body)
  )
    return;
  const k = bindings.indexOf(e.code);
  if (k < 0) return;
  e.preventDefault();
  if (k === 8 && frame) {
    if (!e.repeat) running ? stop() : start();
    return;
  }
  if (running && k < 8) {
    keyboard.add(k);
    inputs(webPad());
  }
});
document.addEventListener("keyup", (e) => {
  const k = bindings.indexOf(e.code);
  if (keyboard.delete(k)) {
    inputs(running ? webPad() : null);
    e.preventDefault();
  }
});
window.addEventListener("gamepadconnected", () => padStatus(webPad()));
window.addEventListener("blur", () => {
  if (running) stop();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && running) stop();
});
window.addEventListener("pagehide", () => {
  stop();
});
