/**
 * 双页消融显影着色器驱动器深模块 (InkDissolveDriver)
 *
 * 职责：
 * 1. 统一持有并管理 GPU 着色器消融 Uniform (textDissolve, leftTextDissolve, leftEmergingYRange)；
 * 2. 封装右页文字消融/显影、左页单条显影、双页同时吸干与左页整页复显的非线性缓动与 RAF 调度；
 * 3. 严格仲裁动画单一归属（Right 通道、Left 通道与全局双页 Full 通道互斥），彻底消除取消句柄散落与踩踏；
 * 4. 解耦时钟环境，支持外部虚拟时钟注入进行微秒级纯单元测试；
 * 5. 确保任何动画被中断、取消或正常完成时，着色器 Uniform 状态与外部贴图必定确定性复位。
 */

export class InkDissolveDriver {
  /**
   * @param {Object} [options]
   * @param {Object} [options.uniforms] 注入外部 uniform 或由内部自主创建
   * @param {{ value: number }} [options.uniforms.textDissolve]
   * @param {{ value: number }} [options.uniforms.leftTextDissolve]
   * @param {{ value: { x: number, y: number, set: (x: number, y: number) => void } }} [options.uniforms.leftEmergingYRange]
   * @param {{ now: () => number, requestFrame: (fn: Function) => any, cancelFrame: (handle: any) => void }} [options.clock]
   * @param {Object} [options.renderPort]
   * @param {() => void} [options.renderPort.onRightPageRedraw] 右页贴图局部重绘
   * @param {() => void} [options.renderPort.onFullRedraw] 整张双页贴图重绘
   */
  constructor(options = {}) {
    const rawUniforms = options.uniforms || {};
    this.textDissolve = rawUniforms.textDissolve || { value: 0.0 };
    this.leftTextDissolve = rawUniforms.leftTextDissolve || { value: 0.0 };
    this.leftEmergingYRange = rawUniforms.leftEmergingYRange || {
      value: {
        x: -1.0,
        y: -1.0,
        set(x, y) {
          this.x = x;
          this.y = y;
        },
      },
    };

    // 时钟抽象：安全绑定 requestAnimationFrame 与 performance.now
    if (options.clock) {
      this.clock = options.clock;
    } else {
      const getRaf = () => {
        if (typeof requestAnimationFrame !== 'undefined') {
          return (fn) => requestAnimationFrame(fn);
        }
        return (fn) => setTimeout(() => fn(Date.now()), 16);
      };
      const getCaf = () => {
        if (typeof cancelAnimationFrame !== 'undefined') {
          return (h) => cancelAnimationFrame(h);
        }
        return (h) => clearTimeout(h);
      };
      const getNow = () => {
        if (typeof performance !== 'undefined' && performance.now) {
          return () => performance.now();
        }
        return () => Date.now();
      };
      this.clock = {
        now: getNow(),
        requestFrame: getRaf(),
        cancelFrame: getCaf(),
      };
    }

    this.renderPort = options.renderPort || {};

    // 内部通道活跃取消句柄（全收敛在内部，严禁向外泄露）
    this._rightCancel = null;
    this._leftCancel = null;
    this._fullCancel = null;
  }

  get isRightBusy() {
    return Boolean(this._rightCancel || this._fullCancel);
  }

  get isLeftBusy() {
    return Boolean(this._leftCancel || this._fullCancel);
  }

  get isFullBusy() {
    return Boolean(this._fullCancel);
  }

  /**
   * 中止所有正在执行的消融与显影动画，并重置 Uniform
   */
  cancelAll() {
    if (this._rightCancel) {
      this._rightCancel();
      this._rightCancel = null;
    }
    if (this._leftCancel) {
      this._leftCancel();
      this._leftCancel = null;
    }
    if (this._fullCancel) {
      this._fullCancel();
      this._fullCancel = null;
    }
    this.textDissolve.value = 0.0;
    this.leftTextDissolve.value = 0.0;
    this.leftEmergingYRange.value.set(-1.0, -1.0);
  }

  /**
   * 取消当前右页动画
   */
  cancelRight() {
    if (this._rightCancel) {
      this._rightCancel();
      this._rightCancel = null;
    }
  }

  /**
   * 取消当前左页动画
   */
  cancelLeft() {
    if (this._leftCancel) {
      this._leftCancel();
      this._leftCancel = null;
    }
  }

