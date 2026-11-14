import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import * as THREE from "three";
import { Pet, Windows, events, type PetConfig } from "../mygo";
import { animate, type Action, type Pose } from "./anim";
import { buy, checkin, clamp, feed, foods, goods, greeting, lines, load, need, needExp, pick, play, settle, stage, toggleWear, type PetState, type Play } from "./game";
import { buildPet, spawn, stepParticles, type Particle, type Rig } from "./model";
import "./pet.css";

const BASE_W = 230;
const BASE_H = 260;
type Tab = "status" | "feed" | "play" | "shop" | "settings";

/** 一次性的动作各做多久（秒）；做完回到发呆。 */
const durations: Partial<Record<Action, number>> = { happy: 1.6, wave: 1.4, eat: 2.3, land: 0.45, dizzy: 2.2, dig: 2.6, ball: 2.6, float: 4.2, bath: 2.8, sad: 2.5 };

function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const game = useRef<PetState | null>(null);
  const cfg = useRef<PetConfig | null>(null);
  const pose = useRef<Pose>({ action: "idle", t: 0, dir: 0, lookX: 0, lookY: 0, blink: 2, blinking: -1, mood: 70, scale: 1 });
  const rigRef = useRef<Rig | null>(null);
  const particles = useRef<Particle[]>([]);
  const [, setVersion] = useState(0);
  const [bubble, setBubble] = useState("");
  const [panel, setPanel] = useState<Tab | null>(null);
  const [scale, setScale] = useState(1);
  const [name, setName] = useState("团子");
  const bubbleTimer = useRef<ReturnType<typeof setTimeout>>();
  const panelRef = useRef<Tab | null>(null);
  panelRef.current = panel;
  const refresh = () => setVersion((v) => v + 1);

  const say = (text: string, ms = 3200) => {
    setBubble(text);
    clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(() => setBubble(""), ms);
  };
  const save = () => game.current && void Pet.save(JSON.stringify(game.current)).catch(() => undefined);
  const act = (action: Action, item?: string) => {
    const rig = rigRef.current;
    pose.current.action = action;
    pose.current.t = 0;
    if (action !== "walk") pose.current.dir = 0;
    if (rig) for (const [id, obj] of Object.entries(rig.items)) obj.visible = id === item;
  };
  const fx = (char: string, color: string, n = 4) => rigRef.current && spawn(rigRef.current, particles.current, char, color, n);
  const leveled = (ups: number) => {
    if (ups <= 0 || !game.current) return;
    fx("★", "#f6c445", 8);
    setTimeout(() => say(`升到 ${game.current!.level} 级啦！${stage(game.current!.level).name}`, 4000), 900);
  };
  const applyWear = () => {
    const rig = rigRef.current;
    const g = game.current;
    if (rig && g) for (const [id, obj] of Object.entries(rig.accessories)) obj.visible = g.wearing.includes(id);
  };

  // --- 各种互动 ---
  const doFeed = (id: string) => {
    const g = game.current;
    if (!g) return;
    const r = feed(g, id);
    say(r.text);
    if (r.ok) {
      act("eat", id);
      setTimeout(() => fx("♥", "#ff6b8b", 3), 1200);
      leveled(r.leveled);
    }
    refresh();
    save();
  };
  const doPlay = (kind: Play) => {
    const g = game.current;
    if (!g) return;
    const r = play(g, kind);
    say(r.text);
    if (r.ok) {
      if (kind === "pet") {
        act("happy");
        fx("♥", "#ff6b8b", 5);
      } else if (kind === "ball") act("ball", "ball");
      else if (kind === "balloon") act("float", "balloon");
      else if (kind === "bath") {
        act("bath");
        fx("○", "#8fd3ff", 10);
      } else if (kind === "treasure" && r.treasure) {
        act("dig");
        const item = r.treasure.item;
        setBubble("");
        setTimeout(() => {
          const rig = rigRef.current;
          if (rig && pose.current.action === "dig") for (const [id, obj] of Object.entries(rig.items)) obj.visible = id === item;
          say(r.text);
          fx("✦", "#f6c445", 5);
        }, 1300);
      }
      leveled(r.leveled);
    }
    refresh();
    save();
  };
  const toggleSleep = () => {
    const g = game.current;
    if (!g) return;
    g.asleep = !g.asleep;
    act(g.asleep ? "sleep" : "happy");
    say(pick(g.asleep ? lines.sleep : lines.wake));
    refresh();
    save();
  };
  const openPanel = (tab: Tab | null) => {
    setPanel(tab);
    void Pet.setPanel(tab !== null);
  };

  useEffect(() => {
    let disposed = false;
    let raf = 0;
    const offs: (() => void)[] = [];
    void Pet.info().then((info) => {
      if (disposed || !canvas.current) return;
      const now = Date.now();
      const g = load(info.state, now);
      const away = settle(g, now, true);
      game.current = g;
      cfg.current = info.config;
      setScale(info.config.scale || 1);
      setName(info.config.name || "团子");

      const renderer = new THREE.WebGLRenderer({ canvas: canvas.current, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(28, BASE_W / BASE_H, 0.1, 50);
      camera.position.set(0, 1.55, 8.4);
      camera.lookAt(0, 1.32, 0);
      scene.add(new THREE.HemisphereLight(0xffffff, 0xb9a48a, 1.5));
      const sun = new THREE.DirectionalLight(0xffffff, 2.1);
      sun.position.set(2.5, 5, 4);
      scene.add(sun);
      const rig = buildPet();
      rigRef.current = rig;
      scene.add(rig.root);
      applyWear();
      const fit = () => {
        const s = cfg.current?.scale || 1;
        renderer.setSize(BASE_W * s, BASE_H * s, false);
      };
      fit();

      // 见面：签到、打招呼
      const gift = checkin(g, now);
      if (g.asleep) act("sleep");
      else act("wave");
      setTimeout(() => {
        if (gift) {
          say(`${pick(greeting(new Date().getHours()))} 今天的见面礼：${gift.coins} 金币${gift.streak > 1 ? `（连续 ${gift.streak} 天）` : ""}`, 5200);
          fx("★", "#f6c445", 5);
        } else if (!g.asleep) say(pick(greeting(new Date().getHours())));
      }, 600);
      if (away.woke) g.asleep = false;
      refresh();
      save();

      // 主循环：限制在每秒 30 帧左右，睡着时更低；窗口看不见时浏览器会自己停掉。
      let last = performance.now();
      let acc = 0;
      let decide = 4 + Math.random() * 4; // 多久之后自己找点事做
      let stepTimer = 0;
      let settleTimer = 0;
      let nagTimer = 50;
      let remind = 45 * 60;
      let falling = 0; // 下落的速度；0 表示没在掉
      const loop = (t: number) => {
        raf = requestAnimationFrame(loop);
        const dt = Math.min(0.1, (t - last) / 1000);
        acc += dt;
        last = t;
        const p = pose.current;
        const frame = p.action === "sleep" ? 1 / 12 : 1 / 30;
        if (acc < frame) return;
        const step = acc;
        acc = 0;
        const time = t / 1000;
        const conf = cfg.current!;
        p.t += step;
        p.mood = g.mood;
        p.scale = stage(g.level).scale;

        // 一次性的动作做完了：回到发呆（睡着的回去接着睡）。
        const limit = durations[p.action];
        if (limit && p.t >= limit) {
          act(g.asleep ? "sleep" : "idle");
        }

        // 走路：隔一小会儿挪一下窗口，碰到屏幕边就掉头。
        if (p.action === "walk") {
          stepTimer += step;
          if (stepTimer >= 0.05) {
            stepTimer = 0;
            void Pet.move(Math.round(p.dir * 3 * (conf.scale || 1)), 0).then((r) => {
              if (r && r[2] && pose.current.action === "walk") pose.current.dir = -pose.current.dir;
            });
          }
        }
        // 松手后往下掉，掉到屏幕底部落地。
        if (p.action === "fall") {
          falling += step * 2600;
          const dy = Math.max(1, Math.round(falling * step));
          void Pet.land().then((left) => {
            if (pose.current.action !== "fall") return;
            if (left <= 2) {
              falling = 0;
              act(shaken.current > 1400 ? "dizzy" : "land");
              if (shaken.current > 1400) {
                say(pick(lines.dizzy));
                fx("✶", "#ffd166", 6);
              }
              shaken.current = 0;
            } else void Pet.move(0, Math.min(dy, left));
          });
        }

        // 自己找点事做：只在发呆、没开面板、没开安静模式的时候。
        if (p.action === "idle" && !panelRef.current) {
          decide -= step;
          if (decide <= 0) {
            decide = 5 + Math.random() * 9;
            const r = Math.random();
            if (g.energy < 8) {
              g.asleep = true;
              act("sleep");
              say(pick(lines.sleep));
            } else if (conf.quiet) {
              /* 安静模式：就待着 */
            } else if (r < 0.4) {
              act("walk");
              p.dir = Math.random() < 0.5 ? -1 : 1;
              durations.walk = 2 + Math.random() * 4;
            } else if (r < 0.55) {
              act("sit");
              durations.sit = 4 + Math.random() * 6;
            } else if (r < 0.7 && g.mood >= 50) say(pick(lines.happy));
          }
          // 有需要的时候隔一阵提醒一次。
          nagTimer -= step;
          const want = need(g);
          if (want && nagTimer <= 0 && !conf.quiet) {
            nagTimer = 70;
            say(pick(lines[want]));
            act("sad");
          }
        }
        // 没人看着它的时候眼睛自己四处看看。
        if (!hovering.current) {
          p.lookX += (Math.sin(time * 0.6) * 0.5 - p.lookX) * Math.min(1, step * 2);
          p.lookY += (Math.sin(time * 0.43) * 0.2 - p.lookY) * Math.min(1, step * 2);
        }
        if (p.action === "sleep" && Math.random() < step * 0.45) spawn(rig, particles.current, "z", "#9db4d8", 1, [0.5, 2.5, 0.4]);

        // 每 30 秒结算一次状态并存档。
        settleTimer += step;
        if (settleTimer >= 30) {
          settleTimer = 0;
          const tick = settle(g, Date.now());
          if (tick.woke) {
            act("happy");
            say(pick(lines.wake));
          }
          leveled(tick.leveled);
          if (checkin(g, Date.now())) say("新的一天！见面礼已经放进口袋了");
          refresh();
          save();
        }
        if (conf.reminders && !g.asleep) {
          remind -= step;
          if (remind <= 0) {
            remind = 45 * 60;
            say(pick(lines.water), 6000);
            act("wave");
          }
        }

        animate(rig, p, time, step);
        stepParticles(rig, particles.current, step);
        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(loop);

      offs.push(
        events.configChanged.on((v) => {
          cfg.current = v.config.pet;
          setScale(v.config.pet.scale || 1);
          setName(v.config.pet.name || "团子");
          fit();
        }),
      );
      offs.push(() => {
        renderer.dispose();
      });
      // 给端到端测试看状态用。
      (window as unknown as { __pet: unknown }).__pet = { game: () => game.current, pose: () => pose.current, feed: doFeed, play: doPlay };
    });
    const onLeave = () => save();
    window.addEventListener("beforeunload", onLeave);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      offs.forEach((f) => f());
      window.removeEventListener("beforeunload", onLeave);
      save();
    };
  }, []);

  // --- 鼠标：拖动、点击、抚摸 ---
  const hovering = useRef(false);
  const shaken = useRef(0);
  const drag = useRef<{ x: number; y: number; moved: boolean; lastX: number; lastY: number } | null>(null);
  const stroke = useRef({ dist: 0, since: 0, cool: 0, x: 0, y: 0 });
  const clickTimer = useRef<ReturnType<typeof setTimeout>>();

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, y: e.screenY, moved: false, lastX: e.screenX, lastY: e.screenY };
  };
  const onMove = (e: PointerEvent) => {
    const el = canvas.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    hovering.current = true;
    pose.current.lookX = clamp(((e.clientX - rect.left) / rect.width - 0.5) * 2.4, -1, 1);
    pose.current.lookY = clamp((0.3 - (e.clientY - rect.top) / rect.height) * 2.4, -1, 1);
    const d = drag.current;
    if (d) {
      const dx = e.screenX - d.x;
      const dy = e.screenY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 5) {
        d.moved = true;
        shaken.current = 0;
        void Windows.dragStart();
        act("held");
        if (game.current?.asleep) {
          game.current.asleep = false;
          refresh();
        }
        say(pick(lines.drag), 1800);
      }
      if (d.moved) {
        shaken.current += Math.hypot(e.screenX - d.lastX, e.screenY - d.lastY);
        d.lastX = e.screenX;
        d.lastY = e.screenY;
        void Windows.dragMove(Math.round(dx), Math.round(dy));
      }
      return;
    }
    // 抚摸：鼠标在头上来回蹭。
    const s = stroke.current;
    const now = performance.now();
    if (e.clientY - rect.top < rect.height * 0.5 && now > s.cool) {
      if (now - s.since > 1300) {
        s.dist = 0;
        s.since = now;
      } else s.dist += Math.hypot(e.clientX - s.x, e.clientY - s.y);
      if (s.dist > 260) {
        s.dist = 0;
        s.cool = now + 4000;
        doPlay("pet");
      }
    }
    s.x = e.clientX;
    s.y = e.clientY;
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      act("fall");
      return;
    }
    // 单击打招呼，双击掏口袋。
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = undefined;
      doPlay("treasure");
      return;
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = undefined;
      const g = game.current;
      if (!g) return;
      if (g.asleep) {
        say("Zzz…（右键可以叫醒它）", 2000);
        return;
      }
      act("wave");
      say(pick(lines.click), 1800);
    }, 260);
  };

  const g = game.current;
  const s = scale;
  const patchConfig = (p: Partial<PetConfig>) => {
    if (!cfg.current) return;
    cfg.current = { ...cfg.current, ...p };
    void Pet.setConfig(cfg.current);
    refresh();
  };
  const bar = (label: string, value: number, color: string) => (
    <div class="pet-bar">
      <span>{label}</span>
      <div><i style={{ width: `${Math.round(value)}%`, background: color }} /></div>
      <b>{Math.round(value)}</b>
    </div>
  );
  const tabs: [Tab, string][] = [["status", "状态"], ["feed", "喂食"], ["play", "玩耍"], ["shop", "商店"], ["settings", "设置"]];

  return (
    <div class="pet-root" onContextMenu={(e) => { e.preventDefault(); openPanel(panel ? null : "status"); }}>
      {panel && g && cfg.current && (
        <div class="pet-panel" onPointerDown={(e) => e.stopPropagation()}>
          <div class="pet-tabs">
            {tabs.map(([id, label]) => (
              <button key={id} type="button" class={panel === id ? "is-on" : ""} onClick={() => setPanel(id)}>{label}</button>
            ))}
            <button type="button" class="pet-close" title="收起面板" onClick={() => openPanel(null)}>×</button>
          </div>
          <div class="pet-body">
            {panel === "status" && (
              <>
                <div class="pet-title">
                  <input value={name} aria-label="名字" maxLength={12} onInput={(e) => setName((e.target as HTMLInputElement).value)} onBlur={() => patchConfig({ name: name.trim() || "团子" })} />
                  <span>{stage(g.level).name} · Lv.{g.level}</span>
                </div>
                {bar("经验", (g.exp / needExp(g.level)) * 100, "#9b8cff")}
                {bar("饱腹", g.hunger, "#ffa94d")}
                {bar("心情", g.mood, "#ff6b8b")}
                {bar("精力", g.energy, "#51cf66")}
                {bar("清洁", g.clean, "#4dabf7")}
                <div class="pet-meta">🪙 {g.coins} 金币 · 陪伴 {g.days} 天{g.streak > 1 ? ` · 连续 ${g.streak} 天` : ""}</div>
                <div class="pet-meta">喂过 {g.stats.fed} 次 · 玩过 {g.stats.played} 次 · 摸过 {g.stats.petted} 次 · 寻宝 {g.stats.treasures} 次</div>
              </>
            )}
            {panel === "feed" && (
              <div class="pet-grid">
                {foods.map((f) => (
                  <button key={f.id} type="button" disabled={!(g.food[f.id]! > 0)} onClick={() => doFeed(f.id)} title={`饱腹 +${f.hunger}，心情 +${f.mood}`}>
                    <b>{f.name}</b>
                    <span>还有 {g.food[f.id] ?? 0} 个</span>
                  </button>
                ))}
                <p>吃完了去“商店”买。{g.hunger < 25 ? "它现在很饿。" : ""}</p>
              </div>
            )}
            {panel === "play" && (
              <div class="pet-grid">
                <button type="button" onClick={() => doPlay("pet")}><b>摸摸头</b><span>心情 +4</span></button>
                <button type="button" onClick={() => doPlay("treasure")}><b>口袋寻宝</b><span>看看能掏出什么</span></button>
                <button type="button" onClick={() => doPlay("ball")}><b>玩皮球</b><span>{g.owned.includes("ball") ? "心情 +16" : "商店有卖"}</span></button>
                <button type="button" onClick={() => doPlay("balloon")}><b>放气球</b><span>{g.owned.includes("balloon") ? "心情 +12" : "商店有卖"}</span></button>
                <button type="button" onClick={() => doPlay("bath")}><b>洗澡</b><span>清洁回满</span></button>
                <button type="button" onClick={toggleSleep}><b>{g.asleep ? "叫醒" : "睡觉"}</b><span>{g.asleep ? "睡着时恢复精力" : "恢复精力"}</span></button>
                <p>也可以直接来：单击打招呼，双击掏口袋，在头上来回蹭是抚摸，按住可以拎起来。</p>
              </div>
            )}
            {panel === "shop" && (
              <div class="pet-shop">
                <div class="pet-meta">🪙 {g.coins} 金币（在线陪着、签到、升级、寻宝都能攒）</div>
                {foods.map((f) => (
                  <div key={f.id}>
                    <span><b>{f.name}</b> 饱腹 +{f.hunger}</span>
                    <button type="button" disabled={g.coins < f.price} onClick={() => { const err = buy(g, f.id); if (err) say(err); refresh(); save(); }}>{f.price} 金币</button>
                  </div>
                ))}
                {goods.map((x) => {
                  const own = g.owned.includes(x.id);
                  return (
                    <div key={x.id}>
                      <span><b>{x.name}</b> {x.desc}</span>
                      {own ? (
                        x.kind === "wear" ? (
                          <button type="button" class={g.wearing.includes(x.id) ? "is-on" : ""} onClick={() => { toggleWear(g, x.id); applyWear(); refresh(); save(); }}>{g.wearing.includes(x.id) ? "戴着" : "戴上"}</button>
                        ) : (
                          <button type="button" disabled>已拥有</button>
                        )
                      ) : (
                        <button type="button" disabled={g.level < x.level || g.coins < x.price} onClick={() => { const err = buy(g, x.id); if (err) say(err); else { applyWear(); act("happy"); } refresh(); save(); }}>
                          {g.level < x.level ? `Lv.${x.level} 解锁` : `${x.price} 金币`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {panel === "settings" && (
              <div class="pet-settings">
                <label>大小 <input type="range" min={0.6} max={1.8} step={0.1} value={cfg.current.scale} onChange={(e) => { patchConfig({ scale: Number((e.target as HTMLInputElement).value) }); setTimeout(() => void Pet.setPanel(true), 200); }} /> {Math.round(cfg.current.scale * 100)}%</label>
                <label><input type="checkbox" checked={cfg.current.alwaysOnTop} onChange={(e) => patchConfig({ alwaysOnTop: (e.target as HTMLInputElement).checked })} /> 一直在别的窗口上面</label>
                <label><input type="checkbox" checked={cfg.current.reminders} onChange={(e) => patchConfig({ reminders: (e.target as HTMLInputElement).checked })} /> 每 45 分钟提醒喝水、活动一下</label>
                <label><input type="checkbox" checked={cfg.current.quiet} onChange={(e) => patchConfig({ quiet: (e.target as HTMLInputElement).checked })} /> 安静模式：不乱走，不主动说话</label>
                <button type="button" class="pet-hide" onClick={() => { save(); void Pet.hide(); }}>把{name}收起来</button>
                <p>收起来之后不占任何资源，存档还在。在搜索框里输入“宠物”，或用托盘菜单，可以再叫出来。</p>
              </div>
            )}
          </div>
        </div>
      )}
      <div class="pet-stage" style={{ width: `${BASE_W * s}px`, height: `${BASE_H * s}px` }}>
        {bubble && <div class="pet-bubble" key={bubble}>{bubble}</div>}
        <canvas
          ref={canvas}
          style={{ width: `${BASE_W * s}px`, height: `${BASE_H * s}px` }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => (hovering.current = false)}
        />
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
