export type XPost = {
  category: "AI" | "Markets" | "Tech" | "Investing"; name: string; handle: string;
  time: string; text: string; likes: string; reposts: string; replies: string; color: string; url: string;
  source?: "live" | "mock"; symbol?: string; price?: string; change?: string;
};

export const xPosts: XPost[] = [
  { category: "AI", name: "NVIDIA", handle: "@nvidia", time: "10m", text: "AI demand remains extraordinary. Blackwell production is ramping across our partner ecosystem.", likes: "12.4K", reposts: "3.4K", replies: "873", color: "#76b900", url: "https://x.com/nvidia" },
  { category: "Markets", name: "The Kobeissi Letter", handle: "@KobeissiLetter", time: "28m", text: "US equity futures rise as markets price a softer inflation path. Treasury yields are easing from the session highs.", likes: "4.8K", reposts: "1.1K", replies: "286", color: "#111827", url: "https://x.com/KobeissiLetter" },
  { category: "Tech", name: "Microsoft", handle: "@Microsoft", time: "1h", text: "Cloud growth accelerates as companies move from AI pilots to production workloads across every industry.", likes: "8.1K", reposts: "2.3K", replies: "492", color: "#4385f5", url: "https://x.com/Microsoft" },
  { category: "Investing", name: "Aswath Damodaran", handle: "@AswathDamodaran", time: "2h", text: "A great company can still be a poor investment at the wrong price. Story, numbers and price must agree.", likes: "6.7K", reposts: "1.4K", replies: "319", color: "#7c5ce7", url: "https://x.com/AswathDamodaran" },
  { category: "Markets", name: "Charlie Bilello", handle: "@charliebilello", time: "3h", text: "Market breadth is improving: more stocks are now participating in the advance than at last month's high.", likes: "3.9K", reposts: "892", replies: "174", color: "#ef8b2c", url: "https://x.com/charliebilello" },
];

export const socialBuzz = ["NVDA", "TSLA", "MSFT", "AAPL", "AMZN"];
export const trendingKeywords = ["AI", "Markets", "Earnings", "Semiconductors"];
