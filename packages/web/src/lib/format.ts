/** Format a USD amount to 3 decimals, enough to show sub-cent generation costs (e.g. $0.001). */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(3)}`;
}
