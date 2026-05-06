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
const STORAGE_CENTER_KEY = '@safr_shelters_center'; // Centru geo al cache-ului
const API_TIMEOUT = 30000; // 30 seconds (Overpass can be slow)
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Raza zonei în jurul user-ului (km). 20 km acoperă un oraș mare + suburbii.
export const SEARCH_RADIUS_KM = 20;

// Prag în km peste care cache-ul devine invalid (user s-a deplasat prea mult
// față de centrul în care s-au obținut POI-urile inițial).
const CACHE_RELOCATE_THRESHOLD_KM = 10;

// Overpass API endpoints (try main first, fallback to mirrors)
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',      // Main endpoint
  'https://lz4.overpass-api.de/api/interpreter',  // Fast mirror
  'https://overpass.kumi.systems/api/interpreter', // Alternative mirror
];

/**
 * Construiește un bounding box în jurul unei coordonate GPS, cu raza specificată (km).
 * Folosește aproximarea: 1° latitudine ≈ 111 km; 1° longitudine ≈ 111 * cos(lat) km.
 */
const buildBoundingBox = (lat: number, lng: number, radiusKm: number) => {
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return {
    south: lat - latDelta,
    north: lat + latDelta,
    west: lng - lngDelta,
    east: lng + lngDelta,
  };
};

/**
 * Distanță între două coordonate (km) — formula Haversine.
 * Duplicat din utils/navigation pentru a evita dependințe circulare.
 */
const haversineKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

/**
 * Overpass QL query construit dinamic pentru bounding box-ul dat.
 * Folosește `nwr` (node + way + relation) pentru a captura toate tipurile de OSM elements.
 * Include atât schema veche (`amenity=*`), cât și schema nouă OSM Healthcare 2.0 (`healthcare=*`).
 */
const buildOverpassQuery = (bbox: {south: number; west: number; north: number; east: number}) => {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:60];
(
  nwr["amenity"="hospital"](${b});
  nwr["healthcare"="hospital"](${b});
  nwr["amenity"="clinic"](${b});
  nwr["healthcare"="clinic"](${b});
  nwr["amenity"="doctors"](${b});
  nwr["amenity"="pharmacy"](${b});
  nwr["healthcare"="pharmacy"](${b});
  nwr["amenity"="fire_station"](${b});
  nwr["amenity"="police"](${b});
  nwr["amenity"="shelter"](${b});
  nwr["emergency"="assembly_point"](${b});
);
out center;
`.trim();
};

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
 * Determină tipul Shelter pe baza tag-urilor OSM.
 * Verifică atât schema veche (`amenity=*`), cât și schema nouă (`healthcare=*`, `emergency=*`).
 * Prioritatea: amenity > healthcare > emergency.
 */
const mapTagsToType = (tags?: OverpassElement['tags']): Shelter['type'] => {
  if (!tags) return 'unknown';

  // Spitale: amenity=hospital SAU healthcare=hospital
  if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') {
    return 'hospital';
  }
  // Clinici și cabinete medicale → tratate tot ca 'hospital' pentru UI simplu
  if (tags.amenity === 'clinic' || tags.healthcare === 'clinic' || tags.amenity === 'doctors') {
    return 'hospital';
  }
  // Farmacii
  if (tags.amenity === 'pharmacy' || tags.healthcare === 'pharmacy') {
    return 'pharmacy';
  }
  // Pompieri
  if (tags.amenity === 'fire_station') {
    return 'fire';
  }
  // Poliție
  if (tags.amenity === 'police') {
    return 'police';
  }
  // Adăposturi / puncte de adunare
  if (tags.amenity === 'shelter' || tags.emergency === 'assembly_point') {
    return 'bunker';
  }
  return 'unknown';
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

  const type = mapTagsToType(element.tags);
  // Dacă nu are niciun tag cunoscut, skip — evităm să afișăm markere "unknown"
  if (type === 'unknown') {
    return null;
  }
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
 * Load shelters from AsyncStorage cache.
 * Returnează și centrul geografic pentru care a fost salvat cache-ul —
 * astfel putem verifica dacă cache-ul mai e relevant pentru poziția curentă.
 */
const loadFromCache = async (): Promise<{shelters: Shelter[]; center: {lat: number; lng: number} | null} | null> => {
  try {
    const [cachedData, timestampStr, centerStr] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(STORAGE_TIMESTAMP_KEY),
      AsyncStorage.getItem(STORAGE_CENTER_KEY),
    ]);

    if (!cachedData) {
      console.log('[ShelterService] No cache found');
      return null;
    }

    if (timestampStr) {
      const cacheAge = Date.now() - parseInt(timestampStr, 10);
      if (cacheAge > CACHE_MAX_AGE) {
        console.log('[ShelterService] Cache expired (age:', Math.round(cacheAge / 3600000), 'hours)');
      }
    }

    const shelters: Shelter[] = JSON.parse(cachedData);
    const center = centerStr ? JSON.parse(centerStr) : null;
    console.log('[ShelterService] Loaded', shelters.length, 'shelters from cache');
    return {shelters, center};
  } catch (error) {
    console.error('[ShelterService] Error loading cache:', error);
    return null;
  }
};

/**
 * Save shelters to AsyncStorage cache, împreună cu centrul geografic (pentru
 * verificarea relevanței la apeluri viitoare).
 */
const saveToCache = async (shelters: Shelter[], center: {lat: number; lng: number}): Promise<void> => {
  try {
    await Promise.all([
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(shelters)),
      AsyncStorage.setItem(STORAGE_TIMESTAMP_KEY, Date.now().toString()),
      AsyncStorage.setItem(STORAGE_CENTER_KEY, JSON.stringify(center)),
    ]);
    console.log('[ShelterService] Saved', shelters.length, 'shelters to cache (center:', center, ')');
  } catch (error) {
    console.error('[ShelterService] Error saving to cache:', error);
  }
};

// --- API FUNCTIONS ---

/**
 * Fetch shelters from Overpass API using axios, pentru coordonatele date.
 * Query-ul se construiește dinamic cu bounding box de SEARCH_RADIUS_KM în jurul punctului.
 * Tries multiple endpoints if one fails.
 */
const fetchFromAPI = async (center: {lat: number; lng: number}): Promise<Shelter[]> => {
  let lastError: Error | null = null;
  const bbox = buildBoundingBox(center.lat, center.lng, SEARCH_RADIUS_KM);
  const query = buildOverpassQuery(bbox);

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`[ShelterService] Trying endpoint: ${endpoint} (center: ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)})`);

      const response = await axios.post<OverpassResponse>(
        endpoint,
        `data=${encodeURIComponent(query)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            // Overpass fair-use policy cere User-Agent identificabil.
            // Unele mirrors returnează 406 fără el.
            'User-Agent': 'Safr/1.0 (emergency-app; contact: admin@safr.ro)',
          },
          timeout: API_TIMEOUT,
          // Overpass returnează JSON (configurat via [out:json] în query),
          // dar nu declara Accept — provoacă 406 pe unele mirrors.
          responseType: 'json',
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
 * Obține shelters în jurul unei locații GPS, cu strategie cache-first.
 *
 * Logica de validitate cache:
 * 1. Dacă cache-ul există și user-ul e la <CACHE_RELOCATE_THRESHOLD_KM față de
 *    centrul cache-ului → cache valid, îl folosim (+ refresh din API în background).
 * 2. Dacă user-ul s-a deplasat semnificativ → invalidăm cache-ul și cerem date noi.
 *
 * @param userLocation — coordonate GPS user. Dacă null → fallback hardcodat.
 * @returns Promise cu shelters, sursa datelor și eroare opțională.
 */
