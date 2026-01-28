import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, Alert, ActivityIndicator, PermissionsAndroid, Linking } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';
import RNFS from 'react-native-fs';
import Geolocation from 'react-native-geolocation-service';
import { getShelters, refreshShelters, Shelter } from '../services/shelterService';
import {
  showNavigationOptions,
  calculateDistance,
  formatDistance,
  estimateTravelTime,
  formatTravelTime,
} from '../utils/navigation';

// --- DISASTER ZONES (mock for now) ---
const DISASTER_ZONES = [
  { id: 'd1', type: 'fire', lat: 45.751, lng: 21.222, radius: 300 },
];

// Location permission status type
type LocationPermissionStatus = 'granted' | 'denied' | 'disabled' | 'restricted' | 'unavailable';

const MapScreen = () => {
  const [selectedLocation, setSelectedLocation] = useState<Shelter | null>(null);

  // Stare pentru Harta Offline
  const [mapPath, setMapPath] = useState<string | null>(null);
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
  const [activeFilters, setActiveFilters] = useState<Set<Shelter['type']>>(
    new Set(['hospital', 'pharmacy', 'fire', 'police', 'bunker'])
  );

  const cameraRef = useRef<MapLibreGL.CameraRef>(null);

  // --- 1. SETUP HARTA OFFLINE ---
  useEffect(() => {
    const initMapFile = async () => {
      try {
        const fileName = 'romania.mbtiles';
        const destPath = `${RNFS.DocumentDirectoryPath}/${fileName}`;
        const exists = await RNFS.exists(destPath);

        if (!exists) {
          console.log('Copiere harta din assets...');
          if (Platform.OS === 'android') {
            await RNFS.copyFileAssets(fileName, destPath);
            console.log('✅ Harta copiată cu succes pe Android');
          } else {
            const bundlePath = `${RNFS.MainBundlePath}/${fileName}`;
            console.log(`Attempting to copy from: ${bundlePath}`);
            const bundleExists = await RNFS.exists(bundlePath);

            if (bundleExists) {
              await RNFS.copyFile(bundlePath, destPath);
              console.log('✅ Harta copiată cu succes pe iOS');
            } else {
              throw new Error(`Fișierul hărții nu a fost găsit: ${bundlePath}`);
            }
          }
        } else {
          console.log('✅ Harta există deja în DocumentDirectory');
        }

        // Verify the file was copied successfully
        const finalExists = await RNFS.exists(destPath);
        if (!finalExists) {
          throw new Error('Fișierul hărții nu a putut fi verificat după copiere');
        }

        setMapPath(destPath);
        setMapError(null);
        setIsMapReady(true);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Eroare necunoscută la încărcarea hărții';
        console.error('❌ Eroare la copierea hărții:', error);
        setMapError(errorMessage);
        setMapPath(null);
        setIsMapReady(true);
      }
    };
    initMapFile();
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
        console.log('✅ GPS watch cleared');
      }
    };
  }, [requestLocationPermission, getLocationErrorMessage]);

  // --- 2.5. LOAD SHELTERS FROM OVERPASS API ---
  useEffect(() => {
    let isMounted = true;

    const loadShelters = async () => {
      try {
        setSheltersLoading(true);
        const result = await getShelters();

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
  }, []);

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
    setSheltersLoading(true);
    try {
      const result = await refreshShelters();
      setShelters(result.shelters);
      setSheltersSource(result.source);
      setSheltersError(result.error || null);

      if (result.source === 'api') {
        Alert.alert('Succes', `Datele au fost actualizate. ${result.shelters.length} locații găsite.`);
      } else if (result.error) {
        Alert.alert('Atenție', result.error);
      }
    } catch (error) {
      Alert.alert('Eroare', 'Nu s-au putut actualiza datele.');
    } finally {
      setSheltersLoading(false);
    }
  }, []);

  // --- 3. STIL HARTA ---
  const mapStyle = useMemo(() => {
    if (!mapPath) return null;
    return {
      version: 8,
      sources: { 'offline_source': { type: 'vector', url: `mbtiles://${mapPath}` } },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#F0F2F5' } },
        { id: 'landuse', type: 'fill', source: 'offline_source', 'source-layer': 'landuse', paint: { 'fill-color': '#D6E6D5' } },
        { id: 'water', type: 'fill', source: 'offline_source', 'source-layer': 'water', paint: { 'fill-color': '#A0C8F0' } },
        { id: 'buildings', type: 'fill', source: 'offline_source', 'source-layer': 'building', paint: { 'fill-color': '#D9D9D9', 'fill-outline-color': '#CCCCCC' } },
        { id: 'roads', type: 'line', source: 'offline_source', 'source-layer': 'transportation', paint: { 'line-color': '#FFFFFF', 'line-width': 2 } },
      ]
    };
  }, [mapPath]);

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
        Alert.alert("GPS", "Căutare semnal GPS...");
    }
  };

  // --- 5. COMPONENTA MARKER ---
  const getMarkerStyle = (type: Shelter['type']): { color: string; icon: string; borderColor: string } => {
    switch (type) {
      case 'hospital':
        return { color: '#DC2626', icon: 'H', borderColor: '#991B1B' };    // Red with H
      case 'pharmacy':
        return { color: '#16A34A', icon: '+', borderColor: '#166534' };   // Green with +
      case 'fire':
        return { color: '#EA580C', icon: 'F', borderColor: '#9A3412' };   // Orange with F
      case 'police':
        return { color: '#2563EB', icon: 'P', borderColor: '#1E40AF' };   // Blue with P
      case 'bunker':
        return { color: '#7C3AED', icon: 'S', borderColor: '#5B21B6' };   // Purple with S (Shelter)
      default:
        return { color: '#6B7280', icon: '•', borderColor: '#374151' };   // Gray with dot
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
          <Text style={[styles.markerIcon, { fontSize: isHospital ? 12 : 10 }]}>{icon}</Text>
        </View>
      </MapLibreGL.PointAnnotation>
    );
  };

  // Loading state
  if (!isMapReady) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Se încarcă harta offline...</Text>
      </View>
    );
  }

  // Map error state - show fallback UI
  if (mapError) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorIcon}>🗺️</Text>
        <Text style={styles.errorTitle}>Harta nu a putut fi încărcată</Text>
        <Text style={styles.errorMessage}>{mapError}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => {
            setIsMapReady(false);
            setMapError(null);
            // Re-trigger map initialization
            const initMapFile = async () => {
              try {
                const fileName = 'romania.mbtiles';
                const destPath = `${RNFS.DocumentDirectoryPath}/${fileName}`;
                const exists = await RNFS.exists(destPath);
                if (exists) {
                  setMapPath(destPath);
                  setMapError(null);
                }
                setIsMapReady(true);
              } catch (e) {
                setMapError('Încercarea a eșuat');
                setIsMapReady(true);
              }
            };
            initMapFile();
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
          setShowFilterMenu(false);
        }}
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

        {/* --- CUSTOM USER LOCATION MARKER --- */}
        {userLocation && (
             <MapLibreGL.PointAnnotation
                id="userLocation"
                coordinate={[userLocation.longitude, userLocation.latitude]}
             >
                <View style={styles.userDotContainer}>
                    <View style={styles.userDot} />
                    <View style={styles.userDotRing} />
                </View>
             </MapLibreGL.PointAnnotation>
        )}

        {/* --- DISASTER ZONES --- */}
        <MapLibreGL.ShapeSource
          id="disasterSource"
          shape={{
            type: 'FeatureCollection',
            features: DISASTER_ZONES.map(zone => ({
              type: 'Feature',
              properties: {},
              geometry: { type: 'Point', coordinates: [zone.lng, zone.lat] },
            })),
          }}
        >
          <MapLibreGL.CircleLayer
            id="disasterCircles"
            style={{
              circleRadius: 60,
              circleColor: 'rgba(231, 76, 60, 0.4)',
              circleStrokeColor: 'rgba(231, 76, 60, 1)',
              circleStrokeWidth: 2,
              circleBlur: 0.2,
            }}
          />
        </MapLibreGL.ShapeSource>

        {filteredShelters.map(renderShelterMarker)}
      </MapLibreGL.MapView>

      {/* --- LOCATION ERROR BANNER --- */}
      {locationError && (
        <View style={styles.locationErrorBanner}>
          <View style={styles.locationErrorContent}>
            <Text style={styles.locationErrorIcon}>⚠️</Text>
            <Text style={styles.locationErrorText}>{locationError}</Text>
          </View>
          {(locationPermissionStatus === 'denied' || locationPermissionStatus === 'restricted') && (
            <TouchableOpacity style={styles.settingsButton} onPress={openLocationSettings}>
              <Text style={styles.settingsButtonText}>Setări</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* --- DATA SOURCE BADGE --- */}
      <View style={styles.dataBadgeContainer}>
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
          >
            <Text style={styles.dataBadgeIcon}>
              {sheltersSource === 'api' ? '🌐' : sheltersSource === 'cache' ? '💾' : '⚠️'}
            </Text>
            <Text style={styles.dataBadgeText}>
              {filteredShelters.length}/{shelters.length} locații • {sheltersSource === 'api' ? 'Live' : sheltersSource === 'cache' ? 'Cache' : 'Offline'}
            </Text>
            <Text style={styles.dataBadgeRefresh}>🔄</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* --- BUTTONS --- */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.controlBtn, !userLocation && styles.controlBtnDisabled]}
          onPress={centerOnUser}
        >
          <Text style={styles.btnText}>📍</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.controlBtn, {marginTop: 10}]} onPress={handleZoomIn}>
          <Text style={styles.btnText}>+</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.controlBtn, {marginTop: 10}]} onPress={handleZoomOut}>
          <Text style={styles.btnText}>−</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.controlBtn, styles.filterBtn, showFilterMenu && styles.filterBtnActive]}
          onPress={() => setShowFilterMenu(!showFilterMenu)}
        >
          <Text style={styles.btnText}>⚙</Text>
        </TouchableOpacity>
      </View>

      {/* --- FILTER MENU --- */}
      {showFilterMenu && (
        <View style={styles.filterMenu}>
          <View style={styles.filterHeader}>
            <Text style={styles.filterTitle}>Filtrează</Text>
            <TouchableOpacity onPress={toggleAllFilters}>
              <Text style={styles.filterSelectAll}>
                {activeFilters.size === 5 ? 'Deselectează' : 'Selectează tot'}
              </Text>
            </TouchableOpacity>
          </View>

          {([
            { type: 'hospital' as const, label: 'Spitale', icon: 'H' },
            { type: 'pharmacy' as const, label: 'Farmacii', icon: '+' },
            { type: 'fire' as const, label: 'Pompieri', icon: 'F' },
            { type: 'police' as const, label: 'Poliție', icon: 'P' },
            { type: 'bunker' as const, label: 'Adăposturi', icon: 'S' },
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
                  <Text style={styles.filterIconText}>{icon}</Text>
                </View>
                <Text style={[styles.filterLabel, !isActive && styles.filterLabelInactive]}>
                  {label}
                </Text>
                <Text style={styles.filterCount}>{count}</Text>
                <View style={[styles.filterCheckbox, isActive && styles.filterCheckboxActive]}>
                  {isActive && <Text style={styles.filterCheckmark}>✓</Text>}
                </View>
              </TouchableOpacity>
            );
          })}

          <Text style={styles.filterFooter}>
            {filteredShelters.length} din {shelters.length} afișate
          </Text>
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
                      <Text style={styles.distanceIcon}>📍</Text>
                      <Text style={styles.distanceText}>{formatDistance(distance)}</Text>
                    </View>
                    <View style={styles.distanceItem}>
                      <Text style={styles.distanceIcon}>🚗</Text>
                      <Text style={styles.distanceText}>{formatTravelTime(drivingTime)}</Text>
                    </View>
                    <View style={styles.distanceItem}>
                      <Text style={styles.distanceIcon}>🚶</Text>
                      <Text style={styles.distanceText}>{formatTravelTime(walkingTime)}</Text>
                    </View>
                  </>
                );
              })()}
            </View>
          )}

          {!userLocation && (
            <Text style={styles.cardNoLocation}>📍 Activează GPS pentru distanță</Text>
          )}

          <TouchableOpacity
            style={styles.navButton}
            onPress={() => showNavigationOptions(
              { lat: selectedLocation.lat, lng: selectedLocation.lng, label: selectedLocation.name },
              userLocation
            )}
          >
            <Text style={styles.navButtonText}>🧭 Navighează</Text>
          </TouchableOpacity>
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
    backgroundColor: '#007AFF',
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

  // Data source badge
  dataBadgeContainer: {
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
    backgroundColor: '#007AFF',
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
    color: '#007AFF',
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
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
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
    backgroundColor: '#007AFF',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  navButtonText: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 16,
  },
});

export default MapScreen;