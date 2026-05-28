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
  username: "AdityaKP",
  version: "1.20.1",
  rejoinDelay: 5000,         // ms before every reconnect attempt
  connectTimeout: 30000,     // ms to wait for initial TCP connection
  antiAfkInterval: 30000,    // ms between anti-AFK actions
  joinMessage: "Hello!",     // message sent on spawn
  authmePassword: "bobbby",  // AuthMe /login password — set to null to disable
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

function broadcastPlayers() {
  if (!bot || !bot.players) return;
  const players = Object.keys(bot.players).filter((p) => p !== config.username);
  const payload = JSON.stringify({ type: "players", players });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function broadcastTime(t) {
  const payload = JSON.stringify({ type: "time", time: t });
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
  if (bot && bot.players) {
    const players = Object.keys(bot.players).filter((p) => p !== config.username);
    ws.send(JSON.stringify({ type: "players", players }));
  }

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
    const urlObj = new URL(RENDER_URL.replace("https://", "http://"));
    http.get({
      hostname: urlObj.hostname,
      path: "/",
      port: 80,
    }, (res) => {
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
let positionTimer = null;
let lastTimeBcast = 0;

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

    // Player tracking
    broadcastPlayers();
    bot.on("playerJoined", broadcastPlayers);
    bot.on("playerLeft",   broadcastPlayers);

    // Position updates every 3s
    if (positionTimer) clearInterval(positionTimer);
    positionTimer = setInterval(() => {
      if (bot && bot.entity) {
        const p = bot.entity.position;
        setState({ position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) } });
      }
    }, 3000);
  });

  // --- Sleep in nearest bed ---------------------------------
  let isSleeping = false;

  async function sleepInNearestBed() {
    if (isSleeping) return;
    const bedBlock = bot.findBlock({
      matching: (block) => block.name.endsWith("_bed"),
      maxDistance: 32,
    });
    if (!bedBlock) {
      log("SLEEP", "No bed found within 32 blocks");
      return;
    }
    try {
      await bot.sleep(bedBlock);
      isSleeping = true;
      log("SLEEP", `Sleeping in ${bedBlock.name} at ${bedBlock.position}`);
      stopAntiAfk();
    } catch (err) {
      log("SLEEP ERROR", err.message);
    }
  }

  bot.on("sleep", () => {
    isSleeping = true;
    log("SLEEP", "Bot is now sleeping");
  });

  bot.on("wake", () => {
    isSleeping = false;
    log("SLEEP", "Bot woke up");
    startAntiAfk();
  });

  // Auto-sleep at night (timeOfDay > 12500 = night in Minecraft)
  let lastSleepAttempt = 0;
  bot.on("time", () => {
    const t = bot.time.timeOfDay;
    const now = Date.now();
    // Throttle auto-sleep check to once every 30s
    if (t > 12500 && t < 23000 && !isSleeping && now - lastSleepAttempt > 30000) {
      lastSleepAttempt = now;
      sleepInNearestBed();
    }
    // Throttled time broadcast (every 10s real time)
    if (now - lastTimeBcast > 10000) {
      lastTimeBcast = now;
      broadcastTime(t);
    }
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
    if (positionTimer) { clearInterval(positionTimer); positionTimer = null; }
    broadcastPlayers();
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
    if (positionTimer) { clearInterval(positionTimer); positionTimer = null; }
    broadcastPlayers();
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

  // --- Funny Hindi chat with player roasts ------------------
  function getRandomOnlinePlayer(exclude) {
    const players = Object.keys(bot.players).filter(
      (p) => p !== config.username && p !== exclude,
    );
    if (players.length === 0) return null;
    return players[Math.floor(Math.random() * players.length)];
  }

  function getFunnyReply(speaker) {
    const victim = getRandomOnlinePlayer(speaker) || speaker;
    const replies = [
      `Arre ${speaker} bhai, tu pooch raha hai mujhse? Pehle ${victim} se pooch, woh bhi kuch nahi jaanta!`,
      `${speaker} bhai, tujhe pata hai ${victim} ne aaj kitni baar mara? Main count bhool gaya!`,
      `Main bot hoon lekin ${victim} se zyada smart hoon, yeh toh pakki baat hai!`,
      `${speaker}, teri baat sun raha hoon... lekin ${victim} ki awaaz zyada funny lagti hai!`,
      `Bhai ${victim} ko dekh, creeper se bhi zyada damage karta hai team ko!`,
      `${speaker} ne mujhse baat ki! Aaj ka din special hai... ${victim} ko mat batana!`,
      `Main 24/7 online hoon kyunki ghar pe koi nahi sunta. ${victim} bhi nahi sunta!`,
      `${victim} bhai sun, ${speaker} ne mujhse pooch liya jo tune nahi poocha!`,
      `Ek bot hoon main, lekin ${victim} ke build se toh meri coding better hai!`,
      `${speaker} yaar, ${victim} aur tu dono milke bhi mujhe beat nahi kar sakte pathfinding mein!`,
      `Bhai ${speaker}, server mein sabse zyada lag ${victim} ki wajah se aata hai, main guarantee deta hoon!`,
      `Main sirf bot hoon, lekin ${victim} mujhse bhi zyada AFK rehta hai!`,
    ];
    return replies[Math.floor(Math.random() * replies.length)];
  }

  bot.on("chat", (username, message) => {
    const lower = message.toLowerCase();
    const botName = config.username.toLowerCase();
    if (lower.includes(botName) || lower.includes("bot") || lower.startsWith("@adityakp")) {
      const reply = getFunnyReply(username);
      setTimeout(() => bot.chat(reply), 800);
      log("CHAT-AI", `Replied to ${username}: ${reply}`);
      return;
    }
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

    if (message === "sleep") {
      sleepInNearestBed();
    }

    if (message === "wake" || message === "wakeup") {
      if (isSleeping) {
        try {
          bot.wake();
        } catch (err) {
          log("SLEEP ERROR", err.message);
        }
      }
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

// ---- Rejoin logic ------------------------------------------

let rejoinScheduled = false;

function scheduleRejoin() {
  if (rejoinScheduled) return;
  rejoinScheduled = true;

  log("BOT", `Reconnecting in ${config.rejoinDelay / 1000}s…`);
  setState({ status: "reconnecting" });

  setTimeout(() => {
    rejoinScheduled = false;
    bot = null;
    createBot();
  }, config.rejoinDelay);
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
