export type XPost = {
  category: "AI" | "Markets" | "Tech" | "Investing"; name: string; handle: string;
  time: string; text: string; likes: string; reposts: string; replies: string; color: string; url: string;
  source?: "live" | "mock"; symbol?: string; price?: string; change?: string;
};

export const trackedXAccounts = ["@nolimitgains"] as const;

export const xPosts: XPost[] = [
  { category: "Markets", name: "No Limit Gains", handle: "@nolimitgains", time: "21h", text: "Two scenarios for GOOGL and MSFT from an earlier call both played out at the same time: $GOOGL down 11% while $MSFT is up 22%.", likes: "—", reposts: "—", replies: "—", color: "#111827", url: "https://x.com/NoLimitGains/status/2087289477349654744" },
  { category: "Investing", name: "No Limit Gains", handle: "@nolimitgains", time: "21h", text: "Shared a chart of something that went +1000% to -75% in a single day and asked what pattern followers would call it.", likes: "—", reposts: "—", replies: "—", color: "#111827", url: "https://x.com/NoLimitGains/status/2087287176698462335" },
  { category: "Markets", name: "No Limit Gains", handle: "@nolimitgains", time: "22h", text: "$ONON at its lowest valuation ever, with chart.", likes: "—", reposts: "—", replies: "—", color: "#111827", url: "https://x.com/NoLimitGains/status/2087277504587346054" },
];

export const socialBuzz = ["NVDA", "TSLA", "MSFT", "AAPL", "AMZN"];
export const trendingKeywords = ["AI", "Markets", "Earnings", "Semiconductors"];
