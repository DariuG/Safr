import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  FirebaseAuthTypes,
} from '@react-native-firebase/auth';
import { getFirestore, doc, getDoc } from '@react-native-firebase/firestore';

interface AuthContextType {
  isAdmin: boolean;
  isLoading: boolean;
  user: FirebaseAuthTypes.User | null;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const auth = getAuth();
const db = getFirestore();

// Verifică dacă UID-ul curent e în colecția `admins`
const checkIsAdmin = async (uid: string): Promise<boolean> => {
  try {
    const adminRef = doc(db, 'admins', uid);
    const snap = await getDoc(adminRef);
    return snap.exists();
  } catch (error) {
    console.error('[AuthContext] Error checking admin status:', error);
    return false;
  }
};

// Traducere erori Firebase în mesaje user-friendly
const getFirebaseErrorMessage = (code: string): string => {
  switch (code) {
    case 'auth/invalid-email':
      return 'Adresa de email este invalidă.';
    case 'auth/user-disabled':
      return 'Acest cont a fost dezactivat.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Email sau parolă incorecte.';
    case 'auth/too-many-requests':
      return 'Prea multe încercări. Reîncearcă mai târziu.';
    case 'auth/network-request-failed':
      return 'Eroare de rețea. Verifică conexiunea.';
    default:
      return 'Autentificare eșuată. Reîncearcă.';
  }
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<FirebaseAuthTypes.User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Auth state listener — se apelează la login, logout, și la pornirea app-ului
  // (Firebase persistă sesiunea automat între restart-uri)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      setUser(fbUser);
      if (fbUser) {
        const adminStatus = await checkIsAdmin(fbUser.uid);
        setIsAdmin(adminStatus);
        console.log('[AuthContext] User authenticated:', fbUser.email, 'isAdmin:', adminStatus);
      } else {
        setIsAdmin(false);
        console.log('[AuthContext] No user authenticated');
      }
      setIsLoading(false);
    });

    return unsubscribe;
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
      const adminStatus = await checkIsAdmin(credential.user.uid);

      if (!adminStatus) {
        // User autentificat dar NU e admin — delogăm imediat
        await signOut(auth);
        return { success: false, error: 'Acest cont nu are drepturi de administrator.' };
      }

      console.log('[AuthContext] Admin logged in:', credential.user.email);
      return { success: true };
    } catch (error: any) {
      console.error('[AuthContext] Login error:', error.code, error.message);
      return { success: false, error: getFirebaseErrorMessage(error.code) };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await signOut(auth);
      console.log('[AuthContext] User logged out');
    } catch (error) {
      console.error('[AuthContext] Logout error:', error);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ isAdmin, isLoading, user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default AuthContext;
