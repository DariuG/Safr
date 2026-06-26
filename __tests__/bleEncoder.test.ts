import {
  encodeCompactAlert,
  decodeCompactAlert,
  hashAlertId,
  encodeTimestamp,
  decodeTimestamp,
  encodeCoordinate,
  decodeCoordinate,
  encodeFullAlert,
  decodeFullAlert,
  serializeFullAlert,
  deserializeFullAlert,
  alertToCompact,
  uint8ArrayToBase64,
  base64ToUint8Array,
  COMPACT_ALERT_SIZE,
  CompactAlert,
} from '../src/services/bleEncoder';
import {DisasterAlert} from '../src/services/alertService';

// =============================================================================
// CompactAlert encode/decode (20 bytes)
// =============================================================================

describe('CompactAlert encoding/decoding', () => {
  const sampleAlert: CompactAlert = {
    alertType: 'fire',
    severity: 'high',
    lat: 45.7489,
    lng: 21.2087,
    radius: 2,
    alertIdHash: 123456789,
    timestamp: encodeTimestamp(1707753600000),
  };

  test('encoded output has exactly 20 bytes', () => {
    const encoded = encodeCompactAlert(sampleAlert);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBe(COMPACT_ALERT_SIZE);
  });

  test('decode(encode(alert)) returns original values', () => {
    const encoded = encodeCompactAlert(sampleAlert);
    const decoded = decodeCompactAlert(encoded);

    expect(decoded.alertType).toBe(sampleAlert.alertType);
    expect(decoded.severity).toBe(sampleAlert.severity);
    expect(decoded.lat).toBeCloseTo(sampleAlert.lat, 5);
    expect(decoded.lng).toBeCloseTo(sampleAlert.lng, 5);
    expect(decoded.radius).toBe(sampleAlert.radius);
    expect(decoded.alertIdHash).toBe(sampleAlert.alertIdHash);
    expect(decoded.timestamp).toBe(sampleAlert.timestamp);
  });

  test('all alert types encode/decode correctly', () => {
    const types = ['earthquake', 'flood', 'fire', 'storm', 'war', 'other'] as const;

    for (const type of types) {
      const alert: CompactAlert = {...sampleAlert, alertType: type};
      const decoded = decodeCompactAlert(encodeCompactAlert(alert));
      expect(decoded.alertType).toBe(type);
    }
  });

  test('all severity levels encode/decode correctly', () => {
    const severities = ['low', 'medium', 'high', 'critical'] as const;

    for (const severity of severities) {
      const alert: CompactAlert = {...sampleAlert, severity};
      const decoded = decodeCompactAlert(encodeCompactAlert(alert));
      expect(decoded.severity).toBe(severity);
    }
  });

  test('negative coordinates encode/decode correctly', () => {
    const alert: CompactAlert = {
      ...sampleAlert,
      lat: -33.8688,  // Sydney
      lng: -151.2093,
    };
    const decoded = decodeCompactAlert(encodeCompactAlert(alert));
    expect(decoded.lat).toBeCloseTo(-33.8688, 5);
    expect(decoded.lng).toBeCloseTo(-151.2093, 5);
  });

  test('large radius encodes correctly', () => {
    const alert: CompactAlert = {...sampleAlert, radius: 500};
    const decoded = decodeCompactAlert(encodeCompactAlert(alert));
    expect(decoded.radius).toBe(500);
  });

  test('throws on invalid data size', () => {
    expect(() => decodeCompactAlert(new Uint8Array(10))).toThrow();
  });
});

// =============================================================================
// Coordinate encoding
// =============================================================================

describe('Coordinate encoding', () => {
  test('encodes with ~0.1m precision', () => {
    expect(encodeCoordinate(45.7489)).toBe(45748900);
    expect(encodeCoordinate(-33.8688)).toBe(-33868800);
    expect(encodeCoordinate(0)).toBe(0);
  });

  test('decode reverses encode', () => {
    const coords = [45.7489, -33.8688, 0, 90, -90, 180, -180];
    for (const coord of coords) {
      expect(decodeCoordinate(encodeCoordinate(coord))).toBeCloseTo(coord, 5);
    }
  });
});

// =============================================================================
// Timestamp encoding
// =============================================================================

describe('Timestamp encoding', () => {
  test('encodes ms to minutes', () => {
    // 1707753600000 ms = 28462560 minutes
    expect(encodeTimestamp(1707753600000)).toBe(28462560);
  });

  test('decode gives back approximate timestamp (minute precision)', () => {
    const now = Date.now();
    const encoded = encodeTimestamp(now);
    const decoded = decodeTimestamp(encoded);
    // Should be within 1 minute of original
    expect(Math.abs(decoded - now)).toBeLessThan(60000);
  });
});

// =============================================================================
// Alert ID hashing (CRC32)
// =============================================================================

describe('hashAlertId', () => {
  test('same ID produces same hash', () => {
    const hash1 = hashAlertId('alert_123_abc');
    const hash2 = hashAlertId('alert_123_abc');
    expect(hash1).toBe(hash2);
  });

  test('different IDs produce different hashes', () => {
    const hash1 = hashAlertId('alert_123_abc');
    const hash2 = hashAlertId('alert_456_def');
    expect(hash1).not.toBe(hash2);
  });

  test('returns a number (int32)', () => {
    const hash = hashAlertId('test');
    expect(typeof hash).toBe('number');
    expect(Number.isInteger(hash)).toBe(true);
  });
});

