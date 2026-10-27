import * as THREE from 'three';

/**
 * 纯几何函数：解算三次贝塞尔曲线插拔轨迹位姿 (P0 ~ P3)
 * @param {Object} params
 * @param {number} params.t 插值进度 [0, 1]
 * @param {THREE.Vector3} params.p0 瓶内停靠点位置
 * @param {THREE.Vector3} params.apexPos 拔出路径避瓶拱顶世界坐标
 * @param {THREE.Vector3} params.p3 目标跟随点位置
 * @param {THREE.Quaternion} params.startQuat 瓶内起始旋转
 * @param {THREE.Quaternion} params.endQuat 目标终点旋转
 * @returns {{ pos: THREE.Vector3, quat: THREE.Quaternion }}
 */
export function evaluateArcPose({ t, p0, apexPos, p3, startQuat, endQuat }) {
  // P1: 瓶口上方拱顶，垂直向上避让瓶颈
  const p1 = new THREE.Vector3(p0.x, Math.max(p0.y + 0.35, apexPos.y), p0.z);
  // P2: 中继过渡点
  const p2 = new THREE.Vector3(
    (p0.x + p3.x) * 0.5,
    Math.max(p1.y, p3.y + 0.25),
    (p0.z + p3.z) * 0.5
  );

  // 三次贝塞尔曲线公式: (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
  const oneMinusT = 1 - t;
  const t2 = t * t;
  const oneMinusT2 = oneMinusT * oneMinusT;

  const pos = new THREE.Vector3()
    .addScaledVector(p0, oneMinusT2 * oneMinusT)
    .addScaledVector(p1, 3 * oneMinusT2 * t)
    .addScaledVector(p2, 3 * oneMinusT * t2)
    .addScaledVector(p3, t2 * t);

  const quat = new THREE.Quaternion().slerpQuaternions(startQuat, endQuat, t);

  return { pos, quat };
}

/**
 * 插拔轨迹调度器 (QuillSheatheArc)
 * 纯状态机与几何解算深模块：管理羽毛笔在瓶内 ('in_bottle')、拔出 ('unsheathing')、
 * 纸面跟随 ('following') 与插回 ('sheathing') 之间的时序跃迁，
 * 封装抛物线 4 控制点空间贝塞尔曲线求值与避瓶防穿模拱顶高度计算。
 */
export class QuillSheatheArc {
  /**
   * @param {Object} [options]
   * @param {number} [options.transitionSpeed=1.6] 插拔速度 (~0.6s)
   */
  constructor({ transitionSpeed = 1.6 } = {}) {
    this.state = 'in_bottle';
    this.progress = 0.0;
    this.transitionSpeed = transitionSpeed;
  }

  get isInBottle() {
    return this.state === 'in_bottle';
  }

  get isFollowing() {
    return this.state === 'following';
  }

  get isTransitioning() {
    return this.state === 'unsheathing' || this.state === 'sheathing';
  }

  /**
   * 设置目标开合态 (active=true 展开进入跟随，active=false 合书插回墨水瓶)
   * @param {boolean} active
   * @param {boolean} [forceUnsheathed=false]
   */
  setActive(active, forceUnsheathed = false) {
    if (forceUnsheathed || active) {
      if (this.state === 'in_bottle' || this.state === 'sheathing') {
        this.state = 'unsheathing';
      }
    } else {
      if (this.state === 'following' || this.state === 'unsheathing') {
        this.state = 'sheathing';
      }
    }
  }

  /**
   * 每帧步进时序状态机
   * @param {number} dt 帧间隔 (秒)
   * @param {Object} [options]
   * @param {boolean} [options.forceUnsheathed=false] 是否强制保持拔出态
   * @returns {{ state: string, progress: number }}
   */
  step(dt, { forceUnsheathed = false } = {}) {
    if (forceUnsheathed) {
      if (this.state === 'in_bottle' || this.state === 'sheathing') {
        this.state = 'unsheathing';
      }
    }

    if (this.state === 'unsheathing') {
      this.progress += dt * this.transitionSpeed;
      if (this.progress >= 1.0) {
        this.progress = 1.0;
        this.state = 'following';
      }
    } else if (this.state === 'sheathing') {
      this.progress -= dt * this.transitionSpeed;
      if (this.progress <= 0.0) {
        this.progress = 0.0;
        this.state = 'in_bottle';
      }
    }

    return {
      state: this.state,
      progress: this.progress,
    };
  }

  /**
   * 解算当前插拔位姿
   * @param {Object} params
   * @param {THREE.Vector3} params.p0 瓶内起点
   * @param {THREE.Vector3} params.apexPos 拱顶避让位置
   * @param {THREE.Vector3} params.p3 终点跟随位置
   * @param {THREE.Quaternion} params.startQuat 瓶内起点旋转
   * @param {THREE.Quaternion} params.endQuat 终点旋转
   * @returns {{ pos: THREE.Vector3, quat: THREE.Quaternion }}
   */
  evaluate({ p0, apexPos, p3, startQuat, endQuat }) {
    return evaluateArcPose({
      t: this.progress,
      p0,
      apexPos,
      p3,
      startQuat,
      endQuat,
    });
  }
}
