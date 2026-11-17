// Audit: find English-looking string literals that are NOT wrapped in t().
// Usage: node scripts/audit-untranslated.cjs [filter-substring]
const ts = require("typescript");
const fs = require("fs");
const path = require("path");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "i18n") walk(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

// 判断一个字符串是否"看起来像用户可见的英文文案"
function isCandidate(s) {
  if (typeof s !== "string") return false;
  if (s.length < 6 || s.length > 400) return false;
  if (!/ {1}/.test(s)) return false; // 至少要有一个空格（词组/句子）
  if (!/[A-Za-z]{3}/.test(s)) return false; // 至少 3 连字母
  // 纯路径 / 文件扩展 / CSS 选择器 / 正则 / 日期格式 token
  if (/^[\s./#@*\[\]{}()>~+|^-]+$/.test(s)) return false;
  if (/^[A-Za-z0-9_./:@#?=&%-]+$/.test(s) && !/\s/.test(s)) return false;
  if (/^\d/.test(s) && !/[A-Za-z]{3}/.test(s)) return false;
  if (/^[A-Z_0-9\s:]+$/.test(s) && s.length < 30) return false; // 全大写短常量
  if (s.startsWith("http") || s.startsWith("data:")) return false;
  if (/^[a-z][A-Za-z]*\.[A-Za-z]+$/.test(s)) return false; // file.ext
  return true;
}

function contextOf(node, sf) {
  let cur = node;
  let inT = false;
  let inImport = false;
  let inConsole = false;
  let nearestCall = "";
  let nearestProp = "";
  const chain = [];
  let depth = 0;
  while (cur && depth < 8) {
    if (ts.isCallExpression(cur) || ts.isNewExpression(cur)) {
      const expr = cur.expression;
      const name = expr && (expr.text || expr.getText(sf));
      if (name === "t") inT = true;
      if (name === "console" || (expr && expr.getText(sf).includes("console"))) inConsole = true;
      if (!nearestCall && name) nearestCall = name;
    }
    if (ts.isImportDeclaration(cur) || ts.isExportDeclaration(cur) || ts.isImportEqualsDeclaration(cur)) inImport = true;
    if (ts.isPropertyAssignment(cur) && cur.name) {
      if (!nearestProp) nearestProp = cur.name.getText(sf);
    }
    if (ts.isPropertyAccessExpression(cur) && !nearestProp) nearestProp = cur.name.text;
    chain.push(ts.SyntaxKind[cur.kind]);
    cur = cur.parent;
    depth++;
  }
  return {
    inT, inImport, inConsole,
    nearestCall,
    nearestProp,
    chain: chain.slice(0, 5).join("<"),
  };
}

const filter = process.argv[2] || "";
const rows = [];
for (const f of walk("src")) {
  const src = fs.readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
  (function visit(n) {
    let text = null;
    let raw = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      text = n.text; raw = n.getText(sf);
    } else if (ts.isTemplateExpression(n)) {
      text = n.head.text + n.templateSpans.map(s => s.literal.text).join(" ");
      raw = n.getText(sf);
    }
    if (text && isCandidate(text)) {
      const ctx = contextOf(n, sf);
      if (!ctx.inT && !ctx.inImport && !ctx.inConsole) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        rows.push({
          file: f.replace(/^src\//, ""), line,
          text: String(text).replace(/\n/g, "\\n").slice(0, 110),
          call: ctx.nearestCall, prop: ctx.nearestProp,
        });
      }
    }
    ts.forEachChild(n, visit);
  })(sf);
}

if (filter) {
  const hit = rows.filter(r => (r.file + r.text + r.call + r.prop).toLowerCase().includes(filter.toLowerCase()));
  console.log(`=== 过滤 "${filter}" 命中 ${hit.length} 条 ===`);
  hit.forEach(r => console.log(`${r.file}:${r.line} [call=${r.call} prop=${r.prop}] ${JSON.stringify(r.text)}`));
} else {
  console.log(`=== 疑似未翻译英文文案：${rows.length} 条 ===`);
  const byFile = {};
  for (const r of rows) (byFile[r.file] ||= []).push(r);
  Object.entries(byFile).sort((a,b) => b[1].length - a[1].length).forEach(([file, list]) => {
    console.log(`\n--- ${file} (${list.length}) ---`);
    list.forEach(r => console.log(`  ${r.line} [${r.call || "-"} ${r.prop ? "prop=" + r.prop : ""}] ${JSON.stringify(r.text)}`));
  });
}
