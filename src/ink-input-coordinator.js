/**
 * 打字与跨页过渡协调器深模块 (InkInputCoordinator)
 *
 * 职责：
 * 1. 封装输入法组合输入状态 (isComposing) 与打字状态机；
 * 2. 统一调度文本行折叠溢出分屏、多屏打字跨页消融与反向毛细显影过渡时序；
 * 3. 聚合外部繁忙状态 (ChatDirector, SessionReset) 与内部过渡锁，提供单一真实的 isLocked 判定；
 * 4. 仲裁文字变更后的待输入墨滴生命周期（隐去当前墨滴并在打字静止间隙后在字尾重启）；
 * 5. 零 DOM 直接依赖，通过小接口与事件回调协同。
 */

export class InkInputCoordinator {
  /**
   * @param {Object} options
   * @param {Object} options.sessionModel 墨迹会话领域模型 (InkSessionModel)
   * @param {Object} options.epoch 会话世代模型 (SessionEpoch)
   * @param {Object} options.config 延时与动画配置
   * @param {number} options.config.typingIdleDelay 打字静止间隙 (ms)
   * @param {number} options.config.firstDropDelay 首滴延迟 (ms)
   * @param {number} options.config.duration 跨页消融时长 (ms)
   * @param {number} options.config.emergeDuration 跨页显影时长 (ms)
   * @param {() => boolean} [options.isExternalBusy] 外部忙碌状态查询（对话演播、换页复显等）
   * @param {Object} options.displayPort
   * @param {(text: string) => void} options.displayPort.setRenderText 设置当前渲染文本
   * @param {() => void} options.displayPort.redrawFullCanvas 全量重绘
   * @param {(duration: number, onComplete: Function) => Function} options.displayPort.animateTextErosion 消融动画
   * @param {(duration: number, onComplete: Function) => Function} options.displayPort.animateTextEmergence 显影动画
   * @param {Object} options.dropPort
   * @param {() => void} options.dropPort.stop 停止墨滴
   * @param {(delay: number) => void} options.dropPort.start 启动墨滴
   * @param {Object} [options.inputPort]
   * @param {() => void} [options.inputPort.focus] 聚焦输入
   * @param {() => void} [options.inputPort.onType] 打字通知
   * @param {(prompt: string) => void} [options.onSubmitPrompt] 提交提示词回调
   */
  constructor({
    sessionModel,
    epoch,
    config,
    isExternalBusy = () => false,
    displayPort,
    dropPort,
    inputPort = {},
    onSubmitPrompt = null,
  }) {
    this.sessionModel = sessionModel;
    this.epoch = epoch;
    this.config = config;
    this.isExternalBusy = isExternalBusy;
    this.displayPort = displayPort;
    this.dropPort = dropPort;
    this.inputPort = inputPort;
    this.onSubmitPrompt = onSubmitPrompt;

    this.isComposing = false;
    this.isTransitioningPage = false;
    this.isEmergingBackPage = false;
    this.activeTransitionCancel = null;
    this.activeEmergenceCancel = null;
  }

  get isLocked() {
    return this.isExternalBusy() || this.isTransitioningPage || this.isEmergingBackPage;
  }

  /**
   * 停止当前正在执行的跨页显影
   */
  stopEmergence() {
    if (this.activeEmergenceCancel) {
      this.activeEmergenceCancel();
      this.activeEmergenceCancel = null;
    }
    this.isEmergingBackPage = false;
  }

  /**
   * 中止所有正在执行的跨页过渡动画
   */
  cancelAll() {
    this.stopEmergence();
    if (this.activeTransitionCancel) {
      this.activeTransitionCancel();
      this.activeTransitionCancel = null;
    }
    this.isTransitioningPage = false;
    this.isComposing = false;
  }

  /**
   * 文字内容变更后的待输入墨滴重置：先隐去当前墨滴，再于打字静止间隙后在最新字尾重新滴落
   */
  scheduleDropCycleRestart() {
    this.dropPort.stop();
    if (this.isLocked) return;
    this.dropPort.start(this.config.typingIdleDelay);
  }

