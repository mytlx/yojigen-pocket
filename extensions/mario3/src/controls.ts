import { pocket } from "../../sdk/pocket";
export const actions = [
  "跳跃 / A",
  "加速 / B",
  "选择",
  "开始",
  "上",
  "下",
  "左",
  "右",
  "暂停",
];
const defaults = [
  "KeyX",
  "KeyZ",
  "ShiftLeft",
  "Enter",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "KeyP",
];
export const bindings = defaults.slice();
const id = "controls.v1";
export function keyLabel(key: string) {
  return (
    (
      {
        ArrowUp: "↑",
        ArrowDown: "↓",
        ArrowLeft: "←",
        ArrowRight: "→",
        ShiftLeft: "左 Shift",
        ShiftRight: "右 Shift",
        Space: "空格",
      } as Record<string, string>
    )[key] ?? key.replace(/^(Key|Digit)/, "")
  );
}
export async function loadBindings() {
  const saved = await pocket.storage.get<string[]>(id);
  if (
    Array.isArray(saved) &&
    saved.length === actions.length &&
    saved.every((s) => typeof s === "string" && s) &&
    new Set(saved).size === saved.length
  )
    bindings.splice(0, bindings.length, ...saved);
}
export async function bind(index: number, key: string) {
  const next = bindings.slice(),
    other = next.indexOf(key);
  if (other >= 0) next[other] = next[index]!;
  next[index] = key;
  await pocket.storage.set(id, next);
  bindings.splice(0, bindings.length, ...next);
}
export async function resetKeys() {
  await pocket.storage.set(id, defaults);
  bindings.splice(0, bindings.length, ...defaults);
}
export interface Pad {
  name: string;
  buttons: boolean[];
  axes: number[];
}
export function webPad(): Pad | null {
  try {
    const g = Array.from(navigator.getGamepads?.() ?? []).find(
      (g) => g?.connected && g.mapping === "standard",
    );
    if (g)
      return {
        name: g.id,
        buttons: g.buttons.map((b) => b.pressed),
        axes: [...g.axes],
      };
  } catch {
    /* Host WebView may not delegate the Gamepad feature. */
  }
  return null;
}
export function padKeys(p: Pad | null) {
  const set = new Set<number>();
  if (!p) return set;
  [0, 2, 8, 9, 12, 13, 14, 15].forEach((b, i) => {
    if (p.buttons[b]) set.add(i);
  });
  if (p.buttons[1]) set.add(1);
  const [x = 0, y = 0] = p.axes;
  if (x < -0.48) set.add(6);
  if (x > 0.48) set.add(7);
  if (y < -0.48) set.add(4);
  if (y > 0.48) set.add(5);
  return set;
}
