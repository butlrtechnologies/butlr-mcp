/**
 * Fuzzy matching utilities for asset search
 */

export interface SearchableAsset {
  id: string;
  name: string;
  type: "site" | "building" | "floor" | "room" | "zone" | "sensor" | "hive";
  [key: string]: any; // Additional fields
}

export interface MatchResult<T extends SearchableAsset> {
  asset: T;
  score: number;
  matchedField: string;
}

/**
 * Simple fuzzy matching - checks if query is contained in target (case-insensitive)
 * Returns a score based on match quality
 */
export function fuzzyMatch(query: string, target: string): number {
  const lowerQuery = query.toLowerCase().trim();
  const lowerTarget = target.toLowerCase();

  // Exact match
  if (lowerTarget === lowerQuery) {
    return 100;
  }

  // Starts with query
  if (lowerTarget.startsWith(lowerQuery)) {
    return 90;
  }

  // Contains query
  if (lowerTarget.includes(lowerQuery)) {
    return 70;
  }

  // Word boundary match (e.g., "SF" matches "SF Tower")
  const words = lowerTarget.split(/\s+/);
  for (const word of words) {
    if (word.startsWith(lowerQuery)) {
      return 80;
    }
  }

  // No match
  return 0;
}

/**
 * Search through a list of assets by name
 * Returns matches sorted by relevance score
 */
export function searchAssets<T extends SearchableAsset>(
  assets: T[],
  query: string,
  options: {
    matchFields?: string[]; // Fields to search in (default: ["name"])
    minScore?: number; // Minimum score to include (default: 70)
    maxResults?: number; // Maximum results to return (default: 20)
  } = {}
): MatchResult<T>[] {
  const { matchFields = ["name"], minScore = 70, maxResults = 20 } = options;

  if (!query || query.trim().length === 0) {
    return [];
  }

  // Score each asset
  const scored: MatchResult<T>[] = [];

  for (const asset of assets) {
    let bestScore = 0;
    let bestField = "";

    // Try matching against each field
    for (const field of matchFields) {
      const value = asset[field];
      if (typeof value === "string") {
        const score = fuzzyMatch(query, value);
        if (score > bestScore) {
          bestScore = score;
          bestField = field;
        }
      }
    }

    // Include if score meets threshold
    if (bestScore >= minScore) {
      scored.push({
        asset,
        score: bestScore,
        matchedField: bestField,
      });
    }
  }

  // Sort by score (highest first) and limit results
  return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

/**
 * Filter assets by type
 */
export function filterByType<T extends SearchableAsset>(assets: T[], types: string[]): T[] {
  if (!types || types.length === 0) {
    return assets;
  }

  return assets.filter((asset) => types.includes(asset.type));
}