  /**
   * 处理当前页排版与分屏渲染
   * @param {boolean} [forceEmergence=false] 是否强制触发反向显影
   * @param {string|null} [textOverride=null] 覆盖文本
   * @param {number|null} [cursorOverride=null] 覆盖光标
   */
  renderCurrentPage(forceEmergence = false, textOverride = null, cursorOverride = null) {
    if (this.isEmergingBackPage || this.isTransitioningPage) return;

    const textToSync = textOverride !== null ? textOverride : this.sessionModel.inputBuffer;
    const cursor = cursorOverride !== null ? cursorOverride : textToSync.length;
    const { action, targetPageIndex, ranges, currentText } = this.sessionModel.setInput(textToSync, cursor);

    if (action === 'forward') {
      this.stopEmergence();
      this.triggerForwardPageTransition(ranges, targetPageIndex);
      return;
    }

    if (action === 'backward' || forceEmergence) {
      this.triggerPageEmergence(currentText);
    } else {
      this.stopEmergence();
      this.displayPort.setRenderText(currentText);
      this.displayPort.redrawFullCanvas();
    }
  }

  /**
   * 触发新屏文字反向毛细显影
   * @param {string} curText
   * @param {Function} [onFinished]
   */
  triggerPageEmergence(curText, onFinished = null) {
    this.stopEmergence();
    this.isEmergingBackPage = true;
    this.dropPort.stop();

    this.displayPort.setRenderText(curText);

    const guard = (fn) => (this.epoch ? this.epoch.guard(fn) : fn);
    this.activeEmergenceCancel = this.displayPort.animateTextEmergence(
      this.config.emergeDuration,
      guard(() => {
        this.activeEmergenceCancel = null;
        this.isEmergingBackPage = false;
        if (this.inputPort.focus) {
          this.inputPort.focus();
        }
        this.dropPort.start(this.config.firstDropDelay);
        if (onFinished) onFinished();
      })
    );
  }

  /**
   * 触发跨页前进过渡：旧屏文字各向异性消融 -> 确认换屏 -> 新屏反向显影
   * @param {Array} ranges
   * @param {number} targetPageIndex
   */
  triggerForwardPageTransition(ranges, targetPageIndex) {
    if (this.isTransitioningPage) return;
    this.isTransitioningPage = true;
    this.dropPort.stop();

    const prevRangeText = ranges[this.sessionModel.displayedPageIndex]?.text || this.sessionModel.inputBuffer;
    this.displayPort.setRenderText(prevRangeText);

    const guard = (fn) => (this.epoch ? this.epoch.guard(fn) : fn);

    // 阶段一：当前旧屏文字原位执行各向异性纸浆纤维腐蚀消融
    this.activeTransitionCancel = this.displayPort.animateTextErosion(
      this.config.duration,
      guard(() => {
        this.activeTransitionCancel = null;
        this.sessionModel.confirmForwardPage(targetPageIndex);

        // 阶段二：确认切换至目标新屏，并以反向毛细显影流畅过渡展示新屏文字
        const nextPageInfo = this.sessionModel.getCurrentPageInfo();
        this.triggerPageEmergence(nextPageInfo.text, () => {
          this.isTransitioningPage = false;
          if (this.inputPort.focus) {
            this.inputPort.focus();
          }
          this.dropPort.start(this.config.firstDropDelay);
        });
      })
    );
  }

  // ---------- 事件意图驱动方法 ----------

  handleCompositionStart() {
    if (this.isLocked) return false;
    this.isComposing = true;
    return true;
  }

  handleCompositionUpdate() {
    if (this.isLocked) return false;
    return true;
  }

  handleCompositionEnd(value, cursor = null) {
    if (this.isLocked) return false;
    this.isComposing = false;
    this.scheduleDropCycleRestart();
    this.renderCurrentPage(false, value, cursor);
    if (this.inputPort.onType) {
      this.inputPort.onType();
    }
    return true;
  }

  handleInput(value, cursor = null) {
    if (this.isLocked) return false;
    if (!this.isComposing) {
      this.scheduleDropCycleRestart();
      this.renderCurrentPage(false, value, cursor);
      if (this.inputPort.onType) {
        this.inputPort.onType();
      }
    }
    return true;
  }

  handleEnter() {
    if (this.isLocked || this.isComposing) return false;
    const fullPrompt = this.sessionModel.currentPrompt;
    if (fullPrompt && this.onSubmitPrompt) {
      this.onSubmitPrompt(fullPrompt);
      return true;
    }
    return false;
  }
}
