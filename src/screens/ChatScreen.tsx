import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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

	// File constants — sursă de adevăr e modelManager
	const MODEL_FORMAT = LLM_FILE;


  // Subscribe la modelManager — download-ul rulează central, ChatScreen doar reacționează
  useEffect(() => {
    const unsubscribe = modelManager.subscribe(setModelState);
    return unsubscribe;
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
          const status = m.score >= 0.60 ? 'PASS' : 'fail';
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
    setUserInput('');

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

            // Threshold de hard-reject 0.60 calibrat empiric pe 15 queries RO.
            const bestScore = relevantEntries[0]?.score ?? 0;

            // Log minimal — array-uri mari prin Metro bridge sunt foarte
            // lente pe device fizic.
            console.log(
              `[RAG] best=${(bestScore * 100).toFixed(1)}% top=${
                relevantEntries[0]?.entry.tag ?? '—'
              }`,
            );

            if (bestScore < 0.6) {
              setConversation(prev => [
                ...prev,
                {
                  role: 'assistant',
                  content:
                    'În caz de urgență, sună la 112!\n\nNu am informații despre acest subiect în baza mea de cunoștințe. Te rog sună la 112 (servicii de urgență) pentru ajutor profesionist.',
                },
              ]);
              setIsGenerating(false);
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

      // Keep only the last 4 message pairs (8 messages) to avoid context overflow
      // Skip the original system message (index 0) when slicing
      const recentMessages = conversation.slice(1).slice(-8);

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
      
      // Send to model with retrieved context.
      // n_predict: 512 = ~10-12 propoziții, suficient pentru first-aid;
      // pe Llama 3.2 1B emulator (~2-5 tok/s) răspunde în 1-3 min în loc
      // de 30+ min cu valoarea anterioară 10000. Stop tokens acoperă
      // formatele Llama 3 (`<|eot_id|>`) și fallback-uri pentru alte
      // modele care ar putea fi încărcate.
      const result = await context.completion({
        messages: newConversation,
        n_predict: 512,
        stop: stopWords,
      });

      // Ensure the result has text before updating the conversation
      if (result && result.text) {
        setConversation(prev => [
          ...prev,
          {role: 'assistant', content: result.text.trim()},
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
      // n_ctx: 2048 (redus de la 4096) — KB-ul nostru injectează cel mult 2
      // entry-uri × ~750 tokeni + system + mesaj user = ~1700 tokeni. 2048
      // lasă spațiu pentru răspuns dar reduce semnificativ memoria KV cache
      // și timpul de procesare prompt.
      const llamaContext = await initLlama({
        model: destPath,
        use_mlock: true,
        n_ctx: 2048,
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
      <ScrollView 
        ref={scrollViewRef}
        contentContainerStyle={styles.scrollView}
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
                  const willPass = m.score >= 0.60;
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
                  Verde = peste prag 60% (intră în context LLM). Roșu = sub prag → mesaj "sună la 112". (Loguri detaliate în Metro console.)
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
            {isGenerating && (
              <View style={[styles.messageBubble, styles.llamaBubble]}>
                <ActivityIndicator size="small" color="#2563EB" />
              </View>
            )}
          </View>
        )}
      </ScrollView>
      {context && (
        <View style={styles.inputContainer}>
          <View style={styles.buttonRow}>
            <TextInput
              style={styles.input}
              placeholder="Type your message..."
              placeholderTextColor="#94A3B8"
              value={userInput}
              onChangeText={setUserInput}
              multiline={true}
              maxLength={1000}
              returnKeyType="send"
              onSubmitEditing={handleSendMessage}
            />
            <TouchableOpacity
              style={[
                styles.testButton,
                (isTesting || isGenerating || !userInput.trim()) && { backgroundColor: '#94A3B8' }
              ]}
              onPress={handleTestScores}
              disabled={isTesting || isGenerating || !userInput.trim()}>
              <Text style={styles.testButtonText}>
                {isTesting ? '...' : '🔍'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.sendButton,
                isGenerating && { backgroundColor: '#94A3B8' }
              ]}
              onPress={handleSendMessage}
              disabled={isGenerating || !userInput.trim()}>
              <Text style={styles.buttonText}>
                {isGenerating ? 'Trimit...' : 'Send'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
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