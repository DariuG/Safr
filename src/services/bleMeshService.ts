/**
 * BLE Mesh Service - Orchestrează comunicarea mesh BLE pentru propagarea alertelor.
 *
 * Acesta e fișierul central care leagă toate componentele:
 * - bleEncoder.ts (encodare/decodare date)
 * - bleDeduplicator.ts (filtrare duplicate)
 * - BleAdvertiserModule (modul nativ iOS - advertising + GATT server)
 * - react-native-ble-plx (scanning + GATT client)
 * - alertService.ts (alerte Firebase)
 *
 * FLOW PRINCIPAL:
 *
 * [Telefon A - are internet]
 * Firebase → alertService → bleMeshService.broadcastAlert(alert)
 *   → Encodează alert → Trimite la BleAdvertiserModule → Advertising BLE
 *
 * [Telefon B - fără internet, scanează]
 * bleMeshService.startScanning()
 *   → react-native-ble-plx descoperă advertising cu SAFR UUID
 *   → Verifică deduplicator: alertă nouă?
 *   → DA → Conectare GATT → Citire alertă completă (JSON)
 *   → Deconectare → Notifică UI → Relay (TTL-1)
 */

import {NativeModules, Platform} from 'react-native';
import {BleManager, Device, State, Subscription} from 'react-native-ble-plx';
import NetInfo, {NetInfoState} from '@react-native-community/netinfo';
import {DisasterAlert} from './alertService';
import {AlertDeduplicator} from './bleDeduplicator';
import {
  SAFR_SERVICE_UUID,
  ALERT_CHARACTERISTIC_UUID,
  alertToCompact,
  encodeCompactAlert,
  encodeFullAlert,
  decodeFullAlert,
  serializeFullAlert,
  deserializeFullAlert,
  hashAlertId,
  uint8ArrayToBase64,
  base64ToUint8Array,
  FullAlertPayload,
} from './bleEncoder';

// =============================================================================
// SECȚIUNEA 1: Constante și Tipuri
// =============================================================================
//
// Parametri configurabili ai mesh-ului. Separați aici pentru ușurință în tuning.

/** TTL inițial: câte "hopuri" poate face o alertă prin mesh.
 *  10 hops × ~30-100m rază BLE = 300m-1km acoperire. */
const INITIAL_TTL = 10;

/** Interval rotație alerte: dacă avem 3 alerte active, le advertisăm pe rând,
 *  câte 10 secunde fiecare. Un scanner care ascultă 30s le prinde pe toate. */
const ROTATION_INTERVAL_MS = 10000;

/** Timeout conexiune GATT: dacă nu reușim să citim alerta în 5s,
 *  renunțăm (dispozitivul a ieșit din rază sau e ocupat). */
const GATT_CONNECTION_TIMEOUT_MS = 5000;

/** Câte retry-uri la GATT connection failure. */
const GATT_MAX_RETRIES = 2;

/** Delay între retry-uri GATT (exponential: 1s, 2s). */
const GATT_RETRY_BASE_DELAY_MS = 1000;

// Referință la modulul nativ iOS (BleAdvertiserModule.swift)
// NativeModules expune toate modulele native înregistrate prin bridge.
const {BleAdvertiserModule} = NativeModules;

// =============================================================================
// SECȚIUNEA 2: Interfețe și Callback-uri
// =============================================================================

/** Callback apelat când o alertă nouă e primită prin BLE mesh.
 *  MapScreen/UI-ul se înregistrează pe acest callback pentru a afișa alerta. */
type OnAlertReceived = (alert: DisasterAlert) => void;

/** Starea curentă a mesh-ului, expusă către UI. */
export interface MeshStatus {
  isRunning: boolean;
  isScanning: boolean;
  isAdvertising: boolean;
  devicesInRange: number;
  bluetoothState: string; // 'on' | 'off' | 'unauthorized' | 'unsupported' | 'unknown'
  activeAlertCount: number;
}

