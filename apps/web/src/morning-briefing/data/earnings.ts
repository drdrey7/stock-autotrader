export type EarningsCompany = {
  ticker: string; company: string; date: string; timing: "BMO" | "AMC" | "TBD";
  result: "Beat" | "Miss" | "Mixed" | "Upcoming"; epsActual?: string; epsExpected: string;
  revenueActual?: string; revenueExpected: string; reaction?: string;
  guidance: "Raised" | "Maintained" | "Lowered" | "Pending"; revenueYoy?: string;
  epsYoy?: string; margin?: string; segment?: string; officialUrl?: string; color: string;
  source?: "live" | "mock"; eventSignal?: "Confirmed" | "Pending" | "Risk Window";
};

export const earnings: EarningsCompany[] = [
  { ticker: "AAPL", company: "Apple", date: "2026-08-14", timing: "AMC", result: "Upcoming", epsExpected: "$1.44", revenueExpected: "$92.8B", guidance: "Pending", officialUrl: "https://investor.apple.com/", color: "#222" },
  { ticker: "MSFT", company: "Microsoft", date: "2026-08-15", timing: "AMC", result: "Upcoming", epsExpected: "$2.94", revenueExpected: "$65.5B", guidance: "Pending", officialUrl: "https://www.microsoft.com/en-us/Investor", color: "#4385f5" },
  { ticker: "NVDA", company: "NVIDIA", date: "2026-08-16", timing: "AMC", result: "Upcoming", epsExpected: "$0.67", revenueExpected: "$30.9B", guidance: "Pending", officialUrl: "https://investor.nvidia.com/", color: "#76b900" },
  { ticker: "WMT", company: "Walmart", date: "2026-08-20", timing: "BMO", result: "Upcoming", epsExpected: "$0.73", revenueExpected: "$176.2B", guidance: "Pending", officialUrl: "https://stock.walmart.com/", color: "#1675d1" },
  { ticker: "CRM", company: "Salesforce", date: "2026-08-26", timing: "AMC", result: "Upcoming", epsExpected: "$2.78", revenueExpected: "$10.1B", guidance: "Pending", officialUrl: "https://investor.salesforce.com/", color: "#18a5de" },
  { ticker: "MSFT", company: "Microsoft", date: "2026-07-30", timing: "AMC", result: "Beat", epsActual: "$3.65", epsExpected: "$3.37", revenueActual: "$76.4B", revenueExpected: "$73.8B", reaction: "+4.8%", guidance: "Raised", revenueYoy: "+18%", epsYoy: "+24%", margin: "45.1%", segment: "Azure +39%", officialUrl: "https://www.microsoft.com/en-us/Investor", color: "#4385f5" },
  { ticker: "AAPL", company: "Apple", date: "2026-07-31", timing: "AMC", result: "Mixed", epsActual: "$1.61", epsExpected: "$1.58", revenueActual: "$93.2B", revenueExpected: "$94.0B", reaction: "-1.4%", guidance: "Maintained", revenueYoy: "+5%", epsYoy: "+9%", margin: "46.2%", segment: "Services +12%", officialUrl: "https://investor.apple.com/", color: "#222" },
  { ticker: "AMZN", company: "Amazon", date: "2026-07-24", timing: "AMC", result: "Beat", epsActual: "$1.68", epsExpected: "$1.31", revenueActual: "$177.9B", revenueExpected: "$175.1B", reaction: "+4.3%", guidance: "Raised", revenueYoy: "+13%", epsYoy: "+31%", margin: "11.8%", segment: "AWS +19%", officialUrl: "https://ir.aboutamazon.com/", color: "#f59e0b" },
  { ticker: "META", company: "Meta Platforms", date: "2026-07-29", timing: "AMC", result: "Beat", epsActual: "$7.14", epsExpected: "$6.08", revenueActual: "$49.3B", revenueExpected: "$47.9B", reaction: "+6.7%", guidance: "Raised", revenueYoy: "+22%", epsYoy: "+36%", margin: "43.0%", segment: "Ads +21%", officialUrl: "https://investor.atmeta.com/", color: "#1877f2" },
  { ticker: "TSLA", company: "Tesla", date: "2026-04-22", timing: "AMC", result: "Miss", epsActual: "$0.39", epsExpected: "$0.46", revenueActual: "$22.1B", revenueExpected: "$23.4B", reaction: "-5.2%", guidance: "Lowered", revenueYoy: "-7%", epsYoy: "-18%", margin: "7.4%", segment: "Auto -9%", officialUrl: "https://ir.tesla.com/", color: "#e82127" },
];

export const takeaways: Record<string, string[]> = {
  MSFT: ["Revenue and EPS exceeded consensus estimates.", "Azure growth accelerated as AI workloads moved into production.", "Operating leverage improved despite higher infrastructure investment.", "Management raised the next-quarter revenue outlook."],
  AAPL: ["EPS was ahead of expectations, while revenue finished slightly below consensus.", "Services remained the strongest segment.", "Gross margin stayed resilient.", "Management maintained its prior outlook."],
  AMZN: ["AWS growth remained healthy and margins expanded.", "Retail efficiency supported a stronger operating result.", "Advertising growth remained above the company average."],
  META: ["Advertising demand and AI recommendations lifted engagement.", "Revenue and margins exceeded expectations.", "Management raised full-year capital expenditure guidance."],
  TSLA: ["Vehicle revenue declined and pricing pressure persisted.", "Energy storage remained a bright spot.", "Management lowered near-term delivery expectations."],
};
