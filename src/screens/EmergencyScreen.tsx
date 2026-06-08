import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Animated,
  LayoutAnimation,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import {
  EMERGENCY_CATEGORIES,
  EmergencyPlan,
  EmergencyCategory,
} from '../data/emergencyGuides';

// --- CHEVRON ANIMAT (reutilizat la categorii și planuri) ---
interface ChevronProps {
  expanded: boolean;
  color?: string;
  size?: number;
}

const Chevron: React.FC<ChevronProps> = ({
  expanded,
  color = '#94A3B8',
  size = 22,
}) => {
  const rotate = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotate, {
      toValue: expanded ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [expanded, rotate]);

  const rotation = rotate.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });

  return (
    <Animated.View style={{ transform: [{ rotate: rotation }] }}>
      <MaterialCommunityIcons name="chevron-down" size={size} color={color} />
    </Animated.View>
  );
};

// --- RÂND DE PLAN (situație concretă, expandabilă pentru pași) ---
interface PlanRowProps {
  plan: EmergencyPlan;
  color: string;
  isExpanded: boolean;
  isFirst: boolean;
  onToggle: () => void;
}

const PlanRow: React.FC<PlanRowProps> = ({
  plan,
  color,
  isExpanded,
  isFirst,
  onToggle,
}) => {
  return (
    <View style={[styles.planRow, !isFirst && styles.planRowDivider]}>
      <TouchableOpacity
        style={styles.planRowHeader}
        onPress={onToggle}
        activeOpacity={0.6}>
        <View style={[styles.planIconChip, { backgroundColor: color + '14' }]}>
          <MaterialCommunityIcons name={plan.icon} size={20} color={color} />
        </View>
        <View style={styles.planTitleContainer}>
          <Text style={styles.planTitle}>{plan.title}</Text>
          <Text style={styles.planDescription}>{plan.shortDescription}</Text>
        </View>
        <Chevron expanded={isExpanded} size={20} />
      </TouchableOpacity>

      {isExpanded && (
        <View style={styles.planContent}>
          {plan.importantNote && (
            <View
              style={[
                styles.importantNote,
                { backgroundColor: color + '12', borderLeftColor: color },
              ]}>
              <MaterialCommunityIcons
                name="alert"
                size={18}
                color={color}
                style={styles.importantNoteIcon}
              />
              <Text style={[styles.importantNoteText, { color }]}>
                {plan.importantNote}
              </Text>
            </View>
          )}

          <Text style={styles.stepsTitle}>Pași de urmat</Text>
          {plan.steps.map((step, index) => (
            <View key={index} style={styles.stepItem}>
              <View style={[styles.stepNumber, { backgroundColor: color }]}>
                <Text style={styles.stepNumberText}>{index + 1}</Text>
              </View>
              <Text style={styles.stepText}>{step}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
};

// --- CARD DE CATEGORIE (drop-down) ---
interface CategoryCardProps {
  category: EmergencyCategory;
  isOpen: boolean;
  openPlan: string | null;
  onToggleCategory: () => void;
  onTogglePlan: (planId: string) => void;
}

const CategoryCard: React.FC<CategoryCardProps> = ({
  category,
  isOpen,
  openPlan,
  onToggleCategory,
  onTogglePlan,
}) => {
  return (
    <View style={styles.categoryCard}>
      <TouchableOpacity
        style={styles.categoryHeader}
        onPress={onToggleCategory}
        activeOpacity={0.7}>
        <View
          style={[
            styles.categoryIconChip,
            { backgroundColor: category.color + '14' },
          ]}>
          <MaterialCommunityIcons
            name={category.icon}
            size={22}
            color={category.color}
          />
        </View>
        <Text style={styles.categoryTitle}>{category.title}</Text>
        <Text style={styles.categoryCount}>{category.plans.length}</Text>
        <Chevron expanded={isOpen} />
      </TouchableOpacity>

      {isOpen && (
        <View style={styles.categoryBody}>
          {category.plans.map((plan, index) => (
            <PlanRow
              key={plan.id}
              plan={plan}
              color={category.color}
              isFirst={index === 0}
              isExpanded={openPlan === plan.id}
              onToggle={() => onTogglePlan(plan.id)}
            />
          ))}
        </View>
      )}
    </View>
  );
};

// --- ECRAN ---
const EmergencyScreen = () => {
  const insets = useSafeAreaInsets();
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [openPlan, setOpenPlan] = useState<string | null>(null);

  const toggleCategory = (categoryId: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenCategory(prev => (prev === categoryId ? null : categoryId));
  };

  const togglePlan = (planId: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenPlan(prev => (prev === planId ? null : planId));
  };

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + 16 },
        ]}
        showsVerticalScrollIndicator={false}>
        <Text style={styles.screenTitle}>Ghid de urgență</Text>
        <Text style={styles.screenSubtitle}>
          Planuri de acțiune pentru situații critice
        </Text>

        {EMERGENCY_CATEGORIES.map(category => (
          <CategoryCard
            key={category.id}
            category={category}
            isOpen={openCategory === category.id}
            openPlan={openPlan}
            onToggleCategory={() => toggleCategory(category.id)}
            onTogglePlan={togglePlan}
          />
        ))}

        <TouchableOpacity
          style={styles.callButton}
          activeOpacity={0.85}
          onPress={() => Linking.openURL('tel:112')}>
          <MaterialCommunityIcons name="phone" size={20} color="#FFFFFF" />
          <Text style={styles.callButtonText}>Sună la 112</Text>
        </TouchableOpacity>
        <Text style={styles.footerHint}>
          Numărul unic de urgență, disponibil non-stop.
        </Text>
      </ScrollView>
    </View>
  );
};

// --- STILURI ---
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F1F5F9',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 130,
    paddingHorizontal: 18,
  },
  screenTitle: {
    fontSize: 30,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.5,
    textAlign: 'center',
  },
  screenSubtitle: {
    fontSize: 15,
    color: '#64748B',
    marginTop: 4,
    marginBottom: 24,
    textAlign: 'center',
  },

  // Card categorie (drop-down)
  categoryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#E8EDF3',
    overflow: 'hidden',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  categoryIconChip: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  categoryTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '700',
    color: '#0F172A',
  },
  categoryCount: {
    fontSize: 13,
    fontWeight: '700',
    color: '#94A3B8',
    backgroundColor: '#F1F5F9',
    overflow: 'hidden',
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 2,
    marginRight: 10,
  },
  categoryBody: {
    paddingHorizontal: 16,
    paddingBottom: 6,
  },

  // Rând plan (situație)
  planRow: {
    paddingVertical: 2,
  },
  planRowDivider: {
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  planRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
  },
  planIconChip: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 13,
  },
  planTitleContainer: {
    flex: 1,
  },
  planTitle: {
    fontSize: 15.5,
    fontWeight: '700',
    color: '#0F172A',
  },
  planDescription: {
    fontSize: 12.5,
    color: '#64748B',
    marginTop: 2,
  },

  // Conținut extins (pași)
  planContent: {
    paddingBottom: 14,
    paddingLeft: 2,
  },
  importantNote: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    borderLeftWidth: 3,
    marginBottom: 16,
  },
  importantNoteIcon: {
    marginRight: 9,
  },
  importantNoteText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 19,
  },
  stepsTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 12,
  },
  stepItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  stepNumber: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    marginTop: 1,
  },
  stepNumberText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  stepText: {
    flex: 1,
    fontSize: 14.5,
    color: '#334155',
    lineHeight: 21,
  },

  // Buton 112
  callButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DC2626',
    borderRadius: 16,
    paddingVertical: 16,
    marginTop: 4,
    shadowColor: '#DC2626',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  callButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    marginLeft: 9,
  },
  footerHint: {
    textAlign: 'center',
    fontSize: 12.5,
    color: '#94A3B8',
    marginTop: 12,
  },
});

export default EmergencyScreen;