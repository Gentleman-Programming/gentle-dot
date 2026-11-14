/**
 * Transport Factory - Creates the Meta Cloud transport
 */

import { createMetaCloudTransport } from "./meta-cloud.js";
import type { ChannelTransport, TransportFactoryOptions, MetaCloudConfig } from "./types.js";

export function createTransportFactory(options: TransportFactoryOptions): ChannelTransport {
  // Only Meta Cloud provider supported for now (Baileys has git dependency issues)
  if (!options.meta) {
    throw new Error("Meta Cloud configuration is required. Set DOT_WHATSAPP_PROVIDER=meta-cloud and provide Meta Cloud credentials.");
  }
  
  return createMetaCloudTransport({
    authDir: options.authDir,
    allowedNumbers: options.allowedNumbers,
    log: options.log,
    meta: options.meta,
  });
}

export type { ChannelTransport, ChannelInbound, TransportStateEvent, TransportFactoryOptions, MetaCloudConfig } from "./types.js";
