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
