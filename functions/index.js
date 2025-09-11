const functions = require("firebase-functions/v1");
const axios = require("axios");
const admin = require("firebase-admin");

admin.initializeApp();

const geminiApiKey = functions.config().gemini.key;

exports.generateContent = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "Vous devez être connecté pour utiliser cette fonctionnalité."
    );
  }

  const prompt = data.prompt;
  const useGrounding = data.useGrounding || false;
  const isJson = data.isJson || false;
  const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`;

  if (!prompt) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "Le prompt ne peut pas être vide."
    );
  }

  const payload = {
    contents: [{parts: [{text: prompt}]}],
  };
  if (useGrounding && !isJson) {
    payload.tools = [{"google_search_retrieval": {}}];
  }
  if (isJson) {
    payload.generationConfig = {responseMimeType: "application/json"};
  }

  try {
    const response = await axios.post(geminiApiUrl, payload);
    const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      return {result: text};
    } else {
      throw new Error("Réponse invalide de l'API Gemini.");
    }
  } catch (error) {
    console.error("Erreur d'appel à l'API Gemini:", error.response?.data || error.message);
    throw new functions.https.HttpsError(
        "internal",
        "Une erreur est survenue lors de l'appel à l'API d'IA."
    );
  }
});