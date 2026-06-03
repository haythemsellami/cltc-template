import { EventEmitter } from "node:events";

import { WebSocket } from "ws";
import { parseUnits } from "viem";

/**
 * Subscribes to the organizer's public `/stream` as just another consumer — exactly like the taker
 * agents and the operator's price tracker. Tracks the latest price (WAD) and the active round, and
 * emits:
 *   - "tick"        (priceWad: bigint)
 *   - "round-start" (round: number | null)
 *   - "round-end"   (round: number | null)
 * Reconnects on drop. The price already reflects any round transform (e.g. rescale) — the feed
 * applies the transform before broadcast, so you quote against exactly what everyone else sees.
 */
export class FeedClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private closed = false;
  private connected = false;
  private priceWad: bigint | null = null;
  private roundActive = false;
  private round: number | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly stream: string,
    private readonly label = "market-maker",
  ) {
    super();
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.connected;
  }

  isRoundActive(): boolean {
    return this.roundActive;
  }

  latestPriceWad(): bigint | null {
    return this.priceWad;
  }

  private connect(): void {
    if (this.closed) {
      return;
    }
    const url = `${this.wsUrl}?streams=${encodeURIComponent(this.stream)}&label=${encodeURIComponent(this.label)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
    });
    ws.on("message", (data: Buffer) => this.onMessage(data.toString("utf8")));
    ws.on("close", () => {
      this.connected = false;
      if (!this.closed) {
        setTimeout(() => this.connect(), 2_000);
      }
    });
    ws.on("error", () => {
      // the close handler schedules the reconnect
    });
  }

  private onMessage(raw: string): void {
    let frame: {
      event?: string;
      round?: number;
      stream?: string;
      data?: { p?: unknown; b?: unknown; a?: unknown };
    };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (frame.event === "round-start") {
      this.roundActive = true;
      this.round = typeof frame.round === "number" ? frame.round : null;
      this.emit("round-start", this.round);
      return;
    }
    if (frame.event === "round-end") {
      const ended = this.round;
      this.roundActive = false;
      this.emit("round-end", ended);
      return;
    }
    if (frame.event) {
      // subscribed / paused / resumed / speed / error — no price payload to track
      return;
    }

    const data = frame.data;
    if (!data) {
      return;
    }
    const price = this.priceFrom(data);
    if (price === null) {
      return;
    }
    this.priceWad = price;
    this.emit("tick", price);
  }

  private priceFrom(data: { p?: unknown; b?: unknown; a?: unknown }): bigint | null {
    try {
      // aggTrade carries a single price `p`; bookTicker carries best bid `b` / ask `a` (use the mid).
      if (typeof data.p === "string") {
        return parseUnits(data.p, 18);
      }
      if (typeof data.b === "string" && typeof data.a === "string") {
        return (parseUnits(data.b, 18) + parseUnits(data.a, 18)) / 2n;
      }
    } catch {
      return null;
    }
    return null;
  }
}
