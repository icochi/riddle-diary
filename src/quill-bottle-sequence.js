/**
 * 瓶口磁吸捕获与双连蘸墨时序状态机深模块 (QuillBottleSequence)
 *
 * 领域职责：
 * 1. 瓶口磁吸滞后捕获 (Bottle Hover Trap)：两级防抖半径判定 (进入 0.24m / 退出 0.38m)；
 * 2. 交互状态门控：书本上方与合书态绝对禁止捕获，防误触防抖；
 * 3. 双连蘸墨时序 (Rapid Double-Dip)：锁定光标脱扣判定，连续两次深入瓶颈下潜 (185mm)；
 * 4. 零 DOM、零 WebGL 依赖：纯时间步长与距离驱动，方便轻量化单元测试。
 */
export class QuillBottleSequence {
  /**
   * @param {Object} [options]
   * @param {number} [options.trapRadiusIn=0.24] 进入磁吸捕获半径 (米)
   * @param {number} [options.trapRadiusOut=0.38] 脱离磁吸捕获半径 (米)
   * @param {number} [options.dipDuration=0.70] 双连蘸墨总时长 (秒)
   * @param {number} [options.dipDepth=0.185] 下潜深度 (米)
   */
  constructor(options = {}) {
    this.trapRadiusIn = options.trapRadiusIn ?? 0.24;
    this.trapRadiusOut = options.trapRadiusOut ?? 0.38;
    this.dipDuration = options.dipDuration ?? 0.70;
    this.dipDepth = options.dipDepth ?? 0.185;

    this.isTrapped = false;
    this.isDipping = false;
    this.dipTimer = 0.0;
    this.onDipComplete = null;
  }

  /**
   * 触发快速双连蘸墨
   * @param {Function} [onComplete]
   */
  triggerDoubleDip(onComplete = null) {
    this.isTrapped = true;
    this.isDipping = true;
    this.dipTimer = 0.0;
    this.onDipComplete = onComplete;
  }

  /**
   * 计算双连蘸墨下潜位移 (沿瓶口垂直中心向下深入瓶颈)
   * @param {number} t
   * @returns {number}
   */
  computeDipOffset(t = this.dipTimer) {
    if (t < 0 || t > this.dipDuration || (t > 0.30 && t <= 0.35)) return 0;
    const p = t <= 0.30 ? t / 0.30 : (t - 0.35) / (this.dipDuration - 0.35);
    return Math.sin(p * Math.PI) * this.dipDepth;
  }

  /**
   * 步进状态机
   * @param {Object} params
   * @param {number} params.dt 帧耗时 (秒)
   * @param {number} params.distToLip 水平距离 (米)
   * @param {boolean} params.isOverBook 是否在书本上方
   * @param {boolean} params.canTrap 是否允许捕获 (处于跟随或拔出状态)
   * @param {boolean} [params.freezeFollow=false] 是否冻结跟随
   * @returns {{ isTrapped: boolean, isDipping: boolean, dipOffset: number }}
   */
  update({ dt, distToLip, isOverBook, canTrap, freezeFollow = false }) {
    // 1. 蘸墨动画计时器更新
    if (this.isDipping) {
      this.dipTimer += dt;
      if (this.dipTimer >= this.dipDuration) {
        this.dipTimer = 0.0;
        this.isDipping = false;
        // 蘸墨完成后仍保持 isTrapped = true，停留在瓶口悬停位
        if (this.onDipComplete) {
          const cb = this.onDipComplete;
          this.onDipComplete = null;
          cb();
        }
      }
    }

    // 2. 磁吸滞后判定
    if (canTrap) {
      if (this.isDipping) {
        this.isTrapped = true;
      } else if (!freezeFollow) {
        if (isOverBook) {
          this.isTrapped = false;
        } else if (!this.isTrapped) {
          if (distToLip <= this.trapRadiusIn) {
            this.isTrapped = true;
          }
        } else {
          if (distToLip >= this.trapRadiusOut) {
            this.isTrapped = false;
          }
        }
      }
    } else {
      this.isTrapped = false;
    }

    const dipOffset = this.isDipping ? this.computeDipOffset() : 0;
    return {
      isTrapped: this.isTrapped,
      isDipping: this.isDipping,
      dipOffset,
    };
  }
}
