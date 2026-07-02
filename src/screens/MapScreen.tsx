import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, Alert, ActivityIndicator, PermissionsAndroid, Linking, TextInput, ScrollView, KeyboardAvoidingView, Keyboard, AppState } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Geolocation from 'react-native-geolocation-service';
import { getShelters, refreshShelters, getCachedShelters, Shelter } from '../services/shelterService';
import {
  showNavigationOptions,
  calculateDistance,
  formatDistance,
  estimateTravelTime,
  formatTravelTime,
} from '../utils/navigation';
import { useAuth } from '../context/AuthContext';
import {
  DisasterAlert,
  AlertType,
  AlertSeverity,
  ALERT_TYPE_LABELS,
  ALERT_SEVERITY_LABELS,
  createAlert,
  subscribeToAlerts,
  deleteAlert,
} from '../services/alertService';
import bleMeshService, { MeshStatus } from '../services/bleMeshService';
import {
  showAlertNotification,
  subscribeAlertFocus,
  AlertFocus,
} from '../services/notificationService';
import mapResourcesService, { MapResourcesState } from '../services/mapResourcesService';
import toastService from '../services/toastService';

// Helper function to create a circle polygon from center point and radius in km
const createCirclePolygon = (centerLng: number, centerLat: number, radiusKm: number, points: number = 64): number[][] => {
  const coords: number[][] = [];
  const earthRadius = 6371; // km

  for (let i = 0; i <= points; i++) {
    const angle = (i * 360) / points;
    const angleRad = (angle * Math.PI) / 180;

    // Calculate point on circle using haversine formula inverse
    const latRad = (centerLat * Math.PI) / 180;
    const lngRad = (centerLng * Math.PI) / 180;

    const newLatRad = Math.asin(
      Math.sin(latRad) * Math.cos(radiusKm / earthRadius) +
      Math.cos(latRad) * Math.sin(radiusKm / earthRadius) * Math.cos(angleRad)
    );

    const newLngRad = lngRad + Math.atan2(
      Math.sin(angleRad) * Math.sin(radiusKm / earthRadius) * Math.cos(latRad),
      Math.cos(radiusKm / earthRadius) - Math.sin(latRad) * Math.sin(newLatRad)
    );

    const newLat = (newLatRad * 180) / Math.PI;
    const newLng = (newLngRad * 180) / Math.PI;

    coords.push([newLng, newLat]);
  }

  return coords;
};

// Location permission status type
type LocationPermissionStatus = 'granted' | 'denied' | 'disabled' | 'restricted' | 'unavailable';

// Iconițe MaterialCommunityIcons per tip de alertă
// ALERT_TYPE_LABELS pentru render-ul pe hartă și în carduri.
const ALERT_TYPE_MDI: Record<AlertType, string> = {
  earthquake: 'home-alert-outline',
  flood: 'waves',
  fire: 'fire',
  storm: 'weather-lightning-rainy',
  war: 'bomb',
  other: 'alert',
};

