import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PlumeKinematics } from './plume-kinematics.js';
import { QuillBottleSequence } from './quill-bottle-sequence.js';
import { QuillSurfaceTargeter } from './quill-surface-targeter.js';
import { QuillSheatheArc } from './quill-sheathe-arc.js';

/**
 * 羽毛笔导轨系统 (Quill Follow Rig)
 * 纯深模块：负责羽毛笔模型的生命周期管理、插拔轨迹动画 (Sheathe/Unsheathe Arc)、
 * 3D 纸面射线追踪、滞后倾斜 (Lag Tilt) 与打字笔触微动 (Tapping)
 */
export class QuillFollowRig {
  /**
   * @param {Object} params
   * @param {THREE.Group} params.group 羽毛笔根对象
   * @param {THREE.PerspectiveCamera} [params.camera] 场景相机
   * @param {HTMLElement} [params.domElement] 画布 DOM 元素
   * @param {Object} [params.bottleTransform] 墨水瓶世界空间位置与旋转
   * @param {Array<THREE.Mesh>} [params.bookMeshes] 日记本可拾取网格
   * @param {number} [params.paperY] 纸面 Y 高度
   * @param {number} [params.groundY] 桌面基准地面 Y 高度
   * @param {QuillSurfaceTargeter} [params.targeter] 自定义表面瞄准器实例
   */
  constructor({ group, camera, domElement, bottleTransform, bookMeshes = [], paperY = 0.12, groundY = 0.0, targeter = null }) {
    this.group = group;
    this.camera = camera;
    this.domElement = domElement;
    this.bookMeshes = bookMeshes;
    this.paperY = paperY;
    this.groundY = groundY;

    // 插拔轨迹状态机与抛物线几何解算深模块 (QuillSheatheArc)
    this.arc = new QuillSheatheArc({ transitionSpeed: 1.6 });

    // 墨水瓶口在局部世界中的锚点 (根据 Blender 导出的瓶内停靠位)
    this.bottlePos = bottleTransform?.position
      ? bottleTransform.position.clone()
      : new THREE.Vector3(-1.30, paperY, 0.52);
    this.bottleRotY = bottleTransform?.rotationY ?? Math.PI;

    // 羽毛笔在瓶内的相对位姿 (参考 Blender 模型第 0 帧位姿)
    // Blender 第 0 帧: loc=(-28.7914, 25.4312, 17.2660), rot=(0, 0, PI)
    // 转换为 glTF / Three.js 坐标系并缩放 0.003:
    this.sheathedLocalPos = new THREE.Vector3(-28.791433 * 0.003, 17.266005 * 0.003, -25.431242 * 0.003);
    this.sheathedQuat = new THREE.Quaternion(-0.25622959, -0.94909209, -0.18322283, 0);

    // 拔出时瓶口上方的过渡拱顶 (Apex)，垂直向上避让瓶颈
    this.bottleApexPos = new THREE.Vector3(-28.791433 * 0.003, 150.0 * 0.003, -25.431242 * 0.003);

    // 1. 笔记本上方书写姿态（对齐当前 Blender 模型的旋转角度）：
    this.bookQuat = new THREE.Quaternion(0.32522978, 0.89948021, 0.20167353, 0.21092368);

    // 2. 桌面平行姿态（笔记本范围之外）：
    this.desktopQuat = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5);

    // 3. 墨水瓶口绝对竖直姿态（笔尖垂直朝下对准瓶内）：
    this.bottleVerticalQuat = new THREE.Quaternion(0, 0, 0, 1);

    // 瓶口悬停中心点 (瓶口上沿 Y 约为 0.4188m，悬停在瓶口上方 10mm 处)
    this.bottleLipPos = new THREE.Vector3(
      this.bottlePos.x,
      this.bottlePos.y + 0.298767 + 0.010,
      this.bottlePos.z
    );