// =============================================================================
// SECȚIUNEA 3: Clasa principală BleMeshService
// =============================================================================

class BleMeshService {
  // --- Dependințe ---

  /** BleManager din react-native-ble-plx - folosit pentru scanning (descoperire
   *  dispozitive) și GATT client (citire date de la dispozitivele descoperite). */
  private bleManager: BleManager | null = null;

  /** Deduplicatorul - previne procesarea aceleiași alerte de mai multe ori.
   *  Fără el, dacă 3 telefoane din jur emit aceeași alertă, am procesa-o de 3 ori. */
  private deduplicator: AlertDeduplicator;

  // --- Stare internă ---

  /** Flag: mesh-ul e pornit? Controlat de startMesh/stopMesh. */
  private isRunning = false;

  /** Flag: scanarea e activă? */
  private isScanning = false;

  /** Flag: advertising-ul e activ? */
  private isAdvertising = false;

  /** Alertele pe care le advertisăm (primite din Firebase sau din mesh).
   *  Fiecare alertă are asociat un TTL. */
  private alertsToAdvertise: Map<string, {alert: DisasterAlert; ttl: number}> =
    new Map();

  /** Index-ul alertei curente în rotație.
   *  Dacă avem 3 alerte, rotăm: 0→1→2→0→1→2... */
  private rotationIndex = 0;

  /** Timer-ul pentru rotația alertelor. */
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  /** Set de device ID-uri descoperite recent (pentru numărare "devices in range"). */
  private devicesInRange: Set<string> = new Set();

  /** Subscription la schimbările de stare Bluetooth (on/off). */
  private stateSubscription: Subscription | null = null;

  /** Callback-ul înregistrat de UI pentru a primi alerte noi. */
  private onAlertReceived: OnAlertReceived | null = null;

  /** Flag: în curs de procesare GATT? Previne conexiuni simultane
   *  (iOS suportă câteva, dar e mai stabil cu una singură la un moment dat). */
  private isProcessingGatt = false;

  /** Coadă de dispozitive de procesat (dacă descoperim mai multe în timp ce
   *  procesăm una, le punem în coadă). */
  private gattQueue: Device[] = [];

  /** Unsubscribe de la NetInfo (network monitoring). */
  private netInfoUnsubscribe: (() => void) | null = null;

  /** Starea curentă a conexiunii la internet. */
  private hasInternet = true;

  /** Flag: modul auto e activ? (mesh pornește/oprește automat pe baza conexiunii). */
  private autoModeEnabled = false;

  /** Callback-uri înregistrate de UI pentru schimbări de stare mesh. */
  private onStatusChange: ((status: MeshStatus) => void) | null = null;

  /** Timer periodic pentru status update (asigură că UI-ul e mereu actualizat). */
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  // -------------------------------------------------------------------------
  // MARK: Constructor
  // -------------------------------------------------------------------------

  constructor() {
    this.deduplicator = new AlertDeduplicator();
  }

  private getBleManager(): BleManager {
    if (!this.bleManager) {
      this.bleManager = new BleManager();
    }
    return this.bleManager;
  }

  // =========================================================================
  // SECȚIUNEA 4: Metode publice (API-ul folosit de UI/alertService)
  // =========================================================================

