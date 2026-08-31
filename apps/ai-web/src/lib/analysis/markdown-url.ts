/** Restrict report links to web URLs or unambiguous same-origin paths/fragments. */
const RELATIVE_BASE = "https://safe-markdown.invalid";

export function safeMarkdownUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url, RELATIVE_BASE);
    if (url.startsWith("#") || url.startsWith("/")) {
      return parsed.origin === RELATIVE_BASE ? url : "";
    }
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}
