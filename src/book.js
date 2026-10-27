import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createPageMaterial } from './pages.js';
import { createCornerMaterial } from './corner.js';

const TEX = {
  basecolor: '/assets/textures/diary_cover_basecolor.png',
  orm: '/assets/textures/diary_cover_orm.png',
};

const PAGE_TEX = {
  basecolor: '/assets/textures/page_basecolor.png',
  orm: '/assets/textures/page_orm.png',
  normal: '/assets/textures/page_normal.png',
};

// three 的 computeBoundingBox 会把全部 morph target 的位移累加到基网格上（实测 x 冲到 102），
// 接影面高度只能按基网格（第 0 页合上态）的 y 下限来放
function baseMinY(geometry) {
  const a = geometry.attributes.position.array;
  let min = Infinity;
  for (let i = 1; i < a.length; i += 3) min = Math.min(min, a[i]);
  return min;
}

function setupTexture(img, srgb, wrapping = THREE.ClampToEdgeWrapping) {
  img.flipY = false;
  img.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  img.wrapS = img.wrapT = wrapping;
  img.minFilter = THREE.LinearMipmapLinearFilter;
  img.magFilter = THREE.LinearFilter;
  img.generateMipmaps = true;
  img.anisotropy = 16;
  return img;
}

class BakedBook {
  /**
   * @param {Object} params
   * @param {THREE.Group} params.group
   * @param {Array<{ mesh: THREE.Mesh, source: string }>} params.meshes
   * @param {THREE.Material} params.pages
   * @param {THREE.Material} params.leather
   * @param {THREE.Material} params.spine
   * @param {THREE.Material} params.corner
   * @param {number} params.minY
   */
  constructor({ group, meshes, pages, leather, spine, corner, minY }) {
    this.group = group;
    this.meshes = meshes;
    this.pages = pages;
    this.leather = leather;
    this.spine = spine;
    this.corner = corner;
    this.minY = minY;
    // Corner 护角金属件网格高达 61448 顶点并绑定 27 组形态键，不参与书面交互与羽毛笔跟随，坚决排除以释放射线拾取算力
    this.pickableMeshes = meshes
      .filter((m) => m.source !== 'Corner')
      .map((m) => m.mesh);
  }

  /**
   * 统一设置姿态键与页码展开状态
   * 
   * 职责：
   * 1. 隐藏 4 块部件网格的 morphTargetInfluences 遍历与线性插值混合；
   * 2. 同步驱动内页材质着色器的 open uniform。
   *
   * @param {number} key 当前姿态键号 (0 ~ 27)
   * @param {number} [page] 当前展开进度页数 (0 ~ 12)
   */
  setPose(key, page = null) {
    const count = this.meshes[0].mesh.morphTargetInfluences.length;
    const k = THREE.MathUtils.clamp(Math.floor(key), 0, count);
    const blend = THREE.MathUtils.clamp(key - k, 0, 1);

    for (let i = 0; i < this.meshes.length; i++) {
      const inf = this.meshes[i].mesh.morphTargetInfluences;
      inf.fill(0);
      if (k > 0) inf[k - 1] = 1 - blend;
      if (blend > 0 && k < count) inf[k] = blend;
    }

    if (page !== null && this.pages?.userData?.open) {
      this.pages.userData.open.value = THREE.MathUtils.clamp(page, 0, 1);
    }
  }

  /**
   * 诊断与量化调试信息
   */
  get targetsInfo() {
    return this.meshes.map(({ mesh, source }) => ({
      mesh: mesh.name,
      source,
      influences: mesh.morphTargetInfluences.length,
      relative: mesh.geometry.morphTargetsRelative,
      dictionary: Object.keys(mesh.morphTargetDictionary ?? {}),
      vertices: mesh.geometry.attributes.position.count,
    }));
  }
}

export async function loadBook(url, options = {}) {
  const envMap = options?.envMap ?? null;
  const loader = new GLTFLoader();
  const tex = new THREE.TextureLoader();
  const [gltf, basecolor, orm, pageBasecolor, pageOrm, pageNormal] = await Promise.all([
    loader.loadAsync(url),
    tex.loadAsync(TEX.basecolor),
    tex.loadAsync(TEX.orm),
    tex.loadAsync(PAGE_TEX.basecolor),
    tex.loadAsync(PAGE_TEX.orm),
    tex.loadAsync(PAGE_TEX.normal),
  ]);
  setupTexture(basecolor, true);
  setupTexture(orm, false);
  setupTexture(pageBasecolor, true, THREE.RepeatWrapping);
  setupTexture(pageOrm, false, THREE.RepeatWrapping);
  setupTexture(pageNormal, false, THREE.RepeatWrapping);

  const leather = new THREE.MeshPhysicalMaterial({
    name: 'DiaryLeather',
    map: basecolor,
    roughnessMap: orm,
    metalnessMap: orm,
    roughness: 1,
    metalness: 1,
    clearcoat: 0.0,
    ior: 1.50,
    envMap,
    envMapIntensity: 0.08,
    side: THREE.DoubleSide,
  });

  const pages = createPageMaterial({
    basecolor: pageBasecolor,
    orm: pageOrm,
    normal: pageNormal,
    inkTexture: options?.inkTexture ?? null,
    textDissolve: options?.textDissolve ?? null,
    leftTextDissolve: options?.leftTextDissolve ?? null,
    leftEmergingYRange: options?.leftEmergingYRange ?? null,
    leftHoverBox: options?.leftHoverBox ?? null,
    leftHoverProgress: options?.leftHoverProgress ?? null,
    leftHoverMode: options?.leftHoverMode ?? null,
  });

  const spine = new THREE.MeshStandardMaterial({
    name: 'DiarySpine',
    color: new THREE.Color(0.52, 0.40, 0.25),
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  const corner = createCornerMaterial({ envMap });

  const meshes = [];
  let minY = Infinity;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const source = o.material.name;
    if (source === 'BookCover') {
      o.material = leather;
      o.receiveShadow = true;
    } else if (source === 'BookSpine') {
      o.material = spine;
      o.receiveShadow = false;
    } else if (source === 'Corner') {
      o.material = corner;
      o.receiveShadow = true;
    } else {
      o.material = pages;
      o.receiveShadow = true;
    }
    o.castShadow = true;
    minY = Math.min(minY, baseMinY(o.geometry));
    meshes.push({ mesh: o, source });
  });

  return new BakedBook({
    group: gltf.scene,
    meshes,
    pages,
    leather,
    spine,
    corner,
    minY,
  });
}