    // 瓶口悬停捕获与双连蘸墨时序状态机 (QuillBottleSequence)
    this.trapBlend = 0.0;
    this.bottleSeq = new QuillBottleSequence({
      trapRadiusIn: 0.24,
      trapRadiusOut: 0.38,
      dipDuration: 0.70,
      dipDepth: 0.185,
    });

    // 笔记本 3D 边界盒 (水平范围包含微小安全外扩，顶面为 paperY)
    this.bookBounds = {
      minX: -1.08,
      maxX: 1.08,
      minZ: -0.78,
      maxZ: 0.78,
      topY: paperY,
      bottomY: groundY,
    };

    // 墨水瓶 3D 障碍体参数 (底座/瓶身圆柱体防穿模)
    this.bottleRadius = 0.165; // 瓶身与瓶塞外接圆柱半径 (米)
    this.bottleHeight = this.bottleLipPos.y; // 瓶口上沿高度 (米)

    // 羽梢避障运动学解算深模块 (PlumeKinematics)
    this.kinematics = new PlumeKinematics({
      bottlePos: this.bottlePos,
      bottleRadius: this.bottleRadius,
      bottleHeight: this.bottleHeight,
      bookBounds: this.bookBounds,
      groundY: this.groundY,
    });

    // 当前姿态混合进度 (0: 桌面平行姿态, 1: 笔记本书写姿态)
    this.poseBlend = 1.0;
    this.activeWritingQuat = new THREE.Quaternion().copy(this.bookQuat);
    this._isOverBook = true;

    // 是否冻结鼠标跟随（用于调试面板精细旋转对齐）
    this.freezeFollow = false;

    // 是否临时插回墨水瓶（用于翻页转场避免遮挡）
    this.isTemporarilySheathed = false;

    // 是否锁定在墨水瓶口上方悬停待命（翻页转场期间避免影响翻页）
    this.isBottleHoverLocked = false;

    // 是否强制拔出进入跟随/调试状态（不依赖书本翻页进度）
    this.forceUnsheathed = false;

    // 表面瞄准器深模块 (QuillSurfaceTargeter)：封装射线相交与纸面投影
    this.targeter = targeter || new QuillSurfaceTargeter({
      camera: this.camera,
      domElement: this.domElement,
      bookMeshes: this.bookMeshes,
      paperY: this.paperY,
    });

    // 3D 纸面拾取与跟随目标点 (默认停留在右页中间偏右书写区)
    this.targetPos = new THREE.Vector3().copy(this.targeter.targetPos);
    this.currentPos = new THREE.Vector3().copy(this.targetPos);
    this.currentQuat = new THREE.Quaternion().copy(this.sheathedQuat);

    // 滞后倾斜速度向量与目标跟踪缓存
    this.velocity = new THREE.Vector2(0, 0);
    this.prevMousePos = new THREE.Vector2(0, 0);
    this.prevTargetPos = new THREE.Vector3().copy(this.targetPos);
    this.lagTilt = new THREE.Euler(0, 0, 0);

