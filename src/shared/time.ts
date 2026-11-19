const pad2 = (n: number) => String(n).padStart(2, "0");

/** 将 Date 格式化为 `YYYY-MM-DD HH:mm:ss`；传入固定 UTC 偏移分钟数（如 480）时按该偏移输出，否则使用本地时区。 */
export function formatDateTime(d: Date, utcOffsetMinutes?: number): string {
  if (Number.isNaN(d.getTime())) return "";
  if (utcOffsetMinutes !== undefined) {
    const shifted = new Date(d.getTime() + utcOffsetMinutes * 60_000);
    return (
      `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())} ` +
      `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`
    );
  }
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** 将 ISO 时间戳格式化为 `YYYY-MM-DD HH:mm:ss`；空值返回空串，无法解析时回退原文本。 */
export function formatLocalTime(iso?: string, utcOffsetMinutes?: number): string {
  const raw = iso?.trim();
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return formatDateTime(d, utcOffsetMinutes);
}
