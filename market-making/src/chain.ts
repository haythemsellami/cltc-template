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
