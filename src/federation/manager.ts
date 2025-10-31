import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "../logger";
import type { SystemXRouter } from "../router";
import { FederationPeer, type FederationPeerConfig, type FederationEnvironment } from "./peer";

export interface FederationConfig {
  domain: string;
  exportRoutes?: string[];
  heartbeatIntervalMs?: number;
  peers: FederationPeerConfig[];
}

function splitRoutes(value: string | undefined | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((route) => route.trim())
    .filter((route) => route.length > 0);
}

function inferDefaultRoutes(domain: string): string[] {
  if (!domain) {
    return ["*"];
  }
  const normalizedDomain = domain.replace(/^\*@/, "").replace(/^\*\./, "");
  if (domain.includes("@")) {
    return [domain];
  }
  return [`*@${normalizedDomain}`];
}

function normalizePeerId(config: FederationPeerConfig): FederationPeerConfig {
  if (config.id) {
    return config;
  }
  try {
    const url = new URL(config.url);
    return { ...config, id: url.host };
  } catch {
    return { ...config, id: `peer-${Math.random().toString(36).slice(2, 8)}` };
  }
}

function validateRoutes(routes: string[]): boolean {
  return Array.isArray(routes) && routes.length > 0 && routes.every((route) => typeof route === "string" && route.length > 0);
}

export function loadFederationConfig(logger: Logger): FederationConfig | null {
  try {
    const configPath = process.env.FEDERATION_CONFIG;
    if (configPath) {
      const resolved = resolve(configPath);
      const raw = readFileSync(resolved, "utf8");
      const parsed = JSON.parse(raw) as FederationConfig;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Config must be an object");
      }
      if (!parsed.domain || typeof parsed.domain !== "string") {
        throw new Error("Config missing 'domain'");
      }
      if (!Array.isArray(parsed.peers) || parsed.peers.length === 0) {
        throw new Error("Config requires at least one peer");
      }
      for (const peer of parsed.peers) {
        if (!peer.url || typeof peer.url !== "string") {
          throw new Error("Peer config missing 'url'");
        }
        if (!validateRoutes(peer.routes)) {
          throw new Error(`Peer ${peer.id ?? peer.url} must declare non-empty routes array`);
        }
      }
      logger.info("Loaded federation configuration", {
        path: resolved,
        peers: parsed.peers.length,
      });
      return parsed;
    }

    const enabled = process.env.FEDERATION_ENABLED === "true";
    if (!enabled) {
      return null;
    }

    const url = process.env.FEDERATION_PEER_URL;
    if (!url) {
      logger.warn("Federation enabled but FEDERATION_PEER_URL is missing");
      return null;
    }

    const peerRoutes = splitRoutes(process.env.FEDERATION_ROUTES);
    if (peerRoutes.length === 0) {
      logger.warn("Federation enabled but FEDERATION_ROUTES has no entries");
      return null;
    }

    const domain = process.env.FEDERATION_DOMAIN ?? "local.systemx";
    const exportRoutes =
      splitRoutes(process.env.FEDERATION_ANNOUNCE_ROUTES).length > 0
        ? splitRoutes(process.env.FEDERATION_ANNOUNCE_ROUTES)
        : inferDefaultRoutes(domain);

    const reconnectDelayMs = process.env.FEDERATION_RECONNECT_DELAY_MS
      ? Number.parseInt(process.env.FEDERATION_RECONNECT_DELAY_MS, 10)
      : undefined;
    const heartbeatIntervalMs = process.env.FEDERATION_HEARTBEAT_MS
      ? Number.parseInt(process.env.FEDERATION_HEARTBEAT_MS, 10)
      : undefined;

    const peer: FederationPeerConfig = normalizePeerId({
      id: process.env.FEDERATION_PEER_ID,
      url,
      routes: peerRoutes,
      auth: process.env.FEDERATION_AUTH,
      reconnectDelayMs,
    });

    const config: FederationConfig = {
      domain,
      exportRoutes,
      heartbeatIntervalMs,
      peers: [peer],
    };

    logger.info("Federation enabled via environment", {
      domain,
      peer: peer.id,
      routes: peerRoutes.length,
    });

    return config;
  } catch (error) {
    logger.error("Failed to load federation configuration", {
      error: (error as Error).message,
    });
    return null;
  }
}

export class FederationManager {
  private readonly peers: FederationPeer[];
  private readonly logger: Logger;

  constructor(peers: FederationPeer[], logger: Logger) {
    this.peers = peers;
    this.logger = logger;
  }

  start() {
    if (this.peers.length === 0) {
      this.logger.warn("Federation manager started without peers");
      return;
    }
    for (const peer of this.peers) {
      peer.start();
    }
  }

  stop() {
    for (const peer of this.peers) {
      peer.stop();
    }
  }
}

export function createFederationManager(router: SystemXRouter, logger: Logger, config: FederationConfig): FederationManager {
  const announceRoutes =
    config.exportRoutes && config.exportRoutes.length > 0 ? config.exportRoutes : inferDefaultRoutes(config.domain);

  const environment: FederationEnvironment = {
    router,
    logger,
    localDomain: config.domain,
    announceRoutes,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
  };

  const peers = config.peers
    .map((raw) => normalizePeerId(raw))
    .filter((peer) => {
      if (!peer.url) {
        logger.warn("Skipping federation peer with missing URL");
        return false;
      }
      if (!validateRoutes(peer.routes)) {
        logger.warn("Skipping federation peer with invalid routes", {
          peerId: peer.id,
        });
        return false;
      }
      return true;
    })
    .map((peer) => new FederationPeer(peer, environment));

  return new FederationManager(peers, logger);
}
