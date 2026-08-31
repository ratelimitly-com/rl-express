import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type {
  GuardResult,
  LatencyGuard,
  RateLimitResult,
  RClient,
  RequestPolicy,
  ResourceRequest,
  ResourceResult,
  ServiceLatencyBlock
} from 'ratelimitly-client';

// These values are direct runtime re-exports. Their declarations stay owned by
// ratelimitly-client so the Express package cannot drift from the client API.
export {
  AuthenticationError,
  AuthMethod,
  GuardResult,
  HaSchedule,
  LatencyGuard,
  ProtocolError,
  RateLimitError,
  RateLimitResult,
  RClient,
  RClientConfig,
  RequestPolicy,
  ResourceRequest,
  ResourceResult,
  ServiceLatencyBlock,
  TenantConfig,
  TimeoutError
} from 'ratelimitly-client';

export type {
  AuthMethodType,
  LatencyGuardOptions,
  Quotas,
  RClientOptions,
  RequestPolicyOptions,
  ServerEndpoint,
  ServiceLatencyBlockOptions
} from 'ratelimitly-client';

export { decodeApiKey, encodeApiKey } from 'ratelimitly-client/api_key_codec';
export type { DecodedApiKey } from 'ratelimitly-client/api_key_codec';

export interface ClientOptions {
  /** An application-owned client. The middleware never destroys it. */
  client?: RClient;
  /** RateLimitly Bech32 API key; RATELIMITLY_AUTH_KEY is used when omitted. */
  authKey?: string;
  /** Optional override for the DNS discovery name derived from the API key. */
  dnsName?: string;
  requestPolicy?: RequestPolicy;
  dnsRefreshIntervalS?: number;
}

export interface LatencyTrackerOptions {
  ttlMs?: number | string;
  maxSamples?: number;
  minSampleThreshold?: number;
}

export class LatencyTracker {
  readonly latencyTrackerName: string;
  readonly ttlMs: number;
  readonly maxSamples: number;
  readonly minSampleThreshold: number;

  constructor(latencyTrackerName: string, options?: LatencyTrackerOptions);
}

export type RateLimitlyOutcome = 'granted' | 'rejected' | 'fail-open';

export interface RateLimitlyInfo {
  outcome: RateLimitlyOutcome;
  admitted: boolean;
  error: Error | null;
  result: RateLimitResult | null;
  limit?: number;
  windowMs?: number;
  tokensRequested?: number;
  guardResults: GuardResult[];
  resourceResults: ResourceResult[];
  serverId: bigint | number | null;
  requestId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      rateLimitly?: RateLimitlyInfo;
      rateLimitlyGuards?: GuardResult[];
    }
  }
}

export type KeyGenerator = (
  req: Request,
  res: Response
) => string;

export type MetricsLabelGenerator = (
  req: Request,
  res: Response
) => string;

export type ResourceResolver = (
  req: Request,
  res: Response
) => ResourceRequest[] | Promise<ResourceRequest[]>;

export type GuardResolver = (
  req: Request,
  res: Response
) => LatencyGuard[] | Promise<LatencyGuard[]>;

export type LatencyReportResolver = (
  req: Request,
  res: Response,
  durationMs: number
) => ServiceLatencyBlock[] | Promise<ServiceLatencyBlock[]>;

export type SkipResolver = (
  req: Request,
  res: Response
) => boolean | Promise<boolean>;

export type LatencyReportErrorHandler = (
  error: Error,
  req: Request,
  res: Response
) => void | Promise<void>;

export interface RateLimitlyOptions extends ClientOptions {
  windowMs?: number | string;
  window?: number | string;
  limit?: number;
  max?: number;
  rate?: number;
  tokensRequested?: number;
  tokens?: number;
  bucketId?: string | ((req: Request, res: Response) => string | Promise<string>);
  bucket?: string | ((req: Request, res: Response) => string | Promise<string>);
  context?: string;
  prefix?: string;
  resourceKeyPrefix?: string;
  keyGenerator?: KeyGenerator;
  resources?: ResourceRequest[] | ResourceResolver;
  resource?: ResourceRequest;

  guard?: LatencyGuard;
  guards?: LatencyGuard[] | GuardResolver;

  reportLatency?: LatencyTracker | LatencyTracker[] | LatencyReportResolver;
  onLatencyReportError?: LatencyReportErrorHandler;

  metricsLabel?: string | MetricsLabelGenerator;
  label?: string | MetricsLabelGenerator;
  emitDefaultMetricsLabel?: boolean;
  defaultMetricsLabel?: boolean;

  failOpen?: boolean;
  passOnRateLimitError?: boolean;
  onError?: (error: Error, req: Request, res: Response) => void;
  errorHandler?: (
    error: Error,
    req: Request,
    res: Response,
    next: NextFunction,
    options: RateLimitlyOptions
  ) => void;

