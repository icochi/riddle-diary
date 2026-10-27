import { computeBleedField } from './ink-bleed.js';

export const DEFAULT_DROP_CONFIG = {
  dotDiameter: 24,            // 最初滴落墨核基准直径 (px, 在 2048 分辨率下)
  bleedWidth: 7,              // 外围毛细蛛网浸润环外延宽度 (px，减小蛛网范围至紧凑内敛的 7px)
  firstDropDelay: 1200,       // 页面展开/就绪后第一滴墨延迟滴落时间 (ms)
  typingIdleDelay: 600,       // 打字静止间隙：文字最后一次变更后重新滴落待输入墨滴的等待时间 (ms)
  condenseDuration: 350,      // 3D 阶段一：原位凝结膨起时长 (ms, 原片 ~350ms)
  condenseStay: 500,          // 3D 阶段二：饱满晶莹定格时长 (ms, 原片 ~500ms 呼吸定格)
  absorbDuration: 1200,       // 3D 阶段三：伴随外围毛细向四周抽吸扩散的慢速渗入时长 (ms)
  bleedDelay: 500,            // 阶段零：小墨点刚滴落接触纸面定格延迟 (ms, 无 3D 环境退化使用)
  spreadDuration: 1800,       // 阶段一：向四周毛细渗透展开 (ms, 放慢至优雅舒缓的 1800ms 慢速演播)
  settleTime: 80,             // 阶段二：饱满浸透余韵过渡 (ms)
  dissolveDuration: 1550,     // 阶段三：蛛网演化(750ms)与全域淡化(800ms)总时长 (ms, 原片 ~1550ms)
  interval: 1600,             // 阶段四：留白间隔 (ms)
};

const safeRaf = typeof requestAnimationFrame !== 'undefined'
  ? requestAnimationFrame
  : (cb) => setTimeout(() => cb(performance.now()), 16);
const safeCancelRaf = typeof cancelAnimationFrame !== 'undefined'
  ? cancelAnimationFrame
  : (id) => clearTimeout(id);

/**
 * 待输入滴墨管线深模块 (InkDropPipeline)
 *
 * 职责：
 * 1. 隐藏阶段定时器、rAF 循环与局部微观时间场计算；
 * 2. 封装五阶段生命周期（接触定格 -> 渗透展开 -> 饱满浸透 -> 分形消融 -> 留白间隔）；
 * 3. 维护独立离屏缓冲，对外部通知重绘请求 (onDirty)；
 * 4. 支持由外部查询/渲染当前墨滴位图与透明度。
 */
export class InkDropPipeline {
  /**
   * @param {Object} options
   * @param {Object} [options.config] 参数配置
   * @param {() => { x: number, y: number }} options.getPosition 获取当前墨点放置坐标的回调
   * @param {(canvasPos: { x: number, y: number }) => { position: any, normal: any }} [options.get3DPosition] 映射至 3D 纸面世界坐标
   * @param {any} [options.droplet3D] 3D 墨滴实例
   * @param {() => void} options.onDirty 局部或整页画布脏标记重绘回调
   * @param {(phase: string, meta?: Object) => void} [options.onPhaseChange] 阶段变更通知回调
   */
  constructor({ config = {}, getPosition, get3DPosition = null, droplet3D = null, onDirty, onPhaseChange = null }) {
    this.config = { ...DEFAULT_DROP_CONFIG, ...config };
    this.getPosition = getPosition;
    this.get3DPosition = get3DPosition;
    this.droplet3D = droplet3D;
    this.onDirty = onDirty;
    this.onPhaseChange = onPhaseChange;

    this.currentPhase = 'idle';
    this.activeDrop = null;
    this.dropAlpha = 1.0;
    this.dropCycleTimer = null;
    this.activeDropRaf = null;
    this.isEnabled = false;
  }

  _setPhase(phase, meta = {}) {
    this.currentPhase = phase;
    if (this.onPhaseChange) {
      try {
        this.onPhaseChange(phase, meta);
      } catch (e) {
        console.error(e);
      }
    }
  }

