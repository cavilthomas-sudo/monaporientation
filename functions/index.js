// L'import V1 CORRECT et EXPLICITE
const functions = require("firebase-functions/v1");

// Les autres imports nécessaires
const admin = require("firebase-admin");
const axios = require("axios");
const SibApiV3Sdk = require('@getbrevo/brevo');
const cors = require('cors')({origin: true});
const webpush = require('web-push');




// Initialisation de Firebase Admin
admin.initializeApp();

const VAPID_PUBLIC_KEY = "BNCDYwj7YAiREgh5LbW9vPqA4NXmBpDQDzk9oWk6K-Wkt05ibaELJIKdhB2aRff2QxZ90DiXUJjBUmXdWyimZPM"; 
const VAPID_PRIVATE_KEY = functions.config().vapid ? functions.config().vapid.private_key : "VOTRE_CLÉ_PRIVÉE_VAPID_ICI";

webpush.setVapidDetails(
  'mailto:contact@oriantation.fr', // Votre email de contact
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);
// AJOUTEZ CETTE FONCTION DANS LA SECTION DES HELPERS DE VOTRE index.js
function extractJsonFromString(str) {
    if (!str) return null;

    let cleanedStr = str.trim();
    if (cleanedStr.startsWith("```json")) {
        cleanedStr = cleanedStr.substring(7);
    }
    if (cleanedStr.endsWith("```")) {
        cleanedStr = cleanedStr.substring(0, cleanedStr.length - 3);
    }
    cleanedStr = cleanedStr.trim();

    const jsonStart = cleanedStr.indexOf('{');
    const jsonEnd = cleanedStr.lastIndexOf('}') + 1;

    if (jsonStart === -1 || jsonEnd === 0) {
        return null;
    }

    const jsonString = cleanedStr.substring(jsonStart, jsonEnd);
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Impossible d'analyser le JSON extrait:", error);
        return null;
    }
}
/**
 * Envoie une notification push à un utilisateur via ses abonnements enregistrés.
 * C'est la version finale, robuste et fonctionnelle.
 * @param {string} userId - L'ID de l'utilisateur dans Firestore.
 * @param {string} title - Le titre de la notification.
 * @param {string} body - Le corps du message de la notification.
 */
async function sendPushNotification(userId, title, body) {
  const userDoc = await admin.firestore().doc(`users/${userId}`).get();
  const userData = userDoc.data();

  if (!userData || !userData.pushSubscriptions || userData.pushSubscriptions.length === 0) {
    console.log(`Pas d'abonnement push trouvé pour l'utilisateur ${userId}.`);
    return;
  }

  // 1. On prépare le contenu de la notification. Cela doit être une chaîne de caractères.
  const payload = JSON.stringify({
    title: title,
    body: body,
    icon: 'https://oriantation.fr/logo.png'
  });

  const subscriptions = userData.pushSubscriptions;
  const promises = [];
  const invalidSubscriptions = [];

  // 2. On parcourt chaque abonnement de l'utilisateur.
  subscriptions.forEach(sub => {
    const pushPromise = webpush.sendNotification(sub, payload)
      .catch(error => {
        // Si un abonnement est expiré (code 410), on le marque pour suppression.
        if (error.statusCode === 410) {
          console.log(`Abonnement expiré pour l'utilisateur ${userId}. Suppression...`);
          invalidSubscriptions.push(sub);
        } else {
          console.error(`Erreur d'envoi de la notification pour ${userId}:`, error);
        }
      });
    promises.push(pushPromise);
  });

  // 3. On attend que toutes les notifications soient envoyées.
  await Promise.all(promises);

  // 4. Si des abonnements invalides ont été trouvés, on les retire de Firestore.
  if (invalidSubscriptions.length > 0) {
    await admin.firestore().doc(`users/${userId}`).update({
      pushSubscriptions: admin.firestore.FieldValue.arrayRemove(...invalidSubscriptions)
    });
    console.log(`${invalidSubscriptions.length} abonnements invalides ont été supprimés.`);
  }
}

async function internalCallOpenAI({ promptText, model = 'gpt-4o', isJson = false, promptId = null, variables = {} }) {
const openaiApiKey = functions.config().openai.key;
     if (!openaiApiKey) {
        throw new Error("Clé API OpenAI non configurée.");
    }
    const headers = { 'Authorization': `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' };

    let response;
    // VOIE EXPERT
    if (promptId) {
        const payload = { prompt: { id: promptId, variables: variables } };
        response = await axios.post('https://api.openai.com/v1/responses', payload, { headers: headers });
    // VOIE EXPRESS
    } else {
        if (!promptText) {
            throw new Error("Le prompt ne peut pas être vide.");
        }
        const finalPrompt = isJson ? `${promptText}\n\n# Format de Sortie OBLIGATOIRE\nTa réponse doit être uniquement un objet JSON valide.` : promptText;
        const payload = { model: model, messages: [{ "role": "user", "content": finalPrompt }] };
        response = await axios.post('https://api.openai.com/v1/chat/completions', payload, { headers: headers });
    }

    const text = response.data?.choices?.[0]?.message?.content ||
                 response.data?.output?.find(item => item.type === 'message')?.content?.[0]?.text;

    if (text) {
        return text.trim();
    } else {
        console.error("Structure de réponse OpenAI inattendue:", JSON.stringify(response.data, null, 2));
        throw new Error("Structure de réponse OpenAI invalide.");
    }
}


