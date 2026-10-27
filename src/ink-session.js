/**
 * 对话墨迹周期领域模型 (InkSessionModel)
 *
 * 职责：
 * 1. 输入缓冲 (inputBuffer) 状态与光标位置管理
 * 2. 文本纯计算分屏 (Pagination) 与行折叠
 * 3. 对话会话历史 (sessionHistory) 记录与索引管理
 * 4. 历史回顾演播时用户草稿的暂存与复原机制
 *
 * 遵循深度模块原则：零 DOM/Canvas 依赖，通过测算适配器 (textMeasurer) 解耦排版环境。
 */

const DEFAULT_SESSION_TITLE = '新篇章';

export class InkSessionModel {
  /**
   * @param {Object} options
   * @param {(text: string, isAi: boolean) => Array<{ start: number, end: number, text: string }>} options.textMeasurer 文本分屏测算器
   * @param {number} [options.historyCapacity] 左页版心所能容纳的历史条目数，超出即淘汰最旧一条
   */
  constructor(options = {}) {
    this.textMeasurer = options.textMeasurer || ((text) => [{ start: 0, end: text.length, text }]);
    this.historyCapacity = options.historyCapacity ?? Infinity;
    this._inputBuffer = '';
    this._displayedPageIndex = 0;
    this.draftBackup = { buffer: '', cursor: 0 };
    this.activeReplayId = null;

    this.sessions = [];
    this.currentSessionId = null;
    this._listeners = [];
    this._createInitialSession();
  }

  onSessionsChange(listener) {
    if (typeof listener === 'function') {
      this._listeners.push(listener);
    }
  }

  _notifySessionsChanged() {
    for (const listener of this._listeners) {
      try {
        listener(this.sessions);
      } catch (err) {
        console.error('Error notifying sessions change:', err);
      }
    }
  }

  /**
   * 由外部宿主（豆包适配器）全量同步真实会话列表
   * @param {Array<{ id: string, title: string, isCurrent?: boolean }>} externalList
   */
  setExternalSessions(externalList) {
    if (!Array.isArray(externalList) || externalList.length === 0) return;

    // 清洗过滤外部列表中非会话条目（如“对话列表设置”等管理配置项）
    const isIgnoredTitle = (title) => {
      if (!title || typeof title !== 'string') return true;
      const t = title.trim();
      if (t === '对话列表设置' || t === '会话列表设置' || t === '对话设置' || t === '会话设置') return true;
      return t.length <= 8 && /^(对话|会话|历史|侧边栏)?(列表)?(设置|管理)$/.test(t);
    };
    const validList = externalList.filter((ext) => ext && ext.title && !isIgnoredTitle(ext.title));
    if (validList.length === 0) return;

    // 保留旧 session 的 draft 与已加载 history
    const oldSessionsMap = new Map(this.sessions.map((s) => [s.id, s]));

    const newSessions = validList.map((ext, idx) => {
      const existing = oldSessionsMap.get(ext.id);
      return {
        id: ext.id,
        title: ext.title || DEFAULT_SESSION_TITLE,
        hasCustomTitle: true,
        history: existing?.history || [],
        draft: existing?.draft || { buffer: '', cursor: 0 },
        createdAt: existing?.createdAt || Date.now() - (validList.length - idx) * 1000,
      };
    });

    this.sessions = newSessions;

    // 定位当前激活会话
    const currentExt = validList.find((s) => s.isCurrent);
    if (currentExt) {
      this.currentSessionId = currentExt.id;
    } else {
      // 宿主当前处于新对话页（无选中的历史会话）
      // 检查之前是否已经有一个尚未立项的空白活跃 session
      const existingBlankSession = this.sessions.find(
        (s) => s.id === this.currentSessionId && s.history.length === 0 && !s.hasCustomTitle
      ) || Array.from(oldSessionsMap.values()).find(
        (s) => s.id === this.currentSessionId && s.history.length === 0 && !s.hasCustomTitle
      );

      if (existingBlankSession) {
        // 保留该空白 session
        if (!this.sessions.some((s) => s.id === existingBlankSession.id)) {
          this.sessions.unshift(existingBlankSession);
        }
        this.currentSessionId = existingBlankSession.id;
      } else {
        // 创建一个全新的未立项空白篇章并设为当前
        const blankSession = {
          id: 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          title: DEFAULT_SESSION_TITLE,
          hasCustomTitle: false,
          history: [],
          draft: { buffer: '', cursor: 0 },
          createdAt: Date.now(),
        };
        this.sessions.unshift(blankSession);
        this.currentSessionId = blankSession.id;
      }
    }

    const cur = this.currentSession;
    if (cur) {
      this._inputBuffer = cur.draft?.buffer || '';
    }

    this._notifySessionsChanged();
  }

