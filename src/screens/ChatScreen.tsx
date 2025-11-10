import React, { useState } from 'react';
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
			'This is a conversation between user and assistant, a friendly chatbot.',
		},
	];

	const [conversation, setConversation] = useState<Message[]>(INITIAL_CONVERSATION);
	// const [selectedModelFormat, setSelectedModelFormat] = useState<string>('');
	// const [selectedGGUF, setSelectedGGUF] = useState<string | null>(null);
	// const [availableGGUFs, setAvailableGGUFs] = useState<string[]>([]);
	const [userInput, setUserInput] = useState<string>('');
	const [progress, setProgress] = useState<number>(0);
	const [context, setContext] = useState<any>(null);
	const [isDownloading, setIsDownloading] = useState<boolean>(false);
	const [isGenerating, setIsGenerating] = useState<boolean>(false);
	const [isInitializing, setIsInitializing] = useState<boolean>(false);
	const [currentPage, setCurrentPage] = useState<Page>("modelSelection");
	const scrollViewRef = React.useRef<ScrollView>(null);

	const GGUF_MODEL = "medmekk/Llama-3.2-1B-Instruct.GGUF";
	const MODEL_FORMAT = "Llama-3.2-1B-Instruct-Q2_K.gguf"
	//   "medmekk/Qwen2.5-0.5B-Instruct.GGUF";


	const handleDownloadAndNavigate = async (file: string) => {
		Alert.alert(
		"Confirm Download",
		`Do you want to download ${file}?`,
		[
			{
			text: "No",
			style: "cancel",
			},
			{
			text: "Yes",
			onPress: async () => {
				try {
					await handleDownloadModel(file);
					setCurrentPage("conversation"); // Only navigate after successful download
				} catch (error) {
					Alert.alert('Error', 'Failed to download and initialize the model');
				}
			}},
		],
		{ cancelable: false }
		);
	};

 	const handleDownloadModel = async (file: string) => {
		const downloadUrl = `https://huggingface.co/${
		GGUF_MODEL
		}/resolve/main/${file}`;
		// we set the isDownloading state to true to show the progress bar and set the progress to 0
		setIsDownloading(true);
		setProgress(0);

		try {
		// we download the model using the downloadModel function, it takes the selected GGUF file, the download URL, and a progress callback function to update the progress bar
		const destPath = await downloadModel(file, downloadUrl, progress =>
			setProgress(progress),
		);

		// Success
		Alert.alert('Success', `Model downloaded to: ${destPath}`);
		if (destPath) {
			await loadModel(file);
		} else {
			throw new Error('Model download path is invalid.');
		}

		} catch (error) {
		const errorMessage =
			error instanceof Error
			? error.message
			: 'Download failed due to an unknown error.';
		Alert.alert('Error', errorMessage);
		} finally {
		setIsDownloading(false);
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

    const newConversation: Message[] = [
      // ... is a spread operator that spreads the previous conversation array to which we add the new user message
      ...conversation,
      {role: 'user', content: userInput},
    ];
    setIsGenerating(true);
    // Update conversation state and clear user input
    setConversation(newConversation);
    setUserInput('');

    try {
      // we define list the stop words for all the model formats
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
      // now that we have the new conversation with the user message, we can send it to the model
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
      const destPath = `${RNFS.DocumentDirectoryPath}/${modelName}`;

      // Ensure the model file exists before attempting to load it
      const fileExists = await RNFS.exists(destPath);
      if (!fileExists) {
        throw new Error('The model file does not exist.');
      }

      if (context) {
        await releaseAllLlama();
        setContext(null);
        setConversation(INITIAL_CONVERSATION);
      }

      const llamaContext = await initLlama({
        model: destPath,
        use_mlock: true,
        n_ctx: 2048,
        n_gpu_layers: 1
      });
      
      if (!llamaContext) {
        throw new Error('Failed to initialize the model');
      }

      setContext(llamaContext);
      return true;
    } catch (error) {
      Alert.alert('Error Loading Model', error instanceof Error ? error.message : 'An unknown error occurred.');
      return false;
    } finally {
      setIsInitializing(false);
    }
  };

  	// handleDownloadModel("Llama-3.2-1B-Instruct-Q2_K.gguf");

  	return (
    <SafeAreaView style={styles.container}>
      <ScrollView 
        ref={scrollViewRef}
        contentContainerStyle={styles.scrollView}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}>
        <Text style={styles.title}>Llama Chat</Text>
        {/* Model Selection Section */}
        {currentPage === 'modelSelection' && !isDownloading && (
          <View style={styles.card}>
            <Text style={styles.subtitle}>Download the model!</Text>
            <TouchableOpacity
              style={styles.button}		
              onPress={() => handleDownloadAndNavigate(MODEL_FORMAT)}>
              <Text style={styles.buttonText}>Download!</Text>
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
                  🦙 Welcome! The Llama is ready to chat. Ask away! 🎉
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
            <Text style={styles.subtitle}>Downloading : </Text>
            <Text style={styles.subtitle2}>{GGUF_MODEL}</Text>
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
    marginBottom: Platform.OS === 'android' ? 90 : 0, // Add bottom margin to avoid overlap with navigation
  },
});

export default ChatScreen;