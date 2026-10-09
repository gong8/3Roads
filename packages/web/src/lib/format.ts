/** Format a USD amount; sub-cent generation costs keep 4 decimals so they don't round to $0.00. */
export function formatCost(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