  /**
   * 为指定 Session 注入/同步问答历史对
   * @param {string} sessionId
   * @param {Array<{ prompt: string, reply: string }>} pairs
   */
  setSessionChatHistory(sessionId, pairs) {
    if (!Array.isArray(pairs)) return;
    const targetSession = this.sessions.find((s) => s.id === sessionId) || this.currentSession;
    if (!targetSession) return;

    targetSession.history = pairs.map((p, idx) => ({
      id: `hist_ext_${targetSession.id}_${idx + 1}`,
      sessionId: targetSession.id,
      prompt: p.prompt,
      reply: p.reply,
      title: p.prompt.length > 14 ? p.prompt.slice(0, 14) + '…' : p.prompt,
      timestamp: Date.now() - (pairs.length - idx) * 1000,
    }));
  }

  _createInitialSession() {
    const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const session = {
      id,
      title: DEFAULT_SESSION_TITLE,
      hasCustomTitle: false,
      history: [],
      draft: { buffer: '', cursor: 0 },
      createdAt: Date.now(),
    };
    this.sessions.push(session);
    this.currentSessionId = id;
    this._notifySessionsChanged();
    return session;
  }

  get currentSession() {
    return this.sessions.find((s) => s.id === this.currentSessionId) || this.sessions[0];
  }

  get sessionHistory() {
    return this.currentSession ? this.currentSession.history : [];
  }

  get inputBuffer() {
    return this._inputBuffer;
  }

  get displayedPageIndex() {
    return this._displayedPageIndex;
  }

  get hasDraft() {
    return Boolean(this._inputBuffer);
  }

  get currentPrompt() {
    return this._inputBuffer.trim();
  }

  /**
   * 获取当前屏分屏范围与对应文本内容
   */
  getCurrentPageInfo() {
    const ranges = this.calculatePageRanges(this._inputBuffer, false);
    const range = ranges[this._displayedPageIndex] || { text: '', start: 0, end: 0 };
    return {
      ranges,
      pageIndex: this._displayedPageIndex,
      text: range.text,
    };
  }

  /**
   * 更新输入文本与当前屏计算
   * @param {string} text
   * @param {number} cursor
   * @returns {{ action: 'same' | 'forward' | 'backward', targetPageIndex: number, ranges: Array }}
   */
  setInput(text, cursor = text.length) {
    this._inputBuffer = text;
    const ranges = this.calculatePageRanges(text, false);

    let targetPageIndex = 0;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (cursor >= r.start && cursor < r.end) {
        targetPageIndex = i;
        break;
      }
      if (cursor >= r.end) {
        targetPageIndex = i;
      }
    }

    if (ranges.length > this._displayedPageIndex + 1 && cursor >= ranges[this._displayedPageIndex + 1].start) {
      targetPageIndex = this._displayedPageIndex + 1;
    }

    let action = 'same';
    if (targetPageIndex > this._displayedPageIndex) {
      action = 'forward';
    } else if (targetPageIndex < this._displayedPageIndex) {
      action = 'backward';
      this._displayedPageIndex = targetPageIndex;
    }

    if (this._displayedPageIndex >= ranges.length) {
      this._displayedPageIndex = Math.max(0, ranges.length - 1);
    }

