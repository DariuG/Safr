/**
 * mapResourcesService — singleton care copiază fișierul `.mbtiles` din bundle
 * în DocumentDirectory la pornirea app-ului (nu la mount-ul MapScreen) și
 * expune starea + path-ul către UI.
 *
 * Problema rezolvată: înainte, copy-ul (~80-150 MB) se făcea la mount-ul
 * MapScreen, blocând UI-ul la prima intrare pe hartă. Acum init() e apelat din
 * App.tsx în paralel cu modelManager.init(), deci când userul ajunge pe Map
 * fișierul e deja gata și harta randează instant.
 *
 * Pattern identic cu modelManager: state machine + subscribe().
 */

import RNFS from 'react-native-fs';
import { Platform } from 'react-native';

export type MapResourceStatus = 'unknown' | 'copying' | 'ready' | 'error';

export interface MapResourcesState {
  status: MapResourceStatus;
  mbtilesPath: string | null;
  error: string | null;
}

const MBTILES_FILE = 'romania.mbtiles';
const MBTILES_DEST = `${RNFS.DocumentDirectoryPath}/${MBTILES_FILE}`;

type Listener = (state: MapResourcesState) => void;

class MapResourcesService {
  private state: MapResourcesState = {
    status: 'unknown',
    mbtilesPath: null,
    error: null,
  };

  private listeners: Set<Listener> = new Set();
  private initialized = false;

  // ── Public API ──

  public getState(): MapResourcesState {
    return { ...this.state };
  }

  public getMbtilesPath(): string | null {
    return this.state.mbtilesPath;
  }

  /**
   * Abonare la actualizări de stare. Apelează listener-ul imediat cu starea
   * curentă. Returnează un unsubscribe.
   */
  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Inițializare — apelată o singură dată la pornirea app-ului (App.tsx).
   * Copiază .mbtiles din bundle dacă nu există deja în DocumentDirectory.
   * Idempotent: dacă fișierul există, doar marchează ready.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.copyIfNeeded();
  }

  /**
   * Forțează o nouă încercare de copiere (folosit de butonul "Încearcă din nou"
   * din MapScreen când starea e error). Resetează flag-ul de init.
   */
  public async retry(): Promise<void> {
    this.initialized = true;
    await this.copyIfNeeded();
  }

  // ── Private ──

  private async copyIfNeeded(): Promise<void> {
    try {
      const exists = await RNFS.exists(MBTILES_DEST);
      if (exists) {
        console.log('[MapResources] .mbtiles already in DocumentDirectory');
        this.update({ status: 'ready', mbtilesPath: MBTILES_DEST, error: null });
        return;
      }

      this.update({ status: 'copying', error: null });
      console.log('[MapResources] Copying .mbtiles from bundle...');

      if (Platform.OS === 'android') {
        // Android: fișier relativ la android/app/src/main/assets/
        await RNFS.copyFileAssets(MBTILES_FILE, MBTILES_DEST);
        console.log('[MapResources] Copied from Android assets');
      } else {
        // iOS: fișier inclus în Xcode bundle
        const bundlePath = `${RNFS.MainBundlePath}/${MBTILES_FILE}`;
        const bundleExists = await RNFS.exists(bundlePath);
        if (!bundleExists) {
          throw new Error(`Fișierul hărții nu a fost găsit în bundle: ${bundlePath}`);
        }
        await RNFS.copyFile(bundlePath, MBTILES_DEST);
        console.log('[MapResources] Copied from iOS bundle');
      }

      // Verifică post-copiere
      const finalExists = await RNFS.exists(MBTILES_DEST);
      if (!finalExists) {
        throw new Error('Fișierul hărții nu a putut fi verificat după copiere');
      }

      this.update({ status: 'ready', mbtilesPath: MBTILES_DEST, error: null });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Eroare necunoscută la copierea hărții';
      console.error('[MapResources] Copy failed:', msg);
      this.update({ status: 'error', mbtilesPath: null, error: msg });
    }
  }

  private update(partial: Partial<MapResourcesState>) {
    this.state = { ...this.state, ...partial };
    const snapshot = this.getState();
    this.listeners.forEach(l => l(snapshot));
  }
}

const mapResourcesService = new MapResourcesService();
export default mapResourcesService;