    // 提取羽毛笔几何顶点缓存，交由羽梢运动学深模块 (PlumeKinematics) 统一解算
    const localVertices = [];
    this.group.traverse((c) => {
      if (c.isMesh && c.geometry && c.geometry.attributes.position) {
        const pos = c.geometry.attributes.position;
        const scale = this.group.scale.y || 0.003;
        for (let i = 0; i < pos.count; i++) {
          localVertices.push(
            new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).multiplyScalar(scale)
          );
        }
      }
    });
    this.kinematics.setLocalVertices(localVertices);

    this.updateWorldTransformImmediate();
  }

  dispose() {
    this.targeter?.dispose();
  }

  get state() {
    return this.arc.state;
  }

  get transitionProgress() {
    return this.arc.progress;
  }

  /**
   * 设置目标开合态 (展开完成进入跟随，未展开插在墨水瓶)
   * @param {boolean} active 是否激活跟随态
   */
  setActive(active) {
    this.arc.setActive(active, this.forceUnsheathed);
  }

  /**
   * 锁定羽毛笔悬停在墨水瓶口上方（瓶口待命姿态，笔尖朝下，锁定光标跟随）
   */
  hoverOverBottle() {
    this.isTemporarilySheathed = false;
    this.isBottleHoverLocked = true;
    this.freezeFollow = true;
    this.bottleSeq.isTrapped = true;
    this.trapBlend = 1.0;
    this.currentPos.copy(this.bottleLipPos);
    this.targetPos.copy(this.bottleLipPos);
  }

  /**
   * 解除瓶口上方悬停锁定，恢复正常光标跟随与磁吸判定
   */
  releaseBottleHover() {
    this.isBottleHoverLocked = false;
    this.freezeFollow = false;
    this.bottleSeq.isTrapped = false;
  }

  get isInBottle() {
    return this.isTemporarilySheathed || this.arc.isInBottle;
  }

  get isOverBook() {
    return this._isOverBook;
  }

  get isTrapped() {
    return this.bottleSeq.isTrapped;
  }

  set isTrapped(val) {
    this.bottleSeq.isTrapped = val;
  }

  get isDipping() {
    return this.bottleSeq.isDipping;
  }

  /**
   * 是否处于瓶口磁吸悬停待命态（日记本外且已吸附在瓶口）
   * 收拢 main.js 中对 isTrapped 与 isOverBook 的组合窥探
   */
  isHoveringBottle() {
    return this.isTrapped && !this.isOverBook;
  }

  /**
   * 触发快速双连蘸墨动画 (Rapid Double-Dip)
   * 深入瓶颈 185mm，连蘸两次，动作期间锁定光标脱扣判定
   * @param {Function} [onComplete] 蘸墨完成回调
   */
  triggerDoubleDip(onComplete = null) {
    this.bottleSeq.triggerDoubleDip(onComplete);
  }

  /**
   * 更新笔在墨水瓶内的世界坐标
   */
  getSheathedWorldTransform() {
    const pos = this.sheathedLocalPos.clone();
    pos.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.bottleRotY);
    pos.add(this.bottlePos);

    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.bottleRotY);
    quat.multiply(this.sheathedQuat);

    return { pos, quat };
  }

  /**
   * 获取拔出路径拱顶世界坐标
   */
  getApexWorldPos() {
    const pos = this.bottleApexPos.clone();
    pos.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.bottleRotY);
    pos.add(this.bottlePos);
    return pos;
  }

  updateWorldTransformImmediate() {
    const sheathed = this.getSheathedWorldTransform();
    this.group.position.copy(sheathed.pos);
    this.group.quaternion.copy(sheathed.quat);
  }

  /**
   * 每帧状态积分与位姿解算
   * @param {number} dt 帧间隔 (秒)
   */
  update(dt) {
    if (dt <= 0) return;

    // 1. 表面瞄准器深模块步进：解算当前鼠标在 3D 纸面或桌面的投射目标与网格归属
    const targetState = this.targeter.update(this.freezeFollow);
    this.targetPos.copy(targetState.targetPos);
    const isOverBook = targetState.isOverBook;
    this._isOverBook = isOverBook;

    // 计算光标目标点与墨水瓶口中心在水平 XZ 平面的距离
    const dxLip = this.targetPos.x - this.bottleLipPos.x;
    const dzLip = this.targetPos.z - this.bottleLipPos.z;
    const distToLip = Math.hypot(dxLip, dzLip);

    // 2. 瓶口磁吸捕获与双连蘸墨时序状态机步进 (QuillBottleSequence)
    const canTrap = (this.state === 'following' || this.state === 'unsheathing');
    const { dipOffset } = this.bottleSeq.update({
      dt,
      distToLip,
      isOverBook,
      canTrap,
      freezeFollow: this.freezeFollow,
    });

    // 4. 插拔轨迹状态机步进 (QuillSheatheArc)
    this.arc.step(dt, { forceUnsheathed: this.forceUnsheathed });

    // 5. 姿态插值与混合：
    // a) 笔记本上方书写姿态与桌面姿态 (0.5, 0.5, 0.5, 0.5) 平滑插值
    this._isOverBook = isOverBook;
    const targetBlend = isOverBook ? 1.0 : 0.0;
    const blendRate = 1.0 - Math.pow(0.001, dt);
    this.poseBlend = THREE.MathUtils.lerp(this.poseBlend, targetBlend, blendRate);
    this.activeWritingQuat.slerpQuaternions(this.desktopQuat, this.bookQuat, this.poseBlend);

    // b) 瓶口竖直姿态 (BottleVerticalQuat) 平滑插值
    // 若光标已回到书本上且脱离捕获，直接归零瓶口混合因子，杜绝拉扯视差
    if (this.isBottleHoverLocked) {
      this.trapBlend = 1.0;
    } else if (!this.isTrapped && isOverBook) {
      this.trapBlend = 0.0;
    } else {
      const targetTrapBlend = this.isTrapped ? 1.0 : 0.0;
      const trapBlendRate = 1.0 - Math.pow(0.0005, dt);
      this.trapBlend = THREE.MathUtils.lerp(this.trapBlend, targetTrapBlend, trapBlendRate);
    }

    const baseFollowQuat = new THREE.Quaternion().copy(this.activeWritingQuat);
    baseFollowQuat.slerp(this.bottleVerticalQuat, this.trapBlend);

    // 6. 计算跟随位移与滞后倾角
    const sheathed = this.getSheathedWorldTransform();
    const apex = this.getApexWorldPos();

    if (this.isInBottle) {
      this.group.position.copy(sheathed.pos);
      this.group.quaternion.copy(sheathed.quat);
      return;
    }

    // 解算当前有效跟随目标点：在捕获态下平滑锚定至瓶口悬停中心 bottleLipPos
    const effectiveTargetPos = this.isBottleHoverLocked
      ? this.bottleLipPos.clone()
      : this.targetPos.clone();
    if (!this.isBottleHoverLocked && this.trapBlend > 0.001) {
      effectiveTargetPos.lerp(this.bottleLipPos, this.trapBlend);
    }

    // 速度计算：基于目标点每帧实际物理位移 (米/秒)
    const dtSafe = Math.max(dt, 0.001);
    const moveDx = (effectiveTargetPos.x - this.prevTargetPos.x) / dtSafe;
    const moveDz = (effectiveTargetPos.z - this.prevTargetPos.z) / dtSafe;
    this.prevTargetPos.copy(effectiveTargetPos);

    // 跟随位置更新：
    // 在瓶口悬停捕获或刚刚脱离瓶口平滑过渡时，采用平滑插值吸附与回位；
    // 仅在完全跟随且与鼠标光标已足够接近时，才无缝切换为紧密贴合，避免脱扣瞬间发生位置突跳。
    const distToTarget = this.currentPos.distanceTo(effectiveTargetPos);
    if (this.arc.isFollowing && this.trapBlend < 0.001 && distToTarget < 0.005) {
      this.currentPos.copy(effectiveTargetPos);
    } else {
      const followLerp = 1.0 - Math.pow(0.0001, dt);
      this.currentPos.lerp(effectiveTargetPos, followLerp);
    }

    // 动态空气阻力倾角：仅在笔记本范围之外 (桌面区) 启用；笔记本内保持固定书写姿态
    const speedX = THREE.MathUtils.clamp(moveDx * 0.15, -0.35, 0.35);
    const speedZ = THREE.MathUtils.clamp(moveDz * 0.15, -0.35, 0.35);
    const targetTiltX = isOverBook ? 0.0 : speedZ * 0.45 * (1.0 - this.trapBlend);
    const targetTiltZ = isOverBook ? 0.0 : -speedX * 0.45 * (1.0 - this.trapBlend);
    this.lagTilt.x = THREE.MathUtils.lerp(this.lagTilt.x, targetTiltX, Math.min(1.0, dt * 14));
    this.lagTilt.z = THREE.MathUtils.lerp(this.lagTilt.z, targetTiltZ, Math.min(1.0, dt * 14));

    const dynamicWritingQuat = baseFollowQuat.clone();
    const tiltQuat = new THREE.Quaternion().setFromEuler(this.lagTilt);
    dynamicWritingQuat.multiply(tiltQuat);

    // 7. 瓶口悬停与蘸墨高度计算 (仅在处于捕获态或正在蘸墨动画期间介入)
    let p3 = this.currentPos.clone();
    if (this.isDipping) {
      p3.y = this.bottleLipPos.y - dipOffset;
    } else if (this.trapBlend > 0.001) {
      p3.y = THREE.MathUtils.lerp(this.currentPos.y, this.bottleLipPos.y, this.trapBlend);
    }

    // 8. 委托插拔轨迹深模块解算空间贝塞尔抛物线位姿 (QuillSheatheArc)
    const { pos: finalPos, quat: finalQuat } = this.arc.evaluate({
      p0: sheathed.pos,
      apexPos: apex,
      p3,
      startQuat: sheathed.quat,
      endQuat: dynamicWritingQuat,
    });

    // 9. 墨水瓶越顶滑行与羽梢旋转避障解算 (PlumeKinematics 深模块单行驱动)
    if (!this.isDipping && !this.isInBottle) {
      const solved = this.kinematics.solve({
        pos: finalPos,
        quat: finalQuat,
        dt,
        t: this.arc.progress,
        isOverBook,
        trapBlend: this.trapBlend,
      });
      finalPos.copy(solved.pos);
      finalQuat.copy(solved.quat);
    }

    this.group.position.copy(finalPos);
    this.group.quaternion.copy(finalQuat);
  }
}

