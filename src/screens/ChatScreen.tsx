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
import { downloadModel } from '../api/model';
import RNFS from "react-native-fs";
import { initLlama, releaseAllLlama } from 'llama.rn';
import ProgressBar from '../components/ProgressBar';
import { 
  loadKnowledgeBase, 
  retrieveRelevantContext, 
  formatContextForPrompt,
  type KnowledgeEntry 
} from '../utils/rag';


type Message = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type Page = 'modelSelection' | 'conversation';

const ChatScreen = () => {

	const INITIAL_CONVERSATION: Message[] = [
		{
			role: 'system',
			content:
			'You are a helpful emergency first-aid assistant. Answer the user\'s question using the information provided in the CONTEXT section below. Be direct and clear. Only use information from the CONTEXT.',
		},
	];

	const [conversation, setConversation] = useState<Message[]>(INITIAL_CONVERSATION);
	// const [selectedModelFormat, setSelectedModelFormat] = useState<string>('');
	// const [selectedGGUF, setSelectedGGUF] = useState<string | null>(null);
	// const [availableGGUFs, setAvailableGGUFs] = useState<string[]>([]);
	const [userInput, setUserInput] = useState<string>('');
	const [progress, setProgress] = useState<number>(0);
	const [context, setContext] = useState<any>(null);
	const [embeddingContext, setEmbeddingContext] = useState<any>(null);
	const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeEntry[]>([]);
	const [isDownloading, setIsDownloading] = useState<boolean>(false);
	const [downloadingModel, setDownloadingModel] = useState<string>('');
	const [isGenerating, setIsGenerating] = useState<boolean>(false);
	const [isInitializing, setIsInitializing] = useState<boolean>(false);
	const [currentPage, setCurrentPage] = useState<Page>("modelSelection");
	const [embeddingModelExists, setEmbeddingModelExists] = useState<boolean>(false);
	const scrollViewRef = React.useRef<ScrollView>(null);

	const GGUF_MODEL = "medmekk/Llama-3.2-1B-Instruct.GGUF";
	// const MODEL_FORMAT = "Llama-3.2-1B-Instruct-Q2_K.gguf"
	const MODEL_FORMAT = "Llama-3.2-1B-Instruct-Q5_K_S.gguf"
	
	// Embedding model - use nomic-embed which is proven to work with llama.rn
	// Note: This produces 768-dim embeddings, you'll need to regenerate your knowledge base
	const EMBEDDING_MODEL = "nomic-ai/nomic-embed-text-v1.5-GGUF";
	const EMBEDDING_MODEL_FORMAT = "nomic-embed-text-v1.5.Q4_K_M.gguf";


	const handleDownloadAllModels = async () => {
		try {
			// Download LLM first
			setIsDownloading(true);
			setDownloadingModel(MODEL_FORMAT);
			setProgress(0);

			const llmUrl = `https://huggingface.co/${GGUF_MODEL}/resolve/main/${MODEL_FORMAT}`;
			await downloadModel(MODEL_FORMAT, llmUrl, progress => setProgress(progress));
			console.log('✅ Chat model downloaded');

			// Download embedding model
			setDownloadingModel(EMBEDDING_MODEL_FORMAT);
			setProgress(0);

			const embeddingUrl = `https://huggingface.co/${EMBEDDING_MODEL}/resolve/main/${EMBEDDING_MODEL_FORMAT}`;
			await downloadModel(EMBEDDING_MODEL_FORMAT, embeddingUrl, progress => setProgress(progress));
			console.log('✅ Embedding model downloaded');

			setIsDownloading(false);
			setDownloadingModel('');

			Alert.alert('Success', 'Both models downloaded successfully!');
			
			// Load both models
			await loadModel(MODEL_FORMAT);
			setCurrentPage('conversation');
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Download failed';
			Alert.alert('Error', errorMessage);
			setIsDownloading(false);
			setDownloadingModel('');
		}
	};

	const handleDownloadLLM = async () => {
		setIsDownloading(true);
		setDownloadingModel(MODEL_FORMAT);
		setProgress(0);

		try {
			const downloadUrl = `https://huggingface.co/${GGUF_MODEL}/resolve/main/${MODEL_FORMAT}`;
			const destPath = await downloadModel(MODEL_FORMAT, downloadUrl, progress =>
				setProgress(progress),
			);

			Alert.alert('Success', 'Chat model downloaded successfully!');
			
			// Load the LLM after download
			await loadModel(MODEL_FORMAT);
			setCurrentPage('conversation');
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Download failed';
			Alert.alert('Error', errorMessage);
		} finally {
			setIsDownloading(false);
			setDownloadingModel('');
		}
	};

	const handleDownloadEmbedding = async () => {
		setIsDownloading(true);
		setDownloadingModel(EMBEDDING_MODEL_FORMAT);
		setProgress(0);

		try {
			const downloadUrl = `https://huggingface.co/${EMBEDDING_MODEL}/resolve/main/${EMBEDDING_MODEL_FORMAT}`;
			const destPath = await downloadModel(EMBEDDING_MODEL_FORMAT, downloadUrl, progress =>
				setProgress(progress),
			);

			Alert.alert('Success', 'Embedding model downloaded successfully!');
			
			// Load the embedding model after download
			await loadEmbeddingModel();
			setEmbeddingModelExists(true);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Download failed';
			Alert.alert('Error', errorMessage);
		} finally {
			setIsDownloading(false);
			setDownloadingModel('');
		}
	};

  const handleSendMessage = async () => {
    // Check if context is loaded and user input is valid
    if (!context) {
      Alert.alert('Model Not Loaded', 'Please load the model first.');
      return;
    }

    if (!userInput.trim()) {
      Alert.alert('Input Error', 'Please enter a message.');
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
          // Generate embedding for user query (now matches pattern-only KB embeddings)
          const { embedding: queryEmbedding } = await embeddingContext.embedding(userMessage);
          
          console.log(`📊 Query embedding dimensions: ${queryEmbedding.length}`);
          console.log(`📊 First 10 values of query embedding:`, queryEmbedding.slice(0, 10));
          console.log(`📊 Sum of query embedding:`, queryEmbedding.reduce((a: number, b: number) => a + b, 0));
          console.log(`📊 Knowledge base embedding dimensions: ${knowledgeBase[0].embedding.length}`);
          console.log(`📊 First 10 values of KB embedding:`, knowledgeBase[0].embedding.slice(0, 10));
          
          // Check if embeddings are all zeros or constant
          const querySum = queryEmbedding.reduce((a: number, b: number) => a + b, 0);
          const queryVariance = queryEmbedding.reduce((sum: number, val: number) => sum + val * val, 0);
          
          if (Math.abs(querySum) < 0.001 || Math.abs(queryVariance) < 0.001) {
            console.error('❌ Query embedding appears to be all zeros or constant!');
            console.error('The embedding model may not be working correctly.');
            throw new Error('Invalid embedding generated');
          }
          
          // Check if dimensions match
          if (queryEmbedding.length !== knowledgeBase[0].embedding.length) {
            console.warn(`⚠️ Embedding dimension mismatch! Query: ${queryEmbedding.length}, KB: ${knowledgeBase[0].embedding.length}`);
            console.warn('⚠️ Skipping RAG - model does not support same embedding dimension as knowledge base');
          } else {
            // Retrieve relevant context from knowledge base with lower threshold
            const relevantEntries = retrieveRelevantContext(
              queryEmbedding,
              knowledgeBase,
              5,    // Top 5 results to capture multi-part answers
              0.15  // 15% threshold to include related chunks
            );
            
            // Log all similarity scores for debugging
            console.log('🔍 Top 10 similarity scores:');
            const allScores = knowledgeBase.map(entry => ({
              tag: entry.tag,
              id: entry.id,
              score: retrieveRelevantContext(queryEmbedding, [entry], 1, 0)[0]?.score || 0
            })).sort((a, b) => b.score - a.score).slice(0, 10);
            
            allScores.forEach((item, idx) => {
              console.log(`  ${idx + 1}. ${item.id} [${item.tag}]: ${(item.score * 100).toFixed(2)}%`);
            });
            
            // Check if best match is below 60% - reject immediately
            const bestScore = allScores[0]?.score || 0;
            if (bestScore < 0.6) {
              console.log(`⚠️ Best similarity score ${(bestScore * 100).toFixed(2)}% is below 75% threshold`);
              console.log('🚫 Query appears unrelated to medical emergencies - returning standard rejection');
              
              // Set conversation with rejection message and skip LLM call
              setConversation(prev => [
                ...prev,
                {role: 'assistant', content: 'In case of any emergency, call 112!\n\nAccording to my knowledge base: I don\'t have information about this topic. Please call 112 (emergency services) immediately for professional help.'}
              ]);
              setIsGenerating(false);
              return; // Exit early without calling LLM
            }
            
            if (relevantEntries.length > 0) {
              retrievedContext = formatContextForPrompt(relevantEntries);
              console.log(`✅ Retrieved ${relevantEntries.length} relevant contexts`);
              relevantEntries.forEach((item, idx) => {
                console.log(`  ${idx + 1}. ${item.entry.id}: ${(item.score * 100).toFixed(1)}% similarity`);
                console.log(`     Pattern: ${item.entry.pattern}`);
                console.log(`     Response length: ${item.entry.response.length} chars`);
                console.log(`     Response preview: ${item.entry.response.substring(0, 80)}...`);
              });
              console.log(`📝 Total context size: ${retrievedContext.length} characters`);
              console.log('📝 Full context sent to model:');
              console.log(retrievedContext.substring(0, 600) + '...');
            } else {
              console.log('⚠️ No relevant context found above threshold');
              console.log('💡 Best match was:', allScores[0]);
            }
          }
        } catch (embeddingError) {
          console.warn('⚠️ Failed to generate embedding, continuing without RAG:', embeddingError);
        }
      } else if (!embeddingContext) {
        console.log('⚠️ Embedding model not loaded, skipping RAG');
      }

      // Build conversation with retrieved context injected into system message
      let systemMessage = INITIAL_CONVERSATION[0].content;
      
      if (retrievedContext) {
        // Medical query with relevant context found
        systemMessage += "\n\nCONTEXT:\n" + retrievedContext + "\n\nUse the above context to answer the question.";
      } else {
        // No relevant context found - refuse to answer
        systemMessage += "\n\nCONTEXT:\nNo relevant information available.\n\nTell the user you don't have information about this topic.";
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
      
      // Send to model with retrieved context
      const result = await context.completion({
        messages: newConversation,
        n_predict: 10000,
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
        'Error During Inference',
        error instanceof Error ? error.message : 'An unknown error occurred.',
      );
    } finally {
      setIsGenerating(false);
    }
  };


  const loadModel = async (modelName: string) => {
    setIsInitializing(true);
    try {
      const modelDir = `${RNFS.DocumentDirectoryPath}/models`;
      const destPath = `${modelDir}/${modelName}`;

      // Ensure the model file exists before attempting to load it
      const fileExists = await RNFS.exists(destPath);
      if (!fileExists) {
        throw new Error('The model file does not exist.');
      }

      if (context) {
        await releaseAllLlama();
        setContext(null);
        setEmbeddingContext(null);
        setConversation(INITIAL_CONVERSATION);
      }

      // Load main LLM for chat
      const llamaContext = await initLlama({
        model: destPath,
        use_mlock: true,
        n_ctx: 4096,
        n_gpu_layers: 1,
      });
      
      if (!llamaContext) {
        throw new Error('Failed to initialize the model');
      }

      setContext(llamaContext);
      
      // Load embedding model for RAG (in background)
      loadEmbeddingModel();
      
      return true;
    } catch (error) {
      Alert.alert('Error Loading Model', error instanceof Error ? error.message : 'An unknown error occurred.');
      return false;
    } finally {
      setIsInitializing(false);
    }
  };

  const loadEmbeddingModel = async () => {
    try {
      const modelDir = `${RNFS.DocumentDirectoryPath}/models`;
      const embeddingPath = `${modelDir}/${EMBEDDING_MODEL_FORMAT}`;

      // Check if embedding model exists
      const exists = await RNFS.exists(embeddingPath);
      setEmbeddingModelExists(exists);
      
      if (!exists) {
        console.log('⚠️ Embedding model not found. RAG will be disabled.');
        console.log(`💡 To enable RAG, download: ${EMBEDDING_MODEL}`);
        return;
      }

      console.log('📦 Loading embedding model for RAG...');
      
      const embContext = await initLlama({
        model: embeddingPath,
        use_mlock: true,
        n_ctx: 512,
        embedding: true,
        n_gpu_layers: 1,
      });

      if (embContext) {
        setEmbeddingContext(embContext);
        console.log('✅ Embedding model loaded successfully');
      }
    } catch (error) {
      console.warn('⚠️ Failed to load embedding model:', error);
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
          'Knowledge Base Error',
          'Failed to load emergency knowledge base. RAG features will be disabled.',
        );
      }
    };

    loadKB();

    return () => {
      mounted = false;
    };
  }, []);

  // On mount, check whether the model file already exists on device.
  // If it does, switch to the conversation view and attempt to load it.
  useEffect(() => {
    let mounted = true;

    const checkAndLoadModel = async () => {
      try {
        const modelDir = `${RNFS.DocumentDirectoryPath}/models`;
        const destPath = `${modelDir}/${MODEL_FORMAT}`;
        const embeddingPath = `${modelDir}/${EMBEDDING_MODEL_FORMAT}`;
        const exists = await RNFS.exists(destPath);
        const embExists = await RNFS.exists(embeddingPath);
        setEmbeddingModelExists(embExists);
        if (exists && mounted) {
          // Show conversation screen and try to initialize the model in background
          setCurrentPage('conversation');
          const ok = await loadModel(MODEL_FORMAT);
          if (!ok && mounted) {
            // If initialization failed, go back to selection so user can retry
            setCurrentPage('modelSelection');
          }
        }
      } catch (err) {
        console.log('Error checking/loading model on mount', err);
      }
    };

    checkAndLoadModel();

    return () => {
      mounted = false;
    };
  }, []);

  	return (
    <SafeAreaView style={styles.container}>
      <ScrollView 
        ref={scrollViewRef}
        contentContainerStyle={styles.scrollView}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}>
        <Text style={styles.title}>Safr assistant</Text>
        {/* Model Selection Section */}
        {currentPage === 'modelSelection' && !isDownloading && (
          <View style={styles.card}>
            <Text style={styles.subtitle}>Download Models</Text>
            <Text style={styles.cardText}>
              This will download both the chat model and embedding model for RAG functionality.
            </Text>
            <Text style={[styles.cardText, { marginTop: 8, fontSize: 12, fontStyle: 'italic' }]}>
              • Chat Model: {MODEL_FORMAT}
            </Text>
            <Text style={[styles.cardText, { fontSize: 12, fontStyle: 'italic' }]}>
              • Embedding Model: {EMBEDDING_MODEL_FORMAT}
            </Text>
            <TouchableOpacity
              style={styles.button}
              onPress={handleDownloadAllModels}>
              <Text style={styles.buttonText}>Download Both Models</Text>
            </TouchableOpacity>
          </View>
        )}
            
        {currentPage === 'conversation' && !isDownloading && (
          <View style={styles.chatContainer}>
            {isInitializing ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#2563EB" />
                <Text style={styles.loadingText}>Initializing model...</Text>
              </View>
            ) : (
              <>
                <Text style={styles.greetingText}>
                  Your personal emergency assistant is ready to chat. How can I help you today?
                </Text>
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
              </>
            )}
          </View>
        )}
        {isDownloading && (
          <View style={styles.card}>
            <Text style={styles.subtitle}>Downloading</Text>
            <Text style={styles.subtitle2}>{downloadingModel}</Text>
            <ProgressBar progress={progress} />
          </View>
        )}
      </ScrollView>
      {currentPage === 'conversation' && (
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
                styles.sendButton,
                isGenerating && { backgroundColor: '#94A3B8' }
              ]}
              onPress={handleSendMessage}
              disabled={isGenerating || !userInput.trim()}>
              <Text style={styles.buttonText}>
                {isGenerating ? 'Sending...' : 'Send'}
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
});

export default ChatScreen;