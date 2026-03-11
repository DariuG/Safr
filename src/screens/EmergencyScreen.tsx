import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Platform,
} from 'react-native';

// --- TYPES ---
interface EmergencyPlan {
  id: string;
  title: string;
  icon: string;
  shortDescription: string;
  steps: string[];
  importantNote?: string;
}

interface EmergencyCategory {
  id: string;
  title: string;
  icon: string;
  color: string;
  plans: EmergencyPlan[];
}

// --- MOCK DATA ---
const EMERGENCY_CATEGORIES: EmergencyCategory[] = [
  {
    id: 'natural',
    title: 'Dezastre Naturale',
    icon: '🌍',
    color: '#E67E22',
    plans: [
      {
        id: 'earthquake',
        title: 'Cutremur',
        icon: '🏚️',
        shortDescription: 'Ce să faci în timpul unui cutremur',
        steps: [
          'Adăpostește-te sub o masă solidă sau lângă un perete interior',
          'Stai departe de ferestre, oglinzi și mobilier înalt',
          'Dacă ești afară, îndepărtează-te de clădiri și cabluri electrice',
          'Dacă ești în mașină, oprește în siguranță și stai înăuntru',
          'După cutremur, verifică rănirile și evacuează dacă e necesar',
        ],
        importantNote: 'NU alerga afară în timpul cutremurului!',
      },
      {
        id: 'flood',
        title: 'Inundație',
        icon: '🌊',
        shortDescription: 'Cum să te protejezi de inundații',
        steps: [
          'Urmărește alertele meteo și evacuează din timp dacă e necesar',
          'Mută-te la etajele superioare ale clădirii',
          'NU merge prin apă în mișcare - 15cm pot să te doboare',
          'Evită podurile peste ape repezi',
          'După inundație, nu consuma apă de la robinet până la aprobare',
        ],
        importantNote: 'Apa în mișcare este extrem de periculoasă!',
      },
      {
        id: 'fire_wildfire',
        title: 'Incendiu de Vegetație',
        icon: '🔥',
        shortDescription: 'Evacuare și protecție la incendii',
        steps: [
          'Evacuează imediat zona dacă autoritățile cer acest lucru',
          'Închide toate ferestrele și ușile casei',
          'Îndepărtează materialele inflamabile din jurul casei',
          'Dacă ești blocat, caută o zonă fără vegetație',
          'Acoperă-ți gura și nasul cu material umed',
        ],
      },
      {
        id: 'storm',
        title: 'Furtună Severă',
        icon: '⛈️',
        shortDescription: 'Siguranță în timpul furtunilor',
        steps: [
          'Adăpostește-te într-o clădire solidă',
          'Stai departe de ferestre și uși de sticlă',
          'Deconectează aparatele electrice',
          'Evită să folosești telefonul fix în timpul furtunii',
          'Dacă ești afară, stai departe de copaci și stâlpi',
        ],
      },
    ],
  },
  {
    id: 'medical',
    title: 'Urgențe Medicale',
    icon: '🏥',
    color: '#E74C3C',
    plans: [
      {
        id: 'cardiac_arrest',
        title: 'Stop Cardiac',
        icon: '❤️',
        shortDescription: 'Resuscitare cardio-pulmonară (RCP)',
        steps: [
          'Verifică dacă persoana răspunde - strigă și scutură ușor',
          'Sună la 112 imediat',
          'Începe compresiile toracice: 30 compresii, 5-6cm adâncime',
          'Dacă știi, fă 2 respirații gură-la-gură după 30 compresii',
          'Continuă până vine ambulanța sau persoana își revine',
        ],
        importantNote: 'Ritmul compresiilor: 100-120 pe minut!',
      },
      {
        id: 'choking',
        title: 'Înec cu Alimente',
        icon: '😮',
        shortDescription: 'Manevra Heimlich pentru sufocare',
        steps: [
          'Întreabă persoana dacă se sufocă - dacă nu poate vorbi, acționează',
          'Poziționează-te în spatele persoanei',
          'Pune pumnul deasupra buricului, sub stern',
          'Execută 5 compresii abdominale rapide, în sus',
          'Repetă până obiectul este expulzat',
        ],
        importantNote: 'La copii sub 1 an, tehnica este diferită!',
      },
      {
        id: 'burns',
        title: 'Arsuri',
        icon: '🔥',
        shortDescription: 'Primul ajutor pentru arsuri',
        steps: [
          'Îndepărtează sursa de căldură și hainele afectate',
          'Răcește arsura cu apă rece 10-20 minute',
          'NU aplica gheață, unt sau pastă de dinți',
          'Acoperă cu un bandaj steril, fără a presa',
          'Pentru arsuri grave (față, mâini, mari), sună la 112',
        ],
      },
      {
        id: 'bleeding',
        title: 'Hemoragie Severă',
        icon: '🩸',
        shortDescription: 'Oprirea sângerărilor grave',
        steps: [
          'Apasă ferm pe rană cu un material curat',
          'Menține presiunea constantă minimum 10 minute',
          'Ridică membrul afectat deasupra nivelului inimii',
          'Dacă sângerarea nu se oprește, aplică un garou deasupra rănii',
          'Sună la 112 pentru hemoragii severe',
        ],
        importantNote: 'NU scoate obiectele înfipte în rană!',
      },
    ],
  },
  {
    id: 'safety',
    title: 'Siguranță Personală',
    icon: '🛡️',
    color: '#3498DB',
    plans: [
      {
        id: 'home_fire',
        title: 'Incendiu în Casă',
        icon: '🏠',
        shortDescription: 'Evacuare în caz de incendiu',
        steps: [
          'Alertează toți membrii familiei',
          'Părăsește imediat clădirea - NU încerca să iei lucruri',
          'Verifică ușile înainte să le deschizi - dacă sunt fierbinți, nu deschide',
          'Mergi aplecat pentru a evita fumul',
          'Întâlnește-vă la punctul de adunare prestabilit',
        ],
        importantNote: 'NU te întoarce în clădire sub nicio formă!',
      },
      {
        id: 'gas_leak',
        title: 'Scurgere de Gaz',
        icon: '💨',
        shortDescription: 'Ce să faci când simți miros de gaz',
        steps: [
          'NU aprinde lumina și NU folosi întrerupătoare',
          'Deschide imediat ferestrele',
          'Închide robinetul de gaz dacă e accesibil',
          'Evacuează clădirea',
          'Sună la 112 sau distribuitor de gaz de afară',
        ],
        importantNote: 'NU folosi telefonul în interior!',
      },
      {
        id: 'car_accident',
        title: 'Accident Rutier',
        icon: '🚗',
        shortDescription: 'Pași de urmat la un accident',
        steps: [
          'Oprește motorul și pornește luminile de avarie',
          'Verifică dacă tu și pasagerii sunteți răniți',
          'Sună la 112 dacă sunt răniți sau pagube mari',
          'Pune triunghiul reflectorizant la 50m în spate',
          'Fă poze la locul accidentului și schimbă date cu celălalt șofer',
        ],
      },
      {
        id: 'power_outage',
        title: 'Pană de Curent',
        icon: '🔦',
        shortDescription: 'Gestionarea unei pene de curent',
        steps: [
          'Verifică dacă e pană locală sau generală',
          'Deconectează aparatele sensibile pentru a evita supratensiunea',
          'Folosește lanterne, nu lumânări (risc incendiu)',
          'Păstrează frigiderul închis pentru a menține frigul',
          'Raportează pana la distribuitor dacă durează',
        ],
      },
    ],
  },
];

