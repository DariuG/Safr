import { Alert, Linking, Platform } from 'react-native';

interface NavigationDestination {
  lat: number;
  lng: number;
  label?: string;
}

interface NavigationApp {
  name: string;
  icon: string;
  getUrl: (dest: NavigationDestination, mode: 'driving' | 'walking') => string;
  checkAvailable?: () => Promise<boolean>;
}

// Travel mode mapping for different apps
const travelModes = {
  googleMaps: { driving: 'driving', walking: 'walking' },
  waze: { driving: 'driving', walking: 'walking' }, // Waze only supports driving but we include it
  appleMaps: { driving: 'd', walking: 'w' },
};

// Available navigation apps
const navigationApps: NavigationApp[] = [
  {
    name: 'Google Maps',
    icon: '🗺️',
    getUrl: (dest, mode) => {
      const travelMode = travelModes.googleMaps[mode];
      if (Platform.OS === 'android') {
        // Android: Use intent for Google Maps app
        return `google.navigation:q=${dest.lat},${dest.lng}&mode=${mode === 'walking' ? 'w' : 'd'}`;
      }
      // iOS/Web: Use universal URL
      return `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=${travelMode}`;
    },
  },
  {
    name: 'Waze',
    icon: '🚗',
    getUrl: (dest) => {
      return `https://waze.com/ul?ll=${dest.lat},${dest.lng}&navigate=yes`;
    },
  },
  ...(Platform.OS === 'ios'
    ? [
        {
          name: 'Apple Maps',
          icon: '🍎',
          getUrl: (dest: NavigationDestination, mode: 'driving' | 'walking') => {
            const travelMode = travelModes.appleMaps[mode];
            return `maps://app?daddr=${dest.lat},${dest.lng}&dirflg=${travelMode}`;
          },
        },
      ]
    : []),
];

/**
 * Check if a URL scheme can be opened
 */
const canOpenUrl = async (url: string): Promise<boolean> => {
  try {
    return await Linking.canOpenURL(url);
  } catch {
    return false;
  }
};

/**
 * Open navigation to a destination
 */
const openNavigation = async (
  app: NavigationApp,
  destination: NavigationDestination,
  mode: 'driving' | 'walking'
): Promise<boolean> => {
  const url = app.getUrl(destination, mode);

  try {
    const canOpen = await canOpenUrl(url);

    if (!canOpen) {
      // Try web fallback for Google Maps
      if (app.name === 'Google Maps') {
        const webUrl = `https://www.google.com/maps/dir/?api=1&destination=${destination.lat},${destination.lng}&travelmode=${mode}`;
        await Linking.openURL(webUrl);
        return true;
      }
      return false;
    }

    await Linking.openURL(url);
    return true;
  } catch (error) {
    console.error(`[Navigation] Error opening ${app.name}:`, error);
    return false;
  }
};

/**
 * Show navigation options dialog and open selected app
 */
export const showNavigationOptions = (
  destination: NavigationDestination,
  userLocation?: { latitude: number; longitude: number } | null
): void => {
  // Build options array
  const options = [
    ...navigationApps.map((app) => `${app.icon} ${app.name}`),
    'Anulează',
  ];

  Alert.alert(
    '🧭 Navigare',
    `Alege aplicația pentru navigare către:\n${destination.label || 'destinație'}`,
    [
      // Driving options
      {
        text: '🚗 Cu mașina',
        onPress: () => showAppSelector(destination, 'driving'),
      },
      // Walking options
      {
        text: '🚶 Pe jos',
        onPress: () => showAppSelector(destination, 'walking'),
      },
      // Cancel
      {
        text: 'Anulează',
        style: 'cancel',
      },
    ]
  );
};

/**
 * Show app selector for a specific travel mode
 */
const showAppSelector = (
  destination: NavigationDestination,
  mode: 'driving' | 'walking'
): void => {
  const modeLabel = mode === 'driving' ? 'cu mașina' : 'pe jos';

  Alert.alert(
    `Navigare ${modeLabel}`,
    'Alege aplicația:',
    [
      ...navigationApps.map((app) => ({
        text: `${app.icon} ${app.name}`,
        onPress: async () => {
          const success = await openNavigation(app, destination, mode);
          if (!success) {
            Alert.alert(
              'Aplicație indisponibilă',
              `${app.name} nu este instalată sau nu poate fi deschisă.`,
              [{ text: 'OK' }]
            );
          }
        },
      })),
      {
        text: 'Anulează',
        style: 'cancel',
      },
    ]
  );
};

/**
 * Quick navigation - opens Google Maps directly with driving mode
 */
export const quickNavigate = async (
  destination: NavigationDestination,
  mode: 'driving' | 'walking' = 'driving'
): Promise<boolean> => {
  const googleMaps = navigationApps.find((app) => app.name === 'Google Maps');
  if (googleMaps) {
    return openNavigation(googleMaps, destination, mode);
  }
  return false;
};

/**
 * Calculate approximate distance between two points (Haversine formula)
 * Returns distance in kilometers
 */
export const calculateDistance = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number => {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const toRad = (deg: number): number => deg * (Math.PI / 180);

/**
 * Format distance for display
 */
export const formatDistance = (distanceKm: number): string => {
  if (distanceKm < 1) {
    return `${Math.round(distanceKm * 1000)} m`;
  }
  return `${distanceKm.toFixed(1)} km`;
};

/**
 * Estimate travel time
 * Returns time in minutes
 */
export const estimateTravelTime = (
  distanceKm: number,
  mode: 'driving' | 'walking'
): number => {
  // Average speeds: driving ~40 km/h in city, walking ~5 km/h
  const speedKmH = mode === 'driving' ? 40 : 5;
  return Math.round((distanceKm / speedKmH) * 60);
};

/**
 * Format travel time for display
 */
export const formatTravelTime = (minutes: number): string => {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
};
