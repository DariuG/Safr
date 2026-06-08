import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initLlama, releaseAllLlama } from 'llama.rn';
import ProgressBar from '../components/ProgressBar';
import {
  loadKnowledgeBase,
  retrieveRelevantContext,
  formatContextForPrompt,
  type KnowledgeEntry
} from '../utils/rag';
import modelManager, {
  ModelManagerStatus,
  LLM_FILE,
} from '../services/modelManager';


type Message = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

// Prefix nomic-embed-text-v1.5 pentru queries (retrieval asimetric).
// KB-ul a fost embedat cu "search_document: " — vezi
// Creating_Data_For_RAG/build_knowledge_base_embed_from_json.py.
// Cele două prefixe trebuie să rămână în sincron; dacă unul se schimbă
// fără celălalt, spațiile de embedding nu se mai aliniază și similaritățile
// devin haotice (problema cu "prim ajutor" diluând signal-ul AVC).
const QUERY_PREFIX = 'search_query: ';

/**
 * Trei puncte care pulsează secvențial — indicator de tip "typing" afișat
 * în bula asistentului cât timp se procesează un răspuns. Pur vizual.
 */
const TypingDots = () => {
  const dots = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;

  useEffect(() => {
    const animations = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(dot, {
            toValue: 1,
            duration: 320,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0,
            duration: 320,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    animations.forEach(a => a.start());
    return () => animations.forEach(a => a.stop());
  }, [dots]);

  return (
    <View style={styles.typingDotsRow}>
      {dots.map((dot, i) => (
        <Animated.View
          key={i}
          style={[
            styles.typingDot,
            {
              opacity: dot.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
              transform: [
                { translateY: dot.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
};

// Prag de hard-reject pentru retrieval RAG. Sub această valoare, query-ul e
// considerat în afara domeniului → răspuns standard "sună la 112" fără a chema
// LLM-ul. ATENȚIE: necesită recalibrare pe device fizic (vezi ToDo 2bis.1) —
// după adăugarea prefixelor nomic, valoarea 0.60 e prea permisivă (lasă OOD
// să treacă). Sursă unică de adevăr — folosită în handleTestScores (label
// PASS/fail), handleSendMessage (reject) și debug card UI.
const RAG_THRESHOLD = 0.6;

// Lungime minimă query (caractere + cuvinte) sub care cerem reformulare.
// Query-uri foarte scurte ("salut", "ce faci") produc embedding-uri ambigue
// care se potrivesc întâmplător cu patternuri scurte din KB.
const MIN_QUERY_CHARS = 15;
const MIN_QUERY_WORDS = 3;

// Persistența istoricului de chat. Salvăm doar ultimele N mesaje (fără mesajul
// de sistem, care se reconstruiește), pentru a supraviețui navigării între
// ecrane și reporniri ale aplicației.
const CHAT_HISTORY_KEY = '@safr_chat_history';
const MAX_PERSISTED_MESSAGES = 20;

const ChatScreen = () => {

	// System prompt: instrucțiunile sunt în engleză (Llama 3.2 1B Instruct urmează
	// instrucțiunile mai strict pe EN), dar modelul e instruit explicit să răspundă
	// EXCLUSIV în limba română. KB-ul este în română, deci contextul injectat va
	// fi tot RO și modelul poate copia/parafraza direct.
	const INITIAL_CONVERSATION: Message[] = [
		{
			role: 'system',
			content:
				'You are a Romanian-speaking first-aid emergency assistant.\n\n' +
				'CRITICAL RULES:\n' +
				'- Respond ONLY in Romanian language. Never use English in your answers.\n' +
				'- Use ONLY information from the CONTEXT section below. Do not invent medical advice.\n' +
				'- If the CONTEXT does not contain the answer, reply in Romanian: "Nu am informații despre această situație. Sună la 112 pentru ajutor profesionist."\n' +
				'- Be concise and clear. Use numbered steps for procedures.\n' +
				'- Always remind to call 112 in serious emergencies.\n' +
				'- Answer in 2-6 sentences maximum unless the user asks for detailed steps.',
		},
	];

	const [conversation, setConversation] = useState<Message[]>(INITIAL_CONVERSATION);
	const [userInput, setUserInput] = useState<string>('');
	const [context, setContext] = useState<any>(null);
	const [embeddingContext, setEmbeddingContext] = useState<any>(null);
	const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeEntry[]>([]);
	const [isGenerating, setIsGenerating] = useState<boolean>(false);
	const [isInitializing, setIsInitializing] = useState<boolean>(false);
	// Faza curentă a unui răspuns în curs, pentru indicatorul cu mesaj:
	//  - 'searching'  → embedding + retrieval RAG ("caută informații")
	//  - 'generating' → inferență LLM ("scrie răspunsul")
	const [genPhase, setGenPhase] = useState<'idle' | 'searching' | 'generating'>('idle');
	// Textul răspunsului în curs de streaming (token-cu-token). Ținut separat de
	// `conversation` ca să nu re-randăm întreaga listă la fiecare token — doar
	// bula de streaming se actualizează; la final, textul e mutat în conversation.
	const [streamingText, setStreamingText] = useState<string>('');
	// DEV: rezultat al testului de similaritate pure (fără LLM). De ascuns/scos înainte de release.
	const [debugResult, setDebugResult] = useState<{
		query: string;
		topMatches: Array<{ tag: string; score: number; pattern: string; response: string }>;
	} | null>(null);
	const [isTesting, setIsTesting] = useState<boolean>(false);
	const [modelState, setModelState] = useState<ModelManagerStatus>(modelManager.getStatus());
	const [loadError, setLoadError] = useState<string | null>(null);
	// Guard împotriva retry-ului automat infinit dacă initLlama eșuează.
	// Resetat la true doar prin tap pe "Reîncearcă".
	const loadAttemptedRef = React.useRef(false);
	const scrollViewRef = React.useRef<ScrollView>(null);
	// Devine true după ce istoricul persistat a fost încărcat — previne
	// salvarea (și suprascrierea) înainte ca load-ul să termine.
	const historyLoadedRef = React.useRef(false);
	// Tastatura deschisă? Folosit pentru a reduce padding-ul de jos (rezervat
	// barei de taburi) când tastatura e vizibilă, ca input-ul să stea lipit
	// de aceasta. Bara de taburi e ascunsă automat prin tabBarHideOnKeyboard.
	const [keyboardVisible, setKeyboardVisible] = useState<boolean>(false);

	// File constants — sursă de adevăr e modelManager
	const MODEL_FORMAT = LLM_FILE;


  // Subscribe la modelManager — download-ul rulează central, ChatScreen doar reacționează
  useEffect(() => {
    const unsubscribe = modelManager.subscribe(setModelState);
    return unsubscribe;
  }, []);

  // Încarcă istoricul persistat la montare (o singură dată).
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(CHAT_HISTORY_KEY);
        if (raw) {
          const saved: Message[] = JSON.parse(raw);
          if (Array.isArray(saved) && saved.length > 0) {
            // Reconstruim conversația: mesajul de sistem + istoricul salvat.
            setConversation([INITIAL_CONVERSATION[0], ...saved]);
          }
        }
      } catch (e) {
        console.warn('[ChatScreen] Failed to load chat history:', e);
      } finally {
        historyLoadedRef.current = true;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Salvează istoricul (ultimele N mesaje, fără system) la fiecare schimbare.
  // Guard-ul historyLoadedRef previne suprascrierea înainte de load.
  useEffect(() => {
    if (!historyLoadedRef.current) return;
    const messages = conversation.slice(1).slice(-MAX_PERSISTED_MESSAGES);
    AsyncStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(messages)).catch(e =>
      console.warn('[ChatScreen] Failed to save chat history:', e),
    );
  }, [conversation]);

  // Tracking tastatură pentru ajustarea padding-ului input-ului
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, () => setKeyboardVisible(true));
    const hideSub = Keyboard.addListener(hideEvt, () => setKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // DEV: rulează DOAR embedding + retrieval, fără LLM. Returnează scorurile top 5
  // direct în UI, pentru a testa calitatea retrieval-ului rapid (~10ms inferență).
  const handleTestScores = async () => {
    if (!embeddingContext) {
      Alert.alert('Embedding nu e gata', 'Modelul de embedding nu este încărcat încă.');
      return;
    }
    if (!userInput.trim() || knowledgeBase.length === 0) {
      return;
    }

    const queryText = userInput.trim();
    setIsTesting(true);

    try {
      // Folosim embedQueryFresh care recreează contextul intern pentru fiecare
      // call — necesar pentru a evita KV cache pollution între apeluri
      // consecutive (vezi comentariile la embedQueryFresh).
      const queryEmbedding = await embedQueryFresh(queryText);

      // Calculează scorul pentru fiecare entry din KB
      const allScores = knowledgeBase
        .map(entry => ({
          tag: entry.tag,
          pattern: entry.pattern,
          response: entry.response,
          score: 0, // umplut mai jos
        }));

      for (let i = 0; i < knowledgeBase.length; i++) {
        const entry = knowledgeBase[i];
        let dot = 0, na = 0, nb = 0;
        for (let j = 0; j < queryEmbedding.length; j++) {
          dot += queryEmbedding[j] * entry.embedding[j];
          na += queryEmbedding[j] * queryEmbedding[j];
          nb += entry.embedding[j] * entry.embedding[j];
        }
        allScores[i].score = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
      }

      // Top 5 sortate descrescător
      const top = allScores
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      setDebugResult({ query: queryText, topMatches: top });

      // Log curat în Metro pentru copy-paste rapid
      const lines = [
        '',
        '═══════════════════════════════════════════',
        `🔍 Q: ${queryText}`,
        '═══════════════════════════════════════════',
        ...top.map((m, i) => {
          const pct = (m.score * 100).toFixed(1).padStart(5, ' ');
          const status = m.score >= RAG_THRESHOLD ? 'PASS' : 'fail';
          return `  ${i + 1}. ${pct}% [${m.tag}]  ${status}`;
        }),
        '═══════════════════════════════════════════',
        '',
      ];
      console.log(lines.join('\n'));
    } catch (err) {
      console.warn('[DEV] handleTestScores error:', err);
      Alert.alert('Eroare', err instanceof Error ? err.message : 'Eroare necunoscută');
    } finally {
      setIsTesting(false);
    }
  };

  const handleSendMessage = async () => {
    // Check if context is loaded and user input is valid
    if (!context) {
      Alert.alert('Modelul nu este încărcat', 'Așteaptă finalizarea descărcării modelului AI.');
      return;
    }

    if (!userInput.trim()) {
      Alert.alert('Mesaj gol', 'Te rog scrie o întrebare.');
      return;
    }

    const userMessage = userInput.trim();
    setIsGenerating(true);
    setGenPhase('searching');
    setStreamingText('');
    setUserInput('');

    // Guard pe lungime minimă — query-uri foarte scurte ("salut", "ce faci")
    // produc embedding-uri ambigue care se potrivesc întâmplător cu patternuri
    // scurte din KB. Le respingem ÎNAINTE de embedding+LLM (economisim 1-3 min
    // pe device fizic) și cerem reformulare. Mesajul user-ului tot se afișează,
    // dar răspunsul e o cerere de detaliere, nu un apel LLM.
    const wordCount = userMessage.split(/\s+/).filter(Boolean).length;
    if (userMessage.length < MIN_QUERY_CHARS || wordCount < MIN_QUERY_WORDS) {
      setConversation(prev => [
        ...prev,
        { role: 'user', content: userMessage },
        {
          role: 'assistant',
          content:
            'Te rog descrie situația în câteva cuvinte ca să te pot ajuta corect — de exemplu: "Cineva are dureri puternice în piept" sau "Cum opresc o sângerare la mână".',
        },
      ]);
      setIsGenerating(false);
      setGenPhase('idle');
      return;
    }

    try {
      // Generate embedding for the user query
      let retrievedContext = '';
      
      if (knowledgeBase.length > 0 && embeddingContext) {
        try {
          // Prefix `search_query: ` cerut de nomic-embed-v1.5. embedQueryFresh
          // aplică prefix-ul automat și recreează contextul intern (vezi
          // comentariile la embedQueryFresh).
          const queryEmbedding = await embedQueryFresh(userMessage);

          if (queryEmbedding.length !== knowledgeBase[0].embedding.length) {
            console.warn(
              `Embedding dimension mismatch: query=${queryEmbedding.length} vs KB=${knowledgeBase[0].embedding.length} — skipping RAG`,
            );
          } else {
            // Top-2 (nu 5) ca să evităm umplerea n_ctx cu 3000+ tokeni de
            // context, ceea ce face procesarea prompt-ului inițial să dureze
            // minute pe device fizic. KB-ul are intent-uri lungi (~2500 char
            // fiecare) — 2 intent-uri ≈ 1200-1500 tokeni, lasă spațiu suficient
            // pentru system prompt + mesaj user + n_predict 512.
            const relevantEntries = retrieveRelevantContext(
              queryEmbedding,
              knowledgeBase,
              2,
              0.15,
            );

            // Threshold de hard-reject — vezi RAG_THRESHOLD.
            const bestScore = relevantEntries[0]?.score ?? 0;

            // Log minimal — array-uri mari prin Metro bridge sunt foarte
            // lente pe device fizic.
            console.log(
              `[RAG] best=${(bestScore * 100).toFixed(1)}% top=${
                relevantEntries[0]?.entry.tag ?? '—'
              }`,
            );

            if (bestScore < RAG_THRESHOLD) {
              setConversation(prev => [
                ...prev,
                {
                  role: 'assistant',
                  content:
                    'În caz de urgență, sună la 112!\n\nNu am informații despre acest subiect în baza mea de cunoștințe. Te rog sună la 112 (servicii de urgență) pentru ajutor profesionist.',
                },
              ]);
              setIsGenerating(false);
              setGenPhase('idle');
              return;
            }

            if (relevantEntries.length > 0) {
              retrievedContext = formatContextForPrompt(relevantEntries);
              console.log(
                `[RAG] context=${retrievedContext.length}ch from ${relevantEntries.length} entries`,
              );
            }
          }
        } catch (embeddingError) {
          console.warn('[RAG] embedding failed, continuing without context:', embeddingError);
        }
      } else if (!embeddingContext) {
        console.log('[RAG] embedding model not loaded, skipping');
      }

      // Build conversation with retrieved context injected into system message.
      // Context-ul e în română (KB RO), instrucțiunea finală rămâne în EN pentru
      // a fi urmărită strict de model (vezi system prompt INITIAL_CONVERSATION).
      let systemMessage = INITIAL_CONVERSATION[0].content;

      if (retrievedContext) {
        // Medical query with relevant context found
        systemMessage +=
          '\n\nCONTEXT (in Romanian):\n' +
          retrievedContext +
          '\n\nUse ONLY the information above to answer the user. Respond in Romanian.';
      } else {
        // No relevant context found - refuse to answer (model is instructed to reply in RO)
        systemMessage +=
          '\n\nCONTEXT:\nNo relevant information available.\n\n' +
          'Reply in Romanian that you do not have information about this topic and suggest calling 112.';
      }

      // Păstrăm doar ultimele 4 mesaje (2 schimburi) pentru a evita depășirea
      // ferestrei de context. Entry-urile RAG sunt lungi (~700 tokeni fiecare),
      // iar răspunsurile asistentului pot ajunge la 512 tokeni — un istoric prea
      // lung + 2 entries RAG + system prompt depășeau n_ctx și produceau eroarea
      // "context is full". Pentru first-aid, întrebările sunt în mare independente,
      // deci un istoric scurt e suficient. Sărim mesajul de sistem (index 0).
      const recentMessages = conversation.slice(1).slice(-4);

      const newConversation: Message[] = [
        { role: 'system', content: systemMessage },
        // Add only recent user/assistant messages
        ...recentMessages,
        { role: 'user', content: userMessage },
      ];

      // Update conversation state with user message
      setConversation(prev => [
        ...prev,
        {role: 'user', content: userMessage},
      ]);

      // Define stop words for all model formats
      const stopWords = [
        '</s>',
        '<|end|>',
        'user:',
        'assistant:',
        '<|im_end|>',
        '<|eot_id|>',
        '<|end▁of▁sentence|>',
        '<｜end▁of▁sentence｜>',
      ];

      // Indicatorul rămâne pe "caută informații" (faza searching) pe TOATĂ
      // durata de așteptare — embedding, retrieval ȘI procesarea prompt-ului de
      // către LLM (faza lungă, înainte de primul token). Comutăm la faza
      // "generating" abia când sosește PRIMUL token, moment în care textul
      // începe să curgă. Astfel mesajul de status e mereu vizibil, iar
      // tranziția la text e naturală.
      // Send to model with retrieved context, cu STREAMING token-cu-token.
      // Al doilea argument e un callback apelat la fiecare token nou; acumulăm
      // în `streamingText` (afișat live), fără a re-randa întreaga conversație.
      // n_predict: 512 = ~10-12 propoziții, suficient pentru first-aid.
      let accumulated = '';
      const result = await context.completion(
        {
          messages: newConversation,
          n_predict: 512,
          stop: stopWords,
        },
        (data: { token: string }) => {
          if (data?.token) {
            if (accumulated === '') {
              setGenPhase('generating'); // primul token → trecem la text live
            }
            accumulated += data.token;
            setStreamingText(accumulated);
          }
        },
      );

      // Textul final: preferăm acumulatul din streaming; fallback la result.text.
      const finalText = (accumulated || result?.text || '').trim();

      if (finalText) {
        setConversation(prev => [
          ...prev,
          {role: 'assistant', content: finalText},
        ]);
      } else {
        throw new Error('No response from the model.');
      }
    } catch (error) {
      // Handle errors during inference
      Alert.alert(
        'Eroare la generarea răspunsului',
        error instanceof Error ? error.message : 'A apărut o eroare necunoscută.',
      );
    } finally {
      setIsGenerating(false);
      setGenPhase('idle');
      setStreamingText('');
    }
  };


  const loadModel = async (modelName: string) => {
    setIsInitializing(true);
    try {
      const destPath = modelManager.getLLMPath();

      if (context) {
        await releaseAllLlama();
        setContext(null);
        setEmbeddingContext(null);
        setConversation(INITIAL_CONVERSATION);
      }

      // Load main LLM for chat.
      // n_threads: 4 — pe device-uri Android cu 6-8 cores, default-ul llama.rn
      // poate folosi doar 1 thread, ceea ce dă viteză de inferență sub
      // 5 tok/s. Cu 4 threads, ajungem la 15-25 tok/s pe procesoare moderne.
      // Mai mult de 4 nu ajută (Hermes + bridge devin bottleneck).
      // n_ctx: 4096 — KB-ul injectează 2 entry-uri lungi (~700 tokeni fiecare =
      // ~1400) + system (~250) + istoric (4 mesaje) + 512 rezervați răspunsului.
      // 2048 se dovedea prea mic și producea "context is full"; 4096 oferă marjă.
      // Cost: KV cache mai mare (mai mult RAM) — de validat pe device fizic.
      const llamaContext = await initLlama({
        model: destPath,
        use_mlock: true,
        n_ctx: 4096,
        n_threads: 4,
        n_gpu_layers: 1,
      });

      if (!llamaContext) {
        throw new Error('initLlama returned null');
      }

      setContext(llamaContext);
      setLoadError(null);

      // Load embedding model for RAG (in background)
      loadEmbeddingModel();

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Eroare necunoscută la inițializare';
      console.error('[ChatScreen] loadModel failed:', msg);
      setLoadError(msg);
      return false;
    } finally {
      setIsInitializing(false);
    }
  };

  // Tap pe "Reîncearcă" — initLlama a eșuat pe un fișier marcat ca 'ready',
  // ceea ce înseamnă fie fișier corupt (de obicei după download întrerupt
  // de backgrounding), fie incompatibilitate llama.rn. Doar re-apelarea
  // initLlama pe același fișier ar produce aceeași eroare în buclă, deci
  // forțăm un download proaspăt. useEffect-ul va re-declanșa loadModel
  // automat când llmStatus revine la 'ready' după descărcare.
  const retryLoadModel = () => {
    setLoadError(null);
    loadAttemptedRef.current = false;
    modelManager.redownloadLLM().catch(err => {
      console.warn('[ChatScreen] redownloadLLM failed:', err);
    });
  };

  // Embedding context cu state pollution între apeluri: a doua chemare a
  // embedding() pe același context returnează un vector "default" care dă
  // ~46% cosine sim cu orice entry din KB, indiferent de query (KV cache
  // nu se resetează corect între request-uri în llama.rn 0.8.0). Soluția:
  // ținem contextul într-un ref + îl recreăm la fiecare call (release +
  // initLlama proaspăt). Cost: ~500ms per query — acceptabil, garantează
  // determinism. Nu folosim state pentru context pentru că setState e
  // async și ar provoca race cu apeluri consecutive rapide.
  const embeddingReadyRef = React.useRef<boolean>(false);

  /**
   * Inițializează un context proaspăt de embedding și returnează vectorul
   * pentru textul dat. Apelantul NU trebuie să adauge prefix-ul nomic —
   * QUERY_PREFIX este aplicat aici.
   */
  const embedQueryFresh = async (rawText: string): Promise<number[]> => {
    if (!embeddingReadyRef.current) {
      throw new Error('Embedding model nu este disponibil încă');
    }

    const embeddingPath = modelManager.getEmbeddingPath();

    // Init context proaspăt pentru izolare totală de starea precedentă.
    // pooling_type: 1 = MEAN (cerut de nomic-embed-text-v1.5).
    // n_ctx: 2048 acoperă query-uri de până la ~1500 tokeni (mai mult decât
    // necesar pentru first-aid queries, dar evită truncări neașteptate).
    const embContext = await initLlama({
      model: embeddingPath,
      use_mlock: true,
      n_ctx: 2048,
      embedding: true,
      pooling_type: 'mean',
      n_gpu_layers: 1,
    });

    if (!embContext) {
      throw new Error('initLlama a returnat null pentru embedding context');
    }

    try {
      const { embedding } = await embContext.embedding(QUERY_PREFIX + rawText);
      return embedding;
    } finally {
      // Release imediat — nu păstrăm contextul între apeluri.
      // releaseAllLlama() ar fi ucis și contextul LLM-ului, deci folosim
      // release() per-instanță.
      await embContext.release().catch(err => {
        console.warn('[ChatScreen] embed context release failed:', err);
      });
    }
  };

  const loadEmbeddingModel = async () => {
    // Verificare validitate model fără păstrarea unui context persistent.
    // Facem un init-and-release o singură dată ca smoke test pentru a marca
    // embeddingReadyRef = true. Apoi fiecare query reinițializează prin
    // embedQueryFresh().
    try {
      if (modelManager.getStatus().embeddingStatus !== 'ready') {
        console.log('⚠️ Embedding model not ready yet. RAG will be disabled for now.');
        return;
      }

      console.log('📦 Validating embedding model (smoke test)...');

      const probe = await initLlama({
        model: modelManager.getEmbeddingPath(),
        use_mlock: true,
        n_ctx: 2048,
        embedding: true,
        pooling_type: 'mean',
        n_gpu_layers: 1,
      });

      if (!probe) {
        throw new Error('initLlama smoke test returned null');
      }

      await probe.release().catch(() => {});
      embeddingReadyRef.current = true;
      // Setăm un sentinel non-null pentru ca UI-ul să detecteze "embedding gata".
      // Valoarea reală a contextului NU mai este folosită — embedQueryFresh
      // creează unul proaspăt per call.
      setEmbeddingContext({ _ready: true });
      console.log('✅ Embedding model validated (per-call init mode)');
    } catch (error) {
      console.warn('⚠️ Failed to validate embedding model:', error);
      console.log('RAG will be disabled');
    }
  };

  // Load knowledge base on mount
  useEffect(() => {
    let mounted = true;

    const loadKB = async () => {
      try {
        const kb = await loadKnowledgeBase();
        if (mounted) {
          setKnowledgeBase(kb);
        }
      } catch (error) {
        console.error('Failed to load knowledge base:', error);
        Alert.alert(
          'Eroare bază de cunoștințe',
          'Nu s-a putut încărca baza de cunoștințe medicale. Funcțiile RAG vor fi dezactivate.',
        );
      }
    };

    loadKB();

    return () => {
      mounted = false;
    };
  }, []);

  // Auto-load Llama context când modelManager raportează LLM ready.
  // `loadAttemptedRef` previne retry-ul infinit dacă initLlama eșuează —
  // pe error rămâne true și useEffect-ul nu mai apelează loadModel,
  // doar tap pe "Reîncearcă" îl resetează.
  useEffect(() => {
    if (
      modelState.llmStatus === 'ready' &&
      !context &&
      !isInitializing &&
      !loadAttemptedRef.current
    ) {
      loadAttemptedRef.current = true;
      loadModel(MODEL_FORMAT);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelState.llmStatus, context, isInitializing, loadError]);

  	return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}>
      <ScrollView
        ref={scrollViewRef}
        contentContainerStyle={styles.scrollView}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}>
        <Text style={styles.title}>Asistent Safr</Text>
        {/* Stare LLM: descărcare în curs sau eroare → progress / retry card */}
        {modelState.llmStatus === 'downloading' && (
          <View style={styles.card}>
            <Text style={styles.subtitle}>Se descarcă modelul AI</Text>
            <Text style={styles.cardText}>
              {modelState.isCellular
                ? 'Descărcare pe date mobile în curs. Va dura câteva minute.'
                : 'Modelul AI medical offline (~800 MB) se descarcă. Va fi disponibil în câteva minute.'}
            </Text>
            <View style={{ marginTop: 12 }}>
              <ProgressBar progress={modelState.llmProgress} />
            </View>
            <Text style={[styles.cardText, { marginTop: 8, fontSize: 12, textAlign: 'center' }]}>
              {modelState.llmProgress}%
            </Text>
          </View>
        )}

        {modelState.llmStatus === 'copying' && (
          <View style={styles.card}>
            <Text style={styles.subtitle}>Inițializare AI</Text>
            <ActivityIndicator size="large" color="#2563EB" style={{ marginVertical: 12 }} />
          </View>
        )}

        {(modelState.llmStatus === 'missing' || modelState.llmStatus === 'error') && (
          <View style={styles.card}>
            <Text style={styles.subtitle}>AI offline indisponibil</Text>
            <Text style={styles.cardText}>
              {modelState.llmError || 'Modelul AI nu a fost descărcat încă.'}
            </Text>
            <TouchableOpacity
              style={styles.button}
              onPress={() => modelManager.startLLMDownload()}>
              <Text style={styles.buttonText}>Descarcă acum</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Stare LLM ready, încărcare context în curs */}
        {modelState.llmStatus === 'ready' && !context && !loadError && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#2563EB" />
            <Text style={styles.loadingText}>Inițializare model AI...</Text>
          </View>
        )}

        {/* Stare LLM ready, dar initLlama a eșuat */}
        {modelState.llmStatus === 'ready' && !context && loadError && (
          <View style={styles.card}>
            <Text style={styles.subtitle}>Eroare la încărcarea modelului</Text>
            <Text style={styles.cardText}>{loadError}</Text>
            <Text style={[styles.cardText, { marginTop: 8, fontSize: 12, fontStyle: 'italic' }]}>
              Cel mai probabil fișierul modelului este corupt (descărcare întreruptă).
              Reîncearcă pentru a-l șterge și descărca din nou (~800 MB).
            </Text>
            <TouchableOpacity style={styles.button} onPress={retryLoadModel}>
              <Text style={styles.buttonText}>Șterge și descarcă din nou</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Chat normal */}
        {context && (
          <View style={styles.chatContainer}>
            <Text style={styles.greetingText}>
              Asistentul tău AI pentru urgențe este gata. Cu ce te pot ajuta?
            </Text>

            {/* DEV: rezultatul ultimului test de scor (fără LLM) */}
            {debugResult && (
              <View style={styles.debugCard}>
                <View style={styles.debugHeader}>
                  <Text style={styles.debugTitle}>🔍 Test scor (fără LLM)</Text>
                  <TouchableOpacity onPress={() => setDebugResult(null)}>
                    <Text style={styles.debugClose}>✕</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.debugQuery} selectable>Q: {debugResult.query}</Text>
                {debugResult.topMatches.map((m, i) => {
                  const pct = (m.score * 100).toFixed(1);
                  const willPass = m.score >= RAG_THRESHOLD;
                  return (
                    <View key={i} style={styles.debugMatch}>
                      <Text style={styles.debugMatchHeader} selectable>
                        {i + 1}. <Text style={{ color: willPass ? '#16A34A' : '#DC2626', fontWeight: '700' }}>{pct}%</Text> [{m.tag}]
                      </Text>
                      <Text style={styles.debugPattern} selectable numberOfLines={2}>
                        Pattern: {m.pattern}
                      </Text>
                      {i === 0 && (
                        <Text style={styles.debugResponse} selectable numberOfLines={4}>
                          {m.response}
                        </Text>
                      )}
                    </View>
                  );
                })}
                <Text style={styles.debugHint}>
                  Verde = peste prag {(RAG_THRESHOLD * 100).toFixed(0)}% (intră în context LLM). Roșu = sub prag → mesaj "sună la 112". (Loguri detaliate în Metro console.)
                </Text>
              </View>
            )}

            {conversation.slice(1).map((msg, index) => (
              <View key={index} style={styles.messageWrapper}>
                <View
                  style={[
                    styles.messageBubble,
                    msg.role === 'user'
                      ? styles.userBubble
                      : styles.llamaBubble,
                  ]}>
                  <Text
                    style={[
                      styles.messageText,
                      msg.role === 'user' && styles.userMessageText,
                    ]}>
                    {msg.content}
                  </Text>
                </View>
              </View>
            ))}

            {/* Așteptare (embedding + retrieval + procesare prompt LLM) —
                vizibil până la primul token */}
            {genPhase === 'searching' && (
              <View style={styles.messageWrapper}>
                <View style={[styles.messageBubble, styles.llamaBubble, styles.statusRow]}>
                  <TypingDots />
                  <Text style={styles.statusText}>Asistentul tău caută informații…</Text>
                </View>
              </View>
            )}

            {/* Generare — text care curge token-cu-token */}
            {genPhase === 'generating' && streamingText !== '' && (
              <View style={styles.messageWrapper}>
                <View style={[styles.messageBubble, styles.llamaBubble]}>
                  <Text style={styles.messageText}>{streamingText}</Text>
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>
      {context && (
        <View style={[styles.inputContainer, keyboardVisible && styles.inputContainerKeyboard]}>
          <View style={styles.buttonRow}>
            <TextInput
              style={styles.input}
              placeholder="Scrie o întrebare…"
              placeholderTextColor="#94A3B8"
              value={userInput}
              onChangeText={setUserInput}
              multiline={true}
              maxLength={1000}
              returnKeyType="send"
              editable={!isGenerating}
              onSubmitEditing={handleSendMessage}
            />
            <TouchableOpacity
              style={[
                styles.testButton,
                (isTesting || isGenerating || !userInput.trim()) && styles.buttonDisabled,
              ]}
              onPress={handleTestScores}
              disabled={isTesting || isGenerating || !userInput.trim()}>
              <Text style={styles.testButtonText}>
                {isTesting ? '…' : '🔍'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.sendButton,
                (isGenerating || !userInput.trim()) && styles.buttonDisabled,
              ]}
              onPress={handleSendMessage}
              disabled={isGenerating || !userInput.trim()}>
              {isGenerating ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.buttonText}>Trimite</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  flex: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  loadingText: {
    marginTop: 10,
    fontSize: 16,
    color: '#64748B',
  },
  scrollView: {
    padding: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#1E293B',
    marginVertical: 24,
    textAlign: 'center',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    margin: 16,
    shadowColor: '#475569',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  subtitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#334155',
    marginBottom: 16,
    marginTop: 16,
  },
  subtitle2: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 16,
    color: '#93C5FD',
  },
  cardText: {
    fontSize: 14,
    color: '#64748B',
    marginBottom: 8,
  },
  button: {
    backgroundColor: '#93C5FD', // Lighter blue
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginVertical: 6,
    shadowColor: '#93C5FD', // Matching lighter shadow color
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.15, // Slightly reduced opacity for subtle shadows
    shadowRadius: 4,
    elevation: 2,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  selectedButton: {
    backgroundColor: '#2563EB',
  },
  buttonTextGGUF: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  chatContainer: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  messageWrapper: {
    marginBottom: 16,
  },
  messageBubble: {
    padding: 12,
    borderRadius: 12,
    maxWidth: '80%',
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#3B82F6',
  },
  llamaBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  messageText: {
    fontSize: 16,
    color: '#334155',
  },
  userMessageText: {
    color: '#FFFFFF',
  },
  greetingText: {
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
    marginVertical: 12,
    color: '#64748B', // Soft gray that complements #2563EB
  },
  input: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 24,
    padding: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#334155',
    flex: 1,
    marginRight: 8,
  },
  sendButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 20,
    shadowColor: '#2563EB',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
    minWidth: 80,
    alignItems: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  inputContainer: {
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    paddingBottom: Platform.OS === 'ios' ? 110 : 100, // Space for tab bar (90px) + extra padding
  },
  // Când tastatura e deschisă, bara de taburi e ascunsă (tabBarHideOnKeyboard),
  // deci padding-ul rezervat ei nu mai e necesar — input-ul stă lipit de tastatură.
  inputContainerKeyboard: {
    paddingBottom: 12,
  },
  buttonDisabled: {
    backgroundColor: '#94A3B8',
    shadowOpacity: 0,
    elevation: 0,
  },

  // ── Indicator de generare (typing / status pe faze) ──
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusText: {
    marginLeft: 10,
    fontSize: 14,
    color: '#64748B',
    fontStyle: 'italic',
  },
  typingDotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  typingDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#2563EB',
    marginHorizontal: 2,
  },

  // ── DEV: stiluri pentru testul de scor ──
  testButton: {
    backgroundColor: '#7C3AED',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 20,
    marginRight: 6,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 48,
  },
  testButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  debugCard: {
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#FCD34D',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  debugHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  debugTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#92400E',
    letterSpacing: 0.5,
  },
  debugClose: {
    fontSize: 16,
    color: '#92400E',
    paddingHorizontal: 6,
  },
  debugQuery: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0F172A',
    marginBottom: 8,
    fontStyle: 'italic',
  },
  debugMatch: {
    backgroundColor: 'rgba(255,255,255,0.6)',
    padding: 8,
    borderRadius: 6,
    marginBottom: 4,
  },
  debugMatchHeader: {
    fontSize: 12,
    color: '#0F172A',
    marginBottom: 2,
  },
  debugPattern: {
    fontSize: 11,
    color: '#475569',
  },
  debugResponse: {
    fontSize: 11,
    color: '#0F172A',
    marginTop: 4,
    fontStyle: 'italic',
    borderLeftWidth: 2,
    borderLeftColor: '#94A3B8',
    paddingLeft: 6,
  },
  debugHint: {
    fontSize: 10,
    color: '#92400E',
    marginTop: 4,
    fontStyle: 'italic',
  },
});

export default ChatScreen;