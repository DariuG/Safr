import RNFS from 'react-native-fs';

const MODEL_VERSION = '1.0.0'; // Change this when you update your model

export const downloadModel = async (
  modelName: string,
  modelUrl: string,
  onProgress: (progress: number) => void
): Promise<string> => {
  const modelDir = `${RNFS.DocumentDirectoryPath}/models`;
  const destPath = `${modelDir}/${modelName}`;
  const versionFile = `${modelDir}/${modelName}.version`;

  try {
    if (!modelName || !modelUrl) {
      throw new Error('Invalid model name or URL');
    }

    // Ensure model directory exists
    await RNFS.mkdir(modelDir);

    // Check for existing version
    const hasVersion = await RNFS.exists(versionFile);
    let currentVersion = null;
    if (hasVersion) currentVersion = await RNFS.readFile(versionFile, 'utf8');

    // If model exists and version is current, skip download
    const fileExists = await RNFS.exists(destPath);
    if (fileExists && currentVersion === MODEL_VERSION) {
      console.log(`✅ Model already downloaded: ${destPath}`);
      return destPath;
    }

    // Otherwise, delete any old version
    if (fileExists) {
      await RNFS.unlink(destPath);
      console.log(`Deleted old model at ${destPath}`);
    }

    console.log(`⬇️ Downloading model from: ${modelUrl}`);
    const downloadResult = await RNFS.downloadFile({
      fromUrl: modelUrl,
      toFile: destPath,
      progressDivider: 5,
      begin: (res) => console.log('Download started:', res),
      progress: ({ bytesWritten, contentLength }) => {
        const progress = (bytesWritten / contentLength) * 100;
        onProgress(Math.floor(progress));
      },
    }).promise;

    if (downloadResult.statusCode === 200) {
      console.log('✅ Model downloaded successfully.');
      await RNFS.writeFile(versionFile, MODEL_VERSION, 'utf8');
      return destPath;
    } else {
      throw new Error(`Download failed with status code: ${downloadResult.statusCode}`);
    }
  } catch (error) {
    throw new Error(
      `❌ Failed to download model: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
};
