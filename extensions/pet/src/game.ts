/** 养成系统：四项状态、等级、金币、背包和饰品。所有数值都从这里算，界面只负责显示。 */

export interface PetState {
  v: 1;
  born: number; // 领养的时间
  last: number; // 上一次结算的时间
  hunger: number; // 饱腹 0–100
  mood: number; // 心情
  energy: number; // 精力
  clean: number; // 清洁
  exp: number;
  level: number;
  coins: number;
  asleep: boolean;
  food: Record<string, number>; // 背包里的食物
  owned: string[]; // 买过的玩具和饰品
  wearing: string[]; // 正戴着的饰品
  days: number; // 陪伴天数（签到过的天数）
  streak: number; // 连续签到
  lastCheckin: string; // 上次签到的日期
  stats: { fed: number; played: number; petted: number; bathed: number; treasures: number };
}

export interface Food {
  id: string;
  name: string;
  price: number;
  hunger: number;
  mood: number;
  energy?: number;
}
export const foods: Food[] = [
  { id: "apple", name: "苹果", price: 3, hunger: 12, mood: 3 },
  { id: "riceball", name: "饭团", price: 5, hunger: 25, mood: 2 },
  { id: "fish", name: "小鱼干", price: 8, hunger: 34, mood: 6 },
  { id: "cake", name: "蛋糕", price: 15, hunger: 20, mood: 22, energy: 5 },
];

export interface Goods {
  id: string;
  name: string;
  price: number;
  level: number; // 到这个等级才能买
  kind: "toy" | "wear";
  desc: string;
}
export const goods: Goods[] = [
  { id: "ball", name: "皮球", price: 30, level: 1, kind: "toy", desc: "可以陪它玩球" },
  { id: "balloon", name: "气球", price: 20, level: 2, kind: "toy", desc: "拿着气球飘一会儿" },
  { id: "bow", name: "蝴蝶结", price: 40, level: 2, kind: "wear", desc: "别在耳朵上" },
  { id: "hat", name: "草帽", price: 60, level: 3, kind: "wear", desc: "夏天的感觉" },
  { id: "glasses", name: "眼镜", price: 90, level: 5, kind: "wear", desc: "看起来很有学问" },
  { id: "crown", name: "皇冠", price: 300, level: 10, kind: "wear", desc: "养到长老才配得上" },
];

/** 从口袋里可能掏出来的东西。 */
export const treasures = [
  { item: "star", text: "一颗星星！", coins: 8, mood: 6 },
  { item: "flower", text: "一朵小花，送给你", coins: 0, mood: 12 },
  { item: "apple", text: "一个苹果，放进背包了", coins: 0, mood: 4, food: "apple" },
  { item: "riceball", text: "不知道什么时候藏的饭团", coins: 0, mood: 4, food: "riceball" },
  { item: "balloon", text: "气球！要飞起来啦", coins: 3, mood: 10 },
  { item: "star", text: "亮晶晶的，值不少金币", coins: 15, mood: 5 },
];

export const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
export const needExp = (level: number) => 40 + level * 30;
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export function stage(level: number): { name: string; scale: number } {
  if (level >= 10) return { name: "长老", scale: 1.08 };
  if (level >= 6) return { name: "成年", scale: 1.04 };
  if (level >= 3) return { name: "少年", scale: 1 };
  return { name: "幼崽", scale: 0.92 };
}

export function newState(now: number): PetState {
  return {
    v: 1, born: now, last: now, hunger: 70, mood: 75, energy: 80, clean: 85, exp: 0, level: 1, coins: 30, asleep: false,
    food: { apple: 2, riceball: 1 }, owned: [], wearing: [], days: 0, streak: 0, lastCheckin: "",
    stats: { fed: 0, played: 0, petted: 0, bathed: 0, treasures: 0 },
  };
}

export function load(raw: string, now: number): PetState {
  try {
    const s = JSON.parse(raw) as Partial<PetState>;
    if (s && s.v === 1 && typeof s.hunger === "number") {
      const base = newState(now);
      return { ...base, ...s, food: { ...(s.food ?? {}) }, owned: [...(s.owned ?? [])], wearing: [...(s.wearing ?? [])], stats: { ...base.stats, ...(s.stats ?? {}) } };
    }
  } catch {
    /* 存档坏了就重新开始 */
  }
  return newState(now);
}