async function sendEmailWithBrevo({ templateId, toEmail, params }) {
    const brevoApiKey = functions.config().brevo.key;
    if (!brevoApiKey) {
        throw new Error("Clé API Brevo non configurée.");
    }

    let apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    let apiKey = apiInstance.authentications['apiKey'];
    apiKey.apiKey = brevoApiKey;

    let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.templateId = templateId;
    sendSmtpEmail.to = [{ email: toEmail }];
    sendSmtpEmail.params = params || {};
    sendSmtpEmail.sender = {
        name: "OrIAntation",
        email: "contact@oriantation.fr"
    };
    
    // LOGIQUE EXISTANTE : Email de vérification pour élèves OU enseignants
    if (templateId === 1 || templateId === 2) {
        try {
            const actionCodeSettings = { url: 'https://oriantation.fr' };
            const link = await admin.auth().generateEmailVerificationLink(toEmail, actionCodeSettings);
            sendSmtpEmail.params.verificationLink = link;
        } catch (error) {
            console.error("Erreur de génération du lien de vérification:", error);
            // On ne bloque pas l'envoi si l'email n'existe pas, mais on logue l'erreur.
            // La fonction appelante gérera le retour à l'utilisateur.
            throw new Error("Impossible de générer le lien de vérification.");
        }
    }
    // LOGIQUE AJOUTÉE GRÂCE À VOUS : Email de réinitialisation de mot de passe
    else if (templateId === 4) {
        try {
            const actionCodeSettings = { url: 'https://oriantation.fr' };
            const link = await admin.auth().generatePasswordResetLink(toEmail, actionCodeSettings);
            // Assurez-vous que votre template Brevo utilise bien la variable 'resetLink'
            sendSmtpEmail.params.resetLink = link;
        } catch (error) {
            // Sécurité : si l'email n'existe pas, on ne propage pas l'erreur pour ne pas le révéler.
            // L'application cliente recevra une réponse de succès générique.
            if (error.code === 'auth/user-not-found') {
                console.log(`Tentative de réinitialisation pour un email inexistant: ${toEmail}`);
                // On simule un succès pour ne pas donner d'indice sur l'existence du compte.
                return; 
            }
            console.error("Erreur de génération du lien de réinitialisation:", error);
            throw new Error("Impossible de générer le lien de réinitialisation.");
        }
    }

    // Envoi de l'email
    await apiInstance.sendTransacEmail(sendSmtpEmail);
}

// REMPLACEZ VOTRE PROMPT DE RAPPEL PAR CELUI-CI
const TUTORIAL_REMINDER_PROMPT_TEMPLATE = `
# Rôle et Identité
Tu es "OrIA", le coach IA bienveillant de l'application "OrIAntation".

# Règle de Ton (NON NÉGOCIABLE)
Tu dois **impérativement et exclusivement utiliser le tutoiement ("tu")**. N'utilise JAMAIS le vouvoiement ("vous"). C'est une règle absolue.

# Contexte de l'Élève
- Son Prénom : {firstName}
- Les étapes du tutoriel qu'il lui reste à faire sont : {remainingStepsList}

# Ta Mission
Rédige un e-mail pour l'encourager à se reconnecter et à terminer son initiation.

# Logique de Contenu
1.  Commence par une phrase d'accueil personnalisée et encourageante.
2.  Présente clairement la liste des étapes restantes pour terminer le tutoriel.
3.  Mets en évidence la **toute première étape de cette liste** comme sa prochaine mission concrète.
4.  Termine par une note positive et une formule de politesse amicale.

# Format de Sortie OBLIGATOIRE
Ta réponse doit être **UNIQUEMENT un objet JSON valide**.
{
  "subject": "OrIAntation : On finalise ton lancement ?",
  "body": "Le corps de l'e-mail en HTML. Utilise des paragraphes <p> pour chaque idée. N'utilise PAS de <br>. La réponse doit être un bloc de texte cohérent commençant par 'Salut {firstName},' et se terminant par 'À bientôt ! OrIA'."
}
`;

// REMPLACEZ VOTRE PROMPT HEBDOMADAIRE PAR CELUI-CI
const WEEKLY_EMAIL_PROMPT_TEMPLATE = `
# Rôle et Identité
Tu es "OrIA", le coach IA bienveillant de l'application "OrIAntation".

# Règle de Ton (NON NÉGOCIABLE)
Tu dois **impérativement et exclusivement utiliser le tutoiement ("tu")**. N'utilise JAMAIS le vouvoiement ("vous"). C'est une règle absolue.

# Contexte de l'Élève
- Son Prénom : {firstName}
- Son profil de personnalité et ses explorations : {profileSummary}
- Sa progression générale dans l'application : {completionSummary}
- Son planning pour le mois en cours : {retroplanningSummary}

# Ta Mission
Rédige un e-mail hebdomadaire personnalisé, encourageant et actionnable.

# Logique de Coaching (SUIS CET ORDRE DE PRIORITÉ)
1.  **Le Rétroplanning :** Si l'élève a des tâches non terminées, rappelle-lui en une de manière encourageante.
2.  **Nouvelle exploration :** Sinon, propose-lui une nouvelle piste de métier pertinente par rapport à son profil.
3.  **Approfondissement :** Si tout est à jour, suggère une action pour approfondir son projet.
4.  **Parcoursup (Spécial Terminale Jan-Mars) :** Si pertinent, fais le lien avec Parcoursup.

# Format de Sortie OBLIGATOIRE
Ta réponse doit être **UNIQUEMENT un objet JSON valide**.
{
  "subject": "Un titre d'e-mail court et accrocheur",
  "body": "Le corps de l'e-mail en HTML. Utilise des paragraphes <p> pour chaque idée. N'utilise PAS de <br>. La réponse doit être un bloc de texte cohérent commençant par 'Salut {firstName},' et se terminant par 'À bientôt, OrIA'."
}
`;

