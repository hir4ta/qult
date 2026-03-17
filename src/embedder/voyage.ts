const DEFAULT_API_URL = 'https://api.voyageai.com/v1/embeddings';
const DEFAULT_RERANK_URL = 'https://api.voyageai.com/v1/rerank';
const DEFAULT_MODEL = 'voyage-4-large';
const DEFAULT_RERANK_MODEL = 'rerank-2.5';
const DEFAULT_DIMS = 2048;

function envOr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function envIntOr(key: string, fallback: number): number {
  const v = process.env[key];
  if (v) {
    const n = parseInt(v, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return fallback;
}

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

interface VoyageRequest {
  input: string[];
  model: string;
  input_type?: string;
  output_dimension?: number;
}

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
  usage: { total_tokens: number };
}

interface VoyageErrorResponse {
  detail: string;
  type?: string;
  code?: string;
}

interface RerankRequest {
  query: string;
  documents: string[];
  model: string;
  top_k?: number;
  return_documents: boolean;
}

interface RerankResponse {
  data: Array<{ index: number; relevance_score: number }>;
}

class VoyageError extends Error {
  readonly status: number;
  readonly detail: string;
  readonly raw: string;
  readonly errResp?: VoyageErrorResponse;

  constructor(status: number, detail: string, raw: string, errResp?: VoyageErrorResponse) {
    super(
      status === 401 || status === 403
        ? `embedder: voyage returned ${status}: authentication failed (check VOYAGE_API_KEY)`
        : `embedder: voyage returned ${status}: ${detail}`,
    );
    this.status = status;
    this.detail = detail;
    this.raw = raw;
    this.errResp = errResp;
  }
}

const TRANSIENT_ERROR_TYPES = new Set([
  'temporary_error', 'transient_error', 'overloaded',
  'rate_limited', 'capacity_exceeded', 'service_unavailable',
]);

const TRANSIENT_MESSAGE_PATTERNS = [
  'request to model', 'model is overloaded', 'temporarily',
  'try again', 'service unavailable', 'internal server error', 'over capacity',
];

function isVoyageTransient(detail: string): boolean {
  const lower = detail.toLowerCase();
  return TRANSIENT_MESSAGE_PATTERNS.some(p => lower.includes(p));
}

function isVoyageTransientStructured(errResp?: VoyageErrorResponse): boolean {
  if (!errResp) return false;
  if (errResp.type && TRANSIENT_ERROR_TYPES.has(errResp.type.toLowerCase())) return true;
  if (errResp.code && TRANSIENT_ERROR_TYPES.has(errResp.code.toLowerCase())) return true;
  return false;
}

async function retryVoyage<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay = (1 << attempt) * 1000; // 2s, 4s
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delay);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (err instanceof VoyageError) {
        if (err.status === 429 || err.status >= 500) continue;
        if (err.status === 400 && (isVoyageTransient(err.detail) || isVoyageTransientStructured(err.errResp))) continue;
        throw err;
      }
      // Network/DNS/TLS errors — retry.
      continue;
    }
  }
  throw lastErr;
}

export class VoyageClient {
  private readonly apiKey: string;
  readonly apiURL: string;
  readonly rerankURL: string;
  readonly model: string;
  readonly rerankModel: string;
  readonly dims: number;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.apiURL = envOr('VOYAGE_API_URL', DEFAULT_API_URL);
    this.rerankURL = envOr('VOYAGE_RERANK_API_URL', DEFAULT_RERANK_URL);
    this.model = envOr('VOYAGE_MODEL', DEFAULT_MODEL);
    this.rerankModel = envOr('VOYAGE_RERANK_MODEL', DEFAULT_RERANK_MODEL);
    this.dims = envIntOr('VOYAGE_DIMS', DEFAULT_DIMS);
  }

  async embed(texts: string[], inputType: string, signal?: AbortSignal): Promise<number[][]> {
    const payload: VoyageRequest = {
      input: texts,
      model: this.model,
      input_type: inputType,
      output_dimension: this.dims,
    };
    return retryVoyage(() => this.doEmbed(payload, signal), signal);
  }

  private async doEmbed(payload: VoyageRequest, signal?: AbortSignal): Promise<number[][]> {
    const resp = await fetch(this.apiURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      let errResp: VoyageErrorResponse | undefined;
      try {
        const parsed = JSON.parse(raw) as VoyageErrorResponse;
        if (parsed.detail) errResp = parsed;
      } catch { /* ignore */ }
      throw new VoyageError(resp.status, errResp?.detail ?? raw, raw, errResp);
    }

    const result = await resp.json() as VoyageResponse;
    return result.data.map(d => d.embedding);
  }

  async embedForSearch(query: string, signal?: AbortSignal): Promise<number[]> {
    const vecs = await this.embed([query], 'query', signal);
    if (vecs.length === 0) throw new Error('embedder: no embeddings returned');
    return vecs[0]!;
  }

  async embedForStorage(text: string, signal?: AbortSignal): Promise<number[]> {
    const vecs = await this.embed([text], 'document', signal);
    if (vecs.length === 0) throw new Error('embedder: no embeddings returned');
    return vecs[0]!;
  }

  async rerank(query: string, documents: string[], topK: number, signal?: AbortSignal): Promise<RerankResult[]> {
    const payload: RerankRequest = {
      query,
      documents,
      model: this.rerankModel,
      top_k: topK,
      return_documents: false,
    };
    return retryVoyage(() => this.doRerank(payload, signal), signal);
  }

  private async doRerank(payload: RerankRequest, signal?: AbortSignal): Promise<RerankResult[]> {
    const resp = await fetch(this.rerankURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      let errResp: VoyageErrorResponse | undefined;
      try {
        const parsed = JSON.parse(raw) as VoyageErrorResponse;
        if (parsed.detail) errResp = parsed;
      } catch { /* ignore */ }
      throw new VoyageError(resp.status, errResp?.detail ?? raw, raw, errResp);
    }

    const result = await resp.json() as RerankResponse;
    return result.data.map(d => ({
      index: d.index,
      relevanceScore: d.relevance_score,
    }));
  }
}
