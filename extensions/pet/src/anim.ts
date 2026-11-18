import type { Rig } from "./model";

/** 宠物正在做的动作。 */
export type Action = "idle" | "walk" | "sit" | "sleep" | "happy" | "eat" | "wave" | "held" | "fall" | "land" | "dizzy" | "dig" | "ball" | "float" | "bath" | "sad";

export interface Pose {
  action: Action;
  t: number; // 这个动作做了多久（秒）
  dir: number; // 朝向：-1 左，1 右，0 正面
  lookX: number; // 眼睛看哪儿（-1 到 1）
  lookY: number;
  blink: number; // 下一次眨眼还有多久
  blinking: number; // 正在眨的那一下进行到哪儿（<0 表示没在眨）
  mood: number; // 0–100，影响耳朵和嘴
  scale: number;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

/** 每一帧按当前动作摆好姿势。只改关节的角度和位置，不新建任何东西。 */
export function animate(rig: Rig, p: Pose, time: number, dt: number) {
  const s = Math.sin;
  const { body, head, armL, armR, legL, legR, tail, earL, earR } = rig;
  const k = Math.min(1, dt * 10); // 姿势之间平滑过渡

  // 目标姿势，先按“站着发呆”来，再由各个动作改。
  let bodyY = s(time * 2.2) * 0.012;
  let bodyScaleY = 1 + s(time * 2.2) * 0.012;
  let bodyRotZ = s(time * 1.1) * 0.015;
  let bodyRotX = 0;
  let headRotX = p.lookY * -0.18;
  let headRotY = p.lookX * 0.35;
  let headRotZ = s(time * 0.9) * 0.03;
  let aL = 0.42;
  let aR = -0.42; // 手臂绕 z 轴张开的角度
  let aLx = 0;
  let aRx = 0; // 手臂前后摆
  let lL = 0;
  let lR = 0; // 腿前后摆
  let tailWag = s(time * 2.4) * 0.22;
  let tailUp = 0;
  let rootY = 0;
  let rootRotY = p.dir * 0.75;
  let rootRotZ = 0;
  let squash = 1;
  let eyesClosed = false;
  let mouthOpen = false;
  let earDroop = p.mood < 30 ? 0.35 : 0;

  switch (p.action) {
    case "walk": {
      const w = time * 9;
      lL = s(w) * 0.55;
      lR = -s(w) * 0.55;
      aLx = -s(w) * 0.5;
      aRx = s(w) * 0.5;
      bodyY = Math.abs(s(w)) * 0.05;
      bodyRotZ = s(w) * 0.05;
      tailWag = s(w * 0.5) * 0.35;
      headRotY = p.dir * 0.2;
      break;
    }
    case "sit":
      rootY = -0.2;
      lL = lR = -1.25;
      bodyRotX = -0.06;
      aL = 0.25;
      aR = -0.25;
      break;
    case "sleep":
      rootY = -0.22;
      lL = lR = -1.25;
      bodyRotX = 0.16;
      headRotX = 0.38;
      headRotZ = 0.12;
      bodyScaleY = 1 + s(time * 1.2) * 0.02;
      bodyY = 0;
      eyesClosed = true;
      tailWag = s(time * 0.8) * 0.05;
      earDroop = 0.3;
      break;
    case "happy": {
      const j = Math.abs(s(p.t * 7));
      rootY = j * 0.34;
      squash = 1 + (j - 0.5) * 0.1;
      aL = 2.4 + s(p.t * 14) * 0.2;
      aR = -2.4 - s(p.t * 14) * 0.2;
      rootRotY = p.t < 0.9 ? p.t * 7 : 0;
      tailWag = s(time * 14) * 0.5;
      mouthOpen = true;
      break;
    }
    case "wave":
      aR = -2.5 + s(p.t * 12) * 0.35;
      headRotZ = -0.12;
      mouthOpen = true;
      rootRotY = 0;
      break;
    case "eat": {
      aRx = -1.5;
      aR = -0.2;
      headRotX = 0.12 + Math.abs(s(p.t * 12)) * 0.08;
      mouthOpen = s(p.t * 12) > 0;
      rootRotY = 0;
      break;
    }
    case "held":
      // 被拎起来：四肢垂着晃
      aL = 0.9 + s(time * 6) * 0.25;
      aR = -0.9 - s(time * 6 + 1) * 0.25;
      lL = s(time * 7) * 0.4;
      lR = s(time * 7 + 2) * 0.4;
      bodyRotZ = s(time * 5) * 0.08;
      tailWag = s(time * 9) * 0.5;
      mouthOpen = true;
      rootRotY = 0;
      break;
    case "fall":
      aL = 2.2;
      aR = -2.2;
      lL = 0.4;
      lR = -0.4;
      mouthOpen = true;
      rootRotY = 0;
      break;
    case "land": {
      // 落地：先压扁再弹回来
      const q = ease(p.t / 0.45);
      squash = 0.72 + q * 0.28 + s(q * Math.PI) * 0.12;
      aL = 1.2 - q * 0.8;
      aR = -1.2 + q * 0.8;
      rootRotY = 0;
      break;
    }
    case "dizzy":
      bodyRotZ = s(time * 6) * 0.16;
      headRotZ = s(time * 6 + 1) * 0.25;
      aL = 0.8;
      aR = -0.8;
      rootRotY = 0;
      break;
    case "dig": {
      // 低头把手伸进口袋里翻
      const phase = p.t < 1.3 ? 1 : 0;
      headRotX = phase ? 0.4 : 0;
      aRx = phase ? -0.9 + s(p.t * 16) * 0.12 : -1.9;
      aR = phase ? 0.35 : -0.5;
      aL = phase ? 0.2 : 0.42;
      aLx = phase ? -0.6 : 0;
      mouthOpen = !phase;
      rootRotY = 0;
      break;
    }
    case "ball": {
      const j = Math.abs(s(p.t * 6));
      rootY = j * 0.2;
      aRx = -1.3 - j * 0.6;
      aLx = -1.3 - j * 0.6;
      aL = 0.1;
      aR = -0.1;
      mouthOpen = true;
      rootRotY = 0;
      break;
    }
    case "float":
      rootY = 0.35 + s(time * 2) * 0.08;
      aRx = -2.9;
      aR = -0.15;
      lL = s(time * 3) * 0.3;
      lR = -s(time * 3) * 0.3;
      bodyRotZ = s(time * 1.6) * 0.08;
      mouthOpen = true;
      rootRotY = 0;
      break;
    case "bath":
      aL = 1.6 + s(p.t * 16) * 0.4;
      aR = -1.6 - s(p.t * 16 + 1) * 0.4;
      bodyRotZ = s(p.t * 10) * 0.06;
      eyesClosed = true;
      rootRotY = 0;
      break;
    case "sad":
      headRotX = 0.3;
      earDroop = 0.5;
      aL = 0.15;
      aR = -0.15;
      tailWag = 0;
      tailUp = -0.3;
      break;
    default:
      break;
  }

  rig.root.position.y = lerp(rig.root.position.y, rootY, k);
  rig.root.rotation.y = p.action === "happy" && p.t < 0.9 ? rootRotY : lerp(rig.root.rotation.y, rootRotY, k);
  rig.root.rotation.z = lerp(rig.root.rotation.z, rootRotZ, k);
  rig.root.scale.set(p.scale * (2 - squash), p.scale * squash, p.scale * (2 - squash));
  body.position.y = lerp(body.position.y, bodyY, k);
  body.scale.y = lerp(body.scale.y, bodyScaleY, k);
  body.rotation.z = lerp(body.rotation.z, bodyRotZ, k);
  body.rotation.x = lerp(body.rotation.x, bodyRotX, k);
  head.rotation.x = lerp(head.rotation.x, headRotX, k);
  head.rotation.y = lerp(head.rotation.y, headRotY, k);
  head.rotation.z = lerp(head.rotation.z, headRotZ, k);
  armL.rotation.z = lerp(armL.rotation.z, -aL, k);
  armR.rotation.z = lerp(armR.rotation.z, -aR, k);
  armL.rotation.x = lerp(armL.rotation.x, aLx, k);
  armR.rotation.x = lerp(armR.rotation.x, aRx, k);
  legL.rotation.x = lerp(legL.rotation.x, lL, k);
  legR.rotation.x = lerp(legR.rotation.x, lR, k);
  tail.rotation.y = lerp(tail.rotation.y, tailWag, k);
  tail.rotation.x = lerp(tail.rotation.x, tailUp, k);
  earL.rotation.z = lerp(earL.rotation.z, 0.35 + earDroop + s(time * 3.1) * 0.02, k);
  earR.rotation.z = lerp(earR.rotation.z, -0.35 - earDroop - s(time * 3.1) * 0.02, k);
  rig.bell.rotation.z = s(time * 5) * (p.action === "walk" || p.action === "happy" ? 0.4 : 0.05);
  rig.shadow.scale.setScalar(1 - Math.min(0.5, rig.root.position.y * 0.6));

  // 眨眼
  p.blink -= dt;
  if (p.blink <= 0 && p.blinking < 0) {
    p.blinking = 0;
    p.blink = 2 + Math.random() * 4;
  }
  let lid = 1;
  if (p.blinking >= 0) {
    p.blinking += dt;
    lid = Math.abs(1 - (p.blinking / 0.16) * 2);
    if (p.blinking >= 0.16) p.blinking = -1;
  }
  if (eyesClosed) lid = 0.08;
  for (const eye of [rig.eyeL, rig.eyeR]) eye.scale.y = lerp(eye.scale.y, Math.max(0.08, lid), Math.min(1, dt * 30));
  for (const pupil of [rig.pupilL, rig.pupilR]) {
    pupil.position.x = lerp(pupil.position.x, p.lookX * 0.035, k);
    pupil.position.y = lerp(pupil.position.y, p.lookY * 0.03, k);
  }
  rig.mouthOpen.visible = mouthOpen;
  rig.mouth.visible = !mouthOpen;
  // 心情不好时嘴角向下
  rig.mouth.rotation.z = p.mood < 30 ? Math.PI : 0;
  rig.mouth.position.y = p.mood < 30 ? -0.25 : -0.2;
  for (const c of rig.cheeks) c.visible = p.mood >= 45 || p.action === "happy" || p.action === "eat";
}
