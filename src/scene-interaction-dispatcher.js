import * as THREE from 'three';

/**
 * 场景物理拾取与交互仲裁器 (SceneInteractionDispatcher)
 *
 * 领域深模块 (Ports & Adapters)：
 * 1. 隐藏 NDC 屏幕归一化坐标换算与 Three.js Raycaster 射线投射算法；
 * 2. 隐藏对墨水瓶实体网格、瓶内羽毛笔实体网格、书本立体可拾取网格的逐层遍历；
 * 3. 封装物理碰撞检测优先级与门控状态仲裁：
 *    - 优先级 1: 墨水瓶捕获区 / 墨水瓶 / 瓶内羽毛笔（换页复显进行中屏蔽磁吸捕获兜底，保护合书入口）；
 *    - 优先级 2: 笔记本实体网格（完全展开态转发墨水点击；非完全展开态触发前进/翻页）；
 *    - 优先级 3: 桌面外部背景（触发平滑合书）。
 * 4. 零 DOM 依赖，上层仅通过 dispatchClick(clientX, clientY, rect) 触发，并通过纯意图插槽回调协同。
 */
export class SceneInteractionDispatcher {
  /**
   * @param {Object} options
   * @param {THREE.Camera} options.camera 场景相机
   * @param {Object} options.targets 交互靶区对象
   * @param {Array<THREE.Object3D>} [options.targets.bottleObjects] 墨水瓶相关根对象或网格列表
   * @param {Array<THREE.Object3D>} [options.targets.quillObjects] 羽毛笔相关根对象或网格列表
   * @param {Array<THREE.Object3D>} [options.targets.bookObjects] 书本可拾取网格列表
   * @param {Object} [options.stateQuery] 状态查询门控适配器
   * @param {() => boolean} [options.stateQuery.isFullyOpen] 书本是否完全展开
   * @param {() => boolean} [options.stateQuery.isQuillInBottle] 羽毛笔是否插在瓶中
   * @param {() => boolean} [options.stateQuery.isHoveringBottle] 是否处于瓶口悬停捕获状态
   * @param {() => boolean} [options.stateQuery.isSessionResetting] 是否正在换页复显转场中
   * @param {Object} options.actions 意图动作插槽回调
   * @param {() => void} [options.actions.onBottleClick] 命中墨水瓶且满足换页时序时的回调
   * @param {(hit: THREE.Intersection) => void} [options.actions.onBookClick] 命中书本实体网格时的回调
   * @param {() => void} [options.actions.onOutsideClick] 点击书本外部桌面时的回调
   */
  constructor({
    camera,
    targets = {},
    stateQuery = {},
    actions = {},
  }) {
    this.camera = camera;
    this.stateQuery = {
      isFullyOpen: () => true,
      isQuillInBottle: () => false,
      isHoveringBottle: () => false,
      isSessionResetting: () => false,
      ...stateQuery,
    };
    this.actions = {
      onBottleClick: () => {},
      onBookClick: () => {},
      onOutsideClick: () => {},
      onBookHover: () => {},
      ...actions,
    };

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    this.clickableBottleMeshes = [];
    this.clickableQuillMeshes = [];
    this.clickableBookMeshes = [];

    this._lastPointerX = -9999;
    this._lastPointerY = -9999;
    this._lastPointerResult = null;

    this._collectMeshes(targets.bottleObjects, this.clickableBottleMeshes);
    this._collectMeshes(targets.quillObjects, this.clickableQuillMeshes);
    this._collectMeshes(targets.bookObjects, this.clickableBookMeshes);
  }

  _collectMeshes(objects, targetArray) {
    if (!objects) return;
    const list = Array.isArray(objects) ? objects : [objects];
    for (const obj of list) {
      if (!obj) continue;
      if (obj.isMesh) {
        targetArray.push(obj);
      } else if (typeof obj.traverse === 'function') {
        obj.traverse((child) => {
          if (child.isMesh) targetArray.push(child);
        });
      }
    }
  }

