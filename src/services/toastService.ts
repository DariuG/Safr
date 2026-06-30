/**
 * toastService — notificări in-app non-blocante (toast).
 *
 * Înlocuiește `Alert.alert` pentru confirmări/erori care NU necesită o decizie
 * a utilizatorului. Spre deosebire de `Alert.alert` (dialog nativ al sistemului,
 * cu aspect diferit pe iOS vs Android), toast-ul e un component custom randat de
 * `ToastHost`, deci arată identic pe ambele platforme și nu blochează interfața.
 *
 * Pattern singleton + observator, ca celelalte servicii (vezi bleMeshService).
 */

export type ToastType = 'success' | 'error' | 'info';

export interface ToastData {
  id: number;
  message: string;
  type: ToastType;
  duration: number; // ms
}

type Listener = (toast: ToastData) => void;

class ToastService {
  private listeners: Set<Listener> = new Set();
  private counter = 0;

  /** Abonare (folosit de ToastHost). Returnează un unsubscribe. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Afișează un toast. `id` unic permite re-declanșarea animației la mesaje succesive. */
  show(message: string, type: ToastType = 'info', duration = 2600): void {
    const toast: ToastData = { id: ++this.counter, message, type, duration };
    this.listeners.forEach(fn => fn(toast));
  }

  success(message: string, duration?: number): void {
    this.show(message, 'success', duration);
  }
  error(message: string, duration?: number): void {
    this.show(message, 'error', duration);
  }
  info(message: string, duration?: number): void {
    this.show(message, 'info', duration);
  }
}

const toastService = new ToastService();
export default toastService;