import { describe, test, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { Configuration, PluginsApi } from '@openzeppelin/relayer-sdk';
import { ZenexClient } from '../src/client/zenex-client';
import {
  PluginTransportError,
  PluginExecutionError,
  PluginUnexpectedError,
  isResourceLimitFailure,
} from '../src/client/errors';
import { MARKET_FEED_ID } from './helpers';

vi.mock('axios');
const mockedAxios = axios as unknown as {
  create: ReturnType<typeof vi.fn>;
  isAxiosError: ReturnType<typeof vi.fn>;
};

vi.mock('@openzeppelin/relayer-sdk', () => ({
  Configuration: vi.fn(),
  PluginsApi: vi.fn(),
}));

const PREPARE_REQUEST = {
  user: 'GUSER',
  calls: ['AAAA'],
  expirationLedger: 1_000,
  maxFeeAmountAtomic: '1000000',
};

function mockAxiosInstance() {
  const instance = { post: vi.fn() };
  mockedAxios.create.mockReturnValue(instance);
  return instance;
}

function mockPluginsApi() {
  const api = { callPlugin: vi.fn() };
  (PluginsApi as unknown as ReturnType<typeof vi.fn>).mockImplementation(function () {
    return api;
  });
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAxios.isAxiosError.mockReturnValue(false);
});

describe('configuration', () => {
  test('configures direct HTTP mode when pluginId is not provided', () => {
    mockAxiosInstance();
    new ZenexClient({ baseUrl: 'https://relay.example.com', apiKey: 'edge-key' });
    expect(mockedAxios.create).toHaveBeenCalledWith({
      baseURL: 'https://relay.example.com',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer edge-key',
      },
    });
  });

  test('omits the Authorization header without an apiKey in direct mode', () => {
    mockAxiosInstance();
    new ZenexClient({ baseUrl: 'https://relay.example.com' });
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
    );
  });

  test('configures relayer mode when pluginId is provided', () => {
    mockPluginsApi();
    new ZenexClient({ pluginId: 'zenex', apiKey: 'relayer-key', baseUrl: 'http://localhost:8080' });
    expect(Configuration).toHaveBeenCalledWith({
      basePath: 'http://localhost:8080',
      accessToken: 'relayer-key',
      baseOptions: { headers: { 'x-api-key': 'relayer-key' }, timeout: 30000 },
    });
    expect(PluginsApi).toHaveBeenCalled();
  });

  test('rejects a direct configuration without baseUrl', () => {
    expect(() => new ZenexClient({ baseUrl: '' })).toThrow('baseUrl is required');
  });
});

describe('routing', () => {
  test('posts prepare routes to their paths in direct mode', async () => {
    const instance = mockAxiosInstance();
    instance.post.mockResolvedValueOnce({ data: { success: true, data: { func: 'F', authEntries: [] } } });
    const client = new ZenexClient({ baseUrl: 'https://relay.example.com' });
    await client.prepareCalls(PREPARE_REQUEST);
    expect(instance.post).toHaveBeenCalledWith('/prepare/calls', { params: PREPARE_REQUEST });
  });

  test('passes the route to callPlugin in relayer mode', async () => {
    const api = mockPluginsApi();
    api.callPlugin.mockResolvedValueOnce({ data: { success: true, data: { func: 'F', authEntries: [] } } });
    const client = new ZenexClient({ pluginId: 'zenex', apiKey: 'k', baseUrl: 'http://localhost:8080' });
    await client.prepareTryFill({ ...PREPARE_REQUEST, feedId: MARKET_FEED_ID });
    expect(api.callPlugin).toHaveBeenCalledWith(
      'zenex',
      { params: { ...PREPARE_REQUEST, feedId: MARKET_FEED_ID } },
      '/prepare/try-fill'
    );
  });

  test('submits on the /submit route', async () => {
    const api = mockPluginsApi();
    api.callPlugin.mockResolvedValueOnce({
      data: { success: true, data: { transactionId: 'tx-1', status: 'submitted', hash: null } },
    });
    const client = new ZenexClient({ pluginId: 'zenex', apiKey: 'k', baseUrl: 'http://localhost:8080' });
    const result = await client.submit({ func: 'F', auth: ['A'] });
    expect(api.callPlugin).toHaveBeenCalledWith('zenex', { params: { func: 'F', auth: ['A'] } }, '/submit');
    expect(result.transactionId).toBe('tx-1');
  });

  test('polls status via the bare channels surface in relayer mode', async () => {
    const api = mockPluginsApi();
    api.callPlugin.mockResolvedValueOnce({
      data: { success: true, data: { transactionId: 'tx-1', status: 'confirmed', hash: 'H' } },
    });
    const client = new ZenexClient({ pluginId: 'zenex', apiKey: 'k', baseUrl: 'http://localhost:8080' });
    const result = await client.getTransaction({ transactionId: 'tx-1' });
    expect(api.callPlugin).toHaveBeenCalledWith(
      'zenex',
      { params: { getTransaction: { transactionId: 'tx-1' } } },
      undefined
    );
    expect(result.hash).toBe('H');
  });

  test('polls status via /status in direct mode', async () => {
    const instance = mockAxiosInstance();
    instance.post.mockResolvedValueOnce({
      data: { success: true, data: { transactionId: 'tx-1', status: 'confirmed', hash: 'H' } },
    });
    const client = new ZenexClient({ baseUrl: 'https://relay.example.com' });
    await client.getTransaction({ transactionId: 'tx-1' });
    expect(instance.post).toHaveBeenCalledWith('/status', { params: { transactionId: 'tx-1' } });
  });
});

