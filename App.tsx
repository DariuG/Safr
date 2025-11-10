/**
 * Safr - Emergency Situation Assistant
 *
 * @format
 */

import { StatusBar, StyleSheet, useColorScheme, Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';

// Import screens
import HomeScreen from './src/screens/HomeScreen';
import ChatScreen from './src/screens/ChatScreen';
import MapScreen from './src/screens/MapScreen';
import EmergencyScreen from './src/screens/EmergencyScreen';

const Tab = createBottomTabNavigator();

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
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
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;
