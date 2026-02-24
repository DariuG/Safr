/**
 * Alert Deduplicator for BLE Mesh.
 *
 * Maintains a seen-set of alert ID hashes to prevent processing
 * the same alert multiple times as it propagates through the mesh.
 *
 * Uses CRC32 hashes (from bleEncoder.hashAlertId) as keys.
 * Entries expire after EXPIRY_MS (1 hour) to allow re-processing
 * of alerts that have been updated.
 */

const EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL = 100; // Run cleanup every N additions

export class AlertDeduplicator {
  private seenAlerts: Map<number, number> = new Map(); // alertIdHash -> timestamp (ms)
  private addCount: number = 0;

  /**
   * Check if an alert should be processed (i.e., hasn't been seen recently).
   * If it's new, marks it as seen and returns true.
   * If it's a duplicate, returns false.
   */
  shouldProcess(alertIdHash: number): boolean {
    const now = Date.now();

    // Check if already seen and not expired
    const seenAt = this.seenAlerts.get(alertIdHash);
    if (seenAt !== undefined && now - seenAt < EXPIRY_MS) {
      return false; // Duplicate
    }

    // Mark as seen
    this.seenAlerts.set(alertIdHash, now);
    this.addCount++;

    // Periodic cleanup
    if (this.addCount % CLEANUP_INTERVAL === 0) {
      this.cleanup();
    }

    return true; // New alert
  }

  /**
   * Check if an alert has been seen without marking it.
   */
  hasSeen(alertIdHash: number): boolean {
    const seenAt = this.seenAlerts.get(alertIdHash);
    if (seenAt === undefined) {
      return false;
    }
    return Date.now() - seenAt < EXPIRY_MS;
  }

  /**
   * Manually mark an alert as seen (e.g., alerts received from Firebase).
   */
  markSeen(alertIdHash: number): void {
    this.seenAlerts.set(alertIdHash, Date.now());
  }

  /**
   * Remove expired entries from the seen-set.
   */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [hash, timestamp] of this.seenAlerts) {
      if (now - timestamp >= EXPIRY_MS) {
        this.seenAlerts.delete(hash);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(
        `[BLE:DEDUP] Cleanup: removed ${removed} expired entries, ${this.seenAlerts.size} remaining`,
      );
    }
  }

  /**
   * Get the number of alerts currently in the seen-set.
   */
  get size(): number {
    return this.seenAlerts.size;
  }

  /**
   * Clear all seen alerts (e.g., on mesh restart).
   */
  clear(): void {
    this.seenAlerts.clear();
    this.addCount = 0;
    console.log('[BLE:DEDUP] Seen-set cleared');
  }
}
