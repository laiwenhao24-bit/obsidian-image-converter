/**
 * codemod-i18n.mjs
 *
 * Wraps user-facing string literals with t() for i18n, using the TypeScript
 * compiler API so only real UI call sites are touched (never comments, data
 * values, CSS classes, or variable templates).
 *
 * Targets:
 *  - new Notice("...")            -> first arg
 *  - .setName/.setDesc/.setTooltip/.setPlaceholder/.setButtonText/.setTitle/.setText
 *                                  -> first arg (string/template literal only)
 *  - .addOption(value, "Label")   -> second arg
 *  - { text: "..." } inside createEl/createSpan/createDiv/createP/createEl-style DOM calls
 *
 * Template literals with ${...} are converted to t("...{p0}...", { p0: <expr> }).
 * Already-wrapped t(...) calls are skipped.
 *
 * Collects all keys into scripts/i18n-keys.json.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const KEYS_OUT = path.join(ROOT, "scripts", "i18n-keys.json");

const METHOD_FIRST = new Set([
    "setName", "setDesc", "setTooltip", "setPlaceholder",
    "setButtonText", "setTitle", "setEmptyStateText", "setNotice",
    "setText",
]);
const DOM_FACTORIES = new Set([
    "createEl", "createSpan", "createDiv", "createP", "createH1", "createH2",
    "createH3", "createH4", "createEl", "createFrag", "appendText",
]);

function isStringLike(node) {
    return (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)
    );
}

/** Build t(...) call text from a string-like node. Returns null if not wrappable. */
function buildWrapper(node, sf, collectKey) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const raw = node.text; // decoded text
        collectKey(raw);
        return `t(${JSON.stringify(raw)})`;
    }
    if (ts.isTemplateExpression(node)) {
        // head.text + ${expr0} + literal0.text + ${expr1} + literal1.text ...
        let key = node.head.text;
        const params = [];
        node.templateSpans.forEach((span, i) => {
            const name = `p${i}`;
            key += `{${name}}`;
            params.push({ name, expr: span.expression.getText(sf) });
            key += span.literal.text;
        });
        collectKey(key);
        const paramText = params.map((p) => `${p.name}: ${p.expr}`).join(", ");
        return `t(${JSON.stringify(key)}, { ${paramText} })`;
    }
    return null;
}

function methodNameOf(expr) {
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    return null;
}

function calleeNameOf(call) {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return null;
}

function isNewNotice(call) {
    return ts.isNewExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "Notice";
}

function isAlreadyT(node) {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t";
}

function relativeImport(fromFile) {
    const dir = path.dirname(path.relative(SRC, fromFile)).split(path.sep).join("/");
    if (!dir || dir === ".") return "./i18n";
    const ups = dir.split("/").map(() => "..").join("/");
    return `${ups}/i18n`;
}

function collectTsFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "i18n") continue;
            collectTsFiles(p, out);
        } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
            out.push(p);
        }
    }
    return out;
}

const keys = new Set();
const files = collectTsFiles(SRC);
let totalEdits = 0;
const changedFiles = [];

for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const edits = [];

    const collectKey = (k) => { if (k && k.trim()) keys.add(k); };

    function visit(node, parent) {
        // CallExpression / NewExpression targets
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const args = node.arguments ?? [];
            if (isNewNotice(node)) {
                if (args[0] && isStringLike(args[0]) && !isAlreadyT(args[0])) {
                    const w = buildWrapper(args[0], sf, collectKey);
                    if (w) edits.push({ start: args[0].getStart(sf), end: args[0].getEnd(), text: w });
                }
            } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "ConfirmDialog") {
                // ConfirmDialog(app, title, message, confirmText, callback)
                for (const idx of [1, 2, 3]) {
                    const a = args[idx];
                    if (a && isStringLike(a) && !isAlreadyT(a)) {
                        const w = buildWrapper(a, sf, collectKey);
                        if (w) edits.push({ start: a.getStart(sf), end: a.getEnd(), text: w });
                    }
                }
            } else if (ts.isCallExpression(node)) {
                const m = methodNameOf(node.expression);
                if (m && METHOD_FIRST.has(m)) {
                    if (args[0] && isStringLike(args[0]) && !isAlreadyT(args[0])) {
                        const w = buildWrapper(args[0], sf, collectKey);
                        if (w) edits.push({ start: args[0].getStart(sf), end: args[0].getEnd(), text: w });
                    }
                } else if (m === "addOption" && args.length >= 2) {
                    if (args[1] && isStringLike(args[1]) && !isAlreadyT(args[1])) {
                        const w = buildWrapper(args[1], sf, collectKey);
                        if (w) edits.push({ start: args[1].getStart(sf), end: args[1].getEnd(), text: w });
                    }
                } else if (m === "addInfoIcon" && args.length >= 2) {
                    if (args[1] && isStringLike(args[1]) && !isAlreadyT(args[1])) {
                        const w = buildWrapper(args[1], sf, collectKey);
                        if (w) edits.push({ start: args[1].getStart(sf), end: args[1].getEnd(), text: w });
                    }
                }
                // { text: "..." } in DOM factory calls
                const callee = calleeNameOf(node);
                if (callee && DOM_FACTORIES.has(callee)) {
                    for (const arg of args) {
                        if (ts.isObjectLiteralExpression(arg)) {
                            for (const prop of arg.properties) {
                                if (
                                    ts.isPropertyAssignment(prop) &&
                                    prop.name && ts.isIdentifier(prop.name) && prop.name.text === "text" &&
                                    isStringLike(prop.initializer) && !isAlreadyT(prop.initializer)
                                ) {
                                    const w = buildWrapper(prop.initializer, sf, collectKey);
                                    if (w) edits.push({ start: prop.initializer.getStart(sf), end: prop.initializer.getEnd(), text: w });
                                }
                            }
                        }
                    }
                }
            }
        }

        ts.forEachChild(node, (child) => visit(child, node));
    }
    visit(sf, null);

    if (edits.length === 0) continue;

    // de-dupe / drop overlapping edits (defensive)
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

    // Add import if we introduced t() and none exists
    if (/\bt\(/.test(out) && !/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["'][^"']*i18n["']/.test(out)) {
        const imp = `import { t } from "${relativeImport(file)}";\n`;
        out = imp + out;
    }

    fs.writeFileSync(file, out, "utf8");
    totalEdits += filtered.length;
    changedFiles.push(path.relative(ROOT, file) + ` (${filtered.length})`);
}

fs.writeFileSync(KEYS_OUT, JSON.stringify([...keys].sort(), null, 2), "utf8");

console.log(`Wrapped ${totalEdits} string literals across ${changedFiles.length} files.`);
console.log(changedFiles.join("\n"));
console.log(`Collected ${keys.size} unique keys -> scripts/i18n-keys.json`);