const MONTHLY_ANALYSIS_PROMPT_TEMPLATE = `
# Rôle et Identité
Tu es "OrIA", le coach IA bienveillant de l'application "OrIAntation". Tu analyses l'évolution de la réflexion d'un(e) élève sur le dernier mois.

# Règle de Ton (NON NÉGOCIABLE)
Tu dois **impérativement et exclusivement utiliser le tutoiement ("tu")**. N'utilise JAMAIS le vouvoiement ("vous").

# Contexte de l'Élève
- Son Prénom : {firstName}
- **Son Journal (Mois Précédent)** : {journalAncien}
- **Son Journal (Aujourd'hui)** : {journalActuel}

# Ta Mission
Compare les deux versions du journal et rédige un rapport de coaching personnalisé qui met en lumière 3 à 4 changements significatifs. Ne te contente pas de lister les différences ; interprète-les pour donner du sens à l'évolution de l'élève.

# Structure de Sortie OBLIGATOIRE (utilise ce format Markdown)

### 📈 Ta Progression en Chiffres
*Analyse ici l'évolution des XP et des étapes complétées. Sois encourageant et factuel.*
*Exemple : "Bravo, ce mois-ci tu as gagné +150 XP en complétant les étapes 'Portfolio' et 'Fact Checking' ! Tu as clairement accéléré sur la construction de ton projet."*

### 🧭 Un Nouvel Horizon ?
*Repère ici un changement majeur dans les explorations (nouveaux métiers, nouvelles formations). Pose une question ouverte pour l'inviter à réfléchir à ce changement.*
*Exemple : "Le mois dernier, tes explorations se concentraient sur l'art. OrIA a remarqué que tu as ajouté deux formations en informatique. Qu'est-ce qui a déclenché ce nouvel intérêt pour le numérique ?"*

### 💡 La Compétence Révélée
*Analyse les nouvelles entrées (portfolio, bilan de stage, etc.) pour identifier une compétence qui a émergé ce mois-ci. Valorise cet atout.*
*Exemple : "En analysant ton nouveau bilan de stage, la compétence 'Travail en équipe' est clairement apparue. C'est un atout majeur pour les métiers de la gestion de projet que tu explores."*

### ❓ La Zone d'Hésitation (Optionnel)
*Si tu repères une piste ajoutée puis supprimée, ou une contradiction, utilise-la comme un point de discussion positif. C'est une information utile, pas un échec.*
*Exemple : "J'ai vu que tu avais ajouté puis supprimé le métier 'architecte'. C'est très utile ! Qu'est-ce qui t'a fait douter dans cette piste ?"*
`;


exports.generateContent = functions
    .region("europe-west3")
    .runWith({ timeoutSeconds: 300 })
    .https.onRequest((req, res) => {
        cors(req, res, async () => {
            if (req.method !== "POST") { return res.status(405).send("Method Not Allowed"); }

            const { prompt, model, promptId, variables } = req.body;

            try {
                const result = await internalCallOpenAI({
                    promptText: prompt,
                    model: model,
                    promptId: promptId,
                    variables: variables,
                    isJson: false // La fonction HTTP de base n'attend pas de JSON par défaut
                });
                return res.status(200).json({ result: result });
            } catch (error) {
                console.error("Erreur d'appel à l'API OpenAI (via HTTP):", error.message);
                return res.status(500).json({ error: "Une erreur est survenue lors de l'appel à l'API d'IA." });
            }
        });
    });