describe('response handling', () => {
  test('throws PluginExecutionError when the plugin rejects', async () => {
    const instance = mockAxiosInstance();
    instance.post.mockResolvedValueOnce({
      data: { success: false, error: 'Relay fee exceeds the user-signed maximum', data: { code: 'FEE' } },
    });
    const client = new ZenexClient({ baseUrl: 'https://relay.example.com' });
    await expect(client.submit({ func: 'F', auth: ['A'] })).rejects.toThrow(PluginExecutionError);
  });

  test('extracts the plugin envelope from an HTTP error body', async () => {
    const instance = mockAxiosInstance();
    const httpError = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { success: false, error: 'INVALID_PARAMS' } },
    });
    instance.post.mockRejectedValueOnce(httpError);
    mockedAxios.isAxiosError.mockReturnValue(true);
    const client = new ZenexClient({ baseUrl: 'https://relay.example.com' });
    await expect(client.prepareCalls(PREPARE_REQUEST)).rejects.toThrow(PluginExecutionError);
  });

  test('throws PluginTransportError with sanitized details on a network failure', async () => {
    const instance = mockAxiosInstance();
    instance.post.mockRejectedValueOnce(
      Object.assign(new Error('socket hang up'), {
        code: 'ECONNRESET',
        response: undefined,
        config: { headers: { Authorization: 'Bearer secret' } },
      })
    );
    mockedAxios.isAxiosError.mockReturnValue(true);
    const client = new ZenexClient({ baseUrl: 'https://relay.example.com' });
    const error = await client.prepareCalls(PREPARE_REQUEST).catch((e) => e);
    expect(error).toBeInstanceOf(PluginTransportError);
    // The raw AxiosError carries the request config (API-key header) — details must not.
    expect(error.errorDetails).toEqual({ code: 'ECONNRESET', message: 'socket hang up', status: undefined });
  });

  test('throws PluginUnexpectedError on a malformed response', async () => {
    const instance = mockAxiosInstance();
    instance.post.mockResolvedValueOnce({ data: { nope: true } });
    const client = new ZenexClient({ baseUrl: 'https://relay.example.com' });
    await expect(client.prepareCalls(PREPARE_REQUEST)).rejects.toThrow(PluginUnexpectedError);
  });

  test('merges metadata into the returned data when present', async () => {
    const instance = mockAxiosInstance();
    instance.post.mockResolvedValueOnce({
      data: {
        success: true,
        data: { transactionId: 'tx-1', status: 'submitted', hash: null },
        metadata: { logs: [{ level: 'info', message: 'ok' }] },
      },
    });
    const client = new ZenexClient({ baseUrl: 'https://relay.example.com' });
    const result = await client.submit({ func: 'F', auth: ['A'] });
    expect(result.metadata?.logs).toHaveLength(1);
  });
});

describe('isResourceLimitFailure', () => {
  // The two failures seen on chain: the write set grew between the simulation
  // and the ledger that executed the transaction.
  test('classifies the byte-write diagnostic as retryable', () => {
    const failure = new PluginExecutionError('Transaction failed', {
      code: 'ONCHAIN_FAILED',
      reason: 'operation byte-write resources exceeds amount specified',
    });
    expect(isResourceLimitFailure(failure)).toBe(true);
  });

  test('classifies a txSorobanInvalid result code as retryable', () => {
    const failure = new PluginExecutionError('txFeeBumpInnerFailed', {
      code: 'ONCHAIN_FAILED',
      resultCode: 'txFeeBumpInnerFailed:txSorobanInvalid',
    });
    expect(isResourceLimitFailure(failure)).toBe(true);
  });

  test('reads a plain status reason string', () => {
    expect(isResourceLimitFailure('2188 declared vs 1992 actual, resource limit exceeded')).toBe(true);
  });

  test('leaves an unrelated failure terminal', () => {
    const failure = new PluginExecutionError('Relay fee exceeds the user-signed maximum', {
      code: 'FEE_EXCEEDS_SIGNED_MAXIMUM',
    });
    expect(isResourceLimitFailure(failure)).toBe(false);
    expect(isResourceLimitFailure('Error(Contract, #12)')).toBe(false);
    expect(isResourceLimitFailure(undefined)).toBe(false);
    expect(isResourceLimitFailure({})).toBe(false);
  });

  test('survives a failure that carries a cycle', () => {
    const failure: Record<string, unknown> = { reason: 'byte-write resources exceeds amount specified' };
    failure.self = failure;
    expect(isResourceLimitFailure(failure)).toBe(true);
  });
});
