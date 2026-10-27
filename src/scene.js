import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LAST_PAGE } from './turn.js';

// Blender 的 sun 颜色与 World 灰都是线性值，走 sRGB 会被二次压暗
const linear = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);

// spec 锁的是水平 fov（45mm / 36mm 传感器），three 的 fov 是垂直的
const H_FOV = (43.15 * Math.PI) / 180;
const SUNS = [
  // 桌面前方头顶阅读台灯（Key）：位于读者面前上方偏左，斜下照射桌面中央，产生自然向后延伸的柔和投影
  { name: 'Key', strength: 2.3, color: linear(1.0, 0.89, 0.73), dir: [-0.3, 0.88, 0.44], shadow: true },
  // 轮廓微光 (Rim)：右侧方极弱微光，仅给书侧勾出微弱轮廓线，避免直冲镜头产生桌面反光
  { name: 'Rim', strength: 0.12, color: linear(0.85, 0.9, 1.0), dir: [0.85, 0.35, -0.1] },
  // 柔和暗部补光 (Fill)：右前方暖棕微补光，丰富暗部层次
  { name: 'Fill', strength: 0.42, color: linear(0.85, 0.65, 0.48), dir: [0.55, 0.6, 0.58] },
];
const WORLD_GRAY = 0.05;
const LIGHT_DIST = 8;
import { VIEW } from './camera-director.js';

export function createStage(canvasParent) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvasParent.clientWidth, canvasParent.clientHeight);
  // ACES Filmic 带来胶片级高光平滑滚降与暖调对比
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  canvasParent.append(renderer.domElement);
  // 画布是唯一的交互面，给它一个可访问名，键盘与辅助技术才找得到这块热区
  renderer.domElement.setAttribute('role', 'button');
  renderer.domElement.setAttribute('aria-label', '翻页');
  renderer.domElement.setAttribute('tabindex', '0');

  const scene = new THREE.Scene();
  scene.background = linear(WORLD_GRAY, WORLD_GRAY * 0.9, WORLD_GRAY * 0.8);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = scene.background;
  scene.environment = pmrem.fromScene(envScene, 0, 0.1, 100).texture;

  // 为日记本封面、护角与墨水瓶等高级物理材质生成专属暗调环境反射贴图（100% 隔离桌面与背景，防止全局冲白）
  const darkEnvMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(25, 1, 0.1, 1000);
  camera.position.copy(VIEW.browse);
  camera.lookAt(0, 0, 0);

  const lights = {};
  for (const s of SUNS) {
    const light = new THREE.DirectionalLight(s.color, s.strength);
    light.position.set(...s.dir).normalize().multiplyScalar(LIGHT_DIST);
    light.castShadow = Boolean(s.shadow);
    if (light.castShadow) {
      light.shadow.mapSize.set(2048, 2048);
      Object.assign(light.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 1, far: 20 });
      // 减小 bias 与 normalBias，消除接触面 Peter Panning 悬空感
      light.shadow.normalBias = 0.0018;
      light.shadow.bias = -0.00005;
      light.shadow.radius = 2.2;
    }
    scene.add(light, light.target);
    lights[s.name] = light;
  }

  // 地面漫反射半球光：天空微弱环境冷光 + 地面暗红木反弹暖光（模拟真实 GI 漫反射，将红木底色反弹至书本底边与书芯，消除悬浮断层）
  const hemi = new THREE.HemisphereLight(
    linear(0.85, 0.8, 0.72),
    linear(0.55, 0.18, 0.08),
    0.38
  );
  scene.add(hemi);
  lights.Hemi = hemi;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.4 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  function resize() {
    const w = canvasParent.clientWidth || window.innerWidth || 1;
    const h = canvasParent.clientHeight || window.innerHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = (2 * Math.atan(Math.tan(H_FOV / 2) / camera.aspect) * 180) / Math.PI;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);
  if (typeof ResizeObserver !== 'undefined' && canvasParent) {
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvasParent);
  }

  return {
    renderer,
    scene,
    camera,
    lights,
    ground,
    darkEnvMap,
    render: () => renderer.render(scene, camera),
  };
}

export function createContactShadow() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 512);

  // 绘制双重柔和接触阴影：紧实深黑接触核 + 渐变羽化软影，彻底消除图层割裂悬浮感
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.92)';
  ctx.shadowBlur = 40;
  ctx.beginPath();
  ctx.roundRect(80, 50, 352, 412, 32);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;

  const geo = new THREE.PlaneGeometry(1.15, 1.55);
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  return mesh;
}

const DESKTOP_TEX = {
  basecolor: '/assets/textures/desktop_basecolor.png',
  normal: '/assets/textures/desktop_normal.png',
  orm: '/assets/textures/desktop_orm.png',
};

function desktopTexture(img, srgb, repeat = 10) {
  img.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  img.wrapS = img.wrapT = THREE.RepeatWrapping;
  img.repeat.set(repeat, repeat);
  img.minFilter = THREE.LinearMipmapLinearFilter;
  img.magFilter = THREE.LinearFilter;
  img.generateMipmaps = true;
  img.anisotropy = 16;
  return img;
}

export async function loadDesktop(ground, repeat = 15) {
  const tex = new THREE.TextureLoader();
  const [basecolor, normal, orm] = await Promise.all([
    tex.loadAsync(DESKTOP_TEX.basecolor),
    tex.loadAsync(DESKTOP_TEX.normal),
    tex.loadAsync(DESKTOP_TEX.orm),
  ]);
  desktopTexture(basecolor, true, repeat);
  desktopTexture(normal, false, repeat);
  desktopTexture(orm, false, repeat);

  const material = new THREE.MeshPhysicalMaterial({
    name: 'M_Desktop',
    map: basecolor,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughnessMap: orm,
    metalnessMap: orm,
    aoMap: orm,
    roughness: 0.65,
    metalness: 0.0,
    clearcoat: 0.42,
    clearcoatRoughness: 0.05,
    aoMapIntensity: 1,
  });
  if (ground) {
    ground.material = material;
  }
  return material;
}