  /**
   * 右页文字消融 (Erosion): 缓入快出，文字吸干入纸背
   * @param {number} duration 毫秒
   * @param {Function} [onComplete]
   * @param {boolean} [redrawOnFinish=true] 动画完成时是否自动调用右页重绘端口
   * @returns {() => void} 取消函数
   */
  dissolveRight(duration, onComplete = null, redrawOnFinish = true) {
    this.cancelRight();
    if (this._fullCancel) {
      this._fullCancel();
      this._fullCancel = null;
    }

    this.textDissolve.value = 0.0;
    const startTime = this.clock.now();
    let frameId = null;
    let finished = false;

    const step = (now) => {
      if (finished) return;
      const elapsed = (now || this.clock.now()) - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      // 缓入快出：progress^2
      const ease = progress * progress;
      this.textDissolve.value = ease;

      if (progress < 1.0) {
        frameId = this.clock.requestFrame(step);
      } else {
        finished = true;
        this.textDissolve.value = 0.0;
        this._rightCancel = null;
        if (redrawOnFinish && this.renderPort.onRightPageRedraw) {
          this.renderPort.onRightPageRedraw();
        }
        if (onComplete) onComplete();
      }
    };

    frameId = this.clock.requestFrame(step);

    const cancel = () => {
      if (finished) return;
      finished = true;
      if (frameId) this.clock.cancelFrame(frameId);
      this.textDissolve.value = 0.0;
      this._rightCancel = null;
      if (this.renderPort.onRightPageRedraw) {
        this.renderPort.onRightPageRedraw();
      }
    };

    this._rightCancel = cancel;
    return cancel;
  }

  /**
   * 右页文字显影 (Emergence): 快出缓入，墨水反向毛细析出凝结
   * @param {number} duration 毫秒
   * @param {Function} [onComplete]
   * @param {boolean} [redraw=true] 是否在显影初始时调用右页重绘端口
   * @returns {() => void} 取消函数
   */
  emergeRight(duration, onComplete = null, redraw = true) {
    this.cancelRight();
    if (this._fullCancel) {
      this._fullCancel();
      this._fullCancel = null;
    }

    // 显影前预先置为完全消融态 1.0 并绘制静态字迹
    this.textDissolve.value = 1.0;
    if (redraw && this.renderPort.onRightPageRedraw) {
      this.renderPort.onRightPageRedraw();
    }

    const startTime = this.clock.now();
    let frameId = null;
    let finished = false;

    const step = (now) => {
      if (finished) return;
      const elapsed = (now || this.clock.now()) - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      // 快出缓入：1 - (1 - progress)^2
      const ease = 1.0 - (1.0 - progress) * (1.0 - progress);
      this.textDissolve.value = 1.0 - ease;

      if (progress < 1.0) {
        frameId = this.clock.requestFrame(step);
      } else {
        finished = true;
        this.textDissolve.value = 0.0;
        this._rightCancel = null;
        if (onComplete) onComplete();
      }
    };

    frameId = this.clock.requestFrame(step);

    const cancel = () => {
      if (finished) return;
      finished = true;
      if (frameId) this.clock.cancelFrame(frameId);
      this.textDissolve.value = 0.0;
      this._rightCancel = null;
      if (this.renderPort.onRightPageRedraw) {
        this.renderPort.onRightPageRedraw();
      }
    };

    this._rightCancel = cancel;
    return cancel;
  }

  /**
   * 预设左页新增条目消融态，防止绘制时产生单帧白闪
   * @param {{ yMinNorm: number, yMaxNorm: number } | null} boundInfo
   */
  prepareLeftItem(boundInfo) {
    this.cancelLeft();
    if (!boundInfo) {
      this.leftTextDissolve.value = 0.0;
      this.leftEmergingYRange.value.set(-1.0, -1.0);
      return;
    }
    this.leftEmergingYRange.value.set(boundInfo.yMinNorm, boundInfo.yMaxNorm);
    this.leftTextDissolve.value = 1.0;
  }

