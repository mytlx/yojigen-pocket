/** 按键名（KeyboardEvent.code）在界面上怎么显示。 */
const names: Record<string, string> = {
  Space: "空格", Enter: "回车", Tab: "Tab", Backspace: "退格", Delete: "Del", Escape: "Esc", CapsLock: "Caps",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", PageUp: "PgUp", PageDown: "PgDn",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
  NumpadAdd: "Num +", NumpadSubtract: "Num -", NumpadMultiply: "Num *", NumpadDivide: "Num /", NumpadDecimal: "Num .", NumpadEnter: "Num 回车",
  ContextMenu: "菜单键", PrintScreen: "PrtSc", ScrollLock: "ScrLk", NumLock: "NumLk",
};

export function keyLabel(code: string, mac: boolean): string {
  if (names[code]) return names[code]!;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  const side = code.endsWith("Right") ? "右 " : "";
  if (code.startsWith("Shift")) return side + "Shift";
  if (code.startsWith("Control")) return side + "Ctrl";
  if (code.startsWith("Alt")) return side + (mac ? "⌥" : "Alt");
  if (code.startsWith("Meta")) return side + (mac ? "⌘" : "Win");
  return code;
}

export const isModifier = (code: string) => /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code);

/** 组合键的显示：Ctrl + Shift + K。 */
export const comboLabel = (keys: string[], mac: boolean) => keys.map((k) => keyLabel(k, mac)).join(" + ");
