import { computeSkeletonField } from './ink-rasterizer.js';

/**
 * 左页历史索引视图深模块 (LeftPageHistoryView)
 *
 * 职责：
 * 1. 负责左页版心内的 Session 手风琴排版与问答历史项光栅化；
 * 2. 提取文字 EDT 欧氏中轴骨架场并回写 Canvas ImageData 的 Green 通道；
 * 3. 记录各条目像素与归一化 YRange 边界，供反向显影动画 (emergeLeftItem) 精确锁定作用域；
 * 4. 封装白银比例着色器 UV 逆映射几何算子与点击容差拾取 (hitTest)。
 */

/**
 * 基于 FNV-1a 32位哈希计算确定性随机种子
 * @param {string} str
 * @returns {number}
 */
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

/**
 * 绘制羽毛笔书写质感的手绘微弧下划线
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x 文字左侧起点
 * @param {number} y 文字下划线基准 Y 坐标
 * @param {number} width 文字测算宽度
 * @param {number} seed 确定性种子，确保同一条目多次重绘不抖动
 */
function drawHandDrawnUnderline(ctx, x, y, width, seed) {
  if (width <= 0 || typeof ctx.beginPath !== 'function') return;

  let s = seed | 0;
  const rand = () => ((s = (s + 0x6d2b79f5) | 0), ((Math.imul(s ^ (s >>> 15), 1 | s)) >>> 0) / 4294967296);

  // 起止端点自然微延展与首尾微扬/垂角
  const startX = x - (1.5 + rand() * 2.5);
  const endX = x + width + (3.0 + rand() * 3.5);
  const totalW = endX - startX;
  if (totalW <= 0) return;

  const yBase = y;
  // 自然中段微弧下沉 (1.2 ~ 2.4px) 与行末微扬/垂微倾斜 (-0.5 ~ +0.6px)
  const dip = 1.2 + rand() * 1.2;
  const tilt = (rand() - 0.45) * 1.1;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const cp1x = startX + totalW * 0.28;
  const cp1y = yBase + dip * 0.7 + (rand() - 0.5) * 0.5;
  const midX = startX + totalW * 0.55;
  const midY = yBase + dip + (rand() - 0.5) * 0.4;
  const cp2x = startX + totalW * 0.82;
  const cp2y = yBase + dip * 0.6 + tilt * 0.6 + (rand() - 0.5) * 0.5;
  const finishX = endX;
  const finishY = yBase + tilt;

  // 第一层：基底墨迹（主笔划微弧线，浓郁深墨色）
  ctx.strokeStyle = 'rgba(20, 13, 7, 0.88)';
  ctx.lineWidth = 1.9 + rand() * 0.4;
  ctx.beginPath();
  ctx.moveTo(startX, yBase);
  ctx.quadraticCurveTo(cp1x, cp1y, midX, midY);
  ctx.quadraticCurveTo(cp2x, cp2y, finishX, finishY);
  ctx.stroke();

  // 第二层：中段轻微浸润叠笔（模拟羽毛笔行笔压感，两端收敛、腹部深实）
  ctx.strokeStyle = 'rgba(20, 13, 7, 0.45)';
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(startX + totalW * 0.15, yBase + dip * 0.3);
  ctx.quadraticCurveTo(midX, midY + 0.4, startX + totalW * 0.85, yBase + dip * 0.35 + tilt * 0.7);
  ctx.stroke();

  ctx.restore();
}

export class LeftPageHistoryView {
  /**
   * @param {Object} options
   * @param {{ x: number, y: number, w: number, h: number }} options.pageRect 版心矩形
   * @param {{ size: number, lineHeight: number, family: string }} options.fontConfig 字体配置
   * @param {number} [options.canvasSize=2048] 贴图全尺寸
   */
  constructor({ pageRect, fontConfig, canvasSize = 2048 }) {
    this.pageRect = pageRect;
    this.fontConfig = fontConfig;
    this.canvasSize = canvasSize;
    this.itemBounds = [];
    this.hoveredId = null;
  }

  /**
   * 设置当前鼠标悬停的条目 ID
   * @param {string|null} id
   */
  setHoveredId(id) {
    this.hoveredId = id || null;
  }

