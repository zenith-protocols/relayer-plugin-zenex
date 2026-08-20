/**
 * pricing.ts
 *
 * Chainlink Data Streams prices for the relay: one signed report per HTTP request; the signed
 * `fullReport` blob passes through to the on-chain oracle untouched, which owns integrity
 * (Chainlink verifier signatures) and freshness (the oracle's staleness gates).
 */

import { createHash, createHmac } from 'node:crypto';
import { pluginError } from '@openzeppelin/relayer-sdk';
import { DATASTREAMS, HTTP_STATUS } from './constants';

/** The Data Streams REST endpoint plus this operator's HMAC credentials. */
export type DataStreamsAccess = { host: string; userId: string; hmacSecret: string };

/** One signed report: the number for off-chain fee math, the signed wire payload for on-chain use. */
type SignedReport = { price: number; update: Uint8Array };

/** What one submit pass consumes: XLM/USD for fee conversion, the market payload for priced tails. */
export type RelayPrices = { xlmUsd: number; marketUpdate: Uint8Array | null };

// Structural cast target only — conversion trusts Data Streams; any missing field throws, mapped wholesale to PRICE_UNAVAILABLE.
interface LatestReportBody {
  report: { feedID: string; fullReport: string };
}

/** ABI word offsets inside the V3 `fullReport` envelope and its report body. */
const REPORT = {
  /** Head word 3 of abi.encode(bytes32[3], bytes reportData, bytes32[] rs, bytes32[] ss, bytes32 rawVs). */
  DATA_OFFSET_WORD: 96,
  /** The nine-word V3 body: feedId, validFrom, observations, nativeFee, linkFee, expiresAt, price, bid, ask. */
  BODY_LENGTH: 288,
  PRICE_OFFSET: 192,
  /** V3 prices are int192 at 18 decimals. */
  PRICE_SCALE: 1e18,
} as const;

function readWordAsOffset(blob: Uint8Array, at: number): number {
  if (at + 32 > blob.length) throw new Error('fullReport is shorter than its ABI head');
  const word = Buffer.from(blob.subarray(at, at + 32));
  if (!word.subarray(0, 28).every((byte) => byte === 0)) throw new Error('fullReport ABI offset overflows u32');
  return word.readUInt32BE(28);
}

/**
 * Extract the V3 report body from the `fullReport` ABI envelope
 * (`abi.encode(bytes32[3] reportContext, bytes reportData, …signatures)`).
 * The signatures stay untouched — verification is the on-chain verifier's job.
 */
function reportBody(fullReport: Uint8Array): Uint8Array {
  const dataOffset = readWordAsOffset(fullReport, REPORT.DATA_OFFSET_WORD);
  const length = readWordAsOffset(fullReport, dataOffset);
  if (length < REPORT.BODY_LENGTH) throw new Error('reportData is shorter than a V3 report body');
  const start = dataOffset + 32;
  if (start + length > fullReport.length) throw new Error('reportData overruns the fullReport blob');
  return fullReport.subarray(start, start + length);
}

/** Decode the body's int192 price word (18 decimals) as a JS number for off-chain fee math. */
function decodePrice(body: Uint8Array): number {
  const word = Buffer.from(body.subarray(REPORT.PRICE_OFFSET, REPORT.PRICE_OFFSET + 32));
  const unsigned = BigInt(`0x${word.toString('hex')}`);
  const signed = unsigned >= 1n << 255n ? unsigned - (1n << 256n) : unsigned;
  return Number(signed) / REPORT.PRICE_SCALE;
}

/** The three Data Streams auth headers for one GET: HMAC over "METHOD PATH BODY_SHA USER TS". */
function authHeaders(path: string, access: DataStreamsAccess): Record<string, string> {
  const timestamp = Date.now();
  const bodyHash = createHash('sha256').update('').digest('hex');
  const signature = createHmac('sha256', access.hmacSecret)
    .update(`GET ${path} ${bodyHash} ${access.userId} ${timestamp}`)
    .digest('hex');
  return {
    Authorization: access.userId,
    'X-Authorization-Timestamp': String(timestamp),
    'X-Authorization-Signature-SHA256': signature,
  };
}

