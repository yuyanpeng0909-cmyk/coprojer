const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('typescript')
const compiled = ts.transpileModule(fs.readFileSync('src/shared/prototype.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const api = {}
new Function('exports', compiled)(api)
const extract = api.extractPrototypeHtml
const html =
  '<!DOCTYPE html>\n<html lang="zh"><head><style>body{color:black}</style></head><body><p>原型正文</p><script>const example = "</html>";</script><!-- </html> --></body></html>'
for (const reply of [
  html,
  '\uFEFF' + html,
  '开场说明\n```html\n' + html + '\n```\n结尾说明',
  '开场说明\n' + html + '\n结尾说明',
  '说明\n~~~HTML\n' + html + '\n~~~\n后记',
]) {
  assert.equal(extract(reply), html)
}
assert.equal(
  extract('说明\n```html\n<html><body>无 doctype</body></html>\n```'),
  '<html><body>无 doctype</body></html>',
)
assert.throws(() => extract('只有说明和 <html><body>未完成'))
assert.throws(() => extract('```html\n' + html + '\n```\n```html\n' + html + '\n```'), /多个/)
console.log(
  'PASS: prototype document boundaries, Markdown wrappers, trailing prose, script/comment closing-tag literals, incomplete and ambiguous outputs',
)
