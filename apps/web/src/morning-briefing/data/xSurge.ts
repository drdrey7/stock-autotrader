import type { DataSource } from "./source";

export type XPost = {
  category: "AI" | "Markets" | "Tech" | "Investing"; name: string; handle: string;
  time: string; createdAt: string; text: string; likes: string; reposts: string; replies: string; color: string; url: string;
  source?: DataSource; symbol?: string; price?: string; change?: string;
};

export const trackedXAccounts = ["@nolimitgains"] as const;

export const xPosts: XPost[] = [
  { category: "Markets", name: "No Limit Gains", handle: "@nolimitgains", time: "21h", createdAt: "2026-08-11T21:26:06.020Z", text: "Two scenarios for GOOGL and MSFT from an earlier call both played out at the same time: $GOOGL down 11% while $MSFT is up 22%.", likes: "—", reposts: "—", replies: "—", color: "#111827", url: "https://x.com/NoLimitGains/status/2087289477349654744" },
  { category: "Investing", name: "No Limit Gains", handle: "@nolimitgains", time: "21h", createdAt: "2026-08-11T21:16:57.502Z", text: "Shared a chart of something that went +1000% to -75% in a single day and asked what pattern followers would call it.", likes: "—", reposts: "—", replies: "—", color: "#111827", url: "https://x.com/NoLimitGains/status/2087287176698462335" },
  { category: "Markets", name: "No Limit Gains", handle: "@nolimitgains", time: "22h", createdAt: "2026-08-11T20:38:31.491Z", text: "$ONON at its lowest valuation ever, with chart.", likes: "—", reposts: "—", replies: "—", color: "#111827", url: "https://x.com/NoLimitGains/status/2087277504587346054" },
];
