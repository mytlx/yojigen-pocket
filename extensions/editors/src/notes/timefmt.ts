export const DEFAULT_TIME_FORMAT = "YYYY-MM-DD HH:mm:ss";

export const TIME_FORMAT_PRESETS: readonly string[] = [
  "YYYY-MM-DD HH:mm:ss",
  "YYYY-MM-DD HH:mm",
  "YYYY/MM/DD HH:mm:ss",
  "YYYY年MM月DD日 HH:mm:ss",
  "YYYY-MM-DD",
  "HH:mm:ss",
];

const WEEKDAYS_SHORT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const WEEKDAYS_LONG = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] as const;
const TOKEN_RE = /YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s|dddd|ddd/g;

/** 按格式模板输出当前日期时间；支持预设与自定义占位符（单次扫描替换避免重匹配）。 */
export function formatTime(date: Date, format = DEFAULT_TIME_FORMAT): string {
  const tpl = format.trim() || DEFAULT_TIME_FORMAT;
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = String(date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const min = date.getMinutes();
  const sec = date.getSeconds();
  const dow = date.getDay();

  return tpl.replace(TOKEN_RE, (tok) => {
    switch (tok) {
      case "YYYY":
        return year;
      case "YY":
        return year.slice(-2);
      case "MM":
        return pad(month);
      case "M":
        return String(month);
      case "DD":
        return pad(day);
      case "D":
        return String(day);
      case "HH":
        return pad(hour);
      case "H":
        return String(hour);
      case "mm":
        return pad(min);
      case "m":
        return String(min);
      case "ss":
        return pad(sec);
      case "s":
        return String(sec);
      case "dddd":
        return WEEKDAYS_LONG[dow]!;
      case "ddd":
        return WEEKDAYS_SHORT[dow]!;
      default:
        return tok;
    }
  });
}
