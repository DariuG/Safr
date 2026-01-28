import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

// --- TYPES ---
export interface Shelter {
  id: string;
  type: 'hospital' | 'pharmacy' | 'fire' | 'police' | 'bunker' | 'unknown';
  lat: number;
  lng: number;
  name: string;
  capacity?: string;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: {
    lat: number;
    lon: number;
  };
  tags?: {
    name?: string;
    amenity?: string;
    capacity?: string;
    [key: string]: string | undefined;
  };
}

interface OverpassResponse {
  elements: OverpassElement[];
}

interface ShelterServiceResult {
  shelters: Shelter[];
  source: 'cache' | 'api' | 'fallback';
  error?: string;
}

// --- CONSTANTS ---
const STORAGE_KEY = '@safr_shelters_cache';
const STORAGE_TIMESTAMP_KEY = '@safr_shelters_timestamp';
const API_TIMEOUT = 30000; // 30 seconds (Overpass can be slow)
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Overpass API endpoints (try main first, fallback to mirrors)
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',      // Main endpoint
  'https://lz4.overpass-api.de/api/interpreter',  // Fast mirror
  'https://overpass.kumi.systems/api/interpreter', // Alternative mirror
];

// Bounding box for Timisoara area
const BBOX = {
  south: 45.65,
  west: 21.10,
  north: 45.85,
  east: 21.35,
};

// Overpass QL query - fetches emergency-related POIs
const OVERPASS_QUERY = `
[out:json][timeout:25];
(
  node["amenity"="hospital"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["amenity"="hospital"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  node["amenity"="pharmacy"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  node["amenity"="fire_station"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["amenity"="fire_station"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  node["amenity"="police"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
  way["amenity"="police"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east});
);
out center;
`.trim();

// Fallback data in case everything fails
const FALLBACK_SHELTERS: Shelter[] = [
  { id: 'fallback_1', type: 'hospital', lat: 45.738205, lng: 21.242398, name: 'Spitalul Județean Timișoara' },
  { id: 'fallback_2', type: 'hospital', lat: 45.747479, lng: 21.226180, name: 'Spitalul Municipal' },
  { id: 'fallback_3', type: 'fire', lat: 45.755800, lng: 21.228900, name: 'Stație Pompieri Centru' },
  { id: 'fallback_4', type: 'pharmacy', lat: 45.753200, lng: 21.225600, name: 'Farmacie Centrală' },
  { id: 'fallback_5', type: 'police', lat: 45.754100, lng: 21.226800, name: 'Poliția Municipiului Timișoara' },
];

// --- HELPER FUNCTIONS ---

/**
 * Map OSM amenity type to our Shelter type
 */
const mapAmenityToType = (amenity?: string): Shelter['type'] => {
  switch (amenity) {
    case 'hospital':
      return 'hospital';
    case 'pharmacy':
      return 'pharmacy';
    case 'fire_station':
      return 'fire';
    case 'police':
      return 'police';
    case 'shelter':
      return 'bunker';
    default:
      return 'unknown';
  }
};

/**
 * Extract coordinates from an Overpass element
 * Nodes have lat/lon directly, ways have center.lat/center.lon
 */
const extractCoordinates = (element: OverpassElement): { lat: number; lng: number } | null => {
  if (element.type === 'node' && element.lat !== undefined && element.lon !== undefined) {
    return { lat: element.lat, lng: element.lon };
  }

  if ((element.type === 'way' || element.type === 'relation') && element.center) {
    return { lat: element.center.lat, lng: element.center.lon };
  }

  return null;
};

/**
 * Transform an Overpass element to our Shelter interface
 */
const transformToShelter = (element: OverpassElement): Shelter | null => {
  const coords = extractCoordinates(element);
  if (!coords) {
    return null;
  }

  const type = mapAmenityToType(element.tags?.amenity);
  const name = element.tags?.name || `${type.charAt(0).toUpperCase() + type.slice(1)} #${element.id}`;

  return {
    id: `osm_${element.type}_${element.id}`,
    type,
    lat: coords.lat,
    lng: coords.lng,
    name,
    capacity: element.tags?.capacity,
  };
};


// --- CACHE FUNCTIONS ---

/**
 * Load shelters from AsyncStorage cache
 */
const loadFromCache = async (): Promise<Shelter[] | null> => {
  try {
    const [cachedData, timestampStr] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(STORAGE_TIMESTAMP_KEY),
    ]);

    if (!cachedData) {
      console.log('[ShelterService] No cache found');
      return null;
    }

    // Check cache age
    if (timestampStr) {
      const cacheAge = Date.now() - parseInt(timestampStr, 10);
      if (cacheAge > CACHE_MAX_AGE) {
        console.log('[ShelterService] Cache expired (age:', Math.round(cacheAge / 3600000), 'hours)');
        // Don't return null - still use stale cache, but we'll try to refresh
      }
    }

    const shelters: Shelter[] = JSON.parse(cachedData);
    console.log('[ShelterService] Loaded', shelters.length, 'shelters from cache');
    return shelters;
  } catch (error) {
    console.error('[ShelterService] Error loading cache:', error);
    return null;
  }
};

/**
 * Save shelters to AsyncStorage cache
 */
const saveToCache = async (shelters: Shelter[]): Promise<void> => {
  try {
    await Promise.all([
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(shelters)),
      AsyncStorage.setItem(STORAGE_TIMESTAMP_KEY, Date.now().toString()),
    ]);
    console.log('[ShelterService] Saved', shelters.length, 'shelters to cache');
  } catch (error) {
    console.error('[ShelterService] Error saving to cache:', error);
  }
};

