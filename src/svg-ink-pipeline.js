import { computeSkeletonField } from './ink-rasterizer.js';

/**
 * SVG 墨迹提取、骨架烘焙与反显消融流水线 (SvgInkPipeline)
 *
 * 核心能力：
 * 1. extractInkFromImageData: 灰度反显剔除白底与孔洞留白，保留抗锯齿边缘与墨水浓度；
 * 2. bakeSkeletonToGreenChannel: 运行两趟可分离 1D EDT 提取笔画中轴深度并写入 Green 通道；
 * 3. evaluateDissolveAtProgress: 运行与 pages.js GPU 着色器同构的形态学消融/反显算子；
 * 4. SvgInkAnimator: 动画驱动控制器，支持缓动步进、反显、消融、定格与循环演播。
 */

// 跨环境轻量兼容 ImageData 创建函数
function createCompatibleImageData(width, height, data = null) {
  if (typeof globalThis.ImageData !== 'undefined') {
    return data ? new globalThis.ImageData(data, width, height) : new globalThis.ImageData(width, height);
  }
  return {
    width,
    height,
    data: data ? new Uint8ClampedArray(data) : new Uint8ClampedArray(width * height * 4),
  };
}

/**
 * 从包含白底或灰度过渡的像素数据中提取墨水浓度（灰度反显）
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} imageData 原始光栅化图像数据
 * @param {Object} [options]
 * @param {number} [options.inkThreshold=10] 判定有墨的灰度差阈值 (255 - gray > inkThreshold)
 * @param {{ r: number, g: number, b: number }} [options.inkColor={ r: 27, g: 18, b: 12 }] 铁胆墨乌墨基底色
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }} 新的透明底墨迹 ImageData（Alpha 记录墨迹浓度）
 */
export function extractInkFromImageData(imageData, options = {}) {
  const { width, height, data } = imageData;
  const inkThreshold = options.inkThreshold ?? 8;
  const inkColor = options.inkColor || { r: 27, g: 18, b: 12 };
  const output = createCompatibleImageData(width, height);
  const outData = output.data;
  const totalPixels = width * height;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    const srcAlpha = data[idx + 3] / 255.0;

    // 计算感知灰度 (ITU-R BT.601)
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    // 灰度反显：纯白(255) -> 0 墨浓度；纯黑(0) -> 255 墨浓度
    const inkDensity = Math.max(0, Math.min(255, Math.round((255 - gray) * srcAlpha)));

    if (inkDensity > inkThreshold) {
      outData[idx] = inkColor.r;
      outData[idx + 1] = 0; // Green 通道预留给骨架场
      outData[idx + 2] = inkColor.b;
      outData[idx + 3] = inkDensity;
    } else {
      outData[idx] = 0;
      outData[idx + 1] = 0;
      outData[idx + 2] = 0;
      outData[idx + 3] = 0;
    }
  }

  return output;
}

/**
 * 提取笔画中轴骨架并烘焙至 Green 通道
 * @param {ImageData} inkImageData 透明底墨迹 ImageData
 * @param {Object} [options]
 * @param {number} [options.searchRadius=24]
 * @param {number} [options.localMaxRadius=8]
 * @returns {{ bakedImageData: ImageData, skeleton: Uint8Array }}
 */
export function bakeSkeletonToGreenChannel(inkImageData, options = {}) {
  const { width, height, data } = inkImageData;
  const skeleton = computeSkeletonField(data, width, height, {
    isRgba: true,
    threshold: options.threshold ?? 15,
    searchRadius: options.searchRadius ?? 24,
    localMaxRadius: options.localMaxRadius ?? 8,
  });

  const baked = createCompatibleImageData(width, height, new Uint8ClampedArray(data));
  const bakedData = baked.data;
  const total = width * height;

  for (let i = 0; i < total; i++) {
    bakedData[i * 4 + 1] = skeleton[i];
  }

  return { bakedImageData: baked, skeleton };
}

/**
 * 纯数学平滑插值（模拟 GLSL smoothstep）
 */
function smoothstep(min, max, val) {
  const x = Math.max(0.0, Math.min(1.0, (val - min) / (max - min)));
  return x * x * (3.0 - 2.0 * x);
}

