'use strict';

/**
 * cue 正文无损性校验（原文与译文共用）。
 *
 * 系统冻结导出时，每条字幕写成一个 WebVTT cue：正文整体作为时间行之后、
 * 下一个空行之前的若干行。要保证“写进去的文本 == 解析回来的实际显示文本”，
 * 正文必须满足：
 *   1. 不含回车符（\r）：WebVTT 按行组织，解析端统一把 CRLF/CR 归一为 LF，
 *      原字符无法无损还原；
 *   2. 不含空行（连续两个换行，即“空白行”，包括只含空格/制表符的行）：
 *      空行会截断 cue 载荷，其后的内容会被解析成新的块而损坏快照；
 *   3. 首行与末行非空白：cue 块按空行切分，首尾空白行会并入块间分隔，
 *      静默丢失（尾部换行还会让正文看起来“保存成功”，导出后却消失）。
 *
 * 合法的段内单换行（'\n'，每行非空白）照常允许，会成为 cue 的多行正文。
 *
 * 判定口径与 src/vtt.js 的 parseWebVtt 切块规则保持一致（line.trim() === ''
 * 即视为空行），凡是 parseWebVtt 不能从 toWebVtt 输出中原样取回的正文一律拒绝。
 *
 * 注意：空字符串 '' 是合法的“空载荷 cue”（空白字幕，解析器明确支持），不报问题；
 * 但纯空白单行（如 '   '）会被切块规则当成块间分隔而丢失成空载荷，仍判不合格。
 */

/** 描述正文中无法无损写入 cue 的位置（1 起行号；0 表示非字符串等整体问题） */
function cueBodyProblems(text) {
  const problems = [];
  if (typeof text !== 'string') {
    problems.push({ line: 0, code: 'not_text', message: '正文必须是字符串' });
    return problems;
  }
  if (text.includes('\r')) {
    problems.push({
      line: 0, code: 'carriage_return',
      message: '正文含回车符（CR/CRLF）：WebVTT 行尾统一归一为 LF，无法无损写成单个 cue；请改用单个换行（\\n）',
    });
    return problems;
  }
  // 空载荷（''）合法：toWebVtt 输出空 cue，解析器取回 ''，往返无损。
  if (text === '') return problems;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '') {
      const lineNo = i + 1;
      let code;
      let what;
      if (i === 0) {
        code = 'leading_blank_line';
        what = '首行为空（首部换行/空白行）';
      } else if (i === lines.length - 1) {
        code = 'trailing_blank_line';
        what = '末行为空（尾部换行/空白行）';
      } else {
        code = 'blank_line';
        what = `第 ${lineNo} 行为空（连续换行形成的空白行）`;
      }
      problems.push({
        line: lineNo,
        code,
        message:
          `${what}：空行会截断或脱离 WebVTT cue，无法无损写成单个 cue；` +
          '请删除首尾换行与段内空白行（段内单个换行可以保留）',
      });
    }
  });
  return problems;
}

/** 正文是否可无损写成单个 cue（段内单换行合法） */
function isWritableCueText(text) {
  return cueBodyProblems(text).length === 0;
}

module.exports = { cueBodyProblems, isWritableCueText };
