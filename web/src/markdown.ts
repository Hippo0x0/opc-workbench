import { Marked, Renderer } from "marked";

const escape = (value: string): string => value.replace(/[&<>"']/gu, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** 仅渲染 Markdown；原始 HTML 和远程图片不进入页面，链接只允许安全协议。 */
export function reportMarkdown(value: string): string {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escape(text);
  renderer.image = ({ text }) => escape(text);
  renderer.link = function ({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    try {
      const url = new URL(href, "https://localhost");
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) return label;
      return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ""} target="_blank" rel="noopener noreferrer">${label}</a>`;
    } catch { return label; }
  };
  const markdown = new Marked({ renderer, gfm: true, breaks: true, async: false, extensions: [{
    name: "compactLabelStrong",
    level: "inline",
    start: source => source.indexOf("**"),
    tokenizer(source) {
      // 中文标点后的 ** 紧贴正文时，CommonMark 不认为它是闭合符。
      // 仅兼容纯文本；代码、转义和含嵌套标记的内容仍由原解析器处理。
      const match = /^\*\*([^\s*`<\\][^*`<\\\n]*\p{P})\*\*(?=[\p{L}\p{N}])/u.exec(source);
      if (match) return { type: "compactLabelStrong", raw: match[0], text: match[1] };
    },
    renderer: token => `<strong>${escape(typeof token.text === "string" ? token.text : "")}</strong>`,
  }] });
  return markdown.parse(value, { async: false });
}
