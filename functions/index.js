// deploiement final de chez final

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
exports.getSchoolDashboardData = functions.region("europe-west1").https.onCall(async (data, context) => {
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
        return { id: doc.id, firstName: student.firstName || 'N/A', lastName: student.lastName || 'N/A', gradeLevel: student.gradeLevel || 'N/A', progress: progress, status: status };
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
exports.getStudentJournal = functions.region("europe-west1").https.onCall(async (data, context) => {
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
    .region("europe-west1")
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
    .region("europe-west1")
    .https.onCall(async (data, context) => {
        // 1. On récupère et normalise le code envoyé par le frontend.
        const code = data.code.toUpperCase().trim();
        if (!code) {
            // Si aucun code n'est envoyé, on renvoie une erreur.
            throw new functions.https.HttpsError('invalid-argument', 'Le code est manquant.');
        }

        // 2. On cherche le document qui a pour ID le code fourni.
        const codeRef = admin.firestore().doc(`inviteCodes/${code}`);
        const codeDoc = await codeRef.get();

        // 3. Si le document n'existe pas, le code est invalide.
        if (!codeDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Ce code d\'établissement est invalide.');
        }

        // 4. On récupère les informations contenues dans le document : l'ID de l'école et de la classe.
        const codeData = codeDoc.data();
        const schoolId = codeData.schoolId;
        const classId = codeData.classId;

        // Sécurité : on vérifie que les données sont bien présentes.
        if (!schoolId || !classId) {
             throw new functions.https.HttpsError('internal', 'Le code est mal configuré (données manquantes).');
        }

        // 5. On utilise l'ID de l'école pour récupérer le nom complet de l'établissement.
        const schoolRef = admin.firestore().doc(`schools/${schoolId}`);
        const schoolDoc = await schoolRef.get();

        // 6. Si l'établissement n'existe pas, il y a une erreur de cohérence dans la base de données.
        if (!schoolDoc.exists) {
            throw new functions.https.HttpsError('internal', 'Erreur interne, l\'établissement lié à ce code n\'a pas été trouvé.');
        }
        
        // 7. Si tout est correct, on renvoie les trois informations clés au frontend.
        return {
            schoolId: schoolDoc.id,
            schoolName: schoolDoc.data().name,
            classId: classId
        };
    });

    exports.setupTeacherClass = functions
    .region("europe-west1")
    .https.onCall(async (data, context) => {
        // 1. On vérifie que l'utilisateur est bien authentifié
        if (!context.auth) {
            throw new functions.https.HttpsError('unauthenticated', 'Authentification requise.');
        }

        const { schoolName, className } = data;
        if (!schoolName || !className) {
            throw new functions.https.HttpsError('invalid-argument', 'Le nom de l\'établissement et de la classe sont requis.');
        }
        
        const teacherId = context.auth.uid;
        const teacherDocRef = admin.firestore().doc(`users/${teacherId}`);
        const teacherDoc = await teacherDocRef.get();
        const teacherData = teacherDoc.data();

        // 2. On génère un ID unique pour la classe et un code d'invitation simple
        const normalizedSchool = schoolName.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const normalizedClass = className.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const classId = `${normalizedSchool}-${normalizedClass}-${teacherId.substring(0, 4)}`;
        
        const teacherLastName = (teacherData.lastName || 'PROF').toUpperCase().substring(0, 5);
        const classCodePart = className.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().substring(0, 4);
        const inviteCode = `${teacherLastName}-${classCodePart}`;

        // 3. On met à jour le document de l'enseignant avec son classId
        await teacherDocRef.update({
            classId: classId,
            className: className // On peut aussi stocker le nom de la classe
        });

        // 4. On crée le document pour le code d'invitation
        await admin.firestore().doc(`inviteCodes/${inviteCode}`).set({
            classId: classId,
            schoolId: teacherData.schoolId, // On réutilise le schoolId déjà présent
            teacherId: teacherId,
            createdAt: new Date()
        });

        // 5. On renvoie le succès et le code créé au frontend
        return { success: true, inviteCode: inviteCode };
    });

