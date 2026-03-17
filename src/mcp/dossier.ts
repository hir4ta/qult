import type { Store } from '../store/index.js';
import type { Embedder } from '../embedder/index.js';

interface DossierParams {
  action: string;
  project_path?: string;
  task_slug?: string;
  description?: string;
  file?: string;
  content?: string;
  mode?: string;
  size?: string;
  spec_type?: string;
  version?: string;
  confirm?: boolean;
}

export async function handleDossier(
  _store: Store,
  _emb: Embedder | null,
  params: DossierParams,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const result = { action: params.action, status: 'not_implemented' };
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}
