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

    moveBy(dx, dy, width, height) {
        const nx = this.x + dx;
        const ny = this.y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            this.x = nx;
            this.y = ny;
        }
    }

    draw(ctx) {
        ctx.fillStyle = '#FF5252';
        ctx.fillRect(this.x, this.y, 18, 18);
    }
}

class Game {
    constructor() {
        console.log('Initializing game...');
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.snake = new Snake();
        this.food = new Food();
        this.score = 0;
        this.isPaused = false;
        this.gameOver = false;
        this.lastUpdateTime = 0;
        this.updateInterval = 150; // Controls game speed (milliseconds)
        this.isBlocked = false; // Add blocked state
        this.blockMessage = ''; // Message to show when blocked

        document.addEventListener('keydown', this.handleKeyPress.bind(this));
        this.gameLoop = this.gameLoop.bind(this);
        requestAnimationFrame(this.gameLoop);

        // Initialize chat elements
        this.chatInput = document.getElementById('chatInput');
        this.chatSend = document.getElementById('chatSend');
        this.chatMessages = document.getElementById('chatMessages');
        this.leaderboardElement = document.getElementById('leaderboard');
        this.leaderboard = [];
        this.mpLeaderboardElement = document.getElementById('mpLeaderboard');
        this.mpLeaderboard = [];
        this.remoteSnake = null;
        this.remotePlayers = [];
        this.playerId = null;
        this.onlinePlayersList = document.getElementById('onlinePlayersList');
        this.onlinePlayersContainer = document.getElementById('onlinePlayersContainer');
        this.invoiceUrl = null;
        this.creditInfo = document.getElementById('creditInfo');
        this.creditMessage = document.getElementById('creditMessage');
        this.buyGamesBtn = document.getElementById('buyGamesBtn');
        this.buyGamesBtn.addEventListener('click', () => this.buyGames());
        if (window.Telegram && Telegram.WebApp) {
            Telegram.WebApp.onEvent('invoiceClosed', (status) => {
                if (status === 'paid') {
                    // server will grant credits after verifying payment
                }
            });
        }
        this.renderLeaderboard();
        this.renderMpLeaderboard();

        // Vibe mode toggle
        this.autopilot = false;
        this.vibeToggle = document.getElementById('vibeModeToggle');
        this.berryMode = false;
        this.berryToggle = document.getElementById('berryModeToggle');
        this.berryContainer = document.getElementById('berryToggleContainer');
        this.multiplayerMode = false;
        this.multiToggle = document.getElementById('multiplayerModeToggle');
        this.multiContainer = document.getElementById('multiToggleContainer');
        this.vibeToggle.addEventListener('change', () => {
            this.autopilot = this.vibeToggle.checked;
            console.log('Vibe mode toggled:', this.autopilot);
            if (this.autopilot) {
                this.berryContainer.style.display = 'flex';
            } else {
                this.berryContainer.style.display = 'none';
                this.multiContainer.style.display = 'none';
                this.berryToggle.checked = false;
                this.berryMode = false;
                if (this.multiplayerMode) {
                    this.multiToggle.checked = false;
                    this.exitMultiplayer();
                }
            }
        });
        this.berryToggle.addEventListener('change', () => {
            this.berryMode = this.berryToggle.checked;
            if (this.berryMode) {
                this.multiContainer.style.display = 'flex';
            } else {
                this.multiContainer.style.display = 'none';
                if (this.multiplayerMode) {
                    this.multiToggle.checked = false;
                    this.exitMultiplayer();
                }
            }
        });
        this.multiToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                this.multiplayerMode = true;
                this.enterMultiplayer();
            } else {
                this.multiplayerMode = false;
                this.exitMultiplayer();
            }
        });

        // Initialize WebSocket connection
        const host = window.location.hostname;
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${protocol}://${host}:49123`;
        console.log('Connecting to WebSocket:', url);
        this.ws = new WebSocket(url);
        this.ws.onopen = () => console.log('WebSocket connection opened');
        this.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
            if (this.multiplayerMode) {
                this.showConnectionError();
                this.exitMultiplayer();
                this.multiToggle.disabled = true;
            }
        };
        this.ws.onclose = () => {
            console.log('WebSocket connection closed');
            if (this.multiplayerMode) {
                this.showConnectionError(); 
                this.exitMultiplayer();
                this.multiToggle.disabled = true;
            }
        };
        
        // Handle incoming messages from WebSocket
        this.ws.onmessage = (event) => {
            console.log('Received message:', event.data);
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'leaderboard') {
                    this.leaderboard = data.leaderboard;
                    this.renderLeaderboard();
                    return;
                }
                if (data.type === 'mp-leaderboard') {
                    this.mpLeaderboard = data.leaderboard;
                    this.renderMpLeaderboard();
                    return;
                }
                if (data.type === 'init-multiplayer') {
                    this.playerId = data.id;
                    if (data.token) {
                        localStorage.setItem('playerToken', data.token);
                    }
                    if (typeof data.credits === 'number') {
                        this.updateCredits(data.credits, 0);
                    }
                    return;
                }
                if (data.type === 'multiplayer-state') {
                    this.remoteSnake = data.snake;
                    this.remotePlayers = data.players;
                    if (typeof data.score === 'number') {
                        this.score = data.score;
                        document.getElementById('score').textContent = this.score;
                    }
                    this.renderOnlinePlayers();
                    return;
                }
                if (data.type === 'games-update') {
                    this.updateCredits(data.credits, data.waitMinutes);
                    return;
                }
                if (data.type === 'game-over') {
                    this.isBlocked = true;
                    this.blockMessage = `Wait ${data.wait} min or buy more games`;
                    this.updateCredits(0, data.wait);
                    return;
                }
                if (data.type === 'join-denied') {
                    this.creditInfo.style.display = 'block';
                    this.buyGamesBtn.style.display = 'inline-block';
                    this.creditMessage.textContent = `Please wait ${data.wait} min or buy more games.`;
                    this.isBlocked = true;
                    this.blockMessage = `Wait ${data.wait} min or buy more games`;
                    // Don't exit multiplayer mode, just block the game
                    return;
                }
                if (data.type === 'invoice-link') {
                    this.invoiceUrl = data.link;
                    if (window.Telegram && Telegram.WebApp && this.invoiceUrl) {
                        Telegram.WebApp.openInvoice(this.invoiceUrl);
                    }
                    return;
                }
                if (data.type === 'error') {
                    console.error('Server error:', data.message);
                    if (data.message === 'invalid auth') {
                        localStorage.removeItem('playerToken');
                        // Show error message on canvas
                        this.showConnectionError();
                        // Exit multiplayer mode
                        this.exitMultiplayer();
                        // Show message instead of disabling
                        this.multiToggle.parentElement.title = "Unable to connect. Please reload the page.";
                    }
                    return;
                }
            } catch (e) {
                // not JSON
            }
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

        // Touch controls for mobile
        let touchStartX = 0;
        let touchStartY = 0;
        let touchMoved = false;
        this.canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const t = e.touches[0];
            touchStartX = t.clientX;
            touchStartY = t.clientY;
            touchMoved = false;
            console.log('touchstart', touchStartX, touchStartY);
        }, { passive: false });
        this.canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const t = e.touches[0];
            // Only mark as moved if the finger travelled far enough
            if (Math.abs(t.clientX - touchStartX) > 10 || Math.abs(t.clientY - touchStartY) > 10) {
                touchMoved = true;
            }
        }, { passive: false });
        this.canvas.addEventListener('touchend', (e) => {
            e.preventDefault();
            
            // Skip touch processing if game is blocked
            if (this.isBlocked) {
                // Let the buyTouchHandler handle it
                return;
            }
            
            const t = e.changedTouches[0];
            const dx = t.clientX - touchStartX;
            const dy = t.clientY - touchStartY;
            console.log('touchend', { dx, dy, touchMoved });
            if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
                const rect = this.canvas.getBoundingClientRect();
                const tapX = t.clientX - rect.left;
                const tapY = t.clientY - rect.top;
                const diffX = tapX - (this.snake.x + 10);
                const diffY = tapY - (this.snake.y + 10);
                const axis = Math.abs(diffX) > Math.abs(diffY) ? 'x' : 'y';
                console.log('tap', { tapX, tapY, diffX, diffY, axis });
                if (axis === 'x') {
                    this.processDirection(diffX > 0 ? 'ArrowRight' : 'ArrowLeft');
                } else {
                    this.processDirection(diffY > 0 ? 'ArrowDown' : 'ArrowUp');
                }
            } else if (Math.abs(dx) > Math.abs(dy)) {
                if (dx > 0) this.processDirection('ArrowRight');
                else this.processDirection('ArrowLeft');
            } else {
                if (dy > 0) this.processDirection('ArrowDown');
                else this.processDirection('ArrowUp');
            }
        }, { passive: false });

        // Restart on tap when game over
        this.canvas.addEventListener('click', () => {
            if (this.gameOver) this.reset();
        });
        this.canvas.addEventListener('touchstart', (e) => {
            if (this.gameOver) {
                e.preventDefault();
                this.reset();
            }
        }, { passive: false });
    }

    gameLoop(timestamp) {
        if (this.isPaused || this.gameOver) return;

        if (this.multiplayerMode) {
            // Check if blocked
            if (this.isBlocked) {
                this.drawBlocked();
                requestAnimationFrame(this.gameLoop);
                return;
            }
            
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            if (this.remoteSnake) {
                // draw snake
                this.ctx.fillStyle = '#4CAF50';
                this.ctx.fillRect(this.remoteSnake.x, this.remoteSnake.y, 18, 18);
                this.remoteSnake.tail.forEach(t => {
                    this.ctx.fillRect(t.x, t.y, 18, 18);
                });
            }
            this.remotePlayers.forEach(p => {
                this.ctx.font = '20px Arial';
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                this.ctx.fillText(p.emoji, p.x + 10, p.y + 10);
            });
            this.lastUpdateTime = timestamp;
            requestAnimationFrame(this.gameLoop);
            return;
        }


        if (timestamp - this.lastUpdateTime >= this.updateInterval) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            if (this.autopilot) {
                const dir = this.getAutoDirection();
                if (dir) {
                    this.snake.dx = dir.dx;
                    this.snake.dy = dir.dy;
                }
            }

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

        if (this.isPaused || this.gameOver || this.isBlocked) return; // Add isBlocked check
        if (this.multiplayerMode) {
            const dirMap = {
                ArrowUp: 'up',
                ArrowDown: 'down',
                ArrowLeft: 'left',
                ArrowRight: 'right'
            };
            const d = dirMap[event.key];
            if (d && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'move', dir: d }));
            }
            return;
        }
        if (this.isPaused || this.gameOver) return;
        this.processDirection(event.key);
    }

    processDirection(key) {
        if (this.isBlocked) return; // Add isBlocked check
        if (this.multiplayerMode) {
            const map = {
                ArrowUp: 'up',
                ArrowDown: 'down',
                ArrowLeft: 'left',
                ArrowRight: 'right'
            };
            const d = map[key];
            if (d && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'move', dir: d }));
            }
            return;
        }
        if (this.autopilot && this.berryMode) {
            switch (key) {
                case 'ArrowUp':
                    this.food.moveBy(0, -20, this.canvas.width, this.canvas.height);
                    break;
                case 'ArrowDown':
                    this.food.moveBy(0, 20, this.canvas.width, this.canvas.height);
                    break;
                case 'ArrowLeft':
                    this.food.moveBy(-20, 0, this.canvas.width, this.canvas.height);
                    break;
                case 'ArrowRight':
                    this.food.moveBy(20, 0, this.canvas.width, this.canvas.height);
                    break;
            }
            return;
        }

        switch (key) {
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
        console.log('Game over');
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        this.ctx.fillStyle = '#fff';
        this.ctx.font = '48px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('Game Over!', this.canvas.width / 2, this.canvas.height / 2);

        this.ctx.font = '24px Arial';
        this.ctx.fillText('Tap or press Space to restart', this.canvas.width / 2, this.canvas.height / 2 + 40);

        // Remove the old event listener setup and use the existing handleKeyPress method
        // which already handles the Space key press for both pause and restart

        this.submitScoreIfEligible();
    }

    drawBlocked() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw semi-transparent overlay
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw blocked message
        this.ctx.fillStyle = '#fff';
        this.ctx.font = '24px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 2;
        
        this.ctx.fillText(this.blockMessage, centerX, centerY - 40);
        
        // Draw buy button
        this.ctx.strokeStyle = '#4CAF50';
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(centerX - 80, centerY, 160, 40);
        
        this.ctx.fillStyle = '#4CAF50';
        this.ctx.font = '18px Arial';
        this.ctx.fillText('Buy 10 Games', centerX, centerY + 20);
        
        // Add click handler for the button area
        if (!this.buyButtonHandler) {
            this.buyButtonHandler = (e) => {
                const rect = this.canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                
                // Check if click is on buy button
                if (x >= centerX - 80 && x <= centerX + 80 && 
                    y >= centerY && y <= centerY + 40) {
                    this.buyGames();
                }
            };
            this.canvas.addEventListener('click', this.buyButtonHandler);
            
            // Add touch handler for mobile
            this.buyTouchHandler = (e) => {
                e.preventDefault();
                const rect = this.canvas.getBoundingClientRect();
                const touch = e.changedTouches[0];
                const x = touch.clientX - rect.left;
                const y = touch.clientY - rect.top;
                
                // Check if touch is on buy button
                if (x >= centerX - 80 && x <= centerX + 80 && 
                    y >= centerY && y <= centerY + 40) {
                    this.buyGames();
                }
            };
            this.canvas.addEventListener('touchend', this.buyTouchHandler, { passive: false });
        }
    }

    reset() {
        console.log('Resetting game');
        this.snake.reset();
        this.food.move();
        this.score = 0;
        document.getElementById('score').textContent = this.score;
        this.gameOver = false;
        this.isPaused = false;
        requestAnimationFrame(this.gameLoop);
    }

    bfs(start, goal, obstacles, width, height) {
        const queue = [start];
        const visited = new Set([`${start.x},${start.y}`]);
        const parent = new Map();
        const obstacleSet = new Set(obstacles.map(o => `${o.x},${o.y}`));

        while (queue.length > 0) {
            const current = queue.shift();
            const key = `${current.x},${current.y}`;
            if (current.x === goal.x && current.y === goal.y) {
                const path = [];
                let k = key;
                while (k !== `${start.x},${start.y}`) {
                    const [px, py] = k.split(',').map(Number);
                    path.unshift({ x: px, y: py });
                    k = parent.get(k);
                }
                return path;
            }

            const neighbors = [
                { x: current.x + 20, y: current.y },
                { x: current.x - 20, y: current.y },
                { x: current.x, y: current.y + 20 },
                { x: current.x, y: current.y - 20 }
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

    getAutoDirection() {
        const obstacles = this.snake.tail.slice(0, this.snake.tail.length - 1);
        const path = this.bfs(
            { x: this.snake.x, y: this.snake.y },
            { x: this.food.x, y: this.food.y },
            obstacles,
            this.canvas.width,
            this.canvas.height
        );

        if (path && path.length) {
            const next = path[0];
            return { dx: next.x - this.snake.x, dy: next.y - this.snake.y };
        }

        const moves = [
            { dx: 20, dy: 0 },
            { dx: -20, dy: 0 },
            { dx: 0, dy: 20 },
            { dx: 0, dy: -20 }
        ];
        for (const m of moves) {
            const nx = this.snake.x + m.dx;
            const ny = this.snake.y + m.dy;
            const collision =
                nx < 0 ||
                nx >= this.canvas.width ||
                ny < 0 ||
                ny >= this.canvas.height ||
                this.snake.tail.some(seg => seg.x === nx && seg.y === ny);
            if (!collision) return m;
        }
        return null;
    }

    renderLeaderboard() {
        if (!this.leaderboardElement) return;
        this.leaderboardElement.innerHTML = this.leaderboard
            .map(e => `<li>${e.name} - ${e.score}</li>`)
            .join('');
    }

    renderMpLeaderboard() {
        if (!this.mpLeaderboardElement) return;
        this.mpLeaderboardElement.innerHTML = this.mpLeaderboard
            .map(e => `<li>${e.names} - ${e.score}</li>`)
            .join('');
    }

    renderOnlinePlayers() {
        if (!this.onlinePlayersList) return;
        this.onlinePlayersList.innerHTML = this.remotePlayers
            .map(p => `<li>${p.emoji} ${p.name || ''}</li>`)
            .join('');
    }

    enterMultiplayer() {
        document.getElementById('leaderboardContainer').style.display = 'none';
        document.getElementById('mpLeaderboardContainer').style.display = 'block';
        this.onlinePlayersContainer.style.display = 'block';
        // Don't hide credit info, it will be updated when we get the data from server
        this.vibeToggle.disabled = true;
        this.berryToggle.disabled = true;
        this.vibeToggle.checked = false;
        this.autopilot = false;
        this.berryToggle.checked = false;
        this.berryMode = false;
        this.snake.reset();
        this.food.move();
        if (this.ws.readyState === WebSocket.OPEN) {
            const payload = { type: 'join-multiplayer' };
            const stored = localStorage.getItem('playerToken');
            const hasTg = window.Telegram && window.Telegram.WebApp && Telegram.WebApp.initData;
            if (stored) {
                payload.token = stored;
            }
            if (hasTg) {
                payload.tgInitData = Telegram.WebApp.initData;
            }
            if (!stored && !hasTg) {
                const name = prompt('Enter your name:');
                if (name) {
                    payload.name = name;
                } else {
                    this.multiToggle.checked = false;
                    this.onlinePlayersContainer.style.display = 'none';
                    return;
                }
            }
            console.log('Sending join request', payload);
            this.ws.send(JSON.stringify(payload));
        }
    }

    exitMultiplayer() {
        document.getElementById('leaderboardContainer').style.display = '';
        document.getElementById('mpLeaderboardContainer').style.display = 'none';
        this.onlinePlayersContainer.style.display = 'none';
        this.vibeToggle.disabled = false;
        this.berryToggle.disabled = false;
        this.multiToggle.checked = false;
        this.vibeToggle.checked = false;
        this.autopilot = false;
        this.berryToggle.checked = false;
        this.berryMode = false;
        this.isBlocked = false; // Reset blocked state
        this.blockMessage = ''; // Clear block message
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'leave-multiplayer' }));
        }
        this.remoteSnake = null;
        this.remotePlayers = [];
        this.renderOnlinePlayers();
        this.playerId = null;
        this.reset();
        this.updateCredits(0, 0);
    }

    submitScoreIfEligible() {
        if (!this.berryMode) return;
        const worst = this.leaderboard.length < 20 ? Infinity : this.leaderboard[this.leaderboard.length - 1].score;
        if (this.score <= worst) {
            const name = prompt('Enter your name for the leaderboard:');
            if (name) {
                const payload = { type: 'submit-score', name, score: this.score };
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify(payload));
                }
            }
        }
    }

    sendMessage() {
        const message = this.chatInput.value.trim();
        if (message && this.ws.readyState === WebSocket.OPEN) {
            console.log('Sending message:', message);
            this.ws.send(message);
            this.chatInput.value = '';
        }
    }

    updateCredits(credits, wait) {
        if (credits > 0) {
            this.creditInfo.style.display = 'block';
            this.buyGamesBtn.style.display = 'none';
            this.creditMessage.textContent = `Games left: ${credits}`;
            this.isBlocked = false; // Unblock game when credits are available
        } else if (wait > 0) {
            this.creditInfo.style.display = 'block';
            this.buyGamesBtn.style.display = 'inline-block';
            this.creditMessage.textContent = `Wait ${wait} min or buy more games.`;
            this.blockMessage = `Wait ${wait} min or buy more games`;
            if (this.multiplayerMode) {
                this.isBlocked = true; // Block game when no credits
            }
        } else {
            this.creditInfo.style.display = 'none';
            this.isBlocked = false;
        }
    }

    buyGames() {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'get-invoice' }));
        }
    }

    showConnectionError() {
        // Clear the canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw semi-transparent overlay
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw error message
        this.ctx.fillStyle = '#ff4444';
        this.ctx.font = '24px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 2;
        
        this.ctx.fillText('Failed to connect to server', centerX, centerY - 20);
        
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '18px Arial';
        this.ctx.fillText('Please contact developers', centerX, centerY + 20);
        
        // Set flags to block interaction
        this.gameOver = true;
        this.multiplayerMode = false;
    }
}

// Start the game
new Game();