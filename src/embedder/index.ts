import { VoyageClient } from './voyage.js';
export type { RerankResult } from './voyage.js';

export class Embedder {
  private readonly client: VoyageClient;

  private constructor(client: VoyageClient) {
    this.client = client;
  }

  static create(): Embedder {
    const apiKey = process.env['VOYAGE_API_KEY'];
    if (!apiKey) {
      throw new Error(
        "VOYAGE_API_KEY is required but not set (get a key at https://dash.voyageai.com/)",
      );
    }
    return new Embedder(new VoyageClient(apiKey));
  }

  get dims(): number {
    return this.client.dims;
  }

  get model(): string {
    return this.client.model;
  }

  async embedForSearch(query: string, signal?: AbortSignal): Promise<number[]> {
    return this.client.embedForSearch(query, signal);
  }

  async embedForStorage(text: string, signal?: AbortSignal): Promise<number[]> {
    return this.client.embedForStorage(text, signal);
  }

  async embedBatchForStorage(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    return this.client.embed(texts, 'document', signal);
  }

  async validate(signal?: AbortSignal): Promise<void> {
    await this.client.embed(['test'], 'query', signal);
  }

  async rerank(query: string, documents: string[], topK: number, signal?: AbortSignal) {
    return this.client.rerank(query, documents, topK, signal);
  }
}
