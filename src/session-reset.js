/**
 * 会话转场时序调度器 (SessionTransitionSequence)
 *
 * 职责：把"新建会话换页复显"与"切换历史会话"这两条生命周期统一收拢为纯领域状态机。
 * 流程：dissolving（双页同时吸干）→ gating（放行换纸）→ turning（单页立体翻飞：前进/回溯）
 *      → settling（落定静置与纸面更新）→ emerging（双页文字反向毛细显影）→ idle。
 * 零 DOM、零 WebGL：所有视效经 exec 回调外置，时钟与延时完全注入，
 * 因此所有状态与耗时均可在假时钟单元测试中精准断言。
 */

/**
 * 会话世代 (SessionEpoch)
 *
 * 换页转场即宣告上一代会话终结：上一代里排在动画回调、延时器与后台回复之后的所有演出，
 * 落地前先比对世代号，不符就自行作废。`guard(fn)` 在**注册时刻**捕获世代号，
 * 因此迟到一次的旧回复永远不可能写在新纸上。
 */
export class SessionEpoch {
  constructor() {
    this.value = 0;
  }

  advance() {
    return ++this.value;
  }

  guard(fn) {
    if (arguments.length !== 1) {
      throw new TypeError('guard() 只包装回调，不接受延时参数');
    }
    const born = this.value;
    return (...args) => (born === this.value ? fn(...args) : undefined);
  }
}

export class SessionTransitionSequence {
  /**
   * @param {Object} options
   * @param {{ now: () => number, schedule: (fn: Function, ms: number) => any, cancel: (handle: any) => void }} options.clock
   * @param {{ dissolveMs: number, settlePauseMs: number, emergeMs: number }} options.timings
   * @param {Object} options.exec 纸面与舞台执行器
   */
  constructor({ clock, timings, exec }) {
    this.clock = clock;
    this.timings = timings;
    this.exec = exec;
    this.phase = 'idle';
    this.direction = 'forward'; // 'forward' (左向右) | 'backward' (右向左)
    this.hasInk = true;
    this._gateOpen = false;
    this._swapped = false;
    this._timers = [];
  }

  get isActive() {
    return this.phase !== 'idle';
  }

  /**
   * 开启一次会话转场
   * @param {Object|boolean} [paramsOrHasInk={}] 若传布尔值，兼容旧版 begin(hasInk) 签名
   * @param {'forward'|'backward'} [paramsOrHasInk.direction='forward'] 翻页方向
   * @param {boolean} [paramsOrHasInk.hasInk=true] 纸面是否有墨可吸；全空时整段退化为只演换纸
   * @param {boolean} [paramsOrHasInk.requiresGate=false] 是否需要门控（如新建 session 等待蘸墨落定）
   * @returns {boolean} 是否受理（转场进行中一律拒绝）
   */
  begin(paramsOrHasInk = {}) {
    if (this.isActive) return false;

    let direction = 'forward';
    let hasInk = true;
    let requiresGate = false;

    if (typeof paramsOrHasInk === 'boolean') {
      hasInk = paramsOrHasInk;
      requiresGate = true; // 旧版 session-reset 默认等待蘸墨门控
    } else if (paramsOrHasInk && typeof paramsOrHasInk === 'object') {
      if (paramsOrHasInk.direction) direction = paramsOrHasInk.direction;
      if (paramsOrHasInk.hasInk !== undefined) hasInk = paramsOrHasInk.hasInk;
      if (paramsOrHasInk.requiresGate !== undefined) requiresGate = paramsOrHasInk.requiresGate;
    }

    this.direction = direction;
    this.hasInk = hasInk;
    this._gateOpen = !requiresGate;
    this._swapped = false;
    this.exec.cancelInflight();

    if (hasInk) {
      this._enter('dissolving');
      if (this.exec.onTransitionStart) {
        this.exec.onTransitionStart();
      }
      this.exec.dissolvePages(this.timings.dissolveMs, () => {
        this._prepareSwap();
        this._requestLeaf();
      });
    } else {
      if (this.exec.onTransitionStart) {
        this.exec.onTransitionStart();
      }
      this._requestLeaf();
    }
    return true;
  }

  /**
   * 放行翻页门控（如蘸墨落定完成）
   */
  openLeafGate() {
    this._gateOpen = true;
    if (this.phase === 'gating') {
      this._startLeaf();
    }
  }

  /**
   * 立即推进到终态（合书出口）：所有阶段不再演出，纸面直接落到位
   */
  abort() {
    this._clearTimers();
    const wasActive = this.isActive;
    this._enter('idle');
    if (wasActive) {
      if (this.exec.onTransitionEnd) {
        this.exec.onTransitionEnd();
      }
      this.exec.settleAtOnce();
    }
  }

  _requestLeaf() {
    if (!this._gateOpen) {
      this._enter('gating');
      return;
    }
    this._startLeaf();
  }

  _startLeaf() {
    this._prepareSwap();
    this._enter('turning');
    const doneCb = () => this._onLeafSettled();
    // 兼容 playLeaf(done) 与 playLeaf({ direction }, done)
    if (this.exec.playLeaf.length >= 2) {
      this.exec.playLeaf({ direction: this.direction }, doneCb);
    } else {
      this.exec.playLeaf(doneCb);
    }
  }

  _prepareSwap() {
    if (this._swapped) return;
    this._swapped = true;
    if (this.exec.prepareSwap) {
      this.exec.prepareSwap();
    } else if (this.exec.blankRightPage) {
      this.exec.blankRightPage();
    }
  }

  _onLeafSettled() {
    if (this.phase !== 'turning') return;
    this.exec.unlockInput();
    this._enter('settling');
    if (!this.hasInk) {
      this._finish();
      return;
    }
    this._schedule(() => {
      this._enter('emerging');
      const doneCb = () => this._finish();
      if (this.exec.emergePages) {
        this.exec.emergePages(this.timings.emergeMs, doneCb);
      } else if (this.exec.emergeLeftHistory) {
        this.exec.emergeLeftHistory(this.timings.emergeMs, doneCb);
      } else {
        doneCb();
      }
    }, this.timings.settlePauseMs);
  }

  _finish() {
    this._enter('idle');
    if (this.exec.onTransitionEnd) {
      this.exec.onTransitionEnd();
    }
  }

  _enter(phase) {
    this.phase = phase;
  }

  _schedule(fn, ms) {
    const handle = this.clock.schedule(() => {
      this._timers = this._timers.filter((h) => h !== handle);
      fn();
    }, ms);
    this._timers.push(handle);
  }

  _clearTimers() {
    for (const handle of this._timers) this.clock.cancel(handle);
    this._timers = [];
  }
}