// =================================================================
// FONCTION N°1 : ENVOI D'EMAILS TRANSACTIONNELS (BREVO)
// =================================================================
exports.sendTransactionalEmail = functions
    .region("europe-west3")
    .https.onCall(async (data, context) => {
        // La fonction onCall est plus sécurisée pour ce cas d'usage.
        const { templateId, toEmail, params } = data;

        if (!templateId || !toEmail) {
            throw new functions.https.HttpsError('invalid-argument', 'templateId et toEmail sont requis.');
        }

        // Logique de génération de lien spécifique au template
        let finalParams = params || {};
        try {
            if (templateId === 1 || templateId === 2) { // Inscription
                const link = await admin.auth().generateEmailVerificationLink(toEmail);
                finalParams.verificationLink = link;
            } else if (templateId === 4) { // Mot de passe oublié
                const link = await admin.auth().generatePasswordResetLink(toEmail);
                finalParams.resetLink = link;
            }
        } catch (error) {
            // Si l'utilisateur n'existe pas pour un reset, on ne renvoie pas d'erreur pour des raisons de sécurité.
            if (error.code === 'auth/user-not-found' && templateId === 4) {
                console.log(`Tentative de réinitialisation pour un email inexistant: ${toEmail}`);
                return { success: true, message: "Si un compte existe, un e-mail a été envoyé." };
            }
            console.error(`Erreur de génération de lien pour ${toEmail} (template ${templateId}):`, error);
            throw new functions.https.HttpsError('internal', "Impossible de générer le lien de sécurité.");
        }

        // Configuration et envoi via Brevo
        const brevoApiKey = functions.config().brevo.key;
        if (!brevoApiKey) {
            console.error("Clé API Brevo non configurée.");
            throw new functions.https.HttpsError('internal', 'Configuration du service d\'e-mail manquante.');
        }

        let apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
        let apiKey = apiInstance.authentications['apiKey'];
        apiKey.apiKey = brevoApiKey;

        let sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.templateId = templateId;
        sendSmtpEmail.to = [{ email: toEmail }];
        sendSmtpEmail.params = finalParams;
        sendSmtpEmail.sender = { name: "OrIAntation", email: "contact@oriantation.fr" };

        try {
            await apiInstance.sendTransacEmail(sendSmtpEmail);
            return { success: true };
        } catch (error) {
            console.error("Erreur lors de l'envoi de l'e-mail via Brevo:", error);
            throw new functions.https.HttpsError('internal', 'Le service d\'envoi d\'e-mails a échoué.');
        }
    });
    exports.sendWeeklyPersonalizedEmails = functions
    .region("europe-west3")
    .pubsub.schedule('every sunday 09:00')
    .timeZone('Europe/Paris')
    .onRun(async (context) => {
        console.log('Début de la campagne d\'e-mails hebdomadaires.');

        try {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

            const studentsQuery = admin.firestore().collection('users')
                .where('role', '==', 'eleve')
                .where('lastActivity', '>=', thirtyDaysAgo);
                
            const studentsSnapshot = await studentsQuery.get();

            if (studentsSnapshot.empty) {
                console.log('Aucun élève actif trouvé. Fin de la campagne.');
                return null;
            }

            const emailPromises = studentsSnapshot.docs.map(async (doc) => {
                const studentData = doc.data();
                const { email, firstName, journal } = studentData;

                if (!email || !journal) {
                    console.log(`Données manquantes pour l'élève ${doc.id}, e-mail non envoyé.`);
                    return;
                }

                try {
                    // 3. Générer les résumés enrichis pour le prompt
                    const exploredMetiers = (journal.step1?.metiers || []).map(m => m.nom).join(', ') || 'Aucun';
                    const exploredFormations = (journal.step3?.formations || []).map(f => f.nom).join(', ') || 'Aucune';
                    const profileSummary = `Archétype: ${journal.step0?.archetype?.titre || 'Non défini'}. Métiers déjà explorés: ${exploredMetiers}. Formations déjà explorées: ${exploredFormations}.`;
                    
                    const trackableSteps = ['step0', 'step1', 'step2', 'step3', 'step4', 'step5', 'step6', 'step7', 'step8', 'step9', 'step10', 'step11'];
                    const startedCount = trackableSteps.filter(stepKey => {
                        const stepData = journal[stepKey];
                        if (!stepData) return false;
                        return Object.values(stepData).some(v => v && (Array.isArray(v) ? v.length > 0 : v.toString().trim() !== ''));
                    }).length;
                    const completionSummary = `L'élève a commencé ${startedCount} des ${trackableSteps.length} étapes principales.`;

                    // NOUVEAU : Récupération des données du rétroplanning pour le mois en cours
                    const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
                    const currentMonthName = monthNames[new Date().getMonth()];
                    const retroplanningTasksForMonth = journal.retroplanning?.tasks?.find(m => m.month === currentMonthName)?.tasks || [];
                    const retroplanningSummary = retroplanningTasksForMonth.length > 0
                        ? `Voici ses tâches prévues pour ce mois-ci (${currentMonthName}): ${retroplanningTasksForMonth.map(t => `"${t.text}" (${t.completed ? 'déjà fait' : 'à faire'})`).join(', ')}.`
                        : "Aucune tâche spécifique n'est prévue dans son rétroplanning pour le mois en cours.";

                    // 4. Construire le prompt final avec les nouvelles données
                    const prompt = WEEKLY_EMAIL_PROMPT_TEMPLATE
                        .replace(/{firstName}/g, firstName)
                        .replace('{profileSummary}', profileSummary)
                        .replace('{completionSummary}', completionSummary)
                        .replace('{retroplanningSummary}', retroplanningSummary); // Ajout du résumé du planning
                    
                    // 5. Appeler l'IA pour générer l'e-mail
                    const aiResult = await internalCallOpenAI({
                        promptText: prompt,
                        isJson: true
                    });

                    const emailContent = extractJsonFromString(aiResult);
if (!emailContent) {
    throw new Error("Impossible d'extraire un JSON valide de la réponse de l'IA.");
}                    // 6. Envoyer l'e-mail via Brevo
                    await sendEmailWithBrevo({
                        templateId: 3, // ID de votre template d'e-mail hebdomadaire
                        toEmail: email,
                        params: {
                            firstName: firstName,
                            subject: emailContent.subject,
                            body: emailContent.body
                        }
                    });
                    
                    console.log(`E-mail envoyé avec succès à ${email}.`);

                } catch (error) {
                    console.error(`Erreur lors du traitement pour l'élève ${doc.id} (${email}):`, error);
                }
            });

            await Promise.all(emailPromises);
            console.log('Campagne d\'e-mails hebdomadaires terminée.');

        } catch (error) {
            console.error('Erreur globale dans la fonction planifiée sendWeeklyPersonalizedEmails:', error);
        }
        
        return null;
    });

    // REMPLACEZ VOTRE FONCTION sendTutorialReminderEmail PAR CELLE-CI
