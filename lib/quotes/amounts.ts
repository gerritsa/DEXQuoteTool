export function convertAtomicDecimals(amount: string, fromDecimals: number, toDecimals: number) {
  if (!/^\d+$/.test(amount)) throw new Error("Atomic amount must be an unsigned integer string");
  if (fromDecimals === toDecimals) return amount;
  const value = BigInt(amount);
  const difference = Math.abs(toDecimals - fromDecimals);
  const factor = 10n ** BigInt(difference);
  return toDecimals > fromDecimals ? (value * factor).toString() : (value / factor).toString();
}
