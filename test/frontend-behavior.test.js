const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('the page keeps its top content reachable when leaderboards grow', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
    const bodyRule = html.match(/body\s*{[^}]*}/s)?.[0];

    assert.ok(bodyRule);
    assert.match(bodyRule, /min-height:\s*100vh;/);
    assert.match(bodyRule, /justify-content:\s*flex-start;/);
    assert.doesNotMatch(bodyRule, /(?:^|\s)height:\s*100vh;/);
});

test('game keys suppress browser scrolling without hijacking chat input', () => {
    const source = fs.readFileSync(path.join(root, 'public', 'game.js'), 'utf8');
    const instrumented = source.replace(
        'new Game();',
        'globalThis.__Game = Game;'
    );
    const context = {
        console: { log() {}, error() {} },
        globalThis: null,
    };
    context.globalThis = context;
    vm.runInNewContext(instrumented, context);

    let gameKeyPrevented = false;
    context.__Game.prototype.handleKeyPress.call(
        { isPaused: true, gameOver: false, blocked: false },
        {
            code: 'ArrowDown',
            key: 'ArrowDown',
            target: { tagName: 'BODY' },
            preventDefault() { gameKeyPrevented = true; },
        }
    );
    assert.equal(gameKeyPrevented, true);

    let chatKeyPrevented = false;
    context.__Game.prototype.handleKeyPress.call(
        { isPaused: true, gameOver: false, blocked: false },
        {
            code: 'ArrowDown',
            key: 'ArrowDown',
            target: { tagName: 'INPUT', type: 'text' },
            preventDefault() { chatKeyPrevented = true; },
        }
    );
    assert.equal(chatKeyPrevented, false);
});

test('keyboard controls are captured before the browser scroll handler', () => {
    const source = fs.readFileSync(path.join(root, 'public', 'game.js'), 'utf8');

    assert.match(
        source,
        /window\.addEventListener\(\s*'keydown',[\s\S]*?capture:\s*true[\s\S]*?passive:\s*false/
    );
});

test('the page cache-busts game code and declares generated favicons', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

    assert.match(html, /<script src="game\.js\?v=[^"]+"><\/script>/);
    assert.match(html, /<link rel="icon" href="favicon\.ico" sizes="any">/);
    assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="favicon-32x32\.png">/);
    assert.ok(fs.existsSync(path.join(root, 'public', 'favicon.ico')));
    assert.ok(fs.existsSync(path.join(root, 'public', 'favicon-32x32.png')));
});
