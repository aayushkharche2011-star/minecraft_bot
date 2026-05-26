const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals: { GoalFollow } } = require("mineflayer-pathfinder");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const dns = require("dns").promises;

// ============================================================
// CONFIG — change everything here, nowhere else in the file
// ============================================================
const config = {
  host: "PixelKingdom.aternos.me",
  port: 16442,
  username: "bittubot",
  version: "1.20.1",
  rejoinDelay: 10000,        // base ms before first reconnect
  maxRetryDelay: 5 * 60 * 1000, // cap backoff at 5 minutes
  connectTimeout: 30000,     // ms to wait for initial TCP connection
  antiAfkInterval: 30000,    // ms between anti-AFK actions
  joinMessage: "Hello!",     // message sent on spawn
  authmePassword: "bitu11",  // AuthMe /login password — set to null to disable
};
// ============================================================

// ---- State -------------------------------------------------

let botState = {
  status: "disconnected", // 'connected' | 'disconnected' | 'reconnecting'
  server: `${config.host}:${config.port}`,
  username: config.username,
  version: config.version,
  health: null,
  food: null,
  position: null,
  uptime: null,
  connectedAt: null,
};

const LOG_BUFFER_SIZE = 500;
const logBuffer = [];
const wsClients = new Set();

// ---- Helpers -----------------------------------------------

function timestamp() {
  return new Date().toISOString();
}

function log(label, ...args) {
  const message = args.join(" ");
  const entry = { ts: timestamp(), label, message };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();

  console.log(`[${entry.ts}] [${label}]`, message);

  const payload = JSON.stringify({ type: "log", ...entry });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function broadcastState() {
  const payload = JSON.stringify({ type: "state", state: botState });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function setState(updates) {
  Object.assign(botState, updates);
  broadcastState();
}

// ---- HTTP + WebSocket server --------------------------------

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/bot-api/status", (req, res) => {
  res.json(botState);
});

app.get("/bot-api/logs", (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  res.json(logBuffer.slice(-limit));
});

