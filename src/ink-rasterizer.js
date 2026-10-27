/**
 * 墨迹排版与骨架光栅化器 (InkRasterizer)
 *
 * 领域深模块职责：
 * 1. 文本折行测算 (wrapTextLines) 与跨屏范围度量 (measurePageRanges)
 * 2. 双字系 (用户提问 Long Cang vs AI 回复 WangHanZong-ZhongXingShu) 字符光栅化
 * 3. 极速可分离 1D EDT (欧氏距离变换) 提取笔画中轴深度
 * 4. 局部极大值归一化并写入 Green 通道，供 GPU 片元着色器驱动笔画粗细演化
 *
 * 接口设计：
 * - 小接口 (layout, measureRanges, rasterizePage, computeSkeletonField)
 * - 纯逻辑无状态算法完全可脱离 DOM / 浏览器在 Node 环境下执行单元测试
 */

/**
 * 纯算法：两趟扫描 1D EDT + 局部极大值提取，生成笔画中轴归一化深度场 (0~255)
 * @param {Uint8ClampedArray|Uint8Array} alphaChannel 仅包含 alpha (0~255) 的单通道数组，或包含 RGBA 的像素数组 (isRgba=true)
 * @param {number} W 区域宽度
 * @param {number} H 区域高度
 * @param {Object} [options]
 * @param {boolean} [options.isRgba=false] 输入是否为 RGBA 数组
 * @param {number} [options.threshold=25] 判定笔画内的二值化阈值
 * @param {number} [options.searchRadius=20] 水平距离搜索窗口半径
 * @param {number} [options.localMaxRadius=7] 局部极大值搜索窗口半径
 * @returns {Uint8Array} 大小为 W * H 的归一化骨架距离场 (0=外缘, 255=中心骨线)
 */
export function computeSkeletonField(alphaChannel, W, H, options = {}) {
  const isRgba = Boolean(options.isRgba);
  const threshold = options.threshold ?? 25;
  const R = options.searchRadius ?? 20;
  const localR = options.localMaxRadius ?? 7;
  const INF = 1e5;
  const total = W * H;

  const result = new Uint8Array(total);
  if (W <= 0 || H <= 0) return result;

  // 1. 二值化判定
  const dist = new Float32Array(total);
  let hasInk = false;
  for (let i = 0; i < total; i++) {
    const a = isRgba ? alphaChannel[i * 4 + 3] : alphaChannel[i];
    if (a > threshold) {
      dist[i] = INF;
      hasInk = true;
    } else {
      dist[i] = 0;
    }
  }
  if (!hasInk) return result;

  // 2. 纵向 1D 欧氏距离变换 (两趟扫描)
  const g = new Float32Array(total);
  for (let x = 0; x < W; x++) {
    let d = INF;
    for (let y = 0; y < H; y++) {
      const idx = y * W + x;
      d = dist[idx] === 0 ? 0 : d + 1;
      g[idx] = d;
    }
    d = INF;
    for (let y = H - 1; y >= 0; y--) {
      const idx = y * W + x;
      d = dist[idx] === 0 ? 0 : d + 1;
      if (d < g[idx]) g[idx] = d;
    }
  }

  // 3. 横向 1D 窗口搜索距离变换 (书法字半宽 <= R)
  const edt = new Float32Array(total);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (g[row + x] === 0) continue;
      let minD2 = g[row + x] * g[row + x];
      const x0 = Math.max(0, x - R);
      const x1 = Math.min(W - 1, x + R);
      for (let nx = x0; nx <= x1; nx++) {
        const dx = nx - x;
        const gy = g[row + nx];
        const d2 = dx * dx + gy * gy;
        if (d2 < minD2) minD2 = d2;
      }
      edt[row + x] = Math.sqrt(minD2);
    }
  }

  // 4. 可分离局部极大值提取 (水平 + 垂直滑动窗口)
  const maxH = new Float32Array(total);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let m = 0;
      const x0 = Math.max(0, x - localR);
      const x1 = Math.min(W - 1, x + localR);
      for (let nx = x0; nx <= x1; nx++) {
        const val = edt[row + nx];
        if (val > m) m = val;
      }
      maxH[row + x] = m;
    }
  }

  const localMax = new Float32Array(total);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let m = 0;
      const y0 = Math.max(0, y - localR);
      const y1 = Math.min(H - 1, y + localR);
      for (let ny = y0; ny <= y1; ny++) {
        const val = maxH[ny * W + x];
        if (val > m) m = val;
      }
      localMax[y * W + x] = m;
    }
  }

  // 5. 归一化写入结果：中轴骨线处接近 255，外轮廓边缘处为 0
  for (let i = 0; i < total; i++) {
    const d = edt[i];
    if (d > 0.05) {
      const lm = Math.max(d, localMax[i]);
      const norm = lm > 0.5 ? Math.min(1.0, d / lm) : 1.0;
      result[i] = Math.round(norm * 255);
    } else {
      result[i] = 0;
    }
  }

  return result;
}

