import * as THREE from 'three';

/**
 * 表面瞄准器 (QuillSurfaceTargeter)
 * 纯几何与射线拾取深模块：负责将屏幕 NDC 坐标或鼠标位置投射到日记本书页立体网格与桌面平面，
 * 封装 Z-fighting 射线反向微浮避让、纸面高度兜底、桌面范围安全夹取 (Safety Clamp) 与屏幕居中对准。
 */
export class QuillSurfaceTargeter {
  /**
   * @param {Object} params
   * @param {THREE.PerspectiveCamera} params.camera 场景相机
   * @param {HTMLElement} [params.domElement] 挂载鼠标事件的 DOM 元素（可选，无 DOM 环境下可手动 setNdc）
   * @param {Array<THREE.Mesh>} [params.bookMeshes=[]] 可拾取书本立体网格
   * @param {number} [params.paperY=0.12] 纸面基准 Y 高度
   * @param {Object} [params.bounds] 桌面水平安全活动边界
   */
  constructor({
    camera,
    domElement = null,
    bookMeshes = [],
    paperY = 0.12,
    bounds = { minX: -1.8, maxX: 1.8, minZ: -1.2, maxZ: 1.2 },
  }) {
    this.camera = camera;
    this.domElement = domElement;
    this.bookMeshes = bookMeshes;
    this.paperY = paperY;
    this.bounds = bounds;

    this.raycaster = new THREE.Raycaster();
    this.paperPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -paperY);
    this.mouseNdc = new THREE.Vector2(0.5, 0.0);
    this.targetPos = new THREE.Vector3(0.5, paperY + 0.002, 0.0);
    this.isOverBook = true;
    this._lastNdc = new THREE.Vector2(-999, -999);

    if (this.domElement && typeof window !== 'undefined') {
      this._bindEvents();
    }
  }

  _bindEvents() {
    this._onMouseMove = (e) => {
      const rect = this.domElement.getBoundingClientRect();
      this.mouseNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouseNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };
    window.addEventListener('mousemove', this._onMouseMove);
  }

  dispose() {
    if (this._onMouseMove && typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this._onMouseMove);
    }
  }

  /**
   * 手动设置 NDC 坐标（用于单测或程序化控制）
   * @param {number} x
   * @param {number} y
   */
  setNdc(x, y) {
    this.mouseNdc.set(x, y);
  }

  /**
   * 根据指定的 NDC 坐标解算 3D 纸面/桌面目标点
   * @param {THREE.Vector2} [ndc=this.mouseNdc]
   * @returns {{ targetPos: THREE.Vector3, isOverBook: boolean }}
   */
  resolve(ndc = this.mouseNdc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    let hitPoint = null;
    let isOverBook = false;

    if (this.bookMeshes && this.bookMeshes.length > 0) {
      const hits = this.raycaster.intersectObjects(this.bookMeshes, true);
      if (hits.length > 0) {
        // 命中书页立体网格，沿射线反向微浮 1.5mm 避让 z-fighting，保持屏幕投影绝对对齐
        hitPoint = hits[0].point.clone();
        if (this.raycaster.ray.direction) {
          hitPoint.addScaledVector(this.raycaster.ray.direction, -0.0015);
        } else {
          hitPoint.y += 0.0015;
        }
        isOverBook = true;
      }
    }

    if (!hitPoint) {
      hitPoint = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.paperPlane, hitPoint)) {
        // 桌面区域保持与书页相同的离地高度平行飞掠
        hitPoint.y = this.paperY;
      }
    }

    if (hitPoint) {
      // 限制跟随范围主要落在日记本与近处桌面区域
      hitPoint.x = THREE.MathUtils.clamp(hitPoint.x, this.bounds.minX, this.bounds.maxX);
      hitPoint.z = THREE.MathUtils.clamp(hitPoint.z, this.bounds.minZ, this.bounds.maxZ);
      this.targetPos.copy(hitPoint);
      this.isOverBook = isOverBook;
    }

    return {
      targetPos: this.targetPos,
      isOverBook: this.isOverBook,
    };
  }

  /**
   * 每帧刷新（若未冻结则解算当前 mouseNdc）
   * @param {boolean} [freeze=false] 是否冻结跟随
   * @returns {{ targetPos: THREE.Vector3, isOverBook: boolean }}
   */
  update(freeze = false) {
    if (freeze) {
      return {
        targetPos: this.targetPos,
        isOverBook: this.isOverBook,
      };
    }
    // 若光标在屏幕空间未移动，直接复用上一帧结果，避免逐帧重复射线计算
    if (
      Math.abs(this.mouseNdc.x - this._lastNdc.x) < 1e-4 &&
      Math.abs(this.mouseNdc.y - this._lastNdc.y) < 1e-4
    ) {
      return {
        targetPos: this.targetPos,
        isOverBook: this.isOverBook,
      };
    }
    this._lastNdc.copy(this.mouseNdc);
    return this.resolve(this.mouseNdc);
  }
}
