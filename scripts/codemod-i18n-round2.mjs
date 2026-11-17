/**
 * codemod-i18n-round2.mjs
 *
 * Second pass: wrap UI strings missed by round 1.
 * Targets (all verified zero-risk — no data keys, no technical tokens):
 *  - bare addInfoIcon(setting, "tooltip")            -> arg[1]
 *  - .addOptions({ key: "Label" })                   -> object property VALUES only
 *  - bare addLine("...") / createSummaryItem(...) / createSectionTitle(...) /
 *    createCompactInputWithPreset("label","desc",...)  -> positional args
 *  - errors.push("...")                             -> arg[0]
 *  - VariableProcessor description/example fields   -> object property VALUES
 *  - string concatenation "a" + "b" passed to setName/setDesc
 *
 * Collects keys into scripts/i18n-keys-v2.json
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
const KEYS_OUT = path.join(ROOT, "scripts", "i18n-keys-v2.json");

const BARE_FN_ARGS = new Map([
    ["addInfoIcon", [1]],
    ["addLine", [0]],
    ["createSummaryItem", [0]],
    ["createSectionTitle", [0]],
    ["createCompactInputWithPreset", [0, 1]],
    ["errors.push", [0]],
]);
const CONCAT_METHODS = new Set(["setName", "setDesc", "setTooltip", "setPlaceholder"]);
const VP_FIELDS = new Set(["description", "example"]);

function isStringLike(node) {
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}
function isAlreadyT(node) {
    return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t";
}
function methodNameOf(expr) {
    return ts.isPropertyAccessExpression(expr) ? expr.name.text : null;
}
function calleePath(call) {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
        return `${e.expression.text}.${e.name.text}`;
    }
    return null;
}
function buildWrapper(node, sf, collect) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const raw = node.text;
        collect(raw);
        return `t(${JSON.stringify(raw)})`;
    }
    if (ts.isTemplateExpression(node)) {
        let key = node.head.text;
        const params = [];
        node.templateSpans.forEach((span, i) => {
            key += `{p${i}}`;
            params.push(`p${i}: ${span.expression.getText(sf)}`);
            key += span.literal.text;
        });
        collect(key);
        return `t(${JSON.stringify(key)}, { ${params.join(", ")} })`;
    }
    return null;
}
/** A string is UI-ish if it has letters and (spaces or is a short UI word). */
function isUiString(text) {
    if (!text || !/[A-Za-z]{2}/.test(text)) return false;
    // Skip obvious technical tokens
    if (/^[A-Z_0-9\s.:\/-]+$/.test(text) && text.length < 24) return false;
    if (/^https?:/.test(text)) return false;
    if (/^[.#@*\/\[\]]/.test(text)) return false;
    if (/^[A-Za-z0-9_./:@#?=&%{}+()$-]+$/.test(text) && !/\s/.test(text) && text.length > 30) return false;
    return true;
}
function collectTsFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "i18n") collectTsFiles(p, out); }
        else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
    return out;
}

const keys = new Set();
const collect = (k) => { if (k && k.trim() && isUiString(k)) keys.add(k); };
const files = collectTsFiles(SRC);
let totalEdits = 0;
const changed = [];

for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const edits = [];
    const isVariableProcessor = file.endsWith("VariableProcessor.ts");

    function visit(node) {
        if (ts.isCallExpression(node)) {
            const args = node.arguments;
            const pathName = calleePath(node);
            const m = methodNameOf(node.expression);

            // bare function positional args
            if (pathName && BARE_FN_ARGS.has(pathName)) {
                for (const idx of BARE_FN_ARGS.get(pathName)) {
                    const a = args[idx];
                    if (a && isStringLike(a) && !isAlreadyT(a)) {
                        const w = buildWrapper(a, sf, collect);
                        if (w) edits.push({ start: a.getStart(sf), end: a.getEnd(), text: w });
                    }
                }
            }

            // .addOptions({ key: "Label" }) -> wrap VALUES only
            if (m === "addOptions" && args[0] && ts.isObjectLiteralExpression(args[0])) {
                for (const prop of args[0].properties) {
                    if (ts.isPropertyAssignment(prop) && isStringLike(prop.initializer) && !isAlreadyT(prop.initializer)) {
                        const w = buildWrapper(prop.initializer, sf, collect);
                        if (w) edits.push({ start: prop.initializer.getStart(sf), end: prop.initializer.getEnd(), text: w });
                    }
                }
            }

            // "a" + "b" concatenation passed to setName/setDesc etc.
            if (m && CONCAT_METHODS.has(m) && args[0] && ts.isBinaryExpression(args[0])) {
                function walkBinary(bin) {
                    for (const side of [bin.left, bin.right]) {
                        if (ts.isBinaryExpression(side) && side.operatorToken.kind === ts.SyntaxKind.PlusToken) {
                            walkBinary(side);
                        } else if (isStringLike(side) && !isAlreadyT(side)) {
                            const w = buildWrapper(side, sf, collect);
                            if (w) edits.push({ start: side.getStart(sf), end: side.getEnd(), text: w });
                        }
                    }
                }
                walkBinary(args[0]);
            }

            // VariableProcessor object literal description/example fields
            if (isVariableProcessor && args[0] && ts.isObjectLiteralExpression(args[0])) {
                for (const prop of args[0].properties) {
                    if (ts.isPropertyAssignment(prop) && prop.name &&
                        ((ts.isIdentifier(prop.name) && VP_FIELDS.has(prop.name.text)) ||
                         (ts.isStringLiteral(prop.name) && VP_FIELDS.has(prop.name.text))) &&
                        isStringLike(prop.initializer) && !isAlreadyT(prop.initializer)) {
                        const w = buildWrapper(prop.initializer, sf, collect);
                        if (w) edits.push({ start: prop.initializer.getStart(sf), end: prop.initializer.getEnd(), text: w });
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sf);

    if (edits.length === 0) continue;
    edits.sort((a, b) => a.start - b.start);
    const filtered = [];
    for (const e of edits) {
        if (filtered.length && e.start < filtered[filtered.length - 1].end) continue;
        filtered.push(e);
    }
    let out = source;
    for (const e of filtered.slice().reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);

    // Ensure t import
    if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*["'][^"']*i18n["']/.test(out)) {
        const rel = path.relative(path.dirname(file), path.join(SRC, "i18n")).split(path.sep).join("/").replace(/^\.\//, "");
        const imp = `import { t } from "${rel.startsWith(".") ? rel : "./" + rel}";\n`;
        out = imp + out;
    }
    fs.writeFileSync(file, out, "utf8");
    totalEdits += filtered.length;
    changed.push(`${path.relative(ROOT, file)}: ${filtered.length}`);
}

fs.writeFileSync(KEYS_OUT, JSON.stringify([...keys].sort(), null, 2), "utf8");
console.log(`Wrapped ${totalEdits} strings across ${changed.length} files.`);
console.log(changed.join("\n"));
console.log(`Unique keys: ${keys.size}`);