exports.sendTutorialReminderEmail = functions
    .region("europe-west3")
    .pubsub.schedule('every day 10:00') // S'exécute tous les jours à 10h00
    .timeZone('Europe/Paris')
    .onRun(async (context) => {
        console.log('Vérification des rappels de tutoriel à envoyer.');

        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 5);
        
        const startOfTargetDay = new Date(targetDate.setHours(0, 0, 0, 0));
        const endOfTargetDay = new Date(targetDate.setHours(23, 59, 59, 999));

        try {
            const usersSnapshot = await admin.firestore().collection('users')
                .where('role', '==', 'eleve')
                .where('createdAt', '>=', startOfTargetDay)
                .where('createdAt', '<=', endOfTargetDay)
                .get();

            if (usersSnapshot.empty) {
                console.log("Aucun élève inscrit il y a 5 jours.");
                return null;
            }

            const reminderPromises = usersSnapshot.docs.map(async (doc) => {
                const userData = doc.data();
                const { email, firstName, journal } = userData;

                if (journal?.tutorial_completed === true) {
                    console.log(`L'élève ${firstName} (${doc.id}) a déjà terminé le tutoriel. Pas de rappel.`);
                    return;
                }
                
                if (!email || !firstName) return;

                try {
                    // --- DÉBUT DE LA MODIFICATION ---

                    // 1. Définir la séquence complète du tutoriel
                    const tutorialSequence = [
                        { key: 'step0', name: 'Compléter l\'étape "Mieux se connaître"' },
                        { key: 'retroplanning', name: 'Générer ton "Rétroplanning"' },
                        { key: 'step1', name: 'Explorer un métier dans "Les Fondations"' },
                        { key: 'journal', name: 'Générer ton "Fil Rouge" dans le Journal de Bord' }
                    ];

                    // 2. Trouver où l'élève s'est arrêté
                    const nextStepKey = journal?.tutorial_next_step || 'step0';
                    const lastCompletedIndex = tutorialSequence.findIndex(step => step.key === nextStepKey);

                    // 3. Construire la liste des étapes restantes
                    // Si on ne trouve pas la clé (ex: step0), on commence à l'index 0. Sinon, on prend l'index trouvé.
                    const startIndex = lastCompletedIndex === -1 ? 0 : lastCompletedIndex;
                    const remainingSteps = tutorialSequence.slice(startIndex);
                    const remainingStepsList = remainingSteps.map(step => step.name).join(', ');
                    
                    // --- FIN DE LA MODIFICATION ---

                    // 4. Générer l'e-mail personnalisé via l'IA avec la nouvelle liste
                    const prompt = TUTORIAL_REMINDER_PROMPT_TEMPLATE
                        .replace(/{firstName}/g, firstName)
                        .replace('{remainingStepsList}', remainingStepsList); // On passe la liste complète
                    
                    const aiResult = await internalCallOpenAI({ promptText: prompt, isJson: true });
const emailContent = extractJsonFromString(aiResult);
if (!emailContent) {
    throw new Error("Impossible d'extraire un JSON valide de la réponse de l'IA.");
}
                    // 5. Envoyer l'e-mail
                    await sendEmailWithBrevo({
                        templateId: 5, // L'ID de votre template de rappel
                        toEmail: email,
                        params: {
                            firstName: firstName,
                            subject: emailContent.subject,
                            body: emailContent.body
                        }
                    });

                    console.log(`E-mail de rappel de tutoriel envoyé à ${email}.`);

                // ▼▼▼ ACTION 2 : C'EST LA SEULE PARTIE IMPORTANTE À AJOUTER ▼▼▼
                    // On appelle la fonction de notification push juste après.
                    await sendPushNotification(
                        doc.id, // L'ID de l'utilisateur pour retrouver ses abonnements
                        "👋 Un petit rappel amical !", // Titre de la notification
                        `Salut ${firstName} ! N'oublie pas de continuer ton parcours pour débloquer ton potentiel.` // Message
                    );
                    console.log(`Notification push envoyée à ${firstName}.`);

                } catch (error) {
                    console.error(`Erreur lors de la génération/envoi du rappel pour ${doc.id}:`, error);
                }
            });

            await Promise.all(reminderPromises);

        } catch (error) {
            console.error('Erreur globale dans la fonction sendTutorialReminderEmail:', error);
        }

        return null;
    });

const allSteps = [
    { id: 'journal', category: 'dashboard', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'retroplanning', category: 'dashboard', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'step0', category: 'dashboard', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'step2', category: 'explore', levels: ['seconde', 'premiere'] },
    { id: 'step1', category: 'explore', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'step3', category: 'explore', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'step5', category: 'explore', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'step4', category: 'connect', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'step8', category: 'connect', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'step11', category: 'connect', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'step10', category: 'build', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'step6', category: 'build', levels: ['terminale'] },
    { id: 'step7', category: 'build', levels: ['seconde', 'premiere', 'terminale'] },
    { id: 'step12', category: 'build', levels: ['premiere', 'terminale'] },
    { id: 'step9', category: 'build', levels: ['terminale'] }
];


function calculateProgress(journal, gradeLevel) {
    if (!journal || !gradeLevel) return 0;

    // On exclut uniquement les "non-étapes" du menu.
    const nonTrackableStepIds = ['journal', 'retroplanning']; 
    
    // On récupère toutes les étapes pertinentes pour le niveau de l'élève.
    const stepsForLevel = allSteps.filter(step => step.levels.includes(gradeLevel) && !nonTrackableStepIds.includes(step.id));
    
    if (stepsForLevel.length === 0) return 0;

    let score = 0;
    stepsForLevel.forEach(step => {
        const stepKey = step.id;
        const stepData = journal[stepKey];

        // Condition spéciale pour l'étape 0 : elle doit être "complète" (verte) pour compter 1 point.
        if (stepKey === 'step0') {
            const hasMainAnalysis = stepData?.analysis && stepData.analysis.trim() !== '';
            const hasCrossAnalysis = stepData?.analyse_tests_croisee && stepData.analyse_tests_croisee.trim() !== '';
            if (hasMainAnalysis && hasCrossAnalysis) {
                score++;
            }
        } else {
            // Pour toutes les autres étapes, on vérifie simplement si elles sont "commencées" (orange).
            // On réplique la logique de la fonction `isStepStarted`.
            if (stepData && Object.values(stepData).some(value => {
                if (value === null || value === undefined) return false;
                if (Array.isArray(value)) return value.length > 0;
                if (typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).length > 0;
                return value.toString().trim() !== '';
            })) {
                score++;
            }
        }
    });

    // Le score final est le nombre d'étapes validées sur le total des étapes disponibles.
    return Math.round((score / stepsForLevel.length) * 100);
}