    return {
      action,
      targetPageIndex,
      ranges,
      currentText: ranges[this._displayedPageIndex]?.text ?? '',
    };
  }

  /**
   * 提交当前输入并清空缓冲区
   * @returns {string} 提交的完整提问内容
   */
  commit() {
    const prompt = this._inputBuffer.trim();
    this._inputBuffer = '';
    this._displayedPageIndex = 0;
    return prompt;
  }

  /**
   * 确认翻屏完成并切至目标页
   */
  confirmForwardPage(targetPageIndex) {
    this._displayedPageIndex = targetPageIndex;
  }

  /**
   * 计算分屏
   */
  calculatePageRanges(text, isAi = false) {
    if (!text) return [{ start: 0, end: 0, text: '' }];
    return this.textMeasurer(text, isAi);
  }

  /**
   * 记录一轮问答至当前会话历史
   *
   * 历史索引去掉罗马数字/阿拉伯数字序号，纯以提问摘要为标题；
   * 首问发生且当前 Session 未定制标题时，自动将 Session 标题更新为该提问摘要。
   */
  addHistory(prompt, reply) {
    const cur = this.currentSession;
    if (!cur) return null;

    const id = 'hist_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const titleSnippet = prompt.length > 14 ? prompt.slice(0, 14) + '…' : prompt;

    // 首问自动命名当前 Session 标题
    if (!cur.hasCustomTitle) {
      cur.title = titleSnippet;
      cur.hasCustomTitle = true;
    }

    // 历史索引项去掉序号，直接展示提问摘要
    const item = {
      id,
      sessionId: cur.id,
      prompt,
      reply,
      title: titleSnippet,
    };

    cur.history.push(item);
    while (cur.history.length > this.historyCapacity) {
      const evicted = cur.history.shift();
      if (this.activeReplayId === evicted.id) this.activeReplayId = null;
    }

    // 活跃会话置顶：将当前产生问答的会话提升至 sessions 列表最前面
    const sIndex = this.sessions.indexOf(cur);
    if (sIndex > 0) {
      this.sessions.splice(sIndex, 1);
      this.sessions.unshift(cur);
      this._notifySessionsChanged();
    }

    return item;
  }

  /**
   * 创建并切换至新 Session（换页复显重置时调用）
   * @param {string} [title=DEFAULT_SESSION_TITLE]
   * @returns {Object} 新创建的 Session 对象
   */
  createSession(title = DEFAULT_SESSION_TITLE) {
    const cur = this.currentSession;
    // 如果当前 session 既无问答记录又无正在输入的草稿，复用当前空白 session 即可
    if (cur && cur.history.length === 0 && !this._inputBuffer) {
      cur.title = title;
      cur.hasCustomTitle = false;
      return cur;
    }

    if (cur) {
      cur.draft = {
        buffer: this._inputBuffer,
        cursor: this._inputBuffer.length,
      };
    }

    const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const newSession = {
      id,
      title,
      hasCustomTitle: false,
      history: [],
      draft: { buffer: '', cursor: 0 },
      createdAt: Date.now(),
    };
    this.sessions.unshift(newSession);
    this.currentSessionId = id;
    this._inputBuffer = '';
    this._displayedPageIndex = 0;
    this.draftBackup = { buffer: '', cursor: 0 };
    this.activeReplayId = null;
    return newSession;
  }

  /**
   * 切换至目标历史 Session
   * 暂存当前 session 草稿，并无损恢复目标 session 的草稿
   * @param {string} sessionId
   * @returns {Object|null} 目标 Session 对象
   */
  switchSession(sessionId) {
    const target = this.sessions.find((s) => s.id === sessionId);
    if (!target || target.id === this.currentSessionId) return null;

    const cur = this.currentSession;
    if (cur) {
      cur.draft = {
        buffer: this._inputBuffer,
        cursor: this._inputBuffer.length,
      };
    }

    this.currentSessionId = target.id;
    this.activeReplayId = null;
    this._inputBuffer = target.draft?.buffer || '';
    this._displayedPageIndex = 0;
    this.draftBackup = { buffer: '', cursor: 0 };
    return target;
  }

  /**
  /**
   * 获取左页排版项序列：
   * 纯 Session 篇章标题列表（不包含历史问答细目），标记当前活跃状态
   * @returns {Array<Object>}
   */
  getFlattenedIndexItems() {
    const items = [];
    for (const session of this.sessions) {
      // 未发生问答且未具备自定义/外部真实标题的空白篇章不列入左页历史目录
      const isBlankSession = session.history.length === 0 && !session.hasCustomTitle;
      if (isBlankSession) continue;

      const isCurrent = session.id === this.currentSessionId;
      items.push({
        type: 'session',
        id: session.id,
        sessionId: session.id,
        title: session.title,
        isCurrent,
        isActive: isCurrent,
      });
    }

    if (items.length > this.historyCapacity) {
      return items.slice(items.length - this.historyCapacity);
    }
    return items;
  }

  findHistoryItem(histId) {
    return this.sessions.flatMap((s) => s.history).find((h) => h.id === histId) || null;
  }

  /**
   * 开启历史回顾，备份草稿
   */
  beginReplay(histId, currentCursor = 0) {
    if (this.activeReplayId === null) {
      this.draftBackup = {
        buffer: this._inputBuffer,
        cursor: currentCursor,
      };
    }
    this.activeReplayId = histId;
    return this.findHistoryItem(histId);
  }

  /**
   * 退出历史回顾，复原草稿
   */
  endReplay() {
    this.activeReplayId = null;
    const { buffer, cursor } = this.draftBackup;
    this._inputBuffer = buffer;
    return { restoredBuffer: buffer, restoredCursor: cursor };
  }

  get isReplaying() {
    return this.activeReplayId !== null;
  }
}