  /**
   * 左页新增历史项反向毛细显影
   * @param {{ yMinNorm: number, yMaxNorm: number } | null} boundInfo
   * @param {number} duration 毫秒
   * @param {Function} [onComplete]
   * @returns {() => void} 取消函数
   */
  emergeLeftItem(boundInfo, duration, onComplete = null) {
    this.cancelLeft();
    if (!boundInfo) {
      this.leftTextDissolve.value = 0.0;
      this.leftEmergingYRange.value.set(-1.0, -1.0);
      if (onComplete) onComplete();
      return () => {};
    }

    this.leftEmergingYRange.value.set(boundInfo.yMinNorm, boundInfo.yMaxNorm);
    this.leftTextDissolve.value = 1.0;

    const startTime = this.clock.now();
    let frameId = null;
    let finished = false;

    const step = (now) => {
      if (finished) return;
      const elapsed = (now || this.clock.now()) - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      const ease = 1.0 - (1.0 - progress) * (1.0 - progress);
      this.leftTextDissolve.value = 1.0 - ease;

      if (progress < 1.0) {
        frameId = this.clock.requestFrame(step);
      } else {
        finished = true;
        this.leftTextDissolve.value = 0.0;
        this.leftEmergingYRange.value.set(-1.0, -1.0);
        this._leftCancel = null;
        if (onComplete) onComplete();
      }
    };

    frameId = this.clock.requestFrame(step);

    const cancel = () => {
      if (finished) return;
      finished = true;
      if (frameId) this.clock.cancelFrame(frameId);
      this.leftTextDissolve.value = 0.0;
      this.leftEmergingYRange.value.set(-1.0, -1.0);
      this._leftCancel = null;
    };

    this._leftCancel = cancel;
    return cancel;
  }

  /**
   * 左页指定条目/行区域局部消融吸干 (Dissolution)
   * @param {{ yMinNorm: number, yMaxNorm: number } | null} boundInfo
   * @param {number} duration 毫秒
   * @param {Function} [onComplete]
   * @returns {() => void} 取消函数
   */
  dissolveLeftItem(boundInfo, duration, onComplete = null) {
    this.cancelLeft();
    if (!boundInfo) {
      this.leftTextDissolve.value = 0.0;
      this.leftEmergingYRange.value.set(-1.0, -1.0);
      if (onComplete) onComplete();
      return () => {};
    }

    this.leftEmergingYRange.value.set(boundInfo.yMinNorm, boundInfo.yMaxNorm);
    this.leftTextDissolve.value = 0.0;

    const startTime = this.clock.now();
    let frameId = null;
    let finished = false;

    const step = (now) => {
      if (finished) return;
      const elapsed = (now || this.clock.now()) - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      const ease = progress * progress;
      this.leftTextDissolve.value = ease;

      if (progress < 1.0) {
        frameId = this.clock.requestFrame(step);
      } else {
        finished = true;
        this.leftTextDissolve.value = 1.0;
        this._leftCancel = null;
        if (onComplete) onComplete();
      }
    };

    frameId = this.clock.requestFrame(step);

    const cancel = () => {
      if (finished) return;
      finished = true;
      if (frameId) this.clock.cancelFrame(frameId);
      this.leftTextDissolve.value = 0.0;
      this.leftEmergingYRange.value.set(-1.0, -1.0);
      this._leftCancel = null;
    };

    this._leftCancel = cancel;
    return cancel;
  }

  /**
   * 换页复显：左右双页同时吸干消融
   * @param {number} duration 毫秒
   * @param {Function} [onComplete]
   * @returns {() => void} 取消函数
   */
  dissolveBothPages(duration, onComplete = null) {
    this.cancelAll();

    this.leftEmergingYRange.value.set(-1.0, -1.0);
    this.textDissolve.value = 0.0;
    this.leftTextDissolve.value = 0.0;

    const startTime = this.clock.now();
    let frameId = null;
    let finished = false;

    const step = (now) => {
      if (finished) return;
      const elapsed = (now || this.clock.now()) - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      const ease = progress * progress;
      this.textDissolve.value = ease;
      this.leftTextDissolve.value = ease;

      if (progress < 1.0) {
        frameId = this.clock.requestFrame(step);
      } else {
        finished = true;
        this._fullCancel = null;
        this.textDissolve.value = 0.0;
        this.leftTextDissolve.value = 1.0;
        if (onComplete) onComplete();
      }
    };

    frameId = this.clock.requestFrame(step);

    const cancel = () => {
      if (finished) return;
      finished = true;
      if (frameId) this.clock.cancelFrame(frameId);
      this._fullCancel = null;
      this.textDissolve.value = 0.0;
      this.leftTextDissolve.value = 0.0;
    };

    this._fullCancel = cancel;
    return cancel;
  }

