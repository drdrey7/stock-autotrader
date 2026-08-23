import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SafeMarkdown } from "./SafeMarkdown";
import { safeMarkdownUrl } from "./markdown-url";

afterEach(cleanup);

describe("SafeMarkdown", () => {
  it("allows explicit web URLs, fragments and single-slash application paths", () => {
    expect(safeMarkdownUrl("https://example.com/research?q=1")).toBe("https://example.com/research?q=1");
    expect(safeMarkdownUrl("http://example.com/")).toBe("http://example.com/");
    expect(safeMarkdownUrl("#risk")).toBe("#risk");
    expect(safeMarkdownUrl("/stocks/NVDA")).toBe("/stocks/NVDA");
  });

  it("rejects executable, data and protocol-relative URLs", () => {
    expect(safeMarkdownUrl("javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrl("data:text/html,hello")).toBe("");
    expect(safeMarkdownUrl("//evil.example/steal")).toBe("");

    render(<SafeMarkdown>{"[unsafe](//evil.example/steal) [script](javascript:alert(1))"}</SafeMarkdown>);
    expect(screen.queryByRole("link", { name: "unsafe" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "script" })).not.toBeInTheDocument();
    expect(screen.getByText("unsafe")).toBeInTheDocument();
  });

  it("opens external links safely and ignores embedded HTML", () => {
    render(<SafeMarkdown>{"[Source](https://example.com/report)\n\n<script>alert('x')</script>\n\n| A | B |\n| - | - |\n| 1 | 2 |"}</SafeMarkdown>);
    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute("target", "_blank");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
