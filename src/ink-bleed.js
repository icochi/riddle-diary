/**
 * 电影原片级分形蛛网与毛细渗流物理场引擎 (InkBleedField)
 *
 * 职责：
 * 纯数学与 TypedArray 运算，生成 Voronoi 细胞纸浆骨架、各向异性到达时间场 T_reach 与多中心破洞消融时间场 T_dissolve。
 * 零 DOM 依赖，支持无浏览器环境单测与多类墨迹复用。
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function computeBleedField(dotDiameter = 20, bleedWidth = 10) {
  const baseCoreRadius = dotDiameter / 2.0; // 基准核心半径 (如 10px / 12px)
  const baseOuterRadius = baseCoreRadius + bleedWidth; // 基准外缘浸润半径 (如 20px / 24px)
  // 根据最大浸润外缘动态计算尺寸（留出锯齿边界余量）
  const size = Math.max(80, Math.ceil((baseOuterRadius + 14) * 2));
  const center = size / 2;
  const totalPixels = size * size;
  const finalRGBA = new Uint8ClampedArray(totalPixels * 4);
  const coreSolidRGBA = new Uint8ClampedArray(totalPixels * 4);
  const coreRatio = new Float32Array(totalPixels);
  const reachTime = new Float32Array(totalPixels);
  const dissolveTime = new Float32Array(totalPixels);

  const webRGBA = new Uint8ClampedArray(totalPixels * 4);

  // 各向异性比例微调：由原本 1.12:0.92 扁椭圆收敛至 1.02:0.98，消除宏观扁平感
  const ANISO_X = 1.02;
  const ANISO_Y = 0.98;

  // 1. 生成大网眼纸浆微纤维微孔核（中心核区 10 个、中圈过渡 14 个、外层边缘 8 个）
  const cells = [];
  const cellLayers = [
    [10, () => 1.5 + Math.random() * (baseCoreRadius * 0.92), ANISO_X, ANISO_Y],
    [14, () => baseCoreRadius * 0.78 + Math.random() * (baseOuterRadius * 0.95 - baseCoreRadius * 0.78), ANISO_X, ANISO_Y],
    [8, () => baseCoreRadius + bleedWidth * (0.65 + Math.random() * 0.4), ANISO_X + 0.02, ANISO_Y - 0.02],
  ];
  for (const [count, getDist, ax, ay] of cellLayers) {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const d = getDist();
      cells.push([center + d * ax * Math.cos(ang), center + d * ay * Math.sin(ang)]);
    }
  }

  // 2. 有机近正圆墨核边界函数（压制宏观形体畸变，保留高频毛边与非对称随机瑕疵，波幅约 8%~10%）
  const corePhase1 = Math.random() * Math.PI * 2;
  const corePhase2 = Math.random() * Math.PI * 2;
  const corePhase3 = Math.random() * Math.PI * 2;
  const coreScale = baseCoreRadius / 12.0;
  function getCoreRadius(ang) {
    const perturbation =
      (0.35 * Math.sin(3 * ang + corePhase1) +
        0.28 * Math.cos(5 * ang + corePhase2) +
        0.26 * Math.sin(7 * ang + corePhase3) +
        0.22 * Math.cos(11 * ang + 1.7) +
        0.18 * Math.sin(17 * ang + corePhase1)) *
      coreScale;
    return baseCoreRadius + perturbation;
  }

  // 3. 外缘放射状破裂锯齿边界
  const phaseOffset = Math.random() * Math.PI * 2;
  const jaggedScale = bleedWidth / 15.0;
  function getOuterRadius(ang) {
    const jagged =
      (4.0 * Math.sin(3 * ang + phaseOffset) +
        2.8 * Math.sin(7 * ang + 1.8) +
        2.2 * Math.sin(11 * ang + 2.5) +
        1.6 * Math.sin(19 * ang) +
        1.2 * Math.cos(31 * ang)) *
      jaggedScale;
    return baseOuterRadius + jagged;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const pIdx = y * size + x;
      const rgbaIdx = pIdx * 4;

      const dx = (x - center) / ANISO_X;
      const dy = (y - center) / ANISO_Y;
      const dist = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);

      const r_core = getCoreRadius(ang);
      const r_out = getOuterRadius(ang);

      // 骨架距离场计算 (d1: 最近微孔中心距离, d2: 次近距离)
      let d1 = Infinity,
        d2 = Infinity;
      for (let i = 0; i < cells.length; i++) {
        const d = Math.hypot(cells[i][0] - x, cells[i][1] - y);
        if (d < d1) {
          d2 = d1;
          d1 = d;
        } else if (d < d2) {
          d2 = d;
        }
      }
      const diff = d2 - d1;
      // 显著加粗蛛丝物理宽度：diff 除数由 3.0 放宽至 4.6，形成如原片特写般粗壮坚韧的墨丝管道
      const strand = Math.exp(-Math.pow(diff / 4.6, 1.8));
      // 大孔洞中心掏空掏透：除数放宽至 4.5
      const hole = Math.exp(-Math.pow(d1 / 4.5, 2.0));

      // 核心终态权重：墨核经抽吸后向心收缩至 58.5% 尺寸（原 65% 再缩小 10%）
      const r_core_shrunk = r_core * 0.585;
      const coreFactor = clamp01((r_core_shrunk + 1.5 - dist) / 3.5);
      // 外围衰减：指数平缓至 0.55，避免蛛丝向外过快透明化衰竭
      const fade = Math.pow(clamp01(1 - (dist - (r_core_shrunk - 1.0)) / (r_out - r_core_shrunk + 6.0)), 0.55);

      // 提升初始墨色浓度：强化粗蛛丝的实心饱满度，大孔洞内部清透掏空
      const webIntensity = (strand * 1.55 + 0.12 * fade) * fade - hole * 0.72 * (1 - coreFactor * 0.92);
      let intensity = Math.max(coreFactor, webIntensity);

      // 最外缘毛细尖刺剪裁
      if (dist > r_out - 4) {
        const edge = Math.max(0, (r_out + 6 - dist) / 10.0);
        intensity *= Math.pow(strand, 1.4) * edge;
      }

      intensity = clamp01(intensity);

      // 初始未收缩时的核心掩膜 (覆盖 100% 原始墨核 dist <= r_core)
      const initialCoreFactor = clamp01((r_core + 1.0 - dist) / 3.0);

      // 全域完整蛛网强度（纯粹的高对比浓黑 Voronoi 蛛网骨架）：
      const fullFade = Math.pow(clamp01(1 - dist / (r_out + 5.0)), 0.6);
      let pureWebIntensity = (strand * 1.5 + 0.12 * fullFade) * fullFade - hole * 0.72;
      if (dist > r_out - 3) {
        const outerEdge = Math.max(0, (r_out + 5.0 - dist) / 8.0);
        pureWebIntensity *= Math.pow(strand, 1.4) * outerEdge;
      }
      pureWebIntensity = clamp01(pureWebIntensity);

      if (intensity > 0.02 || initialCoreFactor > 0.01 || pureWebIntensity > 0.02) {
        // 墨色深浅过渡天然融合：中心纯浓黑 -> 中外圈深茶黑（调低浅茶褐漂白，增强网丝墨色浓郁度与对比）
        const c_ratio = (1 - coreFactor) * (1 - fade);
        finalRGBA[rgbaIdx] = Math.round(13 + c_ratio * 22);
        finalRGBA[rgbaIdx + 1] = Math.round(9 + c_ratio * 15);
        finalRGBA[rgbaIdx + 2] = Math.round(5 + c_ratio * 10);
        finalRGBA[rgbaIdx + 3] = Math.round(intensity * 255);

        // 全域蛛网终态 RGBA (高对比浓黑色)
        const web_ratio = Math.min(1.0, dist / (r_out + 2.0));
        webRGBA[rgbaIdx] = Math.round(14 + web_ratio * 18);
        webRGBA[rgbaIdx + 1] = Math.round(9 + web_ratio * 12);
        webRGBA[rgbaIdx + 2] = Math.round(6 + web_ratio * 8);
        webRGBA[rgbaIdx + 3] = Math.round(pureWebIntensity * 255);

        // 初始未扩散时的饱满纯墨核 (完全不透明纯黑)：
        if (initialCoreFactor > 0.01) {
          coreSolidRGBA[rgbaIdx] = 11;
          coreSolidRGBA[rgbaIdx + 1] = 7;
          coreSolidRGBA[rgbaIdx + 2] = 4;
          coreSolidRGBA[rgbaIdx + 3] = Math.round(initialCoreFactor * 255);
        }

        // 到达时间场 T_reach:
        if (dist <= r_core - 1.0) {
          reachTime[pIdx] = 0.0;
        } else {
          const radialNorm = Math.max(0, Math.min(1, (dist - (r_core - 1.0)) / (r_out + 6 - (r_core - 1.0))));
          const strandAdvantage = (1 - strand) * 0.32;
          const holeDelay = hole * 0.24;
          const t = radialNorm * 0.72 + strandAdvantage + holeDelay;
          reachTime[pIdx] = Math.max(0.01, Math.min(1.0, t));
        }

        // 归一化核心相对半径比例 (0.0 = 中心点, 1.0 = 核心外缘)：
        coreRatio[pIdx] = Math.max(0.0, dist / Math.max(0.001, r_core));
      } else {
        reachTime[pIdx] = 999.0;
      }
    }
  }

  // 计算有机墨核的严格几何内接正圆半径 (用于 3D 墨珠尺寸精确对齐)
  let inscribedRadius = Infinity;
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const rCore = getCoreRadius(a) - 1.0;
    const anisoScale = Math.hypot(ANISO_X * Math.cos(a), ANISO_Y * Math.sin(a));
    const r = rCore * anisoScale;
    if (r < inscribedRadius) inscribedRadius = r;
  }

  return {
    size,
    finalRGBA,
    coreSolidRGBA,
    coreRatio,
    reachTime,
    dissolveTime,
    webRGBA,
    inscribedRadius,
  };
}
