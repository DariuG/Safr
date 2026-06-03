/**
 * Helper-e pentru permisiuni platform-specific.
 *
 * Extras pentru a putea cere permisiunea de locație din mai multe locuri:
 *  - App.tsx, la pornire (pentru prefetch-ul de shelters)
 *  - MapScreen, la mount (pentru afișarea locației user-ului)
 */

import { Platform, PermissionsAndroid } from 'react-native';
import Geolocation from 'react-native-geolocation-service';

export type LocationPermissionStatus =
  | 'granted'
  | 'denied'
  | 'disabled'
  | 'restricted'
  | 'unavailable';

/**
 * Cere permisiunea de locație (whenInUse pe iOS, ACCESS_FINE_LOCATION pe Android).
 * Returnează statusul detaliat. Idempotent — dacă permisiunea e deja acordată,
 * dialogul sistemului nu mai apare.
 */
export const requestLocationPermission = async (): Promise<LocationPermissionStatus> => {
  if (Platform.OS === 'ios') {
    const authStatus = await Geolocation.requestAuthorization('whenInUse');
    return authStatus as LocationPermissionStatus;
  }

  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    {
      title: 'Permisiune Locație Safr',
      message:
        'Safr are nevoie de acces la locația ta pentru a afișa adăposturile de urgență din apropiere.',
      buttonNeutral: 'Întreabă mai târziu',
      buttonNegative: 'Anulează',
      buttonPositive: 'OK',
    },
  );

  if (granted === PermissionsAndroid.RESULTS.GRANTED) {
    return 'granted';
  }
  if (granted === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
    return 'restricted';
  }
  return 'denied';
};

/**
 * Variantă boolean pentru cazurile în care contează doar dacă avem voie.
 */
export const ensureLocationPermission = async (): Promise<boolean> => {
  const status = await requestLocationPermission();
  return status === 'granted';
};
