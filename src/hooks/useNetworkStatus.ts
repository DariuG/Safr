import { useState, useEffect } from 'react';
import NetInfo from '@react-native-community/netinfo';

interface NetworkState {
  isOnline: boolean;
  type: string;
  isConnected: boolean | null;
}

export const useNetworkStatus = (): NetworkState => {
  const [networkState, setNetworkState] = useState<NetworkState>({
    isOnline: true,
    type: 'unknown',
    isConnected: null,
  });

  useEffect(() => {
    // Subscribe to network state updates
    const unsubscribe = NetInfo.addEventListener(state => {
      setNetworkState({
        isOnline: state.isConnected ?? false,
        type: state.type,
        isConnected: state.isConnected,
      });
    });

    // Check initial network state
    NetInfo.fetch().then(state => {
      setNetworkState({
        isOnline: state.isConnected ?? false,
        type: state.type,
        isConnected: state.isConnected,
      });
    });

    return () => unsubscribe();
  }, []);

  return networkState;
};