  /**
   * 更新或重设可拾取网格靶区
   */
  setTargets({ bottleObjects, quillObjects, bookObjects } = {}) {
    if (bottleObjects !== undefined) {
      this.clickableBottleMeshes.length = 0;
      this._collectMeshes(bottleObjects, this.clickableBottleMeshes);
    }
    if (quillObjects !== undefined) {
      this.clickableQuillMeshes.length = 0;
      this._collectMeshes(quillObjects, this.clickableQuillMeshes);
    }
    if (bookObjects !== undefined) {
      this.clickableBookMeshes.length = 0;
      this._collectMeshes(bookObjects, this.clickableBookMeshes);
    }
  }

  /**
   * 触发一次点击交互仲裁与分发
   * @param {number} clientX 视口点击水平坐标
   * @param {number} clientY 视口点击垂直坐标
   * @param {{ left: number, top: number, width: number, height: number }} rect 宿主画布的矩形包围盒
   * @returns {string} 仲裁命中的意图类型 ('blocked' | 'bottle' | 'book' | 'outside')
   */
  dispatchClick(clientX, clientY, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return 'blocked';
    }

    // 1. 将屏幕坐标投影为归一化设备坐标 (NDC)
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // 2. 判定是否命中墨水瓶靶区 (严格对齐 ADR-0011 与 ADR-0017)
    // 条件一: 射线命中墨水瓶本体网格
    // 条件二: 羽毛笔插在瓶内时点击羽毛笔实体
    // 条件三: 在日记本外区域且处于瓶口悬停捕获状态下 (换页复显进行中屏蔽此条以防吞噬合书事件)
    const hitBottle = this.raycaster.intersectObjects(this.clickableBottleMeshes, true);
    const hitQuillInBottle =
      this.stateQuery.isQuillInBottle() &&
      this.raycaster.intersectObjects(this.clickableQuillMeshes, true).length > 0;
    const isTrappedNearBottle =
      this.stateQuery.isHoveringBottle() && !this.stateQuery.isSessionResetting();

    if (hitBottle.length > 0 || hitQuillInBottle || isTrappedNearBottle) {
      if (this.stateQuery.isFullyOpen()) {
        this.actions.onBottleClick();
      }
      return 'bottle';
    }

    // 3. 判定是否命中书本实体网格
    const hitBook = this.raycaster.intersectObjects(this.clickableBookMeshes, true);
    if (hitBook.length > 0) {
      this.actions.onBookClick(hitBook[0]);
      return 'book';
    }

    // 4. 点击落在书本外部（桌面背景/阴影），触发合书意图
    this.actions.onOutsideClick();
    return 'outside';
  }

  /**
   * 触发鼠标悬停/移动交互仲裁与分发
   * @param {number} clientX 视口点击水平坐标
   * @param {number} clientY 视口点击垂直坐标
   * @param {{ left: number, top: number, width: number, height: number }} rect 宿主画布的矩形包围盒
   * @returns {string} 仲裁命中的意图类型 ('blocked' | 'book' | 'none')
   */
  dispatchPointerMove(clientX, clientY, rect) {
    if (
      !this.stateQuery.isFullyOpen() ||
      this.stateQuery.isSessionResetting()
    ) {
      this.actions.onBookHover(null);
      return 'blocked';
    }

    if (!rect || rect.width <= 0 || rect.height <= 0) {
      this.actions.onBookHover(null);
      return 'blocked';
    }

    if (clientX === this._lastPointerX && clientY === this._lastPointerY) {
      return this._lastPointerResult || 'none';
    }
    this._lastPointerX = clientX;
    this._lastPointerY = clientY;

    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const hitBook = this.raycaster.intersectObjects(this.clickableBookMeshes, true);
    if (hitBook.length > 0 && hitBook[0].point.x < 0) {
      this.actions.onBookHover(hitBook[0]);
      this._lastPointerResult = 'book';
      return 'book';
    }

    this.actions.onBookHover(null);
    this._lastPointerResult = 'none';
    return 'none';
  }

  /**
   * 触发鼠标移出画布事件
   */
  dispatchPointerLeave() {
    this._lastPointerX = -9999;
    this._lastPointerY = -9999;
    this._lastPointerResult = null;
    this.actions.onBookHover(null);
  }
}