/** A 429's Retry-After when it names a delay we can afford; the default backoff otherwise. */
function retryDelayMs(response: Response): number {
  const seconds = Number(response.headers?.get?.('retry-after'));
  if (!Number.isFinite(seconds) || seconds < 0) return DATASTREAMS.RETRY_DELAY_MS;
  return Math.min(seconds * 1000, DATASTREAMS.RETRY_DELAY_MAX_MS);
}

/** A dropped socket, upstream hiccup, or rate limit is worth one more attempt; any other 4xx is not. */
async function latestReportResponse(feedId: string, access: DataStreamsAccess): Promise<Response> {
  const path = `${DATASTREAMS.LATEST_REPORT_PATH}?feedID=${feedId}`;
  const request = (): Promise<Response> =>
    fetch(`${access.host}${path}`, {
      method: 'GET',
      // Signed per attempt: the HMAC timestamp must stay within the API's clock-skew window.
      headers: authHeaders(path, access),
      signal: AbortSignal.timeout(DATASTREAMS.FETCH_TIMEOUT_MS),
    });
  let delay: number = DATASTREAMS.RETRY_DELAY_MS;
  try {
    const response = await request();
    if (response.status < 500 && response.status !== 429) return response;
    if (response.status === 429) delay = retryDelayMs(response);
  } catch {
    // Network-level failure: idle keep-alive sockets die between sporadic
    // requests, so the first reuse after a quiet spell can fail spuriously.
  }
  await new Promise((resolve) => setTimeout(resolve, delay));
  return request();
}

/** One feed per request — the single-feed pull primitive; any failure is PRICE_UNAVAILABLE (fail closed). */
async function fetchReport(feedId: string, access: DataStreamsAccess): Promise<SignedReport> {
  try {
    const response = await latestReportResponse(feedId, access);
    if (!response.ok) throw new Error(`reports/latest responded ${response.status}`);
    const payload = (await response.json()) as LatestReportBody;
    const fullReportHex = payload.report.fullReport;
    if (typeof fullReportHex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(fullReportHex)) {
      throw new Error('reports/latest returned a malformed fullReport');
    }
    const update = Uint8Array.from(Buffer.from(fullReportHex.slice(2), 'hex'));
    const body = reportBody(update);
    const reportedFeed = `0x${Buffer.from(body.subarray(0, 32)).toString('hex')}`;
    // The wrong feed would only surface later as an on-chain feed-mismatch reject; fail closed here.
    if (reportedFeed !== feedId) throw new Error('reports/latest returned a report for a different feed');
    const price = decodePrice(body);
    // A malformed price must fail closed here, not surface later as NaN fee math.
    if (!Number.isFinite(price) || price <= 0) throw new Error('reports/latest returned a non-positive price');
    return { price, update };
  } catch (error) {
    console.error(`[zenex] Data Streams reports/latest failed: ${error}`);
    throw pluginError('Data Streams price is unavailable', {
      code: 'PRICE_UNAVAILABLE',
      status: HTTP_STATUS.SERVICE_UNAVAILABLE,
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** The signed single-feed `fullReport` a priced tail carries on-chain. */
export async function fetchMarketUpdate(feedId: string, access: DataStreamsAccess): Promise<Uint8Array> {
  return (await fetchReport(feedId, access)).update;
}

/** XLM/USD always (fee conversion), plus the named market feed; when the market IS the XLM feed one fetch serves both. */
export async function fetchRelayPrices(
  feedId: string | null,
  xlmUsdFeedId: string,
  access: DataStreamsAccess
): Promise<RelayPrices> {
  const [xlm, market] = await Promise.all([
    fetchReport(xlmUsdFeedId, access),
    feedId === null || feedId === xlmUsdFeedId ? null : fetchReport(feedId, access),
  ]);
  return { xlmUsd: xlm.price, marketUpdate: feedId === null ? null : (market ?? xlm).update };
}