/**
 * 纯数学线性混合（模拟 GLSL mix）
 */
function mix(x, y, a) {
  return x * (1.0 - a) + y * a;
}

/**
 * 运行与 pages.js WebGL 片元着色器 100% 同构的形态学消融/反显算子
 * @param {ImageData} sourceBakedData 已烘焙 Green 骨架的基准图像数据
 * @param {number} activeDissolve 消融进度 (0.0=饱满显影, 1.0=完全消融吸干)
 * @param {ImageData} [targetOutputData] 输出目标缓冲区（若不传则创建新 ImageData）
 * @param {Object} [options]
 * @returns {ImageData}
 */
export function evaluateDissolveAtProgress(sourceBakedData, activeDissolve, targetOutputData = null, options = {}) {
  const { width, height, data: src } = sourceBakedData;
  const output = targetOutputData || createCompatibleImageData(width, height);
  const dst = output.data;
  const total = width * height;

  // 饱满静置态 (activeDissolve <= 0.001)
  if (activeDissolve <= 0.001) {
    dst.set(src);
    return output;
  }

  // 完全消融隐匿态 (activeDissolve >= 0.999)
  if (activeDissolve >= 0.999) {
    dst.fill(0);
    return output;
  }

  const stage = 1.0 - activeDissolve;
  // 笔画收缩位移：从 -0.15 (饱满完全覆盖) 推进到 1.15 (完全收尽)
  const widthCutoff = mix(-0.15, 1.15, smoothstep(0.05, 0.98, activeDissolve));
  // 宽域羽化过渡带：深度消融/显影时过渡带宽度达到 0.45，实现柔和水渍羽化晕散
  const feather = mix(0.12, 0.45, activeDissolve);
  // 全局柔和不透明度淡化 (缓入快出)
  const opacity = smoothstep(0.015, 0.80, stage);

  // 颜色双色相渐变：水痕浅褐 (51, 35, 24) -> 饱满浓墨 (27, 18, 12)
  const colorStage = smoothstep(0.08, 0.65, stage);
  const curR = Math.round(mix(51, 27, colorStage));
  const curG = Math.round(mix(35, 18, colorStage));
  const curB = Math.round(mix(24, 12, colorStage));

  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const baseAlpha = src[idx + 3];
    if (baseAlpha === 0) {
      dst[idx] = 0;
      dst[idx + 1] = 0;
      dst[idx + 2] = 0;
      dst[idx + 3] = 0;
      continue;
    }

    const strokeDepth = src[idx + 1] / 255.0; // 归一化骨架中轴深度 (0.0=外缘, 1.0=骨核)
    const widthAlpha = smoothstep(-feather, feather, strokeDepth - widthCutoff);
    const finalAlpha = Math.round(baseAlpha * widthAlpha * opacity);

    // 对应着色器 effectiveAlpha <= 0.005 过滤
    if (finalAlpha <= 1) {
      dst[idx] = 0;
      dst[idx + 1] = 0;
      dst[idx + 2] = 0;
      dst[idx + 3] = 0;
    } else {
      dst[idx] = curR;
      dst[idx + 1] = src[idx + 1]; // 保留 Green 骨架
      dst[idx + 2] = curB;
      dst[idx + 3] = finalAlpha;
    }
  }

  return output;
}

/**
 * 动画控制器状态枚举
 */
export const SvgAnimState = {
  IDLE: 'idle',
  EMERGING: 'emerging',
  STAYING: 'staying',
  DISSOLVING: 'dissolving',
};

/**
 * 余弦缓动曲线
 */
function easeInOutCubic(t) {
  return t < 0.5 ? 4.0 * t * t * t : 1.0 - Math.pow(-2.0 * t + 2.0, 3.0) / 2.0;
}

/**
 * SVG 墨迹动画控制器
 */
