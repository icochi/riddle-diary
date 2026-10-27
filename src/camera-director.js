import * as THREE from 'three';
import { LAST_PAGE } from './turn.js';

export const VIEW = {
  browse: new THREE.Vector3(-0.68, 3.504, 2.9),
  seam: new THREE.Vector3(0, 3.504, 2.9),
  headon: new THREE.Vector3(0, 3.2, 0.0001),
};

export const TARGET = {
  browse: new THREE.Vector3(-0.68, 0, 0),
  seam: new THREE.Vector3(0, 0, 0),
  headon: new THREE.Vector3(0, 0, 0),
};

// 镜头调度分界点：
// - SEAM_SETTLE_PAGE: 封面掀开落稳且镜头平移至中缝到位的进度页码（第 1 页）
// - HEADON_START_PAGE: 快速翻页结束、开始从中缝斜俯过渡至正对俯视的进度页码（第 9 页）
export const SEAM_SETTLE_PAGE = 1;
export const HEADON_START_PAGE = 9;

const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();

/**
 * 纯数学函数：计算指定页码进度与混合因子下的相机位姿
 * 零副作用，可直接用于自动化单元测试
 * @param {number} page 当前展开页码 (0 ~ 12)
 * @param {'browse'|'seam'|'headon'|number|null} [forcedOrBlend=null]
 * @returns {{ position: THREE.Vector3, target: THREE.Vector3 }}
 */
export function calculateCameraPose(page, forcedOrBlend = null) {
  const position = new THREE.Vector3();
  const target = new THREE.Vector3();

  // 1. 若外部指定了强制机位命名
  if (typeof forcedOrBlend === 'string' && VIEW[forcedOrBlend]) {
    position.copy(VIEW[forcedOrBlend]);
    target.copy(TARGET[forcedOrBlend]);
    return { position, target };
  }

  // 2. 阶段一：初始合上态 (page <= 0)，居中全景
  if (page <= 0) {
    position.copy(VIEW.browse);
    target.copy(TARGET.browse);
    return { position, target };
  }

  // 3. 阶段二：封面掀开翻起阶段 (0 < page < 1)，从全景平滑平移至中缝
  if (page < SEAM_SETTLE_PAGE) {
    const k = THREE.MathUtils.clamp(page / SEAM_SETTLE_PAGE, 0, 1);
    position.lerpVectors(VIEW.browse, VIEW.seam, k);
    target.lerpVectors(TARGET.browse, TARGET.seam, k);
    return { position, target };
  }

  // 4. 阶段三：内页快速翻飞阶段 (1 <= page < 9)，稳定对准中缝
  if (page < HEADON_START_PAGE) {
    position.copy(VIEW.seam);
    target.copy(TARGET.seam);
    return { position, target };
  }

  // 5. 阶段四：翻页收尾与完全摊开阶段 (9 <= page <= 12)
  const targetK = typeof forcedOrBlend === 'number'
    ? forcedOrBlend
    : THREE.MathUtils.clamp((page - HEADON_START_PAGE) / (LAST_PAGE - HEADON_START_PAGE), 0, 1);

  position.lerpVectors(VIEW.seam, VIEW.headon, targetK);
  target.lerpVectors(TARGET.seam, TARGET.headon, targetK);
  return { position, target };
}

/**
 * 镜头调度器深模块 (CameraDirector)
 *
 * 职责：
 * 1. 封装四阶段分段运镜插值时序；
 * 2. 封装完全摊开就绪态下的鼠标悬停平滑指数插值；
 * 3. 响应手动调试面板与强制机位覆盖；
 * 4. 主循环仅通过 step(dt, page, isFullyOpen, isHovering) 推进。
 */
export class CameraDirector {
  /**
   * @param {Object} options
   * @param {THREE.PerspectiveCamera} options.camera 待调度的相机
   * @param {'browse'|'seam'|'headon'|null} [options.forcedView=null] 命令行/URL 强制视角
   */
  constructor({ camera, forcedView = null }) {
    this.camera = camera;
    this.forcedView = forcedView;

    // 完全摊开就绪态下的悬停平滑混合因子 (0: 中缝对齐 Seam view, 1: 正对俯视 Head-on view)
    this.hoverBlend = 1.0;
    this.lockedBlend = null;
  }

  /**
   * 锁定镜头平滑过渡至中缝对齐视角（Seam view，用于翻页转场）
   */
  lockSeamView() {
    this.lockedBlend = 0.0;
  }

  /**
   * 锁定镜头平滑过渡至正对俯视视角（Head-on view，用于正对阅读历史回顾）
   */
  lockHeadonView() {
    this.lockedBlend = 1.0;
  }

  /**
   * 解除视角锁定，恢复根据鼠标悬停状态自动调度
   */
  releaseSeamView() {
    this.lockedBlend = null;
  }

  /**
   * 立即应用指定页码下的机位（例如页面跳转或定格初始化时调用）
   * @param {number} page
   */
  applyPose(page) {
    const { position, target } = calculateCameraPose(page, this.forcedView);
    this.camera.position.copy(position);
    this.camera.lookAt(target);
    const currentTarget = (this.camera.userData.target = this.camera.userData.target || new THREE.Vector3());
    currentTarget.copy(target);
  }

  /**
   * 主循环步进推进机位
   * @param {number} dt 帧间隔 (秒)
   * @param {number} page 当前页码
   * @param {boolean} isFullyOpen 是否完全摊开
   * @param {boolean} isHovering 鼠标是否悬停在书本上
   */
  step(dt, page, isFullyOpen, isHovering) {
    if (isFullyOpen && !this.forcedView) {
      const targetBlend = this.lockedBlend !== null ? this.lockedBlend : (isHovering ? 1.0 : 0.0);
      if (Math.abs(this.hoverBlend - targetBlend) > 0.0001) {
        const blendSpeed = 1.0 - Math.pow(0.001, dt);
        this.hoverBlend = THREE.MathUtils.lerp(this.hoverBlend, targetBlend, blendSpeed);
        const { position, target } = calculateCameraPose(page, this.hoverBlend);
        this.camera.position.copy(position);
        this.camera.lookAt(target);
        const currentTarget = (this.camera.userData.target = this.camera.userData.target || new THREE.Vector3());
        currentTarget.copy(target);
      }
    } else if (!isFullyOpen) {
      this.hoverBlend = 1.0;
    }
  }

  /**
   * 强制指定/跳转视角 (供调试控制台 window.__diary.view 调用)
   * @param {'browse'|'seam'|'headon'} name
   * @param {number} page
   */
  jumpView(name, page) {
    const { position, target } = calculateCameraPose(page, name);
    this.camera.position.copy(position);
    this.camera.lookAt(target);
    const currentTarget = (this.camera.userData.target = this.camera.userData.target || new THREE.Vector3());
    currentTarget.copy(target);
  }
}
