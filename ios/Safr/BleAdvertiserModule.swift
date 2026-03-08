import Foundation
import CoreBluetooth
import React

// ============================================================================
// BleAdvertiserModule - Modul nativ iOS pentru BLE Advertising + GATT Server
// ============================================================================
//
// CE FACE:
// 1. Transformă iPhone-ul într-un "peripheral" BLE care emite semnale
//    (advertising) ce conțin date compacte despre alertă (20 bytes)
// 2. Rulează un GATT Server care servește alerta completă (JSON) celor
//    care se conectează pentru a citi detaliile
//
// DE CE E NATIV:
// CoreBluetooth (CBPeripheralManager) e disponibil doar în Swift/ObjC.
// react-native-ble-plx face doar scanning (Central), nu advertising (Peripheral).
//
// FLOW:
// JS apelează startAdvertising(base64data) →
//   Swift pornește CBPeripheralManager.startAdvertising cu service UUID →
//   Alt telefon scanează, vede UUID-ul SAFR →
//   Se conectează GATT, citește characteristic-ul cu alerta completă →
//   Se deconectează
// ============================================================================

/// @objc(BleAdvertiserModule) expune clasa Swift către Objective-C cu acest nume.
/// Modulul extinde RCTEventEmitter (care extinde NSObject și conformează RCTBridgeModule)
/// pentru ca React Native să-l poată găsi prin NativeModules.BleAdvertiserModule.
@objc(BleAdvertiserModule)
class BleAdvertiserModule: RCTEventEmitter {

  /// Returnează lista de evenimente suportate (obligatoriu pentru RCTEventEmitter).
  /// Chiar dacă nu emitem evenimente acum, e necesar pentru conformare.
  override func supportedEvents() -> [String]! {
    return ["onBleStateChange"]
  }

  /// Previne warning-ul "Module requires main queue setup" de la RN.
  override var methodQueue: DispatchQueue! {
    return DispatchQueue(label: "com.safr.ble.module")
  }

  // --------------------------------------------------------------------------
  // MARK: - UUIDs
  // --------------------------------------------------------------------------
  // Identificatori unici pentru serviciul nostru BLE și characteristic-ul de alertă.
  // Orice telefon care scanează pentru SAFR_SERVICE_UUID ne va găsi.
  // După conectare, va citi ALERT_CHARACTERISTIC_UUID pentru datele alertei.

  private static let SAFR_SERVICE_UUID = CBUUID(string: "0000SAFE-0000-1000-8000-00805F9B34FB")
  private static let ALERT_CHARACTERISTIC_UUID = CBUUID(string: "0000ALR1-0000-1000-8000-00805F9B34FB")

  // --------------------------------------------------------------------------
  // MARK: - Properties
  // --------------------------------------------------------------------------

  /// CBPeripheralManager - obiectul iOS care controlează advertising-ul și GATT server-ul.
  /// E echivalentul unui "server Bluetooth" - face telefonul vizibil pentru alții.
  private var peripheralManager: CBPeripheralManager?

  /// Delegat separat care gestionează toate callback-urile CoreBluetooth.
  /// Separat de clasa principală pentru claritate.
  private var delegate: PeripheralManagerDelegate?

  /// Datele alertei complete (JSON, base64-encoded) servite prin GATT.
  /// Când un alt telefon se conectează și citește characteristic-ul, primește aceste date.
  private var currentAlertData: Data?

  /// Manufacturer data (20 bytes compact alert) inclusă în advertising packet.
  /// Aceasta e vizibilă FĂRĂ conexiune - orice scanner o vede direct.
  private var currentManufacturerData: Data?

  /// Flag: advertising-ul e activ?
  private var isAdvertising = false

  /// Referință la GATT service-ul adăugat, pentru cleanup.
  private var addedService: CBMutableService?

  // --------------------------------------------------------------------------
  // MARK: - React Native Module Setup
  // --------------------------------------------------------------------------

