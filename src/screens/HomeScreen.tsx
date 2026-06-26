import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import bleMeshService, { MeshStatus } from '../services/bleMeshService';
import { subscribeToAlerts, DisasterAlert } from '../services/alertService';
import modelManager, { ModelManagerStatus } from '../services/modelManager';

const SAFETY_TIPS = [
  'Identifica iesirile de urgenta din cladirea in care te afli.',
  'Pastreaza un kit de urgenta: apa, lanterna, baterii, trusa medicala.',
  'Salveaza numerele de urgenta in telefon: 112, 113, 114.',
  'Stabileste un punct de intalnire cu familia in caz de urgenta.',
  'Verifica periodic detectoarele de fum si stingatoarele.',
];

const HomeScreen = () => {
  const navigation = useNavigation<any>();
  const { isAdmin, logout } = useAuth();
  const [meshStatus, setMeshStatus] = useState<MeshStatus | null>(null);
  const [alertCount, setAlertCount] = useState(0);
  const [modelState, setModelState] = useState<ModelManagerStatus>(modelManager.getStatus());
  const [tipIndex] = useState(() => Math.floor(Math.random() * SAFETY_TIPS.length));

  useEffect(() => {
    bleMeshService.onStatusChanged((status: MeshStatus) => {
      setMeshStatus(status);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeToAlerts(
      (alerts: DisasterAlert[]) => setAlertCount(alerts.length),
      () => {},
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = modelManager.subscribe(setModelState);
    return unsubscribe;
  }, []);

  // Derive AI card visual state
  const llm = modelState.llmStatus;
  const showAICard = llm !== 'ready' && llm !== 'unknown';
  let aiCardTitle = '';
  let aiCardSubtitle = '';
  let aiCardAction: (() => void) | null = null;
  let aiCardActionLabel = '';
  let aiCardAccent = '#0EA5E9';
  if (llm === 'downloading') {
    aiCardTitle = `AI offline: descărcare ${modelState.llmProgress}%`;
    aiCardSubtitle = modelState.isCellular
      ? 'Se descarcă pe date mobile. Conectează-te la WiFi pentru a economisi date.'
      : 'Modelul AI medical (~800 MB) se descarcă în fundal.';
    aiCardAccent = '#0EA5E9';
  } else if (llm === 'missing') {
    aiCardTitle = 'AI offline: indisponibil';
    aiCardSubtitle = modelState.llmError || 'Modelul AI nu este descărcat.';
    aiCardActionLabel = 'Descarcă acum';
    aiCardAction = () => modelManager.startLLMDownload();
    aiCardAccent = '#F59E0B';
  } else if (llm === 'error') {
    aiCardTitle = 'AI offline: eroare la descărcare';
    aiCardSubtitle = modelState.llmError || 'Reîncearcă mai târziu.';
    aiCardActionLabel = 'Reîncearcă';
    aiCardAction = () => modelManager.startLLMDownload();
    aiCardAccent = '#EF4444';
  }

  // Mesh status logic (same as MapScreen badge)
  const btOff = !meshStatus || meshStatus.bluetoothState !== 'on';
  const isOffline = meshStatus && !meshStatus.hasInternet;
  let meshDotColor = '#EF4444';
  let meshLabel = 'BLE Off';
  if (meshStatus?.isRunning && !btOff) {
    if (isOffline) {
      meshDotColor = '#22C55E';
      meshLabel = 'Mesh activ';
    } else {
      meshDotColor = '#3B82F6';
      meshLabel = meshStatus.isAdvertising ? 'Broadcast' : 'Mesh standby';
    }
  }

  return (
    <View style={s.root}>
      {/* Dark top section */}
      <View style={s.darkSection}>
        <SafeAreaView edges={['top']} style={s.safeTop}>

          {/* Admin badge */}
          {isAdmin && (
            <View style={s.adminBadge}>
              <Text style={s.adminBadgeText}>ADMIN</Text>
              <TouchableOpacity onPress={logout} style={s.adminLogout}>
                <Text style={s.adminLogoutText}>Logout</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Hero */}
          <View style={s.hero}>
            <Text style={s.heroLabel}>SAFR</Text>
            <Text style={s.heroTitle}>Siguranța ta, prioritatea noastră</Text>
            <Text style={s.heroSub}>
              Alerte, adăposturi și asistență AI la un tap distanță.
            </Text>
          </View>

          {/* Status bar — integrated in dark section */}
          <View style={s.statusBar}>
            <View style={s.statusItem}>
              <Text style={s.statusValue}>{alertCount}</Text>
              <Text style={s.statusLabel}>Alerte active</Text>
            </View>
            <View style={s.statusDivider} />
            <View style={s.statusItem}>
              <View style={[s.statusDot, { backgroundColor: meshDotColor }]} />
              <Text style={s.statusLabel}>{meshLabel}</Text>
            </View>
            <View style={s.statusDivider} />
            <View style={s.statusItem}>
              <Text style={s.statusValue}>{meshStatus?.devicesInRange ?? 0}</Text>
              <Text style={s.statusLabel}>Dispozitive</Text>
            </View>
          </View>
        </SafeAreaView>
      </View>

      {/* Light bottom section */}
      <ScrollView
        style={s.lightSection}
        contentContainerStyle={s.lightContent}
        showsVerticalScrollIndicator={false}
      >
        {/* AI model status card — apare doar dacă LLM nu e gata */}
        {showAICard && (
          <View style={[s.aiCard, { borderLeftColor: aiCardAccent }]}>
            <View style={s.aiCardBody}>
              <Text style={s.aiCardTitle}>{aiCardTitle}</Text>
              <Text style={s.aiCardSubtitle}>{aiCardSubtitle}</Text>
              {llm === 'downloading' && (
                <View style={s.aiProgressTrack}>
                  <View
                    style={[
                      s.aiProgressFill,
                      { width: `${modelState.llmProgress}%`, backgroundColor: aiCardAccent },
                    ]}
                  />
                </View>
              )}
              {aiCardAction && (
                <TouchableOpacity
                  style={[s.aiCardButton, { backgroundColor: aiCardAccent }]}
                  onPress={aiCardAction}
                  activeOpacity={0.7}
                >
                  <Text style={s.aiCardButtonText}>{aiCardActionLabel}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Quick actions */}
        <Text style={s.sectionTitle}>Acces rapid</Text>
        <View style={s.grid}>
          <TouchableOpacity
            style={s.actionCard}
            onPress={() => navigation.navigate('Map')}
            activeOpacity={0.7}
          >
            <View style={[s.actionAccent, { backgroundColor: '#2563EB' }]} />
            <View style={s.actionBody}>
              <Text style={s.actionTitle}>Harta</Text>
              <Text style={s.actionDesc}>Alerte si adaposturi in zona ta</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={s.actionCard}
            onPress={() => navigation.navigate('Chat')}
            activeOpacity={0.7}
          >
            <View style={[s.actionAccent, { backgroundColor: '#16A34A' }]} />
            <View style={s.actionBody}>
              <Text style={s.actionTitle}>Asistent AI</Text>
              <Text style={s.actionDesc}>Ghid inteligent de urgenta</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={s.actionCard}
            onPress={() => navigation.navigate('Emergency')}
            activeOpacity={0.7}
          >
            <View style={[s.actionAccent, { backgroundColor: '#DC2626' }]} />
            <View style={s.actionBody}>
              <Text style={s.actionTitle}>Urgente</Text>
              <Text style={s.actionDesc}>Numere si resurse de urgenta</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* Safety tip */}
        <View style={s.tipCard}>
          <Text style={s.tipLabel}>Sfat de siguranta</Text>
          <Text style={s.tipText}>{SAFETY_TIPS[tipIndex]}</Text>
        </View>

        {/* Admin login */}
        {!isAdmin && (
          <TouchableOpacity
            style={s.adminLogin}
            onPress={() => navigation.navigate('AdminLogin')}
            activeOpacity={0.7}
          >
            <Text style={s.adminLoginText}>Admin Login</Text>
          </TouchableOpacity>
        )}

        <View style={{ height: 30 }} />
      </ScrollView>
    </View>
  );
};

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F1F5F9',
  },

  // ── Dark top ──
  darkSection: {
    backgroundColor: '#0F2439',
  },
  safeTop: {
    paddingHorizontal: 20,
    paddingBottom: 20,
  },

  // Admin badge
  adminBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: 4,
    marginBottom: 4,
  },
  adminBadgeText: {
    color: '#F87171',
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 1.5,
  },
  adminLogout: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
  },
  adminLogoutText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    fontWeight: '600',
  },

  // Hero
  hero: {
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 14,
  },
  heroLabel: {
    fontSize: 26,
    fontWeight: 'bold',
    color: '#60A5FA',
    marginBottom: 4,
  },
  heroTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    marginBottom: 6,
  },
  heroSub: {
    fontSize: 12.5,
    color: 'rgba(255,255,255,0.45)',
    lineHeight: 18,
    textAlign: 'center',
  },

  // Status bar (dark themed)
  statusBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  statusItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  statusLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.45)',
    marginTop: 3,
    textAlign: 'center',
  },
  statusDivider: {
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginVertical: 2,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginBottom: 2,
  },

  // ── Light bottom ──
  lightSection: {
    flex: 1,
    backgroundColor: '#F1F5F9',
  },
  lightContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
  },

  // Section title
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 12,
    letterSpacing: 0.3,
  },

  // Quick actions — list with accent bar
  grid: {
    marginBottom: 20,
  },
  actionCard: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginBottom: 10,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  actionAccent: {
    width: 4,
  },
  actionBody: {
    flex: 1,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  actionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 3,
  },
  actionDesc: {
    fontSize: 12,
    color: '#64748B',
    lineHeight: 17,
  },

  // Safety tip
  tipCard: {
    backgroundColor: '#FFFBEB',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#FDE68A',
    marginBottom: 16,
  },
  tipLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#92400E',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  tipText: {
    fontSize: 13,
    color: '#78350F',
    lineHeight: 20,
  },

  // Admin login
  adminLogin: {
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
  },
  adminLoginText: {
    color: '#64748B',
    fontSize: 13,
    fontWeight: '600',
  },

  // AI model status card
  aiCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    borderLeftWidth: 4,
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 2,
  },
  aiCardBody: {
    padding: 16,
  },
  aiCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 4,
  },
  aiCardSubtitle: {
    fontSize: 12,
    color: '#64748B',
    lineHeight: 17,
    marginBottom: 12,
  },
  aiProgressTrack: {
    height: 6,
    backgroundColor: '#E2E8F0',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 4,
  },
  aiProgressFill: {
    height: '100%',
    borderRadius: 3,
  },
  aiCardButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: 4,
  },
  aiCardButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
});

export default HomeScreen;
