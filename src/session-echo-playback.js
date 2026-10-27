/**
 * 历史会话流式回响调度器深模块 (SessionEchoPlayback)
 *
 * 职责：
 * 1. 切换历史 Session 时，在双页承载历史对话消息的流式反显、延时与消融；
 * 2. 动态测算消息折行高度，并支持单条长消息跨页（左页底部接右页顶部）切分；
 * 3. 严格遵循时序步进（比上一条晚 200ms 显示）与生命周期（反显 + 延时 + 消融）；
 * 4. 第二轮循环覆盖时，实施垂直区间几何碰撞检测与消融等待门控（等目标位置文字消融完毕）；
 * 5. 抽象时钟与渲染端口，支持纯虚拟时钟与 Node 内存测试；支持任意时刻即时打断与终态收束。
 */

export const DEFAULT_ECHO_CONFIG = {
  emergeDuration: 800,    // 单条消息反显时长 (ms，舒缓毛细渗透)
  stayDuration: 1800,     // 单条消息饱满定格停留时长 (ms，从容可读)
  dissolveDuration: 800,  // 单条消息吸干消融时长 (ms，柔和渐隐)
  staggerMs: 800,         // 下一条消息延迟启动步进 (ms，接续浮现避免堆叠冲刷)
  lineHeight: 44,         // 标准行高 (px)
  paragraphSpacing: 14,   // 消息段落间距 (px)
  paddingTop: 12,         // 版心顶部安全留白 (px)
  paddingBottom: 12,      // 版心底部安全留白 (px)
};

/**
 * 平滑缓动函数 (Quad Ease In-Out)
 * @param {number} t 归一化时间 (0~1)
 * @returns {number}
 */
export function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * 测算并分割历史消息列表为多页排版片段
 * @param {Array<{ role: 'user'|'ai', text: string }>} messages
 * @param {Object} options
 * @param {{ x: number, y: number, w: number, h: number }} options.leftPage
 * @param {{ x: number, y: number, w: number, h: number }} options.rightPage
 * @param {(text: string, maxWidth: number) => Array<string>} options.wrapText
 * @param {typeof DEFAULT_ECHO_CONFIG} [options.config]
 * @returns {Array<{ index: number, role: string, text: string, fragments: Array<{ page: 'left'|'right', round: number, x: number, y: number, w: number, h: number, lines: Array<string> }> }>}
 */
export function layoutEchoMessages(messages, { leftPage, rightPage, wrapText, config = DEFAULT_ECHO_CONFIG }) {
  if (!messages || messages.length === 0) return [];

  const lineH = config.lineHeight;
  const spacing = config.paragraphSpacing;

  let curPage = 'left';
  let curRound = 0;
  let curPageRect = leftPage;
  let curY = curPageRect.y + config.paddingTop;
  const bottomLimit = () => curPageRect.y + curPageRect.h - config.paddingBottom;

  const result = [];

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const msg = messages[mIdx];
    const maxW = curPageRect.w - 20;
    const lines = wrapText(msg.text, maxW);
    if (!lines || lines.length === 0) continue;

    const fragments = [];
    let lineCursor = 0;

    while (lineCursor < lines.length) {
      let availableH = bottomLimit() - curY;
      let fitLines = Math.floor(availableH / lineH);

      // 若当前页连单行都容纳不下，切到下一页/轮
      if (fitLines <= 0) {
        if (curPage === 'left') {
          curPage = 'right';
          curPageRect = rightPage;
        } else {
          curPage = 'left';
          curPageRect = leftPage;
          curRound++;
        }
        curY = curPageRect.y + config.paddingTop;
        availableH = bottomLimit() - curY;
        fitLines = Math.max(1, Math.floor(availableH / lineH));
      }

      const takeCount = Math.min(fitLines, lines.length - lineCursor);
      const fragLines = lines.slice(lineCursor, lineCursor + takeCount);
      const fragH = takeCount * lineH;

      fragments.push({
        page: curPage,
        round: curRound,
        x: curPageRect.x + 8,
        y: curY,
        w: curPageRect.w - 16,
        h: fragH,
        lines: fragLines,
      });

      lineCursor += takeCount;
      curY += fragH + spacing;
    }

    result.push({
      index: mIdx,
      role: msg.role,
      text: msg.text,
      fragments,
    });
  }

  return result;
}

