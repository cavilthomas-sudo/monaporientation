// =================================================================
// FICHIER functions/index.js - VERSION FINALE (V1 explicite)
// =================================================================

// L'import V1 CORRECT et EXPLICITE
const functions = require("firebase-functions/v1");

// Les autres imports nécessaires
const admin = require("firebase-admin");
const axios = require("axios");
const SibApiV3Sdk = require('@getbrevo/brevo');
const cors = require('cors')({origin: true});

// Initialisation de Firebase Admin
admin.initializeApp();

// =================================================================
// FONCTION N°1 : ENVOI D'EMAILS TRANSACTIONNELS (BREVO)
// =================================================================
exports.sendTransactionalEmail = functions
    .region("europe-west1") // Cette ligne devrait maintenant fonctionner
    .https.onRequest((req, res) => {
        cors(req, res, async () => {
            const brevoApiKey = functions.config().brevo.key;
            if (!brevoApiKey) {
                console.error("Clé API Brevo non configurée.");
                return res.status(500).send({ error: "Configuration du serveur incomplète." });
            }

            const { templateId, toEmail, params } = req.body.data;

            let apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
            let apiKey = apiInstance.authentications['apiKey'];
            apiKey.apiKey = brevoApiKey;

            let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
            sendSmtpEmail.params = params || {};
            
            if (templateId === 1) { // Email de vérification
                try {
                    const actionCodeSettings = { url: 'https://oriantation.fr' };
                    const link = await admin.auth().generateEmailVerificationLink(toEmail, actionCodeSettings);
                    sendSmtpEmail.params.verificationLink = link;
                } catch (error) {
                    console.error("Erreur de génération du lien de vérification:", error);
                    return res.status(500).send({ error: "Impossible de générer le lien de vérification." });
                }
            }
            
            sendSmtpEmail.templateId = templateId;
            sendSmtpEmail.to = [{ email: toEmail }];
            sendSmtpEmail.sender = { 
                name: "OrIAntation",
                email: "contact@oriantation.fr"
            };

            try {
                await apiInstance.sendTransacEmail(sendSmtpEmail);
                return res.status(200).send({ success: true, message: "Email envoyé." });
            } catch (error) {
                console.error("Erreur d'envoi Brevo:", error.response ? error.response.body : error);
                return res.status(500).send({ error: "Erreur lors de l'envoi de l'email." });
            }
        });
    });

// =================================================================
// FONCTION N°2 : APPEL À L'API OPENAI (CHATGPT)
// =================================================================
exports.generateContent = functions
    .region("europe-west1")
    .runWith({ timeoutSeconds: 300 })
    .https.onRequest((req, res) => {
        cors(req, res, async () => {
            if (req.method !== "POST") { return res.status(405).send("Method Not Allowed"); }

            const openaiApiKey = functions.config().openai.key;
            if (!openaiApiKey) { return res.status(500).json({ error: "Configuration du serveur incomplète." }); }

            const { prompt, model, promptId, variables } = req.body;
            const headers = { 'Authorization': `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' };

            try {
                let response;
                
                // --- LOGIQUE CORRIGÉE ---

                // VOIE EXPERT : Si un ID de prompt publié est fourni
                if (promptId) {
                    const payload = { prompt: { id: promptId, variables: variables || {} } };
                    response = await axios.post('https://api.openai.com/v1/responses', payload, { headers: headers });
                
                // VOIE EXPRESS : L'appel direct par défaut
                } else {
                    // La vérification du prompt se fait UNIQUEMENT ici
                    if (!prompt) {
                        return res.status(400).json({ error: "Le prompt ne peut pas être vide." });
                    }
                    const payload = { model: model || 'gpt-4o', messages: [{ "role": "user", "content": prompt }] };
                    response = await axios.post('https://api.openai.com/v1/chat/completions', payload, { headers: headers });
                }
                
                // Le reste de la logique pour lire la réponse est inchangé et correct
                const text = response.data?.choices?.[0]?.message?.content ||
                             response.data?.output?.find(item => item.type === 'message')?.content?.[0]?.text;

                if (text) {
                    return res.status(200).json({ result: text.trim() });
                } else {
                    console.error("Structure de réponse OpenAI inattendue:", JSON.stringify(response.data, null, 2));
                    throw new Error("Structure de réponse OpenAI invalide.");
                }
            } catch (error) {
                if (error.response) {
                    console.error("Erreur de l'API OpenAI (données):", JSON.stringify(error.response.data, null, 2));
                } else {
                    console.error("Erreur d'appel à l'API OpenAI (générale):", error.message);
                }
                return res.status(500).json({ error: "Une erreur est survenue lors de l'appel à l'API d'IA." });
            }
        });
    });