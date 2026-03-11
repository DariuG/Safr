/**
 * BLE Encoder/Decoder for compact alert transmission over BLE advertising
 * and full alert JSON for GATT characteristic reads.
 *
 * Compact Alert: 20 bytes for BLE advertising manufacturer data
 * Full Alert: JSON with short keys for GATT transfer (max 512 bytes)
 */

import CRC32 from 'crc-32';
import {AlertType, AlertSeverity, DisasterAlert} from './alertService';

// --- Constants ---

export const SAFR_SERVICE_UUID = '00005AFE-0000-1000-8000-00805F9B34FB';
export const ALERT_CHARACTERISTIC_UUID = '0000A1E1-0000-1000-8000-00805F9B34FB';
export const BLE_COMPANY_ID = 0xffff; // Test/dev company ID
export const COMPACT_ALERT_SIZE = 20;

// --- Enum Mappings ---

const ALERT_TYPE_TO_INT: Record<AlertType, number> = {
  earthquake: 0,
  flood: 1,
  fire: 2,
  storm: 3,
  war: 4,
  other: 5,
};

const INT_TO_ALERT_TYPE: Record<number, AlertType> = {
  0: 'earthquake',
  1: 'flood',
  2: 'fire',
  3: 'storm',
  4: 'war',
  5: 'other',
};

const SEVERITY_TO_INT: Record<AlertSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const INT_TO_SEVERITY: Record<number, AlertSeverity> = {
  0: 'low',
  1: 'medium',
  2: 'high',
  3: 'critical',
};

// --- Compact Alert (20 bytes) ---

/**
 * Compact alert structure for BLE advertising manufacturer data.
 * Contains enough info for quick filtering + deduplication.
 */
export interface CompactAlert {
  alertType: AlertType;
  severity: AlertSeverity;
  lat: number;
  lng: number;
  radius: number; // km
  alertIdHash: number; // CRC32 of alert ID
  timestamp: number; // minutes since epoch
}

/**
 * Encode a compact alert into a 20-byte Uint8Array.
 *
 * Byte layout:
 * [0]     alertType    (uint8)
 * [1]     severity     (uint8)
 * [2-5]   latitude     (int32, x1e6)
 * [6-9]   longitude    (int32, x1e6)
 * [10-11] radius       (uint16, km)
 * [12-15] alertIdHash  (int32, CRC32)
 * [16-19] timestamp    (uint32, minutes since epoch)
 */
export function encodeCompactAlert(alert: CompactAlert): Uint8Array {
  const buffer = new ArrayBuffer(COMPACT_ALERT_SIZE);
  const view = new DataView(buffer);

  view.setUint8(0, ALERT_TYPE_TO_INT[alert.alertType] ?? 5);
  view.setUint8(1, SEVERITY_TO_INT[alert.severity] ?? 0);
  view.setInt32(2, Math.round(alert.lat * 1e6), false); // big-endian
  view.setInt32(6, Math.round(alert.lng * 1e6), false);
  view.setUint16(10, Math.min(alert.radius, 65535), false);
  view.setInt32(12, alert.alertIdHash, false);
  view.setUint32(16, alert.timestamp, false);

  return new Uint8Array(buffer);
}

/**
 * Decode a 20-byte Uint8Array back into a CompactAlert.
 */
