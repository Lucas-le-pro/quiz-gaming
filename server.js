const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());

app.get('/', (req, res) => res.send('LamaaGames server OK'));

// Stockage en mémoire
const amis = {};       // amis[pseudo] = [liste d'amis]
const invitations = {}; // invitations[pseudo] = [liste d'inviteurs en attente]
const messages = {};   // messages[clé] = [liste de messages]

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
