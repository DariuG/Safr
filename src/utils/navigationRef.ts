import { createNavigationContainerRef } from '@react-navigation/native';

/**
 * Ref global la NavigationContainer, folosit pentru a permite navigarea
 * din afara componentelor React (ex: handler-i de notificare la nivel de App).
 */
export const navigationRef = createNavigationContainerRef<any>();

/**
 * Navighează la tab-ul Map din MainTabs. Safe la apeluri când
 * NavigationContainer nu e gata încă (no-op).
 */
export const navigateToMap = (): void => {
  if (navigationRef.isReady()) {
    navigationRef.navigate('MainTabs', { screen: 'Map' });
  }
};
