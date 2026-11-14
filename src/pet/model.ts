import * as THREE from "three";

/**
 * 宠物的模型：一只肚子上有口袋的小狸猫，全部用基本形状拼出来，不依赖任何外部模型文件。
 * 脚底在 y = 0，身高大约 2.5 个单位，脸朝 +z。
 */

const C = {
  fur: 0xd98e4a,
  furDark: 0x6b4226,
  cream: 0xfff1dc,
  patch: 0x5a3a22,
  nose: 0x2e1f17,
  pink: 0xff9d9d,
  scarf: 0x2a8bef,
  scarfDark: 0x1c6fd0,
  gold: 0xf6c445,
  goldDark: 0x9a6a08,
  white: 0xffffff,
  line: 0x3a2618,
};

function toonRamp(): THREE.DataTexture {
  // 三级明暗：卡通渲染的色阶。
  const data = new Uint8Array([120, 120, 120, 255, 190, 190, 190, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export interface Rig {
  root: THREE.Group; // 整只（位置、朝向、整体缩放）
  body: THREE.Group; // 躯干以上（呼吸、弹跳）
  head: THREE.Group;
  earL: THREE.Object3D;
  earR: THREE.Object3D;
  eyeL: THREE.Group;
  eyeR: THREE.Group;
  pupilL: THREE.Object3D;
  pupilR: THREE.Object3D;
  mouth: THREE.Object3D;
  mouthOpen: THREE.Object3D;
  cheeks: THREE.Object3D[];
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  tail: THREE.Group;
  bell: THREE.Object3D;
  pocket: THREE.Object3D;
  hand: THREE.Group; // 右手里拿的东西挂在这里
  shadow: THREE.Mesh;
  accessories: Record<string, THREE.Object3D>;
  items: Record<string, THREE.Object3D>;
  effects: THREE.Group; // 爱心、星星、泡泡这些飘起来的小东西
}

export function buildPet(): Rig {
  const ramp = toonRamp();
  const mat = (color: number, extra: Partial<THREE.MeshToonMaterialParameters> = {}) => new THREE.MeshToonMaterial({ color, gradientMap: ramp, ...extra });
  const outlineMat = new THREE.MeshBasicMaterial({ color: C.line, side: THREE.BackSide });
  const sphere = (r: number, m: THREE.Material, seg = 28) => new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * 0.75)), m);
  /** 加一圈描边：把同样的形状放大一点、只画背面。 */
  const outlined = <T extends THREE.Mesh>(mesh: T, grow = 1.05): T => {
    const o = new THREE.Mesh(mesh.geometry, outlineMat);
    o.scale.setScalar(grow);
    mesh.add(o);
    return mesh;
  };
  const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T => {
    o.position.set(x, y, z);
    return o;
  };

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // 影子
  const sc = document.createElement("canvas");
  sc.width = sc.height = 128;
  const g2 = sc.getContext("2d")!;
  const grad = g2.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, "rgba(0,0,0,0.42)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g2.fillStyle = grad;
  g2.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.0), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  root.add(shadow);

  // 腿和脚
  const makeLeg = (x: number) => {
    const leg = new THREE.Group();
    const foot = outlined(sphere(0.23, mat(C.furDark)), 1.07);
    foot.scale.set(1, 0.62, 1.35);
    at(foot, 0, -0.22, 0.1);
    const pad = sphere(0.1, mat(C.pink));
    pad.scale.set(1, 0.3, 1.2);
    at(pad, 0, -0.33, 0.14);
    leg.add(foot, pad);
    return at(leg, x, 0.36, 0.02);
  };
  const legL = makeLeg(-0.34);
  const legR = makeLeg(0.34);
  root.add(legL, legR);

  // 尾巴：三节，颜色一深一浅
  const tail = new THREE.Group();
  [
    [0.3, C.fur, 0, 0, -0.18],
    [0.34, C.furDark, 0, 0.14, -0.5],
    [0.3, C.fur, 0, 0.36, -0.78],
    [0.2, C.cream, 0, 0.56, -0.96],
  ].forEach(([r, color, x, y, z]) => tail.add(at(outlined(sphere(r!, mat(color!)), 1.06), x!, y!, z!)));
  at(tail, 0, 0.5, -0.5);
  body.add(tail);

  // 身体
  const torso = outlined(sphere(0.74, mat(C.fur), 36), 1.035);
  torso.scale.set(1, 0.97, 0.9);
  body.add(at(torso, 0, 0.86, 0));
  const belly = sphere(0.6, mat(C.cream), 32);
  belly.scale.set(0.9, 0.9, 0.55);
  body.add(at(belly, 0, 0.8, 0.36));

  // 口袋：贴在肚子上的半圆，带蓝色缝线
  const pocket = new THREE.Group();
  const pouch = new THREE.Mesh(new THREE.CircleGeometry(0.31, 32, Math.PI, Math.PI), mat(C.white, { side: THREE.DoubleSide }));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.02, 8, 32, Math.PI), mat(C.scarfDark));
  rim.rotation.z = Math.PI;
  const top = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.62, 4, 8), mat(C.scarfDark));
  top.rotation.z = Math.PI / 2;
  const stitch = new THREE.Group();
  for (let i = 1; i < 9; i++) {
    const a = Math.PI + (i / 9) * Math.PI;
    const dot = new THREE.Mesh(new THREE.CapsuleGeometry(0.01, 0.04, 2, 6), mat(C.scarf));
    dot.position.set(Math.cos(a) * 0.245, Math.sin(a) * 0.245, 0.004);
    dot.rotation.z = a;
    stitch.add(dot);
  }
  pocket.add(pouch, rim, top, stitch);
  pocket.rotation.x = -0.16;
  body.add(at(pocket, 0, 0.83, 0.705));

  // 手臂：从肩膀垂下来，绕肩膀转
  const makeArm = (side: number) => {
    const arm = new THREE.Group();
    const upper = outlined(new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.34, 6, 14), mat(C.fur)), 1.1);
    at(upper, 0, -0.24, 0);
    const paw = outlined(sphere(0.15, mat(C.furDark)), 1.08);
    at(paw, 0, -0.52, 0.02);
    arm.add(upper, paw);
    arm.rotation.z = side * 0.42;
    return at(arm, side * 0.62, 1.2, 0.08);
  };
  const armL = makeArm(-1);
  const armR = makeArm(1);
  body.add(armL, armR);
  const hand = new THREE.Group();
  at(hand, 0, -0.66, 0.16);
  armR.add(hand);

  // 围巾和铃铛
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.115, 14, 36), mat(C.scarf));
  scarf.rotation.x = Math.PI / 2 + 0.12;
  scarf.scale.set(1, 0.92, 1);
  body.add(at(scarf, 0, 1.38, 0.03));
  const scarfEnd = outlined(new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.3, 4, 10), mat(C.scarfDark)), 1.08);
  scarfEnd.rotation.z = 0.5;
  body.add(at(scarfEnd, -0.36, 1.16, 0.44));
  const bell = new THREE.Group();
  bell.add(outlined(sphere(0.125, mat(C.gold)), 1.1));
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.126, 0.014, 6, 24), mat(C.goldDark));
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.025;
  const hole = at(sphere(0.03, mat(C.goldDark)), 0, -0.04, 0.112);
  const slit = at(new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.08, 0.02), mat(C.goldDark)), 0, -0.085, 0.092);
  bell.add(band, hole, slit);
  body.add(at(bell, 0.04, 1.22, 0.5));

  // 头
  const head = new THREE.Group();
  at(head, 0, 1.92, 0.02);
  body.add(head);
  const skull = outlined(sphere(0.66, mat(C.fur), 40), 1.035);
  skull.scale.set(1.1, 0.94, 0.98);
  head.add(skull);
  const face = sphere(0.52, mat(C.cream), 32);
  face.scale.set(1.05, 0.72, 0.5);
  head.add(at(face, 0, -0.14, 0.4));

  // 耳朵
  const makeEar = (side: number) => {
    const ear = new THREE.Group();
    const outer = outlined(sphere(0.22, mat(C.fur)), 1.08);
    outer.scale.set(1, 1.05, 0.6);
    const inner = sphere(0.13, mat(C.furDark));
    inner.scale.set(1, 1.05, 0.5);
    at(inner, 0, -0.01, 0.08);
    ear.add(outer, inner);
    ear.rotation.z = -side * 0.35;
    return at(ear, side * 0.46, 0.5, 0);
  };
  const earL = makeEar(-1);
  const earR = makeEar(1);
  head.add(earL, earR);

  // 眼睛：深色的眼圈、白眼球、黑眼珠、高光
  const makeEye = (side: number) => {
    const patch = sphere(0.2, mat(C.patch));
    patch.scale.set(1.05, 1.22, 0.4);
    patch.rotation.z = side * 0.3;
    head.add(at(patch, side * 0.27, 0.01, 0.52));
    const eye = new THREE.Group();
    const white = sphere(0.115, mat(C.white));
    white.scale.set(1, 1.08, 0.6);
    const pupil = new THREE.Group();
    const iris = sphere(0.078, new THREE.MeshBasicMaterial({ color: 0x1b1210 }));
    iris.scale.set(1, 1.05, 0.5);
    const glint = at(sphere(0.028, new THREE.MeshBasicMaterial({ color: 0xffffff })), -0.025, 0.035, 0.04);
    pupil.add(iris, glint);
    at(pupil, 0, 0, 0.05);
    eye.add(white, pupil);
    head.add(at(eye, side * 0.27, 0.03, 0.6));
    return { eye, pupil };
  };
  const L = makeEye(-1);
  const R = makeEye(1);

  // 鼻子、嘴、腮红
  const nose = sphere(0.07, mat(C.nose));
  nose.scale.set(1.2, 0.8, 0.8);
  head.add(at(nose, 0, -0.14, 0.68));
  const mouth = new THREE.Group();
  for (const side of [-1, 1]) {
    const curve = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.014, 6, 16, Math.PI), new THREE.MeshBasicMaterial({ color: C.nose }));
    curve.rotation.z = Math.PI;
    curve.position.x = side * 0.065;
    mouth.add(curve);
  }
  head.add(at(mouth, 0, -0.2, 0.655));
  const mouthOpen = sphere(0.07, new THREE.MeshBasicMaterial({ color: 0x7a2f2f }));
  mouthOpen.scale.set(1, 0.9, 0.4);
  mouthOpen.visible = false;
  head.add(at(mouthOpen, 0, -0.28, 0.64));
  const cheeks = [-1, 1].map((side) => {
    const c = sphere(0.09, new THREE.MeshBasicMaterial({ color: C.pink, transparent: true, opacity: 0.7 }));
    c.scale.set(1.25, 0.75, 0.3);
    head.add(at(c, side * 0.43, -0.2, 0.5));
    return c;
  });

  // 饰品（默认都不戴）
  const accessories: Record<string, THREE.Object3D> = {};
  const hat = new THREE.Group();
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.66, 0.05, 32), mat(0xe9c46a));
  const crownHat = at(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.3, 28), mat(0xe9c46a)), 0, 0.16, 0);
  const ribbon = at(new THREE.Mesh(new THREE.CylinderGeometry(0.405, 0.41, 0.09, 28), mat(0xd1495b)), 0, 0.07, 0);
  hat.add(brim, crownHat, ribbon);
  hat.rotation.set(-0.12, 0, 0.1);
  accessories.hat = at(hat, 0, 0.6, 0.02);
  const glasses = new THREE.Group();
  for (const side of [-1, 1]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.02, 8, 28), mat(0x2b2b2b));
    ring.position.x = side * 0.27;
    glasses.add(ring);
  }
  const bridge = new THREE.Mesh(new THREE.CapsuleGeometry(0.016, 0.16, 4, 8), mat(0x2b2b2b));
  bridge.rotation.z = Math.PI / 2;
  glasses.add(bridge);
  accessories.glasses = at(glasses, 0, 0.03, 0.68);
  const bow = new THREE.Group();
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.22, 16), mat(0xff6b9d));
    wing.rotation.z = side * (Math.PI / 2);
    wing.position.x = side * 0.11;
    bow.add(wing);
  }
  bow.add(sphere(0.05, mat(0xe0527f)));
  bow.rotation.z = -0.3;
  accessories.bow = at(bow, 0.36, 0.5, 0.26);
  const crown = new THREE.Group();
  crown.add(new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.12, 24, 1, true), mat(C.gold, { side: THREE.DoubleSide })));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    crown.add(at(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 10), mat(C.gold)), Math.cos(a) * 0.25, 0.13, Math.sin(a) * 0.25));
  }
  crown.add(at(sphere(0.04, mat(0xe63946)), 0, 0.02, 0.26));
  accessories.crown = at(crown, 0, 0.66, 0);
  for (const a of Object.values(accessories)) {
    a.visible = false;
    head.add(a);
  }

  // 手里能拿的东西
  const items: Record<string, THREE.Object3D> = {};
  const riceball = new THREE.Group();
  const rice = sphere(0.2, mat(C.white));
  rice.scale.set(1, 0.9, 0.8);
  riceball.add(outlined(rice, 1.08), at(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.3), mat(0x24332a)), 0, -0.1, 0));
  items.riceball = riceball;
  const apple = new THREE.Group();
  apple.add(outlined(sphere(0.18, mat(0xe63946)), 1.08), at(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1), mat(0x5a3a22)), 0, 0.2, 0), at(sphere(0.05, mat(0x52b788)), 0.06, 0.22, 0));
  items.apple = apple;
  const fish = new THREE.Group();
  const fishBody = outlined(sphere(0.2, mat(0xf4a261)), 1.08);
  fishBody.scale.set(1.5, 0.75, 0.5);
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.2, 3), mat(0xe76f51));
  fin.rotation.z = Math.PI / 2;
  fish.add(fishBody, at(fin, -0.36, 0, 0), at(sphere(0.025, new THREE.MeshBasicMaterial({ color: 0x1b1210 })), 0.2, 0.04, 0.09));
  items.fish = fish;
  const cake = new THREE.Group();
  cake.add(outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 24), mat(0xfff1dc)), 1.08), at(new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.05, 24), mat(0xffb4c6)), 0, 0.1, 0), at(sphere(0.05, mat(0xe63946)), 0, 0.16, 0));
  items.cake = cake;
  const ball = new THREE.Group();
  ball.add(outlined(sphere(0.2, mat(0x4cc9f0)), 1.08));
  const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 8, 28), mat(0xffd166));
  stripe.rotation.x = Math.PI / 2;
  ball.add(stripe);
  items.ball = ball;
  const balloon = new THREE.Group();
  const bulb = outlined(sphere(0.26, mat(0xef476f)), 1.06);
  bulb.scale.set(1, 1.15, 1);
  balloon.add(at(bulb, 0, 0.75, 0), at(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.55), mat(0x555555)), 0, 0.24, 0));
  items.balloon = balloon;
  const star = new THREE.Group();
  star.add(outlined(new THREE.Mesh(new THREE.OctahedronGeometry(0.2), mat(C.gold)), 1.1));
  items.star = star;
  const flower = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    flower.add(at(sphere(0.08, mat(0xffafcc)), Math.cos(a) * 0.11, 0.3 + Math.sin(a) * 0.11, 0));
  }
  flower.add(at(sphere(0.07, mat(C.gold)), 0, 0.3, 0.02), at(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3), mat(0x52b788)), 0, 0.1, 0));
  items.flower = flower;
  for (const it of Object.values(items)) {
    it.visible = false;
    hand.add(it);
  }

  const effects = new THREE.Group();
  root.add(effects);

  return {
    root, body, head, earL, earR, eyeL: L.eye, eyeR: R.eye, pupilL: L.pupil, pupilR: R.pupil, mouth, mouthOpen, cheeks,
    armL, armR, legL, legR, tail, bell, pocket, hand, shadow, accessories, items, effects,
  };
}