export interface Tick {
  leveled: number; // 升了几级
  woke: boolean; // 睡够了自己醒了
}

/** 加经验，够了就升级：升级送金币，心情变好。 */
export function gain(s: PetState, exp: number): number {
  let ups = 0;
  s.exp += exp;
  while (s.exp >= needExp(s.level)) {
    s.exp -= needExp(s.level);
    s.level++;
    s.coins += 20 + s.level * 5;
    s.mood = clamp(s.mood + 15);
    ups++;
  }
  return ups;
}

/**
 * 按过去的时间结算状态。应用开着的时候每分钟按正常速度变化；
 * 关着的那段时间变得慢得多，而且最多算 12 小时：几天没开，它不会饿坏。
 */
export function settle(s: PetState, now: number, away = false): Tick {
  let minutes = Math.max(0, (now - s.last) / 60000);
  s.last = now;
  const out: Tick = { leveled: 0, woke: false };
  if (minutes <= 0) return out;
  let rate = 1;
  if (away) {
    minutes = Math.min(minutes, 12 * 60);
    rate = 0.25;
  }
  const m = minutes * rate;
  s.hunger = clamp(s.hunger - m * 0.45);
  s.clean = clamp(s.clean - m * 0.12);
  if (s.asleep || away) {
    s.energy = clamp(s.energy + m * (away ? 0.6 : 1.4));
    if (s.asleep && s.energy >= 100) {
      s.asleep = false;
      out.woke = true;
    }
  } else {
    s.energy = clamp(s.energy - m * 0.22);
  }
  // 饿着、脏着、困着的时候心情掉得快；都照顾好了会慢慢变好。
  const care = (s.hunger < 25 ? 1 : 0) + (s.clean < 25 ? 1 : 0) + (s.energy < 20 ? 1 : 0);
  s.mood = clamp(s.mood + m * (care ? -0.5 * care : s.mood < 60 ? 0.1 : -0.08));
  if (!away) {
    // 在线陪着：每分钟一点金币；心情好的时候还涨经验。
    s.coins += Math.floor(minutes + Math.random());
    if (s.mood >= 50) out.leveled = gain(s, minutes * 1.2);
  }
  return out;
}

/** 每天第一次见面签到：金币、经验，连续签到给得更多。 */
export function checkin(s: PetState, now: number): { coins: number; streak: number } | null {
  const today = day(now);
  if (s.lastCheckin === today) return null;
  s.streak = s.lastCheckin === day(now - 86400000) ? s.streak + 1 : 1;
  s.lastCheckin = today;
  s.days++;
  const coins = 15 + Math.min(s.streak, 7) * 5;
  s.coins += coins;
  gain(s, 20);
  return { coins, streak: s.streak };
}

export function feed(s: PetState, id: string): { ok: boolean; text: string; leveled: number } {
  const f = foods.find((x) => x.id === id);
  if (!f || !((s.food[id] ?? 0) > 0)) return { ok: false, text: "背包里没有这个了，去商店买一点", leveled: 0 };
  if (s.asleep) return { ok: false, text: "它睡着了，先别吵它", leveled: 0 };
  if (s.hunger >= 98) return { ok: false, text: "吃不下了…", leveled: 0 };
  s.food[id]!--;
  s.hunger = clamp(s.hunger + f.hunger);
  s.mood = clamp(s.mood + f.mood);
  s.energy = clamp(s.energy + (f.energy ?? 0));
  s.stats.fed++;
  return { ok: true, text: `${f.name}真好吃！`, leveled: gain(s, 5) };
}

export function buy(s: PetState, id: string): string {
  const f = foods.find((x) => x.id === id);
  if (f) {
    if (s.coins < f.price) return "金币不够";
    s.coins -= f.price;
    s.food[id] = (s.food[id] ?? 0) + 1;
    return "";
  }
  const g = goods.find((x) => x.id === id);
  if (!g) return "没有这个东西";
  if (s.owned.includes(id)) return "已经有了";
  if (s.level < g.level) return `要到 ${g.level} 级才能买`;
  if (s.coins < g.price) return "金币不够";
  s.coins -= g.price;
  s.owned.push(id);
  if (g.kind === "wear") s.wearing = [...s.wearing.filter((w) => !conflict(w, id)), id];
  return "";
}

