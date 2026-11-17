/**
 * Second-pass codemod: wrap UI strings assigned via direct properties:
 *   obj.placeholder = "..."
 *   obj.textContent = "..."
 *   { placeholder: "..." }
 * Only ASCII-english-looking strings that are clearly UI text are wrapped.
 * Reuses t() import.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

const PROP_NAMES = new Set(["placeholder", "textContent", "innerText", "title", "ariaLabel"]);

function collectTsFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "i18n") collectTsFiles(p, out); }
        else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
    return out;
}

function isUiText(s) {
    // Wrap strings that look like human-readable English (>=2 letters in a word, or known labels)
    if (!s || s.length === 0) return false;
    if (/^[A-Za-z][A-Za-z ]+[.:!?]?$/.test(s)) return true; // "Name:", "Loading caption..."
    if (/[a-z]{2,}/.test(s)) return true;
    return false;
}

function buildWrapper(node, sf) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return { text: `t(${JSON.stringify(node.text)})`, key: node.text };
    }
    if (ts.isTemplateExpression(node)) {
        let key = node.head.text;
        const params = [];
        node.templateSpans.forEach((span, i) => {
            const name = `p${i}`;
            key += `{${name}}` + span.literal.text;
            params.push(`${name}: ${span.expression.getText(sf)}`);
        });
        return { text: `t(${JSON.stringify(key)}, { ${params.join(", ")} })`, key };
    }
    return null;
}

const keys = new Set();
let count = 0;
for (const file of collectTsFiles(SRC)) {
    const source = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const edits = [];

    (function visit(n) {
        // obj.prop = "..."  (assignment)
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(n.left) && PROP_NAMES.has(n.left.name.text)) {
            const r = n.right;
            if ((ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r) || ts.isTemplateExpression(r)) && isUiText(r.text ?? "")) {
                const w = buildWrapper(r, sf);
                if (w) { edits.push({ start: r.getStart(sf), end: r.getEnd(), text: w.text }); keys.add(w.key); }
            }
        }
        // { placeholder: "..." } object literal property
        if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && PROP_NAMES.has(n.name.text)) {
            const r = n.initializer;
            if ((ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r)) && isUiText(r.text)) {
                const w = buildWrapper(r, sf);
                if (w) { edits.push({ start: r.getStart(sf), end: r.getEnd(), text: w.text }); keys.add(w.key); }
            }
        }
        ts.forEachChild(n, visit);
    })(sf);

    if (!edits.length) continue;
    edits.sort((a, b) => a.start - b.start);
    const filtered = [];
    for (const e of edits) {
        if (filtered.length && e.start < filtered[filtered.length - 1].end) continue;
        filtered.push(e);
    }
    let out = source;
    for (let i = filtered.length - 1; i >= 0; i--) {
        const e = filtered[i];
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    if (/\bt\(/.test(out) && !/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["'][^"']*i18n["']/.test(out)) {
        const rel = path.relative(SRC, file).split(path.sep).join("/");
        const dir = path.dirname(rel);
        const ups = dir === "." ? "" : dir.split("/").map(() => "..").join("/") + "/";
        out = `import { t } from "${ups}i18n";\n` + out;
    }
    fs.writeFileSync(file, out, "utf8");
    count += filtered.length;
    console.log(`${path.relative(ROOT, file)} (${filtered.length})`);
}

fs.writeFileSync(path.join(ROOT, "scripts", "i18n-keys-props.json"), JSON.stringify([...keys].sort(), null, 2), "utf8");
console.log(`Wrapped ${count} property-assigned UI strings.`);
console.log("New keys:", [...keys].filter(k => k.length > 1).join(" | "));
