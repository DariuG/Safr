/**
 * Safr - Emergency Situation Assistant
 *
 * @format
 */

import React, { useEffect, useState } from 'react';
import { StatusBar, StyleSheet, useColorScheme, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeBottomTabNavigator } from '@bottom-tabs/react-navigation';
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

const Tab = createNativeBottomTabNavigator();
const Stack = createNativeStackNavigator();

// Tab Navigator Component (bară nativă — Liquid Glass pe iOS 26)

// SF Symbols pe iOS (pentru aspectul nativ + tint corect cu materialul Liquid
// Glass); pe Android, surse de imagine generate din fontul MaterialCommunityIcons
// (deja folosit în app), pre-încărcate o singură dată. Bara nativă NU acceptă
// componente React ca iconițe.
const TAB_ICONS = {
  Home: { sf: 'house', mci: 'home' },
  Chat: { sf: 'message', mci: 'chat' },
  Map: { sf: 'map', mci: 'map' },
  Emergency: { sf: 'exclamationmark.triangle', mci: 'alert-circle' },
} as const;

type TabKey = keyof typeof TAB_ICONS;

function TabNavigator() {
  // Bara nativă cere surse de imagine pe Android; le pre-generăm o singură dată.
  const [androidIcons, setAndroidIcons] = useState<Record<string, any>>({});

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        (Object.keys(TAB_ICONS) as TabKey[]).map(async key => {
          const src = await MaterialCommunityIcons.getImageSource(
            TAB_ICONS[key].mci,
            26,
            '#334155',
          );
          return [key, src] as const;
        }),
      );
      if (!cancelled) {
        setAndroidIcons(Object.fromEntries(entries));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const iconFor = (key: TabKey) => () =>
    Platform.OS === 'ios' ? { sfSymbol: TAB_ICONS[key].sf } : androidIcons[key];

  return (
    <Tab.Navigator
      tabBarActiveTintColor="#2563EB"
      tabBarInactiveTintColor="#94A3B8">
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: 'Home', tabBarIcon: iconFor('Home') }}
      />
      <Tab.Screen
        name="Chat"
        component={ChatScreen}
        options={{ title: 'Chat', tabBarIcon: iconFor('Chat') }}
      />
      <Tab.Screen
        name="Map"
        component={MapScreen}
        options={{ title: 'Map', tabBarIcon: iconFor('Map') }}
      />
      <Tab.Screen
        name="Emergency"
        component={EmergencyScreen}
        options={{ title: 'Emergency', tabBarIcon: iconFor('Emergency') }}
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
