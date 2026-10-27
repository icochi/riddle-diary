/**
 * 对话墨迹周期与演播调度器深模块 (ChatInkDirector)
 *
 * 职责：
 * 1. 统一调度提问消融、网络挂起、反向毛细显影、字数阅读停留与多屏演播的完整时序状态机；
 * 2. 统一调度历史索引项点击后的草稿暂存、旧墨吸干、问答复演与草稿复原流程；
 * 3. 严格遵循会话世代作废（SessionEpoch），迟到的后台回复与上一代动画回调自行动作废；
 * 4. 抽象时钟（clock）、网络通信（promptPort）与纸面演出（displayPort），支持纯内存与虚拟时钟无缝测试；
 * 5. 全流程仲裁用户输入锁定与待输入墨滴生命周期的启闭。
 */

export const DEFAULT_DIRECTOR_CONFIG = {
  bleedDuration: 400,   // 回车提交后笔画微渗时长 (ms)
  stayTime: 150,        // 回车提交后笔画墨迹定格停留时间 (ms)
  duration: 2400,       // 吸干消融总时长 (ms, 缓入快出)
  emergeDuration: 2200, // AI 文本反向毛细显影时长 (ms, 快出缓入)
  aiStayTime: 3200,     // AI 文本单页停留时长下限 (ms)
  aiLastPageStay: 4200, // 末页读完即解锁书写，多给一拍呼吸 (ms)
  aiStayPerChar: 120,   // 每个字符的阅读时长 (ms)
  aiStayMax: 16000,     // AI 文本单页停留时长上限 (ms)
  mockAiResponse: '你好哈利波特，我是汤姆·豆包·里德尔。',
  mockAiDelay: 0,
  errorMessage: '墨水沉入纸背，未见回响……',
  pageTurnPause: 200,   // 多屏翻向下一页之间的留白微间隔 (ms)
  replayExitDuration: 400, // 历史回顾平滑打断时的快速吸干时长 (ms)
};

/**
 * 单页 AI 文本阅读停留时长计算
 * @param {number} charCount 字符数
 * @param {boolean} isLastPage 是否为最后终页
 * @param {typeof DEFAULT_DIRECTOR_CONFIG} [cfg]
 */
export function calculateAiPageStayMs(charCount, isLastPage, cfg = DEFAULT_DIRECTOR_CONFIG) {
  const floor = isLastPage ? cfg.aiLastPageStay : cfg.aiStayTime;
  const stay = charCount * cfg.aiStayPerChar;
  return stay < floor ? floor : stay > cfg.aiStayMax ? cfg.aiStayMax : stay;
}

export class ChatInkDirector {
  /**
   * @param {Object} options
   * @param {Object} options.sessionModel 墨迹会话领域模型实例 (InkSessionModel)
   * @param {Object} options.epoch 会话世代模型实例 (SessionEpoch)
   * @param {typeof DEFAULT_DIRECTOR_CONFIG} [options.config] 配置项
   * @param {{ now: () => number, schedule: (fn: Function, ms: number) => any, cancel: (handle: any) => void }} [options.clock] 时钟适配器
   * @param {(prompt: string) => Promise<string>} [options.promptPort] AI 通信端口
   * @param {() => { ready: boolean, reason?: string }|boolean} [options.validatePort] 前置就绪校验端口
   * @param {() => void} [options.onCancel] 取消生成回调
   * @param {Object} options.displayPort 纸面显示与着色器动画端口
   * @param {(duration: number, onComplete: Function) => Function} options.displayPort.animateTextErosion 消融动画
   * @param {(duration: number, onComplete: Function) => Function} options.displayPort.animateTextEmergence 显影动画
   * @param {(histItem: any) => void} [options.displayPort.prepareLeftItemEmergence] 预设左页项消融态
   * @param {(histItem: any, duration: number, onComplete?: Function) => Function} [options.displayPort.animateLeftItemEmergence] 左页项显影
   * @param {(text: string, isAi: boolean) => void} options.displayPort.setRenderText 设置当前渲染文本与属性
   * @param {() => void} [options.displayPort.redrawCanvas] 全局重绘贴图
   * @param {Object} [options.inputPort] 输入控制端口
   * @param {() => void} [options.inputPort.lock] 锁定输入
   * @param {() => void} [options.inputPort.unlock] 解锁输入
   * @param {(text: string, cursor: number) => void} [options.inputPort.syncDraft] 同步输入框文本与光标
   * @param {(delay: number) => void} [options.dropPort.start] 启动滴墨
   * @param {() => void} [options.dropPort.stop] 停止滴墨
   * @param {(phase: string) => void} [options.onPhaseChange] 阶段变更通知
   */
  constructor({
    sessionModel,
    epoch,
    config = {},
    clock = null,
    promptPort = null,
    validatePort = null,
    onCancel = null,
    displayPort,
    inputPort = {},
    dropPort = {},
    onPhaseChange = null,
  }) {
    this.sessionModel = sessionModel;
    this.epoch = epoch;
    this.config = { ...DEFAULT_DIRECTOR_CONFIG, ...config };
    this.clock = clock || {
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle),
    };
    this.promptPort = promptPort || (async () => this.config.mockAiResponse);
    this.validatePort = validatePort;
    this.onCancel = onCancel;
    this.displayPort = displayPort;
    this.inputPort = inputPort;
    this.dropPort = dropPort;
    this.onPhaseChange = onPhaseChange;