  /**
   * Pornește mesh-ul BLE: inițializează modulul nativ, pornește scanarea.
   *
   * Apelat de UI (buton "Start Mesh") sau automat la pornirea app-ului.
   * După apel:
   * - Telefonul începe să scaneze pentru alte dispozitive SAFR
   * - Dacă are alerte de advertisat, pornește și advertising-ul
   */
  async startMesh(): Promise<void> {
    if (this.isRunning) {
      console.log('[BLE:MESH] Already running');
      return;
    }

    console.log('[BLE:MESH] Starting mesh...');

    try {
      // Pas 1: Inițializează modulul nativ (CBPeripheralManager pe iOS)
      await BleAdvertiserModule.initialize();
      console.log('[BLE:MESH] Native module initialized');

      this.isRunning = true;

      // Pas 2: Ascultă schimbările de stare Bluetooth (on/off) cu delay
      // Amânăm subscripția la BleManager pentru a nu interfera cu permisiunile
      setTimeout(() => {
        if (!this.isRunning) return;
        try {
          this.stateSubscription = this.getBleManager().onStateChange(state => {
            console.log('[BLE:MESH] Bluetooth state changed:', state);
            if (state === State.PoweredOn && this.isRunning && !this.isScanning) {
              this.startScanning();
            } else if (state === State.PoweredOff) {
              this.isScanning = false;
              this.isAdvertising = false;
            }
            this.notifyStatusChange();
          }, true);
        } catch (e: any) {
          console.warn('[BLE:MESH] Failed to subscribe to BLE state:', e.message);
        }
      }, 1000);

      // Notifică UI-ul după 2s (timp suficient ca BLE să raporteze starea)
      setTimeout(() => {
        this.notifyStatusChange();
      }, 2000);

      // Pas 3: Dacă avem deja alerte de advertisat, pornește advertising
      if (this.alertsToAdvertise.size > 0) {
        await this.startAdvertisingRotation();
      }

      console.log('[BLE:MESH] Mesh started successfully');
    } catch (error: any) {
      console.error('[BLE:MESH] Failed to start mesh:', error.message);
      this.isRunning = false;
    }
  }

  /**
   * Oprește mesh-ul complet: scanare, advertising, timere, cleanup.
   */
  async stopMesh(): Promise<void> {
    console.log('[BLE:MESH] Stopping mesh...');

    this.isRunning = false;

    // Oprește scanarea
    this.getBleManager().stopDeviceScan();
    this.isScanning = false;

    // Oprește advertising
    try {
      await BleAdvertiserModule.stopAdvertising();
    } catch (e) {
      // Ignoră eroarea dacă nu era pornit
    }
    this.isAdvertising = false;

    // Oprește rotația alertelor
    this.stopRotationTimer();

    // Curăță starea
    this.alertsToAdvertise.clear();
    this.devicesInRange.clear();
    this.gattQueue = [];
    this.isProcessingGatt = false;

    // Dezabonare de la starea Bluetooth
    this.stateSubscription?.remove();
    this.stateSubscription = null;

    // Cleanup modulul nativ
    try {
      await BleAdvertiserModule.cleanup();
    } catch (e) {
      // Ignoră
    }

    console.log('[BLE:MESH] Mesh stopped');
  }

  /**
   * Adaugă o alertă pentru broadcast BLE.
   *
   * Apelat din 2 locuri:
   * 1. alertService.ts - când primește alertă nouă din Firebase (telefonul are internet)
   * 2. Intern - când primește alertă prin BLE și vrea să o relay-eze (TTL > 0)
   *
   * @param alert - Alerta de broadcasted
   * @param ttl - Câte hopuri mai poate face (default: 10 pentru Firebase, decrementat pentru relay)
   */
  async broadcastAlert(
    alert: DisasterAlert,
    ttl: number = INITIAL_TTL,
  ): Promise<void> {
    const alertHash = hashAlertId(alert.id);

    // Marchează alerta ca "văzută" în deduplicator
    // Astfel, dacă o primim înapoi prin BLE de la alt telefon, o ignorăm
    this.deduplicator.markSeen(alertHash);

    // Adaugă în lista de alerte de advertisat
    this.alertsToAdvertise.set(alert.id, {alert, ttl});
    console.log(
      `[BLE:MESH] Broadcasting alert "${alert.id}" (TTL=${ttl}), total: ${this.alertsToAdvertise.size}`,
    );

    // Pornește advertising dacă mesh-ul e activ
    if (this.isRunning) {
      await this.startAdvertisingRotation();
    }
  }

