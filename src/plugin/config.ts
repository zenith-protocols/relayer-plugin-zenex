/**
 * config.ts
 *
 * Environment- and plugins[].config-driven configuration for the zenex plugin.
 */

import { Networks } from '@stellar/stellar-sdk';
import { pluginError, PluginContext } from '@openzeppelin/relayer-sdk';
import { HTTP_STATUS } from './constants';
import { RelayParseConfig } from './types';

export interface ZenexConfig {
  /** The Router contract every relayed func must target. */
  router: string;
  /** Spliced into relay-owned tails: a Stellar account or contract. */
  feeRecipient: string;
  feeRateBps: number;
  feeTokenContractId: string;
  feeTokenDecimals: number;
  /** The Lazer channel this operator's Pyth token is entitled to. */
  pythChannel: string;
  network: 'testnet' | 'mainnet';
  networkPassphrase: string;
  /** Carries every chain read; its address is the simulation source. */
  fundRelayerId: string;
  pythToken: string;
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

/**
 * Load configuration from plugins[].config and environment variables
 */
export function loadConfig(context: PluginContext): ZenexConfig {
  const config = (context.config ?? {}) as Record<string, unknown>;
  const fees = (config.fees ?? {}) as Record<string, unknown>;
  const feeToken = (fees.feeToken ?? {}) as Record<string, unknown>;
  rejectUnknownKeys(config, ['router', 'feeRecipient', 'fees', 'pythChannel'], '');
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
    pythChannel: requireConfigString(config.pythChannel, 'pythChannel'),
    network: networkRaw,
    networkPassphrase: networkRaw === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
    fundRelayerId: requireEnv('FUND_RELAYER_ID'),
    pythToken: requireEnv('PYTH_ACCESS_TOKEN'),
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