    this.phase = 'idle';
    this.activeCancel = null;
    this.leftActiveCancel = null;
    this._scheduledTimer = null;
  }

  get isBusy() {
    return this.phase !== 'idle';
  }

  get isReplaying() {
    return this.phase === 'replaying';
  }

  _setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.onPhaseChange?.(phase);
  }

  _schedule(fn, ms) {
    this._clearScheduled();
    const handle = this.clock.schedule(() => {
      this._scheduledTimer = null;
      fn();
    }, ms);
    this._scheduledTimer = handle;
    return handle;
  }

  _clearScheduled() {
    if (this._scheduledTimer !== null) {
      this.clock.cancel(this._scheduledTimer);
      this._scheduledTimer = null;
    }
  }

  _cancelCurrentAnimation() {
    if (this.activeCancel) {
      this.activeCancel();
      this.activeCancel = null;
    }
    if (this.leftActiveCancel) {
      this.leftActiveCancel();
      this.leftActiveCancel = null;
    }
    this._clearScheduled();
  }

  /**
   * 提交提问并驱动对话墨迹演播
   * @param {string} fullPrompt
   * @returns {boolean} 是否受理
   */
  submit(fullPrompt) {
    if (this.isBusy || !fullPrompt) return false;

    if (this.validatePort) {
      const check = this.validatePort();
      if (check === false || (check && check.ready === false)) {
        return false;
      }
    }

    this._setPhase('eroding_prompt');
    this.inputPort.lock?.();
    this.dropPort.stop?.();

    this.sessionModel.commit();
    this.inputPort.syncDraft?.('', 0);

    const promptPromise = Promise.resolve()
      .then(() => this.promptPort(fullPrompt))
      .catch((err) => {
        console.error('Error fetching AI prompt response:', err);
        return this.config.errorMessage || this.config.mockAiResponse;
      });

    const currentEpoch = this.epoch.value;

    this._schedule(() => {
      if (this.epoch.value !== currentEpoch) {
        this.cancelAll();
        return;
      }

      if (this.displayPort.dissolveLeftInitialTitle) {
        this.leftActiveCancel = this.displayPort.dissolveLeftInitialTitle(this.config.duration, () => {
          this.leftActiveCancel = null;
        });
      }

      this.activeCancel = this.displayPort.animateTextErosion(this.config.duration, async () => {
        this.activeCancel = null;
        if (this.leftActiveCancel) {
          this.leftActiveCancel();
          this.leftActiveCancel = null;
        }
        if (this.epoch.value !== currentEpoch) {
          this.cancelAll();
          return;
        }

        this._setPhase('awaiting_reply');
        const reply = (await promptPromise) || this.config.mockAiResponse;

        // 世代校验：等回复期间被换页复显抢先，迟到的回复作废
        if (this.epoch.value !== currentEpoch) {
          this.cancelAll();
          return;
        }

        if (!reply) {
          this._finishChatCycle();
          return;
        }

        let histItem = null;
        try {
          histItem = this.sessionModel.addHistory(fullPrompt, reply);
          this.displayPort.redrawCanvas?.();
          if (histItem && this.displayPort.prepareLeftItemEmergence) {
            this.displayPort.prepareLeftItemEmergence(histItem);
          }
        } catch (e) {
          console.error(e);
        }

        this._emergeAiReply(reply, histItem, currentEpoch);
      });
    }, this.config.stayTime);

    return true;
  }

  _emergeAiReply(replyText, newHistItem, currentEpoch) {
    const pageRanges = this.sessionModel.calculatePageRanges(replyText, true);
    const pages = pageRanges.map((r) => r.text);
    this._playAiPage(pages, 0, newHistItem, currentEpoch);
  }

  _playAiPage(pages, pageIndex, newHistItem, currentEpoch) {
    if (this.epoch.value !== currentEpoch) {
      this.cancelAll();
      return;
    }

    if (pageIndex >= pages.length) {
      this._finishChatCycle();
      return;
    }

    this._setPhase('emerging_reply');
    this.displayPort.setRenderText(pages[pageIndex], true);

    // AI 文本第一屏启动显影时，左页同步开始反向毛细显影本次新增索引条目
    if (pageIndex === 0 && newHistItem && this.displayPort.animateLeftItemEmergence) {
      this.displayPort.animateLeftItemEmergence(newHistItem, this.config.emergeDuration);
    }

    this.activeCancel = this.displayPort.animateTextEmergence(this.config.emergeDuration, () => {
      this.activeCancel = null;
      if (this.epoch.value !== currentEpoch) {
        this.cancelAll();
        return;
      }

      this._setPhase('reading_reply');
      const isLastPage = pageIndex === pages.length - 1;
      const stayDuration = calculateAiPageStayMs(pages[pageIndex].length, isLastPage, this.config);

      this._schedule(() => {
        if (this.epoch.value !== currentEpoch) {
          this.cancelAll();
          return;
        }

        this._setPhase('eroding_reply');
        this.activeCancel = this.displayPort.animateTextErosion(this.config.duration, () => {
          this.activeCancel = null;
          if (this.epoch.value !== currentEpoch) {
            this.cancelAll();
            return;
          }

          this._schedule(() => {
            this._playAiPage(pages, pageIndex + 1, null, currentEpoch);
          }, this.config.pageTurnPause);
        });
      }, stayDuration);
    });
  }

  _finishChatCycle() {
    this.displayPort.setRenderText('', false);
    this._setPhase('idle');
    this.inputPort.unlock?.();
    this.dropPort.start?.(0);
  }

  /**
   * 启动历史回顾演播
   * @param {Object} histItem
   * @param {number} [currentCursor] 当前未提交草稿的光标位置
   * @returns {boolean} 是否受理
   */
  startReplay(histItem, currentCursor = 0) {
    if (this.isBusy || !histItem) return false;

    this._cancelCurrentAnimation();
    this.sessionModel.beginReplay(histItem.id, currentCursor);
    this.displayPort.redrawCanvas?.();
    this.dropPort.stop?.();
    this.inputPort.lock?.();
    this._setPhase('replaying');

    const currentEpoch = this.epoch.value;

    // 先吸干右页已有文字
    this.activeCancel = this.displayPort.animateTextErosion(this.config.replayExitDuration, () => {
      this.activeCancel = null;
      if (this.epoch.value !== currentEpoch || !this.sessionModel.isReplaying) return;

      const promptRanges = this.sessionModel.calculatePageRanges(histItem.prompt, false);
      const promptPages = promptRanges.map((r) => r.text);

      this._playReplaySequence(promptPages, false, () => {
        if (this.epoch.value !== currentEpoch || !this.sessionModel.isReplaying) return;
        const replyRanges = this.sessionModel.calculatePageRanges(histItem.reply, true);
        const replyPages = replyRanges.map((r) => r.text);

        this._playReplaySequence(replyPages, true, () => {
          this.interruptReplay(false);
        });
      });
    });

    return true;
  }

  _playReplaySequence(pages, isAi, onSequenceComplete) {
    const currentEpoch = this.epoch.value;
    const playPage = (idx) => {
      if (this.epoch.value !== currentEpoch || !this.sessionModel.isReplaying) return;
      if (idx >= pages.length) {
        if (onSequenceComplete) onSequenceComplete();
        return;
      }

      this.displayPort.setRenderText(pages[idx], isAi);

      this.activeCancel = this.displayPort.animateTextEmergence(this.config.emergeDuration, () => {
        this.activeCancel = null;
        if (this.epoch.value !== currentEpoch || !this.sessionModel.isReplaying) return;

        // 复演的提示页读完还有回复页要读，不算末页；只有回复段的最后一页才算末页
        const isLastPage = isAi && idx === pages.length - 1;
        const stayDuration = calculateAiPageStayMs(pages[idx].length, isLastPage, this.config);

        this._schedule(() => {
          if (this.epoch.value !== currentEpoch || !this.sessionModel.isReplaying) return;

          this.activeCancel = this.displayPort.animateTextErosion(this.config.duration, () => {
            this.activeCancel = null;
            if (this.epoch.value !== currentEpoch || !this.sessionModel.isReplaying) return;

            this._schedule(() => {
              playPage(idx + 1);
            }, 150);
          });
        }, stayDuration);
      });
    };

    playPage(0);
  }

  /**
   * 中断历史回顾演播并恢复用户草稿
   * @param {boolean} [immediate=false] 是否瞬清退出（如合书场景）
   */
  interruptReplay(immediate = false) {
    if (!this.sessionModel.isReplaying && this.phase !== 'replaying') return;

    this._cancelCurrentAnimation();

    const finishExit = () => {
      const { restoredBuffer, restoredCursor } = this.sessionModel.endReplay();
      this.displayPort.setRenderText(restoredBuffer || '', false);
      this.inputPort.syncDraft?.(restoredBuffer, restoredCursor);
      this.displayPort.redrawCanvas?.();
      this._setPhase('idle');
      this.inputPort.unlock?.();
      this.dropPort.start?.(1200);
    };

    if (immediate) {
      finishExit();
      return;
    }

    this.activeCancel = this.displayPort.animateTextErosion(this.config.replayExitDuration, () => {
      this.activeCancel = null;
      finishExit();
    });
  }

  /**
   * 彻底中止所有正在执行的动画与计时器（如合书或会话作废）
   * @param {{ preserveText?: boolean }} [options]
   */
  cancelAll({ preserveText = false } = {}) {
    this._cancelCurrentAnimation();
    this.onCancel?.();
    if (this.sessionModel.isReplaying) {
      this.sessionModel.endReplay();
    }
    if (!preserveText) {
      this.displayPort.setRenderText('', false);
    }
    this._setPhase('idle');
  }
}
