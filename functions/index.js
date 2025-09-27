const functions = require("firebase-functions/v1");
const axios = require("axios");

// On récupère la clé API stockée
const brevoApiKey = functions.config().brevo.key;

exports.sendTransactionalEmail = functions.https.onCall(async (data, context) => {
    // On vérifie que l'utilisateur est bien authentifié
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Vous devez être connecté.');
    }

    const { templateId, toEmail, params } = data;
    const brevoApiUrl = 'https://api.brevo.com/v3/smtp/email';

    const payload = {
        to: [{ email: toEmail }],
        templateId: templateId,
        params: params
    };

    const headers = {
        'api-key': brevoApiKey,
        'Content-Type': 'application/json'
    };

    try {
        await axios.post(brevoApiUrl, payload, { headers });
        return { success: true };
    } catch (error) {
        console.error("Erreur d'envoi de l'email via Brevo:", error.response?.data);
        throw new functions.https.HttpsError('internal', "Impossible d'envoyer l'email.");
    }
});

const cors = require("cors")({ origin: true });

// On récupère la clé secrète OpenAI que vous avez configurée
const openaiApiKey = functions.config().openai.key; 

// L'URL de l'API OpenAI
const openaiApiUrl = 'https://api.openai.com/v1/chat/completions';

exports.generateContent = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Le prompt ne peut pas être vide." });
    }

    // Le format des données pour ChatGPT avec votre modèle choisi
    const payload = {
      model: "gpt-4o-mini",
      messages: [{ "role": "user", "content": prompt }]
    };

    // L'authentification pour ChatGPT
    const headers = {
      'Authorization': `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json'
    };

    try {
      const response = await axios.post(openaiApiUrl, payload, { headers: headers });
      
      const text = response.data.choices[0].message.content;
      
      if (text) {
        res.status(200).json({ result: text.trim() });
      } else {
        throw new Error("Réponse invalide de l'API OpenAI.");
      }
    } catch (error) {
      console.error("Erreur d'appel à l'API OpenAI:", error.response?.data || error.message);
      res.status(500).json({ error: "Une erreur est survenue lors de l'appel à l'API d'IA." });
    }
  });
});