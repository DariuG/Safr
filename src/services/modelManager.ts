/**
 * ModelManager — singleton care orchestrează descărcarea/copierea
 * modelelor AI (LLM + embedding) și expune starea curentă către UI.
 *
 * Flow:
 *  - init() la pornirea app-ului (din App.tsx)
 *  - Embedding model: try copy din bundle (~120 MB), fallback download
 *  - LLM model: dacă lipsește, începe download silent în background
 *  - Pe cellular: warning toast o singură dată, apoi continuă
 *  - HomeScreen + ChatScreen se abonează via subscribe()
 */

import RNFS from 'react-native-fs';
import { Platform, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { downloadModel } from '../api/model';

export type ModelStatus =
  | 'unknown'        // Stare inițială (înainte de init)
  | 'missing'        // Fișierul lipsește, niciun download în curs
  | 'copying'        // Copiere din app bundle în DocumentDirectory
  | 'downloading'    // Descărcare din rețea în curs
  | 'ready'          // Fișier prezent, gata de folosit
  | 'error';         // Download/copy a eșuat

export interface ModelManagerStatus {
  llmStatus: ModelStatus;
  llmProgress: number;        // 0-100
  llmError: string | null;
  embeddingStatus: ModelStatus;
  embeddingError: string | null;
  isCellular: boolean;
}

// === Configurație model LLM ===
const LLM_REPO = 'medmekk/Llama-3.2-1B-Instruct.GGUF';
export const LLM_FILE = 'Llama-3.2-1B-Instruct-Q5_K_S.gguf';
const LLM_URL = `https://huggingface.co/${LLM_REPO}/resolve/main/${LLM_FILE}`;

// === Configurație model embedding ===
const EMBEDDING_REPO = 'nomic-ai/nomic-embed-text-v1.5-GGUF';
export const EMBEDDING_FILE = 'nomic-embed-text-v1.5.Q4_K_M.gguf';
const EMBEDDING_URL = `https://huggingface.co/${EMBEDDING_REPO}/resolve/main/${EMBEDDING_FILE}`;

// === Paths la runtime ===
const MODELS_DIR = `${RNFS.DocumentDirectoryPath}/models`;
const LLM_PATH = `${MODELS_DIR}/${LLM_FILE}`;
const EMBEDDING_PATH = `${MODELS_DIR}/${EMBEDDING_FILE}`;

// Markerul de completare scris de downloadModel la final de transfer.
// Daca fișierul .gguf există DAR .version lipsește, descărcarea a fost
// întreruptă (app backgrounded / kill / network drop) — tratez ca parțial,
// șterg și redescarc. Fără acest check, un fișier corupt e considerat 'ready'
// și initLlama crapă ulterior fără recovery.
const COMPLETION_MARKER_SUFFIX = '.version';

const CELLULAR_WARNED_KEY = '@safr_cellular_warned';

type Listener = (status: ModelManagerStatus) => void;

class ModelManager {
  private status: ModelManagerStatus = {
    llmStatus: 'unknown',
    llmProgress: 0,
    llmError: null,
    embeddingStatus: 'unknown',
    embeddingError: null,
    isCellular: false,
  };

  private listeners: Set<Listener> = new Set();
  private initialized = false;

  // ── Public API ──

  public getStatus(): ModelManagerStatus {
    return { ...this.status };
  }

  public getLLMPath(): string {
    return LLM_PATH;
  }

  public getEmbeddingPath(): string {
    return EMBEDDING_PATH;
  }

  /**
   * Abonare la actualizări de stare. Apelează listener-ul imediat cu starea curentă.
   * Returnează un unsubscribe.
   */
  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Inițializare — apelată o singură dată la pornirea app-ului.
   * Asigură embedding (copiere bundle sau download), apoi LLM (download dacă lipsește).
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await RNFS.mkdir(MODELS_DIR).catch(() => {});

    // Embedding e blocant pentru RAG, deci îl rezolvăm întâi
    await this.ensureEmbedding();

    // LLM se descarcă în background, fără să blocheze app-ul
    this.ensureLLM().catch(err => {
      console.error('[ModelManager] ensureLLM error:', err);
    });
  }

  /**
   * Force re-download al LLM-ului — sterge fisier + marker + reseteaza stare,
   * apoi declanseaza descarcare proaspata. Folosit cand initLlama esueaza
   * pe un fisier care trecuse de isModelComplete (corupere reziduala) sau
   * cand userul vrea sa repete un download esuat.
   */
  public async redownloadLLM(): Promise<void> {
    if (this.status.llmStatus === 'downloading') {
      console.log('[ModelManager] LLM redownload requested while already downloading — ignoring');
      return;
    }
    console.log('[ModelManager] Redownloading LLM — wiping existing artifacts');
    await this.deletePartial(LLM_PATH);
    this.update({ llmStatus: 'missing', llmProgress: 0, llmError: null });
    await this.startLLMDownload();
  }

  /**
   * Trigger manual al download-ului LLM (din UI, e.g. "Retry").
   */
  public async startLLMDownload(): Promise<void> {
    if (this.status.llmStatus === 'downloading') {
      console.log('[ModelManager] LLM download already in progress');
      return;
    }

    this.update({ llmStatus: 'downloading', llmProgress: 0, llmError: null });

    try {
      await downloadModel(LLM_FILE, LLM_URL, (progress) => {
        this.update({ llmProgress: progress });
      });
      this.update({ llmStatus: 'ready', llmProgress: 100, llmError: null });
      console.log('[ModelManager] LLM downloaded successfully');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown download error';
      console.error('[ModelManager] LLM download failed:', msg);
      this.update({ llmStatus: 'error', llmError: msg });
    }
  }

  // ── Private helpers ──

  private notify() {
    const snapshot = this.getStatus();
    this.listeners.forEach(l => l(snapshot));
  }

  private update(partial: Partial<ModelManagerStatus>) {
    this.status = { ...this.status, ...partial };
    this.notify();
  }

  private async isModelComplete(modelPath: string): Promise<boolean> {
    const fileExists = await RNFS.exists(modelPath);
    if (!fileExists) return false;
    return RNFS.exists(`${modelPath}${COMPLETION_MARKER_SUFFIX}`);
  }

  private async deletePartial(modelPath: string): Promise<void> {
    await RNFS.unlink(modelPath).catch(() => {});
    await RNFS.unlink(`${modelPath}${COMPLETION_MARKER_SUFFIX}`).catch(() => {});
  }

  private async ensureEmbedding(): Promise<void> {
    try {
      if (await this.isModelComplete(EMBEDDING_PATH)) {
        this.update({ embeddingStatus: 'ready' });
        return;
      }

      // Fișier parțial dintr-un download întrerupt anterior — curăț înainte
      if (await RNFS.exists(EMBEDDING_PATH)) {
        console.log('[ModelManager] Embedding partial detected, deleting before retry');
        await this.deletePartial(EMBEDDING_PATH);
      }

      // Try copy din bundle
      this.update({ embeddingStatus: 'copying' });
      const copied = await this.copyEmbeddingFromBundle();
      if (copied) {
        await this.writeCompletionMarker(EMBEDDING_PATH);
        this.update({ embeddingStatus: 'ready', embeddingError: null });
        return;
      }

      // Fallback: download din rețea
      console.log('[ModelManager] Embedding not in bundle, falling back to network download');
      this.update({ embeddingStatus: 'downloading' });
      await downloadModel(EMBEDDING_FILE, EMBEDDING_URL, () => {
        // Progress pentru embedding nu e expus separat — e rapid (~120 MB)
      });
      this.update({ embeddingStatus: 'ready', embeddingError: null });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[ModelManager] Embedding setup failed:', msg);
      this.update({ embeddingStatus: 'error', embeddingError: msg });
    }
  }

  private async writeCompletionMarker(modelPath: string): Promise<void> {
    // Scris dupa copy-from-bundle pentru a unifica detectia "complete":
    // existenta fisierului + marker. Versiunea downloadModel scrie marker
    // doar pe download reuit; replicam aici pentru consistenta.
    await RNFS.writeFile(
      `${modelPath}${COMPLETION_MARKER_SUFFIX}`,
      '1.0.0',
      'utf8',
    ).catch(err => console.warn('[ModelManager] Could not write completion marker:', err));
  }

  private async copyEmbeddingFromBundle(): Promise<boolean> {
    try {
      if (Platform.OS === 'android') {
        // Android: assets/models/<file>.gguf, relativ la android/app/src/main/assets/
        const assetPath = `models/${EMBEDDING_FILE}`;
        await RNFS.copyFileAssets(assetPath, EMBEDDING_PATH);
        console.log('[ModelManager] Embedding copied from Android assets');
        return true;
      } else {
        // iOS: file inclus în Xcode bundle, accesibil via MainBundlePath
        const bundlePath = `${RNFS.MainBundlePath}/${EMBEDDING_FILE}`;
        const bundleExists = await RNFS.exists(bundlePath);
        if (bundleExists) {
          await RNFS.copyFile(bundlePath, EMBEDDING_PATH);
          console.log('[ModelManager] Embedding copied from iOS bundle');
          return true;
        }
        return false;
      }
    } catch (error) {
      console.warn('[ModelManager] Bundle copy failed:', error);
      return false;
    }
  }

  private async ensureLLM(): Promise<void> {
    if (await this.isModelComplete(LLM_PATH)) {
      this.update({ llmStatus: 'ready' });
      return;
    }

    // Daca exista fisier dar lipseste markerul -> download intrerupt
    // (app backgrounded / kill in timpul descarcarii). Sterg si redescarc.
    if (await RNFS.exists(LLM_PATH)) {
      console.log('[ModelManager] LLM partial file detected (no completion marker), deleting');
      await this.deletePartial(LLM_PATH);
    }

    const netState = await NetInfo.fetch();
    const isCellular = netState.type === 'cellular';
    this.update({ isCellular });

    if (!netState.isConnected) {
      this.update({
        llmStatus: 'missing',
        llmError: 'Fără conexiune la internet. Conectează-te pentru a descărca modelul AI.',
      });
      return;
    }

    if (isCellular) {
      await this.showCellularWarningIfFirstTime();
    }

    await this.startLLMDownload();
  }

  private async showCellularWarningIfFirstTime(): Promise<void> {
    const warned = await AsyncStorage.getItem(CELLULAR_WARNED_KEY);
    if (warned) return;

    await AsyncStorage.setItem(CELLULAR_WARNED_KEY, '1');

    Alert.alert(
      'Date mobile detectate',
      'Safr începe descărcarea modelului AI offline (~800 MB) pe date mobile. Pentru a economisi date, conectează-te la WiFi când e posibil.',
      [{ text: 'OK', style: 'default' }],
    );
  }
}

const modelManager = new ModelManager();
export default modelManager;
