export interface KnowledgeRow {
  id: number;
  filePath: string;
  contentHash: string;
  title: string;
  content: string;
  subType: string;
  projectRemote: string;
  projectPath: string;
  projectName: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  hitCount: number;
  lastAccessed: string;
  enabled: boolean;
}

export interface KnowledgeStats {
  total: number;
  bySubType: Record<string, number>;
  avgHitCount: number;
  topAccessed: KnowledgeRow[];
}

export interface LowVitalityRow extends KnowledgeRow {
  vitality: number;
}

export interface VectorMatch {
  sourceId: number;
  score: number;
}

export interface KnowledgeConflict {
  a: KnowledgeRow;
  b: KnowledgeRow;
  similarity: number;
  type: 'potential_duplicate' | 'potential_contradiction';
}

export interface ProjectInfo {
  remote: string;
  path: string;
  name: string;
  branch: string;
}

export interface SessionLink {
  claudeSessionId: string;
  masterSessionId: string;
  projectRemote: string;
  projectPath: string;
  taskSlug: string;
  branch: string;
  linkedAt: string;
}

export interface SessionContinuity {
  masterSessionId: string;
  linkedSessions: string[];
  compactCount: number;
}

export const SUB_TYPE_GENERAL = 'general' as const;
export const SUB_TYPE_DECISION = 'decision' as const;
export const SUB_TYPE_PATTERN = 'pattern' as const;
export const SUB_TYPE_RULE = 'rule' as const;
