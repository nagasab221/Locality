import { EventEmitter } from "events";
import type { Response } from "express";

/**
 * Server-sent-events bus. The renderer subscribes to /api/events; the scanner,
 * progress ledger, marker detector and subtitle extractor publish here.
 */
class EventBus extends EventEmitter {
  private clients = new Set<Response>();

  addClient(res: Response) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  broadcast(type: string, data: unknown) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
    this.emit(type, data);
  }
}

export const events = new EventBus();