  /**
   * Elimină o alertă din broadcast (expirată sau dezactivată).
   */
  async removeAlert(alertId: string): Promise<void> {
    this.alertsToAdvertise.delete(alertId);
    console.log(
      `[BLE:MESH] Removed alert "${alertId}", remaining: ${this.alertsToAdvertise.size}`,
    );

    if (this.alertsToAdvertise.size === 0) {
      // Nu mai avem alerte → oprește advertising
      try {
        await BleAdvertiserModule.stopAdvertising();
      } catch (e) {
        // Ignoră
      }
      this.isAdvertising = false;
      this.stopRotationTimer();
    }
  }

  /**
   * Înregistrează callback-ul pentru alerte primite prin BLE.
   * UI-ul (MapScreen) apelează asta pentru a fi notificat.
   */
  onAlert(callback: OnAlertReceived): void {
    this.onAlertReceived = callback;
  }

  /**
   * Înregistrează callback pentru schimbări de stare mesh (pentru UI badge).
   */
  onStatusChanged(callback: (status: MeshStatus) => void): void {
    this.onStatusChange = callback;
  }

  /**
   * Notifică UI-ul despre schimbarea stării mesh-ului.
   */
  private async notifyStatusChange(): Promise<void> {
    if (this.onStatusChange) {
      const status = await this.getStatus();
      this.onStatusChange(status);
    }
  }

  /**
   * Activează modul automat: mesh-ul pornește/oprește pe baza conexiunii la internet.
   *
   * - Cu internet: mesh-ul NU scanează (alertele vin din Firebase), dar
   *   ADVERTISEAZĂ alertele primite (pentru alții fără internet)
   * - Fără internet: mesh-ul pornește scanning-ul (primește alerte BLE)
   *   și advertisează ce a primit (relay)
   *
   * Apelat o singură dată la montarea MapScreen.
   */
  async enableAutoMode(): Promise<void> {
    if (this.autoModeEnabled) {
      return;
    }
    this.autoModeEnabled = true;

    console.log('[BLE:MESH] Auto mode enabled - monitoring network state');

    // Verifică starea curentă a rețelei
    const state = await NetInfo.fetch();
    this.hasInternet = !!(state.isConnected && state.isInternetReachable);

    // Pornește mesh-ul (indiferent de internet - trebuie să putem advertisa)
    await this.startMesh();

    // Monitorizează schimbările de conexiune
    this.netInfoUnsubscribe = NetInfo.addEventListener(
      (netState: NetInfoState) => {
        const hadInternet = this.hasInternet;
        this.hasInternet = !!(
          netState.isConnected && netState.isInternetReachable
        );

        if (hadInternet !== this.hasInternet) {
          console.log(
            `[BLE:MESH] Network changed: ${hadInternet ? 'online' : 'offline'} → ${this.hasInternet ? 'online' : 'offline'}`,
          );
          this.notifyStatusChange();
        }
      },
    );

    this.notifyStatusChange();

    // Status polling la fiecare 5s pentru a ține UI-ul sincronizat
    this.statusTimer = setInterval(() => {
      this.notifyStatusChange();
    }, 5000);
  }

  /**
   * Dezactivează modul automat și oprește mesh-ul.
   * Apelat la demontarea MapScreen.
   */
  async disableAutoMode(): Promise<void> {
    this.autoModeEnabled = false;

    // Oprește status polling
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }

    // Dezabonare de la NetInfo
    this.netInfoUnsubscribe?.();
    this.netInfoUnsubscribe = null;