const MapScreen = () => {
  // Auth state
  const { isAdmin } = useAuth();
  const insets = useSafeAreaInsets();

  const [selectedLocation, setSelectedLocation] = useState<Shelter | null>(null);

  // Alert state (pentru admin)
  const [alerts, setAlerts] = useState<DisasterAlert[]>([]);
  // Counter incrementat la fiecare alertă BLE — forțează MapLibre să re-renderizeze
  // ShapeSource-urile chiar dacă React nu detectează schimbarea corect
  const [alertRenderKey, setAlertRenderKey] = useState(0);
  const [showAlertForm, setShowAlertForm] = useState(false);
  const [alertTapLocation, setAlertTapLocation] = useState<{lat: number, lng: number} | null>(null);
  const [isCreatingAlert, setIsCreatingAlert] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<DisasterAlert | null>(null);
  const [showAlertsModal, setShowAlertsModal] = useState(false);
  const [deletingAlertId, setDeletingAlertId] = useState<string | null>(null);

  // BLE Mesh state
  const [meshStatus, setMeshStatus] = useState<MeshStatus | null>(null);

  // Alert form fields
  const [alertType, setAlertType] = useState<AlertType>('fire');
  const [alertSeverity, setAlertSeverity] = useState<AlertSeverity>('medium');
  const [alertMessage, setAlertMessage] = useState('');
  const [alertRadius, setAlertRadius] = useState('1'); // km
  const [alertDuration, setAlertDuration] = useState('24'); // ore

  // Stare pentru Harta Offline
  const [mapPath, setMapPath] = useState<string | null>(null);
  const [glyphsTemplate, setGlyphsTemplate] = useState<string | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  // Stare pentru Zoom și Locație
  const [zoomLevel, setZoomLevel] = useState<number>(12);
  const [userLocation, setUserLocation] = useState<{latitude: number, longitude: number} | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationPermissionStatus, setLocationPermissionStatus] = useState<LocationPermissionStatus | null>(null);

  // Stare pentru Shelters (din Overpass API)
  const [shelters, setShelters] = useState<Shelter[]>([]);
  const [sheltersLoading, setSheltersLoading] = useState(true);
  const [sheltersSource, setSheltersSource] = useState<'cache' | 'api' | 'fallback' | null>(null);
  const [sheltersError, setSheltersError] = useState<string | null>(null);

  // Stare pentru Filtrare
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<Shelter['type']>>(
    new Set(['hospital', 'pharmacy', 'fire', 'police', 'bunker'])
  );

  const cameraRef = useRef<MapLibreGL.CameraRef>(null);
  // Timer pentru deschiderea întârziată a formularului de alertă (după ce
  // markerul a fost afișat la long-press).
  const alertFormTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Set de alert ID-uri deja cunoscute — popup doar pentru cele NOI
  const knownAlertIds = useRef<Set<string>>(new Set());
  // La primul snapshot Firebase, populăm fără popup (sunt alerte existente)
  const isFirstSnapshot = useRef(true);
  // Flag: am încărcat deja shelter-ii pentru locația curentă?
  // Previne re-fetch la fiecare update GPS minor (GPS poate notifica la fiecare secundă).
  const sheltersLoadedForLocation = useRef(false);

  // Funcție comună de notificare — folosită atât de Firebase cât și de BLE.
  // Nivel 1 (foreground): popup Alert.alert nativ.
  // Nivel 2 (background/inactive): notificare locală sistem prin @notifee.
  const showAlertPopup = useCallback((alert: DisasterAlert) => {
    if (AppState.currentState !== 'active') {
      // App în background → notificare sistem
      showAlertNotification(alert).catch(err =>
        console.warn('[MapScreen] Notif display failed:', err),
      );
      return;
    }

    // App în foreground → popup în-app
    const typeLabel = ALERT_TYPE_LABELS[alert.type]?.label || alert.type;
    const severityLabel = ALERT_SEVERITY_LABELS[alert.severity]?.label || alert.severity;
    Alert.alert(
      'Alertă nouă',
      `${typeLabel} — Severitate: ${severityLabel}\n\n${alert.message}`,
      [
        {text: 'OK', style: 'cancel'},
        {
          text: 'Vezi pe harta',
          onPress: () => {
            cameraRef.current?.setCamera({
              centerCoordinate: [alert.lng, alert.lat],
              zoomLevel: 13,
              animationDuration: 500,
            });
          },
        },
      ],
    );
  }, []);

  // Centrează harta pe o alertă (din tap pe notificare sistem).
  // Folosește lat/lng din payload-ul notificării direct dacă există;
  // altfel, caută alerta în array-ul live (funcționează doar pentru alerte reale Firestore).
  const focusOnAlert = useCallback((focus: AlertFocus) => {
    let lng = focus.lng;
    let lat = focus.lat;
    if (lng === undefined || lat === undefined) {
      const alert = alerts.find(a => a.id === focus.alertId);
      if (alert) {
        lng = alert.lng;
        lat = alert.lat;
      }
    }
    if (lng !== undefined && lat !== undefined) {
      cameraRef.current?.setCamera({
        centerCoordinate: [lng, lat],
        zoomLevel: 13,
        animationDuration: 500,
      });
    }
  }, [alerts]);

  // Subscribe la evenimente alertFocus emise de notificationService.
  // App-ul deja navighează la tab-ul Map; MapScreen primește acelasi
  // eveniment și centrează camera cu un mic delay pentru a permite
  // tranzitia de tab să termine.
  useEffect(() => {
    const unsubscribe = subscribeAlertFocus((focus) => {
      setTimeout(() => focusOnAlert(focus), 300);
    });
    return unsubscribe;
  }, [focusOnAlert]);

  // Curăță timer-ul de deschidere a formularului la demontare.
  useEffect(() => {
    return () => {
      if (alertFormTimerRef.current) {
        clearTimeout(alertFormTimerRef.current);
      }
    };
  }, []);

  // --- 1. SETUP HARTA OFFLINE ---
  // Copy-ul .mbtiles se face acum în mapResourcesService (apelat din App.tsx
  // la startup), deci când ajungem aici fișierul e de obicei deja gata.
  // MapScreen doar se abonează la stare și mapează la state-ul local de UI.
  useEffect(() => {
    const unsubscribe = mapResourcesService.subscribe((s: MapResourcesState) => {
      setMapPath(s.mbtilesPath);
      setGlyphsTemplate(mapResourcesService.getGlyphsTemplate());
      if (s.status === 'ready') {
        setMapError(null);
        setIsMapReady(true);
      } else if (s.status === 'error') {
        setMapError(s.error);
        setIsMapReady(true);
      } else {
        // unknown / copying — încă în lucru, ținem ecranul de loading
        setIsMapReady(false);
      }
    });
    // Safety net: dacă App.tsx nu a apucat să cheme init() (ex: hot-reload pe
    // MapScreen direct), îl pornim noi — e idempotent.
    mapResourcesService.init().catch(() => {});
    return unsubscribe;
  }, []);

  // --- 2. SETUP LOCATIE (GPS) ---
  // Request location permission based on platform
  const requestLocationPermission = useCallback(async (): Promise<LocationPermissionStatus> => {
    if (Platform.OS === 'ios') {
      // iOS: Use Geolocation.requestAuthorization
      const authStatus = await Geolocation.requestAuthorization('whenInUse');
      console.log('iOS authorization status:', authStatus);
      return authStatus as LocationPermissionStatus;
    } else {
      // Android: Use PermissionsAndroid
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'Permisiune Locație Safr',
          message: 'Safr are nevoie de acces la locația ta pentru a afișa adăposturile de urgență din apropiere.',
          buttonNeutral: 'Întreabă mai târziu',
          buttonNegative: 'Anulează',
          buttonPositive: 'OK',
        }
      );

      if (granted === PermissionsAndroid.RESULTS.GRANTED) {
        return 'granted';
      } else if (granted === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        return 'restricted';
      } else {
        return 'denied';
      }
    }
  }, []);

  // Handle location errors with user-friendly messages
  const getLocationErrorMessage = useCallback((error: { code: number; message: string }): string => {
    switch (error.code) {
      case 1: // PERMISSION_DENIED
        return 'Permisiunea pentru locație a fost refuzată';
      case 2: // POSITION_UNAVAILABLE
        return 'Locația nu este disponibilă. Verifică dacă GPS-ul este activat.';
      case 3: // TIMEOUT
        return 'Căutarea locației a expirat. Încearcă din nou.';
      case 4: // PLAY_SERVICE_NOT_AVAILABLE (Android)
        return 'Google Play Services nu este disponibil';
      case 5: // SETTINGS_NOT_SATISFIED (Android)
        return 'Setările de locație nu sunt configurate corect';
      default:
        return `Eroare GPS: ${error.message}`;
    }
  }, []);

  // Open device settings for location permissions
  const openLocationSettings = useCallback(() => {
    if (Platform.OS === 'ios') {
      Linking.openURL('app-settings:');
    } else {
      Linking.openSettings();
    }
  }, []);

  useEffect(() => {
    let watchId: number | null = null;
    let isMounted = true;

    const setupLocationTracking = async () => {
      try {
        // Request permission
        const permissionStatus = await requestLocationPermission();

        if (!isMounted) return;

        setLocationPermissionStatus(permissionStatus);

        if (permissionStatus !== 'granted') {
          let errorMsg = '';
          switch (permissionStatus) {
            case 'denied':
              errorMsg = 'Permisiunea pentru locație a fost refuzată. Activează-o din setări.';
              break;
            case 'disabled':
              errorMsg = 'Serviciile de locație sunt dezactivate. Activează GPS-ul.';
              break;
            case 'restricted':
              errorMsg = 'Accesul la locație este restricționat pe acest dispozitiv.';
              break;
            case 'unavailable':
              errorMsg = 'Serviciul de locație nu este disponibil.';
              break;
            default:
              errorMsg = 'Nu s-a putut obține permisiunea pentru locație.';
          }
          setLocationError(errorMsg);
          return;
        }

        // Clear any previous errors
        setLocationError(null);

        // Start watching position
        watchId = Geolocation.watchPosition(
          (position) => {
            if (!isMounted) return;
            const { latitude, longitude } = position.coords;
            setUserLocation({ latitude, longitude });
            setLocationError(null); // Clear error on successful position
          },
          (error) => {
            if (!isMounted) return;
            console.log('Eroare GPS:', error.code, error.message);
            setLocationError(getLocationErrorMessage(error));
          },
          {
            enableHighAccuracy: true,
            distanceFilter: 10,
            interval: 5000,
            fastestInterval: 2000,
            showLocationDialog: true, // Android: show dialog if location is off
            forceRequestLocation: true, // Android: force location request
          }
        );
      } catch (error) {
        if (!isMounted) return;
        console.error('Eroare la configurarea locației:', error);
        setLocationError('Eroare la inițializarea GPS-ului');
      }
    };

    setupLocationTracking();

    // Cleanup function - prevents memory leak
    return () => {
      isMounted = false;
      if (watchId !== null) {
        Geolocation.clearWatch(watchId);
        console.log('GPS watch cleared');
      }
    };
  }, [requestLocationPermission, getLocationErrorMessage]);

  // --- 2.5. SUBSCRIBE TO ALERTS (FIREBASE REALTIME) ---
  useEffect(() => {
    console.log('[MapScreen] Subscribing to alerts...');

    const unsubscribe = subscribeToAlerts(
      (newAlerts) => {
        console.log('[MapScreen] Received', newAlerts.length, 'active alerts');
        setAlerts(newAlerts);

        if (isFirstSnapshot.current) {
          // Primul snapshot: populăm Set-ul cu alertele existente, fără popup
          newAlerts.forEach(a => knownAlertIds.current.add(a.id));
          isFirstSnapshot.current = false;
        } else {
          // Snapshot-uri ulterioare: popup pentru alertele noi
          newAlerts.forEach(a => {
            if (!knownAlertIds.current.has(a.id)) {
              knownAlertIds.current.add(a.id);
              showAlertPopup(a);
            }
          });
        }
      },
      (error) => {
        console.error('[MapScreen] Alert subscription error:', error);
      }
    );

    // Cleanup: unsubscribe when component unmounts
    return () => {
      console.log('[MapScreen] Unsubscribing from alerts');
      unsubscribe();
    };
  }, [showAlertPopup]);

  // --- 2.55. BLE MESH AUTO-MODE ---
  // Pornește mesh-ul automat. Monitorizează starea rețelei:
  // - Cu internet: primește alerte Firebase + le advertisează prin BLE
  // - Fără internet: scanează BLE pentru alerte de la vecini
  useEffect(() => {
    // IMPORTANT: Setăm callback-urile ÎNAINTE de enableAutoMode()
    // pentru a nu pierde evenimente dacă mesh-ul pornește rapid
    bleMeshService.onStatusChanged((status: MeshStatus) => {
      setMeshStatus(status);
    });
    bleMeshService.onAlert((alert: DisasterAlert) => {
      console.log('[MapScreen] Alert received via BLE:', alert.message);
      setTimeout(() => {
        setAlerts(prev => {
          const exists = prev.some(a => a.id === alert.id);
          if (exists) { return prev; }
          return [alert, ...prev];
        });
        setAlertRenderKey(k => k + 1);
        // Popup doar dacă nu am mai văzut-o (poate a venit și prin Firebase)
        if (!knownAlertIds.current.has(alert.id)) {
          knownAlertIds.current.add(alert.id);
          showAlertPopup(alert);
        }
      }, 0);
    });

    // Acum pornim mesh-ul — callback-urile sunt deja înregistrate
    bleMeshService.enableAutoMode().catch(err => {
      console.warn('[MapScreen] BLE Mesh auto-mode failed:', err.message);
    });

    return () => {
      bleMeshService.disableAutoMode().catch(() => {});
    };
  }, []);

  // --- 2.6. LOAD SHELTERS FROM OVERPASS API ---
  // Shelter-ii se încarcă DOAR după ce avem locația GPS, pentru a construi
  // bounding box-ul de SEARCH_RADIUS_KM în jurul user-ului.
  useEffect(() => {
    if (!userLocation || sheltersLoadedForLocation.current) {
      return;
    }
    sheltersLoadedForLocation.current = true;

    let isMounted = true;

    const loadShelters = async () => {
      try {
        setSheltersLoading(true);

        // Afișare instant din cache (populat de prefetchShelters la startup),
        // în timp ce getShelters() face refresh din API în fundal.
        const cachedImmediate = await getCachedShelters();
        if (isMounted && cachedImmediate && cachedImmediate.length > 0) {
          setShelters(cachedImmediate);
          setSheltersSource('cache');
          console.log(`[MapScreen] Showing ${cachedImmediate.length} cached shelters instantly`);
        }

        const result = await getShelters(userLocation);

        if (!isMounted) return;

        setShelters(result.shelters);
        setSheltersSource(result.source);
        setSheltersError(result.error || null);

        console.log(`[MapScreen] Loaded ${result.shelters.length} shelters from ${result.source}`);
      } catch (error) {
        if (!isMounted) return;
        console.error('[MapScreen] Error loading shelters:', error);
        setSheltersError('Eroare la încărcarea locațiilor');
      } finally {
        if (isMounted) {
          setSheltersLoading(false);
        }
      }
    };

    loadShelters();

    return () => {
      isMounted = false;
    };
  }, [userLocation]);

  // Filtered shelters based on active filters
  const filteredShelters = useMemo(() => {
    return shelters.filter(shelter => activeFilters.has(shelter.type));
  }, [shelters, activeFilters]);

  // Toggle a filter type
  const toggleFilter = useCallback((type: Shelter['type']) => {
    setActiveFilters(prev => {
      const newFilters = new Set(prev);
      if (newFilters.has(type)) {
        // Don't allow deselecting all filters
        if (newFilters.size > 1) {
          newFilters.delete(type);
        }
      } else {
        newFilters.add(type);
      }
      return newFilters;
    });
  }, []);

  // Select/deselect all filters
  const toggleAllFilters = useCallback(() => {
    const allTypes: Shelter['type'][] = ['hospital', 'pharmacy', 'fire', 'police', 'bunker'];
    if (activeFilters.size === allTypes.length) {
      // If all selected, select only hospitals
      setActiveFilters(new Set(['hospital']));
    } else {
      // Select all
      setActiveFilters(new Set(allTypes));
    }
  }, [activeFilters]);

  // Function to manually refresh shelters
  const handleRefreshShelters = useCallback(async () => {
    if (!userLocation) {
      toastService.info(
        'Activează GPS-ul pentru a afișa locațiile de urgență din zona ta.',
      );
      return;
    }
    setSheltersLoading(true);
    try {
      const result = await refreshShelters(userLocation);
      setShelters(result.shelters);
      setSheltersSource(result.source);
      setSheltersError(result.error || null);

      if (result.source === 'api') {
        toastService.success(`Date actualizate — ${result.shelters.length} locații găsite.`);
      } else if (result.error) {
        toastService.info(result.error);
      }
    } catch (error) {
      toastService.error('Nu s-au putut actualiza datele.');
    } finally {
      setSheltersLoading(false);
    }
  }, [userLocation]);

  // --- 3. STIL HARTA ---
  const mapStyle = useMemo(() => {
    if (!mapPath) return null;
    const layers: any[] = [
      { id: 'background', type: 'background', paint: { 'background-color': '#F0F2F5' } },
      { id: 'landuse', type: 'fill', source: 'offline_source', 'source-layer': 'landuse', paint: { 'fill-color': '#D6E6D5' } },
      { id: 'water', type: 'fill', source: 'offline_source', 'source-layer': 'water', paint: { 'fill-color': '#A0C8F0' } },
      { id: 'buildings', type: 'fill', source: 'offline_source', 'source-layer': 'building', paint: { 'fill-color': '#D9D9D9', 'fill-outline-color': '#CCCCCC' } },
      { id: 'roads', type: 'line', source: 'offline_source', 'source-layer': 'transportation', paint: { 'line-color': '#FFFFFF', 'line-width': 2 } },
    ];
    const style: any = {
      version: 8,
      sources: { 'offline_source': { type: 'vector', url: `mbtiles://${mapPath}` } },
      layers,
    };
    // Etichete (nume localități + străzi) - doar dacă fonturile offline sunt disponibile.
    if (glyphsTemplate) {
      style.glyphs = glyphsTemplate;
      layers.push(
        {
          id: 'place-labels',
          type: 'symbol',
          source: 'offline_source',
          'source-layer': 'place',
          minzoom: 6,
          layout: {
            'text-font': ['NotoSans'],
            'text-field': ['coalesce', ['get', 'name'], ['get', 'name:latin']],
            'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 15],
            'text-max-width': 8,
          },
          paint: { 'text-color': '#1E293B', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.4 },
        },
        {
          id: 'street-labels',
          type: 'symbol',
          source: 'offline_source',
          'source-layer': 'transportation_name',
          minzoom: 14,
          layout: {
            'symbol-placement': 'line',
            'text-font': ['NotoSans'],
            'text-field': ['coalesce', ['get', 'name'], ['get', 'name:latin']],
            'text-size': 12,
          },
          paint: { 'text-color': '#3A3A3A', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.3 },
        },
      );
    }
    return style;
  }, [mapPath, glyphsTemplate]);

  // --- 4. CONTROL ZOOM (REPARAT) ---
  // Nu mai cerem zoom-ul camerei, ci folosim variabila noastră de stare
  const handleZoomIn = () => {
    const newZoom = Math.min(zoomLevel + 1, 20);
    setZoomLevel(newZoom); // Actualizăm starea
    cameraRef.current?.setCamera({
      zoomLevel: newZoom,
      animationDuration: 300,
      animationMode: 'flyTo'
    });
  };

  const handleZoomOut = () => {
    const newZoom = Math.max(zoomLevel - 1, 1);
    setZoomLevel(newZoom);
    cameraRef.current?.setCamera({
      zoomLevel: newZoom,
      animationDuration: 300,
      animationMode: 'flyTo'
    });
  };

  // Această funcție se apelează automat când utilizatorul mișcă harta (pinch zoom)
  // O folosim ca să ținem variabila 'zoomLevel' sincronizată cu realitatea
  const onRegionDidChange = async (feature: any) => {
     if (feature && feature.properties && feature.properties.zoomLevel) {
        setZoomLevel(feature.properties.zoomLevel);
     }
  };

  // --- HANDLE MAP LONG PRESS (ADMIN ONLY) ---
  const handleMapLongPress = useCallback((event: any) => {
    if (!isAdmin) return; // Doar admin-ul poate crea alerte

    const coordinates = event.geometry?.coordinates;
    if (coordinates && coordinates.length >= 2) {
      // GeoJSON e [lng, lat]; stocăm explicit ca {lat, lng} pentru alertă.
      const lng = coordinates[0];
      const lat = coordinates[1];
      console.log('[MapScreen] Admin long pressed at:', lat, lng);

      // 1. Arată markerul IMEDIAT la punctul apăsat (coordonatele sunt înregistrate).
      setAlertTapLocation({ lat, lng });
      setSelectedLocation(null); // Închide orice bottom sheet deschis
      setShowFilterMenu(false);
      setSelectedAlert(null);

      // Centrează camera pe locația apăsată (doar pan, fără schimbare de zoom).
      cameraRef.current?.setCamera({
        centerCoordinate: [lng, lat],
        animationDuration: 400,
        animationMode: 'flyTo',
      });

      // 2. Deschide formularul cu o mică întârziere (1s), ca utilizatorul să vadă
      //    întâi markerul și locul ales, înainte ca sheet-ul să urce peste el.
      if (alertFormTimerRef.current) {
        clearTimeout(alertFormTimerRef.current);
      }
      alertFormTimerRef.current = setTimeout(() => {
        setShowAlertForm(true);
      }, 1000);
    }
  }, [isAdmin]);

  // --- HANDLE CREATE ALERT SUBMIT ---
  const handleCreateAlert = useCallback(async () => {
    if (!alertTapLocation) return;

    const radiusNum = parseFloat(alertRadius);
    const durationNum = parseFloat(alertDuration);

    if (isNaN(radiusNum) || radiusNum <= 0) {
      toastService.error('Introdu o rază validă (în km).');
      return;
    }
    if (isNaN(durationNum) || durationNum <= 0) {
      toastService.error('Introdu o durată validă (în ore).');
      return;
    }
    if (!alertMessage.trim()) {
      toastService.error('Introdu un mesaj pentru alertă.');
      return;
    }

    setIsCreatingAlert(true);

    try {
      const alertData = {
        type: alertType,
        severity: alertSeverity,
        lat: alertTapLocation.lat,
        lng: alertTapLocation.lng,
        radius: radiusNum,
        message: alertMessage.trim(),
        timestamp: Date.now(),
        expiresAt: Date.now() + durationNum * 60 * 60 * 1000, // ore -> ms
        createdBy: 'admin',
      };

      const newAlertId = await createAlert(alertData);

      // Pre-înregistrăm ID-ul ca seen ÎNAINTE ca snapshot-ul Firestore
      // să sosească. Altfel, dispozitivul creator și-ar trata propria alertă ca
      // fiind „nouă" și ar afișa un al doilea popup („Alertă nouă") peste „Succes".
      knownAlertIds.current.add(newAlertId);

      // Centrează camera pe locația alertei create.
      cameraRef.current?.setCamera({
        centerCoordinate: [alertTapLocation.lng, alertTapLocation.lat],
        animationDuration: 400,
        animationMode: 'flyTo',
      });

      toastService.success('Alerta a fost creată și trimisă.');

      // Reset form
      setShowAlertForm(false);
      setAlertTapLocation(null);
      setAlertMessage('');
      setAlertRadius('1');
      setAlertDuration('24');
      setAlertType('fire');
      setAlertSeverity('medium');
    } catch (error) {
      console.error('[MapScreen] Error creating alert:', error);
      toastService.error('Nu s-a putut crea alerta. Verifică conexiunea.');
    } finally {
      setIsCreatingAlert(false);
    }
  }, [alertTapLocation, alertType, alertSeverity, alertMessage, alertRadius, alertDuration]);

  // --- CANCEL ALERT FORM ---
  const handleCancelAlert = useCallback(() => {
    // Anulează deschiderea întârziată a formularului, dacă e încă în așteptare.
    if (alertFormTimerRef.current) {
      clearTimeout(alertFormTimerRef.current);
      alertFormTimerRef.current = null;
    }
    setShowAlertForm(false);
    setAlertTapLocation(null);
    setAlertMessage('');
  }, []);

  // --- HANDLE DELETE ALERT (admin only) ---
  const handleDeleteAlert = useCallback(async (alertId: string) => {
    Alert.alert(
      'Șterge alerta',
      'Ești sigur că vrei să ștergi această alertă? Acțiunea este ireversibilă.',
      [
        { text: 'Anulează', style: 'cancel' },
        {
          text: 'Șterge',
          style: 'destructive',
          onPress: async () => {
            setDeletingAlertId(alertId);
            try {
              await deleteAlert(alertId);
              // If the deleted alert was selected, clear selection
              if (selectedAlert?.id === alertId) {
                setSelectedAlert(null);
              }
              toastService.success('Alerta a fost ștearsă.');
            } catch (error) {
              console.error('[MapScreen] Error deleting alert:', error);
              toastService.error('Nu s-a putut șterge alerta.');
            } finally {
              setDeletingAlertId(null);
            }
          },
        },
      ]
    );
  }, [selectedAlert]);

  // --- HANDLE ALERT TAP (show details) ---
  const handleAlertPress = useCallback((event: any) => {
    const feature = event.features?.[0];
    if (feature?.properties?.id) {
      const alertId = feature.properties.id;
      const alert = alerts.find(a => a.id === alertId);
      if (alert) {
        setSelectedAlert(alert);
        setSelectedLocation(null); // Close shelter card if open
        setShowFilterMenu(false);
      }
    }
  }, [alerts]);

  const centerOnUser = () => {
    if (userLocation) {
      // Setăm și zoomLevel pe 15 când ne centrăm
      setZoomLevel(15);
      cameraRef.current?.setCamera({
        centerCoordinate: [userLocation.longitude, userLocation.latitude],
        zoomLevel: 15,
        animationDuration: 1000,
        animationMode: 'flyTo'
      });
    } else {
        toastService.info('Căutare semnal GPS…');
    }
  };

  // --- 5. COMPONENTA MARKER ---
  const getMarkerStyle = (type: Shelter['type']): { color: string; icon: string; borderColor: string } => {
    switch (type) {
      case 'hospital':
        return { color: '#DC2626', icon: 'hospital', borderColor: '#991B1B' };
      case 'pharmacy':
        return { color: '#16A34A', icon: 'plus', borderColor: '#166534' };
      case 'fire':
        return { color: '#EA580C', icon: 'fire-truck', borderColor: '#9A3412' };
      case 'police':
        return { color: '#2563EB', icon: 'police-badge', borderColor: '#1E40AF' };
      case 'bunker':
        return { color: '#7C3AED', icon: 'shield-home', borderColor: '#5B21B6' };
      default:
        return { color: '#6B7280', icon: 'map-marker', borderColor: '#374151' };
    }
  };

  const renderShelterMarker = (shelter: Shelter) => {
    const { color, icon, borderColor } = getMarkerStyle(shelter.type);
    const isHospital = shelter.type === 'hospital';
    const size = isHospital ? 22 : 18; // Hospitals slightly larger

    return (
      <MapLibreGL.PointAnnotation
        key={shelter.id}
        id={shelter.id}
        coordinate={[shelter.lng, shelter.lat]}
        onSelected={() => {
          setSelectedLocation(shelter);
          const targetZoom = 16;
          setZoomLevel(targetZoom);

          cameraRef.current?.setCamera({
            centerCoordinate: [shelter.lng, shelter.lat],
            zoomLevel: targetZoom,
            animationDuration: 800,
            animationMode: 'flyTo',
          });
        }}
      >
        <View style={[styles.markerDot, {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          borderColor: borderColor,
        }]}>
          <MaterialCommunityIcons name={icon} size={isHospital ? 13 : 11} color="#FFFFFF" />
        </View>
      </MapLibreGL.PointAnnotation>
    );
  };

  // Loading state
  if (!isMapReady) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2563EB" />
        <Text style={styles.loadingText}>Se încarcă harta offline...</Text>
      </View>
    );
  }

  // Map error state - show fallback UI
  if (mapError) {
    return (
      <View style={styles.errorContainer}>
        <MaterialCommunityIcons name="map-search-outline" size={64} color="#94A3B8" style={styles.errorIcon} />
        <Text style={styles.errorTitle}>Harta nu a putut fi încărcată</Text>
        <Text style={styles.errorMessage}>{mapError}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => {
            setIsMapReady(false);
            setMapError(null);
            // Re-trigger prin serviciu (subscribe-ul va prelua noua stare)
            mapResourcesService.retry().catch(() => {});
          }}
        >
          <Text style={styles.retryButtonText}>Încearcă din nou</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapLibreGL.MapView
        style={styles.map}
        mapStyle={mapStyle ? JSON.stringify(mapStyle) : undefined}
        surfaceView={false}
        logoEnabled={false}
        attributionEnabled={false}
        onPress={() => {
          setSelectedLocation(null);
          setSelectedAlert(null);
          setShowFilterMenu(false);
          setShowLegend(false);
          if (!showAlertForm) {
            // Atingere pe hartă în fereastra de 1s dinaintea formularului:
            // anulează deschiderea programată și markerul provizoriu.
            if (alertFormTimerRef.current) {
              clearTimeout(alertFormTimerRef.current);
              alertFormTimerRef.current = null;
            }
            setAlertTapLocation(null);
          }
        }}
        onLongPress={handleMapLongPress}
        // Adăugăm acest listener pentru a sincroniza zoom-ul când userul dă pinch
        onRegionDidChange={onRegionDidChange}
      >
        <MapLibreGL.Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: [21.2087, 45.7489],
            zoomLevel: 12,
          }}
        />

        {/* --- USER LOCATION (puck nativ MapLibre, cu săgeată de orientare) --- */}
        {/* renderMode="native" + busola dispozitivului: bulina albastră clasică
            cu săgeata care arată direcția în care e orientat telefonul (iOS:
            showsUserHeadingIndicator; Android: androidRenderMode="compass"). */}
        <MapLibreGL.UserLocation
          visible
          renderMode="native"
          androidRenderMode="compass"
          showsUserHeadingIndicator
        />

        {/* --- ALERT ZONES (Firebase + BLE mesh) --- */}
        {/* alertRenderKey forțează re-mount la alerte noi BLE */}
        {alerts.map(alert => (
          <MapLibreGL.ShapeSource
            key={`alert-${alert.id}-${alertRenderKey}`}
            id={`alertSource-${alert.id}`}
            shape={{
              type: 'Feature',
              properties: {
                id: alert.id,
                type: alert.type,
                severity: alert.severity,
              },
              geometry: {
                type: 'Polygon',
                coordinates: [createCirclePolygon(alert.lng, alert.lat, alert.radius)],
              },
            }}
            onPress={handleAlertPress}
          >
            <MapLibreGL.FillLayer
              id={`alertFill-${alert.id}`}
              style={{
                fillColor: ALERT_SEVERITY_LABELS[alert.severity].color,
                fillOpacity: 0.25,
              }}
            />
            <MapLibreGL.LineLayer
              id={`alertLine-${alert.id}`}
              style={{
                lineColor: ALERT_SEVERITY_LABELS[alert.severity].color,
                lineWidth: 2.5,
                lineOpacity: 0.8,
              }}
            />
          </MapLibreGL.ShapeSource>
        ))}

        {/* --- ALERT CENTER MARKERS --- */}
        {alerts.map(alert => (
          <MapLibreGL.PointAnnotation
            key={`alertMarker-${alert.id}-${alertRenderKey}`}
            id={`alertMarker-${alert.id}`}
            coordinate={[alert.lng, alert.lat]}
            onSelected={() => {
              setSelectedAlert(alert);
              setSelectedLocation(null);
              setShowFilterMenu(false);
            }}
          >
            <View style={[styles.alertMarker, { borderColor: ALERT_SEVERITY_LABELS[alert.severity].color }]}>
              <MaterialCommunityIcons name={ALERT_TYPE_MDI[alert.type]} size={18} color={ALERT_SEVERITY_LABELS[alert.severity].color} />
            </View>
          </MapLibreGL.PointAnnotation>
        ))}

        {/* --- ALERT TAP LOCATION MARKER (when creating) --- */}
        {alertTapLocation && (
          <MapLibreGL.PointAnnotation
            id="alertTapMarker"
            coordinate={[alertTapLocation.lng, alertTapLocation.lat]}
          >
            <View style={styles.alertTapMarker}>
              <View style={styles.alertTapPin}>
                <MaterialCommunityIcons name="plus" size={20} color="#FFFFFF" />
              </View>
            </View>
          </MapLibreGL.PointAnnotation>
        )}

        {filteredShelters.map(renderShelterMarker)}
      </MapLibreGL.MapView>

      {/* --- LOCATION ERROR BANNER --- */}
      {locationError && (
        <View style={[styles.locationErrorBanner, { top: insets.top + 64 }]}>
          <View style={styles.locationErrorContent}>
            <MaterialCommunityIcons name="alert" size={18} color="#F59E0B" style={styles.locationErrorIcon} />
            <Text style={styles.locationErrorText}>{locationError}</Text>
          </View>
          {(locationPermissionStatus === 'denied' || locationPermissionStatus === 'restricted') && (
            <TouchableOpacity style={styles.settingsButton} onPress={openLocationSettings}>
              <Text style={styles.settingsButtonText}>Setări</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* --- GPS REQUIRED BANNER (pentru shelters) --- */}
      {!userLocation && !locationError && (
        <View style={[styles.locationErrorBanner, { top: insets.top + 64 }]}>
          <View style={styles.locationErrorContent}>
            <MaterialCommunityIcons name="crosshairs-gps" size={18} color="#F59E0B" style={styles.locationErrorIcon} />
            <Text style={styles.locationErrorText}>
              Activează GPS-ul pentru a vedea locațiile de urgență din zona ta.
            </Text>
          </View>
        </View>
      )}

      {/* --- DATA SOURCE BADGE & ALERTS BUTTON --- */}
      <View style={[styles.topLeftContainer, { top: insets.top + 12 }]}>
        {sheltersLoading ? (
          <View style={[styles.dataBadge, styles.dataBadgeLoading]}>
            <ActivityIndicator size="small" color="#666" />
            <Text style={styles.dataBadgeText}>Încărcare...</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[
              styles.dataBadge,
              sheltersSource === 'api' && styles.dataBadgeApi,
              sheltersSource === 'cache' && styles.dataBadgeCache,
              sheltersSource === 'fallback' && styles.dataBadgeFallback,
            ]}
            onPress={handleRefreshShelters}
            accessibilityRole="button"
            accessibilityLabel="Reîmprospătează locațiile"
          >
            <MaterialCommunityIcons
              name={sheltersSource === 'api' ? 'web' : sheltersSource === 'cache' ? 'database' : 'alert'}
              size={14}
              color={sheltersSource === 'api' ? '#16A34A' : sheltersSource === 'cache' ? '#D97706' : '#DC2626'}
              style={styles.dataBadgeIcon}
            />
            <Text style={styles.dataBadgeText}>
              {filteredShelters.length}/{shelters.length} locații • {sheltersSource === 'api' ? 'Live' : sheltersSource === 'cache' ? 'Cache' : 'Offline'}
            </Text>
            <MaterialCommunityIcons name="refresh" size={14} color="#64748B" style={styles.dataBadgeRefresh} />
          </TouchableOpacity>
        )}

        {/* Active Alerts Button */}
        <TouchableOpacity
          style={[styles.alertsButton, alerts.length > 0 && styles.alertsButtonActive]}
          onPress={() => setShowAlertsModal(true)}
        >
          <MaterialCommunityIcons name="alarm-light" size={15} color={alerts.length > 0 ? '#DC2626' : '#64748B'} style={styles.alertsButtonIcon} />
          <Text style={styles.alertsButtonText}>
            Alerte active ({alerts.length})
          </Text>
        </TouchableOpacity>

        {/* BLE Mesh Status Badge — mereu vizibil */}
        {(() => {
          const btOff = !meshStatus || meshStatus.bluetoothState !== 'on';
          const isOffline = meshStatus && !meshStatus.hasInternet;
          const devices = meshStatus?.devicesInRange ?? 0;

          // Stări vizuale:
          // Roșu: BLE off sau mesh nu rulează
          // Verde: offline mode (scanează + advertisează)
          // Albastru: online mode (doar advertisează pentru vecini)
          let badgeStyle = styles.meshBadgeOff;
          let dotColor = '#EF4444'; // roșu default
          let statusText = 'BLE Off';

          if (meshStatus?.isRunning && !btOff) {
            if (isOffline) {
              // Offline: scanează + advertisează = verde
              badgeStyle = styles.meshBadgeOffline;
              dotColor = '#22C55E';
              statusText = meshStatus.isScanning ? 'Mesh activ' : 'Mesh pornit';
            } else {
              // Online: doar advertisează = albastru
              badgeStyle = styles.meshBadgeOnline;
              dotColor = '#3B82F6';
              statusText = meshStatus.isAdvertising ? 'Broadcast' : 'Mesh standby';
            }
          } else if (meshStatus?.isRunning && btOff) {
            statusText = 'BLE oprit';
          }

          const deviceText = devices > 0 ? ` • ${devices} disp.` : '';

          return (
            <View style={[styles.meshBadge, badgeStyle]}>
              <View style={[styles.meshDot, { backgroundColor: dotColor }]} />
              <Text style={styles.meshBadgeText}>
                {statusText}{deviceText}
              </Text>
            </View>
          );
        })()}
      </View>

      {/* --- BUTTONS --- */}
      <View style={[styles.controls, { top: insets.top + 74 }]}>
        <TouchableOpacity
          style={[styles.controlBtn, !userLocation && styles.controlBtnDisabled]}
          onPress={centerOnUser}
          accessibilityRole="button"
          accessibilityLabel="Centrează pe locația mea"
        >
          <MaterialCommunityIcons name="crosshairs-gps" size={22} color="#333" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.controlBtn, {marginTop: 10}]}
          onPress={handleZoomIn}
          accessibilityRole="button"
          accessibilityLabel="Mărește harta"
        >
          <MaterialCommunityIcons name="plus" size={24} color="#333" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.controlBtn, {marginTop: 10}]}
          onPress={handleZoomOut}
          accessibilityRole="button"
          accessibilityLabel="Micșorează harta"
        >
          <MaterialCommunityIcons name="minus" size={24} color="#333" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.controlBtn, styles.filterBtn, showFilterMenu && styles.filterBtnActive]}
          onPress={() => { setShowFilterMenu(v => !v); setShowLegend(false); }}
          accessibilityRole="button"
          accessibilityLabel="Filtrează locațiile"
        >
          <MaterialCommunityIcons name="tune-variant" size={22} color={showFilterMenu ? '#FFFFFF' : '#333'} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.controlBtn, styles.filterBtn, showLegend && styles.filterBtnActive]}
          onPress={() => { setShowLegend(v => !v); setShowFilterMenu(false); }}
          accessibilityRole="button"
          accessibilityLabel="Legenda hărții"
        >
          <MaterialCommunityIcons name="information-outline" size={22} color={showLegend ? '#FFFFFF' : '#333'} />
        </TouchableOpacity>
      </View>

      {/* --- FILTER MENU --- */}
      {showFilterMenu && (
        <View style={[styles.filterMenu, { top: insets.top + 74 }]}>
          <View style={styles.filterHeader}>
            <Text style={styles.filterTitle}>Filtrează</Text>
            <TouchableOpacity onPress={toggleAllFilters}>
              <Text style={styles.filterSelectAll}>
                {activeFilters.size === 5 ? 'Deselectează' : 'Selectează tot'}
              </Text>
            </TouchableOpacity>
          </View>

          {([
            { type: 'hospital' as const, label: 'Spitale', icon: 'hospital' },
            { type: 'pharmacy' as const, label: 'Farmacii', icon: 'plus' },
            { type: 'fire' as const, label: 'Pompieri', icon: 'fire-truck' },
            { type: 'police' as const, label: 'Poliție', icon: 'police-badge' },
            { type: 'bunker' as const, label: 'Adăposturi', icon: 'shield-home' },
          ]).map(({ type, label, icon }) => {
            const isActive = activeFilters.has(type);
            const style = getMarkerStyle(type);
            const count = shelters.filter(s => s.type === type).length;

            return (
              <TouchableOpacity
                key={type}
                style={[styles.filterItem, !isActive && styles.filterItemInactive]}
                onPress={() => toggleFilter(type)}
              >
                <View style={[styles.filterIcon, { backgroundColor: style.color, borderColor: style.borderColor }]}>
                  <MaterialCommunityIcons name={icon} size={13} color="#FFFFFF" />
                </View>
                <Text style={[styles.filterLabel, !isActive && styles.filterLabelInactive]}>
                  {label}
                </Text>
                <Text style={styles.filterCount}>{count}</Text>
                <View style={[styles.filterCheckbox, isActive && styles.filterCheckboxActive]}>
                  {isActive && <MaterialCommunityIcons name="check" size={13} color="#FFFFFF" />}
                </View>
              </TouchableOpacity>
            );
          })}

          <Text style={styles.filterFooter}>
            {filteredShelters.length} din {shelters.length} afișate
          </Text>
        </View>
      )}

      {/* --- LEGENDĂ HARTĂ --- */}
      {showLegend && (
        <View style={[styles.filterMenu, { top: insets.top + 74 }]}>
          <View style={styles.filterHeader}>
            <Text style={styles.filterTitle}>Legendă</Text>
          </View>

          {([
            { type: 'hospital' as const, label: 'Spitale', icon: 'hospital' },
            { type: 'pharmacy' as const, label: 'Farmacii', icon: 'plus' },
            { type: 'fire' as const, label: 'Pompieri', icon: 'fire-truck' },
            { type: 'police' as const, label: 'Poliție', icon: 'police-badge' },
            { type: 'bunker' as const, label: 'Adăposturi', icon: 'shield-home' },
          ]).map(({ type, label, icon }) => {
            const style = getMarkerStyle(type);
            return (
              <View key={type} style={styles.legendItem}>
                <View style={[styles.filterIcon, { backgroundColor: style.color, borderColor: style.borderColor }]}>
                  <MaterialCommunityIcons name={icon} size={13} color="#FFFFFF" />
                </View>
                <Text style={styles.legendLabel}>{label}</Text>
              </View>
            );
          })}

          <View style={styles.legendDivider} />

          <View style={styles.legendItem}>
            <View style={styles.legendUserDot} />
            <Text style={styles.legendLabel}>Locația ta</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={styles.legendAlertRing} />
            <Text style={styles.legendLabel}>Zonă de alertă</Text>
          </View>
        </View>
      )}

      {/* --- BOTTOM SHEET --- */}
      {selectedLocation && (
        <View style={styles.bottomCard}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{selectedLocation.name}</Text>
            <View style={[styles.typeBadge, { backgroundColor: getMarkerStyle(selectedLocation.type).color }]}>
              <Text style={styles.typeBadgeText}>
                {selectedLocation.type === 'hospital' ? 'Spital' :
                 selectedLocation.type === 'pharmacy' ? 'Farmacie' :
                 selectedLocation.type === 'fire' ? 'Pompieri' :
                 selectedLocation.type === 'police' ? 'Poliție' :
                 selectedLocation.type === 'bunker' ? 'Adăpost' : 'Locație'}
              </Text>
            </View>
          </View>

          {/* Distance and ETA info */}
          {userLocation && (
            <View style={styles.distanceContainer}>
              {(() => {
                const distance = calculateDistance(
                  userLocation.latitude,
                  userLocation.longitude,
                  selectedLocation.lat,
                  selectedLocation.lng
                );
                const drivingTime = estimateTravelTime(distance, 'driving');
                const walkingTime = estimateTravelTime(distance, 'walking');

                return (
                  <>
                    <View style={styles.distanceItem}>
                      <MaterialCommunityIcons name="map-marker-distance" size={18} color="#2563EB" style={styles.distanceIcon} />
                      <Text style={styles.distanceText}>{formatDistance(distance)}</Text>
                    </View>
                    <View style={styles.distanceItem}>
                      <MaterialCommunityIcons name="car" size={18} color="#2563EB" style={styles.distanceIcon} />
                      <Text style={styles.distanceText}>{formatTravelTime(drivingTime)}</Text>
                    </View>
                    <View style={styles.distanceItem}>
                      <MaterialCommunityIcons name="walk" size={18} color="#2563EB" style={styles.distanceIcon} />
                      <Text style={styles.distanceText}>{formatTravelTime(walkingTime)}</Text>
                    </View>
                  </>
                );
              })()}
            </View>
          )}

          {!userLocation && (
            <Text style={styles.cardNoLocation}>Activează GPS pentru distanță</Text>
          )}

          <TouchableOpacity
            style={styles.navButton}
            onPress={() => showNavigationOptions(
              { lat: selectedLocation.lat, lng: selectedLocation.lng, label: selectedLocation.name },
              userLocation
            )}
          >
            <MaterialCommunityIcons name="navigation-variant" size={18} color="#FFFFFF" style={styles.navButtonIcon} />
            <Text style={styles.navButtonText}>Navighează</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* --- ALERTS LIST MODAL --- */}
      {showAlertsModal && (
        <View style={styles.alertsModalOverlay}>
          <TouchableOpacity
            style={styles.alertsModalBackdrop}
            onPress={() => setShowAlertsModal(false)}
          />
          <View style={styles.alertsModalContainer}>
            <View style={styles.alertsModalHeader}>
              <View style={styles.alertsModalTitleRow}>
                <MaterialCommunityIcons name="alarm-light" size={20} color="#DC2626" style={styles.alertsModalTitleIcon} />
                <Text style={styles.alertsModalTitle}>Alerte active</Text>
              </View>
              <TouchableOpacity
                onPress={() => setShowAlertsModal(false)}
                style={styles.alertsModalClose}
                accessibilityRole="button"
                accessibilityLabel="Închide"
              >
                <MaterialCommunityIcons name="close" size={18} color="#64748B" />
              </TouchableOpacity>
            </View>

            <ScrollView
              style={styles.alertsModalScroll}
              contentContainerStyle={styles.alertsModalScrollContent}
              showsVerticalScrollIndicator={true}
            >
              {alerts.length === 0 ? (
                <View style={styles.alertsModalEmpty}>
                  <MaterialCommunityIcons name="check-circle-outline" size={48} color="#22C55E" style={styles.alertsModalEmptyIcon} />
                  <Text style={styles.alertsModalEmptyText}>
                    Nu există alerte active în acest moment.
                  </Text>
                </View>
              ) : (
                alerts.map((alert) => (
                  <View key={alert.id} style={styles.alertCard}>
                    <View style={styles.alertCardHeader}>
                      <View
                        style={[
                          styles.alertCardBadge,
                          { backgroundColor: ALERT_SEVERITY_LABELS[alert.severity].color },
                        ]}
                      >
                        <View style={styles.alertCardBadgeRow}>
                          <MaterialCommunityIcons name={ALERT_TYPE_MDI[alert.type]} size={13} color="#FFFFFF" style={styles.alertCardBadgeIcon} />
                          <Text style={styles.alertCardBadgeText}>
                            {ALERT_TYPE_LABELS[alert.type].label}
                          </Text>
                        </View>
                      </View>
                      <Text
                        style={[
                          styles.alertCardSeverity,
                          { color: ALERT_SEVERITY_LABELS[alert.severity].color },
                        ]}
                      >
                        {ALERT_SEVERITY_LABELS[alert.severity].label}
                      </Text>
                    </View>

                    <Text style={styles.alertCardMessage}>{alert.message}</Text>

                    <View style={styles.alertCardDetails}>
                      <View style={styles.alertCardDetailRow}>
                        <MaterialCommunityIcons name="map-marker" size={13} color="#94A3B8" style={styles.alertCardDetailIcon} />
                        <Text style={styles.alertCardDetail}>
                          {alert.lat.toFixed(4)}, {alert.lng.toFixed(4)}
                        </Text>
                      </View>
                      <View style={styles.alertCardDetailRow}>
                        <MaterialCommunityIcons name="map-marker-radius" size={13} color="#94A3B8" style={styles.alertCardDetailIcon} />
                        <Text style={styles.alertCardDetail}>
                          Rază: {alert.radius} km
                        </Text>
                      </View>
                      <View style={styles.alertCardDetailRow}>
                        <MaterialCommunityIcons name="clock-outline" size={13} color="#94A3B8" style={styles.alertCardDetailIcon} />
                        <Text style={styles.alertCardDetail}>
                          Expiră: {new Date(alert.expiresAt).toLocaleString('ro-RO', {
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.alertCardActions}>
                      <TouchableOpacity
                        style={styles.alertCardViewBtn}
                        onPress={() => {
                          setShowAlertsModal(false);
                          setSelectedAlert(alert);
                          cameraRef.current?.setCamera({
                            centerCoordinate: [alert.lng, alert.lat],
                            zoomLevel: 13,
                            animationDuration: 800,
                            animationMode: 'flyTo',
                          });
                        }}
                      >
                        <Text style={styles.alertCardViewBtnText}>Vezi pe hartă</Text>
                      </TouchableOpacity>

                      {isAdmin && (
                        <TouchableOpacity
                          style={[
                            styles.alertCardDeleteBtn,
                            deletingAlertId === alert.id && styles.alertCardDeleteBtnDisabled,
                          ]}
                          onPress={() => handleDeleteAlert(alert.id)}
                          disabled={deletingAlertId === alert.id}
                        >
                          {deletingAlertId === alert.id ? (
                            <ActivityIndicator color="#DC2626" size="small" />
                          ) : (
                            <View style={styles.alertCardDeleteBtnRow}>
                              <MaterialCommunityIcons name="delete" size={14} color="#DC2626" style={styles.alertCardDeleteBtnIcon} />
                              <Text style={styles.alertCardDeleteBtnText}>Șterge</Text>
                            </View>
                          )}
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      )}

      {/* --- ADMIN ALERT FORM --- */}
      {showAlertForm && alertTapLocation && (
        <View style={styles.alertFormOverlay}>
          <TouchableOpacity style={styles.alertFormBackdrop} onPress={() => { Keyboard.dismiss(); handleCancelAlert(); }} />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.alertFormKeyboardView}
          >
          <View style={styles.alertFormContainer}>
            <ScrollView
              style={styles.alertFormScroll}
              contentContainerStyle={styles.alertFormScrollContent}
              showsVerticalScrollIndicator={true}
              keyboardShouldPersistTaps="handled"
              bounces={true}
            >
            {/* Header compact: titlu + coordonate + close */}
            <View style={styles.alertFormHeader}>
              <View>
                <Text style={styles.alertFormTitle}>Creare alertă</Text>
                <Text style={styles.alertFormCoords}>
                  {alertTapLocation.lat.toFixed(5)}, {alertTapLocation.lng.toFixed(5)}
                </Text>
              </View>
              <TouchableOpacity onPress={() => { Keyboard.dismiss(); handleCancelAlert(); }} style={styles.alertFormClose} accessibilityRole="button" accessibilityLabel="Închide">
                <MaterialCommunityIcons name="close" size={18} color="#64748B" />
              </TouchableOpacity>
            </View>

            {/* Tip alertă — grid compact */}
            <Text style={styles.alertFormLabel}>Tip alertă</Text>
            <View style={styles.alertTypeGrid}>
              {(Object.keys(ALERT_TYPE_LABELS) as AlertType[]).map(type => {
                const { label, color } = ALERT_TYPE_LABELS[type];
                const isSelected = alertType === type;
                return (
                  <TouchableOpacity
                    key={type}
                    style={[
                      styles.alertTypeBtn,
                      isSelected && { backgroundColor: color, borderColor: color },
                    ]}
                    onPress={() => setAlertType(type)}
                  >
                    <MaterialCommunityIcons name={ALERT_TYPE_MDI[type]} size={20} color={isSelected ? '#FFFFFF' : '#64748B'} style={styles.alertTypeIcon} />
                    <Text style={[styles.alertTypeLabel, isSelected && styles.alertTypeLabelSelected]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Severitate — butoane cu fill */}
            <Text style={styles.alertFormLabel}>Severitate</Text>
            <View style={styles.severityRow}>
              {(Object.keys(ALERT_SEVERITY_LABELS) as AlertSeverity[]).map(sev => {
                const { label, color } = ALERT_SEVERITY_LABELS[sev];
                const isSelected = alertSeverity === sev;
                return (
                  <TouchableOpacity
                    key={sev}
                    style={[
                      styles.severityBtn,
                      { backgroundColor: color + '20', borderColor: color },
                      isSelected && { backgroundColor: color },
                    ]}
                    onPress={() => setAlertSeverity(sev)}
                  >
                    <Text style={[
                      styles.severityLabel,
                      { color: color },
                      isSelected && styles.severityLabelSelected,
                    ]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Mesaj — compact */}
            <Text style={styles.alertFormLabel}>Mesaj alertă</Text>
            <TextInput
              style={styles.alertInput}
              placeholder="Descrie situația de urgență…"
              placeholderTextColor="#999"
              value={alertMessage}
              onChangeText={setAlertMessage}
              multiline
              numberOfLines={2}
            />

            {/* Rază și Durată — pe același rând */}
            <View style={styles.alertRowInputs}>
              <View style={styles.alertHalfInput}>
                <Text style={styles.alertFormLabel}>Rază (km)</Text>
                <TextInput
                  style={styles.alertInputSmall}
                  placeholder="1"
                  placeholderTextColor="#999"
                  value={alertRadius}
                  onChangeText={setAlertRadius}
                  keyboardType="numeric"
                />
              </View>
              <View style={styles.alertHalfInput}>
                <Text style={styles.alertFormLabel}>Durată (ore)</Text>
                <TextInput
                  style={styles.alertInputSmall}
                  placeholder="24"
                  placeholderTextColor="#999"
                  value={alertDuration}
                  onChangeText={setAlertDuration}
                  keyboardType="numeric"
                />
              </View>
            </View>

            </ScrollView>

            {/* Footer fix cu butoane — mereu vizibil, lipit la baza sheet-ului,
                deasupra zonei sigure (safe area). Nu mai depinde de scroll. */}
            <View style={[styles.alertFormFooter, { paddingBottom: insets.bottom + 12 }]}>
              <View style={styles.alertFormButtons}>
                <TouchableOpacity
                  style={styles.alertCancelBtn}
                  onPress={() => { Keyboard.dismiss(); handleCancelAlert(); }}
                >
                  <Text style={styles.alertCancelBtnText}>Anulează</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.alertSubmitBtn, isCreatingAlert && styles.alertSubmitBtnDisabled]}
                  onPress={handleCreateAlert}
                  disabled={isCreatingAlert}
                >
                  {isCreatingAlert ? (
                    <ActivityIndicator color="white" size="small" />
                  ) : (
                    <Text style={styles.alertSubmitBtnText}>Trimite alerta</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
          </KeyboardAvoidingView>
        </View>
      )}

      {/* --- ALERT DETAILS CARD --- */}
      {selectedAlert && !showAlertForm && (
        <View style={styles.alertDetailCard}>
          <View style={styles.alertDetailHeader}>
            <View style={[styles.alertDetailBadge, styles.alertDetailBadgeRow, { backgroundColor: ALERT_SEVERITY_LABELS[selectedAlert.severity].color }]}>
              <MaterialCommunityIcons name={ALERT_TYPE_MDI[selectedAlert.type]} size={15} color="#FFFFFF" style={styles.alertDetailBadgeIcon} />
              <Text style={styles.alertDetailBadgeText}>
                {ALERT_TYPE_LABELS[selectedAlert.type].label}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setSelectedAlert(null)} style={styles.alertDetailClose} accessibilityRole="button" accessibilityLabel="Închide">
              <MaterialCommunityIcons name="close" size={16} color="#64748B" />
            </TouchableOpacity>
          </View>

          <Text style={styles.alertDetailMessage}>{selectedAlert.message}</Text>

          <View style={styles.alertDetailInfo}>
            <View style={styles.alertDetailInfoItem}>
              <Text style={styles.alertDetailInfoLabel}>Severitate</Text>
              <Text style={[styles.alertDetailInfoValue, { color: ALERT_SEVERITY_LABELS[selectedAlert.severity].color }]}>
                {ALERT_SEVERITY_LABELS[selectedAlert.severity].label}
              </Text>
            </View>
            <View style={styles.alertDetailInfoItem}>
              <Text style={styles.alertDetailInfoLabel}>Rază</Text>
              <Text style={styles.alertDetailInfoValue}>{selectedAlert.radius} km</Text>
            </View>
            <View style={styles.alertDetailInfoItem}>
              <Text style={styles.alertDetailInfoLabel}>Expiră</Text>
              <Text style={styles.alertDetailInfoValue}>
                {new Date(selectedAlert.expiresAt).toLocaleString('ro-RO', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </Text>
            </View>
          </View>

          {userLocation && (
            <View style={styles.alertDetailDistance}>
              <MaterialCommunityIcons name="map-marker-distance" size={15} color="#64748B" style={styles.alertDetailDistanceIcon} />
              <Text style={styles.alertDetailDistanceText}>
                La {formatDistance(calculateDistance(
                  userLocation.latitude,
                  userLocation.longitude,
                  selectedAlert.lat,
                  selectedAlert.lng
                ))} de tine
              </Text>
            </View>
          )}
        </View>
      )}

      {/* --- ADMIN MODE INDICATOR --- */}
      {isAdmin && !showAlertForm && !selectedAlert && !selectedLocation && (
        <View style={styles.adminModeIndicator}>
          <Text style={styles.adminModeText}>Ține apăsat pe hartă pentru a crea alertă</Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },

  // Loading state
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F0F2F5',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#666',
  },

  // Error state
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F0F2F5',
    padding: 20,
  },
  errorIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8,
    textAlign: 'center',
  },
  errorMessage: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginBottom: 24,
    paddingHorizontal: 20,
  },
  retryButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },

  // Location error banner
  locationErrorBanner: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 110 : 95,
    left: 10,
    right: 10,
    backgroundColor: '#FEF3C7',
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    borderWidth: 1,
    borderColor: '#F59E0B',
  },
  locationErrorContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  locationErrorIcon: {
    fontSize: 18,
    marginRight: 8,
  },
  locationErrorText: {
    fontSize: 13,
    color: '#92400E',
    flex: 1,
  },
  settingsButton: {
    backgroundColor: '#F59E0B',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    marginLeft: 8,
  },
  settingsButtonText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },

  // Markers - icon dot style
  markerDot: {
    borderWidth: 2,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerIcon: {
    color: 'white',
    fontWeight: 'bold',
    textAlign: 'center',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },

  // User location dot
  userDotContainer: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#4285F4',
    zIndex: 2,
    borderWidth: 2,
    borderColor: 'white',
  },
  userDotRing: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(66, 133, 244, 0.3)',
  },

  // Top left container (data badge + alerts button)
  topLeftContainer: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 45,
    left: 10,
    right: 70,
  },
  dataBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
  },
  dataBadgeLoading: {
    backgroundColor: '#F5F5F5',
  },
  dataBadgeApi: {
    backgroundColor: '#E8F5E9',
    borderWidth: 1,
    borderColor: '#4CAF50',
  },
  dataBadgeCache: {
    backgroundColor: '#FFF8E1',
    borderWidth: 1,
    borderColor: '#FFC107',
  },
  dataBadgeFallback: {
    backgroundColor: '#FFEBEE',
    borderWidth: 1,
    borderColor: '#F44336',
  },
  dataBadgeIcon: {
    fontSize: 14,
    marginRight: 6,
  },
  dataBadgeText: {
    fontSize: 12,
    color: '#333',
    flex: 1,
  },
  dataBadgeRefresh: {
    fontSize: 14,
    marginLeft: 6,
  },

  // Alerts button
  alertsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  alertsButtonActive: {
    backgroundColor: '#FEF2F2',
    borderColor: '#DC2626',
  },
  alertsButtonIcon: {
    fontSize: 14,
    marginRight: 6,
  },
  alertsButtonText: {
    fontSize: 12,
    color: '#333',
    fontWeight: '500',
  },

  // BLE Mesh badge
  meshBadge: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 6,
    borderWidth: 1,
  },
  meshBadgeOff: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  meshBadgeOffline: {
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
  },
  meshBadgeOnline: {
    backgroundColor: '#EFF6FF',
    borderColor: '#BFDBFE',
  },
  meshDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  meshBadgeText: {
    fontSize: 11,
    color: '#475569',
    fontWeight: '500',
  },

  // Alerts modal
  alertsModalOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  alertsModalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  alertsModalContainer: {
    backgroundColor: 'white',
    borderRadius: 20,
    width: '90%',
    maxHeight: '75%',
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  alertsModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  alertsModalTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  alertsModalTitleIcon: {
    marginRight: 8,
  },
  alertsModalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1E293B',
  },
  alertsModalClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertsModalCloseText: {
    fontSize: 16,
    color: '#64748B',
  },
  alertsModalScroll: {
    flexGrow: 0,
  },
  alertsModalScrollContent: {
    padding: 16,
  },
  alertsModalEmpty: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  alertsModalEmptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  alertsModalEmptyText: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
  },

  // Alert card
  alertCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  alertCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  alertCardBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  alertCardBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  alertCardBadgeIcon: {
    marginRight: 4,
  },
  alertCardBadgeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  alertCardSeverity: {
    fontSize: 12,
    fontWeight: '600',
  },
  alertCardMessage: {
    fontSize: 14,
    color: '#1E293B',
    lineHeight: 20,
    marginBottom: 10,
  },
  alertCardDetails: {
    backgroundColor: 'white',
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
  },
  alertCardDetail: {
    fontSize: 12,
    color: '#64748B',
  },
  alertCardDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 5,
  },
  alertCardDetailIcon: {
    marginRight: 6,
  },
  alertCardActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  alertCardViewBtn: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  alertCardViewBtnText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  alertCardDeleteBtn: {
    backgroundColor: '#FEE2E2',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginLeft: 8,
  },
  alertCardDeleteBtnDisabled: {
    opacity: 0.5,
  },
  alertCardDeleteBtnRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  alertCardDeleteBtnIcon: {
    marginRight: 4,
  },
  alertCardDeleteBtnText: {
    color: '#DC2626',
    fontSize: 13,
    fontWeight: '600',
  },

  // Controls
  controls: {
    position: 'absolute',
    right: 15,
    top: Platform.OS === 'ios' ? 120 : 100,
  },
  controlBtn: {
    width: 44,
    height: 44,
    backgroundColor: 'white',
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  controlBtnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
  },
  filterBtn: {
    marginTop: 10,
  },
  filterBtnActive: {
    backgroundColor: '#2563EB',
  },

  // Filter menu
  filterMenu: {
    position: 'absolute',
    right: 70,
    top: Platform.OS === 'ios' ? 120 : 100,
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 12,
    minWidth: 200,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
  },
  filterHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5E5',
  },
  filterTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  filterSelectAll: {
    fontSize: 12,
    color: '#2563EB',
  },
  filterItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  filterItemInactive: {
    opacity: 0.5,
  },
  filterIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  filterIconText: {
    color: 'white',
    fontSize: 11,
    fontWeight: 'bold',
  },
  filterLabel: {
    flex: 1,
    fontSize: 14,
    color: '#333',
  },
  filterLabelInactive: {
    color: '#999',
  },
  filterCount: {
    fontSize: 12,
    color: '#999',
    marginRight: 10,
  },
  filterCheckbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#DDD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterCheckboxActive: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
  },
  filterCheckmark: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold',
  },
  filterFooter: {
    fontSize: 11,
    color: '#999',
    textAlign: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#E5E5E5',
  },

  // Legendă hartă
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  legendLabel: {
    flex: 1,
    fontSize: 14,
    color: '#333',
  },
  legendDivider: {
    height: 1,
    backgroundColor: '#E5E5E5',
    marginVertical: 6,
  },
  legendUserDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#4285F4',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    marginRight: 10,
  },
  legendAlertRing: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2.5,
    borderColor: '#EF4444',
    backgroundColor: 'rgba(239,68,68,0.18)',
    marginRight: 10,
  },

  // Bottom card (account for tab bar: Android ~60px, iOS ~85px with home indicator)
  bottomCard: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 100 : 90,
    left: 15,
    right: 15,
    backgroundColor: 'white',
    padding: 20,
    borderRadius: 15,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    flex: 1,
    marginRight: 10,
  },
  typeBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  typeBadgeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  cardCapacity: {
    color: '#666',
    fontSize: 14,
    marginBottom: 4,
  },
  cardCoords: {
    color: '#999',
    fontSize: 12,
    marginBottom: 8,
  },
  distanceContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: '#F5F5F5',
    borderRadius: 8,
    paddingVertical: 10,
    marginVertical: 10,
  },
  distanceItem: {
    alignItems: 'center',
  },
  distanceIcon: {
    fontSize: 16,
    marginBottom: 2,
  },
  distanceText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#333',
  },
  cardNoLocation: {
    color: '#999',
    fontSize: 12,
    textAlign: 'center',
    marginVertical: 10,
  },
  navButton: {
    marginTop: 10,
    backgroundColor: '#2563EB',
    padding: 14,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navButtonIcon: {
    marginRight: 8,
  },
  navButtonText: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 16,
  },

  // Alert tap marker (when creating) — pin randat ca View (formă plină),
  // nu ca glyph de font: apare instant și e proeminent, fără dependența de
  // încărcarea fontului de iconițe (care întârzia rasterizarea în PointAnnotation).
  alertTapMarker: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertTapPin: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#DC2626',
    borderWidth: 3,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
  },

  // Alert marker on map
  alertMarker: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'white',
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
  },
  alertMarkerIcon: {
    fontSize: 18,
  },

  // Alert detail card
  alertDetailCard: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 100 : 90,
    left: 15,
    right: 15,
    backgroundColor: 'white',
    padding: 16,
    borderRadius: 15,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  alertDetailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  alertDetailBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  alertDetailBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  alertDetailBadgeIcon: {
    marginRight: 5,
  },
  alertDetailBadgeText: {
    color: 'white',
    fontWeight: '600',
    fontSize: 14,
  },
  alertDetailClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertDetailCloseText: {
    fontSize: 14,
    color: '#64748B',
  },
  alertDetailMessage: {
    fontSize: 15,
    color: '#1E293B',
    lineHeight: 22,
    marginBottom: 12,
  },
  alertDetailInfo: {
    flexDirection: 'row',
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    padding: 12,
  },
  alertDetailInfoItem: {
    flex: 1,
    alignItems: 'center',
  },
  alertDetailInfoLabel: {
    fontSize: 11,
    color: '#64748B',
    marginBottom: 4,
  },
  alertDetailInfoValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
  },
  alertDetailDistance: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertDetailDistanceIcon: {
    marginRight: 6,
  },
  alertDetailDistanceText: {
    fontSize: 14,
    color: '#64748B',
  },

  // Admin mode indicator
  adminModeIndicator: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 100 : 90,
    left: 15,
    right: 15,
    backgroundColor: 'rgba(220, 38, 38, 0.9)',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
  },
  adminModeText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },

  // Alert form overlay (full screen)
  alertFormOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  alertFormBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  alertFormKeyboardView: {
    justifyContent: 'flex-end' as const,
  },
  alertFormContainer: {
    backgroundColor: 'white',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '75%',
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
  },
  // ScrollView se contractă în interiorul containerului (maxHeight), lăsând
  // footer-ul cu butoane mereu vizibil sub el.
  alertFormScroll: {
    flexShrink: 1,
  },
  alertFormScrollContent: {
    padding: 16,
    paddingBottom: 8,
  },
  // Footer fix cu butoanele — separat de zona scrollabilă.
  alertFormFooter: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    backgroundColor: '#FFFFFF',
  },
  alertFormHeader: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'flex-start' as const,
    marginBottom: 8,
  },
  alertFormTitle: {
    fontSize: 18,
    fontWeight: 'bold' as const,
    color: '#1E293B',
  },
  alertFormClose: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#F1F5F9',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  alertFormCloseText: {
    fontSize: 16,
    color: '#64748B',
  },
  alertFormCoords: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  alertFormLabel: {
    fontSize: 13,
    fontWeight: '600' as const,
    color: '#334155',
    marginBottom: 6,
    marginTop: 10,
  },

  // Alert type grid — compact
  alertTypeGrid: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    marginHorizontal: -3,
  },
  alertTypeBtn: {
    width: '31%',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
    alignItems: 'center' as const,
    margin: 3,
  },
  alertTypeIcon: {
    fontSize: 18,
    marginBottom: 2,
  },
  alertTypeLabel: {
    fontSize: 10,
    color: '#64748B',
    textAlign: 'center' as const,
  },
  alertTypeLabelSelected: {
    color: 'white',
    fontWeight: '600' as const,
  },

  // Severity row — all with fill
  severityRow: {
    flexDirection: 'row' as const,
    marginHorizontal: -3,
  },
  severityBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center' as const,
    marginHorizontal: 3,
  },
  severityLabel: {
    fontSize: 11,
    fontWeight: '600' as const,
  },
  severityLabelSelected: {
    color: 'white',
  },

  // Alert inputs — compact
  alertInput: {
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1E293B',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    minHeight: 60,
    textAlignVertical: 'top' as const,
  },
  alertRowInputs: {
    flexDirection: 'row' as const,
    marginHorizontal: -4,
  },
  alertHalfInput: {
    flex: 1,
    marginHorizontal: 4,
  },
  alertInputSmall: {
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1E293B',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },

  // Alert form buttons — compact
  alertFormButtons: {
    flexDirection: 'row' as const,
    marginHorizontal: -4,
  },
  alertCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    alignItems: 'center' as const,
    marginHorizontal: 4,
  },
  alertCancelBtnText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: '#64748B',
  },
  alertSubmitBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#DC2626',
    alignItems: 'center' as const,
    marginHorizontal: 4,
  },
  alertSubmitBtnDisabled: {
    backgroundColor: '#94A3B8',
  },
  alertSubmitBtnText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: 'white',
  },
});

export default MapScreen;