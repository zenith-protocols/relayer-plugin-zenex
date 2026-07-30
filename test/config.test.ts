import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import type { PluginContext } from '@openzeppelin/relayer-sdk';
import { loadConfig, relayParseConfig } from '../src/plugin/config';
import { FEE_RECIPIENT, FEE_TOKEN, ROUTER } from './helpers';

const ENV_KEYS = ['STELLAR_NETWORK', 'FUND_RELAYER_ID', 'PYTH_ACCESS_TOKEN'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function validPluginConfig(): Record<string, unknown> {
  return {
    router: ROUTER,
    feeRecipient: FEE_RECIPIENT,
    fees: { feeRateBps: 30, feeToken: { contractId: FEE_TOKEN, decimals: 7 } },
    pythChannel: 'fixed_rate@1000ms',
  };
}

function contextWith(config: unknown): PluginContext {
  return { config } as PluginContext;
}

beforeEach(() => {
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.FUND_RELAYER_ID = 'channels-fund';
  process.env.PYTH_ACCESS_TOKEN = 'pyth-token';
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('loadConfig', () => {
  test('loads a valid config with testnet passphrase', () => {
    const config = loadConfig(contextWith(validPluginConfig()));
    expect(config).toEqual({
      router: ROUTER,
      feeRecipient: FEE_RECIPIENT,
      feeRateBps: 30,
      feeTokenContractId: FEE_TOKEN,
      feeTokenDecimals: 7,
      pythChannel: 'fixed_rate@1000ms',
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
      fundRelayerId: 'channels-fund',
      pythToken: 'pyth-token',
    });
  });

  test('maps mainnet to the public passphrase', () => {
    process.env.STELLAR_NETWORK = 'MAINNET';
    const config = loadConfig(contextWith(validPluginConfig()));
    expect(config.network).toBe('mainnet');
    expect(config.networkPassphrase).toBe(Networks.PUBLIC);
  });

  test.each(ENV_KEYS)('rejects a missing %s', (key) => {
    delete process.env[key];
    expect(() => loadConfig(contextWith(validPluginConfig()))).toThrow(/Missing required environment variable/);
  });

  test('rejects an unsupported network', () => {
    process.env.STELLAR_NETWORK = 'futurenet';
    expect(() => loadConfig(contextWith(validPluginConfig()))).toThrow(
      'STELLAR_NETWORK must be "testnet" or "mainnet"'
    );
  });

  test.each([undefined, '30', 30.5, -1, 1_000_001])('rejects invalid feeRateBps: %j', (feeRateBps) => {
    const config = validPluginConfig();
    (config.fees as Record<string, unknown>).feeRateBps = feeRateBps;
    expect(() => loadConfig(contextWith(config))).toThrow('Invalid plugin config: fees.feeRateBps');
  });

  test.each([6, 8, '7', undefined])('rejects fee token decimals: %j', (decimals) => {
    const config = validPluginConfig();
    ((config.fees as Record<string, unknown>).feeToken as Record<string, unknown>).decimals = decimals;
    expect(() => loadConfig(contextWith(config))).toThrow('Invalid plugin config: fees.feeToken.decimals');
  });

  test.each(['router', 'feeRecipient', 'pythChannel'] as const)('rejects a missing %s', (field) => {
    const config = validPluginConfig();
    delete config[field];
    expect(() => loadConfig(contextWith(config))).toThrow(`Invalid plugin config: ${field}`);
  });

  test('rejects a missing feeToken contractId', () => {
    const config = validPluginConfig();
    ((config.fees as Record<string, unknown>).feeToken as Record<string, unknown>).contractId = '';
    expect(() => loadConfig(contextWith(config))).toThrow('Invalid plugin config: fees.feeToken.contractId');
  });

  test('rejects an entirely missing config block', () => {
    expect(() => loadConfig(contextWith(undefined))).toThrow('Invalid plugin config');
  });

  test('trims whitespace from config strings and env values', () => {
    const config = validPluginConfig();
    config.router = `  ${ROUTER}  `;
    process.env.FUND_RELAYER_ID = '  channels-fund  ';
    const loaded = loadConfig(contextWith(config));
    expect(loaded.router).toBe(ROUTER);
    expect(loaded.fundRelayerId).toBe('channels-fund');
  });
});

describe('relayParseConfig', () => {
  test('projects the parse policy from the loaded config', () => {
    const config = loadConfig(contextWith(validPluginConfig()));
    expect(relayParseConfig(config)).toEqual({
      router: ROUTER,
      feeToken: { contractId: FEE_TOKEN, decimals: 7, feeRateBps: 30 },
    });
  });
});