  /**
   * 左页历史索引整页消融吸干 (Full Left Page Dissolution)
   * 用于新会话首问立项或条目重排位移时，将整页旧索引平滑吸干入纸背
   * @param {number} duration 毫秒
   * @param {Function} [onComplete]
   * @returns {() => void} 取消函数
   */
  dissolveLeftHistory(duration, onComplete = null) {
    this.cancelLeft();

    this.leftEmergingYRange.value.set(-1.0, -1.0);
    this.leftTextDissolve.value = 0.0;

    const startTime = this.clock.now();
    let frameId = null;
    let finished = false;

    const step = (now) => {
      if (finished) return;
      const elapsed = (now || this.clock.now()) - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      const ease = progress * progress;
      this.leftTextDissolve.value = ease;

      if (progress < 1.0) {
        frameId = this.clock.requestFrame(step);
      } else {
        finished = true;
        this.leftTextDissolve.value = 1.0;
        this._leftCancel = null;
        if (onComplete) onComplete();
      }
    };

    frameId = this.clock.requestFrame(step);

    const cancel = () => {
      if (finished) return;
      finished = true;
      if (frameId) this.clock.cancelFrame(frameId);
      this.leftTextDissolve.value = 0.0;
      this.leftEmergingYRange.value.set(-1.0, -1.0);
      this._leftCancel = null;
    };

    this._leftCancel = cancel;
    return cancel;
  }

  /**
   * 换页复显：左页历史索引整页反向毛细显影
   * @param {number} duration 毫秒
   * @param {Function} [onComplete]
   * @returns {() => void} 取消函数
   */
  emergeLeftHistory(duration, onComplete = null) {
    if (this._leftCancel) {
      this._leftCancel();
      this._leftCancel = null;
    }
    if (this._fullCancel) {
      this._fullCancel();
      this._fullCancel = null;
    }

    this.leftEmergingYRange.value.set(-1.0, -1.0);
    this.leftTextDissolve.value = 1.0;

    const startTime = this.clock.now();
    let frameId = null;
    let finished = false;

    const step = (now) => {
      if (finished) return;
      const elapsed = (now || this.clock.now()) - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      const ease = 1.0 - (1.0 - progress) * (1.0 - progress);
      this.leftTextDissolve.value = 1.0 - ease;

      if (progress < 1.0) {
        frameId = this.clock.requestFrame(step);
      } else {
        finished = true;
        this._leftCancel = null;
        this.leftTextDissolve.value = 0.0;
        if (onComplete) onComplete();
      }
    };

    frameId = this.clock.requestFrame(step);

    const cancel = () => {
      if (finished) return;
      finished = true;
      if (frameId) this.clock.cancelFrame(frameId);
      this._leftCancel = null;
      this.leftTextDissolve.value = 0.0;
    };

    this._leftCancel = cancel;
    return cancel;
  }

  /**
   * 换页复显 / 切换 Session：双页文字同时整页反向毛细显影
   * @param {number} duration 毫秒
   * @param {boolean} [emergeRightPage=true] 是否同时显影右页草稿（若右页无字则只显影左页）
   * @param {Function} [onComplete]
   * @returns {() => void} 取消函数
   */
  emergeBothPages(duration, emergeRightPage = true, onComplete = null) {
    this.cancelAll();

    this.leftEmergingYRange.value.set(-1.0, -1.0);
    this.leftTextDissolve.value = 1.0;
    if (emergeRightPage) {
      this.textDissolve.value = 1.0;
    } else {
      this.textDissolve.value = 0.0;
    }

    if (this.renderPort.onRightPageRedraw) {
      this.renderPort.onRightPageRedraw();
    }

    const startTime = this.clock.now();
    let frameId = null;
    let finished = false;

    const step = (now) => {
      if (finished) return;
      const elapsed = (now || this.clock.now()) - startTime;
      const progress = Math.min(elapsed / duration, 1.0);
      const ease = 1.0 - (1.0 - progress) * (1.0 - progress);
      const dissolveVal = 1.0 - ease;

      this.leftTextDissolve.value = dissolveVal;
      if (emergeRightPage) {
        this.textDissolve.value = dissolveVal;
      }

      if (progress < 1.0) {
        frameId = this.clock.requestFrame(step);
      } else {
        finished = true;
        this._fullCancel = null;
        this.leftTextDissolve.value = 0.0;
        this.textDissolve.value = 0.0;
        if (onComplete) onComplete();
      }
    };

    frameId = this.clock.requestFrame(step);

    const cancel = () => {
      if (finished) return;
      finished = true;
      if (frameId) this.clock.cancelFrame(frameId);
      this._fullCancel = null;
      this.leftTextDissolve.value = 0.0;
      this.textDissolve.value = 0.0;
      if (this.renderPort.onRightPageRedraw) {
        this.renderPort.onRightPageRedraw();
      }
    };

    this._fullCancel = cancel;
    return cancel;
  }
}