  /// React Native apelează asta pentru a ști pe ce thread să inițializeze modulul.
  /// false = background thread (recomandat, nu blochează UI-ul).
  @objc override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  // --------------------------------------------------------------------------
  // MARK: - initialize()
  // --------------------------------------------------------------------------
  // Primul lucru apelat din JavaScript.
  // Creează CBPeripheralManager care verifică dacă Bluetooth-ul e pornit
  // și dacă hardware-ul suportă BLE.
  //
  // CBPeripheralManagerOptionRestoreIdentifierKey: permite iOS-ului să
  // relanseze app-ul din background dacă apare un eveniment BLE relevant
  // (de ex. un alt telefon vrea să se conecteze). Fără asta, dacă iOS
  // omoară app-ul pentru memorie, BLE-ul se oprește definitiv.

  @objc func initialize(_ resolve: @escaping RCTPromiseResolveBlock,
                        reject: @escaping RCTPromiseRejectBlock) {
    let del = PeripheralManagerDelegate()
    self.delegate = del

    // Callback: când CBPeripheralManager e gata (Bluetooth pornit/oprit)
    del.onStateUpdate = { [weak self] state in
      guard let self = self else { return }
      switch state {
      case .poweredOn:
        NSLog("[BLE:ADV] Bluetooth is powered ON")
        self.setupGattService()
      case .poweredOff:
        NSLog("[BLE:ADV] Bluetooth is powered OFF")
        self.isAdvertising = false
      case .unauthorized:
        NSLog("[BLE:ADV] Bluetooth unauthorized - check permissions")
      case .unsupported:
        NSLog("[BLE:ADV] BLE not supported on this device")
      default:
        NSLog("[BLE:ADV] Bluetooth state: \(state.rawValue)")
      }
    }

    // Creează peripheral manager cu restore identifier pentru background support
    self.peripheralManager = CBPeripheralManager(
      delegate: del,
      queue: DispatchQueue(label: "com.safr.ble.peripheral"),
      options: [
        CBPeripheralManagerOptionRestoreIdentifierKey: "SafrBLEPeripheral"
      ]
    )

    resolve(true)
  }

  // --------------------------------------------------------------------------
  // MARK: - setupGattService()
  // --------------------------------------------------------------------------
  // Configurează GATT service-ul cu un characteristic readable.
  //
  // GATT = Generic Attribute Profile - protocolul prin care dispozitivele
  // BLE expun date structurate. Un "Service" e un grup logic de date,
  // un "Characteristic" e o valoare individuală din acel grup.
  //
  // Analogie: Service = un "folder", Characteristic = un "fișier" din folder.
  // Noi avem un singur folder (SAFR) cu un singur fișier (ALERT) care
  // conține JSON-ul alertei.
  //
  // .read = alt telefon poate citi valoarea
  // .readable = nu necesită pairing/encryption pentru citire

  private func setupGattService() {
    guard let pm = peripheralManager, pm.state == .poweredOn else { return }

    // Elimină serviciul vechi dacă există (la reinițializare)
    if let old = addedService {
      pm.remove(old)
    }

    // Creează characteristic-ul: un "slot" de date readable
    let characteristic = CBMutableCharacteristic(
      type: BleAdvertiserModule.ALERT_CHARACTERISTIC_UUID,
      properties: [.read],
      value: nil,           // nil = valoarea se servește dinamic prin callback
      permissions: [.readable]
    )
    // IMPORTANT: value: nil face ca iOS să apeleze didReceiveRead de fiecare dată
    // când cineva citește. Dacă am pune o valoare fixă, iOS ar servi-o din cache
    // și nu am putea-o actualiza dinamic.

    // Creează service-ul: un "container" pentru characteristic
    let service = CBMutableService(
      type: BleAdvertiserModule.SAFR_SERVICE_UUID,
      primary: true   // primary = serviciul principal al dispozitivului
    )
    service.characteristics = [characteristic]

    // Adaugă service-ul în GATT server - acum e "publicat" și alții îl pot citi
    pm.add(service)
    addedService = service
    NSLog("[BLE:ADV] GATT service added")
  }

