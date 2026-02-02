const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const app = express();

// Utile derrière un proxy (Render / HTTPS)
app.set("trust proxy", 1);

app.use(express.json());

// Server + Socket.IO
const server = http.createServer(app);
const io = new Server(server);

// Static files
app.use(express.static("public"));
app.get("/", (req, res) => {
  res.redirect("/dj.html");
});


// ---------------- CSV ----------------
function loadTracksFromCsv() {
  const filePath = path.join(__dirname, "tracks.csv");
  if (!fs.existsSync(filePath)) {
    throw new Error("tracks.csv introuvable à la racine du projet.");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) throw new Error("tracks.csv est vide.");

  const header = lines[0].split(",").map((h) => h.trim());
  const idx = {
    title: header.indexOf("title"),
    artist: header.indexOf("artist"),
  };

  if (idx.title === -1 || idx.artist === -1) {
    throw new Error("Header CSV invalide. Il faut au moins: title,artist,...");
  }

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const title = cols[idx.title] || "";
    const artist = cols[idx.artist] || "";
    if (!title || !artist) continue;

    out.push({ id: "t" + i, title, artist });
  }

  if (out.length < 4) {
    throw new Error("Il faut au moins 4 titres valides dans tracks.csv.");
  }

  return out;
}

const tracks = loadTracksFromCsv();
console.log("✅ Titres chargés depuis CSV :", tracks.length);

// ---------------- Rooms ----------------
const rooms = new Map();
/**
room = {
  roomCode,
  voteOpen: false,
  suggestions: [track],
  votes: {trackId: number},
  voters: Set(voterId),
  roundId: string,
  lastWinner: track|null,
  history: [trackId...]
}
*/

function pick4(room) {
  // Évite les 5 derniers gagnants (simple et efficace)
  const banned = new Set((room?.history || []).slice(-5));
  const pool = tracks.filter((t) => !banned.has(t.id));
  const base = pool.length >= 4 ? pool : tracks;
  return [...base].sort(() => Math.random() - 0.5).slice(0, 4);
}

function getRoom(roomCode) {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      roomCode,
      voteOpen: false,
      suggestions: [],
      votes: {},
      voters: new Set(),
      roundId: nanoid(6),
      lastWinner: null,
      history: [],
    });
  }
  return rooms.get(roomCode);
}

function publicState(room) {
  return {
    roomCode: room.roomCode,
    voteOpen: room.voteOpen,
    roundId: room.roundId,
    suggestions: room.suggestions,
    votes: room.votes,
    lastWinner: room.lastWinner,
  };
}

// URL de base (utile en prod + pour corriger localhost)
function getBaseUrl(req) {
  // Si tu déploies et/ou mets un domaine: BASE_URL="https://tondomaine.com"
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

// ---------------- API DJ ----------------

// Créer une room
app.post("/api/room/create", (req, res) => {
  const roomCode = nanoid(6).toUpperCase();
  getRoom(roomCode);
  res.json({ roomCode });
});

// Ouvrir un vote: génère 4 choix + reset votes
app.post("/api/room/:code/open-vote", (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = getRoom(roomCode);

  room.suggestions = pick4(room);
  room.votes = {};
  room.voters = new Set();
  room.roundId = nanoid(6);
  room.voteOpen = true;

  io.to(roomCode).emit("round_update", publicState(room));
  res.json({ ok: true });
});

// Fermer + valider: calc gagnant, ferme vote, garde lastWinner
app.post("/api/room/:code/close-vote", (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = getRoom(roomCode);

  room.voteOpen = false;

  // Déterminer le gagnant (max votes, sinon premier)
  let winner = room.suggestions[0] || null;
  let best = -1;

  for (const t of room.suggestions) {
    const c = room.votes[t.id] || 0;
    if (c > best) {
      best = c;
      winner = t;
    }
  }

  if (winner) {
    room.lastWinner = winner;
    room.history.push(winner.id);
  }

  io.to(roomCode).emit("validated", { winner: room.lastWinner || null });
  io.to(roomCode).emit("round_update", publicState(room));

  res.json({ winner: room.lastWinner || null });
});

// Mettre "aucun vote en cours" (sans effacer le dernier gagnant)
app.post("/api/room/:code/reset", (req, res) => {
  const roomCode = req.params.code.toUpperCase();
  const room = getRoom(roomCode);

  room.voteOpen = false;
  room.suggestions = [];
  room.votes = {};
  room.voters = new Set();
  room.roundId = nanoid(6);

  io.to(roomCode).emit("round_update", publicState(room));
  res.json({ ok: true });
});

// QR code PNG: vote.html?room=CODE
app.get("/api/room/:code/qr", async (req, res) => {
  try {
    const roomCode = req.params.code.toUpperCase();
    getRoom(roomCode);

    const baseUrl = getBaseUrl(req);
    const voteUrl = `${baseUrl}/vote.html?room=${roomCode}`;

    res.setHeader("Content-Type", "image/png");
    const pngBuffer = await QRCode.toBuffer(voteUrl, { width: 280, margin: 1 });
    res.send(pngBuffer);
  } catch (e) {
    console.error("QR error:", e);
    res.status(500).send("QR error");
  }
});

// ---------------- Socket.IO ----------------
io.on("connection", (socket) => {
  socket.on("join", ({ roomCode }) => {
    roomCode = String(roomCode || "").toUpperCase();
    const room = getRoom(roomCode);
    socket.join(roomCode);
    socket.emit("round_update", publicState(room));
  });

  socket.on("vote", ({ roomCode, roundId, trackId, voterId }) => {
    roomCode = String(roomCode || "").toUpperCase();
    const room = getRoom(roomCode);

    if (!room.voteOpen) return;
    if (room.roundId !== roundId) return;
    if (!voterId) return;
    if (room.voters.has(voterId)) return;

    room.voters.add(voterId);
    room.votes[trackId] = (room.votes[trackId] || 0) + 1;

    io.to(roomCode).emit("round_update", publicState(room));
  });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;

// En prod (Render), 0.0.0.0 est important
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Serveur lancé sur le port ${PORT}`);
});

