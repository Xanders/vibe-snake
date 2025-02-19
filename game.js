class Snake {
    constructor() {
        this.reset();
    }

    reset() {
        this.x = 200;
        this.y = 200;
        this.dx = 20;
        this.dy = 0;
        this.tail = [];
        this.length = 1;
    }

    update() {
        // Update tail
        this.tail.unshift({ x: this.x, y: this.y });
        while (this.tail.length > this.length) {
            this.tail.pop();
        }

        // Update head position
        this.x += this.dx;
        this.y += this.dy;
    }

    draw(ctx) {
        ctx.fillStyle = '#4CAF50';
        // Draw head
        ctx.fillRect(this.x, this.y, 18, 18);
        // Draw tail
        this.tail.forEach(segment => {
            ctx.fillRect(segment.x, segment.y, 18, 18);
        });
    }

    checkCollision(width, height) {
        // Wall collision
        if (this.x < 0 || this.x >= width || this.y < 0 || this.y >= height) {
            return true;
        }

        // Self collision
        return this.tail.some(segment => segment.x === this.x && segment.y === this.y);
    }
}

class Food {
    constructor() {
        this.move();
    }

    move() {
        this.x = Math.floor(Math.random() * 20) * 20;
        this.y = Math.floor(Math.random() * 20) * 20;
    }

    draw(ctx) {
        ctx.fillStyle = '#FF5252';
        ctx.fillRect(this.x, this.y, 18, 18);
    }
}

class Game {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.snake = new Snake();
        this.food = new Food();
        this.score = 0;
        this.isPaused = false;
        this.gameOver = false;
        this.lastUpdateTime = 0;
        this.updateInterval = 150; // Controls game speed (milliseconds)

        document.addEventListener('keydown', this.handleKeyPress.bind(this));
        this.gameLoop = this.gameLoop.bind(this);
        requestAnimationFrame(this.gameLoop);

        // Initialize chat elements
        this.chatInput = document.getElementById('chatInput');
        this.chatSend = document.getElementById('chatSend');
        this.chatMessages = document.getElementById('chatMessages');

        // Initialize WebSocket connection
        this.ws = new WebSocket('ws://localhost:3000');
        
        // Handle incoming messages from WebSocket
        this.ws.onmessage = (event) => {
            const messageElement = document.createElement('div');
            messageElement.className = 'message';
            messageElement.textContent = event.data;
            this.chatMessages.appendChild(messageElement);
            this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        };

        // Set up chat event listeners
        this.chatSend.addEventListener('click', () => this.sendMessage());
        this.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendMessage();
            }
        });
    }

    gameLoop(timestamp) {
        if (this.isPaused || this.gameOver) return;

        if (timestamp - this.lastUpdateTime >= this.updateInterval) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            this.snake.update();
            this.checkFoodCollision();

            if (this.snake.checkCollision(this.canvas.width, this.canvas.height)) {
                this.gameOver = true;
                this.drawGameOver();
                return;
            }

            this.snake.draw(this.ctx);
            this.food.draw(this.ctx);

            this.lastUpdateTime = timestamp;
        }

        requestAnimationFrame(this.gameLoop);
    }

    handleKeyPress(event) {
        if (event.code === 'Space') {
            if (this.gameOver) {
                this.reset();
                return;
            }
            this.isPaused = !this.isPaused;
            if (!this.isPaused) {
                requestAnimationFrame(this.gameLoop);
            }
            return;
        }

        if (this.isPaused || this.gameOver) return;

        switch (event.key) {
            case 'ArrowUp':
                if (this.snake.dy === 0) {
                    this.snake.dx = 0;
                    this.snake.dy = -20;
                }
                break;
            case 'ArrowDown':
                if (this.snake.dy === 0) {
                    this.snake.dx = 0;
                    this.snake.dy = 20;
                }
                break;
            case 'ArrowLeft':
                if (this.snake.dx === 0) {
                    this.snake.dx = -20;
                    this.snake.dy = 0;
                }
                break;
            case 'ArrowRight':
                if (this.snake.dx === 0) {
                    this.snake.dx = 20;
                    this.snake.dy = 0;
                }
                break;
        }
    }

    checkFoodCollision() {
        if (this.snake.x === this.food.x && this.snake.y === this.food.y) {
            this.food.move();
            this.snake.length++;
            this.score += 10;
            document.getElementById('score').textContent = this.score;
        }
    }

    drawGameOver() {
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        this.ctx.fillStyle = '#fff';
        this.ctx.font = '48px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('Game Over!', this.canvas.width / 2, this.canvas.height / 2);

        this.ctx.font = '24px Arial';
        this.ctx.fillText('Press Space to restart', this.canvas.width / 2, this.canvas.height / 2 + 40);

        // Remove the old event listener setup and use the existing handleKeyPress method
        // which already handles the Space key press for both pause and restart
    }

    reset() {
        this.snake.reset();
        this.food.move();
        this.score = 0;
        document.getElementById('score').textContent = this.score;
        this.gameOver = false;
        this.isPaused = false;
        requestAnimationFrame(this.gameLoop);
    }

    sendMessage() {
        const message = this.chatInput.value.trim();
        if (message && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(message);
            this.chatInput.value = '';
        }
    }
}

// Start the game
new Game();