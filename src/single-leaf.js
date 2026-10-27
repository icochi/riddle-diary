import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BOOK_SEAM_X } from './page-surface-evaluator.js';
import { easeInOutQuad } from './session-echo-playback.js';

/**
 * 单页翻页动画组件 (SingleLeafTurn)
 *
 * 职责：
 * 1. 加载并维护由 Blender 烘焙的单页物理网格模型 (/assets/single-leaf.glb)；
 * 2. 挂接 pages.js 相同的双面真实古纸 PBR 材质与着色器，与日记本内页 100% 视觉无缝统一；
 * 3. 驱动 9 组 Morph Target 姿态键，实现高质量非线性左向右 / 右向左双向翻飞拱弧动画；
 * 4. 右向左翻页时，基于日记本装订中缝 (BOOK_SEAM_X) 精确镜像几何变换，确保旋转铰链轴始终锁定在中缝；
 * 5. 翻页开始时显示，落定后自动隐藏并回调完成事件。
 */
export class SingleLeafTurn {
  /**
   * @param {Object} options
   * @param {THREE.Mesh} options.mesh
   * @param {THREE.Material} options.material
   * @param {number} [options.seamX=BOOK_SEAM_X] 日记本中央装订中缝基准 X 坐标
   */
  constructor({ mesh, material, seamX = BOOK_SEAM_X }) {
    this.mesh = mesh;
    this.material = material;
    this.seamX = seamX;
    this.isPlaying = false;
    this.progress = 0.0;
    this.duration = 0.68; // 翻页动画时长 (秒)
    this.direction = 'forward'; // 'forward' (左向右) | 'backward' (右向左)
    this.onComplete = null;

    // 初始不可见
    this.mesh.visible = false;
  }

  /**
   * 启动单页翻页动画
   * @param {Object} [params]
   * @param {'forward'|'backward'} [params.direction='forward'] 翻页方向
   * @param {Function} [params.onComplete] 翻页落定回调
   */
  play({ direction = 'forward', onComplete = null } = {}) {
    this.isPlaying = true;
    this.progress = 0.0;
    this.direction = direction;
    this.onComplete = onComplete;
    this.mesh.visible = true;

    // 'forward' (左向右): 原始朝向与原点
    // 'backward' (右向左): X 轴关于装订中缝 (seamX) 镜像对称变换
    // 对称平面为 X = seamX，对任意局部点 X_local，镜像后的世界坐标为：
    // X_world = seamX - (X_local - seamX) = 2 * seamX - X_local
    // 对应 Three.js 变换：scale.x = -1, position.x = 2 * seamX
    if (this.mesh.scale) {
      this.mesh.scale.x = (direction === 'backward' ? -1 : 1);
    }
    if (this.mesh.position) {
      this.mesh.position.x = (direction === 'backward' ? 2 * this.seamX : 0);
    }
    this.setMorphProgress(0.0);
  }

  /**
   * 立即停止动画并强制隐藏单页
   */
  stop() {
    this.isPlaying = false;
    this.progress = 0.0;
    this.mesh.visible = false;
    if (this.mesh.scale) {
      this.mesh.scale.x = 1;
    }
    if (this.mesh.position) {
      this.mesh.position.x = 0;
    }
    this.direction = 'forward';
    this.setMorphProgress(0.0);
    this.onComplete = null;
  }

  /**
   * 每帧步进
   * @param {number} dt 帧间隔 (秒)
   */
  update(dt) {
    if (!this.isPlaying) {
      if (this.mesh.visible) {
        this.mesh.visible = false;
      }
      return;
    }

    this.progress += dt / this.duration;
    if (this.progress >= 1.0) {
      this.progress = 1.0;
      this.setMorphProgress(1.0);
      this.isPlaying = false;
      this.mesh.visible = false;
      if (this.mesh.scale) {
        this.mesh.scale.x = 1;
      }
      if (this.mesh.position) {
        this.mesh.position.x = 0;
      }
      this.direction = 'forward';

      if (this.onComplete) {
        const cb = this.onComplete;
        this.onComplete = null;
        cb();
      }
      return;
    }

    // 缓动曲线：先平滑加速后轻柔减速 (Ease In Out Quad)
    this.setMorphProgress(easeInOutQuad(this.progress));
  }

  /**
   * 根据 0..1 归一化进度混合 9 组形态键
   * turn_00 (0.0) -> turn_04_apex (0.5) -> turn_08_flat (1.0)
   * @param {number} p 0.0 ~ 1.0
   */
  setMorphProgress(p) {
    const influences = this.mesh.morphTargetInfluences;
    if (!influences) return;

    influences.fill(0);
    const count = influences.length; // 9
    const pos = p * (count - 1);
    const idx = Math.min(Math.floor(pos), count - 2);
    const blend = pos - idx;

    influences[idx] = 1.0 - blend;
    influences[idx + 1] = blend;
  }
}

/**
 * 加载单页翻页动画资产
 * @param {string} url
 * @param {THREE.Material} pageMaterial 复用日记本内页的真实着色器材质
 * @param {Object} [options]
 * @param {number} [options.seamX=BOOK_SEAM_X] 日记本中央装订中缝基准 X 坐标
 */
export async function loadSingleLeaf(url = '/assets/single-leaf.glb', pageMaterial, options = {}) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);

  let leafMesh = null;
  gltf.scene.traverse((child) => {
    if (child.isMesh) {
      leafMesh = child;
      child.castShadow = true;
      child.receiveShadow = true;
      child.material = pageMaterial;
    }
  });

  if (!leafMesh) {
    throw new Error('single-leaf.glb 中未找到网格模型');
  }

  return new SingleLeafTurn({
    mesh: leafMesh,
    material: pageMaterial,
    seamX: options?.seamX ?? BOOK_SEAM_X,
  });
}