  get hasActiveDrop() {
    return Boolean(
      this.activeDrop &&
      (this.dropAlpha > 0.005 || (this.droplet3D && this.droplet3D.mesh && this.droplet3D.mesh.visible))
    );
  }

  /**
   * 将当前墨滴绘制到目标 2D Canvas 上下文
   * @param {CanvasRenderingContext2D} ctx
   */
  renderTo(ctx) {
    if (!this.hasActiveDrop || this.dropAlpha <= 0.005) return;
    const pos = this.getPosition();
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1.0, this.dropAlpha));
    const half = this.activeDrop.size / 2;
    ctx.drawImage(this.activeDrop.canvas, pos.x - half, pos.y - half);
    ctx.restore();
  }

  /**
   * 启动循环滴墨
   * @param {number} [delay=0]
   */
  start(delay = 0) {
    this.stop();
    this.isEnabled = true;
    if (delay > 0) {
      this._setPhase('waiting', { delay });
      this.dropCycleTimer = setTimeout(() => {
        this._spawnSingleDrop();
      }, delay);
    } else {
      this._spawnSingleDrop();
    }
  }

  /**
   * 停止循环并清理动画
   */
  stop() {
    if (this.dropCycleTimer) {
      clearTimeout(this.dropCycleTimer);
      this.dropCycleTimer = null;
    }
    if (this.activeDropRaf) {
      safeCancelRaf(this.activeDropRaf);
      this.activeDropRaf = null;
    }
    if (this.droplet3D) {
      this.droplet3D.hide();
    }
    this.activeDrop = null;
    this.dropAlpha = 1.0;
    this._setPhase('idle');
  }

  setEnabled(enabled) {
    this.isEnabled = enabled;
    if (!enabled) {
      this.stop();
    }
  }

  _spawnSingleDrop() {
    if (!this.isEnabled) return;

    const field = computeBleedField(this.config.dotDiameter, this.config.bleedWidth);
    const dropCanvas = document.createElement('canvas');
    dropCanvas.width = dropCanvas.height = field.size;
    const dropCtx = dropCanvas.getContext('2d');
    const currentImgData = dropCtx.createImageData(field.size, field.size);
    const curData = currentImgData.data;
    const totalPixels = field.size * field.size;

    for (let i = 0; i < totalPixels; i++) {
      if (field.coreSolidRGBA && field.coreSolidRGBA[i * 4 + 3] > 0) {
        const idx = i * 4;
        curData[idx] = field.coreSolidRGBA[idx];
        curData[idx + 1] = field.coreSolidRGBA[idx + 1];
        curData[idx + 2] = field.coreSolidRGBA[idx + 2];
        curData[idx + 3] = field.coreSolidRGBA[idx + 3];
      } else if (field.reachTime[i] <= 0.0) {
        const idx = i * 4;
        curData[idx] = field.finalRGBA[idx];
        curData[idx + 1] = field.finalRGBA[idx + 1];
        curData[idx + 2] = field.finalRGBA[idx + 2];
        curData[idx + 3] = field.finalRGBA[idx + 3];
      }
    }
    dropCtx.putImageData(currentImgData, 0, 0);

    this.activeDrop = {
      canvas: dropCanvas,
      ctx: dropCtx,
      size: field.size,
      finalRGBA: field.finalRGBA,
      coreSolidRGBA: field.coreSolidRGBA,
      coreRatio: field.coreRatio,
      reachTime: field.reachTime,
      dissolveTime: field.dissolveTime,
      webRGBA: field.webRGBA,
      currentImgData,
    };

    if (this.droplet3D) {
      if (typeof field.inscribedRadius === 'number') {
        this.droplet3D.setBaseRadius(field.inscribedRadius);
      }
      if (this.get3DPosition) {
        const pos = this.getPosition();
        const pos3D = this.get3DPosition(pos);
        if (pos3D && pos3D.position) {
          this.droplet3D.showAt(pos3D.position, pos3D.normal);
          this.dropAlpha = 0.0;
          this.onDirty();
          this._animateDropletCondense(this.activeDrop);
          return;
        }
      }
    }

    this.dropAlpha = 1.0;
    this.onDirty();
    this._setPhase('contact');

    this.dropCycleTimer = setTimeout(() => {
      this._animateSpiderwebSpread(this.activeDrop, this.config.spreadDuration);
    }, this.config.bleedDelay);
  }

  _animateDropletCondense(drop) {
    const startTime = performance.now();
    const duration = this.config.condenseDuration;
    // 2D 底墨始终在场就位，与 3D 墨珠重合，消除中途 dropAlpha 突现跳跃
    this.dropAlpha = 1.0;
    this.onDirty();
    this._setPhase('condense', { duration });

    const step = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      if (this.droplet3D) {
        this.droplet3D.setCondense(progress);
      }
      if (progress < 1.0) {
        this.activeDropRaf = safeRaf(step);
      } else {
        if (this.droplet3D) {
          this.droplet3D.setStay();
        }
        this._setPhase('stay', { duration: this.config.condenseStay });
        // 凝结饱满后保留原片充分的呼吸定格余韵 (~500ms)，随后开启向四周毛细抽吸展开
        this.dropCycleTimer = setTimeout(() => {
          this._animateSpiderwebSpread(drop, this.config.spreadDuration);
        }, this.config.condenseStay);
      }
    };
    this.activeDropRaf = safeRaf(step);
  }

  _animateSpiderwebSpread(drop, duration) {
    const startTime = performance.now();
    const totalPixels = drop.size * drop.size;
    const curData = drop.currentImgData.data;
    const finalData = drop.finalRGBA;
    const coreData = drop.coreSolidRGBA;
    const coreRatios = drop.coreRatio;
    const reachTimes = drop.reachTime;
    const webRGBA = drop.webRGBA;
    const reachBand = 0.10; // 毛细展开湿润波前渐显过渡带宽，消除像素 0->100% 阶跃硬跳
    this._setPhase('spread', { duration });

    const step = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      // 余弦 S 型平滑推进：初期静止起步（速度为0），墨丝在饱满墨点下缓慢渗透而不突兀破壳
      const smoothProgress = 0.5 - 0.5 * Math.cos(progress * Math.PI);
      // 外围毛细展开波前：初期与墨核收缩同步进行，前期速度极缓并被墨核遮盖
      const easedTime = smoothProgress;
      // 内核向心收缩曲线：同步 S 型收缩至 0.585，初期墨核饱满遮盖，中期伴随表面张力释放平滑缩进
      const shrinkFactor = 1.0 - 0.415 * smoothProgress;
      // 墨核深层纤维微孔析出：在展开后半程 (progress > 0.45) 伴生启动，消除阶段交接突变
      const coreHoleRatio = progress > 0.45
        ? (0.5 - 0.5 * Math.cos(((progress - 0.45) / 0.55) * Math.PI)) * 0.4
        : 0.0;

      for (let i = 0; i < totalPixels; i++) {
        const t = reachTimes[i];
        const idx = i * 4;

        // 1. 外围毛细蛛网向外伸展：带有波前透明度软淡入 (Soft Wet Front)，绝不突变跳出
        if (t < 900.0) {
          if (t <= easedTime - reachBand) {
            curData[idx] = finalData[idx];
            curData[idx + 1] = finalData[idx + 1];
            curData[idx + 2] = finalData[idx + 2];
            curData[idx + 3] = finalData[idx + 3];
          } else if (t < easedTime) {
            const frontRatio = (easedTime - t) / reachBand;
            curData[idx] = finalData[idx];
            curData[idx + 1] = finalData[idx + 1];
            curData[idx + 2] = finalData[idx + 2];
            curData[idx + 3] = Math.round(finalData[idx + 3] * frontRatio);
          }
        }

        // 2. 中心墨核向内收缩与深层纤维微孔伴生：实心纯黑平滑显露出网孔纤维
        if (coreData && coreData[idx + 3] > 0) {
          const cRatio = coreRatios ? coreRatios[i] : 0.0;
          if (cRatio <= shrinkFactor) {
            // 仍在收缩后内核内部：伴随 coreHoleRatio 微妙析出微孔纤维，杜绝死黑与突变
            if (coreHoleRatio > 0 && webRGBA) {
              curData[idx] = Math.round(coreData[idx] * (1.0 - coreHoleRatio) + webRGBA[idx] * coreHoleRatio);
              curData[idx + 1] = Math.round(coreData[idx + 1] * (1.0 - coreHoleRatio) + webRGBA[idx + 1] * coreHoleRatio);
              curData[idx + 2] = Math.round(coreData[idx + 2] * (1.0 - coreHoleRatio) + webRGBA[idx + 2] * coreHoleRatio);
              curData[idx + 3] = Math.round(coreData[idx + 3] * (1.0 - coreHoleRatio) + webRGBA[idx + 3] * coreHoleRatio);
            } else {
              curData[idx] = coreData[idx];
              curData[idx + 1] = coreData[idx + 1];
              curData[idx + 2] = coreData[idx + 2];
              curData[idx + 3] = coreData[idx + 3];
            }
          } else if (cRatio < shrinkFactor + 0.22) {
            // 收缩边缘软化过渡带：实心纯黑向抽吸后微孔蛛网渐变
            const blend = (cRatio - shrinkFactor) / 0.22;
            curData[idx] = Math.round(coreData[idx] * (1 - blend) + finalData[idx] * blend);
            curData[idx + 1] = Math.round(coreData[idx + 1] * (1 - blend) + finalData[idx + 1] * blend);
            curData[idx + 2] = Math.round(coreData[idx + 2] * (1 - blend) + finalData[idx + 2] * blend);
            curData[idx + 3] = Math.round(coreData[idx + 3] * (1 - blend) + finalData[idx + 3] * blend);
          } else {
            // 已完全退让出的外圈区域：展现为被抽吸后的网孔纤维纹理
            curData[idx] = finalData[idx];
            curData[idx + 1] = finalData[idx + 1];
            curData[idx + 2] = finalData[idx + 2];
            curData[idx + 3] = finalData[idx + 3];
          }
        }
      }

      // 3D 墨珠伴随外围毛细抽吸蔓延，同步平缓沉降消褪并向心等比收敛
      if (this.droplet3D && this.droplet3D.mesh && this.droplet3D.mesh.visible) {
        this.droplet3D.setAbsorb(progress);
      }

      drop.ctx.putImageData(drop.currentImgData, 0, 0);
      this.onDirty();

      if (progress < 1.0) {
        this.activeDropRaf = safeRaf(step);
      } else {
        this.activeDropRaf = null;
        // 展开与消融无缝顺滑接力
        this._animateSpiderwebDissolve(drop, this.config.dissolveDuration);
      }
    };

    this.activeDropRaf = safeRaf(step);
  }

  _animateSpiderwebDissolve(drop, duration) {
    const startTime = performance.now();
    const totalPixels = drop.size * drop.size;
    const curData = drop.currentImgData.data;
    // 捕获展开结束那一帧的真实像素快照，以此为演化基准，保持零跳变连续
    const spreadEndData = new Uint8ClampedArray(curData);
    const webRGBA = drop.webRGBA;
    this._setPhase('dissolve', { duration });

    const step = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1.0);

      if (progress < 0.45) {
        // 第一阶段 (0.0 ~ 0.45)：实心墨核平滑掏空演化至全域 Voronoi 蛛网骨架
        const pWeb = progress / 0.45;
        // 余弦平滑缓动：开始柔和接力掏空，平顺演进至完全纯蛛网骨架
        const easeWeb = 0.5 - 0.5 * Math.cos(pWeb * Math.PI);

        // 3D 墨珠在掏空前半程柔和隐退归零，消除视觉突兀灭失
        if (this.droplet3D && this.droplet3D.mesh && this.droplet3D.mesh.visible) {
          const dropAlphaRemaining = Math.max(0, 1.0 - pWeb);
          this.droplet3D.material.opacity = dropAlphaRemaining * 0.15;
          if (dropAlphaRemaining <= 0.01) {
            this.droplet3D.hide();
          }
        }

        for (let i = 0; i < totalPixels; i++) {
          const idx = i * 4;
          const startAlpha = spreadEndData[idx + 3];
          const targetAlpha = webRGBA ? webRGBA[idx + 3] : 0;
          if (startAlpha === 0 && targetAlpha === 0) continue;

          // 核心区域平滑过渡到微孔交织网
          curData[idx] = Math.round(spreadEndData[idx] * (1.0 - easeWeb) + (webRGBA ? webRGBA[idx] : spreadEndData[idx]) * easeWeb);
          curData[idx + 1] = Math.round(spreadEndData[idx + 1] * (1.0 - easeWeb) + (webRGBA ? webRGBA[idx + 1] : spreadEndData[idx + 1]) * easeWeb);
          curData[idx + 2] = Math.round(spreadEndData[idx + 2] * (1.0 - easeWeb) + (webRGBA ? webRGBA[idx + 2] : spreadEndData[idx + 2]) * easeWeb);
          curData[idx + 3] = Math.round(startAlpha * (1.0 - easeWeb) + targetAlpha * easeWeb);
        }
      } else {
        if (this.droplet3D && this.droplet3D.mesh && this.droplet3D.mesh.visible) {
          this.droplet3D.hide();
        }

        // 第二阶段 (0.45 ~ 1.0)：完整蛛网结构保持整体连通性，全域同步淡化消失并伴随微暖调褪色
        const pFade = (progress - 0.45) / 0.55;
        // 余弦平滑淡化，柔和收尾
        const easeFade = 0.5 - 0.5 * Math.cos(pFade * Math.PI);
        const remainAlphaFactor = 1.0 - easeFade;

        for (let i = 0; i < totalPixels; i++) {
          const idx = i * 4;
          const baseAlpha = webRGBA ? webRGBA[idx + 3] : spreadEndData[idx + 3];
          if (baseAlpha === 0) continue;

          // 软着色器淡化：向纸浆茶褐色微褪色
          const baseR = webRGBA ? webRGBA[idx] : spreadEndData[idx];
          const baseG = webRGBA ? webRGBA[idx + 1] : spreadEndData[idx + 1];
          const baseB = webRGBA ? webRGBA[idx + 2] : spreadEndData[idx + 2];
          const warmFade = easeFade * 0.35;

          curData[idx] = Math.min(255, Math.round(baseR + warmFade * 40));
          curData[idx + 1] = Math.min(255, Math.round(baseG + warmFade * 28));
          curData[idx + 2] = Math.min(255, Math.round(baseB + warmFade * 18));
          curData[idx + 3] = Math.round(baseAlpha * remainAlphaFactor);
        }
      }

      drop.ctx.putImageData(drop.currentImgData, 0, 0);

      // 全局 dropAlpha 在淡化末尾兜底归零
      if (progress > 0.92) {
        this.dropAlpha = Math.max(0, 1.0 - (progress - 0.92) / 0.08);
      }

      this.onDirty();

      if (progress < 1) {
        this.activeDropRaf = safeRaf(step);
      } else {
        this.activeDropRaf = null;
        this.activeDrop = null;
        if (this.isEnabled) {
          this._setPhase('interval', { duration: this.config.interval });
          this.dropCycleTimer = setTimeout(() => {
            this._spawnSingleDrop();
          }, this.config.interval);
        } else {
          this._setPhase('idle');
        }
      }
    };

    this.activeDropRaf = safeRaf(step);
  }
}
