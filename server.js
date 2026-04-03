const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('LamaaGames server OK'));

// Stockage en mémoire
const amis = {};
const invitations = {};
const messages = {};
const jeuxEnAttente = [];
const stats = {};         // stats[pseudo][jeu] = { tempsJoue, ...statsJeu }

function cleAmis(a, b) {
  return [a, b].sort().join('_');
}

// Récupérer les amis d'un pseudo
app.get('/amis/:pseudo', (req, res) => {
  const pseudo = req.params.pseudo;
  res.json(amis[pseudo] || []);
});

// Récupérer les invitations en attente
app.get('/invitations/:pseudo', (req, res) => {
  const pseudo = req.params.pseudo;
  res.json(invitations[pseudo] || []);
});

// Envoyer une invitation
app.post('/inviter', (req, res) => {
  const { de, a } = req.body;
  if (!de || !a) return res.status(400).json({ error: 'Manque de, a' });
  if (!invitations[a]) invitations[a] = [];
  if (!invitations[a].includes(de)) invitations[a].push(de);

  // Notifier en temps réel si connecté
  io.to(a).emit('invitation', { de });
  res.json({ ok: true });
});

// Accepter une invitation
app.post('/accepter', (req, res) => {
  const { pseudo, ami } = req.body;
  if (!pseudo || !ami) return res.status(400).json({ error: 'Manque pseudo, ami' });

  if (!amis[pseudo]) amis[pseudo] = [];
  if (!amis[ami]) amis[ami] = [];

  if (!amis[pseudo].includes(ami)) amis[pseudo].push(ami);
  if (!amis[ami].includes(pseudo)) amis[ami].push(pseudo);

  // Retirer l'invitation
  if (invitations[pseudo]) invitations[pseudo] = invitations[pseudo].filter(i => i !== ami);

  // Notifier les deux
  io.to(pseudo).emit('ami-accepte', { ami });
  io.to(ami).emit('ami-accepte', { ami: pseudo });

  res.json({ ok: true });
});

// Refuser une invitation
app.post('/refuser', (req, res) => {
  const { pseudo, ami } = req.body;
  if (invitations[pseudo]) invitations[pseudo] = invitations[pseudo].filter(i => i !== ami);
  res.json({ ok: true });
});

// Récupérer les messages entre deux amis
app.get('/messages/:a/:b', (req, res) => {
  const cle = cleAmis(req.params.a, req.params.b);
  res.json(messages[cle] || []);
});

// Récupérer tous les jeux en attente
app.get('/jeux', (req, res) => {
  res.json(jeuxEnAttente);
});

// Proposer un jeu
app.post('/jeux', (req, res) => {
  const { nom, description, proposePar } = req.body;
  if (!nom || !proposePar) return res.status(400).json({ error: 'Manque nom ou proposePar' });
  const jeu = { id: Date.now().toString(), nom, description: description || '', proposePar, url: null, date: Date.now() };
  jeuxEnAttente.unshift(jeu);
  io.emit('nouveau-jeu', jeu);
  res.json({ ok: true });
});

// Mettre en ligne un jeu (via URL)
app.post('/jeux/url', (req, res) => {
  const { id, pseudo, url } = req.body;
  const jeu = jeuxEnAttente.find(j => j.id === id && j.proposePar === pseudo);
  if (!jeu) return res.status(403).json({ error: 'Non autorisé' });
  jeu.url = url;
  io.emit('jeu-mis-en-ligne', jeu);
  res.json({ ok: true });
});

// Mettre en ligne un jeu (via upload de fichier → Supabase Storage)
app.post('/jeux/upload', async (req, res) => {
  const { id, pseudo, contenu, nomFichier } = req.body;
  const jeu = jeuxEnAttente.find(j => j.id === id && j.proposePar === pseudo);
  if (!jeu) return res.status(403).json({ error: 'Non autorisé' });

  const chemin = `${id}/${nomFichier}`;
  const buffer = Buffer.from(contenu, 'utf-8');

  const { error } = await supabase.storage
    .from('jeux storage')
    .upload(chemin, buffer, { contentType: 'text/html', upsert: true });

  if (error) return res.status(500).json({ error: error.message });

  const { data } = supabase.storage.from('jeux storage').getPublicUrl(chemin);
  jeu.url = data.publicUrl;
  io.emit('jeu-mis-en-ligne', jeu);
  res.json({ ok: true });
});

// Récupérer les stats d'un joueur
app.get('/stats/:pseudo', (req, res) => {
  const s = stats[req.params.pseudo] || {};
  // Trier par temps joué décroissant
  const trie = Object.entries(s)
    .sort((a, b) => (b[1].tempsJoue || 0) - (a[1].tempsJoue || 0))
    .map(([jeu, data]) => ({ jeu, ...data }));
  res.json(trie);
});

// Enregistrer des stats (appelé par un jeu)
app.post('/stats', (req, res) => {
  const { pseudo, jeu, tempsJoue, ...autresStats } = req.body;
  if (!pseudo || !jeu) return res.status(400).json({ error: 'Manque pseudo ou jeu' });
  if (!stats[pseudo]) stats[pseudo] = {};
  if (!stats[pseudo][jeu]) stats[pseudo][jeu] = { tempsJoue: 0 };
  stats[pseudo][jeu].tempsJoue = (stats[pseudo][jeu].tempsJoue || 0) + (tempsJoue || 0);
  Object.assign(stats[pseudo][jeu], autresStats);
  res.json({ ok: true });
});

// Socket.io — connexion
io.on('connection', (socket) => {
  let monPseudo = null;

  socket.on('rejoindre', (pseudo) => {
    monPseudo = pseudo;
    socket.join(pseudo);
  });

  socket.on('message', ({ de, a, texte }) => {
    const cle = cleAmis(de, a);
    if (!messages[cle]) messages[cle] = [];
    const msg = { de, texte, date: Date.now() };
    messages[cle].push(msg);
    io.to(de).emit('nouveau-message', { avec: a, msg });
    io.to(a).emit('nouveau-message', { avec: de, msg });
  });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => console.log(`LamaaGames server on port ${PORT}`));
