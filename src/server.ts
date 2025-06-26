import * as WebSocket from 'ws';
import {
    initDB,
    createUser,
    getUserByToken,
    getUserByTelegramId,
    getLeastUsedEmoji,
    updateUserEmoji,
    updateUserId,
    addMultiplayerScore,
    getMultiplayerLeaderboard,
    MultiplayerEntry,
} from './db';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

interface AICategory {
    patterns: string[];
    responses: string[];
}

interface AIResponses {
    [key: string]: AICategory;
}

const PORT = 49123;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const server = new WebSocket.Server({ port: PORT });
const clients: Set<WebSocket> = new Set();

interface TelegramAuthResult {
    telegram_id: string;
    display_name: string;
    nickname: string | null;
}

function verifyTelegramInitData(initData: string): TelegramAuthResult | null {
    if (!BOT_TOKEN) return null;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return null;
        const dataPairs: string[] = [];
        params.forEach((v, k) => {
            if (k !== 'hash' && k !== 'signature') {
                dataPairs.push(`${k}=${v}`);
            }
        });
        dataPairs.sort();
        const dataCheckString = dataPairs.join('\n');
        const secret = crypto
            .createHmac('sha256', 'WebAppData')
            .update(BOT_TOKEN)
            .digest();
        const hmac = crypto
            .createHmac('sha256', secret)
            .update(dataCheckString)
            .digest('hex');
        if (hmac !== hash) return null;
        const userStr = params.get('user');
        if (!userStr) return null;
        const user = JSON.parse(userStr);
        const display_name = [user.first_name, user.last_name]
            .filter(Boolean)
            .join(' ');
        const nickname = user.username || null;
        const telegram_id = String(user.id);
        return { telegram_id, display_name, nickname };
    } catch {
        return null;
    }
}

initDB()
    .then(async () => {
        console.log('Database ready');
        const rows = await getMultiplayerLeaderboard(20);
        mpLeaderboard.push(...rows);
    })
    .catch(err => {
        console.error('Failed to init database', err);
    });

interface ScoreEntry {
    name: string;
    score: number;
}

const leaderboard: ScoreEntry[] = [];
const mpLeaderboard: MultiplayerEntry[] = [];

interface MultiplayerPlayer {
    id: string;
    ws: WebSocket;
    x: number;
    y: number;
    emoji: string;
    name: string;
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
    score = 0;
}

let score = 0;

function broadcastMultiplayerState(): void {
    if (multiplayerPlayers.size === 0) return;
    const state = {
        type: 'multiplayer-state',
        snake: { x: snake.x, y: snake.y, tail: snake.tail, length: snake.length },
        players: Array.from(multiplayerPlayers.values()).map(p => ({
            id: p.id,
            x: p.x,
            y: p.y,
            emoji: p.emoji,
            name: p.name,
        })),
        score,
    };
    broadcast(JSON.stringify(state));
}

interface Point { x: number; y: number; }

function bfs(start: Point, goal: Point, obstacles: Point[], width: number, height: number): Point[] | null {
    const queue: Point[] = [start];
    const visited = new Set<string>([`${start.x},${start.y}`]);
    const parent = new Map<string, string>();
    const obstacleSet = new Set<string>(obstacles.map(o => `${o.x},${o.y}`));

    while (queue.length > 0) {
        const current = queue.shift()!;
        const key = `${current.x},${current.y}`;
        if (current.x === goal.x && current.y === goal.y) {
            const path: Point[] = [];
            let k = key;
            while (k !== `${start.x},${start.y}`) {
                const [px, py] = k.split(',').map(Number);
                path.unshift({ x: px, y: py });
                k = parent.get(k)!;
            }
            return path;
        }

        const neighbors = [
            { x: current.x + 20, y: current.y },
            { x: current.x - 20, y: current.y },
            { x: current.x, y: current.y + 20 },
            { x: current.x, y: current.y - 20 },
        ];

        for (const n of neighbors) {
            const nKey = `${n.x},${n.y}`;
            if (n.x < 0 || n.x >= width || n.y < 0 || n.y >= height) continue;
            if (obstacleSet.has(nKey) || visited.has(nKey)) continue;
            visited.add(nKey);
            parent.set(nKey, key);
            queue.push(n);
        }
    }
    return null;
}