export function decodeCompactAlert(data: Uint8Array): CompactAlert {
  if (data.length < COMPACT_ALERT_SIZE) {
    throw new Error(
      `[BLE:ENCODE] Invalid compact alert size: ${data.length}, expected ${COMPACT_ALERT_SIZE}`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const typeInt = view.getUint8(0);
  const severityInt = view.getUint8(1);

  return {
    alertType: INT_TO_ALERT_TYPE[typeInt] ?? 'other',
    severity: INT_TO_SEVERITY[severityInt] ?? 'low',
    lat: view.getInt32(2, false) / 1e6,
    lng: view.getInt32(6, false) / 1e6,
    radius: view.getUint16(10, false),
    alertIdHash: view.getInt32(12, false),
    timestamp: view.getUint32(16, false),
  };
}

// --- Alert ID Hashing ---

/**
 * Generate a CRC32 hash of an alert ID string.
 * Used for compact deduplication in advertising packets.
 */
export function hashAlertId(alertId: string): number {
  return CRC32.str(alertId);
}

// --- Coordinate Encoding ---

/**
 * Encode a coordinate (lat/lng) as int32 with ~0.1m precision.
 */
export function encodeCoordinate(coord: number): number {
  return Math.round(coord * 1e6);
}

/**
 * Decode a coordinate from int32 back to float.
 */
export function decodeCoordinate(encoded: number): number {
  return encoded / 1e6;
}

// --- Timestamp Encoding ---

/**
 * Encode a timestamp (ms since epoch) to minutes since epoch (uint32).
 */
export function encodeTimestamp(timestampMs: number): number {
  return Math.floor(timestampMs / 60000);
}

/**
 * Decode minutes since epoch back to milliseconds.
 */
export function decodeTimestamp(minutesSinceEpoch: number): number {
  return minutesSinceEpoch * 60000;
}

// --- Full Alert JSON (for GATT transfer) ---

/**
 * Compact JSON representation of a full alert for GATT characteristic.
 * Uses short keys to minimize size (target: <512 bytes).
 */
export interface FullAlertPayload {
  id: string;
  t: string; // type
  s: string; // severity
  la: number; // latitude
  ln: number; // longitude
  r: number; // radius km
  m: string; // message
  ts: number; // timestamp ms
  ex: number; // expiresAt ms
  ttl: number; // time-to-live hops
  sig?: string; // HMAC signature (optional for now)
}

/**
 * Convert a DisasterAlert + TTL into a compact JSON payload for GATT transfer.
 */
export function encodeFullAlert(
  alert: DisasterAlert,
  ttl: number = 10,
): FullAlertPayload {
  return {
    id: alert.id,
    t: alert.type,
    s: alert.severity,
    la: alert.lat,
    ln: alert.lng,
    r: alert.radius,
    m: alert.message,
    ts: alert.timestamp,
    ex: alert.expiresAt,
    ttl,
  };
}

/**
 * Convert a GATT JSON payload back into a DisasterAlert.
 */
export function decodeFullAlert(payload: FullAlertPayload): DisasterAlert & {ttl: number} {
  return {
    id: payload.id,
    type: payload.t as AlertType,
    severity: payload.s as AlertSeverity,
    lat: payload.la,
    lng: payload.ln,
    radius: payload.r,
    message: payload.m,
    timestamp: payload.ts,
    createdAt: payload.ts,
    expiresAt: payload.ex,
    isActive: true,
    createdBy: 'ble_mesh',
    ttl: payload.ttl,
  };
}

/**
 * Serialize a full alert payload to a JSON string for GATT characteristic value.
 */
export function serializeFullAlert(payload: FullAlertPayload): string {
  return JSON.stringify(payload);
}

/**
 * Deserialize a JSON string from GATT characteristic value to a full alert payload.
 */
export function deserializeFullAlert(json: string): FullAlertPayload {
  return JSON.parse(json) as FullAlertPayload;
}

// --- DisasterAlert <-> CompactAlert conversion ---

/**
 * Convert a DisasterAlert to a CompactAlert for BLE advertising.
 */
export function alertToCompact(alert: DisasterAlert): CompactAlert {
  return {
    alertType: alert.type,
    severity: alert.severity,
    lat: alert.lat,
    lng: alert.lng,
    radius: alert.radius,
    alertIdHash: hashAlertId(alert.id),
    timestamp: encodeTimestamp(alert.timestamp),
  };
}

// --- Base64 helpers for BLE data transfer ---
// btoa/atob are available globally in Hermes (RN 0.82+)

/**
 * Encode a Uint8Array to base64 string (for BLE characteristic values).
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string to Uint8Array (for BLE characteristic values).
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
