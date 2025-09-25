// importer.js
const admin = require('firebase-admin');
const fs = require('fs');
const xml2js = require('xml2js');

// --- Configuration (comme avant) ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- MODIFICATION : Indiquez ici vos noms de fichiers et de collection ---
const dataFile = 'fiches_métier.xml'; // Mettez le nom de votre fichier XML ici
const collectionName = 'onisep_metiers_xml'; // Choisissez un nom pour votre collection

async function importXmlData() {
  console.log(`Lecture du fichier XML : ${dataFile}...`);

  // 1. Lire le fichier XML
  const xmlData = fs.readFileSync(dataFile, 'utf8');

  // 2. Convertir le XML en objet JavaScript
  const parser = new xml2js.Parser({ explicitArray: false }); // 'explicitArray: false' simplifie l'objet final
  const parsedData = await parser.parseStringPromise(xmlData);

  // !!! POINT TRÈS IMPORTANT !!!
  // L'emplacement de votre liste de métiers dépend de la structure du fichier XML.
  // Décommentez la ligne ci-dessous pour voir la structure de votre objet et trouver le bon chemin.
   // console.log(JSON.stringify(parsedData, null, 2));

  // Adaptez la ligne suivante au chemin trouvé.
  // Par exemple : parsedData.ONISEP.METIERS.METIER ou parsedData.root.items.item
  const metiers = parsedData.metiers.metier;

  if (!metiers || !Array.isArray(metiers)) {
    console.error("Erreur : Impossible de trouver la liste des métiers dans le fichier XML.");
    console.error("Veuillez vérifier la structure de l'objet ci-dessus et adapter la ligne 'const metiers = ...'");
    return;
  }

  // 3. Importer dans Firestore (logique inchangée)
  const collectionRef = db.collection(collectionName);
  console.log(`Début de l'importation de ${metiers.length} métiers...`);

  let batch = db.batch();
  let count = 0;

  for (const metier of metiers) {
    const docRef = collectionRef.doc();
    batch.set(docRef, metier);

    count++;
    if (count % 499 === 0) {
      console.log(`Importation de ${count} documents...`);
      await batch.commit();
      batch = db.batch();
    }
  }

  if (count % 499 !== 0) {
    await batch.commit();
  }

  console.log(`Importation terminée ! ${count} métiers ont été ajoutés à la collection "${collectionName}".`);
}

importXmlData().catch(console.error);