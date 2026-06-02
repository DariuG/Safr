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

// ── Deep-link orchestration ──
//
// Toate sursele de "tap pe notificare" (foreground / background / cold-start)
// converg într-un singur eveniment `alertFocus`. Listener-ii (App + MapScreen)
// se abonează independent: App-ul navighează la tab-ul Map, MapScreen
// centrează camera. Dacă tap-ul vine înainte de mount-ul listener-ilor
// (cold start), focus-ul e ținut într-o variabilă pending și livrat la
// primul subscribe.

export type AlertFocus = {
  alertId: string;
  lat?: number;
  lng?: number;
};

let pendingFocus: AlertFocus | null = null;
const focusListeners = new Set<(focus: AlertFocus) => void>();

export const extractAlertFocus = (data: any): AlertFocus | null => {
  if (!data?.alertId) return null;
  return {
    alertId: String(data.alertId),
    lat: data.lat ? parseFloat(String(data.lat)) : undefined,
    lng: data.lng ? parseFloat(String(data.lng)) : undefined,
  };
};

const emitAlertFocus = (focus: AlertFocus) => {
  if (focusListeners.size > 0) {
    focusListeners.forEach(l => l(focus));
  } else {
    // Niciun listener încă (cold start) — stochează pentru primul subscribe
    pendingFocus = focus;
  }
};

/**
 * Abonare la evenimente de tap pe notificare. Apelat de App.tsx (pentru
 * navigare) și de MapScreen (pentru centrarea camerei). La subscribe,
 * orice focus pending e livrat imediat.
 */
export const subscribeAlertFocus = (
  handler: (focus: AlertFocus) => void,
): (() => void) => {
  focusListeners.add(handler);
  if (pendingFocus) {
    const f = pendingFocus;
    pendingFocus = null;
    handler(f);
  }
  return () => {
    focusListeners.delete(handler);
  };
};

/**
 * Înregistrează handler-ul pentru tap-uri în foreground.
 * Apelat la nivel global de App.tsx, nu de ecrane individuale.
 */
export const registerForegroundTapHandler = (): (() => void) => {
  return notifee.onForegroundEvent(({ type, detail }) => {
    if (type === EventType.PRESS) {
      const focus = extractAlertFocus(detail.notification?.data);
      if (focus) emitAlertFocus(focus);
    }
  });
};

/**
 * Verifică dacă app-ul a fost deschis dintr-o notificare (cold start).
 * Apelat de App.tsx după mount.
 */
export const checkInitialNotification = async (): Promise<void> => {
  const initial = await notifee.getInitialNotification();
  if (initial?.notification?.data) {
    const focus = extractAlertFocus(initial.notification.data);
    if (focus) emitAlertFocus(focus);
  }
};

/**
 * Background handler — înregistrat la module-level în index.js.
 * Setează focus-ul pending; livrarea se face când app-ul revine în foreground
 * și listener-ii se abonează / sunt deja abonați.
 */
export const backgroundEventHandler = async ({ type, detail }: any): Promise<void> => {
  if (type === EventType.PRESS) {
    const focus = extractAlertFocus(detail.notification?.data);
    if (focus) {
      console.log('[Notif] Background press for alert:', focus.alertId);
      emitAlertFocus(focus);
    }
  }
};
