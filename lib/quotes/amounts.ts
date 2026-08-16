export function convertAtomicDecimals(amount: string, fromDecimals: number, toDecimals: number) {
  if (!/^\d+$/.test(amount)) throw new Error("Atomic amount must be an unsigned integer string");
  if (fromDecimals === toDecimals) return amount;
  const value = BigInt(amount);
  const difference = Math.abs(toDecimals - fromDecimals);
  const factor = 10n ** BigInt(difference);
  return toDecimals > fromDecimals ? (value * factor).toString() : (value / factor).toString();
}

export function formatBaseUnits(amount: string, decimals: number) {
  if (!/^\d+$/.test(amount)) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  if (decimals === 0) return padded;
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
