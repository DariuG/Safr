// @ts-ignore - JSON import
import knowledgeData from '../../assets/knowledge_embedded.json';

export interface KnowledgeEntry {
  id: string;
  tag: string;
  pattern: string;
  response: string;
  embedding: number[];
}

/**
 * Calculate cosine similarity between two embedding vectors
 * @param a First embedding vector
 * @param b Second embedding vector
 * @returns Similarity score between 0 and 1
 */
export const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
};

/**
 * Load the knowledge base from the embedded JSON file
 * @returns Array of knowledge entries with embeddings
 */
export const loadKnowledgeBase = async (): Promise<KnowledgeEntry[]> => {
  try {
    // Simply return the imported JSON data
    const knowledgeBase: KnowledgeEntry[] = knowledgeData as KnowledgeEntry[];
    console.log(`✅ Loaded ${knowledgeBase.length} knowledge entries`);
    return knowledgeBase;
  } catch (error) {
    console.error('❌ Error loading knowledge base:', error);
    throw new Error(`Failed to load knowledge base: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Retrieve the most relevant knowledge entries for a given query embedding
 * @param queryEmbedding The embedding vector of the user's query
 * @param knowledgeBase Array of knowledge entries to search through
 * @param topK Number of top results to return (default: 3)
 * @param threshold Minimum similarity score to include (default: 0.3)
 * @returns Array of relevant knowledge entries with similarity scores
 */
export const retrieveRelevantContext = (
  queryEmbedding: number[],
  knowledgeBase: KnowledgeEntry[],
  topK: number = 3,
  threshold: number = 0.3
): Array<{ entry: KnowledgeEntry; score: number }> => {
  // Calculate similarity scores for all entries
  const scoredEntries = knowledgeBase.map(entry => ({
    entry,
    score: cosineSimilarity(queryEmbedding, entry.embedding),
  }));

  // Filter by threshold and sort by score (descending)
  const filteredAndSorted = scoredEntries
    .filter(item => item.score >= threshold)
    .sort((a, b) => b.score - a.score);

  // Return top K results
  return filteredAndSorted.slice(0, topK);
};

/**
 * Format retrieved context into a string for the LLM prompt
 * @param retrievedEntries Array of retrieved knowledge entries with scores
 * @returns Formatted context string
 */
export const formatContextForPrompt = (
  retrievedEntries: Array<{ entry: KnowledgeEntry; score: number }>
): string => {
  if (retrievedEntries.length === 0) {
    return '';
  }

  // Deduplicate by response text
  const uniqueAnswers = new Map<string, { entry: KnowledgeEntry; score: number }>();
  
  retrievedEntries.forEach(item => {
    const responseText = item.entry.response;
    // Only keep the first occurrence (highest score due to sorted order)
    if (!uniqueAnswers.has(responseText)) {
      uniqueAnswers.set(responseText, item);
    }
  });

  // Format context with response only
  const contextTexts = Array.from(uniqueAnswers.values()).map(item => {
    return item.entry.response;
  });

  return contextTexts.join('\n\n');
};
