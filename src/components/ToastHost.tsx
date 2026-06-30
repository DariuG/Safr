/**
 * ToastHost — randează toast-urile emise prin toastService.
 *
 * Se montează o singură dată, la rădăcina aplicației (App.tsx), peste navigare.
 * Aspect consistent pe iOS și Android (component custom, nu toast nativ).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import toastService, { ToastData, ToastType } from '../services/toastService';

const CONFIG: Record<ToastType, { bg: string; icon: string }> = {
  success: { bg: '#16A34A', icon: 'check-circle' },
  error: { bg: '#DC2626', icon: 'alert-circle' },
  info: { bg: '#2563EB', icon: 'information' },
};

const ToastHost = () => {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastData | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return toastService.subscribe(t => setToast(t));
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }
    if (timer.current) {
      clearTimeout(timer.current);
    }
    // intrare
    opacity.setValue(0);
    translateY.setValue(20);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
    // ieșire automată
    timer.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 20, duration: 220, useNativeDriver: true }),
      ]).start(() => setToast(null));
    }, toast.duration);

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, [toast, opacity, translateY]);

  if (!toast) {
    return null;
  }

  const cfg = CONFIG[toast.type];
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrap,
        { bottom: insets.bottom + 96, opacity, transform: [{ translateY }] },
      ]}>
      <View style={[styles.toast, { backgroundColor: cfg.bg }]}>
        <MaterialCommunityIcons
          name={cfg.icon}
          size={20}
          color="#FFFFFF"
          style={styles.icon}
        />
        <Text style={styles.text} numberOfLines={3}>
          {toast.message}
        </Text>
      </View>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 520,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  icon: {
    marginRight: 10,
  },
  text: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 19,
  },
});

export default ToastHost;