// --- API FUNCTIONS ---

/**
 * Fetch shelters from Overpass API using axios
 * Tries multiple endpoints if one fails
 */
const fetchFromAPI = async (): Promise<Shelter[]> => {
  let lastError: Error | null = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`[ShelterService] Trying endpoint: ${endpoint}`);

      const response = await axios.post<OverpassResponse>(
        endpoint,
        `data=${encodeURIComponent(OVERPASS_QUERY)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          timeout: API_TIMEOUT,
        }
      );

      const data = response.data;

      if (!data.elements || !Array.isArray(data.elements)) {
        console.warn(`[ShelterService] Invalid response from ${endpoint}`);
        continue; // Try next endpoint
      }

      console.log(`[ShelterService] Success! Received ${data.elements.length} elements from ${endpoint}`);

      // Transform OSM elements to Shelter objects
      const shelters: Shelter[] = data.elements
        .map(transformToShelter)
        .filter((shelter): shelter is Shelter => shelter !== null);

      console.log(`[ShelterService] Transformed to ${shelters.length} valid shelters`);

      return shelters;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`[ShelterService] Endpoint ${endpoint} failed: ${errorMsg}`);
      lastError = error instanceof Error ? error : new Error(errorMsg);
      // Continue to next endpoint
    }
  }

  // All endpoints failed
  throw lastError || new Error('All Overpass API endpoints failed');
};

// --- MAIN SERVICE FUNCTION ---

/**
 * Get shelters using cache-first strategy
 *
 * 1. Load from cache immediately (if available)
 * 2. Fetch from API in background
 * 3. If API succeeds, update cache and return new data
 * 4. If API fails and no cache, return fallback data
 *
 * @returns Promise with shelters array, source, and optional error
 */
export const getShelters = async (): Promise<ShelterServiceResult> => {
  let cachedShelters: Shelter[] | null = null;

  // Step 1: Try to load from cache first
  try {
    cachedShelters = await loadFromCache();
  } catch (error) {
    console.error('[ShelterService] Cache load error:', error);
  }

  // Step 2: Try to fetch from API
  try {
    const apiShelters = await fetchFromAPI();

    if (apiShelters.length > 0) {
      // Save to cache for future use
      await saveToCache(apiShelters);

      return {
        shelters: apiShelters,
        source: 'api',
      };
    }

    // API returned empty results - use cache if available
    if (cachedShelters && cachedShelters.length > 0) {
      return {
        shelters: cachedShelters,
        source: 'cache',
        error: 'API returned empty results, using cached data',
      };
    }
  } catch (apiError) {
    const errorMessage = apiError instanceof Error ? apiError.message : 'Unknown API error';
    console.error('[ShelterService] API fetch error:', errorMessage);

    // API failed - return cached data if available
    if (cachedShelters && cachedShelters.length > 0) {
      return {
        shelters: cachedShelters,
        source: 'cache',
        error: `API unavailable: ${errorMessage}`,
      };
    }
  }

  // Step 3: No cache and API failed - use fallback
  console.warn('[ShelterService] Using fallback data');
  return {
    shelters: FALLBACK_SHELTERS,
    source: 'fallback',
    error: 'No network connection and no cached data available',
  };
};

/**
 * Force refresh shelters from API (ignores cache)
 */
export const refreshShelters = async (): Promise<ShelterServiceResult> => {
  try {
    const apiShelters = await fetchFromAPI();

    if (apiShelters.length > 0) {
      await saveToCache(apiShelters);
      return {
        shelters: apiShelters,
        source: 'api',
      };
    }

    // API returned empty, try cache
    const cachedShelters = await loadFromCache();
    if (cachedShelters && cachedShelters.length > 0) {
      return {
        shelters: cachedShelters,
        source: 'cache',
        error: 'Refresh returned empty results',
      };
    }

    return {
      shelters: FALLBACK_SHELTERS,
      source: 'fallback',
      error: 'Refresh failed',
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Try cache on error
    const cachedShelters = await loadFromCache();
    if (cachedShelters && cachedShelters.length > 0) {
      return {
        shelters: cachedShelters,
        source: 'cache',
        error: `Refresh failed: ${errorMessage}`,
      };
    }

    return {
      shelters: FALLBACK_SHELTERS,
      source: 'fallback',
      error: `Refresh failed: ${errorMessage}`,
    };
  }
};

/**
 * Clear the shelter cache
 */
export const clearShelterCache = async (): Promise<void> => {
  try {
    await Promise.all([
      AsyncStorage.removeItem(STORAGE_KEY),
      AsyncStorage.removeItem(STORAGE_TIMESTAMP_KEY),
    ]);
    console.log('[ShelterService] Cache cleared');
  } catch (error) {
    console.error('[ShelterService] Error clearing cache:', error);
  }
};

/**
 * Get cache info (for debugging)
 */
export const getCacheInfo = async (): Promise<{ exists: boolean; count: number; ageHours: number | null }> => {
  try {
    const [cachedData, timestampStr] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(STORAGE_TIMESTAMP_KEY),
    ]);

    if (!cachedData) {
      return { exists: false, count: 0, ageHours: null };
    }

    const shelters: Shelter[] = JSON.parse(cachedData);
    const ageHours = timestampStr
      ? Math.round((Date.now() - parseInt(timestampStr, 10)) / 3600000)
      : null;

    return {
      exists: true,
      count: shelters.length,
      ageHours,
    };
  } catch {
    return { exists: false, count: 0, ageHours: null };
  }
};
