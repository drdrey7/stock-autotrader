/** Same-origin internal return paths only. Anything else falls back to /app. */
export function safeReturnPath(next: string | null | undefined, origin = typeof window !== "undefined" ? window.location.origin : "http://localhost"): string {
  if (!next) return "/app";

  // Reject scheme-relative, backslash, and encoded-backslash open redirects before URL parsing.
  if (
    !next.startsWith("/")
    || next.startsWith("//")
    || next.includes("\\")
    || /%5c/i.test(next)
  ) {
    return "/app";
  }

  try {
    const parsed = new URL(next, origin);
    if (parsed.origin !== new URL(origin).origin) return "/app";
    // Defend against parsers that normalize odd paths into a different host.
    if (parsed.username || parsed.password) return "/app";
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/app";
  } catch {
    return "/app";
  }
}
