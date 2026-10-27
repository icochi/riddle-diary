/**
 * 日记体纯净文本清洗器 (DiaryTextSanitizer)
 *
 * 职责：
 * 按照 ADR 0026 规范将豆包大模型输出的 Markdown/富文本降级转换为适合羽毛笔书写光栅化的纯净古典日记文本。
 * - 剥离标题、粗体、斜体、删除线、超链接等 Markdown 标记；
 * - 代码块降级保留缩进，每行前置 2 个全角空格作为“手抄咒文”排版；
 * - 行内代码脱壳保留文本；
 * - 表格降级为“表头: 数值”条列；
 * - 剥离 LaTeX 数学公式 $ 定界符；
 * - 规范化多余空行。
 */

export function sanitizeDiaryText(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';

  let text = rawText;

  // 1. 处理代码块：```lang\ncode\n``` 转换为全角空格缩进手抄咒文
  text = text.replace(/```(?:[a-zA-Z0-9_+-]+)?\r?\n([\s\S]*?)```/g, (_, codeBlock) => {
    const lines = codeBlock.replace(/\r\n/g, '\n').split('\n');
    // 过滤首尾多余纯空白行
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
    return lines.map((line) => `　　${line}`).join('\n') + '\n';
  });

  // 2. 处理多行数学公式块：$$\nformula\n$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => math.trim());

  // 3. 处理行内数学公式：$formula$
  text = text.replace(/\$([^\$\n]+)\$/g, (_, math) => math.trim());

  // 4. 处理 Markdown 表格
  // 匹配形如 | a | b |\n|---|---|\n| 1 | 2 | 的表格结构
  text = text.replace(/(?:(?:^|\n)\|[^\n]+\|\r?\n\|(?:\s*[:-]+[-| :]*)\|\r?\n(?:\|[^\n]+\|(?:\r?\n|$))+)/g, (tableBlock) => {
    const rows = tableBlock.trim().split(/\r?\n/).map((r) =>
      r.split('|').map((c) => c.trim()).filter((c, idx, arr) => idx > 0 && idx < arr.length - 1)
    );
    if (rows.length < 3) return tableBlock; // 非有效表格
    const headers = rows[0];
    const dataRows = rows.slice(2); // 略过表头与分割线
    const lines = [];
    for (const dRow of dataRows) {
      if (dRow.length === 2) {
        lines.push(`${dRow[0]}: ${dRow[1]}`);
      } else {
        const parts = [];
        for (let i = 0; i < dRow.length; i++) {
          const h = headers[i] || `项${i + 1}`;
          parts.push(`${h}: ${dRow[i]}`);
        }
        lines.push(parts.join('，'));
      }
    }
    return '\n' + lines.join('\n') + '\n';
  });

  // 5. 剥离 Markdown 标题 (# 一级标题)
  text = text.replace(/^#{1,6}\s+(.*)$/gm, '$1');

  // 6. 剥离粗体、斜体、删除线 (**bold**, *italic*, ~~strike~~)
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');

  // 7. 剥离行内代码 (`code`)
  text = text.replace(/`([^`]+)`/g, '$1');

  // 8. 剥离图片与链接 (![alt](url) -> [alt], [text](url) -> text)
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[$1]');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 9. 规范化无序列表符号 (- item / * item -> item)
  text = text.replace(/^[\*\-\+]\s+/gm, '• ');

  // 10. 规范化连续空白换行（最多保留 2 个连续换行）
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
