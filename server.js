const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.get('/', (req, res) => res.send('Tetris Duel server OK'));

const rooms = {};

function broadcastRooms() {
  const list = Object.values(rooms)
    .filter(r => !r.isPrivate && r.players.length === 1)
    .map(r => ({ id: r.id, creator: r.players[0].pseudo }));
  io.emit('tetris_rooms', list);
}

io.on('connection', (socket) => {

  socket.on('tetris_get_rooms', () => {
    const list = Object.values(rooms)
      .filter(r => !r.isPrivate && r.players.length === 1)
      .map(r => ({ id: r.id, creator: r.players[0].pseudo }));
    socket.emit('tetris_rooms', list);
  });

  socket.on('tetris_create', ({ pseudo, isPrivate }) => {
    const id   = Math.random().toString(36).substring(2, 10);
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[id]  = { id, code, isPrivate: !!isPrivate, players: [{ id: socket.id, pseudo }] };
    socket.join(id);
    socket.emit('tetris_created', { id, code, isPrivate: !!isPrivate });
    broadcastRooms();
  });

  socket.on('tetris_join', ({ pseudo, id }) => {
    const room = rooms[id];
    if (!room) { socket.emit('tetris_error', 'Salle introuvable'); return; }
    if (room.players.length >= 2) { socket.emit('tetris_error', 'Salle pleine'); return; }
    room.players.push({ id: socket.id, pseudo });
    socket.join(id);
    io.to(room.players[0].id).emit('tetris_start', { opponent: pseudo });
    socket.emit('tetris_start', { opponent: room.players[0].pseudo });
    broadcastRooms();
  });

  socket.on('tetris_join_private', ({ pseudo, code }) => {
    const room = Object.values(rooms).find(r => r.code === code && r.players.length === 1);
    if (!room) { socket.emit('tetris_error', 'Code invalide ou salle pleine'); return; }
    room.players.push({ id: socket.id, pseudo });
    socket.join(room.id);
    io.to(room.players[0].id).emit('tetris_start', { opponent: pseudo });
    socket.emit('tetris_start', { opponent: room.players[0].pseudo });
    broadcastRooms();
  });

  socket.on('tetris_board', ({ id, board, cur, score, level, lines }) => {
    socket.to(id).emit('tetris_board', { board, cur, score, level, lines });
  });

  socket.on('tetris_garbage', ({ id, lines }) => {
    socket.to(id).emit('tetris_garbage', { lines });
  });

  socket.on('tetris_gameover', ({ id, score }) => {
    socket.to(id).emit('tetris_win', { score });
    delete rooms[id];
    broadcastRooms();
  });

  socket.on('disconnect', () => {
    for (const [id, room] of Object.entries(rooms)) {
      if (room.players.some(p => p.id === socket.id)) {
        socket.to(id).emit('tetris_abandon');
        delete rooms[id];
        broadcastRooms();
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3003;
server.listen(PORT, () => console.log(`Tetris Duel server on port ${PORT}`));