/**
 * 纯逻辑：根据给定的宽度测量器测算文本折行
 * @param {string} text 待排版文本
 * @param {number} maxWidth 最大行宽 (px)
 * @param {(str: string) => number} measureWidth 测算单段字符串宽度的函数
 * @returns {Array<string>} 折行后的多行文本数组
 */
export function wrapTextLines(text, maxWidth, measureWidth) {
  if (!text) return [];
  const lines = [];
  let curIdx = 0;
  while (curIdx < text.length) {
    let lineEnd = curIdx + 1;
    while (lineEnd <= text.length) {
      const sub = text.slice(curIdx, lineEnd);
      if (measureWidth(sub) > maxWidth) {
        lineEnd = Math.max(curIdx + 1, lineEnd - 1);
        break;
      }
      if (lineEnd === text.length) break;
      lineEnd++;
    }
    lines.push(text.slice(curIdx, lineEnd));
    curIdx = lineEnd;
  }
  return lines;
}

export class InkRasterizer {
  /**
   * @param {Object} options
   * @param {Object} options.pageRect 版心位置与尺寸 { x, y, w, h }
   * @param {Object} options.fontConfig 字体与行距配置 { family, aiFamily, size, lineHeight }
   * @param {number} [options.canvasSize=2048]
   */
  constructor({ pageRect, fontConfig, canvasSize = 2048 }) {
    this.pageRect = pageRect;
    this.fontConfig = fontConfig;
    this.canvasSize = canvasSize;
  }

  /**
   * 测算单段文字在指定字系下的折行行列表
   * @param {string} text
   * @param {boolean} isAi
   * @param {CanvasRenderingContext2D} ctx
   * @returns {Array<string>}
   */
  layout(text, isAi, ctx) {
    if (!text) return [];
    ctx.save();
    ctx.font = `bold ${this.fontConfig.size}px ${isAi ? this.fontConfig.aiFamily : this.fontConfig.family}`;
    const lines = wrapTextLines(text, this.pageRect.w, (str) => ctx.measureText(str).width);
    ctx.restore();
    return lines;
  }

  /**
   * 适配 InkSessionModel 所需的分屏范围测算器
   * @param {string} text
   * @param {boolean} isAi
   * @param {CanvasRenderingContext2D} ctx
   * @returns {Array<{ start: number, end: number, text: string }>}
   */
  measurePageRanges(text, isAi, ctx) {
    if (!text) return [{ start: 0, end: 0, text: '' }];
    ctx.save();
    ctx.font = `bold ${this.fontConfig.size}px ${isAi ? this.fontConfig.aiFamily : this.fontConfig.family}`;
    const maxW = this.pageRect.w;
    const maxH = this.pageRect.h;
    const lineH = this.fontConfig.lineHeight;
    const maxLines = Math.floor(maxH / lineH);

    const ranges = [];
    let start = 0;
    while (start < text.length) {
      let linesCount = 0;
      let curIdx = start;
      while (curIdx < text.length && linesCount < maxLines) {
        let lineEnd = curIdx + 1;
        while (lineEnd <= text.length) {
          const sub = text.slice(curIdx, lineEnd);
          if (ctx.measureText(sub).width > maxW) {
            lineEnd = Math.max(curIdx + 1, lineEnd - 1);
            break;
          }
          if (lineEnd === text.length) break;
          lineEnd++;
        }
        curIdx = lineEnd;
        linesCount++;
      }
      ranges.push({
        start,
        end: curIdx,
        text: text.slice(start, curIdx),
      });
      start = curIdx;
    }
    ctx.restore();
    return ranges.length > 0 ? ranges : [{ start: 0, end: text.length, text }];
  }

  /**
   * 光栅化排版文字至指定 Canvas 上下文，并直接烘焙 Green 通道骨架距离场
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text
   * @param {Object} options
   * @param {boolean} [options.isAi=false]
   * @param {number} [options.alpha=1.0]
   */
  rasterizePage(ctx, text, options = {}) {
    if (!text || options.alpha <= 0.005) return null;
    const isAi = Boolean(options.isAi);
    const alpha = options.alpha ?? 1.0;
    const { x, y, w } = this.pageRect;
    const lineH = this.fontConfig.lineHeight;

    const lines = this.layout(text, isAi, ctx);
    if (lines.length === 0) return null;

    ctx.save();
    ctx.font = `bold ${this.fontConfig.size}px ${isAi ? this.fontConfig.aiFamily : this.fontConfig.family}`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = `rgba(27, 18, 12, ${Math.min(1.0, alpha)})`;

    let curY = y;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, curY);
      curY += lineH;
    }
    ctx.restore();

    // 提取文字边界并烘焙骨架场
    const totalLinesH = lines.length * lineH;
    const rx = Math.max(0, Math.floor(x - 8));
    const ry = Math.max(0, Math.floor(y - 8));
    const rw = Math.min(this.canvasSize - x, Math.ceil(w + 16));
    const rh = Math.min(this.canvasSize - y, Math.ceil(totalLinesH + 16));

    if (rw > 0 && rh > 0) {
      const imgData = ctx.getImageData(rx, ry, rw, rh);
      const skeleton = computeSkeletonField(imgData.data, rw, rh, { isRgba: true });
      const data = imgData.data;
      for (let i = 0; i < rw * rh; i++) {
        data[i * 4 + 1] = skeleton[i]; // 将骨架归一化值写入 Green 通道
      }
      ctx.putImageData(imgData, rx, ry);
    }

    return {
      lines,
      bounds: { rx, ry, rw, rh },
    };
  }
}

