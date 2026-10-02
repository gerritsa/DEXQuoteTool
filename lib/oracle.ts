const THORCHAIN_ORACLE_PRICES = "https://gateway.liquify.com/chain/thorchain_api/thorchain/oracle/prices";

type OraclePrice = { symbol: string; price: string };
type OraclePricesResponse = { prices?: OraclePrice[] } | OraclePrice[];

// THORChain publishes a BTC reference price, while the Ethereum-wrapped asset
// is named WBTC in the route catalog. Both represent the same underlying asset
// for the cross-rate used to compare quote outputs.
const oracleSymbolAliases: Record<string, string> = {
  WBTC: "BTC",
};

export type OracleSnapshot = {
  sourceSymbol: string;
  destinationSymbol: string;
  sourcePriceUsd: number;
  destinationPriceUsd: number;
  capturedAt: string;
};

export type OracleReference = OracleSnapshot & { referenceOutput: number };

function parsedPrices(payload: OraclePricesResponse) {
  const prices = Array.isArray(payload) ? payload : payload.prices;
  return new Map((prices ?? []).flatMap((item) => {
    const price = Number(item.price);
    return item.symbol && Number.isFinite(price) && price > 0
      ? [[item.symbol.toUpperCase(), price] as const]
      : [];
  }));
}

export function oraclePriceForAsset(prices: ReadonlyMap<string, number>, symbol: string) {
  const normalized = symbol.toUpperCase();
  return prices.get(oracleSymbolAliases[normalized] ?? normalized);
}

export async function getOracleSnapshot(
  sourceSymbol: string,
  destinationSymbol: string,
): Promise<OracleSnapshot | null> {
  try {
    const response = await fetch(THORCHAIN_ORACLE_PRICES, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const prices = parsedPrices(await response.json() as OraclePricesResponse);
    const sourcePriceUsd = oraclePriceForAsset(prices, sourceSymbol);
    const destinationPriceUsd = oraclePriceForAsset(prices, destinationSymbol);
    if (!sourcePriceUsd || !destinationPriceUsd) return null;
    return {
      sourceSymbol,
      destinationSymbol,
      sourcePriceUsd,
      destinationPriceUsd,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    // Oracle availability should not prevent collection of otherwise valid quotes.
    return null;
  }
}

export function referenceForAmount(snapshot: OracleSnapshot | null, sourceAmountBaseUnits: string, sourceDecimals: number): OracleReference | null {
  if (!snapshot) return null;
  const sourceAmount = Number(sourceAmountBaseUnits) / (10 ** sourceDecimals);
  const referenceOutput = sourceAmount * snapshot.sourcePriceUsd / snapshot.destinationPriceUsd;
  return Number.isFinite(referenceOutput) && referenceOutput > 0 ? { ...snapshot, referenceOutput } : null;
}

export function oracleGapBps(output: string | undefined, reference: OracleReference | null) {
  if (!output || !reference) return undefined;
  const quotedOutput = Number(output);
  if (!Number.isFinite(quotedOutput) || quotedOutput <= 0) return undefined;
  return (quotedOutput / reference.referenceOutput - 1) * 10_000;
}
