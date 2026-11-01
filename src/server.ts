import * as WebSocket from 'ws';
import * as http from 'http';
import * as net from 'net';
import { Bot } from 'grammy';
import type { Context as TelegramContext } from 'grammy';
import {
    initDB,
    createUser,
    getUserByToken,
    getUserByTelegramId,
    getLeastUsedEmoji,
    updateUserEmoji,
    updateUserId,
    setUserGameCredits,
    setUserCooldown,
    User,
    addMultiplayerScore,
    getMultiplayerLeaderboard,
    MultiplayerEntry,
    closeDB,
} from './db';
import {
    abortAndClear,
    destroyAndClearTransports,
    failClosedOnUnexpectedRejection,
    settleAllOrThrow,
    ShutdownCoordinator,
    ShutdownInProgressError,
    terminateRejectedTransport,
} from './shutdown';
import { TelegramPoller } from './telegram-poller';
import { dispatchJsonMessage } from './json-message';
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
const INVOICE_PAYLOAD = 'buy10games';
const GAME_PRICE = 99; // Stars
let bot: Bot | null = null;
let botPoller: TelegramPoller<any> | null = null;
if (BOT_TOKEN) {
    bot = new Bot(BOT_TOKEN);
}
const httpServer = http.createServer();
const server = new WebSocket.Server({ server: httpServer });
const clients: Set<WebSocket> = new Set();
const rawSockets = new Set<net.Socket>();
let gameLoop: NodeJS.Timeout | null = null;
let botStartPromise: Promise<void> | null = null;
const delayedBroadcasts = new Set<NodeJS.Timeout>();
const invoiceControllers = new Set<AbortController>();

const lifecycle = new ShutdownCoordinator({
    stopProducers,
    stopBot: stopBotPolling,
    closeWebSockets,
    closeDatabase: closeDatabaseConnection,
});

httpServer.on('connection', socket => {
    if (lifecycle.isShuttingDown) {
        socket.destroy();
        return;
    }
    rawSockets.add(socket);
    socket.once('close', () => rawSockets.delete(socket));
});
httpServer.listen(PORT);

// Track token associated with each websocket even if the user is currently not in the multiplayer room.
const socketTokens = new Map<WebSocket, string>();

interface TelegramAuthResult {
    telegram_id: string;
    display_name: string;
    nickname: string | null;
}

function verifyTelegramInitData(initData: string): TelegramAuthResult | null {
    if (!BOT_TOKEN) {
        console.error('BOT_TOKEN is not set');
        return null;
    }
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) {
            console.warn('No hash in Telegram init data');
            return null;
        }
        
        // Collect all parameters except hash
        const dataPairs: string[] = [];
        for (const [key, value] of params.entries()) {
            if (key !== 'hash') {
                dataPairs.push(`${key}=${value}`);
            }
        }
        
        // Sort parameters alphabetically by key
        dataPairs.sort();
        const dataCheckString = dataPairs.join('\n');
        
        console.log('Bot token length:', BOT_TOKEN.length);
        console.log('Data pairs:', dataPairs);
        console.log('Data check string:', dataCheckString);
        console.log('Hash from Telegram:', hash);
        
        // Create secret key: HMAC-SHA256(BOT_TOKEN, "WebAppData")
        const secret = crypto
            .createHmac('sha256', 'WebAppData')
            .update(BOT_TOKEN)
            .digest();
        
        console.log('Secret key (hex):', secret.toString('hex'));
            
        // Create final hash: HMAC-SHA256(dataCheckString, secret)
        const hmac = crypto
            .createHmac('sha256', secret)
            .update(dataCheckString)
            .digest('hex');
            
        console.log('Calculated hash:', hmac);
        
        if (hmac !== hash) {
            console.warn('Telegram auth hash mismatch');
            console.warn('Expected:', hmac);
            console.warn('Received:', hash);
            return null;
        }
        
        const userStr = params.get('user');
        if (!userStr) {
            console.warn('No user data in Telegram init data');
            return null;
        }
        
        const user = JSON.parse(userStr);
        const display_name = [user.first_name, user.last_name]
            .filter(Boolean)
            .join(' ');
        const nickname = user.username || null;
        const telegram_id = String(user.id);
        
        console.log('Telegram auth successful for user:', display_name);
        return { telegram_id, display_name, nickname };
    } catch (err) {
        console.warn('Failed to parse Telegram init data', err);
        return null;
    }
}