/** 草帽和皇冠都戴在头顶，只能戴一个。 */
const conflict = (a: string, b: string) => ["hat", "crown"].includes(a) && ["hat", "crown"].includes(b);

export function toggleWear(s: PetState, id: string) {
  if (!s.owned.includes(id)) return;
  s.wearing = s.wearing.includes(id) ? s.wearing.filter((w) => w !== id) : [...s.wearing.filter((w) => !conflict(w, id)), id];
}

export type Play = "pet" | "ball" | "balloon" | "bath" | "treasure";

export function play(s: PetState, kind: Play): { ok: boolean; text: string; leveled: number; treasure?: (typeof treasures)[number] } {
  if (s.asleep) return { ok: false, text: "它睡着了，先别吵它", leveled: 0 };
  switch (kind) {
    case "pet":
      s.mood = clamp(s.mood + 4);
      s.stats.petted++;
      return { ok: true, text: "好舒服～", leveled: gain(s, 2) };
    case "ball":
    case "balloon":
      if (!s.owned.includes(kind)) return { ok: false, text: kind === "ball" ? "还没有皮球，商店里有卖" : "还没有气球，商店里有卖", leveled: 0 };
      if (s.energy < 15) return { ok: false, text: "太累了，玩不动…", leveled: 0 };
      s.mood = clamp(s.mood + (kind === "ball" ? 16 : 12));
      s.energy = clamp(s.energy - (kind === "ball" ? 10 : 5));
      s.hunger = clamp(s.hunger - 4);
      s.clean = clamp(s.clean - (kind === "ball" ? 5 : 1));
      s.stats.played++;
      return { ok: true, text: kind === "ball" ? "接住啦！" : "飞起来了～", leveled: gain(s, 6) };
    case "bath":
      if (s.clean >= 95) return { ok: false, text: "已经很干净啦", leveled: 0 };
      s.clean = 100;
      s.mood = clamp(s.mood + 5);
      s.stats.bathed++;
      return { ok: true, text: "洗得香喷喷的", leveled: gain(s, 4) };
    case "treasure": {
      if (s.energy < 8) return { ok: false, text: "太累了，翻不动口袋…", leveled: 0 };
      const t = treasures[Math.floor(Math.random() * treasures.length)]!;
      s.coins += t.coins;
      s.mood = clamp(s.mood + t.mood);
      s.energy = clamp(s.energy - 6);
      if (t.food) s.food[t.food] = (s.food[t.food] ?? 0) + 1;
      s.stats.treasures++;
      return { ok: true, text: t.text, leveled: gain(s, 3), treasure: t };
    }
  }
}

/** 现在最需要什么。界面据此决定表情和它主动说的话。 */
export function need(s: PetState): "" | "hungry" | "dirty" | "tired" | "sad" {
  if (s.hunger < 25) return "hungry";
  if (s.energy < 15) return "tired";
  if (s.clean < 25) return "dirty";
  if (s.mood < 30) return "sad";
  return "";
}

export const lines = {
  hungry: ["肚子咕咕叫了…", "有吃的吗？", "好饿呀"],
  dirty: ["身上脏脏的…", "想洗个澡"],
  tired: ["好困…想睡一会儿", "眼皮打架了"],
  sad: ["陪我玩一会儿嘛", "有点无聊…"],
  happy: ["今天也要加油呀", "嘿嘿", "有你在真好", "口袋里好像有东西，双击我看看？", "要不要休息一下眼睛？"],
  morning: ["早上好！", "新的一天开始啦"],
  noon: ["该吃午饭了吧？", "中午记得休息一下"],
  evening: ["辛苦一天啦", "晚上好～"],
  night: ["这么晚了还不睡吗？", "夜深了，早点休息"],
  water: ["该喝水啦！", "起来活动一下吧", "看了很久屏幕了，看看远处"],
  click: ["嗯？", "叫我吗？", "嘿！", "在呢"],
  drag: ["哇——放我下来！", "要去哪儿呀？", "好高！"],
  dizzy: ["头好晕…", "转、转不动了"],
  wake: ["唔…睡醒了", "睡得真香"],
  sleep: ["晚安…", "我先睡一会儿"],
};

export function greeting(hour: number): string[] {
  if (hour < 5) return lines.night;
  if (hour < 11) return lines.morning;
  if (hour < 14) return lines.noon;
  if (hour < 22) return lines.evening;
  return lines.night;
}

export const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]!;
