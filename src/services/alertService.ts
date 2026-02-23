import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  getDocs,
  onSnapshot,
  serverTimestamp,
} from '@react-native-firebase/firestore';

// Alert types
export type AlertType = 'earthquake' | 'flood' | 'fire' | 'storm' | 'war' | 'other';
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface DisasterAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  lat: number;
  lng: number;
  radius: number; // in kilometers
  message: string;
  timestamp: number;
  createdAt: number;
  expiresAt: number;
  isActive: boolean;
  createdBy: string;
}

// Alert type labels (Romanian)
export const ALERT_TYPE_LABELS: Record<AlertType, { label: string; icon: string; color: string }> = {
  earthquake: { label: 'Cutremur', icon: '🏚️', color: '#8B4513' },
  flood: { label: 'Inundație', icon: '🌊', color: '#1E90FF' },
  fire: { label: 'Incendiu', icon: '🔥', color: '#FF4500' },
  storm: { label: 'Furtună', icon: '⛈️', color: '#4B0082' },
  war: { label: 'Război', icon: '💣', color: '#4A4A4A' },
  other: { label: 'Altele', icon: '⚠️', color: '#FFD700' },
};

// Severity labels (Romanian)
export const ALERT_SEVERITY_LABELS: Record<AlertSeverity, { label: string; color: string }> = {
  low: { label: 'Scăzut', color: '#22C55E' },
  medium: { label: 'Mediu', color: '#F59E0B' },
  high: { label: 'Ridicat', color: '#EF4444' },
  critical: { label: 'Critic', color: '#7C2D12' },
};

const ALERTS_COLLECTION = 'alerts';

// Get Firestore instance
const db = getFirestore();

/**
 * Create a new disaster alert
 */
export const createAlert = async (
  alertData: Omit<DisasterAlert, 'id' | 'createdAt' | 'isActive'>
): Promise<string> => {
  try {
    const alertsRef = collection(db, ALERTS_COLLECTION);
    const docRef = await addDoc(alertsRef, {
      ...alertData,
      createdAt: serverTimestamp(),
      isActive: true,
    });

    console.log('[AlertService] Alert created with ID:', docRef.id);
    return docRef.id;
  } catch (error) {
    console.error('[AlertService] Error creating alert:', error);
    throw error;
  }
};

/**
 * Get all active alerts
 */
export const getActiveAlerts = async (): Promise<DisasterAlert[]> => {
  try {
    const alertsRef = collection(db, ALERTS_COLLECTION);
    const q = query(
      alertsRef,
      where('isActive', '==', true),
      where('expiresAt', '>', Date.now()),
      orderBy('expiresAt'),
      orderBy('createdAt', 'desc')
    );

    const snapshot = await getDocs(q);

    const alerts: DisasterAlert[] = snapshot.docs.map((docSnap: any) => {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        ...data,
        createdAt: data.createdAt?.toMillis?.() || Date.now(),
      } as DisasterAlert;
    });

    console.log('[AlertService] Fetched', alerts.length, 'active alerts');
    return alerts;
  } catch (error) {
    console.error('[AlertService] Error fetching alerts:', error);
    throw error;
  }
};

/**
 * Subscribe to real-time alert updates
 */
export const subscribeToAlerts = (
  onAlertsUpdate: (alerts: DisasterAlert[]) => void,
  onError?: (error: Error) => void
): (() => void) => {
  const alertsRef = collection(db, ALERTS_COLLECTION);
  const q = query(alertsRef, where('isActive', '==', true));

  const unsubscribe = onSnapshot(
    q,
    snapshot => {
      const alerts: DisasterAlert[] = snapshot.docs
        .map((docSnap: any) => {
          const data = docSnap.data();
          return {
            id: docSnap.id,
            ...data,
            createdAt: data.createdAt?.toMillis?.() || Date.now(),
          } as DisasterAlert;
        })
        .filter((alert: DisasterAlert) => alert.expiresAt > Date.now())
        .sort((a: DisasterAlert, b: DisasterAlert) => b.createdAt - a.createdAt);

      console.log('[AlertService] Real-time update:', alerts.length, 'active alerts');
      onAlertsUpdate(alerts);
    },
    error => {
      console.error('[AlertService] Subscription error:', error);
      onError?.(error);
    }
  );

  return unsubscribe;
};

/**
 * Deactivate an alert
 */
export const deactivateAlert = async (alertId: string): Promise<void> => {
  try {
    const alertRef = doc(db, ALERTS_COLLECTION, alertId);
    await updateDoc(alertRef, {
      isActive: false,
    });
    console.log('[AlertService] Alert deactivated:', alertId);
  } catch (error) {
    console.error('[AlertService] Error deactivating alert:', error);
    throw error;
  }
};

/**
 * Delete an alert permanently
 */
export const deleteAlert = async (alertId: string): Promise<void> => {
  try {
    const alertRef = doc(db, ALERTS_COLLECTION, alertId);
    await deleteDoc(alertRef);
    console.log('[AlertService] Alert deleted:', alertId);
  } catch (error) {
    console.error('[AlertService] Error deleting alert:', error);
    throw error;
  }
};

/**
 * Generate a unique alert ID (for BLE mesh later)
 */
export const generateAlertId = (): string => {
  return `alert_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
};
