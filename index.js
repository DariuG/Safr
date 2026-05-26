/**
 * @format
 */

import { AppRegistry } from 'react-native';
import notifee from '@notifee/react-native';
import App from './App';
import { name as appName } from './app.json';
import { backgroundEventHandler } from './src/services/notificationService';

// Background notification handler — DOAR la nivel de modul, NU în componente.
// Permite procesarea tap-urilor pe notificări când app-ul e killed.
notifee.onBackgroundEvent(backgroundEventHandler);

AppRegistry.registerComponent(appName, () => App);