  statusCode?: number;
  message?: string | object;
  handler?: (
    req: Request,
    res: Response,
    next: NextFunction,
    options: RateLimitlyOptions,
    result: RateLimitResult
  ) => void;
  onLimitReached?: (
    req: Request,
    res: Response,
    options: RateLimitlyOptions,
    result: RateLimitResult
  ) => void;

  standardHeaders?: boolean | 'draft-6' | 'draft-7' | 'draft-8';
  legacyHeaders?: boolean;
  requestPropertyName?: string;
  skip?: SkipResolver;
}

export function rateLimitly(options?: RateLimitlyOptions): RequestHandler;
export function rateLimit(options?: RateLimitlyOptions): RequestHandler;
export default rateLimitly;

export interface LatencyGuardMiddlewareOptions extends ClientOptions {
  guard?: LatencyGuard;
  guards?: LatencyGuard[] | GuardResolver;
  failOpen?: boolean;
  statusCode?: number;
  message?: string | object;
  metricsLabel?: string | MetricsLabelGenerator;
  skip?: SkipResolver;
  onError?: (error: Error, req: Request, res: Response) => void;
  errorHandler?: (
    error: Error,
    req: Request,
    res: Response,
    next: NextFunction,
    options: LatencyGuardMiddlewareOptions
  ) => void;
  handler?: (
    req: Request,
    res: Response,
    next: NextFunction,
    options: LatencyGuardMiddlewareOptions,
    result: RateLimitResult
  ) => void;
  onGuardTriggered?: (
    req: Request,
    res: Response,
    options: LatencyGuardMiddlewareOptions,
    failedGuards: GuardResult[]
  ) => void;
}

export function latencyGuard(options?: LatencyGuardMiddlewareOptions): RequestHandler;

export interface LatencyReporterMiddlewareOptions extends ClientOptions {
  tracker?: LatencyTracker;
  trackers?: LatencyTracker[];
  reports?: LatencyReportResolver;
  skip?: (req: Request, res: Response) => boolean;
  onLatencyReportError?: LatencyReportErrorHandler;
}

export function latencyReporter(options?: LatencyReporterMiddlewareOptions): RequestHandler;

export function attachLatencyReporter(
  req: Request,
  res: Response,
  client: RClient,
  reporterConfig: LatencyTracker | LatencyTracker[] | LatencyReportResolver,
  onLatencyReportError?: LatencyReportErrorHandler
): void;

export function resource(
  bucketName: string,
  window: number | string,
  rateLimit: number,
  tokensRequested?: number
): ResourceRequest;

export function latencyTracker(
  latencyTrackerName: string,
  options?: LatencyTrackerOptions
): LatencyTracker;

export function guard(
  tracker: LatencyTracker,
  thresholdMs: number | string
): LatencyGuard;

export function latencyBlock(
  tracker: LatencyTracker,
  observedLatency: number
): ServiceLatencyBlock;

export function createLatencyGuard(
  tracker: LatencyTracker,
  thresholdMs: number | string
): LatencyGuard;

export function createLatencyBlock(
  tracker: LatencyTracker,
  observedLatency: number
): ServiceLatencyBlock;

export function resolveClient(options?: ClientOptions | RClient): RClient;
export function createClient(options?: ClientOptions | RClient): RClient;
export function closeSharedClients(): void;

export class RateLimitDeniedError extends Error {
  statusCode: number;
  status: number;
  result: RateLimitResult | null;
  guardResults: GuardResult[];
  resourceResults: ResourceResult[];
  retryAfterSeconds: number | null;

  constructor(message?: string, options?: object);
}

export class RateLimitUnavailableError extends Error {
  statusCode: number;
  status: number;
  cause: Error | null;

  constructor(message?: string, options?: { cause?: Error; statusCode?: number });
}

export class RateLimitConfigurationError extends Error {
  code: 'RATELIMITLY_CONFIGURATION';
  cause: Error | null;

  constructor(message?: string, options?: { cause?: Error });
}

export function parseDuration(
  value: number | string | undefined | null,
  defaultMs?: number
): number;

export function getClientIp(req: Request): string;
export function defaultKeyGenerator(req: Request, res: Response): string;
export function defaultMetricsLabel(req: Request, res: Response): string;

export interface RateLimitHeaderOptions {
  standardHeaders?: boolean | 'draft-6' | 'draft-7' | 'draft-8';
  legacyHeaders?: boolean;
}

export interface RateLimitHeaderParameters {
  options: RateLimitHeaderOptions;
  result?: RateLimitResult | null;
  limit?: number;
  windowMs?: number;
  tokensRequested?: number;
  isAllowed?: boolean;
}

export function setRateLimitHeaders(
  res: Pick<Response, 'setHeader'>,
  parameters: RateLimitHeaderParameters
): void;