const databaseReady = initDB()
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
    token: string;
    telegramId: string | null;
    gameCredits: number;
    cooldownUntil: number;
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
        void lifecycle.track('multiplayer-score', recordMultiplayerScore).catch(reportTrackedError);
        resetSnake();
    }

    // Self collision
    if (snake.tail.some(seg => seg.x === snake.x && seg.y === snake.y)) {
        void lifecycle.track('multiplayer-score', recordMultiplayerScore).catch(reportTrackedError);
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

gameLoop = setInterval(gameStep, 150);

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

function scheduleBroadcast(message: string): void {
    const timer = setTimeout(() => {
        delayedBroadcasts.delete(timer);
        if (!lifecycle.isShuttingDown) broadcast(message);
    }, 1000);
    delayedBroadcasts.add(timer);
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

function sendGameInfo(player: MultiplayerPlayer): void {
    if (player.ws.readyState !== WebSocket.OPEN) return;
    const timeLeft = player.gameCredits > 0 ? 0 : Math.max(0, player.cooldownUntil - Date.now());
    const minutes = Math.ceil(timeLeft / 60000);

    // Always send a structured update that the client can handle.
    player.ws.send(JSON.stringify({
        type: 'games-update',
        credits: player.gameCredits,
        cooldown: player.cooldownUntil,
        waitMinutes: minutes,
    }));

    // Only forward a human-readable chat message when there is a real cooldown.
    // This prevents confusing "Wait 0 min" notifications on the very first join.
    if (player.gameCredits === 0 && minutes > 0) {
        player.ws.send(`Wait ${minutes} min or buy more games.`);
    } else if (player.gameCredits > 0) {
        player.ws.send(`Games left: ${player.gameCredits}`);
    }
}

async function recordMultiplayerScore(): Promise<void> {
    if (multiplayerPlayers.size === 0) return;
    const players = Array.from(multiplayerPlayers.values());

    const active: MultiplayerPlayer[] = [];

    const playerWrites = players.map(async p => {
        if (p.gameCredits > 0) {
            p.gameCredits--;
            await setUserGameCredits(p.token, p.gameCredits);
        }

        if (p.gameCredits <= 0) {
            if (p.cooldownUntil <= Date.now()) {
                p.cooldownUntil = Date.now() + 60 * 60 * 1000;
                await setUserCooldown(p.token, p.cooldownUntil);
            }
            multiplayerPlayers.delete(p.ws);
        } else {
            active.push(p);
        }

        sendGameInfo(p);
    });
    await settleAllOrThrow(playerWrites, 'One or more multiplayer score writes failed');

    if (active.length > 0) {
        const names = active.map(p => p.name).join(', ');
        const ids = active.map(p => p.id).join(',');
        await addMultiplayerScore(ids, names, score);
        const rows = await getMultiplayerLeaderboard(20);
        mpLeaderboard.length = 0;
        mpLeaderboard.push(...rows);
        sendMpLeaderboard();
    }

    broadcastMultiplayerState();
}

function updateLeaderboard(name: string, score: number): void {
    leaderboard.push({ name, score });
    leaderboard.sort((a, b) => a.score - b.score);
    if (leaderboard.length > 20) {
        leaderboard.length = 20;
    }
}

server.on('connection', (ws: WebSocket) => {
    if (lifecycle.isShuttingDown) {
        terminateRejectedTransport(ws);
        return;
    }
    clients.add(ws);
    console.log('New client connected');
    ws.send('🤖 AI: Welcome to Snake Game! Feel free to ask for help or tips!');
    sendLeaderboard(ws);
    sendMpLeaderboard(ws);

    ws.on('message', (message: WebSocket.RawData) => {
        void lifecycle.track('websocket-message', async () => {
        const messageStr = message.toString();
        const handledAsJson = await dispatchJsonMessage(
        messageStr,
        data => data !== null && typeof data === 'object' && [
            'submit-score',
            'join-multiplayer',
            'move',
            'get-invoice',
            'leave-multiplayer',
        ].includes(data.type),
        async data => {
        if (data !== undefined && data !== null) {
            if (data.type === 'submit-score' && typeof data.name === 'string' && typeof data.score === 'number') {
                updateLeaderboard(data.name, data.score);
                sendLeaderboard();
                return;
            }
            if (data.type === 'join-multiplayer') {
                    console.log('Join request', {
                        hasToken: typeof data.token === 'string',
                        hasTg: typeof data.tgInitData === 'string',
                        hasName: typeof data.name === 'string',
                    });
                    if (multiplayerPlayers.has(ws)) return;
                    let name: string | undefined;
                    let token: string | undefined = typeof data.token === 'string' ? data.token : undefined;
                    let emoji: string | undefined;
                    let id: string | undefined;
                    let gameCredits = 0;
                    let cooldownUntil = 0;
                    let telegramId: string | null = null;
                    if (token) {
                        const user = await getUserByToken(token);
                        if (user) {
                            name = user.name;
                            emoji = user.emoji || undefined;
                            id = user.id;
                            telegramId = user.telegram_id;
                            gameCredits = user.game_credits;
                            cooldownUntil = user.cooldown_until;
                        } else {
                            console.log('Token not found:', token);
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
                                telegramId = user.telegram_id;
                                gameCredits = user.game_credits;
                                cooldownUntil = user.cooldown_until;
                            } else {
                                name = auth.display_name;
                                token = uuidv4();
                                id = uuidv4();
                                emoji = await getLeastUsedEmoji(emojis);
                                await createUser(id, name, token, emoji, auth.telegram_id, auth.nickname);
                                telegramId = auth.telegram_id;
                                gameCredits = 0;
                                cooldownUntil = 0;
                                console.log('Created new user from Telegram', name);
                            }
                        } else {
                            console.log('Failed to verify tgInitData');
                        }
                    }
                    if (!name && typeof data.name === 'string') {
                        name = data.name;
                        token = uuidv4();
                        id = uuidv4();
                        emoji = await getLeastUsedEmoji(emojis);
                        await createUser(id!, name!, token!, emoji, undefined, undefined);
                        telegramId = null;
                        gameCredits = 0;
                        cooldownUntil = 0;
                        console.log('Created new user from name', name);
                    }
                    if (!name || !token || !id) {
                        console.warn('Join failed, missing fields', { name, token, id });
                        ws.send(JSON.stringify({ type: 'error', message: 'invalid auth' }));
                        return;
                    }
                    if (!emoji) {
                        emoji = await getLeastUsedEmoji(emojis);
                        await updateUserEmoji(token, emoji);
                    }
                    // id is already guaranteed to be set by this point

                    if (gameCredits <= 0 && cooldownUntil > Date.now()) {
                        const wait = Math.ceil((cooldownUntil - Date.now()) / 60000);
                        ws.send(JSON.stringify({ type: 'join-denied', wait }));
                        // Persist token for future cheat-codes even if join is denied
                        if (token) {
                            socketTokens.set(ws, token);
                        }
                        return;
                    }

                    // Remember token for miscellaneous operations (e.g. cheat-codes)
                    socketTokens.set(ws, token);

                    const player: MultiplayerPlayer = {
                        id,
                        ws,
                        x: Math.floor(Math.random() * 20) * 20,
                        y: Math.floor(Math.random() * 20) * 20,
                        emoji,
                        name,
                        token,
                        telegramId,
                        gameCredits,
                        cooldownUntil,
                    };
                    multiplayerPlayers.set(ws, player);
                    console.log('Player joined', { name, id, telegramId });
                    ws.send(JSON.stringify({ type: 'init-multiplayer', id, emoji, name, token, credits: gameCredits }));
                    sendGameInfo(player);
                    broadcastMultiplayerState();
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
            if (data.type === 'get-invoice') {
                if (bot) {
                    const controller = new AbortController();
                    invoiceControllers.add(controller);
                    try {
                        const link = await bot.api.createInvoiceLink(
                            '10 Games',
                            'Play ten multiplayer games',
                            INVOICE_PAYLOAD,
                            '',
                            'XTR',
                            [{ label: '10 games', amount: GAME_PRICE }],
                            undefined,
                            controller.signal,
                        );
                        ws.send(JSON.stringify({ type: 'invoice-link', link }));
                    } catch (err) {
                        if (!controller.signal.aborted) {
                            ws.send(JSON.stringify({ type: 'error', message: 'failed to create invoice' }));
                        }
                    } finally {
                        invoiceControllers.delete(controller);
                    }
                }
                return;
            }
            if (data.type === 'leave-multiplayer') {
                const player = multiplayerPlayers.get(ws);
                if (player) {
                    console.log('Player left', { name: player.name, id: player.id });
                }
                multiplayerPlayers.delete(ws);
                socketTokens.delete(ws);
                broadcastMultiplayerState();
                return;
            }
        }
        });
        if (handledAsJson) return;

        // Allow cheat-codes even when the user is not currently in the multiplayer game.
        const associatedToken = socketTokens.get(ws);
        if (multiplayerPlayers.has(ws) || associatedToken) {
            const player = multiplayerPlayers.get(ws) ?? undefined;
            const now = new Date();
            const code = `${String(now.getDate()).padStart(2, '0')}${String(now.getMonth() + 1).padStart(2, '0')}${now.getFullYear()}`;
            const reverse = code.split('').reverse().join('');
            if (messageStr === code) {
                if (player) {
                    player.gameCredits++;
                    await setUserGameCredits(player.token, player.gameCredits);
                    sendGameInfo(player);
                } else if (associatedToken) {
                    const user = await getUserByToken(associatedToken);
                    if (user) {
                        const credits = user.game_credits + 1;
                        await setUserGameCredits(user.token, credits);
                        // Inform the client so it can unblock UI (only structured, no chat text)
                        ws.send(JSON.stringify({ type: 'games-update', credits, cooldown: user.cooldown_until, waitMinutes: 0 }));
                    }
                }
                return;
            }
            if (messageStr === reverse) {
                // useful for testing
                if (player) {
                    if (player.gameCredits > 0) {
                        player.gameCredits--;
                        await setUserGameCredits(player.token, player.gameCredits);
                    }
                    sendGameInfo(player);
                } else if (associatedToken) {
                    const user = await getUserByToken(associatedToken);
                    if (user && user.game_credits > 0) {
                        const credits = user.game_credits - 1;
                        await setUserGameCredits(user.token, credits);
                        ws.send(JSON.stringify({ type: 'games-update', credits, cooldown: user.cooldown_until, waitMinutes: 0 }));
                    }
                }
                return;
            }
        }

        broadcast(`Player: ${messageStr}`);

        const aiResponse = getAIResponse(messageStr);
        if (aiResponse) {
            scheduleBroadcast(aiResponse);
        }
        }).catch(reportTrackedError);
    });

    ws.on('close', () => {
        clients.delete(ws);
        const player = multiplayerPlayers.get(ws);
        if (player) {
            console.log('Client disconnected', { name: player.name, id: player.id });
        } else {
            console.log('Client disconnected');
        }
        multiplayerPlayers.delete(ws);
        socketTokens.delete(ws);
    });
});


console.log(`WebSocket server is running on port ${PORT}`);

if (bot) {

    bot.on('message:successful_payment', async (ctx: TelegramContext) => {
        await lifecycle.track('telegram-payment', async () => {
            const payment = ctx.message.successful_payment;
            if (payment.invoice_payload === INVOICE_PAYLOAD) {
                const tgId = String(ctx.from!.id);
                const user = await getUserByTelegramId(tgId);
                if (user) {
                    const credits = user.game_credits + 10;
                    await setUserGameCredits(user.token, credits);
                    const player = Array.from(multiplayerPlayers.values()).find(p => p.token === user.token);
                    if (player) {
                        player.gameCredits = credits;
                        sendGameInfo(player);
                    }
                }
            }
        });
    });

    botPoller = new TelegramPoller(bot);
    botStartPromise = botPoller.start();
    failClosedOnUnexpectedRejection(
        botStartPromise,
        () => lifecycle.isShuttingDown,
        error => {
            console.error('Telegram bot failed', error);
            beginShutdown('TELEGRAM_POLLER_FAILURE', 1);
        },
    );
    console.log('Telegram bot started');
} else {
    console.log('BOT_TOKEN not set, Telegram payments disabled');
}

function reportTrackedError(error: unknown): void {
    if (error instanceof ShutdownInProgressError) return;
    console.error('Tracked operation failed', error);
}

function stopProducers(): void {
    if (gameLoop) {
        clearInterval(gameLoop);
        gameLoop = null;
    }
    for (const timer of delayedBroadcasts) clearTimeout(timer);
    delayedBroadcasts.clear();
    abortAndClear(invoiceControllers);
}

async function stopBotPolling(): Promise<void> {
    if (!botPoller) return;
    await botPoller.stop();
}

function closeWebSockets(): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let httpClosed = false;
        let listenerClosed = false;
        let terminateTimer: NodeJS.Timeout;
        let deadlineTimer: NodeJS.Timeout;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(terminateTimer);
            clearTimeout(deadlineTimer);
            if (error) reject(error);
            else resolve();
        };
        const finishIfDrained = () => {
            if (httpClosed && listenerClosed && clients.size === 0 && rawSockets.size === 0) finish();
        };
        terminateTimer = setTimeout(() => {
            for (const client of clients) {
                if (client.readyState !== WebSocket.CLOSED) client.terminate();
            }
            destroyAndClearTransports(rawSockets);
        }, 2000);
        deadlineTimer = setTimeout(
            () => finish(new Error('WebSocket server did not close within 5 seconds')),
            5000,
        );

        try {
            httpServer.close(error => {
                if (error) finish(error);
                else {
                    httpClosed = true;
                    finishIfDrained();
                }
            });
            server.close(error => {
                if (error) finish(error);
                else {
                    listenerClosed = true;
                    finishIfDrained();
                }
            });
            for (const client of clients) {
                client.once('close', finishIfDrained);
                if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
                    client.close(1001, 'Server shutting down');
                }
            }
            for (const socket of rawSockets) socket.once('close', finishIfDrained);
            finishIfDrained();
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

async function closeDatabaseConnection(): Promise<void> {
    await databaseReady;
    await closeDB();
}

let shutdownResultObserved = false;
function beginShutdown(reason: string, successExitCode: number): void {
    const shutdown = lifecycle.shutdown(reason);
    if (shutdownResultObserved) return;
    shutdownResultObserved = true;
    void shutdown.then(
        () => {
            console.log(`Graceful shutdown complete after ${reason}`);
            process.exitCode = successExitCode;
        },
        error => {
            console.error('Graceful shutdown completed with errors', error);
            process.exitCode = 1;
        },
    );
}

function handleShutdownSignal(signal: NodeJS.Signals): void {
    beginShutdown(signal, 0);
}

process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));
