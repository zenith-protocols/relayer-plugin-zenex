/**
 * config.ts
 *
 * Environment- and plugins[].config-driven configuration for the zenex plugin.
 */

import { Networks } from '@stellar/stellar-sdk';
import { pluginError, PluginContext } from '@openzeppelin/relayer-sdk';
import { DATASTREAMS, HTTP_STATUS } from './constants';
import { DataStreamsAccess } from './pricing';
import { RelayParseConfig } from './types';

/** A V3-schema Data Streams feed id: 0x0003-prefixed bytes32 hex — the only schema the report decoder and the on-chain oracle accept. */
export const FEED_ID_PATTERN = /^0x0003[0-9a-fA-F]{60}$/i;

export interface ZenexConfig {
  /** The Router contract every relayed func must target. */
  router: string;
  /** Spliced into relay-owned tails: a Stellar account or contract. */
  feeRecipient: string;
  feeRateBps: number;
  feeTokenContractId: string;
  feeTokenDecimals: number;
  /** The Data Streams XLM/USD feed id (bytes32 hex) used for fee conversion. */
  xlmUsdFeedId: string;
  network: 'testnet' | 'mainnet';
  networkPassphrase: string;
  /** Carries every chain read; its address is the simulation source. */
  fundRelayerId: string;
  dsUserId: string;
  dsHmacSecret: string;
  /** The Data Streams REST host: `DS_API_HOST` when set, the network's host otherwise. */
  dsApiHost: string;
}

// Reports only the offending field, never its value — plugin error messages serialize back to callers.
function configInvalid(field: string): never {
  throw pluginError(`Invalid plugin config: ${field}`, {
    code: 'CONFIG_INVALID',
    status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    details: { field },
  });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw pluginError(`Missing required environment variable: ${name}`, {
      code: 'CONFIG_MISSING',
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      details: { name },
    });
  }
  return v.trim();
}

function envInvalid(name: string): never {
  throw pluginError(`Invalid environment variable: ${name}`, {
    code: 'CONFIG_INVALID',
    status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
    details: { name },
  });
}

function requireConfigString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') configInvalid(field);
  return value.trim();
}

// Strict schema: an unknown key is a config error, never silently ignored. This is what keeps
// channels-only keys (e.g. `fundRelayers`) out of this plugin's config block — the embedded
// channels code reads `context.config` too, so a typo or stray override must fail loudly.
function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) configInvalid(prefix === '' ? key : `${prefix}.${key}`);
  }
}

/** Soroban ledger sequences are u32s. */


/**
 * Load configuration from plugins[].config and environment variables
 */
export function loadConfig(context: PluginContext): ZenexConfig {
  const config = (context.config ?? {}) as Record<string, unknown>;
  const fees = (config.fees ?? {}) as Record<string, unknown>;
  const feeToken = (fees.feeToken ?? {}) as Record<string, unknown>;
  rejectUnknownKeys(config, ['router', 'feeRecipient', 'fees', 'xlmUsdFeedId'], '');
  rejectUnknownKeys(fees, ['feeRateBps', 'feeToken'], 'fees');
  rejectUnknownKeys(feeToken, ['contractId', 'decimals'], 'fees.feeToken');
  const feeRateBps = fees.feeRateBps;
  if (typeof feeRateBps !== 'number' || !Number.isInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 1_000_000) {
    configInvalid('fees.feeRateBps');
  }
  // Zenex amounts are 7-decimal atomic units; a different-decimal fee token would misprice every fee.
  if (feeToken.decimals !== 7) configInvalid('fees.feeToken.decimals');

  const networkRaw = requireEnv('STELLAR_NETWORK').toLowerCase();
  if (networkRaw !== 'testnet' && networkRaw !== 'mainnet') {
    throw pluginError('STELLAR_NETWORK must be "testnet" or "mainnet"', {
      code: 'UNSUPPORTED_NETWORK',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  }

  return {
    router: requireConfigString(config.router, 'router'),
    feeRecipient: requireConfigString(config.feeRecipient, 'feeRecipient'),
    feeRateBps,
    feeTokenContractId: requireConfigString(feeToken.contractId, 'fees.feeToken.contractId'),
    feeTokenDecimals: 7,
    xlmUsdFeedId: requireFeedId(config.xlmUsdFeedId),
    network: networkRaw,
    networkPassphrase: networkRaw === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
    fundRelayerId: requireEnv('FUND_RELAYER_ID'),
    dsUserId: requireEnv('DS_USER_ID'),
    dsHmacSecret: requireEnv('DS_HMAC_SECRET'),
    dsApiHost: dataStreamsHost(networkRaw),
  };
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The Data Streams REST host: `DS_API_HOST` when set, the network's host otherwise. The override
 * exists because the Data Streams environment and the Stellar network are separable — a testnet
 * relayer settling against a shadow verifier that accepts mainnet DON reports must pull those
 * reports from the mainnet endpoint.
 *
 * Requirements are deliberately narrow, because the HMAC credentials ride on every request to
 * whatever this names: https only (no cleartext) — except plain http to a loopback or
 * RFC1918-private host, where the traffic never crosses the public internet (a local mock Data
 * Streams stack) — no embedded credentials, and no query or fragment (the fetch owns the query
 * string). A trailing slash is trimmed so the joined `${host}${path}` stays single-slashed.
 * Anything else fails closed at load.
 */
function dataStreamsHost(network: ZenexConfig['network']): string {
  const raw = (process.env.DS_API_HOST ?? '').trim();
  if (raw === '') return DATASTREAMS.HOSTS[network];
  const url = parseUrl(raw);
  if (
    url === null ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname))) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    envInvalid('DS_API_HOST');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// A host cleartext http may name: loopback (localhost, 127.0.0.0/8) or RFC1918-private IPv4
// (10/8, 172.16/12, 192.168/16). WHATWG URL parsing has already lowercased the hostname and
// normalized every IPv4 form (hex, octal, int) to dotted decimal, so plain equality suffices.
function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const octets = hostname.split('.');
  if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/.test(octet))) return false;
  const [a, b] = octets.map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Normalized to lowercase so feed comparisons (market vs XLM/USD) are plain equality.
function requireFeedId(value: unknown): string {
  const feedId = requireConfigString(value, 'xlmUsdFeedId');
  if (!FEED_ID_PATTERN.test(feedId)) configInvalid('xlmUsdFeedId');
  return feedId.toLowerCase();
}

/** The Data Streams endpoint and credentials the pricing calls use. */
export function dataStreamsAccess(config: ZenexConfig): DataStreamsAccess {
  return {
    host: config.dsApiHost,
    userId: config.dsUserId,
    hmacSecret: config.dsHmacSecret,
  };
}

export function relayParseConfig(config: ZenexConfig): RelayParseConfig {
  return {
    router: config.router,
    feeToken: {
      contractId: config.feeTokenContractId,
      decimals: config.feeTokenDecimals,
      feeRateBps: config.feeRateBps,
    },
  };
}