function getAutoDirection(target: Point): { dx: number; dy: number } | null {
    const obstacles = snake.tail.slice(0, snake.tail.length - 1);
    const path = bfs(
        { x: snake.x, y: snake.y },
        target,
        obstacles,
        400,
        400,
    );
    if (path && path.length) {
        const next = path[0];
        return { dx: next.x - snake.x, dy: next.y - snake.y };
    }

    const moves = [
        { dx: 20, dy: 0 },
        { dx: -20, dy: 0 },
        { dx: 0, dy: 20 },
        { dx: 0, dy: -20 },
    ];
    for (const m of moves) {
        const nx = snake.x + m.dx;
        const ny = snake.y + m.dy;
        const collision =
            nx < 0 ||
            nx >= 400 ||
            ny < 0 ||
            ny >= 400 ||
            snake.tail.some(seg => seg.x === nx && seg.y === ny);
        if (!collision) return m;
    }
    return null;
}

function gameStep(): void {
    if (multiplayerPlayers.size === 0) return;
    const players = Array.from(multiplayerPlayers.values());
    let target: MultiplayerPlayer | null = null;
    let minDist = Infinity;
    for (const p of players) {
        const dist = Math.abs(p.x - snake.x) + Math.abs(p.y - snake.y);
        if (dist < minDist) {
            minDist = dist;
            target = p;
        }
    }

    if (target) {
        const dir = getAutoDirection({ x: target.x, y: target.y });
        if (dir) {
            snake.dx = dir.dx;
            snake.dy = dir.dy;
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
        recordMultiplayerScore();
        resetSnake();
    }

    // Self collision
    if (snake.tail.some(seg => seg.x === snake.x && seg.y === snake.y)) {
        recordMultiplayerScore();
        resetSnake();
    }

    // Player collision
    for (const player of players) {
        if (player.x === snake.x && player.y === snake.y) {
            player.x = Math.floor(Math.random() * 20) * 20;
            player.y = Math.floor(Math.random() * 20) * 20;
            snake.length++;
            score += 10;
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

function sendMpLeaderboard(ws?: WebSocket): void {
    const payload = JSON.stringify({ type: 'mp-leaderboard', leaderboard: mpLeaderboard });
    if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    } else {
        broadcast(payload);
    }
}

async function recordMultiplayerScore(): Promise<void> {
    if (multiplayerPlayers.size === 0) return;
    const players = Array.from(multiplayerPlayers.values());
    const names = players.map(p => p.name).join(', ');
    const ids = players.map(p => p.id).join(',');
    await addMultiplayerScore(ids, names, score);
    const rows = await getMultiplayerLeaderboard(20);
    mpLeaderboard.length = 0;
    mpLeaderboard.push(...rows);
    sendMpLeaderboard();
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
    sendMpLeaderboard(ws);

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
                (async () => {
                    if (multiplayerPlayers.has(ws)) return;
                    let name: string | undefined;
                    let token: string | undefined = typeof data.token === 'string' ? data.token : undefined;
                    let emoji: string | undefined;
                    let id: string | undefined;
                    if (token) {
                        const user = await getUserByToken(token);
                        if (user) {
                            name = user.name;
                            emoji = user.emoji || undefined;
                            id = user.id;
                        }
                    }
                    if (!name && typeof data.tgInitData === 'string') {
                        const auth = verifyTelegramInitData(data.tgInitData);
                        if (auth) {
                            const user = await getUserByTelegramId(auth.telegram_id);
                            if (user) {
                                name = user.name;
                                emoji = user.emoji || undefined;
                                id = user.id;
                                token = user.token;
                            } else {
                                name = auth.display_name;
                                token = uuidv4();
                                id = uuidv4();
                                emoji = await getLeastUsedEmoji(emojis);
                                await createUser(id, name, token, emoji, auth.telegram_id, auth.nickname);
                            }
                        }
                    }
                    if (!name && typeof data.name === 'string') {
                        name = data.name;
                        token = uuidv4();
                        id = uuidv4();
                        emoji = await getLeastUsedEmoji(emojis);
                        await createUser(id!, name!, token!, emoji, undefined, undefined);
                    }
                    if (!name || !token || !id) {
                        ws.send(JSON.stringify({ type: 'error', message: 'invalid auth' }));
                        return;
                    }
                    if (!emoji) {
                        emoji = await getLeastUsedEmoji(emojis);
                        await updateUserEmoji(token, emoji);
                    }
                    if (!id) {
                        id = uuidv4();
                        await updateUserId(token, id);
                    }

                    const player: MultiplayerPlayer = {
                        id,
                        ws,
                        x: Math.floor(Math.random() * 20) * 20,
                        y: Math.floor(Math.random() * 20) * 20,
                        emoji,
                        name,
                    };
                    multiplayerPlayers.set(ws, player);
                    ws.send(JSON.stringify({ type: 'init-multiplayer', id, emoji, name, token }));
                    broadcastMultiplayerState();
                })();
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