    await this.stopMesh();
    console.log('[BLE:MESH] Auto mode disabled');
  }

  /**
   * Returnează starea curentă a mesh-ului (pentru UI indicator).
   */
  async getStatus(): Promise<MeshStatus> {
    let bluetoothState = 'unknown';
    try {
      bluetoothState = await BleAdvertiserModule.getBluetoothState();
    } catch (e) {
      // Modulul nativ nu e inițializat încă
    }

    return {
      isRunning: this.isRunning,
      isScanning: this.isScanning,
      isAdvertising: this.isAdvertising,
      devicesInRange: this.devicesInRange.size,
      bluetoothState,
      activeAlertCount: this.alertsToAdvertise.size,
    };
  }

  // =========================================================================
  // SECȚIUNEA 5: Scanning (descoperire dispozitive SAFR)
  // =========================================================================
  //
  // Scanarea folosește react-native-ble-plx (Central role).
  // Caută dispozitive care advertisază service UUID-ul SAFR.
  // Când găsește unul, verifică deduplicatorul și se conectează GATT pentru
  // a citi alerta completă.

  /**
   * Pornește scanarea BLE pentru dispozitive SAFR.
   *
   * Filtrăm pe SAFR_SERVICE_UUID:
   * - Eficient: hardware-ul BLE filtrează, nu primim alte dispozitive
   * - OBLIGATORIU pe iOS în background: fără UUID specific, scanarea nu merge
   *
   * allowDuplicates: false
   * - Primim un callback per dispozitiv unic (nu la fiecare advertising packet)
   * - Pe iOS în background, e mereu false indiferent de setare
   */
  private startScanning(): void {
    if (this.isScanning) {
      return;
    }

    console.log('[BLE:SCAN] Starting scan for SAFR devices...');

    try {
    this.getBleManager().startDeviceScan(
      [SAFR_SERVICE_UUID], // Filtru pe UUID - doar dispozitive SAFR
      {
        allowDuplicates: false,
      },
      (error, device) => {
        if (error) {
          console.error('[BLE:SCAN] Scan error:', error.message);
          // Nu oprim scanarea la erori tranzitorii
          return;
        }

        if (device) {
          this.handleDiscoveredDevice(device);
        }
      },
    );

    this.isScanning = true;
    } catch (err) {
      console.error('[BLE:SCAN] Failed to start scanning:', err);
    }
  }

  /**
   * Procesează un dispozitiv SAFR descoperit prin scanning.
   *
   * La descoperire, avem 2 opțiuni:
   *
   * A) Dispozitivul e în foreground pe iOS/Android:
   *    → manufacturer data e prezentă → parsăm compact alert
   *    → verificăm deduplicator cu alertIdHash
   *    → dacă e nouă → GATT connect → citim alerta completă
   *
   * B) Dispozitivul e în background pe iOS:
   *    → manufacturer data LIPSEȘTE (limitare iOS)
   *    → nu putem verifica deduplicatorul fără alertIdHash
   *    → trebuie să ne conectăm GATT oricum pentru a afla ce alertă are
   *
   * În ambele cazuri, ajungem la GATT connect. Diferența e că în cazul A
   * putem filtra duplicatele ÎNAINTE de conexiune (mai eficient energetic).
   */
  private handleDiscoveredDevice(device: Device): void {
    console.log(
      `[BLE:SCAN] Discovered device: ${device.id} (name: ${device.localName || 'unknown'})`,
    );

    // Tracking dispozitive în rază (pentru UI)
    this.devicesInRange.add(device.id);

    // Curăță dispozitivele vechi din "in range" la fiecare 30s
    // (dispozitivele care au ieșit din rază nu mai emit, dar rămân în set)
    setTimeout(() => this.devicesInRange.delete(device.id), 30000);

    // Adaugă în coada GATT pentru procesare
    this.enqueueGattRead(device);
  }

  // =========================================================================
  // SECȚIUNEA 6: GATT Client (citire alertă completă de la alt dispozitiv)
  // =========================================================================
  //
  // După ce descoperim un dispozitiv SAFR, ne conectăm la el pentru a citi
  // alerta completă (JSON) din GATT characteristic.
  //
  // Flow: Connect → Request MTU → Discover Services → Read Characteristic → Disconnect
  //
  // De ce o coadă? BLE suportă max ~7 conexiuni simultane (iOS e și mai strict).
  // Procesăm câte un dispozitiv la un moment dat pentru stabilitate.

  /**
   * Adaugă un dispozitiv în coada de procesare GATT.
   * Dacă nu se procesează nimic acum, pornește procesarea.
   */
  private enqueueGattRead(device: Device): void {
    this.gattQueue.push(device);

    if (!this.isProcessingGatt) {
      this.processGattQueue();
    }
  }

  /**
   * Procesează dispozitivele din coadă, unul câte unul.
   */
  private async processGattQueue(): Promise<void> {
    if (this.isProcessingGatt) {
      return;
    }
    this.isProcessingGatt = true;

    while (this.gattQueue.length > 0 && this.isRunning) {
      const device = this.gattQueue.shift()!;
      try {
        await this.readAlertFromDevice(device);
      } catch (error: any) {
        console.warn(
          `[BLE:GATT] Failed to read from ${device.id}: ${error.message}`,
        );
      }
    }

    this.isProcessingGatt = false;
  }

  /**
   * Se conectează GATT la un dispozitiv, citește alerta, se deconectează.
   *
   * Aceasta e operația cea mai complexă din mesh:
   * 1. Connect - stabilește link-ul BLE (handshake)
   * 2. Request MTU 512 - negociază dimensiunea maximă a pachetelor
   *    (default e 23 bytes, insuficient pentru JSON-ul alertei)
   * 3. Discover Services - descoperă ce servicii GATT oferă dispozitivul
   * 4. Read Characteristic - citește valoarea alertei (JSON base64)
   * 5. Disconnect - OBLIGATORIU, altfel blocăm slot-uri de conexiune
   *
   * Retry cu backoff exponențial la eșec (dispozitivul poate fi ocupat
   * sau la limita razei BLE).
   */
  private async readAlertFromDevice(
    device: Device,
    retryCount: number = 0,
  ): Promise<void> {
    let connectedDevice: Device | null = null;

    try {
      // Pas 1: Conectare cu timeout
      console.log(`[BLE:GATT] Connecting to ${device.id}...`);
      connectedDevice = await device.connect({
        timeout: GATT_CONNECTION_TIMEOUT_MS,
      });

      // Pas 2: Negociere MTU
      // MTU = Maximum Transmission Unit = câți bytes per pachet
      // Default: 23 bytes (20 utili). Cu requestMTU(512), negociem ~185-517 bytes.
      // Asta permite citirea alertei întregi într-un singur read (fără Long Read).
      if (Platform.OS === 'android') {
        // Pe iOS, MTU se negociază automat la conectare
        await connectedDevice.requestMTU(512);
      }

      // Pas 3: Descoperă serviciile GATT ale dispozitivului
      // Necesar înainte de a putea citi orice characteristic.
      await connectedDevice.discoverAllServicesAndCharacteristics();

      // Pas 4: Citește characteristic-ul de alertă
      // Valoarea vine ca string base64 (convenția react-native-ble-plx)
      const characteristic =
        await connectedDevice.readCharacteristicForService(
          SAFR_SERVICE_UUID,
          ALERT_CHARACTERISTIC_UUID,
        );

      // Pas 5: Deconectare IMEDIATĂ
      // IMPORTANT: nu lăsăm conexiunea deschisă - fiecare slot e prețios
      await connectedDevice.cancelConnection();
      connectedDevice = null;

      // Pas 6: Procesare date primite
      if (characteristic.value) {
        await this.processReceivedAlertData(characteristic.value);
      } else {
        console.warn(`[BLE:GATT] Empty characteristic value from ${device.id}`);
      }
    } catch (error: any) {
      // Asigură deconectarea la eroare
      if (connectedDevice) {
        try {
          await connectedDevice.cancelConnection();
        } catch (e) {
          // Ignoră erori la deconectare (poate deja deconectat)
        }
      }

      // Retry cu backoff exponențial
      if (retryCount < GATT_MAX_RETRIES) {
        const delay =
          GATT_RETRY_BASE_DELAY_MS * Math.pow(2, retryCount);
        console.log(
          `[BLE:GATT] Retry ${retryCount + 1}/${GATT_MAX_RETRIES} for ${device.id} in ${delay}ms`,
        );
        await new Promise<void>(r => setTimeout(r, delay));
        return this.readAlertFromDevice(device, retryCount + 1);
      }

      throw error;
    }
  }

  /**
   * Procesează datele alertei primite prin GATT.
   *
   * Datele vin ca base64 string (convenția BLE-plx).
   * Le decodăm: base64 → bytes → string → JSON → FullAlertPayload → DisasterAlert
   *
   * Apoi:
   * 1. Verifică deduplicator: am mai văzut această alertă?
   * 2. Verifică expirare: alerta mai e validă?
   * 3. Verifică TTL: mai poate fi relay-ată?
   * 4. Notifică UI-ul
   * 5. Relay: re-advertisează cu TTL decrementat
   */
  private async processReceivedAlertData(base64Value: string): Promise<void> {
    try {
      // Decodare: base64 → bytes → string (JSON)
      // Folosim String.fromCharCode în loc de TextDecoder (indisponibil în Hermes)
      const bytes = base64ToUint8Array(base64Value);
      const jsonString = Array.from(bytes)
        .map(b => String.fromCharCode(b))
        .join('');
      const payload: FullAlertPayload = deserializeFullAlert(jsonString);

      console.log(
        `[BLE:MESH] Received alert: id=${payload.id}, type=${payload.t}, TTL=${payload.ttl}`,
      );

      // Verificare deduplicator
      const alertHash = hashAlertId(payload.id);
      if (!this.deduplicator.shouldProcess(alertHash)) {
        console.log(`[BLE:MESH] Duplicate alert "${payload.id}", ignoring`);
        return;
      }

      // Conversie la DisasterAlert
      const alertWithTtl = decodeFullAlert(payload);

      // Verificare expirare
      if (alertWithTtl.expiresAt < Date.now()) {
        console.log(`[BLE:MESH] Expired alert "${payload.id}", ignoring`);
        return;
      }

      // Notifică UI-ul (MapScreen va afișa alerta pe hartă)
      console.log(`[BLE:MESH] New alert received: "${alertWithTtl.message}"`);
      this.onAlertReceived?.(alertWithTtl);

      // Relay: retransmite cu TTL decrementat
      const newTtl = alertWithTtl.ttl - 1;
      if (newTtl > 0) {
        console.log(
          `[BLE:MESH] Relaying alert "${payload.id}" with TTL=${newTtl}`,
        );
        await this.broadcastAlert(alertWithTtl, newTtl);
      } else {
        console.log(
          `[BLE:MESH] Alert "${payload.id}" reached TTL=0, not relaying`,
        );
      }
    } catch (error: any) {
      console.error(
        '[BLE:MESH] Failed to process received alert:',
        error.message,
      );
    }
  }

  // =========================================================================
  // SECȚIUNEA 7: Advertising + Rotație
  // =========================================================================
  //
  // BLE poate advertisa un singur set de date la un moment dat.
  // Dacă avem mai multe alerte, le rotăm: fiecare alertă e advertisată
  // câte ROTATION_INTERVAL_MS (10s), apoi trecem la următoarea.
  //
  // La fiecare rotație:
  // 1. Actualizăm datele GATT (alerta completă JSON)
  // 2. Pe Android, am reporni advertising-ul cu manufacturer data nouă
  // 3. Pe iOS, manufacturer data nu e suportată, dar GATT data se schimbă

  /**
   * Pornește sau repornește rotația alertelor.
   * Advertisează prima alertă imediat, apoi setează timer pentru rotație.
   */
  private async startAdvertisingRotation(): Promise<void> {
    // Oprește timer-ul vechi dacă exista
    this.stopRotationTimer();

    if (this.alertsToAdvertise.size === 0) {
      return;
    }

    // Advertisează prima alertă imediat
    await this.advertiseCurrentAlert();

    // Dacă avem mai multe alerte, setează rotație
    if (this.alertsToAdvertise.size > 1) {
      this.rotationTimer = setInterval(async () => {
        this.rotationIndex =
          (this.rotationIndex + 1) % this.alertsToAdvertise.size;
        await this.advertiseCurrentAlert();
      }, ROTATION_INTERVAL_MS);
    }
  }

  /**
   * Advertisează alerta curentă din rotație.
   *
   * Pregătește 2 seturi de date:
   * 1. alertData (JSON base64) → servită prin GATT la citire
   * 2. manufacturerData (20 bytes compact, base64) → inclusă în advertising packet
   *
   * Pe iOS, manufacturer data NU apare în advertising (limitare Apple),
   * dar o pregătim oricum pentru consistență și pentru viitorul suport Android.
   */
  private async advertiseCurrentAlert(): Promise<void> {
    const entries = Array.from(this.alertsToAdvertise.values());
    if (entries.length === 0) {
      return;
    }

    // Selectează alerta curentă din rotație
    const safeIndex = this.rotationIndex % entries.length;
    const {alert, ttl} = entries[safeIndex];

    try {
      // Pregătire date GATT (alerta completă JSON → base64)
      // Convertim JSON string → bytes manual (fără TextEncoder, indisponibil în Hermes)
      const fullPayload = encodeFullAlert(alert, ttl);
      const jsonString = serializeFullAlert(fullPayload);
      const jsonBytes = new Uint8Array(
        jsonString.split('').map(c => c.charCodeAt(0)),
      );
      const alertDataBase64 = uint8ArrayToBase64(jsonBytes);

      // Pregătire manufacturer data (compact 20 bytes → base64)
      const compact = alertToCompact(alert);
      const compactBytes = encodeCompactAlert(compact);
      const manufacturerDataBase64 = uint8ArrayToBase64(compactBytes);

      if (!this.isAdvertising) {
        // Prima pornire: startAdvertising
        await BleAdvertiserModule.startAdvertising(
          alertDataBase64,
          manufacturerDataBase64,
        );
        this.isAdvertising = true;
        console.log(
          `[BLE:ADV] Started advertising alert "${alert.id}" (TTL=${ttl})`,
        );
      } else {
        // Rotație: doar actualizăm datele GATT
        await BleAdvertiserModule.updateAlertData(alertDataBase64);
        console.log(
          `[BLE:ADV] Rotated to alert "${alert.id}" (TTL=${ttl})`,
        );
      }
    } catch (error: any) {
      console.warn('[BLE:ADV] Advertising error:', error.message);
      // Dacă BLE nu e încă poweredOn, reîncearcă după 2s
      if (error.code === 'BLE_OFF' || error.message?.includes('not powered on')) {
        setTimeout(() => {
          this.advertiseCurrentAlert().catch(() => {});
        }, 2000);
      }
    }
  }

  /**
   * Oprește timer-ul de rotație.
   */
  private stopRotationTimer(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }
  }
}

// =============================================================================
// SECȚIUNEA 8: Singleton Export
// =============================================================================
//
// Exportăm o singură instanță (singleton) pentru toată aplicația.
// Oricine importă bleMeshService primește aceeași instanță.
// Asta e important pentru că:
// - BleManager trebuie să fie unic (multiple instanțe = probleme)
// - Deduplicatorul trebuie să fie partajat (altfel nu deduplicăm corect)
// - Alertele de advertisat trebuie să fie într-un singur loc

const bleMeshService = new BleMeshService();
export default bleMeshService;