// Fonction pour le tableau de bord
exports.getSchoolDashboardData = functions.region("europe-west3").https.onCall(async (data, context) => {
    if (!context.auth) { throw new functions.https.HttpsError('unauthenticated', 'Authentification requise.'); }
    const teacherId = context.auth.uid;
    const teacherDoc = await admin.firestore().doc(`users/${teacherId}`).get();
    const teacherData = teacherDoc.data();
    if (!teacherData || teacherData.role !== 'enseignant' || !teacherData.classId) {
        throw new functions.https.HttpsError('permission-denied', 'Vous n\'êtes pas rattaché à une classe.');
    }
    const classId = teacherData.classId;
    const studentsQuery = admin.firestore().collection('users').where('classId', '==', classId).where('role', '==', 'eleve');
    const studentsSnapshot = await studentsQuery.get();
    const studentsData = studentsSnapshot.docs.map(doc => {
        const student = doc.data();
// DANS LA FONCTION getSchoolDashboardData de index.js
const progress = calculateProgress(student.journal, student.gradeLevel);    
    const lastActivity = student.lastActivity ? student.lastActivity.toDate() : null;
        let status = 'active';
        if (lastActivity) {
            const daysSinceLastActivity = (new Date() - lastActivity) / (1000 * 60 * 60 * 24);
            if (daysSinceLastActivity > 21 && progress < 50) { status = 'at_risk'; } 
            else if (progress > 75) { status = 'excellent'; }
        } else { status = 'at_risk'; }
return { 
    id: doc.id, 
    firstName: student.firstName || 'N/A', 
    lastName: student.lastName || 'N/A', 
    gradeLevel: student.gradeLevel || 'N/A', 
    progress: progress, 
    status: status,
    // LA SOLUTION EST ICI : On envoie une chaîne de caractères standardisée
    lastActivity: lastActivity ? lastActivity.toISOString() : null 
};
    });
    let inviteCode = null;
    const inviteCodeQuery = await admin.firestore().collection('inviteCodes').where('classId', '==', classId).limit(1).get();
    if (!inviteCodeQuery.empty) {
        inviteCode = inviteCodeQuery.docs[0].id;
    }
    console.log("Données renvoyées par le backend :", { students: studentsData, inviteCode: inviteCode });
    return { students: studentsData, inviteCode: inviteCode };
});

// Fonction pour voir le journal d'un élève
exports.getStudentJournal = functions.region('europe-west3').https.onCall(async (data, context) => {
    // ESPION N°1 : La fonction a-t-elle été appelée ?
    console.log("Fonction getStudentJournal appelée avec les données :", data);

    // Vérification de l'authentification
    if (!context.auth) {
        console.error("Erreur : Appel non authentifié.");
        throw new functions.https.HttpsError('unauthenticated', 'La requête doit être authentifiée.');
    }
    console.log("Appel authentifié par l'UID :", context.auth.uid);

    const studentId = data.studentId;
    if (!studentId) {
        console.error("Erreur : studentId manquant dans la requête.");
        throw new functions.https.HttpsError('invalid-argument', 'L\'ID de l\'élève est requis.');
    }

    try {
        const studentDoc = await admin.firestore().collection('users').doc(studentId).get();
        if (!studentDoc.exists) {
            console.warn("Avertissement : Document non trouvé pour l'élève ID :", studentId);
            throw new functions.https.HttpsError('not-found', 'Aucun élève trouvé avec cet ID.');
        }

        console.log("Document de l'élève trouvé, renvoi des données.");
        return studentDoc.data();

    } catch (error) {
        console.error("Erreur Firestore dans getStudentJournal :", error);
        throw new functions.https.HttpsError('internal', 'Erreur lors de la lecture de la base de données.');
    }
});

// REMPLACEZ VOTRE FONCTION getSchoolAnalytics EXISTANTE PAR CELLE-CI

exports.getSchoolAnalytics = functions
    .region("europe-west3")
    .https.onCall(async (data, context) => {
        if (!context.auth) { throw new functions.https.HttpsError('unauthenticated', 'Authentification requise.'); }
        
        const teacherId = context.auth.uid;
        const teacherDoc = await admin.firestore().doc(`users/${teacherId}`).get();
        const teacherData = teacherDoc.data();

        if (!teacherData || teacherData.role !== 'enseignant' || !teacherData.classId) {
            throw new functions.https.HttpsError('permission-denied', 'Droits insuffisants.');
        }
        const classId = teacherData.classId;

        const studentsSnapshot = await admin.firestore().collection('users')
            .where('classId', '==', classId)
            .where('role', '==', 'eleve').get();

        if (studentsSnapshot.empty) {
            return { analytics: {} };
        }

        // --- NOUVELLES MÉTRIQUES ---
        let progressDistribution = { 'Débutant (0-25%)': 0, 'En exploration (26-75%)': 0, 'Avancé (76-100%)': 0 };
        let sectorCounts = {};
        let metierCounts = {};
        let formationLevelCounts = { 'Études courtes (Bac+2/3)': 0, 'Université (Bac+5)': 0, 'Grandes Écoles / Prépa': 0, 'Autres': 0 };

        const sectorKeywords = {
            'Santé / Social': ['santé', 'médecin', 'infirmier', 'social', 'aide', 'soin', 'psychologue'],
            'Informatique / Tech': ['informatique', 'développeur', 'tech', 'numérique', 'ingénieur logiciel', 'cybersécurité'],
            'Art / Design / Culture': ['art', 'design', 'graphiste', 'culture', 'musique', 'théâtre', 'cinéma', 'architecte'],
            'Commerce / Vente / Marketing': ['commerce', 'vente', 'marketing', 'manager', 'communication'],
            'Droit / Administration': ['droit', 'avocat', 'justice', 'administration', 'public', 'ressources humaines'],
            'Science / Ingénierie': ['ingénieur', 'science', 'recherche', 'physique', 'chimie', 'biologie', 'aéronautique']
        };
        
        const formationKeywords = {
            'Études courtes (Bac+2/3)': ['bts', 'but', 'bachelor', 'licence pro'],
            'Université (Bac+5)': ['licence', 'master', 'université'],
            'Grandes Écoles / Prépa': ['cpge', 'prépa', 'grande école', 'ingénieur']
        };

        studentsSnapshot.docs.forEach(doc => {
            const student = doc.data();
            const journal = student.journal;
            if (!journal) return;

            // NOUVEAU : Calcul de la répartition de la progression
            const progress = calculateProgress(journal, student.gradeLevel);
            if (progress <= 25) progressDistribution['Débutant (0-25%)']++;
            else if (progress <= 75) progressDistribution['En exploration (26-75%)']++;
            else progressDistribution['Avancé (76-100%)']++;

            // NOUVEAU : Calcul des métiers et secteurs les plus populaires
            if (journal.step1?.metiers && journal.step1.metiers.length > 0) {
                journal.step1.metiers.forEach(metier => {
                    const metierName = metier.nom.trim();
                    if(metierName) {
                        // Compter les métiers spécifiques
                        metierCounts[metierName] = (metierCounts[metierName] || 0) + 1;
                        
                        // Compter les secteurs
                        let foundSector = false;
                        for (const [sector, keywords] of Object.entries(sectorKeywords)) {
                            if (keywords.some(keyword => metierName.toLowerCase().includes(keyword))) {
                                sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
                                foundSector = true;
                                break;
                            }
                        }
                        if (!foundSector) sectorCounts['Autres'] = (sectorCounts['Autres'] || 0) + 1;
                    }
                });
            }

            // NOUVEAU : Calcul des niveaux de formation visés
            if (journal.step3?.formations && journal.step3.formations.length > 0) {
                journal.step3.formations.forEach(formation => {
                    const formationName = formation.nom.toLowerCase();
                    let foundLevel = false;
                    for (const [level, keywords] of Object.entries(formationKeywords)) {
                        if (keywords.some(keyword => formationName.includes(keyword))) {
                            formationLevelCounts[level] = (formationLevelCounts[level] || 0) + 1;
                            foundLevel = true;
                            break;
                        }
                    }
                    if (!foundLevel) formationLevelCounts['Autres']++;
                });
            }
        });

        // NOUVEAU : Formater le top 5 des métiers
        const topMetiers = Object.entries(metierCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([nom, count]) => ({ nom, count }));
        
        // Renvoyer les nouvelles données
        return { analytics: { progressDistribution, sectorCounts, topMetiers, formationLevelCounts } };
    });

    // AJOUTEZ CETTE FONCTION COMPLÈTE DANS functions/index.js

