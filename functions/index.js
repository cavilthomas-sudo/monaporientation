const functions = require("firebase-functions/v1");
const axios = require("axios");
const admin = require("firebase-admin");
const cors = require("cors")({origin: true});

admin.initializeApp();

const geminiApiKey = functions.config().gemini.key;

exports.generateContent = functions.https.onRequest((req, res) => {
  // On utilise cors pour autoriser les requêtes (y compris depuis Netlify)
  cors(req, res, async () => {
    // Note: Pour une sécurité maximale, on pourrait vérifier l'authentification
    // mais pour résoudre le problème CORS, nous allons d'abord faire simple.
    
    // Le reste du code est similaire
    const prompt = req.body.data?.prompt;
    const useGrounding = req.body.data?.useGrounding || false;
    const isJson = req.body.data?.isJson || false;
    const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${geminiApiKey}`;

    if (!prompt) {
      return res.status(400).json({error: "Le prompt ne peut pas être vide."});
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
        res.status(200).json({data: {result: text}});
      } else {
        throw new Error("Réponse invalide de l'API Gemini.");
      }
    } catch (error) {
      console.error("Erreur d'appel à l'API Gemini:", error.response?.data || error.message);
      res.status(500).json({error: "Une erreur est survenue lors de l'appel à l'API d'IA."});
    }
  });
});