// --- COMPONENT ---
const EmergencyScreen = () => {
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);

  const togglePlan = (planId: string) => {
    setExpandedPlan(expandedPlan === planId ? null : planId);
  };

  const renderPlanCard = (plan: EmergencyPlan, categoryColor: string) => {
    const isExpanded = expandedPlan === plan.id;

    return (
      <TouchableOpacity
        key={plan.id}
        style={[styles.planCard, isExpanded && styles.planCardExpanded]}
        onPress={() => togglePlan(plan.id)}
        activeOpacity={0.7}
      >
        <View style={styles.planHeader}>
          <Text style={styles.planIcon}>{plan.icon}</Text>
          <View style={styles.planTitleContainer}>
            <Text style={styles.planTitle}>{plan.title}</Text>
            <Text style={styles.planDescription}>{plan.shortDescription}</Text>
          </View>
          <Text style={styles.expandIcon}>{isExpanded ? '▲' : '▼'}</Text>
        </View>

        {isExpanded && (
          <View style={styles.planContent}>
            {plan.importantNote && (
              <View style={[styles.importantNote, { backgroundColor: categoryColor + '20' }]}>
                <Text style={[styles.importantNoteText, { color: categoryColor }]}>
                  ⚠️ {plan.importantNote}
                </Text>
              </View>
            )}

            <Text style={styles.stepsTitle}>Pași de urmat:</Text>
            {plan.steps.map((step, index) => (
              <View key={index} style={styles.stepItem}>
                <View style={[styles.stepNumber, { backgroundColor: categoryColor }]}>
                  <Text style={styles.stepNumberText}>{index + 1}</Text>
                </View>
                <Text style={styles.stepText}>{step}</Text>
              </View>
            ))}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  const renderCategory = (category: EmergencyCategory) => {
    return (
      <View key={category.id} style={styles.categoryContainer}>
        <View style={[styles.categoryHeader, { backgroundColor: category.color }]}>
          <Text style={styles.categoryIcon}>{category.icon}</Text>
          <Text style={styles.categoryTitle}>{category.title}</Text>
        </View>

        <View style={styles.plansContainer}>
          {category.plans.map((plan) => renderPlanCard(plan, category.color))}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.screenTitle}>Ghid de Urgență</Text>
        <Text style={styles.screenSubtitle}>
          Planuri de acțiune pentru situații de urgență
        </Text>

        {EMERGENCY_CATEGORIES.map(renderCategory)}

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            În caz de urgență, sună la 112
          </Text>
        </View>
      </ScrollView>
    </View>
  );
};

// --- STYLES ---
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: Platform.OS === 'ios' ? 70 : 50,
    paddingBottom: 100,
    paddingHorizontal: 15,
  },
  screenTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#1a1a1a',
    marginBottom: 5,
    textAlign: 'center',
  },
  screenSubtitle: {
    fontSize: 14,
    color: '#666',
    marginBottom: 20,
    textAlign: 'center',
  },

  // Category
  categoryContainer: {
    marginBottom: 20,
    borderRadius: 12,
    backgroundColor: 'white',
    overflow: 'hidden',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 15,
  },
  categoryIcon: {
    fontSize: 24,
    marginRight: 10,
  },
  categoryTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: 'white',
  },

  // Plans
  plansContainer: {
    padding: 10,
  },
  planCard: {
    backgroundColor: '#FAFAFA',
    borderRadius: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  planCardExpanded: {
    backgroundColor: 'white',
    borderColor: '#CCC',
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  planIcon: {
    fontSize: 28,
    marginRight: 12,
  },
  planTitleContainer: {
    flex: 1,
  },
  planTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  planDescription: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  expandIcon: {
    fontSize: 12,
    color: '#999',
    marginLeft: 10,
  },

  // Plan content
  planContent: {
    paddingHorizontal: 12,
    paddingBottom: 15,
    borderTopWidth: 1,
    borderTopColor: '#EEE',
    marginTop: 5,
    paddingTop: 12,
  },
  importantNote: {
    padding: 10,
    borderRadius: 8,
    marginBottom: 12,
  },
  importantNoteText: {
    fontSize: 13,
    fontWeight: '600',
  },
  stepsTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginBottom: 10,
  },
  stepItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  stepNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    marginTop: 2,
  },
  stepNumberText: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold',
  },
  stepText: {
    flex: 1,
    fontSize: 14,
    color: '#444',
    lineHeight: 20,
  },

  // Footer
  footer: {
    alignItems: 'center',
    paddingVertical: 20,
    marginTop: 10,
  },
  footerText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#E74C3C',
  },
});

export default EmergencyScreen;