/**
 * 墨水瓶资产加载器
 * @param {string} [url='/assets/ink-bottle.glb']
 * @param {Object} [options]
 * @param {THREE.Texture} [options.envMap=null]
 */
export async function loadInkBottle(url = '/assets/ink-bottle.glb', options = {}) {
  const envMap = options?.envMap ?? null;
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const group = gltf.scene;

  group.traverse((child) => {
    if (child.isMesh && child.material) {
      child.castShadow = child.receiveShadow = true;
      const mat = child.material;
      mat.side = THREE.DoubleSide;
      mat.transparent = false;
      mat.depthWrite = true;

      if (child.name === 'InkBottle' || mat.name.includes('Glass')) {
        if (envMap) {
          mat.envMap = envMap;
          mat.envMapIntensity = 0.08;
        }
        mat.color.setRGB(1.0, 1.0, 1.0);
        mat.roughness = 1.0;
        mat.metalness = 0.0;
        mat.clearcoat = 1.0;
        mat.clearcoatRoughness = 0.03;
        mat.ior = 1.52;
      } else if (child.name === 'Cork' || mat.name.includes('Cork')) {
        mat.roughness = 0.85;
        mat.metalness = 0.0;
      }
      mat.needsUpdate = true;
    }
  });

  return {
    group,
    meshes: group.children.filter((c) => c.isMesh),
  };
}

/**
 * 羽毛笔模型加载器
 * @param {string} [url='/assets/quill.glb']
 */
export async function loadQuill(url = '/assets/quill.glb') {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const group = gltf.scene;

  group.traverse((child) => {
    if (child.isMesh && child.material) {
      child.castShadow = child.receiveShadow = true;
      const mat = child.material;
      mat.side = THREE.DoubleSide;
      mat.transparent = true;
      mat.alphaTest = 0.5;
      mat.depthWrite = true;
      mat.needsUpdate = true;
    }
  });

  return {
    group,
    mesh: group.children.find((c) => c.isMesh) || group,
  };
}