/** 飘起来的小东西：爱心、星星、音符、泡泡、Z。画在小画布上做成贴图。 */
const glyphs: Record<string, THREE.Texture> = {};
export function glyphTexture(char: string, color: string): THREE.Texture {
  const key = char + color;
  if (!glyphs[key]) {
    const c = document.createElement("canvas");
    c.width = c.height = 96;
    const g = c.getContext("2d")!;
    g.font = "72px system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.fillText(char, 48, 52);
    glyphs[key] = new THREE.CanvasTexture(c);
  }
  return glyphs[key]!;
}

export interface Particle {
  sprite: THREE.Sprite;
  vx: number;
  vy: number;
  life: number;
  max: number;
  spin: number;
}

export function spawn(rig: Rig, list: Particle[], char: string, color: string, n = 1, origin: [number, number, number] = [0, 2.3, 0.5]) {
  for (let i = 0; i < n; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glyphTexture(char, color), transparent: true, depthTest: false }));
    sprite.scale.setScalar(0.34 + Math.random() * 0.14);
    sprite.position.set(origin[0] + (Math.random() - 0.5) * 0.9, origin[1] + Math.random() * 0.3, origin[2]);
    rig.effects.add(sprite);
    list.push({ sprite, vx: (Math.random() - 0.5) * 0.5, vy: 0.5 + Math.random() * 0.5, life: 0, max: 1.3 + Math.random() * 0.6, spin: (Math.random() - 0.5) * 2 });
  }
}

export function stepParticles(rig: Rig, list: Particle[], dt: number) {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i]!;
    p.life += dt;
    p.sprite.position.x += p.vx * dt;
    p.sprite.position.y += p.vy * dt;
    p.sprite.material.rotation += p.spin * dt;
    p.sprite.material.opacity = Math.max(0, 1 - p.life / p.max);
    if (p.life >= p.max) {
      rig.effects.remove(p.sprite);
      p.sprite.material.dispose();
      list.splice(i, 1);
    }
  }
}
