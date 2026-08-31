import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { safeMarkdownUrl } from "../../lib/analysis/markdown-url";

const ALLOWED_ELEMENTS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
] as const;

function TableScroller({ children }: { children?: ReactNode }) {
  return <div className="ai-report-table-scroll"><table>{children}</table></div>;
}

const components: Components = {
  a: ({ href = "", children, node, ...props }) => {
    // node is the HAST element from react-markdown; discard it before spreading
    // so it never reaches the DOM as an invalid attribute.
    void node;
    const safeHref = safeMarkdownUrl(href);
    if (!safeHref) return <span>{children}</span>;
    const external = safeHref.startsWith("http://") || safeHref.startsWith("https://");
    return (
      <a
        {...props}
        href={safeHref}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    );
  },
  table: TableScroller,
};

export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown
        allowedElements={[...ALLOWED_ELEMENTS]}
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeMarkdownUrl}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
