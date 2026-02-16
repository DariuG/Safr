import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Hardcoded admin credentials (for development)
const ADMIN_CREDENTIALS = {
  username: 'admin',
  password: 'safr2024',
};

interface AuthContextType {
  isAdmin: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  checkAuthStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const AUTH_STORAGE_KEY = '@safr_admin_auth';

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Check if admin is already logged in (on app start)
  const checkAuthStatus = useCallback(async () => {
    try {
      const authData = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
      if (authData) {
        const { isAdmin: storedIsAdmin, expiry } = JSON.parse(authData);
        // Check if session is still valid (24 hours)
        if (storedIsAdmin && expiry && Date.now() < expiry) {
          setIsAdmin(true);
        } else {
          // Session expired, clear it
          await AsyncStorage.removeItem(AUTH_STORAGE_KEY);
          setIsAdmin(false);
        }
      }
    } catch (error) {
      console.error('[AuthContext] Error checking auth status:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Login function
  const login = useCallback(async (username: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      // Validate credentials
      if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
        // Store auth status with 24-hour expiry
        const authData = {
          isAdmin: true,
          expiry: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
        };
        await AsyncStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authData));
        setIsAdmin(true);
        console.log('[AuthContext] Admin logged in successfully');
        return { success: true };
      } else {
        return { success: false, error: 'Credențiale invalide' };
      }
    } catch (error) {
      console.error('[AuthContext] Login error:', error);
      return { success: false, error: 'Eroare la autentificare' };
    }
  }, []);

  // Logout function
  const logout = useCallback(async () => {
    try {
      await AsyncStorage.removeItem(AUTH_STORAGE_KEY);
      setIsAdmin(false);
      console.log('[AuthContext] Admin logged out');
    } catch (error) {
      console.error('[AuthContext] Logout error:', error);
    }
  }, []);

  // Check auth status on mount
  React.useEffect(() => {
    checkAuthStatus();
  }, [checkAuthStatus]);

  return (
    <AuthContext.Provider value={{ isAdmin, isLoading, login, logout, checkAuthStatus }}>
      {children}
    </AuthContext.Provider>
  );
};

// Custom hook to use auth context
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default AuthContext;