app.post("/bot-api/command", (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }
  if (!bot || botState.status !== "connected") {
    return res.status(503).json({ error: "Bot is not connected" });
  }
  try {
    bot.chat(message);
    log("CONSOLE", `Command sent: ${message}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/bot-api/ws" });

wss.on("connection", (ws) => {
  wsClients.add(ws);
  log("WS", "Console connected");

  ws.send(JSON.stringify({ type: "state", state: botState }));
  ws.send(JSON.stringify({ type: "history", logs: logBuffer.slice(-200) }));

  ws.on("close", () => {
    wsClients.delete(ws);
    log("WS", "Console disconnected");
  });

  ws.on("error", (err) => {
    wsClients.delete(ws);
    log("WS ERROR", err.message);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  log("HTTP", `Server listening on port ${PORT}`);
});

server.on("error", (err) => {
  log("HTTP ERROR", err.message);
});

// ---- Self-ping (keeps Render free tier alive) ---------------

const RENDER_URL = process.env.RENDER_EXTERNAL_URL || null;

if (RENDER_URL) {
  setInterval(() => {
    http.get(RENDER_URL, (res) => {
      log("PING", `Self-ping status: ${res.statusCode}`);
    }).on("error", (err) => {
      log("PING ERROR", err.message);
    });
  }, 10 * 60 * 1000);
  log("PING", `Self-ping enabled → ${RENDER_URL} (every 10 min)`);
}

// ---- DNS resolution ----------------------------------------

async function resolveHost(hostname) {
  try {
    const addresses = await dns.resolve4(hostname);
    if (addresses && addresses.length > 0) {
      log("DNS", `Resolved ${hostname} → ${addresses[0]}`);
      return addresses[0];
    }
  } catch (err) {
    log("DNS", `Could not resolve ${hostname} (${err.message}) — using hostname directly`);
  }
  return hostname;
}

// ---- Bot factory -------------------------------------------

let bot = null;
let antiAfkTimer = null;
let retryCount = 0;

async function createBot() {
  log(
    "BOT",
    `Connecting to ${config.host}:${config.port} as ${config.username} (MC ${config.version})`,
  );
  setState({
    status: "reconnecting",
    connectedAt: null,
    health: null,
    food: null,
    position: null,
  });

  // Pre-resolve hostname so Render's DNS can cache it
  const resolvedHost = await resolveHost(config.host);

  // Connection timeout: if the bot doesn't fire 'login' within connectTimeout
  // ms, tear it down and retry via scheduleRejoin
  let connectTimeoutHandle = setTimeout(() => {
    log("ERROR", `Connection timed out after ${config.connectTimeout / 1000}s`);
    if (bot) {
      try { bot.end("connect timeout"); } catch (_) {}
    }
  }, config.connectTimeout);

  bot = mineflayer.createBot({
    host: resolvedHost,
    port: config.port,
    username: config.username,
    version: config.version,
    hideErrors: false,
  });

  bot.loadPlugin(pathfinder);

  // Clear the connect timeout as soon as the TCP handshake succeeds
  bot.once("login", () => {
    clearTimeout(connectTimeoutHandle);
    connectTimeoutHandle = null;
  });

  // --- Spawn ------------------------------------------------
  bot.once("spawn", () => {
    clearTimeout(connectTimeoutHandle);
    connectTimeoutHandle = null;

    retryCount = 0; // reset backoff on successful connection
    log("SPAWN", "Bot spawned successfully");
    setState({
      status: "connected",
      connectedAt: new Date().toISOString(),
      health: bot.health,
      food: bot.food,
    });

    if (config.authmePassword) {
      setTimeout(() => {
        bot.chat(`/login ${config.authmePassword}`);
        log("AUTHME", "Login command sent");

        if (config.joinMessage) {
          setTimeout(() => {
            bot.chat(config.joinMessage);
            log("CHAT", `Sent join message: "${config.joinMessage}"`);
          }, 1000);
        }
      }, 2000);
    } else if (config.joinMessage) {
      bot.chat(config.joinMessage);
      log("CHAT", `Sent join message: "${config.joinMessage}"`);
    }

    startAntiAfk();
  });

  // --- Anti-AFK ---------------------------------------------
  function startAntiAfk() {
    stopAntiAfk();

    antiAfkTimer = setInterval(() => {
      if (!bot || !bot.entity) return;

      const action = Math.floor(Math.random() * 3);

      try {
        if (action === 0) {
          const directions = ["forward", "back", "left", "right"];
          const dir = directions[Math.floor(Math.random() * directions.length)];
          bot.setControlState(dir, true);
          setTimeout(
            () => {
              if (bot) bot.setControlState(dir, false);
            },
            1000 + Math.random() * 1000,
          );
          log("ANTI-AFK", `Walking ${dir}`);
        } else if (action === 1) {
          bot.setControlState("jump", true);
          setTimeout(() => {
            if (bot) bot.setControlState("jump", false);
          }, 300);
          log("ANTI-AFK", "Jumping");
        } else {
          const yaw = (Math.random() * 2 - 1) * Math.PI;
          const pitch = (Math.random() - 0.5) * Math.PI;
          bot.look(yaw, pitch, false);
          log(
            "ANTI-AFK",
            `Looking at yaw=${yaw.toFixed(2)} pitch=${pitch.toFixed(2)}`,
          );
        }
      } catch (err) {
        log("ANTI-AFK ERROR", err.message);
      }
    }, config.antiAfkInterval);

    log(
      "ANTI-AFK",
      `Scheduler started (every ${config.antiAfkInterval / 1000}s)`,
    );
  }

  function stopAntiAfk() {
    if (antiAfkTimer) {
      clearInterval(antiAfkTimer);
      antiAfkTimer = null;
    }
  }

  // --- Kick -------------------------------------------------
  bot.on("kicked", (reason) => {
    let readable = reason;
    try {
      const parsed = JSON.parse(reason);
      readable = parsed.text || parsed.translate || reason;
    } catch (_) {}
    log("KICKED", readable);
    setState({
      status: "disconnected",
      health: null,
      food: null,
      position: null,
      connectedAt: null,
    });
    stopAntiAfk();
    scheduleRejoin();
  });

  // --- Disconnect -------------------------------------------
  bot.on("end", (reason) => {
    clearTimeout(connectTimeoutHandle);
    connectTimeoutHandle = null;
    log("DISCONNECT", reason || "(no reason given)");
    setState({
      status: "disconnected",
      health: null,
      food: null,
      position: null,
      connectedAt: null,
    });
    stopAntiAfk();
    scheduleRejoin();
  });

  // --- Errors -----------------------------------------------
  bot.on("error", (err) => {
    if (err.code === "ETIMEDOUT") {
      log("ERROR", `Connection timed out (ETIMEDOUT) — server may be offline or unreachable`);
    } else if (err.code === "ECONNREFUSED") {
      log("ERROR", `Connection refused (ECONNREFUSED) — server is not accepting connections`);
    } else if (err.code === "ENOTFOUND") {
      log("ERROR", `Hostname not found (ENOTFOUND) — DNS failed for ${config.host}`);
    } else {
      log("ERROR", err.message);
    }
  });

  // --- Chat -------------------------------------------------
  bot.on("message", (message) => {
    log("CHAT", message.toString());
  });

  // --- Follow / Unfollow ------------------------------------
  bot.on("chat", (username, message) => {
    if (message.startsWith("follow")) {
      const targetName = message.split(" ")[1] || username;
      const playerEntity = bot.players[targetName]?.entity;
      if (!playerEntity) {
        bot.chat("Player not found!");
        log("FOLLOW", `Player not found: ${targetName}`);
        return;
      }
      const movements = new Movements(bot);
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new GoalFollow(playerEntity, 2), true);
      bot.chat(`Following ${targetName}!`);
      log("FOLLOW", `Now following ${targetName}`);
      stopAntiAfk();
    }

    if (message === "unfollow") {
      bot.pathfinder.setGoal(null);
      bot.chat("Stopped following!");
      log("FOLLOW", "Stopped following");
      startAntiAfk();
    }
  });

  // --- Health / death ---------------------------------------
  bot.on("death", () => {
    log("BOT", "Bot died — respawning");
    try {
      if (bot && bot.respawn) {
        bot.respawn();
      }
    } catch (err) {
      log("RESPAWN ERROR", err.message);
    }
  });

  bot.on("health", () => {
    if (bot) {
      setState({ health: bot.health, food: bot.food });
    }
  });
}

// ---- Rejoin logic with exponential backoff -----------------

let rejoinScheduled = false;

function scheduleRejoin() {
  if (rejoinScheduled) return;
  rejoinScheduled = true;

  retryCount++;
  // Exponential backoff: 10s, 20s, 40s, 80s … capped at maxRetryDelay
  const delay = Math.min(
    config.rejoinDelay * Math.pow(2, retryCount - 1),
    config.maxRetryDelay,
  );

  log("BOT", `Reconnecting in ${Math.round(delay / 1000)}s… (attempt ${retryCount})`);
  setState({ status: "reconnecting" });

  setTimeout(() => {
    rejoinScheduled = false;
    bot = null;
    createBot();
  }, delay);
}

// ---- Process-level safety net ------------------------------

process.on("uncaughtException", (err) => {
  log("UNCAUGHT EXCEPTION", err.message);
  log("UNCAUGHT EXCEPTION", err.stack || "");
});

process.on("unhandledRejection", (reason) => {
  log("UNHANDLED REJECTION", String(reason));
});

// ---- Start -------------------------------------------------

createBot();
