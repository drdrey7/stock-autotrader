export type Opportunity = {
  ticker: string; company: string; change: number | null; confidence: "High" | "Medium" | null;
  score: number | null; thesis: string; trigger: string; risk: string; color: string;
  source?: "live" | "mock"; verdict?: string; invalidation?: string; objective?: string; reference?: string;
};

export const opportunities: Opportunity[] = [
  { ticker: "NVDA", company: "NVIDIA Corporation", change: 2.34, confidence: "High", score: 91, thesis: "Semiconductor leadership continues as price holds above the breakout zone on expanding volume.", trigger: "$184.20", risk: "$176.80", color: "#76b900" },
  { ticker: "MSFT", company: "Microsoft", change: 1.42, confidence: "High", score: 88, thesis: "Cloud momentum and improving relative strength place Microsoft near a fresh continuation setup.", trigger: "$528.40", risk: "$512.00", color: "#4385f5" },
  { ticker: "NOW", company: "ServiceNow", change: 1.87, confidence: "Medium", score: 79, thesis: "Constructive base formation with improving momentum, but confirmation above resistance is still required.", trigger: "$919.50", risk: "$884.00", color: "#111827" },
  { ticker: "AMD", company: "Advanced Micro Devices", change: 1.76, confidence: "Medium", score: 76, thesis: "AI accelerator demand supports the trend while price approaches a key technical decision point.", trigger: "$184.70", risk: "$176.10", color: "#171717" },
];
