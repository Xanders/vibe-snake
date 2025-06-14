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
        console.log('Client disconnected');
    });
});

console.log(`WebSocket server is running on port ${PORT}`);