  // --------------------------------------------------------------------------
  // MARK: - startAdvertising(alertDataBase64, manufacturerDataBase64)
  // --------------------------------------------------------------------------
  // Pornește emiterea de semnale BLE.
  //
  // Advertising-ul face 2 lucruri simultan:
  // 1. Include service UUID (SAFR) → scannerele care filtrează pe UUID ne găsesc
  // 2. Include manufacturer data (compact alert 20 bytes) → scannerele pot
  //    citi instant tipul alertei fără să se conecteze
  //
  // alertDataBase64: alerta completă JSON (pentru GATT reads)
  // manufacturerDataBase64: alerta compactă 20 bytes (pentru advertising packet)
  //
  // NOTĂ iOS: în background, iOS ELIMINĂ manufacturer data din advertising!
  // Doar service UUID-ul rămâne vizibil (în "overflow area").
  // De aceea GATT server-ul e esențial - e singura cale de transfer în background.

  @objc func startAdvertising(_ alertDataBase64: String,
                              manufacturerDataBase64: String,
                              resolve: @escaping RCTPromiseResolveBlock,
                              reject: @escaping RCTPromiseRejectBlock) {
    guard let pm = peripheralManager else {
      reject("BLE_NOT_INIT", "BLE not initialized. Call initialize() first.", nil)
      return
    }

    guard pm.state == .poweredOn else {
      reject("BLE_OFF", "Bluetooth is not powered on.", nil)
      return
    }

    // Decodează datele din base64
    guard let alertData = Data(base64Encoded: alertDataBase64) else {
      reject("INVALID_DATA", "Invalid base64 alert data.", nil)
      return
    }

    // Salvează datele alertei pentru GATT reads (când cineva se conectează)
    self.currentAlertData = alertData

    // Decodează manufacturer data (compact alert)
    if let mfData = Data(base64Encoded: manufacturerDataBase64) {
      // Adaugă Company ID (0xFFFF = test) ca primii 2 bytes
      // BLE spec: manufacturer data = [company_id_low, company_id_high, ...payload]
      var fullMfData = Data([0xFF, 0xFF])
      fullMfData.append(mfData)
      self.currentManufacturerData = fullMfData
    }

    // Oprește advertising-ul curent (dacă era activ) înainte de a porni cu date noi
    if isAdvertising {
      pm.stopAdvertising()
    }

    // Configurează callback-ul pentru GATT read requests
    delegate?.onReadRequest = { [weak self] request in
      self?.handleReadRequest(request)
    }

    // Construiește dicționarul de advertising
    // CBAdvertisementDataServiceUUIDsKey: UUID-urile serviciilor expuse
    //   → alte telefoane ne găsesc când scanează pentru acest UUID
    // CBAdvertisementDataLocalNameKey: numele dispozitivului (opțional, vizibil în scan)
    var advertisementData: [String: Any] = [
      CBAdvertisementDataServiceUUIDsKey: [BleAdvertiserModule.SAFR_SERVICE_UUID],
      CBAdvertisementDataLocalNameKey: "SAFR"
    ]

    // NOTĂ: iOS NU suportă CBAdvertisementDataManufacturerDataKey în advertising!
    // Pe iOS, manufacturer data nu poate fi inclusă în advertising packets.
    // Singura cale de transfer e prin GATT connection.
    // Lăsăm manufacturer data doar pentru referință internă.
    _ = advertisementData // suppress warning

    pm.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [BleAdvertiserModule.SAFR_SERVICE_UUID],
      CBAdvertisementDataLocalNameKey: "SAFR"
    ])

    isAdvertising = true
    NSLog("[BLE:ADV] Advertising started")
    resolve(true)
  }

  // --------------------------------------------------------------------------
  // MARK: - stopAdvertising()
  // --------------------------------------------------------------------------
  // Oprește emiterea de semnale. Telefonul devine "invizibil" pentru scannere.

  @objc func stopAdvertising(_ resolve: @escaping RCTPromiseResolveBlock,
                             reject: @escaping RCTPromiseRejectBlock) {
    guard let pm = peripheralManager else {
      reject("BLE_NOT_INIT", "BLE not initialized.", nil)
      return
    }

    pm.stopAdvertising()
    isAdvertising = false
    currentAlertData = nil
    currentManufacturerData = nil
    NSLog("[BLE:ADV] Advertising stopped")
    resolve(true)
  }

  // --------------------------------------------------------------------------
  // MARK: - updateAlertData(alertDataBase64)
  // --------------------------------------------------------------------------
  // Actualizează datele alertei servite prin GATT fără a reporni advertising-ul.
  // Folosit la rotația alertelor (când avem mai multe alerte active).

  @objc func updateAlertData(_ alertDataBase64: String,
                             resolve: @escaping RCTPromiseResolveBlock,
                             reject: @escaping RCTPromiseRejectBlock) {
    guard let alertData = Data(base64Encoded: alertDataBase64) else {
      reject("INVALID_DATA", "Invalid base64 alert data.", nil)
      return
    }

    self.currentAlertData = alertData
    NSLog("[BLE:ADV] Alert data updated (\(alertData.count) bytes)")
    resolve(true)
  }

  // --------------------------------------------------------------------------
  // MARK: - isAdvertisingSupported()
  // --------------------------------------------------------------------------
  // Verifică dacă dispozitivul suportă BLE advertising.
  // Pe iOS, toate iPhone-urile de la 4S+ suportă BLE, dar verificăm totuși.

  @objc func isAdvertisingSupported(_ resolve: @escaping RCTPromiseResolveBlock,
                                    reject: @escaping RCTPromiseRejectBlock) {
    guard let pm = peripheralManager else {
      resolve(false)
      return
    }
    // Pe iOS, dacă CBPeripheralManager e poweredOn, advertising e suportat
    resolve(pm.state == .poweredOn)
  }

  // --------------------------------------------------------------------------
  // MARK: - getBluetoothState()
  // --------------------------------------------------------------------------
  // Returnează starea curentă a Bluetooth-ului.
  // Folosit pentru UI indicator (verde/roșu/gri pe MapScreen).

  @objc func getBluetoothState(_ resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    guard let pm = peripheralManager else {
      resolve("unknown")
      return
    }
    switch pm.state {
    case .poweredOn:    resolve("on")
    case .poweredOff:   resolve("off")
    case .unauthorized: resolve("unauthorized")
    case .unsupported:  resolve("unsupported")
    default:            resolve("unknown")
    }
  }

  // --------------------------------------------------------------------------
  // MARK: - handleReadRequest()
  // --------------------------------------------------------------------------
  // Callback apelat de iOS când un alt telefon se conectează GATT și citește
  // characteristic-ul nostru de alertă.
  //
  // request.offset: dacă datele sunt mai mari decât MTU-ul negociat,
  // iOS trimite mai multe read requests cu offset crescător (Long Read).
  // De ex: date de 300 bytes, MTU de 185 → 2 reads: offset 0 și offset 185.

  private func handleReadRequest(_ request: CBATTRequest) {
    guard let pm = peripheralManager else { return }

    // Verifică că read request-ul e pentru characteristic-ul nostru
    guard request.characteristic.uuid == BleAdvertiserModule.ALERT_CHARACTERISTIC_UUID else {
      pm.respond(to: request, withResult: .attributeNotFound)
      return
    }

    // Verifică că avem date de servit
    guard let data = currentAlertData else {
      pm.respond(to: request, withResult: .attributeNotFound)
      NSLog("[BLE:GATT] Read request but no alert data available")
      return
    }

    // Verifică offset valid (Long Read support)
    guard request.offset < data.count else {
      pm.respond(to: request, withResult: .invalidOffset)
      return
    }

    // Servește datele de la offset-ul cerut până la final
    request.value = data.subdata(in: request.offset..<data.count)
    pm.respond(to: request, withResult: .success)
    NSLog("[BLE:GATT] Served \(data.count - request.offset) bytes at offset \(request.offset)")
  }

  // --------------------------------------------------------------------------
  // MARK: - cleanup()
  // --------------------------------------------------------------------------
  // Oprește totul și eliberează resursele. Apelat la deinit sau manual.

  @objc func cleanup(_ resolve: @escaping RCTPromiseResolveBlock,
                     reject: @escaping RCTPromiseRejectBlock) {
    if let pm = peripheralManager {
      pm.stopAdvertising()
      if let service = addedService {
        pm.remove(service)
      }
    }
    isAdvertising = false
    currentAlertData = nil
    currentManufacturerData = nil
    peripheralManager = nil
    delegate = nil
    addedService = nil
    NSLog("[BLE:ADV] Cleanup complete")
    resolve(true)
  }
}

