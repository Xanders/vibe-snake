import * as WebSocket from 'ws';

interface AICategory {
    patterns: string[];
    responses: string[];
}

interface AIResponses {
    [key: string]: AICategory;
}

const PORT = 49123;
const server = new WebSocket.Server({ port: PORT });
const clients: Set<WebSocket> = new Set();

interface ScoreEntry {
    name: string;
    score: number;
}

const leaderboard: ScoreEntry[] = [];

interface MultiplayerPlayer {
    id: string;
    ws: WebSocket;
    x: number;
    y: number;
    emoji: string;
}

interface SnakeState {
    x: number;
    y: number;
    dx: number;
    dy: number;
    tail: { x: number; y: number }[];
    length: number;
}

const multiplayerPlayers = new Map<WebSocket, MultiplayerPlayer>();
const emojis = ['🍓', '🍒', '🍇', '🍉', '🍍', '🍎', '🍑', '🥕'];

const snake: SnakeState = {
    x: 200,
    y: 200,
    dx: 20,
    dy: 0,
    tail: [],
    length: 5,
};

function resetSnake(): void {
    snake.x = 200;
    snake.y = 200;
    snake.dx = 20;
    snake.dy = 0;
    snake.tail = [];
    snake.length = 5;
}

function broadcastMultiplayerState(): void {
    if (multiplayerPlayers.size === 0) return;
    const state = {
        type: 'multiplayer-state',
        snake: { x: snake.x, y: snake.y, tail: snake.tail },
        players: Array.from(multiplayerPlayers.values()).map(p => ({
            id: p.id,
            x: p.x,
            y: p.y,
            emoji: p.emoji,
        })),
    };
    broadcast(JSON.stringify(state));
}

function gameStep(): void {
    if (multiplayerPlayers.size === 0) return;

    // Follow the first player if available
    const players = Array.from(multiplayerPlayers.values());
    const target = players[0];
    if (target) {
        if (target.x > snake.x) {
            snake.dx = 20; snake.dy = 0;
        } else if (target.x < snake.x) {
            snake.dx = -20; snake.dy = 0;
        } else if (target.y > snake.y) {
            snake.dx = 0; snake.dy = 20;
        } else if (target.y < snake.y) {
            snake.dx = 0; snake.dy = -20;
        }
    }

    snake.tail.unshift({ x: snake.x, y: snake.y });
    while (snake.tail.length > snake.length) {
        snake.tail.pop();
    }
    snake.x += snake.dx;
    snake.y += snake.dy;

    // Wall collision
    if (snake.x < 0 || snake.x >= 400 || snake.y < 0 || snake.y >= 400) {
        resetSnake();
    }

    // Self collision
    if (snake.tail.some(seg => seg.x === snake.x && seg.y === snake.y)) {
        resetSnake();
    }

    // Player collision
    for (const player of players) {
        if (player.x === snake.x && player.y === snake.y) {
            player.x = Math.floor(Math.random() * 20) * 20;
            player.y = Math.floor(Math.random() * 20) * 20;
            snake.length++;
        }
    }

    broadcastMultiplayerState();
}

setInterval(gameStep, 150);

// Simple AI responses for different message patterns
const aiResponses: AIResponses = {
    greetings: {
        patterns: ['hi', 'hello', 'hey', 'привет', 'здравствуйте'],
        responses: ['Hello! How are you enjoying the game?', 'Hi there! Having fun with Snake?', 'Hey! Need any game tips?']
    },
    start: {
        patterns: ['start', 'play', 'играть', 'начать'],
        responses: ["Great! Let's play Snake!", "Awesome! Ready to go?", "Let's get started!"]
    },
    gameOver: {
        patterns: ['lost', 'died', 'game over', 'проиграл'],
        responses: ["Don't worry, you'll do better next time!", "Keep trying! Practice makes perfect!", "That was close! Give it another shot!"]
    },
    score: {
        patterns: ['score', 'points', 'очки', 'счет'],
        responses: ["Keep going! You're doing great!", "Nice score! Can you beat it?", "The more apples you eat, the longer you get!"]
    },
    help: {
        patterns: ['help', 'how to', 'помощь', 'как'],
        responses: ["Use arrow keys to control the snake", "Collect red apples to grow longer", "Don't hit the walls or yourself!"]
    }
};

function getAIResponse(message: string): string | null {
    message = message.toLowerCase();

    for (const category of Object.values(aiResponses)) {
        if (category.patterns.some(pattern => message.includes(pattern))) {
            const randomIndex = Math.floor(Math.random() * category.responses.length);
            return `🤖 AI: ${category.responses[randomIndex]}`;
        }
    }

    // Default response if no pattern matches
    return null;
}

function broadcast(message: string): void {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function sendLeaderboard(ws?: WebSocket): void {
    const payload = JSON.stringify({ type: 'leaderboard', leaderboard });
    if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    } else {
        broadcast(payload);
    }
}

function updateLeaderboard(name: string, score: number): void {
    leaderboard.push({ name, score });
    leaderboard.sort((a, b) => a.score - b.score);
    if (leaderboard.length > 20) {
        leaderboard.length = 20;
    }
}

server.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    console.log('New client connected');
    ws.send('🤖 AI: Welcome to Snake Game! Feel free to ask for help or tips!');
    sendLeaderboard(ws);

    ws.on('message', (message: WebSocket.RawData) => {
        const messageStr = message.toString();
        try {
            const data = JSON.parse(messageStr);
            if (data.type === 'submit-score' && typeof data.name === 'string' && typeof data.score === 'number') {
                updateLeaderboard(data.name, data.score);
                sendLeaderboard();
                return;
            }
            if (data.type === 'join-multiplayer') {
                if (!multiplayerPlayers.has(ws)) {
                    const id = Math.random().toString(36).slice(2, 8);
                    const emoji = emojis[Math.floor(Math.random() * emojis.length)];
                    const player: MultiplayerPlayer = {
                        id,
                        ws,
                        x: Math.floor(Math.random() * 20) * 20,
                        y: Math.floor(Math.random() * 20) * 20,
                        emoji,
                    };
                    multiplayerPlayers.set(ws, player);
                    ws.send(JSON.stringify({ type: 'init-multiplayer', id, emoji }));
                    broadcastMultiplayerState();
                }
                return;
            }
            if (data.type === 'move' && multiplayerPlayers.has(ws) && typeof data.dir === 'string') {
                const player = multiplayerPlayers.get(ws)!;
                switch (data.dir) {
                    case 'up':
                        if (player.y > 0) player.y -= 20;
                        break;
                    case 'down':
                        if (player.y < 380) player.y += 20;
                        break;
                    case 'left':
                        if (player.x > 0) player.x -= 20;
                        break;
                    case 'right':
                        if (player.x < 380) player.x += 20;
                        break;
                }
                broadcastMultiplayerState();
                return;
            }
            if (data.type === 'leave-multiplayer') {
                multiplayerPlayers.delete(ws);
                broadcastMultiplayerState();
                return;
            }
        } catch (err) {
            // Not JSON, treat as chat message
        }

        broadcast(`Player: ${messageStr}`);

        const aiResponse = getAIResponse(messageStr);
        if (aiResponse) {
            setTimeout(() => broadcast(aiResponse), 1000);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        multiplayerPlayers.delete(ws);
        console.log('Client disconnected');
    });
});

console.log(`WebSocket server is running on port ${PORT}`);