export class SvgInkAnimator {
  /**
   * @param {Object} options
   * @param {ImageData} options.bakedImageData
   * @param {(dissolveAmount: number, phase: string) => void} options.onRender
   * @param {number} [options.emergeDuration=1000] 反显时长 (ms)
   * @param {number} [options.stayDuration=2000] 定格时长 (ms)
   * @param {number} [options.dissolveDuration=1000] 消融时长 (ms)
   */
  constructor(options) {
    this.bakedImageData = options.bakedImageData;
    this.onRender = options.onRender || (() => {});
    this.emergeDuration = options.emergeDuration ?? 1000;
    this.stayDuration = options.stayDuration ?? 2000;
    this.dissolveDuration = options.dissolveDuration ?? 1000;

    this.state = SvgAnimState.IDLE;
    this.currentDissolve = 0.0;
    this.isLooping = false;
    this._rafId = null;
    this._startTime = 0;
  }

  /**
   * 跳转到指定消融进度 (0.0~1.0)
   * @param {number} dissolveAmount 0.0=饱满显影, 1.0=完全消融
   */
  seek(dissolveAmount) {
    this.stop();
    this.currentDissolve = Math.max(0.0, Math.min(1.0, dissolveAmount));
    this.onRender(this.currentDissolve, 'manual');
  }

  /**
   * 触发单次反显动画 (从 1.0 完全消融态 -> 0.0 饱满显影)
   * @param {number} [duration]
   * @param {() => void} [onComplete]
   */
  emerge(duration = this.emergeDuration, onComplete = null) {
    this.stop();
    this.state = SvgAnimState.EMERGING;
    const startDissolve = this.currentDissolve <= 0.05 ? 1.0 : this.currentDissolve;
    const startTime = performance.now();

    const frame = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(1.0, elapsed / Math.max(1, duration));
      const eased = easeInOutCubic(progress);
      this.currentDissolve = startDissolve * (1.0 - eased);
      this.onRender(this.currentDissolve, SvgAnimState.EMERGING);

      if (progress < 1.0) {
        this._rafId = requestAnimationFrame(frame);
      } else {
        this.currentDissolve = 0.0;
        this.state = SvgAnimState.IDLE;
        this.onRender(0.0, SvgAnimState.IDLE);
        if (onComplete) onComplete();
      }
    };

    this._rafId = requestAnimationFrame(frame);
  }

  /**
   * 触发单次消融吸干动画 (从 0.0 饱满显影 -> 1.0 完全消融)
   * @param {number} [duration]
   * @param {() => void} [onComplete]
   */
  dissolve(duration = this.dissolveDuration, onComplete = null) {
    this.stop();
    this.state = SvgAnimState.DISSOLVING;
    const startDissolve = this.currentDissolve >= 0.95 ? 0.0 : this.currentDissolve;
    const startTime = performance.now();

    const frame = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(1.0, elapsed / Math.max(1, duration));
      const eased = easeInOutCubic(progress);
      this.currentDissolve = startDissolve + (1.0 - startDissolve) * eased;
      this.onRender(this.currentDissolve, SvgAnimState.DISSOLVING);

      if (progress < 1.0) {
        this._rafId = requestAnimationFrame(frame);
      } else {
        this.currentDissolve = 1.0;
        this.state = SvgAnimState.IDLE;
        this.onRender(1.0, SvgAnimState.IDLE);
        if (onComplete) onComplete();
      }
    };

    this._rafId = requestAnimationFrame(frame);
  }

  /**
   * 启动完整生命周期循环演播 (反显 -> 停留 -> 消融 -> 循环)
   */
  startLoop() {
    this.stop();
    this.isLooping = true;

    const playCycle = () => {
      if (!this.isLooping) return;
      // 1. 反显
      this.emerge(this.emergeDuration, () => {
        if (!this.isLooping) return;
        this.state = SvgAnimState.STAYING;
        this.onRender(0.0, SvgAnimState.STAYING);
        // 2. 停留定格
        this._timerId = setTimeout(() => {
          if (!this.isLooping) return;
          // 3. 消融吸干
          this.dissolve(this.dissolveDuration, () => {
            if (!this.isLooping) return;
            // 4. 短暂静置后开启下一轮
            this._timerId = setTimeout(() => {
              if (this.isLooping) playCycle();
            }, 300);
          });
        }, this.stayDuration);
      });
    };

    playCycle();
  }

  /**
   * 停止当前动画或循环
   */
  stop() {
    this.isLooping = false;
    this.state = SvgAnimState.IDLE;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
  }
}
