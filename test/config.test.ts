import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import type { PluginContext } from '@openzeppelin/relayer-sdk';
import { dataStreamsAccess, loadConfig, relayParseConfig } from '../src/plugin/config';
import { DATASTREAMS } from '../src/plugin/constants';
import { FEE_RECIPIENT, FEE_TOKEN, ROUTER, XLM_FEED_ID } from './helpers';

const ENV_KEYS = ['STELLAR_NETWORK', 'FUND_RELAYER_ID', 'DS_USER_ID', 'DS_HMAC_SECRET'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function validPluginConfig(): Record<string, unknown> {
  return {
    router: ROUTER,
    feeRecipient: FEE_RECIPIENT,
    fees: { feeRateBps: 30, feeToken: { contractId: FEE_TOKEN, decimals: 7 } },
    xlmUsdFeedId: XLM_FEED_ID,
  };
}

function contextWith(config: unknown): PluginContext {
  return { config } as PluginContext;
}

beforeEach(() => {
  process.env.STELLAR_NETWORK = 'testnet';
  process.env.FUND_RELAYER_ID = 'channels-fund';
  process.env.DS_USER_ID = 'ds-user-uuid';
  process.env.DS_HMAC_SECRET = 'ds-hmac-secret';
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
      xlmUsdFeedId: XLM_FEED_ID,
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
      fundRelayerId: 'channels-fund',
      dsUserId: 'ds-user-uuid',
      dsHmacSecret: 'ds-hmac-secret',
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

  test.each(['router', 'feeRecipient', 'xlmUsdFeedId'] as const)('rejects a missing %s', (field) => {
    const config = validPluginConfig();
    delete config[field];
    expect(() => loadConfig(contextWith(config))).toThrow(`Invalid plugin config: ${field}`);
  });

  test.each([
    '23',
    XLM_FEED_ID.slice(2),
    XLM_FEED_ID.slice(0, -2),
    `${XLM_FEED_ID}ff`,
    '0xzz',
    `0x0002${XLM_FEED_ID.slice(6)}`, // non-V3 schema
  ])('rejects a malformed xlmUsdFeedId: %j', (xlmUsdFeedId) => {
    const config = validPluginConfig();
    config.xlmUsdFeedId = xlmUsdFeedId;
    expect(() => loadConfig(contextWith(config))).toThrow('Invalid plugin config: xlmUsdFeedId');
  });

  test('normalizes an uppercase xlmUsdFeedId to lowercase', () => {
    const config = validPluginConfig();
    config.xlmUsdFeedId = XLM_FEED_ID.toUpperCase().replace('0X', '0x');
    expect(loadConfig(contextWith(config)).xlmUsdFeedId).toBe(XLM_FEED_ID);
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

describe('dataStreamsAccess', () => {
  test('projects the Data Streams access from the loaded config, host by network', () => {
    const config = loadConfig(contextWith(validPluginConfig()));
    expect(dataStreamsAccess(config)).toEqual({
      host: DATASTREAMS.HOSTS.testnet,
      userId: 'ds-user-uuid',
      hmacSecret: 'ds-hmac-secret',
    });
    process.env.STELLAR_NETWORK = 'mainnet';
    const mainnet = loadConfig(contextWith(validPluginConfig()));
    expect(dataStreamsAccess(mainnet).host).toBe(DATASTREAMS.HOSTS.mainnet);
  });
});
