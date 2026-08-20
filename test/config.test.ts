import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import type { PluginContext } from '@openzeppelin/relayer-sdk';
import { dataStreamsAccess, loadConfig, relayParseConfig } from '../src/plugin/config';
import { DATASTREAMS } from '../src/plugin/constants';
import { FEE_RECIPIENT, FEE_TOKEN, ROUTER, XLM_FEED_ID } from './helpers';

const ENV_KEYS = ['STELLAR_NETWORK', 'FUND_RELAYER_ID', 'DS_USER_ID', 'DS_HMAC_SECRET'] as const;
const OPTIONAL_ENV_KEYS = ['DS_API_HOST'] as const;
const savedEnv = Object.fromEntries([...ENV_KEYS, ...OPTIONAL_ENV_KEYS].map((key) => [key, process.env[key]]));

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
  delete process.env.DS_API_HOST;
});

afterAll(() => {
  for (const key of [...ENV_KEYS, ...OPTIONAL_ENV_KEYS]) {
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
      dsApiHost: DATASTREAMS.HOSTS.testnet,
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

  describe('session block', () => {
    function validSessionBlock(): Record<string, unknown> {
      return {
        policy: 'C'.padEnd(56, 'A'),
        ed25519Verifier: 'C'.padEnd(56, 'B'),
        ruleName: 'zenex-session',
        maxDurationLedgers: 17_280,
        markets: [{ trading: 'C'.padEnd(56, 'D'), collateral: FEE_TOKEN }],
      };
    }

    test('is optional — absent means no session policy', () => {
      expect(loadConfig(contextWith(validPluginConfig())).session).toBeUndefined();
    });

    test('loads a valid block and projects it into the parse policy', () => {
      const config = validPluginConfig();
      config.session = validSessionBlock();
      const loaded = loadConfig(contextWith(config));
      expect(loaded.session).toEqual(validSessionBlock());
      expect(relayParseConfig(loaded).session).toEqual(validSessionBlock());
    });

    test('rejects an unknown session key', () => {
      const config = validPluginConfig();
      config.session = { ...validSessionBlock(), verifier: 'typo' };
      expect(() => loadConfig(contextWith(config))).toThrow('Invalid plugin config: session.verifier');
    });

    test.each(['policy', 'ed25519Verifier', 'ruleName'] as const)('rejects a missing session.%s', (field) => {
      const config = validPluginConfig();
      const session = validSessionBlock();
      delete session[field];
      config.session = session;
      expect(() => loadConfig(contextWith(config))).toThrow(`Invalid plugin config: session.${field}`);
    });

    test.each([undefined, '17280', 0, -1, 1.5, 0x1_0000_0000])('rejects maxDurationLedgers: %j', (value) => {
      const config = validPluginConfig();
      config.session = { ...validSessionBlock(), maxDurationLedgers: value };
      expect(() => loadConfig(contextWith(config))).toThrow('Invalid plugin config: session.maxDurationLedgers');
    });

    test.each([undefined, [], 'markets'])('rejects markets: %j', (value) => {
      const config = validPluginConfig();
      config.session = { ...validSessionBlock(), markets: value };
      expect(() => loadConfig(contextWith(config))).toThrow('Invalid plugin config: session.markets');
    });

    test('rejects a market entry with an unknown key', () => {
      const config = validPluginConfig();
      config.session = { ...validSessionBlock(), markets: [{ trading: ROUTER, collateral: FEE_TOKEN, vault: ROUTER }] };
      expect(() => loadConfig(contextWith(config))).toThrow('Invalid plugin config: session.markets[0].vault');
    });

    test('rejects a market entry missing its collateral', () => {
      const config = validPluginConfig();
      config.session = { ...validSessionBlock(), markets: [{ trading: ROUTER }] };
      expect(() => loadConfig(contextWith(config))).toThrow('Invalid plugin config: session.markets[0].collateral');
    });
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

describe('DS_API_HOST', () => {
  test('overrides the network-derived host — mainnet reports while settling on testnet', () => {
    process.env.DS_API_HOST = DATASTREAMS.HOSTS.mainnet;
    const config = loadConfig(contextWith(validPluginConfig()));
    expect(config.network).toBe('testnet');
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
    expect(dataStreamsAccess(config).host).toBe(DATASTREAMS.HOSTS.mainnet);
  });

  test.each([undefined, '', '   '])('falls back to the network-derived host when unset: %j', (value) => {
    if (value === undefined) delete process.env.DS_API_HOST;
    else process.env.DS_API_HOST = value;
    expect(loadConfig(contextWith(validPluginConfig())).dsApiHost).toBe(DATASTREAMS.HOSTS.testnet);
  });

  test.each([
    ['  https://ds.example.com  ', 'https://ds.example.com'],
    ['https://ds.example.com/', 'https://ds.example.com'],
    ['https://ds.example.com///', 'https://ds.example.com'],
    ['https://ds.example.com:8443/proxy/', 'https://ds.example.com:8443/proxy'],
  ])('trims and normalizes %j', (value, expected) => {
    process.env.DS_API_HOST = value;
    expect(loadConfig(contextWith(validPluginConfig())).dsApiHost).toBe(expected);
  });

  test.each([
    ['http://localhost:8546', 'http://localhost:8546'],
    ['http://127.0.0.1:8546', 'http://127.0.0.1:8546'],
    ['http://127.255.0.1', 'http://127.255.0.1'],
    ['http://10.1.2.3:8546', 'http://10.1.2.3:8546'],
    ['http://172.16.0.1', 'http://172.16.0.1'],
    ['http://172.31.255.254:9000/proxy/', 'http://172.31.255.254:9000/proxy'],
    ['http://192.168.2.100:8546', 'http://192.168.2.100:8546'], // the local ds-sim mock
  ])('accepts cleartext http to the loopback/private host %j', (value, expected) => {
    process.env.DS_API_HOST = value;
    expect(loadConfig(contextWith(validPluginConfig())).dsApiHost).toBe(expected);
  });

  test.each([
    'api.dataengine.chain.link', // no scheme
    'http://api.dataengine.chain.link', // credentials would ride in cleartext to a public host
    'http://8.8.8.8', // public IPv4
    'http://172.15.0.1', // just below 172.16/12
    'http://172.32.0.1', // just above 172.16/12
    'http://192.169.0.1', // just outside 192.168/16
    'http://[::1]:8546', // IPv6 loopback is not in the allowlist
    'http://localhost.example.com', // a public name that merely mentions localhost
    'http://192.168.2.100?feedID=1', // the caller owns the query string, private host or not
    'http://user:pass@192.168.2.100',
    'ftp://api.dataengine.chain.link',
    'https://',
    'not a url',
    'https://ds.example.com?feedID=1', // the caller owns the query string
    'https://ds.example.com#frag',
    'https://user:pass@ds.example.com',
  ])('rejects %j', (value) => {
    process.env.DS_API_HOST = value;
    expect(() => loadConfig(contextWith(validPluginConfig()))).toThrow('Invalid environment variable: DS_API_HOST');
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