export const getShelters = async (
  userLocation: {latitude: number; longitude: number} | null,
): Promise<ShelterServiceResult> => {
  // Fără locație GPS → nu putem construi bounding box. Returnăm fallback.
  if (!userLocation) {
    console.warn('[ShelterService] No user location, returning fallback');
    return {
      shelters: FALLBACK_SHELTERS,
      source: 'fallback',
      error: 'Locația GPS nu este disponibilă',
    };
  }

  const center = {lat: userLocation.latitude, lng: userLocation.longitude};
  let cached: {shelters: Shelter[]; center: {lat: number; lng: number} | null} | null = null;

  try {
    cached = await loadFromCache();
  } catch (error) {
    console.error('[ShelterService] Cache load error:', error);
  }

  // Verificare relevanță cache: user s-a mutat prea mult față de centrul cache-ului?
  const cacheStillRelevant =
    cached &&
    cached.center &&
    haversineKm(center.lat, center.lng, cached.center.lat, cached.center.lng) <
      CACHE_RELOCATE_THRESHOLD_KM;

  try {
    const apiShelters = await fetchFromAPI(center);

    if (apiShelters.length > 0) {
      await saveToCache(apiShelters, center);
      return {shelters: apiShelters, source: 'api'};
    }

    if (cacheStillRelevant && cached) {
      return {
        shelters: cached.shelters,
        source: 'cache',
        error: 'API returned empty results, using cached data',
      };
    }
  } catch (apiError) {
    const errorMessage = apiError instanceof Error ? apiError.message : 'Unknown API error';
    console.error('[ShelterService] API fetch error:', errorMessage);

    if (cacheStillRelevant && cached) {
      return {
        shelters: cached.shelters,
        source: 'cache',
        error: `API indisponibil: ${errorMessage}`,
      };
    }
  }

  console.warn('[ShelterService] Using fallback data');
  return {
    shelters: FALLBACK_SHELTERS,
    source: 'fallback',
    error: 'Fără conexiune și fără date cache pentru zonă',
  };
};

/**
 * Force refresh shelters din API (ignoră cache, necesită GPS).
 */
export const refreshShelters = async (
  userLocation: {latitude: number; longitude: number} | null,
): Promise<ShelterServiceResult> => {
  if (!userLocation) {
    return {
      shelters: FALLBACK_SHELTERS,
      source: 'fallback',
      error: 'Locația GPS nu este disponibilă',
    };
  }

  const center = {lat: userLocation.latitude, lng: userLocation.longitude};

  try {
    const apiShelters = await fetchFromAPI(center);

    if (apiShelters.length > 0) {
      await saveToCache(apiShelters, center);
      return {shelters: apiShelters, source: 'api'};
    }

    const cached = await loadFromCache();
    if (cached && cached.shelters.length > 0) {
      return {shelters: cached.shelters, source: 'cache', error: 'Refresh returned empty results'};
    }

    return {shelters: FALLBACK_SHELTERS, source: 'fallback', error: 'Refresh failed'};
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const cached = await loadFromCache();
    if (cached && cached.shelters.length > 0) {
      return {shelters: cached.shelters, source: 'cache', error: `Refresh failed: ${errorMessage}`};
    }
    return {shelters: FALLBACK_SHELTERS, source: 'fallback', error: `Refresh failed: ${errorMessage}`};
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
      AsyncStorage.removeItem(STORAGE_CENTER_KEY),
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
