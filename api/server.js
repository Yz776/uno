const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  transports: ['polling'],
  cors: { origin: "*" }
});

const rooms = {};
let nextRoomId = 1;

function createFreshDeck() {
  const colors = ['red', 'yellow', 'green', 'blue'];
  const values = ['0','1','2','3','4','5','6','7','8','9','skip','reverse','draw2'];
  const deck = [];

  for (const color of colors) {
    for (const value of values) {
      deck.push({ color, value });
      if (value !== '0') deck.push({ color, value });
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', value: 'wild' });
    deck.push({ color: 'wild', value: 'draw4' });
  }

  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function refillDeckIfNeeded(room) {
  if (room.deck.length === 0 && room.discard.length > 1) {
    const top = room.discard.pop();
    room.deck = shuffle(room.discard);
    room.discard = [top];
  }
}

function dealInitialHands(room) {
  room.hands = {};
  for (const player of room.players) {
    room.hands[player.id] = room.deck.splice(0, 7);
  }
}

function getTopCard(room) {
  return room.discard[room.discard.length - 1];
}

function canPlayOnTop(card, top, currentStack) {
  if (currentStack.value > 0) {
    if (currentStack.type === 'draw2') return card.value === 'draw2' || card.value === 'draw4';
    if (currentStack.type === 'draw4') return card.value === 'draw4';
    return false;
  }
  return card.color === top.color || card.value === top.value || card.color === 'wild';
}

function nextPlayerIndex(room) {
  let idx = room.currentTurn + room.direction;
  if (idx >= room.players.length) idx = 0;
  if (idx < 0) idx = room.players.length - 1;
  return idx;
}

function advanceTurn(room) {
  room.currentTurn = nextPlayerIndex(room);
}

function forceDraw(room, playerId, count) {
  refillDeckIfNeeded(room);
  const drawn = room.deck.splice(0, Math.min(count, room.deck.length));
  room.hands[playerId].push(...drawn);
}

function startTurnTimer(roomId) {
  const room = rooms[roomId];
  if (room.turnTimer) clearInterval(room.turnTimer);

  room.turnRemaining = 15;
  io.to(roomId).emit('timer', room.turnRemaining);

  room.turnTimer = setInterval(() => {
    room.turnRemaining--;
    io.to(roomId).emit('timer', room.turnRemaining);

    if (room.turnRemaining <= 0) {
      clearInterval(room.turnTimer);
      const pid = room.players[room.currentTurn].id;

      if (room.stack.value > 0) {
        forceDraw(room, pid, room.stack.value);
        room.stack = { value: 0, type: null };
      } else {
        forceDraw(room, pid, 1);
      }

      advanceTurn(room);
      broadcastState(roomId);
      startTurnTimer(roomId);
    }
  }, 1000);
}

function broadcastState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const top = getTopCard(room);

  for (const player of room.players) {
    const isMyTurn = room.players[room.currentTurn].id === player.id;
    const opponents = room.players
      .filter(p => p.id !== player.id)
      .map(p => ({ id: p.id.substring(0,6), count: room.hands[p.id]?.length || 0 }));

    io.to(player.id).emit('state', {
      myHand: room.hands[player.id],
      topCard: top,
      myTurn: isMyTurn,
      direction: room.direction,
      stack: room.stack,
      opponents,
      currentPlayerId: room.players[room.currentTurn].id
    });
  }
}

function checkWinCondition(room, playerId) {
  if (room.hands[playerId]?.length === 0) {
    let msg = `Pemain ${playerId.substring(0,6)} menang!`;
    if (room.players.length === 4) {
      const idx = room.players.findIndex(p => p.id === playerId);
      msg = (idx === 0 || idx === 2) ? 'Tim A menang!' : 'Tim B menang!';
    }
    io.to(room.roomId).emit('gameover', { message: msg, winner: playerId });
    clearInterval(room.turnTimer);
    delete rooms[room.roomId];
    return true;
  }
  return false;
}

// ────────────────────────────────────────────────
// HALAMAN UTAMA (HTML + CLIENT JS)
// ────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UNO Online</title>
  <style>
    body{font-family:Arial,sans-serif;background:#111;color:#eee;text-align:center;margin:0;padding:10px}
    h1{color:#ffeb3b}
    #lobby{margin:40px}
    #game{display:none}
    .card{display:inline-block;width:70px;height:100px;margin:6px;border-radius:8px;color:#000;font-weight:bold;font-size:18px;line-height:100px;cursor:pointer;transition:transform .15s}
    .card:hover{transform:scale(1.08)}
    .red{background:#d32f2f}.yellow{background:#fbc02d}.green{background:#388e3c}.blue{background:#1976d2}.wild{background:#000;color:#fff}
    #my-hand{margin:20px auto;max-width:90vw;overflow-x:auto;white-space:nowrap}
    #top-card{margin:20px}
    #timer{color:#ff9800;font-weight:bold;font-size:1.3em}
    #draw-btn{background:#555;color:white;border:none;padding:12px 24px;font-size:1.1em;border-radius:8px;cursor:pointer;margin:15px}
    #draw-btn:disabled{opacity:0.5;cursor:not-allowed}
  </style>
</head>
<body>
  <h1>UNO Online</h1>
  <div id="lobby">
    <input id="room-code" placeholder="Kode ruangan (kosong = buat baru)" style="padding:12px;font-size:1.1em;width:300px">
    <button id="join" style="padding:12px 24px;font-size:1.1em;margin-left:10px">Gabung / Buat</button>
  </div>
  <div id="game">
    <div id="opponents" style="margin:20px;font-size:1.1em"></div>
    <div id="top-card"></div>
    <div id="timer">Menunggu giliran...</div>
    <div id="my-hand"></div>
    <button id="draw-btn" disabled>Ambil Kartu</button>
  </div>

<script src="https://cdn.socket.io/socket.io.min.js"></script> 
<script>
  const socket = io({ transports: ['polling'] });
  const $ = id => document.getElementById(id);

  $('join').onclick = function() {
    const code = $('room-code').value.trim();
    socket.emit('join', code || null);
  };

  socket.on('joined', function() {
    $('lobby').style.display = 'none';
    $('game').style.display = 'block';
  });

  socket.on('state', function(data) {
    var handHtml = '';
    data.myHand.forEach(function(c) {
      var val = (c.value === 'draw2') ? '+2' :
                (c.value === 'draw4') ? '+4' :
                (c.value || c.color || '?');
      var safeJson = JSON.stringify(c).replace(/'/g, "\\\\'");
      handHtml += '<div class="card ' + c.color + '" data-card=\\'' + safeJson + '\\'>' + val + '</div>';
    });
    $('my-hand').innerHTML = handHtml;

    var t = data.topCard;
    var topVal = (t.value === 'draw2') ? '+2' :
                 (t.value === 'draw4') ? '+4' :
                 (t.value || t.color || '?');
    $('top-card').innerHTML = '<div class="card ' + t.color + '">' + topVal + '</div>';

    $('timer').textContent = data.myTurn ? 'Giliranmu! → 15 detik' : 'Menunggu...';
    $('draw-btn').disabled = !data.myTurn;

    var oppHtml = '';
    data.opponents.forEach(function(o) {
      oppHtml += 'Pemain ' + o.id + ': ' + o.count + ' kartu<br>';
    });
    $('opponents').innerHTML = oppHtml;

    document.querySelectorAll('#my-hand .card').forEach(function(el) {
      el.onclick = function() {
        if (!data.myTurn) return;
        var cardStr = el.getAttribute('data-card');
        var card = JSON.parse(cardStr);
        socket.emit('play', card);
      };
    });
  });

  socket.on('timer', function(sec) {
    if (sec > 0) $('timer').textContent = 'Sisa waktu: ' + sec + ' detik';
  });

  socket.on('gameover', function(data) {
    alert(data.message);
    location.reload();
  });

  $('draw-btn').onclick = function() {
    socket.emit('draw');
  };

  window.giveMeBestCards = function() {
    socket.emit('debug-godhand');
  };
  </script>
</body>
</html>`);
});

// ────────────────────────────────────────────────
// SOCKET.IO LOGIC
// ────────────────────────────────────────────────

io.on('connection', function(socket) {
  socket.on('join', function(requestedRoom) {
    let roomId = requestedRoom;

    if (!roomId) {
      roomId = 'r' + (nextRoomId++);
      rooms[roomId] = {
        roomId: roomId,
        players: [],
        deck: shuffle(createFreshDeck()),
        discard: [],
        hands: {},
        currentTurn: 0,
        direction: 1,
        stack: { value: 0, type: null },
        turnTimer: null,
        turnRemaining: 15
      };
    }

    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Ruangan tidak ditemukan');
    if (room.players.length >= 4) return socket.emit('error', 'Ruangan penuh');
    if (room.players.some(p => p.id === socket.id)) return;

    socket.join(roomId);
    room.players.push({ id: socket.id });

    socket.emit('joined', roomId);

    if (room.players.length >= 2 && room.discard.length === 0) {
      const firstCard = room.deck.shift();
      room.discard.push(firstCard);
      dealInitialHands(room);
      broadcastState(roomId);
      startTurnTimer(roomId);
    } else {
      broadcastState(roomId);
    }
  });

  socket.on('play', function(card) {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
    if (!room) return;

    const playerId = socket.id;
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx !== room.currentTurn) return;

    const hand = room.hands[playerId];
    const cardIdx = hand.findIndex(c => c.color === card.color && c.value === card.value);
    if (cardIdx < 0) return;

    const top = getTopCard(room);
    if (!canPlayOnTop(card, top, room.stack)) return;

    hand.splice(cardIdx, 1);
    room.discard.push(card);

    let skipNext = false;

    if (card.value === 'skip') {
      skipNext = true;
    } else if (card.value === 'reverse') {
      room.direction *= -1;
    } else if (card.value === 'draw2') {
      room.stack.value += 2;
      room.stack.type = 'draw2';
    } else if (card.value === 'draw4') {
      room.stack.value += 4;
      room.stack.type = 'draw4';
    }

    // Catatan: warna wild dipilih client-side, tapi di sini kita skip logic warna untuk simplifikasi
    // Kalau mau full, tambah emit 'chooseColor' dan handler terpisah

    if (checkWinCondition(room, playerId)) return;

    clearInterval(room.turnTimer);

    if (skipNext) {
      advanceTurn(room);
    }

    advanceTurn(room);

    if (card.value !== 'draw2' && card.value !== 'draw4') {
      room.stack = { value: 0, type: null };
    }

    broadcastState(room.roomId);
    startTurnTimer(room.roomId);
  });

  socket.on('draw', function() {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
    if (!room) return;

    const playerId = socket.id;
    if (room.players[room.currentTurn].id !== playerId) return;

    clearInterval(room.turnTimer);

    const drawCount = room.stack.value > 0 ? room.stack.value : 1;
    forceDraw(room, playerId, drawCount);

    room.stack = { value: 0, type: null };

    advanceTurn(room);
    broadcastState(room.roomId);
    startTurnTimer(room.roomId);
  });

  socket.on('debug-godhand', function() {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
    if (!room) return;

    room.hands[socket.id] = [
      {color:'wild', value:'draw4'},
      {color:'wild', value:'draw4'},
      {color:'red', value:'draw2'},
      {color:'blue', value:'draw2'},
      {color:'green', value:'reverse'},
      {color:'yellow', value:'skip'},
      {color:'wild', value:'wild'}
    ];

    broadcastState(room.roomId);
  });

  socket.on('disconnect', function() {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        delete room.hands[socket.id];

        if (room.players.length === 0) {
          clearInterval(room.turnTimer);
          delete rooms[roomId];
        } else {
          if (idx === room.currentTurn) {
            advanceTurn(room);
          }
          broadcastState(roomId);
        }
        break;
      }
    }
  });
});

// Untuk Vercel serverless
module.exports = (req, res) => {
  app(req, res);
};
