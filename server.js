import WebSocket, { WebSocketServer } from "ws";

// Create WebSocket server
const wss = new WebSocketServer({ port: 8080 });

// Player and game state
let players = {};        // id → player object
let sockets = {};        // id → WebSocket
let tasks = {
  "lights": false,
  "fix_wires": false,
  "align_engines": false,
  "fuel_engine": false,
  "empty_garbage": false
};
let sabotages = {
  lights: false,
  reactor: false,
  o2: false
};
let votes = {};          // voterId → targetId
let meetingActive = false;
let meetingTimer = null;

wss.on("connection", (ws) => {
  let playerId = Date.now(); // Unique ID based on timestamp
  players[playerId] = {
    id: playerId,
    name: "",
    color: "Red",
    x: 3200,
    y: 850,
    alive: true,
    impostor: false
  };

  sockets[playerId] = ws;

  ws.on("message", (message) => {
    const msg = JSON.parse(message);

    switch (msg.type) {
      case "join":
        players[playerId].name = msg.name;
        players[playerId].color = msg.color;
        break;

      case "input":
        if (players[playerId].alive) {
          players[playerId].x += msg.dir.x * 6;
          players[playerId].y += msg.dir.y * 6;
        }
        break;

      case "kill":
        handleKill(playerId, msg.target);
        break;

      case "report":
        startMeeting(playerId, "Report");
        break;

      case "emergency":
        startMeeting(playerId, "Emergency");
        break;

      case "vote":
        handleVote(playerId, msg.target);
        break;

      case "task_complete":
        completeTask(playerId, msg.task);
        break;

      case "sabotage":
        sabotage(msg.sabotage, playerId);
        break;
    }

    broadcastState();
  });

  ws.on("close", () => {
    delete players[playerId];
    delete sockets[playerId];
    broadcastState();
  });
});

// Helper functions for game logic
function handleKill(killerId, targetId) {
  const killer = players[killerId];
  const target = players[targetId];

  if (!killer || !target) return;
  if (!killer.alive || !target.alive) return;
  if (!killer.impostor) return;
  if (meetingActive) return;

  const dx = killer.x - target.x;
  const dy = killer.y - target.y;
  if (Math.hypot(dx, dy) > 120) return;

  target.alive = false;

  broadcast({
    type: "player_killed",
    killer: killerId,
    victim: targetId
  });
}

function startMeeting(reporterId, reason) {
  if (meetingActive) return;

  meetingActive = true;
  votes = {};

  broadcast({
    type: "meeting_started",
    reporter: reporterId,
    reason: reason
  });

  meetingTimer = setTimeout(endMeeting, 30000);
}

function handleVote(voterId, targetId) {
  if (!meetingActive) return;
  if (!players[voterId].alive) return;
  if (votes[voterId]) return;

  votes[voterId] = targetId;
  broadcastVoteUpdate();
}

function broadcastVoteUpdate() {
  broadcast({
    type: "vote_update",
    votes: Object.keys(votes).length
  });
}

function endMeeting() {
  meetingActive = false;
  clearTimeout(meetingTimer);

  const tally = {};
  for (const voter in votes) {
    const target = votes[voter];
    tally[target] = (tally[target] || 0) + 1;
  }

  let ejected = null;
  let maxVotes = 0;
  let tie = false;

  for (const target in tally) {
    if (tally[target] > maxVotes) {
      maxVotes = tally[target];
      ejected = target;
      tie = false;
    } else if (tally[target] === maxVotes) {
      tie = true;
    }
  }

  if (!tie && ejected && players[ejected]) {
    players[ejected].alive = false;
  }

  broadcast({
    type: "meeting_ended",
    ejected: tie ? null : ejected,
    impostor: ejected ? players[ejected].impostor : false
  });

  votes = {};
}

function broadcastState() {
  const payload = JSON.stringify({
    type: "state",
    players: players,
    tasks: tasks,
    sabotages: sabotages
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function broadcast(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

function completeTask(playerId, taskType) {
  if (tasks[taskType]) return; // Task already completed

  tasks[taskType] = true;
  broadcast({
    type: "task_complete",
    player: playerId,
    task: taskType
  });

  checkWin();
}

function sabotage(type, perpetratorId) {
  if (sabotages[type]) return;

  sabotages[type] = true;
  broadcast({
    type: "sabotage",
    sabotage: type,
    perpetrator: perpetratorId
  });

  setTimeout(() => {
    sabotages[type] = false;
    broadcast({ type: "sabotage_reset", sabotage: type });
  }, 15000);
}

function checkWin() {
  const alivePlayers = Object.values(players).filter(p => p.alive);
  const impostors = alivePlayers.filter(p => p.impostor);
  const crew = alivePlayers.filter(p => !p.impostor);

  if (Object.values(tasks).every(task => task)) {
    broadcast({ type: "game_over", winner: "crew" });
    return;
  }

  if (impostors.length >= crew.length) {
    broadcast({ type: "game_over", winner: "impostor" });
    return;
  }
}