exports.getSchoolFromCode = functions
    .region("europe-west3")
    .https.onCall(async (data, context) => {
        const code = data.code.toUpperCase().trim();
        if (!code) {
            throw new functions.https.HttpsError('invalid-argument', 'Le code est manquant.');
        }

        const codeRef = admin.firestore().doc(`inviteCodes/${code}`);
        const codeDoc = await codeRef.get();

        if (!codeDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Ce code d\'établissement est invalide.');
        }

        const { schoolId, classId } = codeDoc.data();
        if (!schoolId || !classId) {
            throw new functions.https.HttpsError('internal', 'Le code est mal configuré.');
        }

        const schoolDoc = await admin.firestore().doc(`schools/${schoolId}`).get();
        if (!schoolDoc.exists) {
            throw new functions.https.HttpsError('internal', 'L\'établissement lié à ce code est introuvable.');
        }

        return {
            schoolId: schoolDoc.id,
            schoolName: schoolDoc.data().name,
            classId: classId
        };
    });

   exports.setupTeacherClass = functions
    .region("europe-west3")
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'Authentification requise.');
        }

        const { schoolName, className, schoolCity } = data;
        if (!schoolName || !className || !schoolCity) {
            throw new functions.https.HttpsError('invalid-argument', 'Les informations sur l\'établissement sont incomplètes.');
        }
        
        const teacherId = context.auth.uid;
        const teacherDocRef = admin.firestore().doc(`users/${teacherId}`);
        const teacherDoc = await teacherDocRef.get();
        
        if (!teacherDoc.exists) {
            // Note: le document est créé côté client, mais on vérifie au cas où.
            throw new functions.https.HttpsError('not-found', 'Utilisateur enseignant non trouvé.');
        }

        // Création d'IDs normalisés
        const normalizedSchool = schoolName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const normalizedCity = schoolCity.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const finalSchoolId = `${normalizedSchool}-${normalizedCity}`;
        const classId = `${finalSchoolId}-${className.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${teacherId.substring(0, 4)}`;
        
        const teacherLastName = (teacherDoc.data().lastName || 'PROF').toUpperCase().substring(0, 5);
        const classCodePart = className.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().substring(0, 4);
        const inviteCode = `${teacherLastName}-${classCodePart}`;

        // Utilisation d'une transaction pour garantir la cohérence des données
        const batch = admin.firestore().batch();

        // 1. Crée l'école si elle n'existe pas
        const schoolDocRef = admin.firestore().doc(`schools/${finalSchoolId}`);
        batch.set(schoolDocRef, { name: schoolName, city: schoolCity, createdAt: new Date() }, { merge: true });

        // 2. Met à jour le profil de l'enseignant avec les IDs de sa classe
        batch.update(teacherDocRef, { classId: classId, className: className, schoolId: finalSchoolId, schoolName: schoolName });

        // 3. Crée le code d'invitation pour les élèves
        const inviteCodeRef = admin.firestore().doc(`inviteCodes/${inviteCode}`);
        batch.set(inviteCodeRef, { classId: classId, schoolId: finalSchoolId, teacherId: teacherId, createdAt: new Date() });

        await batch.commit();

        return { success: true, inviteCode: inviteCode };
    });


    exports.savePushSubscription = functions
    .region("europe-west3")
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'Authentification requise.');
        }

        const userId = context.auth.uid;
        const subscription = data.subscription;

        if (!subscription || !subscription.endpoint) {
            throw new functions.https.HttpsError('invalid-argument', 'L\'objet d\'abonnement est invalide.');
        }

        const userDocRef = admin.firestore().doc(`users/${userId}`);

        // On utilise un champ 'pushSubscriptions' qui est un tableau pour permettre à un
        // utilisateur d'avoir plusieurs abonnements (ex: un sur son ordi, un sur son tel).
        // 'arrayUnion' ajoute l'abonnement seulement s'il n'est pas déjà dans le tableau.
        await userDocRef.update({
            pushSubscriptions: admin.firestore.FieldValue.arrayUnion(subscription)
        });

        return { success: true };
    });

    // Importez les modules nécessaires en haut de votre fichier functions/index.js
