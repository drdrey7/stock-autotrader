/** Restrict report links to web URLs or unambiguous same-origin paths/fragments. */
export function safeMarkdownUrl(url: string): string {
  if (url.startsWith("#") || (url.startsWith("/") && !url.startsWith("//"))) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}
