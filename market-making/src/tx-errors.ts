// Human-readable transaction failures. viem throws rich but VERBOSE errors (request dumps, docs
// links); this distills each one to the line a player actually needs:
//   - custom revert  -> "updatePrice reverted: QuoteExpired(1781123456, 1781123440)"
//   - out of gas     -> "updatePrice failed: out of MON gas — top up <address> and the bot continues"
//   - anything else  -> viem's shortMessage (one line) instead of the full dump
// Custom errors decode by NAME when the ABI carries their definitions — the venue ABI comes from
// the forge artifact (complete), and the registry ABI below lists the registry's errors.
import { BaseError, ContractFunctionRevertedError, InsufficientFundsError } from "viem";

export function explainTxError(error: unknown, what: string, address?: string): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError) as
      | ContractFunctionRevertedError
      | null;
    if (revert) {
      const name = revert.data?.errorName ?? revert.reason ?? "execution reverted (no reason)";
      const args =
        revert.data?.args && revert.data.args.length > 0 ? `(${revert.data.args.map(String).join(", ")})` : "";
      return `${what} reverted: ${name}${args}`;
    }
    if (error.walk((e) => e instanceof InsufficientFundsError)) {
      return `${what} failed: out of MON gas${address ? ` — top up ${address} and the bot continues` : ""}`;
    }
    return `${what} failed: ${error.shortMessage}`;
  }
  return `${what} failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** Wrap a transaction so any failure rethrows with the readable one-liner. */
export async function withTxError<T>(what: string, address: string | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(explainTxError(error, what, address));
  }
}
