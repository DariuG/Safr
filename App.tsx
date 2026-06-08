/**
 * Safr - Emergency Situation Assistant
 *
 * @format
 */

import React, { useEffect } from 'react';
import { StatusBar, StyleSheet, useColorScheme, Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

// Import screens
import HomeScreen from './src/screens/HomeScreen';
import ChatScreen from './src/screens/ChatScreen';
import MapScreen from './src/screens/MapScreen';
import EmergencyScreen from './src/screens/EmergencyScreen';
import AdminLoginScreen from './src/screens/AdminLoginScreen';

// Import context
import { AuthProvider } from './src/context/AuthContext';

// Notification setup
import {
  requestNotificationPermission,
  initNotificationChannels,
  registerForegroundTapHandler,
  checkInitialNotification,
  subscribeAlertFocus,
} from './src/services/notificationService';

// Navigation ref pentru deep-link din afara componentelor
import { navigationRef, navigateToMap } from './src/utils/navigationRef';

// AI models manager (background download + bundle copy)
import modelManager from './src/services/modelManager';

// Map resources (copy .mbtiles din bundle la startup, nu la mount MapScreen)
import mapResourcesService from './src/services/mapResourcesService';

// Prefetch shelters (populează cache Overpass înainte de MapScreen)
import { prefetchShelters } from './src/services/shelterService';

// Permisiune locație (cerută la startup pentru ca prefetch-ul să funcționeze)
import { ensureLocationPermission } from './src/utils/permissions';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// Tab Navigator Component
function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        tabBarStyle: {
          backgroundColor: '#FFFFFF',
          borderTopWidth: 0,
          height: 90,
          marginBottom: Platform.OS === 'android' ? 5 : 0,
          paddingBottom: Platform.OS === 'ios' ? 25 : 12,
          paddingTop: 12,
          paddingHorizontal: 16,
          elevation: 20,
          shadowColor: '#000',
          shadowOffset: {
            width: 0,
            height: -4,
          },
          shadowOpacity: 0.15,
          shadowRadius: 12,
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          borderTopLeftRadius: 30,
          borderTopRightRadius: 30,
          margin: 0,
        },
        tabBarBackground: () => (
          <View
            style={{
              backgroundColor: '#FFFFFF',
              height: '100%',
              borderTopLeftRadius: 30,
              borderTopRightRadius: 30,
            }}
          />
        ),
        tabBarActiveTintColor: '#2563EB',
        tabBarInactiveTintColor: '#94A3B8',
        tabBarLabelStyle: {
          fontSize: 14,
          fontWeight: '700',
          paddingBottom: Platform.OS === 'android' ? 8 : 0,
          marginTop: Platform.OS === 'android' ? 8 : 4,
        },
        headerShown: false,
        tabBarItemStyle: {
          height: 60,
          paddingTop: 8,
          margin: 0,
        },
        tabBarIconStyle: {
          marginBottom: -4,
        },
      }}>
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="home" color={color} size={28} />
          ),
        }}
      />
      <Tab.Screen
        name="Chat"
        component={ChatScreen}
        options={{
          tabBarLabel: 'Chat',
          // Ascunde bara de taburi când tastatura e deschisă, ca să elibereze
          // spațiu pentru conversație și să nu acopere câmpul de input.
          tabBarHideOnKeyboard: true,
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="chat" color={color} size={28} />
          ),
        }}
      />
      <Tab.Screen
        name="Map"
        component={MapScreen}
        options={{
          tabBarLabel: 'Map',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="map" color={color} size={28} />
          ),
        }}
      />
      <Tab.Screen
        name="Emergency"
        component={EmergencyScreen}
        options={{
          tabBarLabel: 'Emergency',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="alert-circle" color={color} size={28} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  useEffect(() => {
    // Setup notificări + modele AI la pornirea app-ului
    (async () => {
      await initNotificationChannels();
      await requestNotificationPermission();

      // Pornește verificarea/descărcarea modelelor în background.
      // Embedding se copiază din bundle (rapid), LLM se descarcă async (~800 MB).
      modelManager.init().catch(err => {
        console.error('[App] modelManager.init failed:', err);
      });

      // Copiază harta offline (.mbtiles) din bundle în background, ca să fie
      // gata până userul ajunge pe MapScreen (evită freeze la prima intrare).
      mapResourcesService.init().catch(err => {
        console.error('[App] mapResourcesService.init failed:', err);
      });

      // Cere permisiunea de locație la startup (după notificări), apoi
      // prefetch shelters. Cerând permisiunea aici, prefetch-ul funcționează
      // de la prima instalare; altfel permisiunea ar fi cerută abia la intrarea
      // pe MapScreen și prefetch-ul s-ar sări (vezi shelterService.prefetchShelters).
      // Secvențiat: așteptăm răspunsul la dialog înainte de prefetch.
      ensureLocationPermission()
        .then(granted => {
          if (granted) {
            return prefetchShelters();
          }
          console.log('[App] Location not granted at startup — prefetch skipped');
        })
        .catch(err => {
          console.warn('[App] location/prefetch bootstrap failed:', err);
        });
    })();

    // ── Deep-link la nivel global pentru tap-uri pe notificări ──
    // App.tsx ascultă alertFocus și navighează la tab-ul Map.
    // MapScreen ascultă tot alertFocus, dar pentru centrarea camerei.
    const unsubFocus = subscribeAlertFocus(() => {
      navigateToMap();
    });

    // Înregistrează handler-ul de tap în foreground
    const unsubForeground = registerForegroundTapHandler();

    // Verifică cold-start (app deschisă printr-o notificare din terminated state)
    checkInitialNotification();

    return () => {
      unsubFocus();
      unsubForeground();
    };
  }, []);

  return (
    <AuthProvider>
      <SafeAreaProvider>
        <NavigationContainer ref={navigationRef}>
          <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="MainTabs" component={TabNavigator} />
            <Stack.Screen
              name="AdminLogin"
              component={AdminLoginScreen}
              options={{
                presentation: 'modal',
                animation: 'slide_from_bottom',
              }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;