// ==============================================================================
// PeripheralManagerDelegate
// ==============================================================================
// Clasă separată care primește toate callback-urile de la CoreBluetooth.
//
// CoreBluetooth funcționează pe bază de "delegate pattern":
// - iOS nu returnează rezultate direct din apeluri
// - În schimb, apelează metode pe un obiect "delegate" când se întâmplă ceva
// - Ex: "Bluetooth s-a pornit" → peripheralManagerDidUpdateState
//       "Cineva vrea să citească" → didReceiveRead

class PeripheralManagerDelegate: NSObject, CBPeripheralManagerDelegate {

  /// Callback apelat când starea Bluetooth se schimbă
  var onStateUpdate: ((CBManagerState) -> Void)?

  /// Callback apelat când cineva face un GATT read request
  var onReadRequest: ((CBATTRequest) -> Void)?

  // --------------------------------------------------------------------------
  // OBLIGATORIU: apelat de iOS când starea Bluetooth se schimbă.
  // (poweredOn, poweredOff, unauthorized, unsupported, etc.)
  // Fără această metodă, CBPeripheralManager nu funcționează.

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    onStateUpdate?(peripheral.state)
  }

  // --------------------------------------------------------------------------
  // Apelat când service-ul GATT a fost adăugat cu succes (sau nu).

  func peripheralManager(_ peripheral: CBPeripheralManager,
                         didAdd service: CBService, error: Error?) {
    if let error = error {
      NSLog("[BLE:GATT] Failed to add service: \(error.localizedDescription)")
    } else {
      NSLog("[BLE:GATT] Service added successfully: \(service.uuid)")
    }
  }

  // --------------------------------------------------------------------------
  // Apelat când advertising-ul a pornit (sau a eșuat).

  func peripheralManager(_ peripheral: CBPeripheralManager,
                         didStartAdvertising error: Error?) {
    if let error = error {
      NSLog("[BLE:ADV] Failed to start advertising: \(error.localizedDescription)")
    } else {
      NSLog("[BLE:ADV] Advertising started successfully")
    }
  }

  // --------------------------------------------------------------------------
  // Apelat când un alt dispozitiv se conectează GATT și citește characteristic-ul.
  // Rutează request-ul către handleReadRequest din modulul principal.

  func peripheralManager(_ peripheral: CBPeripheralManager,
                         didReceiveRead request: CBATTRequest) {
    NSLog("[BLE:GATT] Received read request from \(request.central.identifier)")
    onReadRequest?(request)
  }

  // --------------------------------------------------------------------------
  // Apelat când iOS restaurează starea după ce app-ul a fost omorât și relansat.
  // Permite continuarea operațiunilor BLE fără intervenția utilizatorului.

  func peripheralManager(_ peripheral: CBPeripheralManager,
                         willRestoreState dict: [String: Any]) {
    NSLog("[BLE:ADV] State restoration triggered")
    // Serviciile publicate anterior sunt restaurate automat de iOS.
    // Advertising-ul trebuie repornit manual de bleMeshService.ts.
  }
}
