import React, { useState, useRef, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, Alert, ActivityIndicator, PermissionsAndroid } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';
import RNFS from 'react-native-fs';
import Geolocation from 'react-native-geolocation-service';

// --- DATE MOCKUP ---
const SHELTERS = [
  { id: '1', type: 'hospital', lat: 45.738205, lng: 21.242398, name: 'Spitalul Județean', capacity: '85%' },
  { id: '2', type: 'bunker', lat: 45.747479, lng: 21.226180, name: 'Adăpost UPT', capacity: '20%' },
];

const DISASTER_ZONES = [
  { id: 'd1', type: 'fire', lat: 45.751, lng: 21.222, radius: 300 },
];

const MapScreen = () => {
  const [selectedLocation, setSelectedLocation] = useState<any>(null);
  
  // Stare pentru Harta Offline
  const [mapPath, setMapPath] = useState<string | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);

  // Stare pentru Zoom și Locație
  const [zoomLevel, setZoomLevel] = useState<number>(12); // Pornim de la 12
  const [userLocation, setUserLocation] = useState<{latitude: number, longitude: number} | null>(null);

  const cameraRef = useRef<MapLibreGL.CameraRef>(null);

  // --- 1. SETUP HARTA OFFLINE ---
  useEffect(() => {
    const initMapFile = async () => {
      try {
        const fileName = 'romania.mbtiles';
        const destPath = `${RNFS.DocumentDirectoryPath}/${fileName}`;
        const exists = await RNFS.exists(destPath);

        if (!exists) {
            console.log("Copiere harta din assets...");
            if (Platform.OS === 'android') {
              // Android: Copy from bundled assets folder
              await RNFS.copyFileAssets(fileName, destPath);
              console.log("✅ Harta copiată cu succes pe Android");
            } else {
              // iOS: Copy from app bundle (requires file to be added in Xcode)
              const bundlePath = `${RNFS.MainBundlePath}/${fileName}`;
              console.log(`Attempting to copy from: ${bundlePath}`);
              const bundleExists = await RNFS.exists(bundlePath);
              
              if (bundleExists) {
                await RNFS.copyFile(bundlePath, destPath);
                console.log("✅ Harta copiată cu succes pe iOS");
              } else {
                throw new Error(`Bundle file not found at: ${bundlePath}`);
              }
            }
        } else {
          console.log("✅ Harta există deja în DocumentDirectory");
        }
        setMapPath(destPath);
        setIsMapReady(true);
      } catch (error) {
        console.error("❌ Eroare la copierea hărții:", error);
        console.log("⚠️ Aplicația va continua fără hartă offline");
        setMapPath(null); 
        setIsMapReady(true);
      }
    };
    initMapFile();
  }, []);

  // --- 2. SETUP LOCATIE (GPS) ---
  useEffect(() => {
    const requestPermissionAndWatch = async () => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) return;
      }

      Geolocation.watchPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          setUserLocation({ latitude, longitude });
        },
        (error) => {
          console.log("Eroare GPS:", error.code, error.message);
        },
        { enableHighAccuracy: true, distanceFilter: 10, interval: 5000, fastestInterval: 2000 }
      );
    };

    requestPermissionAndWatch();
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
  const renderShelterMarker = (shelter: any) => {
    const isHospital = shelter.type === 'hospital';
    const bgColor = isHospital ? '#FFFFFF' : '#34C759';
    const icon = isHospital ? '🏥' : '🛡️';

    return (
      <MapLibreGL.PointAnnotation
        key={shelter.id}
        id={shelter.id}
        coordinate={[shelter.lng, shelter.lat]}
        onSelected={() => {
          setSelectedLocation(shelter);
          // Când selectăm un marker, dăm zoom in
          const targetZoom = 16;
          setZoomLevel(targetZoom);
          
          cameraRef.current?.setCamera({
            centerCoordinate: [shelter.lng, shelter.lat],
            zoomLevel: targetZoom,
            animationDuration: 800,
            animationMode: 'flyTo',
            pitch: 45, 
          });
        }}
      >
        <View style={styles.markerContainer}>
           <View style={[styles.markerBubble, { backgroundColor: bgColor }]}>
             <Text style={{ fontSize: 20 }}>{icon}</Text>
           </View>
           <View style={[styles.markerArrow, { borderTopColor: bgColor }]} />
        </View>
      </MapLibreGL.PointAnnotation>
    );
  };

  if (!isMapReady) return <ActivityIndicator size="large" style={{flex:1}} color="#007AFF"/>;

  return (
    <View style={styles.container}>
      <MapLibreGL.MapView
        style={styles.map}
        mapStyle={mapStyle ? JSON.stringify(mapStyle) : undefined}
        surfaceView={false} 
        logoEnabled={false}
        attributionEnabled={false}
        onPress={() => setSelectedLocation(null)}
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

        {SHELTERS.map(renderShelterMarker)}
      </MapLibreGL.MapView>

      {/* --- BUTTONS --- */}
      <View style={styles.controls}>
        <TouchableOpacity style={styles.controlBtn} onPress={centerOnUser}>
          <Text style={styles.btnText}>📍</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.controlBtn, {marginTop: 10}]} onPress={handleZoomIn}>
          <Text style={styles.btnText}>+</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.controlBtn, {marginTop: 10}]} onPress={handleZoomOut}>
          <Text style={styles.btnText}>−</Text>
        </TouchableOpacity>
      </View>

      {/* --- BOTTOM SHEET --- */}
      {selectedLocation && (
        <View style={styles.bottomCard}>
          <Text style={styles.cardTitle}>{selectedLocation.name}</Text>
          <Text style={{color:'#666'}}>Capacitate: {selectedLocation.capacity}</Text>
          <TouchableOpacity 
            style={styles.navButton} 
            onPress={() => Alert.alert("Navigare", `Calculare rută spre ${selectedLocation.name}`)}
          >
            <Text style={{color:'white', fontWeight:'bold'}}>Navighează Aici</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  markerContainer: { width: 60, height: 60, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  markerBubble: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', elevation: 5 },
  markerArrow: { width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 8, borderLeftColor: 'transparent', borderRightColor: 'transparent', marginTop: -2 },
  userDotContainer: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  userDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: '#4285F4', zIndex: 2, borderWidth: 2, borderColor: 'white' },
  userDotRing: { position:'absolute', width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(66, 133, 244, 0.3)' },
  controls: { position: 'absolute', right: 20, top: 100 },
  controlBtn: { width: 44, height: 44, backgroundColor: 'white', borderRadius: 22, alignItems: 'center', justifyContent: 'center', elevation: 5 },
  btnText: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  bottomCard: { position: 'absolute', bottom: 20, left: 20, right: 20, backgroundColor: 'white', padding: 20, borderRadius: 15, elevation: 10 },
  cardTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 5 },
  navButton: { marginTop: 10, backgroundColor: '#007AFF', padding: 12, borderRadius: 8, alignItems: 'center' }
});

export default MapScreen;