  /**
   * 获取指定 ID 条目的手绘下划线归一化 Y 范围
   * @param {string} id
   */
  getUnderlineBounds(id) {
    const b = this.itemBounds.find((item) => item.id === id);
    return b ? b.underlineYRange : null;
  }

  /**
   * 计算版心最大容纳条目数
   */
  get capacity() {
    return Math.floor(this.pageRect.h / (this.fontConfig.lineHeight + 6));
  }

  /**
   * 获取指定 ID 条目的归一化与像素边界信息
   * @param {string} id
   */
  getItemBounds(id) {
    return this.itemBounds.find((b) => b.id === id) || null;
  }

  /**
   * 获取指定索引位置条目的归一化与像素边界信息
   * @param {number} index
   */
  getItemBoundsByIndex(index) {
    return this.itemBounds[index] || null;
  }

  /**
   * 计算指定索引范围的合并边界
   * @param {number} startIndex
   * @param {number} endIndex
   */
  getBoundsForIndexRange(startIndex, endIndex) {
    const s = Math.max(0, Math.min(startIndex, endIndex));
    const e = Math.min(this.itemBounds.length - 1, Math.max(startIndex, endIndex));
    if (s > e || this.itemBounds.length === 0) return null;
    const first = this.itemBounds[s];
    const last = this.itemBounds[e];
    if (!first || !last) return null;
    return {
      yMinNorm: Math.min(first.yMinNorm, last.yMinNorm),
      yMaxNorm: Math.max(first.yMaxNorm, last.yMaxNorm),
    };
  }

  /**
   * 绘制左页历史对话列表至 2D Canvas 并编码 Green 通道骨架场
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array} items sessionModel.getFlattenedIndexItems() 输出的扁平化列表
   */
  render(ctx, items) {
    this.itemBounds = [];
    if (!items || items.length === 0) return;

    ctx.save();
    ctx.textBaseline = 'top';

    const itemHeight = this.fontConfig.lineHeight + 6;
    let curY = this.pageRect.y;

    for (let i = 0; i < items.length; i++) {
      if (curY + itemHeight > this.pageRect.y + this.pageRect.h) break;
      const item = items[i];

      const textX = this.pageRect.x + 8;
      const displayTitle = item.title;

      // Session 标题行（顶格展示纯文本，当前激活篇章加粗加深）
      ctx.font = `bold ${this.fontConfig.size}px ${this.fontConfig.family}`;
      ctx.fillStyle = item.isCurrent ? 'rgba(20, 13, 7, 0.95)' : 'rgba(56, 40, 28, 0.75)';

      ctx.fillText(displayTitle, textX, curY);

      // 计算并记录该行条目的边界与归一化 YRange
      const textMetrics = ctx.measureText(displayTitle);
      const textWidth = textMetrics.width;

      // 当前活跃 Session 标题保持常驻下划线；鼠标悬停 (hover) 时动态渲染手绘下划线
      const isCurrentSession = Boolean(item.isCurrent);
      const isHovered = Boolean(this.hoveredId && item.id === this.hoveredId);
      const shouldUnderline = isCurrentSession || isHovered;

      const underlineY = curY + this.fontConfig.size + 3;
      const seed = hashString(item.id || item.title || String(i));

      if (shouldUnderline) {
        drawHandDrawnUnderline(ctx, textX, underlineY, textWidth, seed);
      }

      // 下划线 Y 范围：基准点上浮 4px、下浮 8px (共 12px 跨度)，完整覆盖中段下沉微弧与笔画宽度
      const underlineYMinNorm = (underlineY - 4) / this.canvasSize;
      const underlineYMaxNorm = (underlineY + 8) / this.canvasSize;
      // 下划线 X 范围：左右各外扩 4px 容差
      const underlineXMinNorm = Math.max(0, textX - 4) / this.canvasSize;
      const underlineXMaxNorm = Math.min(this.canvasSize, textX + textWidth + 8) / this.canvasSize;

      const rowW = Math.min(this.pageRect.w, textWidth + 16);
      const rowY = curY;
      const rowH = itemHeight;
      const yMinNorm = (rowY - 8) / this.canvasSize;
      const yMaxNorm = (rowY + rowH + 8) / this.canvasSize;

      this.itemBounds.push({
        id: item.id,
        type: item.type,
        sessionId: item.sessionId,
        histItem: item.histItem,
        isCurrent: item.isCurrent,
        isActive: item.isActive,
        index: i,
        rx: Math.max(0, Math.floor(textX - 8)),
        ry: Math.max(0, Math.floor(rowY - 6)),
        rw: Math.min(this.canvasSize, Math.ceil(rowW + 16)),
        rh: Math.min(this.canvasSize, Math.ceil(rowH + 12)),
        yMinNorm,
        yMaxNorm,
        underlineYRange: {
          yMinNorm: underlineYMinNorm,
          yMaxNorm: underlineYMaxNorm,
        },
        underlineBox: {
          uMin: underlineXMinNorm,
          uMax: underlineXMaxNorm,
          vMin: underlineYMinNorm,
          vMax: underlineYMaxNorm,
        },
      });

      curY += itemHeight;
    }

    ctx.restore();

    // 为左页绘制的文字提取骨架场并写入 Green 通道
    if (this.itemBounds.length > 0) {
      const firstB = this.itemBounds[0];
      const lastB = this.itemBounds[this.itemBounds.length - 1];
      const totalRx = Math.max(0, Math.floor(this.pageRect.x));
      const totalRy = Math.max(0, Math.floor(firstB.ry));
      const totalRw = Math.min(this.canvasSize - totalRx, Math.ceil(this.pageRect.w + 20));
      const totalRh = Math.min(this.canvasSize - totalRy, Math.ceil((lastB.ry + lastB.rh) - totalRy + 10));

      if (totalRw > 0 && totalRh > 0) {
        const imgData = ctx.getImageData(totalRx, totalRy, totalRw, totalRh);
        const skeleton = computeSkeletonField(imgData.data, totalRw, totalRh, { isRgba: true });
        const data = imgData.data;
        for (let j = 0; j < totalRw * totalRh; j++) {
          data[j * 4 + 1] = skeleton[j];
        }
        ctx.putImageData(imgData, totalRx, totalRy);
      }
    }
  }

