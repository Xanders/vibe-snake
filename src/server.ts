import * as WebSocket from 'ws';

interface AICategory {
    patterns: string[];
    responses: string[];
}

interface AIResponses {
    [key: string]: AICategory;
}

const server = new WebSocket.Server({ port: 3000 });
const clients: Set<WebSocket> = new Set();

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

server.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    console.log('New client connected');
    broadcast('🤖 AI: Welcome to Snake Game! Feel free to ask for help or tips!');

    ws.on('message', (message: WebSocket.RawData) => {
        const messageStr = message.toString();
        broadcast(`Player: ${messageStr}`);

        // Generate AI response
        const aiResponse = getAIResponse(messageStr);
        if (aiResponse) {
            setTimeout(() => broadcast(aiResponse), 1000); // Add a small delay for more natural feeling
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log('Client disconnected');
    });
});

console.log('WebSocket server is running on port 3000');