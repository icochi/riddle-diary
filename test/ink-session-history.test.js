import test from 'node:test';
import assert from 'node:assert/strict';
import { InkSessionModel } from '../src/ink-session.js';

test('超出左页版心容量时最旧一条连数据一并褪出', () => {
  const model = new InkSessionModel({ historyCapacity: 3 });

  for (let i = 1; i <= 5; i++) model.addHistory(`第 ${i} 轮提问`, `第 ${i} 轮回答`);

  assert.equal(model.sessionHistory.length, 3);
  assert.deepEqual(model.sessionHistory.map((h) => h.prompt), ['第 3 轮提问', '第 4 轮提问', '第 5 轮提问']);
  assert.equal(model.sessionHistory.find((h) => h.prompt === '第 1 轮提问'), undefined, '被淘汰的条目不得残留成"看不见却可点开"');
});

test('历史索引去序号，直接展示提问摘要，超出版心容量滚动淘汰', () => {
  const model = new InkSessionModel({ historyCapacity: 2 });

  model.addHistory('一', 'a');
  model.addHistory('二', 'b');
  model.addHistory('三', 'c');

  // 去除序号前缀，直接展现提问摘要
  assert.deepEqual(model.sessionHistory.map((h) => h.title), ['二', '三']);

  model.addHistory('四', 'd');
  assert.deepEqual(model.sessionHistory.map((h) => h.title), ['三', '四']);
});

test('换页复显创建新 Session，原 Session 沉淀为历史且首问自动命名标题', () => {
  const model = new InkSessionModel({ historyCapacity: 15 });
  model.addHistory('关于五十年前的密室', '我知道这件事');
  model.setInput('未提交草稿', 5);

  assert.equal(model.currentSession.title, '关于五十年前的密室');

  // 换页复显重置会话
  model.createSession();

  assert.equal(model.inputBuffer, '');
  assert.equal(model.hasDraft, false);
  assert.equal(model.sessions.length, 2);
  assert.equal(model.sessions[1].title, '关于五十年前的密室');
  assert.equal(model.sessions[1].history.length, 1);
  assert.equal(model.sessions[1].history[0].title, '关于五十年前的密室');

  // 新 session 初始标题为默认标题
  assert.equal(model.currentSession.title, '新篇章');
  model.addHistory('海格后来怎么样了', '他被开除了');
  assert.equal(model.currentSession.title, '海格后来怎么样了', '首问自动更新为当前 session 标题');
  assert.equal(model.currentSession.history[0].title, '海格后来怎么样了');
});

test('支持切换历史 Session 并无损暂存与恢复草稿', () => {
  const model = new InkSessionModel();
  model.addHistory('篇章一首问', '回答一');
  model.setInput('篇章一草稿', 5);

  const session1Id = model.currentSessionId;

  // 开启篇章二
  model.createSession();
  model.addHistory('篇章二首问', '回答二');
  model.setInput('篇章二草稿', 5);

  const session2Id = model.currentSessionId;
  assert.notEqual(session1Id, session2Id);

  // 切换回篇章一
  const switched = model.switchSession(session1Id);
  assert.ok(switched);
  assert.equal(model.currentSessionId, session1Id);
  assert.equal(model.inputBuffer, '篇章一草稿', '篇章一的草稿被完整恢复');

  // 再次切回篇章二
  model.switchSession(session2Id);
  assert.equal(model.currentSessionId, session2Id);
  assert.equal(model.inputBuffer, '篇章二草稿', '篇章二的草稿被完整恢复');
});

test('getFlattenedIndexItems 仅包含 Session 标题列表并反映当前篇章状态', () => {
  const model = new InkSessionModel();
  model.addHistory('第一篇提问 A', '答 A');
  model.addHistory('第一篇提问 B', '答 B');
  const sess1Id = model.currentSessionId;

  model.createSession();
  model.addHistory('第二篇提问 C', '答 C');
  const sess2Id = model.currentSessionId;

  const items = model.getFlattenedIndexItems();

  // 结构应当是：最新活跃篇章在前（Session 2 在前，Session 1 在后）
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'session');
  assert.equal(items[0].id, sess2Id);
  assert.equal(items[0].isCurrent, true);

  assert.equal(items[1].type, 'session');
  assert.equal(items[1].id, sess1Id);
  assert.equal(items[1].isCurrent, false);

  // 切回 Session 1 后，Session 1 变为 isCurrent: true，Session 2 变为 false
  model.switchSession(sess1Id);
  const itemsAfterSwitch = model.getFlattenedIndexItems();

  assert.equal(itemsAfterSwitch.length, 2);
  assert.equal(itemsAfterSwitch[0].type, 'session');
  assert.equal(itemsAfterSwitch[0].id, sess2Id);
  assert.equal(itemsAfterSwitch[0].isCurrent, false);
  assert.equal(itemsAfterSwitch[1].type, 'session');
  assert.equal(itemsAfterSwitch[1].id, sess1Id);
  assert.equal(itemsAfterSwitch[1].isCurrent, true);
});

test('未发生问答且无自定义标题的初始空白 Session 不被左页索引呈现（保持纯净留白）', () => {
  const model = new InkSessionModel();
  const items = model.getFlattenedIndexItems();
  assert.equal(items.length, 0, '空白初始会话不占用左页历史目录');

  // 首问发生后，会话立项并被左页索引呈现
  model.addHistory('首个问题', '首个回答');
  const itemsAfterFirstPrompt = model.getFlattenedIndexItems();
  assert.equal(itemsAfterFirstPrompt.length, 1);
  assert.equal(itemsAfterFirstPrompt[0].type, 'session');
  assert.equal(itemsAfterFirstPrompt[0].title, '首个问题');
  assert.equal(itemsAfterFirstPrompt[0].isCurrent, true);
});