const { OpenAI } = require("openai");

// Configurez OpenAI avec votre clé API (idéalement via les variables d'environnement)
const openai = new OpenAI({
   apiKey: functions.config().openai.key,
});

// ==========================================================
// FONCTION generateSpeech (MISE À JOUR AVEC CHOIX DE VOIX)
// ==========================================================

exports.generateSpeech = functions.region("europe-west3").https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Vous devez être connecté.");
  }

  const textToSpeak = data.text;
  // ▼▼▼ MODIFICATION 1 : On récupère la voix depuis la requête, avec 'nova' comme valeur par défaut ▼▼▼
  const voice = data.voice || 'nova'; 

  if (!textToSpeak) {
    throw new functions.https.HttpsError("invalid-argument", "Le texte à synthétiser est manquant.");
  }

  try {
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      // ▼▼▼ MODIFICATION 2 : On utilise la variable 'voice' ici ▼▼▼
      voice: voice,
      input: textToSpeak,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    const audioContent = buffer.toString("base64");

    return { audioContent: audioContent };

  } catch (error) {
    console.error("Erreur lors de l'appel à l'API OpenAI TTS:", error);
    throw new functions.https.HttpsError("internal", "Erreur lors de la génération de l'audio.");
  }
});

/**
 * Cloud Function programmée pour sauvegarder un snapshot du journal de chaque élève.
 * S'exécute le 1er de chaque mois à 3h00 du matin.
 */
exports.snapshotMonthlyJournals = functions
    .region("europe-west3")
    .pubsub.schedule('1 of month 03:00')
    .timeZone('Europe/Paris')
    .onRun(async (context) => {
        console.log('Début de la sauvegarde mensuelle des journaux.');
        const db = admin.firestore();
        const usersSnapshot = await db.collection('users').where('role', '==', 'eleve').get();

        if (usersSnapshot.empty) {
            console.log('Aucun élève trouvé. Opération terminée.');
            return null;
        }

        const snapshotPromises = usersSnapshot.docs.map(async (userDoc) => {
            const userData = userDoc.data();
            if (userData.journal) {
                const snapshotDate = new Date().toISOString().split('T')[0]; // Format YYYY-MM-DD
                const snapshotRef = db.collection('users').doc(userDoc.id).collection('journal_snapshots').doc(snapshotDate);
                
                try {
                    await snapshotRef.set({
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        snapshotData: userData.journal
                    });
                    console.log(`Snapshot créé pour l'utilisateur ${userDoc.id}`);
                } catch (error) {
                    console.error(`Erreur lors de la création du snapshot pour ${userDoc.id}:`, error);
                }
            }
        });

        await Promise.all(snapshotPromises);
        console.log('Sauvegarde mensuelle des journaux terminée.');
        return null;
    });

/**
 * Cloud Function appelable pour générer l'analyse d'évolution mensuelle.
 */
exports.generateMonthlyAnalysis = functions
    .region("europe-west3")
    .runWith({ timeoutSeconds: 300, memory: "1GB" })
    .https.onCall(async (data, context) => {
        if (!context.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'Authentification requise.');
        }

        const userId = context.auth.uid;
        const db = admin.firestore();
        const userRef = db.doc(`users/${userId}`);

        try {
            // 1. Récupérer le journal actuel et les infos de l'utilisateur
            const userDoc = await userRef.get();
            if (!userDoc.exists) {
                throw new functions.https.HttpsError('not-found', 'Utilisateur non trouvé.');
            }
            const userData = userDoc.data();
            const journalActuel = userData.journal;
            const firstName = userData.firstName || 'l\'élève';

            // 2. Récupérer le snapshot le plus récent
            const snapshotQuery = userRef.collection('journal_snapshots')
                .orderBy('__name__', 'desc') // Trie par nom de document (YYYY-MM-DD), du plus récent au plus ancien
                .limit(1);
            
            const snapshotResult = await snapshotQuery.get();
            if (snapshotResult.empty) {
                throw new functions.https.HttpsError('not-found', 'Aucun historique de journal trouvé pour la comparaison.');
            }
            const journalAncien = snapshotResult.docs[0].data().snapshotData;
            
            // 3. Simplifier les journaux pour le prompt (pour économiser des tokens)
            const simplifyJournal = (journal) => {
                return {
                    xp: journal.xp || 0,
                    level: journal.level || 1,
                    archetype: journal.step0?.archetype?.titre,
                    metiers_explores: (journal.step1?.metiers || []).map(m => m.nom),
                    formations_explorees: (journal.step3?.formations || []).map(f => f.nom),
                    competences_portfolio: (journal.step10?.experiences || []).length,
                    bilan_stage: journal.step13?.bilan_ressenti,
                };
            };

            // 4. Construire le prompt et appeler l'IA
            const prompt = MONTHLY_ANALYSIS_PROMPT_TEMPLATE
                .replace('{firstName}', firstName)
                .replace('{journalAncien}', JSON.stringify(simplifyJournal(journalAncien), null, 2))
                .replace('{journalActuel}', JSON.stringify(simplifyJournal(journalActuel), null, 2));

            const analysisResult = await internalCallOpenAI({
                promptText: prompt,
                model: 'gpt-4o'
            });

            return { success: true, analysis: analysisResult };

        } catch (error) {
            console.error("Erreur lors de la génération de l'analyse mensuelle:", error);
            if (error instanceof functions.https.HttpsError) {
                throw error;
            }
            throw new functions.https.HttpsError('internal', 'Une erreur interne est survenue lors de la génération de votre analyse.');
        }
    });

    