/**
 * 纯算法：应用与 GPU 片元着色器 (pages.js) 100% 同构的骨架形态学消融/反向显影算子
 *
 * 算法逻辑严格对应 pages.js:
 * 1. widthCutoff = mix(-0.15, 1.15, smoothstep(0.05, 0.98, activeDissolve))
 * 2. feather = mix(0.12, 0.45, activeDissolve)
 * 3. widthAlpha = smoothstep(-feather, feather, strokeDepth - widthCutoff)
 * 4. opacity = smoothstep(0.015, 0.80, stage)
 * 5. 颜色双色相渐变：水痕浅褐 (51, 35, 24) -> 饱满浓墨 (11, 8, 5)
 *
 * @param {Uint8ClampedArray} pixels RGBA 像素数组
 * @param {Uint8Array} skeleton 归一化骨架距离场 (0~255)
 * @param {number} total 像素总数 (W * H)
 * @param {number} activeDissolve 消融进度 (0.0=饱满显影, 1.0=完全消融)
 * @param {boolean} [isAi=false] 是否 AI 字系
 */
export function applyMorphologicalDissolution(pixels, skeleton, total, activeDissolve, isAi = false) {
  if (activeDissolve <= 0.001) return;

  const stage = 1.0 - activeDissolve;

  // 1. 笔画收缩位移：从 -0.15 (饱满完全覆盖) 推进到 1.15 (完全收尽)
  // smoothstep(0.05, 0.98, activeDissolve)
  const dProg = Math.max(0, Math.min(1, (activeDissolve - 0.05) / (0.98 - 0.05)));
  const smoothD = dProg * dProg * (3.0 - 2.0 * dProg);
  const widthCutoff = -0.15 + (1.15 - -0.15) * smoothD;

  // 2. 宽域羽化过渡带：深度消融/显影时过渡带宽度达到 0.45
  const feather = 0.12 + (0.45 - 0.12) * activeDissolve;

  // 3. 全局柔和不透明度淡化 (缓入快出)
  const sProg = Math.max(0, Math.min(1, (stage - 0.015) / (0.80 - 0.015)));
  const opacity = sProg * sProg * (3.0 - 2.0 * sProg);

  // 4. 双色相铁胆墨水颜色过渡
  const cProg = Math.max(0, Math.min(1, (stage - 0.08) / (0.65 - 0.08)));
  const colorStage = cProg * cProg * (3.0 - 2.0 * cProg);

  // 水痕浅褐 (#332318) 到饱满古乌浓墨 (#140d07)
  const rMin = 65, gMin = 45, bMin = 30; // 浅褐水渍骨线
  const rMax = isAi ? 32 : 20;           // 饱满浓墨
  const gMax = isAi ? 22 : 13;
  const bMax = isAi ? 14 : 7;

  const targetR = Math.round(rMin + (rMax - rMin) * colorStage);
  const targetG = Math.round(gMin + (gMax - gMin) * colorStage);
  const targetB = Math.round(bMin + (bMax - bMin) * colorStage);

  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const origA = pixels[idx + 3];
    if (origA === 0) continue;

    const strokeDepth = skeleton[i] / 255.0;
    const diff = strokeDepth - widthCutoff;

    // smoothstep(-feather, feather, diff)
    let widthAlpha = 0;
    if (diff <= -feather) {
      widthAlpha = 0;
    } else if (diff >= feather) {
      widthAlpha = 1.0;
    } else {
      const t = (diff - (-feather)) / (feather * 2.0);
      widthAlpha = t * t * (3.0 - 2.0 * t);
    }

    const dissolveAlpha = widthAlpha * opacity;
    const newA = Math.round(origA * dissolveAlpha);

    pixels[idx] = targetR;
    pixels[idx + 1] = skeleton[i]; // 保留 Green 骨架场供着色器兼容
    pixels[idx + 2] = targetB;
    pixels[idx + 3] = newA;
  }
}