export class SessionEchoPlayback {
  /**
   * @param {Object} options
   * @param {typeof DEFAULT_ECHO_CONFIG} [options.config] 配置项
   * @param {{ now: () => number, schedule: (fn: Function, ms: number) => any, cancel: (handle: any) => void }} [options.clock] 时钟端口
   * @param {{ leftPage: any, rightPage: any, wrapText: (text: string, maxW: number) => Array<string> }} options.layoutPort 排版度量端口
   * @param {Object} options.renderPort 渲染端口
   * @param {(activeFragments: Array<{ page: string, x: number, y: number, w: number, h: number, lines: Array<string>, role: string, opacity: number }>) => void} options.renderPort.onRenderFrame 每帧渲染活跃片段
   * @param {() => void} [options.renderPort.onClear] 清理纸面画布
   * @param {() => void} [options.renderPort.onComplete] 演播全部消融完成回调
   */
  constructor({ config = {}, clock = null, layoutPort, renderPort }) {
    this.config = { ...DEFAULT_ECHO_CONFIG, ...config };
    this.clock = clock || {
      now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h),
    };
    this.layoutPort = layoutPort;
    this.renderPort = renderPort;

    this.isActive = false;
    this._items = [];
    this._scheduledTimers = [];
    this._frameHandle = null;
    this._nextAttemptIndex = 0;
  }

  /**
   * 启动历史消息流式回响演播
   * @param {Array<{ prompt: string, reply: string }>} history 历史问答列表
   * @returns {boolean} 是否受理（已在运行或历史为空时快速返回）
   */
  start(history) {
    if (this.isActive) return false;

    // 展平成独立单条消息序列：User 提问与 AI 回复交替
    const messages = [];
    if (Array.isArray(history)) {
      for (const item of history) {
        if (item.prompt) messages.push({ role: 'user', text: item.prompt });
        if (item.reply) messages.push({ role: 'ai', text: item.reply });
      }
    }

    if (messages.length === 0) {
      this.renderPort.onComplete?.();
      return true;
    }

    const layoutItems = layoutEchoMessages(messages, {
      leftPage: this.layoutPort.leftPage,
      rightPage: this.layoutPort.rightPage,
      wrapText: this.layoutPort.wrapText,
      config: this.config,
    });

    if (layoutItems.length === 0) {
      this.renderPort.onComplete?.();
      return true;
    }

    this.isActive = true;
    this._items = layoutItems.map((item) => ({
      ...item,
      state: 'pending', // 'pending' | 'waiting_gate' | 'active' | 'completed'
      startTime: 0,
      opacity: 0,
    }));
    this._nextAttemptIndex = 0;
    this._scheduledTimers = [];

    this._attemptStartNext(0);
    this._startRenderLoop();
    return true;
  }

  /**
   * 尝试启动指定索引的消息（检测消融等待门控）
   * @param {number} idx
   */
  _attemptStartNext(idx) {
    if (!this.isActive || idx >= this._items.length) return;

    const item = this._items[idx];
    if (item.state !== 'pending' && item.state !== 'waiting_gate') return;

    // 检测几何碰撞门控：该消息的所有片段在对应页面与区间，是否与尚未消融完毕的旧片段重叠
    const blocked = this._checkCollision(item);
    if (blocked) {
      item.state = 'waiting_gate';
      return;
    }

    // 解除门控，正式启动该条消息的生命周期
    item.state = 'active';
    item.startTime = this.clock.now();

    // 调度下一条消息在 200ms 后尝试启动
    this._nextAttemptIndex = idx + 1;
    if (this._nextAttemptIndex < this._items.length) {
      this._schedule(() => {
        this._attemptStartNext(this._nextAttemptIndex);
      }, this.config.staggerMs);
    }
  }

  /**
   * 几何重叠碰撞检测
   * 检查 item 的任一片段，是否与此前未完成消融 (state === 'active') 的任何旧片段发生垂直重叠
   * @param {Object} item
   * @returns {boolean} true 表示发生重叠，需要等待
   */
  _checkCollision(item) {
    for (const curFrag of item.fragments) {
      for (let i = 0; i < item.index; i++) {
        const prev = this._items[i];
        if (prev.state !== 'active') continue;

        for (const prevFrag of prev.fragments) {
          if (prevFrag.page === curFrag.page) {
            // 垂直区间重叠判定: max(startA, startB) < min(endA, endB)
            const curEnd = curFrag.y + curFrag.h;
            const prevEnd = prevFrag.y + prevFrag.h;
            if (Math.max(curFrag.y, prevFrag.y) < Math.min(curEnd, prevEnd)) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  /**
   * 检查所有处于 waiting_gate 的消息是否已被放行
   */
  _checkWaitingGates() {
    for (let i = 0; i < this._items.length; i++) {
      const it = this._items[i];
      if (it.state === 'waiting_gate') {
        if (!this._checkCollision(it)) {
          it.state = 'active';
          it.startTime = this.clock.now();
          // 放行后，如果后续还有待启动项，安排 stagger 尝试
          const nextIdx = i + 1;
          if (nextIdx < this._items.length && this._items[nextIdx].state === 'pending') {
            this._schedule(() => {
              this._attemptStartNext(nextIdx);
            }, this.config.staggerMs);
          }
        } else {
          // 严格保持顺序：如果第 i 条仍在等待，后续条目不可跃迁抢跑
          break;
        }
      }
    }
  }

  /**
   * 步进一帧：更新各活跃消息透明度与生命周期
   * @param {number} now
   */
  step(now = this.clock.now()) {
    if (!this.isActive) return false;

    const { emergeDuration, stayDuration, dissolveDuration } = this.config;
    const totalDuration = emergeDuration + stayDuration + dissolveDuration;

    let anyCompletedThisFrame = false;
    const activeFragments = [];

    for (const item of this._items) {
      if (item.state !== 'active') continue;

      const elapsed = now - item.startTime;
      if (elapsed >= totalDuration) {
        item.state = 'completed';
        item.opacity = 0;
        anyCompletedThisFrame = true;
        continue;
      }

      let opacity = 0;
      let phase = 'stay';
      let dissolveAmount = 0.0;

      if (elapsed < emergeDuration) {
        // 反显阶段：从 1.0 (完全消融态) 衰减到 0.0 (饱满显影)
        phase = 'emerge';
        const progress = Math.min(1.0, Math.max(0, elapsed / emergeDuration));
        dissolveAmount = 1.0 - progress;
        opacity = easeInOutQuad(progress);
      } else if (elapsed < emergeDuration + stayDuration) {
        // 定格停留阶段：饱满显影 (dissolveAmount = 0.0)
        phase = 'stay';
        dissolveAmount = 0.0;
        opacity = 1.0;
      } else {
        // 吸干消融阶段：从 0.0 (饱满显影) 增长到 1.0 (完全消融)
        phase = 'dissolve';
        const dissolveElapsed = elapsed - emergeDuration - stayDuration;
        const progress = Math.min(1.0, Math.max(0, dissolveElapsed / dissolveDuration));
        dissolveAmount = progress;
        opacity = easeInOutQuad(Math.max(0, 1 - progress));
      }

      item.opacity = opacity;
      item.phase = phase;
      item.dissolveAmount = dissolveAmount;

      if (opacity > 0.001) {
        for (const frag of item.fragments) {
          activeFragments.push({
            page: frag.page,
            x: frag.x,
            y: frag.y,
            w: frag.w,
            h: frag.h,
            lines: frag.lines,
            role: item.role,
            opacity,
            phase,
            dissolveAmount,
          });
        }
      }
    }

    if (anyCompletedThisFrame) {
      this._checkWaitingGates();
    }

    this.renderPort.onRenderFrame?.(activeFragments);

    // 检查是否所有条目均已完成
    const allDone = this._items.every((it) => it.state === 'completed');
    if (allDone) {
      this.finish();
      return true;
    }

    return false;
  }

  _startRenderLoop() {
    const loop = () => {
      if (!this.isActive) return;
      const finished = this.step(this.clock.now());
      if (!finished && this.isActive) {
        this._frameHandle = this.clock.schedule(loop, 16);
      }
    };
    this._frameHandle = this.clock.schedule(loop, 16);
  }

  /**
   * 正常完成退出
   */
  finish() {
    if (!this.isActive) return;
    this.isActive = false;
    this._clearTimers();
    this.renderPort.onClear?.();
    this.renderPort.onComplete?.();
  }

  /**
   * 立即打断演出并收束至终态
   */
  interrupt() {
    if (!this.isActive) return;
    this.isActive = false;
    this._clearTimers();
    this.renderPort.onClear?.();
    this.renderPort.onComplete?.();
  }

  _schedule(fn, ms) {
    const handle = this.clock.schedule(() => {
      this._scheduledTimers = this._scheduledTimers.filter((h) => h !== handle);
      fn();
    }, ms);
    this._scheduledTimers.push(handle);
    return handle;
  }

  _clearTimers() {
    if (this._frameHandle !== null) {
      this.clock.cancel(this._frameHandle);
      this._frameHandle = null;
    }
    for (const h of this._scheduledTimers) {
      this.clock.cancel(h);
    }
    this._scheduledTimers = [];
  }
}
