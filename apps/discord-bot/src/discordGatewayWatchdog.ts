import { Status, type Client } from "discord.js";

const GATEWAY_STALL_MS = 120_000;
const GATEWAY_CHECK_MS = 10_000;

// discord.js owns normal resume/reconnect. Restart only the gateway if it gets stuck.
export function watchDiscordGateway(client: Client, onStalled: () => void): () => void {
  let unavailableSince: number | undefined = Date.now();
  const reportError = (error: unknown) => {
    // Do not log request objects, tokens or message contents from network errors.
    const code = (error as { code?: unknown } | null)?.code;
    console.warn("discord-bot gateway error", typeof code === "string" || typeof code === "number" ? code : "connection error");
  };
  client.on("error", reportError);
  client.on("shardError", reportError);
  const timer = setInterval(() => {
    const ready = client.isReady() && client.ws.shards.size > 0 &&
      client.ws.shards.every(shard => shard.status === Status.Ready);
    if (ready) {
      if (unavailableSince !== undefined) console.info("discord-bot gateway connection healthy");
      unavailableSince = undefined;
      return;
    }
    if (unavailableSince === undefined) {
      unavailableSince = Date.now();
      console.warn("discord-bot gateway disconnected; waiting for automatic reconnect");
    }
    if (Date.now() - unavailableSince >= GATEWAY_STALL_MS) {
      stop();
      console.error("discord-bot gateway unavailable for 120 seconds; restarting gateway only (worker preserved)");
      onStalled();
    }
  }, GATEWAY_CHECK_MS);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    client.off("error", reportError);
    client.off("shardError", reportError);
  };
  return stop;
}
