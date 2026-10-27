import { MathUtils } from 'three';

// Book22 起 Blender 侧 Progress 用 28 个 LINEAR 键驱动，这张表就是那条速度表：
// 时间→键号按 KEY_FRAMES 线性插值，页号由 KEY_PAGES 换算，进度不再是 BEZIER 缓动。
const KEY_FRAMES = [1, 4, 8, 11, 14, 16, 17, 19, 20, 22, 23, 25, 26, 28, 29, 31, 32, 34, 35, 37, 38, 40, 41, 43, 44, 46, 47, 49];
const KEY_PAGES = [0, 0.25, 0.5, 0.75, 0.9, 1, 1.33, 2, 2.33, 3, 3.33, 4, 4.33, 5, 5.33, 6, 6.33, 7, 7.33, 8, 8.33, 9, 9.33, 10, 10.33, 11, 11.33, 12];

const FPS = 24;
const LAST_KEY = KEY_FRAMES.length - 1;
export const LAST_PAGE = KEY_PAGES.at(-1);
export const DURATION = (KEY_FRAMES.at(-1) - KEY_FRAMES[0]) / FPS;

const clamp = MathUtils.clamp;

/**
 * 纯数学换算工具函数 (深模块内部运算细节，亦导出供调试对比)
 */
export function keyAt(seconds) {
  const f = clamp(KEY_FRAMES[0] + seconds * FPS, KEY_FRAMES[0], KEY_FRAMES.at(-1));
  let k = 0;
  while (k < LAST_KEY && KEY_FRAMES[k + 1] < f) k++;
  return k + (f - KEY_FRAMES[k]) / (KEY_FRAMES[k + 1] - KEY_FRAMES[k]);
}

export function timeOfKey(key) {
  const k = clamp(Math.trunc(key), 0, LAST_KEY - 1);
  const frame = KEY_FRAMES[k] + (KEY_FRAMES[k + 1] - KEY_FRAMES[k]) * clamp(key - k, 0, 1);
  return (frame - KEY_FRAMES[0]) / FPS;
}

export function pageOf(key) {
  const k = clamp(Math.trunc(key), 0, LAST_KEY - 1);
  const blend = clamp(key - k, 0, 1);
  return KEY_PAGES[k] + (KEY_PAGES[k + 1] - KEY_PAGES[k]) * blend;
}

export function timeFor(page) {
  let k = 0;
  while (k < LAST_KEY && KEY_PAGES[k + 1] < page) k++;
  return timeOfKey(k + (page - KEY_PAGES[k]) / (KEY_PAGES[k + 1] - KEY_PAGES[k]));
}

/**
 * 翻页调度器深模块 (BookPlayback)
 *
 * 职责：
 * 1. 隐藏时间积分、速度方向 (dir)、端点折返判定与边界锁定；
 * 2. 对主循环提供单次 step(dt) 步进并输出状态快照；
 * 3. 对交互层提供 toggle() 与 close() 语义指令；
 * 4. 支持任意时间/页码/键号跳转与定格 (seekPage, seekKey)。
 */
export class BookPlayback {
  /**
   * @param {Object} options
   * @param {number} [options.startPage=0] 初始页码
   * @param {boolean} [options.still=false] 是否定格禁止动画
   */
  constructor(options = {}) {
    this.still = Boolean(options.still);
    const initialPage = options.startPage ?? 0;
    this.seconds = timeFor(initialPage);
    this.dir = 0; // -1: 正在合书, 0: 静止, 1: 正在翻开
  }

  get key() {
    return keyAt(this.seconds);
  }

  get page() {
    return pageOf(this.key);
  }

  get isClosed() {
    return this.seconds <= 0.0001;
  }

  get isFullyOpen() {
    return this.page >= LAST_PAGE - 0.05;
  }

  /**
   * 翻书 / 掉头切换
   */
  toggle() {
    if (this.still) return;
    if (this.seconds <= 0) {
      this.dir = 1;
    } else if (this.seconds >= DURATION) {
      this.dir = -1;
    } else {
      this.dir = -this.dir || (this.page > LAST_PAGE / 2 ? -1 : 1);
    }
  }

  /**
   * 触发合书
   * @returns {boolean} 是否成功触发合书动作
   */
  close() {
    if (this.still) return false;
    if (this.seconds <= 0) return false; // 已经合上
    if (this.dir === -1) return false;   // 已经在合书移动中
    this.dir = -1;
    return true;
  }

  /**
   * 触发翻开
   * @returns {boolean} 是否成功触发翻开动作
   */
  open() {
    if (this.still) return false;
    if (this.isFullyOpen) return false; // 已经展开
    if (this.dir === 1) return false;   // 已经在翻开移动中
    this.dir = 1;
    return true;
  }

  /**
   * 定格/跳转至指定秒数
   */
  seekSeconds(seconds) {
    this.dir = 0;
    this.seconds = seconds;
    return this.snapshot();
  }

  seekPage(pageNumber) {
    return this.seekSeconds(timeFor(pageNumber));
  }

  seekKey(keyNumber) {
    return this.seekSeconds(timeOfKey(keyNumber));
  }

  /**
   * 推进物理时钟 dt (秒)
   * @param {number} dt
   * @returns {{ changed: boolean, key: number, page: number, isFullyOpen: boolean, isClosed: boolean }}
   */
  step(dt) {
    if (this.dir === 0) {
      return { changed: false, ...this.snapshot() };
    }

    const prevSeconds = this.seconds;
    this.seconds = clamp(this.seconds + this.dir * dt, 0, DURATION);

    if (this.seconds <= 0 || this.seconds >= DURATION) {
      this.dir = 0;
    }

    const changed = Math.abs(this.seconds - prevSeconds) > 0.00001;
    return {
      changed,
      ...this.snapshot(),
    };
  }

  /**
   * 当前状态快照
   */
  snapshot() {
    const curKey = this.key;
    const curPage = pageOf(curKey);
    return {
      key: curKey,
      page: curPage,
      seconds: this.seconds,
      dir: this.dir,
      isFullyOpen: this.isFullyOpen,
      isClosed: this.isClosed,
    };
  }
}
