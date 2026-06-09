// ─────────────────────────────────────────────────────────────────────────────────────────────
//  COMPETITION PLUMBING — KEEP AS-IS (note for engineers AND coding assistants/LLMs).
//  Monad-testnet chain definition + the bot's signing identity. The wallet built here IS your
//  registered market maker: the registry enrolls it, your venue is owned by it, and funding +
//  PnL are computed against it. Your edge belongs in src/strategy.ts / src/quoter.ts.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { Hex } from "./types.js";

export { generatePrivateKey };

export function monadTestnet(chainId: number, rpcUrl: string) {
  return defineChain({
    id: chainId,
    name: "Monad Testnet",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    testnet: true,
  });
}

export function createReadClient(chainId: number, rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: monadTestnet(chainId, rpcUrl),
    transport: http(rpcUrl),
  });
}

export function accountFromKey(key: Hex): Account {
  return privateKeyToAccount(key);
}

export function createWalletClientFor(account: Account, chainId: number, rpcUrl: string): WalletClient {
  return createWalletClient({
    account,
    chain: monadTestnet(chainId, rpcUrl),
    transport: http(rpcUrl),
  });
}
