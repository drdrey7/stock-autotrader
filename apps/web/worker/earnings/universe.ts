import sp500 from "../../../publisher/data/sp500.v1.json";
import nasdaq100 from "../../../publisher/data/nasdaq100.v1.json";

export type EarningsUniverseIndex = "S&P 500" | "Nasdaq-100";

export interface EarningsUniverseMember {
  symbol: string;
  indexes: EarningsUniverseIndex[];
}

type UniverseFile = {
  version: string;
  index: EarningsUniverseIndex;
  symbols: string[];
};

const normalizeSymbol = (symbol: string): string => symbol.trim().toUpperCase().replace(/\./g, "-");

function readSymbols(file: UniverseFile): Map<string, EarningsUniverseIndex[]> {
  const members = new Map<string, EarningsUniverseIndex[]>();
  for (const rawSymbol of file.symbols) {
    const symbol = normalizeSymbol(rawSymbol);
    if (!/^[A-Z0-9-]{1,12}$/.test(symbol)) continue;
    const indexes = members.get(symbol) ?? [];
    if (!indexes.includes(file.index)) indexes.push(file.index);
    members.set(symbol, indexes);
  }
  return members;
}

const sp500File = sp500 as UniverseFile;
const nasdaq100File = nasdaq100 as UniverseFile;

if (sp500File.version !== nasdaq100File.version) {
  throw new Error("earnings universe snapshots must use the same version");
}

const allMembers = readSymbols(sp500File);
for (const [symbol, indexes] of readSymbols(nasdaq100File)) {
  const current = allMembers.get(symbol) ?? [];
  for (const index of indexes) {
    if (!current.includes(index)) current.push(index);
  }
  allMembers.set(symbol, current);
}

export const EARNINGS_UNIVERSE_VERSION = sp500File.version;
export const EARNINGS_UNIVERSE: readonly EarningsUniverseMember[] = [...allMembers.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([symbol, indexes]) => ({ symbol, indexes }));
export const EARNINGS_UNIVERSE_SYMBOLS: ReadonlySet<string> = new Set(EARNINGS_UNIVERSE.map(({ symbol }) => symbol));

export function isInEarningsUniverse(symbol: string): boolean {
  return EARNINGS_UNIVERSE_SYMBOLS.has(normalizeSymbol(symbol));
}

export { normalizeSymbol };
