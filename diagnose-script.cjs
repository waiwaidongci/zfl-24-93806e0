const fs = require('fs');
const html = fs.readFileSync('server.js', 'utf8');
const start = html.indexOf('const page = `');
const end = html.lastIndexOf('`;');
const pageContent = html.slice(start + 14, end);
const scriptStart = pageContent.indexOf('<script>');
const scriptEnd = pageContent.lastIndexOf('</script>');
const script = pageContent.slice(scriptStart + 8, scriptEnd);
fs.writeFileSync('extracted-full-script.js', script);
console.log('Script extracted, length:', script.length);
// 逐行检查问题正则
const lines = script.split('\n');
let problemCount = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // 查找正则字面量中可能包含转义字符的问题
  // 匹配 /xxxx/ 形式的正则字面量
  const regexPattern = /\/(?:[^\/\\]|\\.)*\/[gimsuy]*/g;
  let match;
  while ((match = regexPattern.exec(line)) !== null) {
    const regexStr = match[0];
    // 检查是否包含实际的换行或回车（被模板字符串转换后的）
    if (regexStr.includes('\n') || regexStr.includes('\r')) {
      console.log('PROBLEM Line', i+1, ':', regexStr.replace(/\n/g, '\\n').replace(/\r/g, '\\r'));
      problemCount++;
    }
  }
}
console.log('Found', problemCount, 'problem regex patterns');
// 语法检查
try {
  new Function(script);
  console.log('✓ Script syntax OK');
} catch(e) {
  console.log('✗ Syntax error:', e.message);
  // 尝试找到错误行
  const errMatch = e.message.match(/<anonymous>:(\d+)/);
  if (errMatch) {
    const lineNum = parseInt(errMatch[1]);
    console.log('Error around line', lineNum, ':');
    for (let i = Math.max(0, lineNum-3); i < Math.min(lines.length, lineNum+3); i++) {
      console.log((i+1) + ': ' + lines[i]);
    }
  }
}
