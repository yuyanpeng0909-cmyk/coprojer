/** Extract the document from a model reply without rendering its surrounding Markdown. */
export function extractPrototypeHtml(response: string): string {
  function documentIn(text: string): string | null {
    // Ignore comments and raw-text elements so examples such as '</html>' in scripts
    // cannot terminate the document early.
    const tags =
      /<!--[\s\S]*?-->|<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>|<!doctype\s+html\b[^>]*>|<html(?=[\s>])[^>]*>|<\/html\s*>/gi
    let start = -1
    let root = false
    for (const match of text.matchAll(tags)) {
      const tag = match[0]
      if (/^<!doctype/i.test(tag) && start < 0) start = match.index!
      else if (/^<html(?=[\s>])/i.test(tag)) {
        if (root) throw new Error('模型返回了多个或嵌套的 HTML 文档，请生成一个完整原型。')
        if (start < 0) start = match.index!
        root = true
      } else if (/^<\/html/i.test(tag) && root) {
        return text.slice(start, match.index! + tag.length).trim()
      }
    }
    return null
  }
  // Prefer an HTML code block when the reply contains introductory explanations.
  const fences = /^[ \t]*(`{3,}|~{3,})(?:html)?[ \t]*\r?\n([\s\S]*?)^[ \t]*\1[ \t]*$/gim
  const documents = [...response.matchAll(fences)]
    .map((match) => documentIn(match[2]))
    .filter((html): html is string => html !== null)
  if (documents.length > 1) throw new Error('模型返回了多个 HTML 原型，请每次生成一个版本。')
  const html = documents[0] ?? documentIn(response)
  if (!html || html.length > 350000)
    throw new Error('设计模型未返回完整 HTML 原型，原始输出已保存，请继续调整设计要求。')
  return html
}
