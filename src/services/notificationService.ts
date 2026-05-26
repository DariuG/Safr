import notifee, {
  AndroidImportance,
  AndroidVisibility,
  AuthorizationStatus,
  EventType,
} from '@notifee/react-native';
import { Platform } from 'react-native';
import {
  DisasterAlert,
  ALERT_TYPE_LABELS,
  ALERT_SEVERITY_LABELS,
} from './alertService';

const CHANNEL_ID_DEFAULT = 'safr_alerts_default';
const CHANNEL_ID_CRITICAL = 'safr_alerts_critical';

let channelsInitialized = false;

/**
 * Solicită permisiunea de notificări (iOS + Android 13+).
 * Pe Android <13 permisiunea e granted by default.
 */
export const requestNotificationPermission = async (): Promise<boolean> => {
  const settings = await notifee.requestPermission();
  const granted = settings.authorizationStatus >= AuthorizationStatus.AUTHORIZED;
  console.log('[Notif] Permission status:', settings.authorizationStatus, 'granted:', granted);
  return granted;
};

/**
 * Creează două canale Android pentru notificări:
 *  - default: low/medium severity (notificare standard)
 *  - critical: high/critical severity (sunet de urgență + vibrație continuă)
 * Pe iOS canalele sunt ignorate (gestionate prin categories).
 */
export const initNotificationChannels = async (): Promise<void> => {
  if (channelsInitialized) return;

  if (Platform.OS === 'android') {
    await notifee.createChannel({
      id: CHANNEL_ID_DEFAULT,
      name: 'Alerte Safr',
      description: 'Notificări pentru alertele de urgență (severitate scăzută/medie)',
      importance: AndroidImportance.DEFAULT,
      visibility: AndroidVisibility.PUBLIC,
      sound: 'default',
      vibration: true,
      vibrationPattern: [300, 500],
    });

    await notifee.createChannel({
      id: CHANNEL_ID_CRITICAL,
      name: 'Alerte critice Safr',
      description: 'Notificări pentru alertele de urgență cu severitate ridicată/critică',
      importance: AndroidImportance.HIGH,
      visibility: AndroidVisibility.PUBLIC,
      sound: 'default',
      vibration: true,
      vibrationPattern: [300, 500, 300, 500, 300, 500],
      bypassDnd: true,
    });
  }

  channelsInitialized = true;
};

/**
 * Afișează o notificare locală pentru o alertă.
 * Severitatea determină canalul Android (default vs critical) și pattern-ul de vibrație.
 */
export const showAlertNotification = async (alert: DisasterAlert): Promise<void> => {
  await initNotificationChannels();

  const typeLabel = ALERT_TYPE_LABELS[alert.type]?.label || alert.type;
  const severityLabel = ALERT_SEVERITY_LABELS[alert.severity]?.label || alert.severity;
  const icon = ALERT_TYPE_LABELS[alert.type]?.icon || '';

  const isCritical = alert.severity === 'high' || alert.severity === 'critical';
  const channelId = isCritical ? CHANNEL_ID_CRITICAL : CHANNEL_ID_DEFAULT;

  await notifee.displayNotification({
    id: alert.id, // ID unic = alert.id, permite cancel ulterior
    title: `${icon} Alertă ${typeLabel}`,
    body: `Severitate: ${severityLabel}\n${alert.message}`,
    data: {
      alertId: alert.id,
      lat: String(alert.lat),
      lng: String(alert.lng),
    },
    android: {
      channelId,
      smallIcon: 'ic_launcher', // Folosește icon-ul de default al app-ului
      pressAction: { id: 'default' },
      importance: isCritical ? AndroidImportance.HIGH : AndroidImportance.DEFAULT,
    },
    ios: {
      sound: 'default',
      critical: isCritical, // necesită entitlement special pentru a funcționa real
      interruptionLevel: isCritical ? 'timeSensitive' : 'active',
    },
  });
};

/**
 * Anulează o notificare existentă (ex: când alerta expiră sau e ștearsă).
 */
export const cancelAlertNotification = async (alertId: string): Promise<void> => {
  await notifee.cancelNotification(alertId);
};

/**
 * Înregistrează handler-i pentru tap pe notificare.
 * Returnează un unsubscribe pentru cleanup.
 *
 * onAlertTap: apelat cu alertId când userul atinge o notificare.
 */
export const registerNotificationHandlers = (
  onAlertTap: (alertId: string) => void,
): (() => void) => {
  // Foreground: când userul atinge o notificare cu app-ul deschis
  const unsubscribeForeground = notifee.onForegroundEvent(({ type, detail }) => {
    if (type === EventType.PRESS && detail.notification?.data?.alertId) {
      onAlertTap(String(detail.notification.data.alertId));
    }
  });

  return unsubscribeForeground;
};

/**
 * Background handler — trebuie înregistrat la module-level în index.js,
 * NU în React component, pentru a funcționa când app-ul e killed.
 * Vezi index.js pentru apel.
 */
export const backgroundEventHandler = async ({ type, detail }: any): Promise<void> => {
  if (type === EventType.PRESS && detail.notification?.data?.alertId) {
    // App-ul va porni și `getInitialNotification` va fi citită la mount
    console.log('[Notif] Background press for alert:', detail.notification.data.alertId);
  }
};

/**
 * Returnează alertId-ul notificării care a deschis app-ul (dacă există).
 * Apelat la mount-ul MapScreen pentru a face deep-link.
 */
export const getInitialAlertId = async (): Promise<string | null> => {
  const initialNotification = await notifee.getInitialNotification();
  if (initialNotification?.notification?.data?.alertId) {
    return String(initialNotification.notification.data.alertId);
  }
  return null;
};