  /**
   * 根据 3D 页面射线碰撞返回的 UV 坐标进行白银比例几何逆映射与点击拾取
   * @param {{ x: number, y: number }} uv 书页 UV 坐标 (0~1)
   * @returns {{ type: 'session'|'history', sessionId: string, histItem: any, isCurrent: boolean } | null}
   */
  hitTest(uv) {
    if (!uv || this.itemBounds.length === 0) return null;

    // 着色器内对贴图 V 轴进行了物理白银比例居中映射: texV = (pageUv.y - 0.5) * 0.7071 + 0.5
    // 水平方向左页映射: texU = (1.0 - pageUv.x) * 0.5
    const texU = (1.0 - uv.x) * 0.5;
    const texV = (uv.y - 0.5) * 0.7071 + 0.5;

    // 校验水平是否落在左页版心范围内 (允许 50px 的点击容差)
    const uMin = (this.pageRect.x - 50) / this.canvasSize;
    const uMax = (this.pageRect.x + this.pageRect.w + 50) / this.canvasSize;
    if (texU < uMin || texU > uMax) return null;

    const itemHeight = this.fontConfig.lineHeight + 6;
    const canvasY = texV * this.canvasSize;
    const deltaY = canvasY - this.pageRect.y;

    // 允许第一行文字顶部约 35% 行高舒适容差
    const topMargin = itemHeight * 0.35;
    if (deltaY < -topMargin) return null;

    const adjustedDeltaY = Math.max(0, deltaY);
    const index = Math.floor(adjustedDeltaY / itemHeight);

    if (index >= 0 && index < this.itemBounds.length) {
      const clicked = this.itemBounds[index];
      return {
        id: clicked.id,
        type: clicked.type,
        sessionId: clicked.sessionId,
        histItem: clicked.histItem,
        isCurrent: clicked.isCurrent,
        underlineYRange: clicked.underlineYRange,
        underlineBox: clicked.underlineBox,
      };
    }

    return null;
  }
}
