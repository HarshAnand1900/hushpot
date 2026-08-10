import { TOKEN_DECIMALS } from "./contract";

const SCALE = 10n ** BigInt(TOKEN_DECIMALS);

/** Base units to a display string, e.g. 1284600n -> "1,284.60". */
export function formatUnits(value: bigint, decimals = 2): string {
  const whole = value / SCALE;
  const frac = value % SCALE;
  const fracStr = frac.toString().padStart(TOKEN_DECIMALS, "0").slice(0, decimals);
  return `${whole.toLocaleString("en-US")}${decimals > 0 ? `.${fracStr}` : ""}`;
}

/** Split for the design's two-tone numerals: decimals render smaller and dimmer. */
export function splitUnits(value: bigint, decimals = 2): { whole: string; frac: string } {
  const [whole, frac = ""] = formatUnits(value, decimals).split(".");
  return { whole, frac };
}

/** Seconds to "2d 14h 17m", the countdown format used throughout. */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "closing";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export function shortenAddress(address?: string): string {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortenHandle(handle?: string): string {
  if (!handle) return "";
  return `${handle.slice(0, 6)}…${handle.slice(-4)}`;
}
