// L'import V1 CORRECT et EXPLICITE
const functions = require("firebase-functions/v1");

// Les autres imports nécessaires
const admin = require("firebase-admin");
const axios = require("axios");
const SibApiV3Sdk = require('@getbrevo/brevo');
const cors = require('cors')({origin: true});

// Initialisation de Firebase Admin
admin.initializeApp();

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


// MODIFIEZ VOTRE FONCTION generateContent POUR UTILISER LA NOUVELLE FONCTION INTERNE
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
    .https.onRequest((req, res) => {
        cors(req, res, async () => {
            try {
                const { templateId, toEmail, params } = req.body.data;
                await sendEmailWithBrevo({ templateId, toEmail, params });
                // Réponse de succès générique pour la réinitialisation de mot de passe
                if (templateId === 4) {
                    return res.status(200).send({ success: true, message: "Si un compte est associé à cette adresse, un e-mail a été envoyé." });
                }
                return res.status(200).send({ success: true, message: "Email envoyé." });
            } catch (error) {
                console.error("Erreur d'envoi Brevo (via HTTP):", error.message);
                return res.status(500).send({ error: "Erreur lors de l'envoi de l'email." });
            }
        });
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

                    const emailContent = JSON.parse(aiResult);

                    // 6. Envoyer l'e-mail via Brevo
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
                    const emailContent = JSON.parse(aiResult);

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

// Helper function pour calculer la progression (inchangée)
function calculateProgress(journal) {
    if (!journal) return 0;
    const trackableSteps = ['step0', 'step1', 'step2', 'step3', 'step4', 'step5', 'step6', 'step7', 'step8', 'step9', 'step10', 'step11'];
    let startedCount = 0;
    trackableSteps.forEach(stepKey => {
        const stepData = journal[stepKey];
        if (stepData && typeof stepData === 'object' && Object.values(stepData).some(v => v && (Array.isArray(v) ? v.length > 0 : v.toString().trim() !== ''))) {
            startedCount++;
        }
    });
    return trackableSteps.length > 0 ? Math.round((startedCount / trackableSteps.length) * 100) : 0;
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
        const progress = calculateProgress(student.journal);
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
            lastActivity: lastActivity // On ajoute la date d'activité aux données renvoyées
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
exports.getStudentJournal = functions.region("europe-west3").https.onCall(async (data, context) => {
    if (!context.auth) { throw new functions.https.HttpsError('unauthenticated', 'Authentification requise.'); }
    const teacherId = context.auth.uid;
    const { studentId } = data;
    if (!studentId) { throw new functions.https.HttpsError('invalid-argument', 'L\'ID de l\'élève est manquant.'); }
    const teacherDoc = await admin.firestore().doc(`users/${teacherId}`).get();
    const teacherData = teacherDoc.data();
    if (!teacherData || teacherData.role !== 'enseignant' || !teacherData.classId) {
        throw new functions.https.HttpsError('permission-denied', 'Vos droits sont insuffisants.');
    }
    const studentDoc = await admin.firestore().doc(`users/${studentId}`).get();
    const studentData = studentDoc.data();
    if (!studentData || studentData.classId !== teacherData.classId) {
        throw new functions.https.HttpsError('permission-denied', 'Vous ne pouvez pas accéder aux données de cet élève.');
    }
    return {
        firstName: studentData.firstName || 'N/A',
        schoolName: studentData.schoolName || 'N/A',
        gradeLevel: studentData.gradeLevel || 'N/A',
        journal: studentData.journal || {}
    };
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
            const progress = calculateProgress(journal);
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
        console.log("Fonction getSchoolFromCode appelée avec le code :", code); // LOG 1

        if (!code) {
            throw new functions.https.HttpsError('invalid-argument', 'Le code est manquant.');
        }

        const codeRef = admin.firestore().doc(`inviteCodes/${code}`);
        const codeDoc = await codeRef.get();

        console.log("Document de code trouvé :", codeDoc.exists); // LOG 2

        if (!codeDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Ce code d\'établissement est invalide.');
        }

        const codeData = codeDoc.data();
        console.log("Données du code :", JSON.stringify(codeData)); // LOG 3 : LE PLUS IMPORTANT

        const schoolId = codeData.schoolId;
        const classId = codeData.classId;

        console.log("schoolId extrait :", schoolId); // LOG 4

        if (!schoolId || !classId) {
            console.error("Données manquantes dans le code ! schoolId ou classId est vide.");
            throw new functions.https.HttpsError('internal', 'Le code est mal configuré (données manquantes).');
        }

        const schoolRef = admin.firestore().doc(`schools/${schoolId}`);
        const schoolDoc = await schoolRef.get();

        console.log("Document d'école trouvé :", schoolDoc.exists); // LOG 5

        if (!schoolDoc.exists) {
            console.error("L'établissement avec l'ID", schoolId, "n'a pas été trouvé dans la collection 'schools'.");
            throw new functions.https.HttpsError('internal', 'Erreur interne, l\'établissement lié à ce code n\'a pas été trouvé.');
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
            throw new functions.https.HttpsError('unauthenticated', 'Authentification requise pour cette action.');
        }

        const { schoolName, className, schoolCity } = data;
        if (!schoolName || !className || !schoolCity) {
            throw new functions.https.HttpsError('invalid-argument', 'Le nom de l\'établissement, le nom de la classe et la ville sont requis.');
        }
        
        const teacherId = context.auth.uid;
        const teacherDocRef = admin.firestore().doc(`users/${teacherId}`);
        const teacherDoc = await teacherDocRef.get();
        
        if (!teacherDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Utilisateur enseignant non trouvé.');
        }
        const teacherData = teacherDoc.data();

        const normalizedSchool = schoolName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const normalizedCity = schoolCity.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const normalizedClass = className.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        
        const finalSchoolId = `${normalizedSchool}-${normalizedCity}`;
        const classId = `${finalSchoolId}-${normalizedClass}-${teacherId.substring(0, 4)}`;
        
        const teacherLastName = (teacherData.lastName || 'PROF').toUpperCase().substring(0, 5);
        const classCodePart = className.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().substring(0, 4);
        const inviteCode = `${teacherLastName}-${classCodePart}`;

        // ** LA CORRECTION EST ICI **
        // On crée une référence au document de l'école
        const schoolDocRef = admin.firestore().doc(`schools/${finalSchoolId}`);

        // On vérifie si l'école existe déjà et on la crée si besoin.
        const schoolDoc = await schoolDocRef.get();
        if (!schoolDoc.exists) {
            await schoolDocRef.set({
                name: schoolName,
                city: schoolCity,
                createdAt: new Date()
            });
        }
        
        await teacherDocRef.update({
            classId: classId,
            className: className
        });

        await admin.firestore().doc(`inviteCodes/${inviteCode}`).set({
            classId: classId,
            schoolId: finalSchoolId,
            teacherId: teacherId,
            createdAt: new Date()
        });

        return { success: true, inviteCode: inviteCode };
    });