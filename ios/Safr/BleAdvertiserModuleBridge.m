// ============================================================================
// BleAdvertiserModuleBridge.m
// ============================================================================
//
// SCOP: Conectează modulul Swift (BleAdvertiserModule.swift) cu React Native.
//
// DE CE E NECESAR:
// React Native bridge-ul e scris în Objective-C. Modulele native trebuie
// înregistrate prin macro-uri ObjC (RCT_EXTERN_MODULE / RCT_EXTERN_METHOD).
// Fără acest fișier, JavaScript nu poate "vedea" modulul Swift.
//
// CE FACE FIECARE LINIE:
// - RCT_EXTERN_MODULE: înregistrează clasa Swift ca modul RN
//   Parametri: (NumeModul, ClasaParinte, requiresMainQueueSetup)
//
// - RCT_EXTERN_METHOD: expune o metodă Swift către JavaScript
//   Parametri: (numeMetoda:(tipParam)numeParam ... resolver:(RCTPromiseResolveBlock)
//              rejecter:(RCTPromiseRejectBlock))
//
// NOTĂ: numele metodelor și parametrilor TREBUIE să se potrivească EXACT
// cu cele din Swift, altfel app-ul crashează la apel.
// ============================================================================

#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Înregistrează BleAdvertiserModule ca modul React Native
// Al doilea parametru (RCTEventEmitter) = clasa parinte din Swift
// Necesar pentru ca NativeModules să găsească modulul
RCT_EXTERN_MODULE(BleAdvertiserModule, RCTEventEmitter)

// --- Metode expuse către JavaScript ---

// initialize() → Promise<boolean>
// Creează CBPeripheralManager, verifică Bluetooth
RCT_EXTERN_METHOD(initialize:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// startAdvertising(alertDataBase64, manufacturerDataBase64) → Promise<boolean>
// Pornește BLE advertising cu datele alertei
RCT_EXTERN_METHOD(startAdvertising:
                  (NSString *)alertDataBase64
                  manufacturerDataBase64:(NSString *)manufacturerDataBase64
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// stopAdvertising() → Promise<boolean>
// Oprește BLE advertising
RCT_EXTERN_METHOD(stopAdvertising:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// updateAlertData(alertDataBase64) → Promise<boolean>
// Actualizează datele GATT fără restart advertising
RCT_EXTERN_METHOD(updateAlertData:
                  (NSString *)alertDataBase64
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// isAdvertisingSupported() → Promise<boolean>
// Verifică suport hardware BLE
RCT_EXTERN_METHOD(isAdvertisingSupported:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// getBluetoothState() → Promise<string>
// Returnează starea Bluetooth: "on", "off", "unauthorized", "unsupported", "unknown"
RCT_EXTERN_METHOD(getBluetoothState:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

// cleanup() → Promise<boolean>
// Oprește totul și eliberează resursele
RCT_EXTERN_METHOD(cleanup:
                  (RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
