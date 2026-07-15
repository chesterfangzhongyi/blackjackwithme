// server.js
// WebSocket game server for the friends-blackjack app.
// Rooms are held in memory only — fine for a casual session, wiped on server restart.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createDeck, shuffle, deal, scoreHand, isBlackjack, isBust } = require("./deck");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Serve the frontend (public/index.html, manifest.json, icons) from the same
// origin as the WebSocket server — one Railway deploy, no separate hosting needed.
app.use(express.static("public"));

app.get("/health", (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

const MIN_BET = 1;
const MAX_BET = 5;

// In-memory room store: { [code]: room }
const rooms = {};

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function newRoom(code, creatorId, creatorName, roundsPerBanker) {
  return {
    code,
    roundsPerBanker,
    roundCount: 0,
    turnOrder: [creatorId],       // join order, creator first
    bankerIndex: 0,               // index into turnOrder
    players: {
      [creatorId]: { id: creatorId, name: creatorName, balance: 0 },
    },
    deck: [],
    bets: {},                     // { playerId: amount }, excludes current banker
    hands: {},                    // { playerId: [...cards] }, includes "banker" key
    standing: {},                 // { playerId: true } once a player has stood/busted/blackjack
    currentTurn: null,
    phase: "lobby",               // lobby | betting | dealing | player_turns | banker_turn | payout
  };
}

function getBankerId(room) {
  return room.turnOrder[room.bankerIndex];
}

function nonBankerIds(room) {
  const bankerId = getBankerId(room);
  return room.turnOrder.filter((id) => id !== bankerId);
}

function broadcastState(room) {
  io.to(room.code).emit("room_state", room);
}

function ensureShoe(room, cardsNeeded) {
  // Simple reshuffle-when-low strategy. Good enough for a friends game / single deck.
  if (room.deck.length < cardsNeeded) {
    room.deck = shuffle(createDeck());
  }
}

function startDealing(room) {
  room.phase = "dealing";
  room.hands = { banker: [] };
  room.standing = {};

  const bankerId = getBankerId(room);
  const players = nonBankerIds(room);

  ensureShoe(room, (players.length + 1) * 2);

  for (const pid of players) room.hands[pid] = [];

  // Deal 2 cards round-robin (player-realistic order), then banker.
  for (let round = 0; round < 2; round++) {
    for (const pid of players) {
      room.hands[pid].push(...deal(room.deck, 1));
    }
    room.hands.banker.push(...deal(room.deck, 1));
  }

  const bankerBJ = isBlackjack(room.hands.banker);

  // Auto-stand anyone dealt a natural blackjack — no hit/stand choice for them.
  for (const pid of players) {
    if (isBlackjack(room.hands[pid])) room.standing[pid] = true;
  }

  if (bankerBJ) {
    // Skip straight to payout — no point playing out hands vs a banker natural.
    for (const pid of players) room.standing[pid] = true;
    resolvePayout(room);
    return;
  }

  room.phase = "player_turns";
  const firstToAct = players.find((pid) => !room.standing[pid]);
  room.currentTurn = firstToAct || null;
  if (!room.currentTurn) {
    runBankerTurn(room);
  }
}

function advanceTurn(room) {
  const players = nonBankerIds(room);
  const idx = players.indexOf(room.currentTurn);
  const next = players.slice(idx + 1).find((pid) => !room.standing[pid]);
  if (next) {
    room.currentTurn = next;
  } else {
    room.currentTurn = null;
    runBankerTurn(room);
  }
}

function runBankerTurn(room) {
  room.phase = "banker_turn";
  // Stand on all 17s, no exceptions (hard or soft).
  while (scoreHand(room.hands.banker).total < 17) {
    room.hands.banker.push(...deal(room.deck, 1));
  }
  resolvePayout(room);
}

function resolvePayout(room) {
  room.phase = "payout";
  const bankerId = getBankerId(room);
  const bankerHand = room.hands.banker;
  const bankerBJ = isBlackjack(bankerHand);
  const bankerBust = isBust(bankerHand);
  const bankerScore = scoreHand(bankerHand).total;

  const results = {};

  for (const pid of nonBankerIds(room)) {
    const hand = room.hands[pid];
    const bet = room.bets[pid] || 0;
    const playerBJ = isBlackjack(hand);
    const playerBust = isBust(hand);
    let delta = 0; // change to player's balance; banker gets the negative sum

    if (playerBJ && bankerBJ) {
      delta = 0; // push
    } else if (playerBJ && !bankerBJ) {
      delta = bet * 1.5; // 3:2
    } else if (bankerBJ && !playerBJ) {
      delta = -bet;
    } else if (playerBust) {
      delta = -bet;
    } else if (bankerBust) {
      delta = bet;
    } else {
      const playerScore = scoreHand(hand).total;
      if (playerScore > bankerScore) delta = bet;
      else if (playerScore < bankerScore) delta = -bet;
      else delta = 0; // push
    }

    room.players[pid].balance += delta;
    room.players[bankerId].balance -= delta;
    results[pid] = delta;
  }

  room.roundCount += 1;
  if (room.roundCount % room.roundsPerBanker === 0) {
    room.bankerIndex = (room.bankerIndex + 1) % room.turnOrder.length;
  }

  room.lastResults = results; // for UI to show a "round summary" toast
  room.bets = {};
  room.currentTurn = null;
  room.phase = "betting";
}

io.on("connection", (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on("create_room", ({ name, roundsPerBanker }, cb) => {
    const code = makeRoomCode();
    const room = newRoom(code, socket.id, name, roundsPerBanker || 10);
    rooms[code] = room;
    socket.join(code);
    console.log(`[create_room] code=${code} by=${name} (${socket.id})`);
    cb({ ok: true, code });
    broadcastState(room);
  });

  socket.on("join_room", ({ code, name }, cb) => {
    console.log(`[join_room] attempt code=${code} by=${name} (${socket.id}), known rooms=${Object.keys(rooms).join(",")}`);
    const room = rooms[code];
    if (!room) {
      console.log(`[join_room] FAILED — room ${code} not found`);
      return cb({ ok: false, error: "Room not found" });
    }
    if (room.players[socket.id]) return cb({ ok: true }); // already in

    room.players[socket.id] = { id: socket.id, name, balance: 0 };
    room.turnOrder.push(socket.id);
    socket.join(code);
    console.log(`[join_room] OK — ${name} joined ${code}, players now: ${room.turnOrder.length}`);
    cb({ ok: true, code });
    broadcastState(room);
  });

  socket.on("place_bet", ({ code, amount }, cb) => {
    const room = rooms[code];
    if (!room || room.phase !== "betting") return cb({ ok: false, error: "Not accepting bets right now" });
    if (socket.id === getBankerId(room)) return cb({ ok: false, error: "Banker doesn't bet" });
    if (amount < MIN_BET || amount > MAX_BET) {
      return cb({ ok: false, error: `Bet must be between $${MIN_BET} and $${MAX_BET}` });
    }

    room.bets[socket.id] = amount;
    cb({ ok: true });

    const players = nonBankerIds(room);
    const allBetsIn = players.every((pid) => room.bets[pid] !== undefined);
    if (allBetsIn) startDealing(room);
    broadcastState(room);
  });

  socket.on("hit", ({ code }, cb) => {
    const room = rooms[code];
    if (!room || room.phase !== "player_turns" || room.currentTurn !== socket.id) {
      return cb({ ok: false, error: "Not your turn" });
    }
    room.hands[socket.id].push(...deal(room.deck, 1));
    if (isBust(room.hands[socket.id])) {
      room.standing[socket.id] = true;
      advanceTurn(room);
    }
    cb({ ok: true });
    broadcastState(room);
  });

  socket.on("stand", ({ code }, cb) => {
    const room = rooms[code];
    if (!room || room.phase !== "player_turns" || room.currentTurn !== socket.id) {
      return cb({ ok: false, error: "Not your turn" });
    }
    room.standing[socket.id] = true;
    advanceTurn(room);
    cb({ ok: true });
    broadcastState(room);
  });

  socket.on("disconnect", () => {
    // v1: leave room state as-is (balances preserved) — just note the player is offline.
    // A reconnect-by-socket-id scheme would need a persistent player token instead of
    // relying on socket.id; worth revisiting once this is past MVP.
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Blackjack server listening on :${PORT}`));