// =============================================================================
// FullAlertPayload encode/decode (JSON for GATT)
// =============================================================================

describe('FullAlertPayload encoding/decoding', () => {
  const sampleDisasterAlert: DisasterAlert = {
    id: 'alert_1707753600_abc123',
    type: 'fire',
    severity: 'high',
    lat: 45.7489,
    lng: 21.2087,
    radius: 2,
    message: 'Incendiu activ în zona industrială',
    timestamp: 1707753600000,
    createdAt: 1707753600000,
    expiresAt: 1707840000000,
    isActive: true,
    createdBy: 'admin_uid',
  };

  test('encodeFullAlert produces correct short keys', () => {
    const payload = encodeFullAlert(sampleDisasterAlert, 10);

    expect(payload.id).toBe(sampleDisasterAlert.id);
    expect(payload.t).toBe('fire');
    expect(payload.s).toBe('high');
    expect(payload.la).toBe(45.7489);
    expect(payload.ln).toBe(21.2087);
    expect(payload.r).toBe(2);
    expect(payload.m).toBe('Incendiu activ în zona industrială');
    expect(payload.ts).toBe(1707753600000);
    expect(payload.ex).toBe(1707840000000);
    expect(payload.ttl).toBe(10);
  });

  test('decodeFullAlert restores DisasterAlert', () => {
    const payload = encodeFullAlert(sampleDisasterAlert, 8);
    const restored = decodeFullAlert(payload);

    expect(restored.id).toBe(sampleDisasterAlert.id);
    expect(restored.type).toBe(sampleDisasterAlert.type);
    expect(restored.severity).toBe(sampleDisasterAlert.severity);
    expect(restored.lat).toBe(sampleDisasterAlert.lat);
    expect(restored.lng).toBe(sampleDisasterAlert.lng);
    expect(restored.radius).toBe(sampleDisasterAlert.radius);
    expect(restored.message).toBe(sampleDisasterAlert.message);
    expect(restored.isActive).toBe(true);
    expect(restored.createdBy).toBe('ble_mesh');
    expect(restored.ttl).toBe(8);
  });

  test('JSON serialization stays under 512 bytes', () => {
    const payload = encodeFullAlert(sampleDisasterAlert, 10);
    const json = serializeFullAlert(payload);
    const byteLength = new TextEncoder().encode(json).length;

    expect(byteLength).toBeLessThan(512);
  });

  test('serialize/deserialize roundtrip preserves data', () => {
    const payload = encodeFullAlert(sampleDisasterAlert, 5);
    const json = serializeFullAlert(payload);
    const restored = deserializeFullAlert(json);

    expect(restored).toEqual(payload);
  });
});

// =============================================================================
// alertToCompact (DisasterAlert → CompactAlert)
// =============================================================================

describe('alertToCompact', () => {
  test('converts DisasterAlert to CompactAlert', () => {
    const alert: DisasterAlert = {
      id: 'test_alert_id',
      type: 'earthquake',
      severity: 'critical',
      lat: 46.0,
      lng: 25.0,
      radius: 10,
      message: 'Test',
      timestamp: 1707753600000,
      createdAt: 1707753600000,
      expiresAt: 1707840000000,
      isActive: true,
      createdBy: 'admin',
    };

    const compact = alertToCompact(alert);

    expect(compact.alertType).toBe('earthquake');
    expect(compact.severity).toBe('critical');
    expect(compact.lat).toBe(46.0);
    expect(compact.lng).toBe(25.0);
    expect(compact.radius).toBe(10);
    expect(compact.alertIdHash).toBe(hashAlertId('test_alert_id'));
    expect(compact.timestamp).toBe(encodeTimestamp(1707753600000));
  });
});

// =============================================================================
// Base64 helpers
// =============================================================================

describe('Base64 helpers', () => {
  test('roundtrip: bytes → base64 → bytes', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255, 42, 99]);
    const base64 = uint8ArrayToBase64(original);
    const restored = base64ToUint8Array(base64);

    expect(restored).toEqual(original);
  });

  test('works with compact alert bytes', () => {
    const alert: CompactAlert = {
      alertType: 'flood',
      severity: 'medium',
      lat: 44.4268,
      lng: 26.1025,
      radius: 5,
      alertIdHash: 987654321,
      timestamp: encodeTimestamp(Date.now()),
    };

    const encoded = encodeCompactAlert(alert);
    const base64 = uint8ArrayToBase64(encoded);
    const restored = base64ToUint8Array(base64);
    const decoded = decodeCompactAlert(restored);

    expect(decoded.alertType).toBe('flood');
    expect(decoded.severity).toBe('medium');
    expect(decoded.lat).toBeCloseTo(44.4268, 5);
  });

  test('empty array roundtrip', () => {
    const original = new Uint8Array([]);
    const base64 = uint8ArrayToBase64(original);
    const restored = base64ToUint8Array(base64);
    expect(restored.length).toBe(0);
  });
});
