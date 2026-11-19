import { pocket } from "../../sdk/pocket";
export interface SnapshotMachine {
  ppu: {
    currentMirroring: number;
    vramMirrorTable: Uint16Array;
    setMirroring(mode: number): void;
  };
  toJSON(): unknown;
  fromJSON(state: unknown): void;
  buttonUp(p: number, b: number): void;
}
// CRC and length distinguish cartridges, not authentication. The filename
// and extension version deliberately do not participate in the storage key.
export function slot(rom: Uint8Array) {
  let c = -1;
  for (const b of rom) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return `progress-${rom.length}-${(~c >>> 0).toString(16)}.json`;
}
// The native window may disappear before a final bridge call is acknowledged.
// Keep the unacknowledged checkpoint in Web Storage under an installation-specific key.
let recoveryPrefix = "";
function recoveryKey(file: string) {
  return recoveryPrefix + file;
}
function recover(file: string) {
  try {
    return localStorage.getItem(recoveryKey(file));
  } catch {
    return null;
  }
}
function clearRecovery(file: string, payload: string) {
  try {
    if (recover(file) === payload) localStorage.removeItem(recoveryKey(file));
  } catch {
    // The private file remains the authoritative copy.
  }
}
export async function restore(file: string, m: SnapshotMachine) {
  if (!recoveryPrefix) {
    let id = await pocket.storage.get<string>("progress.installation");
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
      await pocket.storage.set("progress.installation", id);
    }
    recoveryPrefix = "mario3.pending." + id + ".";
  }
  const files = await pocket.fs.tree("");
  const pendingCopy = recover(file);
  const disk = files.some((f) => f.path === file)
    ? JSON.parse(await pocket.fs.read("", file))
    : null;
  const backup = pendingCopy && JSON.parse(pendingCopy);
  const saved =
    backup && (!disk || backup.time >= (disk.time ?? 0)) ? backup : disk;
  if (!saved) return false;
  if (saved.format !== 1 || saved.slot !== file)
    throw Error("存档格式不匹配，已保留原存档。");
  // JSNES 3.0 hands out a Uint16Array here. Older files encoded it as a
  // numeric-keyed object, which TypedArray.set silently treats as empty.
  const mirror = saved.state.ppu?.vramMirrorTable;
  if (mirror && !Array.isArray(mirror))
    saved.state.ppu.vramMirrorTable = Object.values(mirror);
  m.fromJSON(saved.state);
  // A save opened in 1.1.0 and then saved again can contain a full-length
  // identity table. Rebuild it from the cartridge mode using JSNES itself.
  const ppu = m.ppu;
  if (ppu.currentMirroring >= 0 && ppu.vramMirrorTable[0x3000] === 0x3000) {
    const mode = ppu.currentMirroring;
    ppu.currentMirroring = -1;
    ppu.setMirroring(mode);
  }
  for (let i = 0; i < 8; i++) m.buttonUp(1, i);
  if (pendingCopy) {
    if (saved === backup) await pocket.fs.write("", file, pendingCopy);
    clearRecovery(file, pendingCopy);
  }
  return true;
}
let pending: Promise<void> = Promise.resolve();
function snapshot(file: string, m: SnapshotMachine) {
  return JSON.stringify(
    { format: 1, slot: file, time: Date.now(), state: m.toJSON() },
    (_, value) => (value instanceof Uint16Array ? Array.from(value) : value),
  );
}
export function persist(file: string, m: SnapshotMachine) {
  const payload = snapshot(file, m);
  try {
    localStorage.setItem(recoveryKey(file), payload);
  } catch {
    // Some WebViews disable Web Storage. The normal private-file write still runs.
  }
  pending = pending
    .catch(() => {})
    .then(async () => {
      await pocket.fs.write("", file, payload);
      clearRecovery(file, payload);
    });
  return pending;
}
export function flushed() {
  return pending;
}

// Commit the fresh boot state before replacing the running session. A failed
// restart must leave both the old file and its recovery copy available.
export async function replaceProgress(file: string, fresh: SnapshotMachine) {
  await pending.catch(() => {});
  const backup = recover(file);
  await pocket.fs.write("", file, snapshot(file, fresh));
  if (backup) clearRecovery(file, backup);
  pending = Promise.resolve();
}
